/**
 * A saved form's status check (`statusCheck`): the one sanctioned read of an
 * anonymous application, and it is authentication, not a lookup.
 *
 * The receipt is the strong factor — random, high entropy, never a key or a
 * counter (`publicReference`) — and the values it is confirmed by are only
 * confirmation: NIST 800-63 does not count knowledge questions as identity
 * proof, and SSNs are breached. So what it answers is a state, in the words
 * the author gave, and never anything typed.
 *
 * Every wrong answer is one answer. A receipt that names nothing, a receipt
 * whose confirmation is wrong, a draft that was never submitted and a receipt
 * that is locked read the same sentence, with the same status, after the same
 * work: a missing row is still compared against a stand-in, and every reply
 * is held to one floor of time. Five failures on one receipt in an hour lock
 * it for the hour, whoever makes them, and the attempt that locks a real
 * application's receipt stamps its `alert` column, which the App's own
 * `notify` rule turns into a notice for staff; the client's own budget is
 * the rate limiter's. A keyed confirmation (the last four of an SSN) is compared as its
 * keyed hash, and nothing typed is logged: an attempt is recorded by its
 * outcome and a keyed digest of the receipt.
 */
import { resetSignInState, signInState } from '../auth/signInState.js';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { statusWords, type AppFormLink, type AppFormSave, type AppStatusCheck } from '../../shared/appSavedForms.js';
import type { CommandCatalog } from '../commands/commandDb.js';
import { keyedHash, keyedMatches } from './formKey.js';

const STATUS_NOT_FOUND =
  'We could not find an application with those details. Check them and try again; ' +
  'after several tries, checks on one reference pause for an hour.';
/** The check's one refusal, for every wrong answer alike. A form whose applications may belong to accounts says, to everyone, where those are read. */
export function statusNotFound(linkable: boolean): { code: 'not_found'; message: string; error: string } {
  const message = linkable
    ? `${STATUS_NOT_FOUND} An application added to an account is shown only there: sign in to see it.`
    : STATUS_NOT_FOUND;
  return { code: 'not_found', message, error: message };
}
const FLOOR_MS = 350;
const LOCK_AFTER = 5;
const LOCK_MS = 3_600_000;

/* Lockouts live in the deployment's sign-in state (auth/signInState.ts): with
   a cache configured, a receipt locked on one instance is locked on all, and
   the window runs from the first failure whichever instance counted it. */

/** Forget every lockout: tests use it. */
export function resetStatusLockouts(): void {
  resetSignInState();
}

/** The request body: the receipt and each confirmation, by the column it confirms. Anything else is refused. */
export function parseStatusRequest(body: unknown, check: AppStatusCheck): { receipt: string; confirm: Record<string, string> } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { receipt, confirm, ...rest } = body as Record<string, unknown>;
  if (Object.keys(rest).length || typeof receipt !== 'string' || !receipt.trim() || receipt.length > 64) return undefined;
  if (!confirm || typeof confirm !== 'object' || Array.isArray(confirm)) return undefined;
  const given = confirm as Record<string, unknown>;
  const names = check.confirm.map((item) => item.column);
  if (
    Object.keys(given).length !== names.length ||
    names.some((name) => typeof given[name] !== 'string' || !(given[name] as string).trim() || (given[name] as string).length > 200)
  )
    return undefined;
  return { receipt: receipt.trim(), confirm: Object.fromEntries(names.map((name) => [name, (given[name] as string).trim()])) };
}

const digest = (value: string) => createHash('sha256').update(value.normalize('NFKC').toLowerCase(), 'utf8').digest();
const equalText = (typed: string, stored: unknown) => {
  const a = digest(typed),
    b = digest(typeof stored === 'string' || typeof stored === 'number' ? String(stored).trim() : '\u0000missing');
  return timingSafeEqual(a, b) && (typeof stored === 'string' || typeof stored === 'number');
};

/** What a check answers: the shown columns in their words, or nothing at all. `receipt` is the server's, for a link that follows;
    `more` the further columns a step-up asked for, as stored, for the server alone. */
export type StatusAnswer =
  | { found: true; status: Record<string, string | null>; receipt: string; more?: Record<string, unknown> }
  | { found: false };

/**
 * One attempt. `records` reads the form's root tables where this request
 * lands (and stamps the alert, where the form keeps one). The caller answers
 * `found: false` with STATUS_NOT_FOUND and 404, and holds the reply to the
 * floor with `settle`. `account` is the verified session's, when there is
 * one: an application linked to an account answers its owner alone.
 */
export async function checkApplicationStatus(options: {
  check: AppStatusCheck;
  save: AppFormSave;
  roots: readonly string[];
  link?: AppFormLink;
  records: Pick<WriteTransaction, 'query' | 'update'>;
  request: { receipt: string; confirm: Record<string, string> };
  catalog: CommandCatalog;
  form: string;
  account?: string;
  now?: () => number;
  /** The App whose form this is: its own form key hashes, and its own lockouts count. */
  appId?: string;
  /** Further root columns read with the check (a step-up's email and details), handed back on success only. */
  more?: readonly string[];
}): Promise<StatusAnswer> {
  const { check, save, roots, records, request, form, link, catalog, account } = options;
  const now = (options.now ?? Date.now)();
  // One App's lockouts are its own: a suite's Apps may share a form name.
  const receiptKey = createHash('sha256')
    .update(options.appId === undefined ? `${form}\u0000${request.receipt}` : `${options.appId}\u0000${form}\u0000${request.receipt}`)
    .digest('hex');
  /* Each attempt is counted before it is judged: read first and counted after,
     guesses sent together all read the count as it was and all were judged,
     however many there were. A success takes the count away again. */
  const attempt = await signInState.fail(receiptKey, LOCK_MS);
  const locked = attempt > LOCK_AFTER;
  const rows: Array<{ table: string; row: Record<string, unknown> }> = [];
  for (const table of roots) {
    const result = await records.query({
      table,
      limit: 2,
      offset: 0,
      columns: [
        ...new Set([
          ...(catalog[table]?.key ?? []),
          save.draft.column,
          ...check.confirm.map((item) => item.column),
          ...check.show,
          ...(link ? [link.owner] : []),
          ...(options.more ?? []),
        ]),
      ],
      filter: { groups: [[{ column: check.receipt, op: '=', value: request.receipt }]] },
    });
    rows.push(...result.rows.map((row) => ({ table, row })));
  }
  // A draft has no receipt to quote yet, and two rows under one receipt name nobody.
  const found = rows.length === 1 && String(rows[0].row[save.draft.column]) !== save.draft.value ? rows[0] : undefined;
  const row = found?.row;
  // The same comparisons whether or not a row was found: a stand-in answers for a missing one.
  let matched = true;
  for (const item of check.confirm) {
    const typed = request.confirm[item.column];
    const stored = row?.[item.column];
    const ok = item.keyed
      ? keyedMatches(item.column, typed, stored ?? keyedHash(item.column, '\u0000stand-in', options.appId), options.appId) &&
        stored !== undefined
      : equalText(typed, stored);
    matched = ok && matched;
  }
  // Linked, it is its owner's: nobody else's details open it, signed in or not.
  const owner = link ? row?.[link.owner] : undefined;
  const theirs = owner === null || owner === undefined || owner === '' || (account !== undefined && String(owner) === account);
  const success = !!row && matched && !locked && theirs;
  if (!success) {
    let outcome: Outcome = locked ? 'locked' : 'refused';
    if (!locked) {
      /* The attempt that locks a real application's receipt tells its staff:
         the alert column is stamped, and the App's own notify rule on a
         change to it says so to whoever it names. Once per lock. */
      if (attempt === LOCK_AFTER && found && check.alert && catalog[found.table]?.key.length) {
        const key = Object.fromEntries(catalog[found.table].key.map((name) => [name, found.row[name] as string | number]));
        await records.update({ table: found.table, key, values: { [check.alert]: new Date(now).toISOString() } });
        outcome = 'alerted';
      }
    }
    record(form, receiptKey, outcome, account);
    return { found: false };
  }
  record(form, receiptKey, 'confirmed', account);
  await signInState.clearFailures(receiptKey);
  return {
    found: true,
    receipt: request.receipt,
    status: Object.fromEntries(check.show.map((name) => [name, statusWords(check, name, row[name])])),
    ...(options.more?.length ? { more: Object.fromEntries(options.more.map((name) => [name, row[name]])) } : {}),
  };
}

/** Hold a reply until the floor, so a found and a missing receipt take the same time. */
export async function settle(startedAt: number, now: () => number = Date.now): Promise<void> {
  const wait = FLOOR_MS - (now() - startedAt);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

/* The attempt's record, for every attempt: its form, its outcome, a digest
   of the receipt and the signed-in account when there is one — enough to see
   repeated failures on one application, and never a typed value. */
type Outcome = 'confirmed' | 'refused' | 'locked' | 'alerted';
function record(form: string, receiptKey: string, outcome: Outcome, account: string | undefined): void {
  process.stderr.write(
    `${JSON.stringify({ event: 'form.status_check', form, receipt: receiptKey.slice(0, 16), outcome, ...(account ? { account } : {}) })}\n`,
  );
}
