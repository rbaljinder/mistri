/**
 * Linking a submitted application to an account (`link` on a saved form):
 * on proven control of the application, never on matching data. A name, a
 * birth date, an SSN or a phone number that matches is how applications are
 * hijacked, so none of them links anything.
 *
 * Two proofs, each declared:
 *
 * - The same browser, straight after submitting (`sameDevice`). The submit
 *   leaves a claim beside the receipt: a random token in an HttpOnly,
 *   SameSite=Strict cookie scoped to the form's API path for thirty minutes,
 *   its SHA-256 on the root. It is spent only when the person, signed in,
 *   answers Yes on the claim page the done screen leads to — never by a later
 *   sign-in on its own, since the next person at a shared computer must not
 *   inherit it. No burns it, as do its expiry, signing out, submitting
 *   another application of the form and the done screen's "This is a shared
 *   device".
 * - A signed-in status check (`statusCheck: true`): the receipt and its
 *   confirming details, which the check treats as authentication, and then
 *   "Add to my account".
 * - A verified email (`email`): an account whose email is verified is
 *   offered the submitted applications that captured the same address — "We
 *   found 1 application submitted with this email — is this yours?" — and
 *   links each with a Yes. The address alone proves nothing about who typed
 *   it, so the confirm is what stops junk being planted in someone's
 *   account. Only where the applicant also proved the address with a code in
 *   the form (`email.verified` holds the address proved, and it is still the
 *   one on the application) does it link without asking. An unverified
 *   account email never matches anything.
 *
 * A link is one write of the root's owner column, with when and by which
 * path beside it for staff to see: one-shot, refused when the application
 * already has an owner, compared-and-set so two at once cannot both land,
 * and recorded in the record history (where the App keeps one) as the
 * account's own write, and in the server's log. Once linked, the application
 * is read only by its owner's session (`ownedApplications`), and the
 * anonymous status check no longer answers for it.
 */
import { cookieUnder } from '@mistriwork/engine/shared/mount.js';
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isPublicForm, type AppDef, type AppFormView } from '../../shared/app.js';
import { WriteConflict, type WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CLAIM_MINUTES, statusWords, type AppFormLink, type AppFormSave, type AppStatusCheck } from '../../shared/appSavedForms.js';
import type { CommandCatalog } from '../commands/commandDb.js';
import { storedInstant } from './savedForms.js';

/** Which proof linked it, as the `via` column says it. */
type LinkPath = 'same-device' | 'status-check' | 'email';

/** The one answer for a claim that cannot be spent: none, forged, expired, declined, already spent or already owned. */
export const CLAIM_GONE = 'There is no application waiting to be added here. It may have been added already, declined, or timed out.';
/** The one answer for an application that already belongs to an account, whichever. */
export const ALREADY_LINKED = 'This application is already linked to an account.';

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const claimCookieName = (form: string) => `tw_claim_${form}`;
const hashOf = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

/** A fresh claim: the browser's token, the root's hash, and when it stops counting. */
export function newClaim(now: Date): { token: string; hash: string; until: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashOf(token), until: new Date(now.getTime() + CLAIM_MINUTES * 60_000).toISOString() };
}

/** The claim's hash from the request's cookie, or undefined for none or anything malformed. */
export function readClaim(req: Pick<IncomingMessage, 'headers'>, form: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  const name = claimCookieName(form);
  let found: string | undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    if (found !== undefined) return undefined;
    found = part.slice(at + 1).trim();
  }
  return found !== undefined && TOKEN.test(found) ? hashOf(found) : undefined;
}

/** The Set-Cookie value: the claim for thirty minutes, or a clearing one. */
export function claimCookie(form: string, token: string | null, secure: boolean): string {
  const parts = [
    `${claimCookieName(form)}=${token ?? ''}`,
    `Path=/api/forms/${form}`,
    'HttpOnly',
    'SameSite=Strict',
    token === null ? 'Max-Age=0' : `Max-Age=${CLAIM_MINUTES * 60}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/**
 * Signing out burns every claim this browser holds (gate.ts): each linkable
 * form's cookie is cleared beside Better Auth's own, which it sets before it
 * writes the head. The token lived only in that cookie, so the claim is gone.
 */
export function burnClaimsOnSignOut(res: ServerResponse, app: Pick<AppDef, 'views'>, secure: boolean, base = ''): void {
  const forms = Object.entries(app.views)
    .filter(([, view]) => isPublicForm(view) && (view as AppFormView).link?.sameDevice)
    .map(([key]) => key);
  if (!forms.length) return;
  const writeHead = res.writeHead;
  res.writeHead = function (this: ServerResponse, ...args: Parameters<ServerResponse['writeHead']>) {
    const prior = res.getHeader('set-cookie');
    res.setHeader('set-cookie', [
      ...(prior === undefined ? [] : Array.isArray(prior) ? prior : [String(prior)]),
      ...forms.map((form) => cookieUnder(base, claimCookie(form, null, secure))),
    ]);
    return writeHead.apply(this, args);
  } as ServerResponse['writeHead'];
}

/** What the link needs of the form: where the draft state, the receipt and the link's own columns are. */
export interface LinkForm {
  save: AppFormSave;
  statusCheck: AppStatusCheck;
  link: AppFormLink;
}

type Records = Pick<WriteTransaction, 'query' | 'update'>;
interface Root {
  table: string;
  key: Record<string, string | number>;
  row: Record<string, unknown>;
}

const instant = storedInstant;
const empty = (value: unknown) => value === null || value === undefined || value === '';

/** The linking columns of a root row, as the compare-and-set needs them. */
function linkState(form: LinkForm): string[] {
  const { link } = form;
  return [link.owner, link.at, link.via, ...(link.sameDevice ? [link.sameDevice.token, link.sameDevice.expires] : [])];
}

/* An address as the match compares it: trimmed, lower-cased. */
const addressOf = (value: unknown) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
/* LIKE with its wildcards escaped: equality, case-insensitive where the engine's LIKE is. */
const likeExactly = (text: string) => text.replace(/[#%_]/g, (match) => `#${match}`);

async function findRoot(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  column: string,
  value: string,
): Promise<Root | undefined> {
  const found: Root[] = [];
  for (const table of roots) {
    const meta = catalog[table];
    if (!meta || meta.key.length !== 1) continue;
    const result = await records.query({
      table,
      limit: 2,
      offset: 0,
      filter: { groups: [[{ column, op: '=', value }]] },
      columns: [...new Set([...meta.key, form.save.draft.column, form.statusCheck.receipt, ...linkState(form)])],
    });
    for (const row of result.rows)
      found.push({ table, row, key: Object.fromEntries(meta.key.map((name) => [name, row[name] as string | number])) });
  }
  // A draft is no one's yet, and two rows under one value name nobody.
  return found.length === 1 && String(found[0].row[form.save.draft.column]) !== form.save.draft.value ? found[0] : undefined;
}

/** The root a live claim names: submitted, before its expiry, and nobody's. */
async function claimedRoot(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  claim: string,
  now: Date,
): Promise<Root | undefined> {
  const same = form.link.sameDevice;
  if (!same) return undefined;
  const root = await findRoot(records, catalog, roots, form, same.token, claim);
  if (!root || !empty(root.row[form.link.owner])) return undefined;
  const expires = instant(root.row[same.expires]);
  return Number.isFinite(expires) && expires > now.getTime() ? root : undefined;
}

/** The receipt a live claim names, for the question "Add application … to this account?"; undefined when it names nothing. */
export async function peekClaim(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  claim: string,
  now: Date,
): Promise<string | undefined> {
  const root = await claimedRoot(records, catalog, roots, form, claim, now);
  const reference = root?.row[form.statusCheck.receipt];
  return typeof reference === 'string' ? reference : undefined;
}

/**
 * Write the owner, once. The compare is on every linking column as it was
 * read, so a second link racing this one — or a claim spent twice — finds the
 * row changed and is refused; the claim's columns are cleared with it.
 */
async function writeLink(
  records: Records,
  form: LinkForm,
  root: Root,
  account: string,
  via: LinkPath,
  now: Date,
): Promise<'linked' | 'owned'> {
  if (!empty(root.row[form.link.owner])) return 'owned';
  const columns = linkState(form);
  const expected = Object.fromEntries(columns.map((name) => [name, (root.row[name] ?? null) as string | number | null]));
  const same = form.link.sameDevice;
  try {
    await records.update({
      table: root.table,
      key: root.key,
      expected,
      values: {
        [form.link.owner]: account,
        [form.link.at]: now.toISOString(),
        [form.link.via]: via,
        ...(same ? { [same.token]: null, [same.expires]: null } : {}),
      },
    });
  } catch (error) {
    if (error instanceof WriteConflict) return 'owned';
    throw error;
  }
  return 'linked';
}

/** Spend a claim for an account: link the root it names, and burn it. The receipt linked, or undefined for a claim that names nothing. */
export async function spendClaim(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  claim: string,
  account: string,
  now: Date,
): Promise<string | undefined> {
  const root = await claimedRoot(records, catalog, roots, form, claim, now);
  if (!root || (await writeLink(records, form, root, account, 'same-device', now)) !== 'linked') return undefined;
  return String(root.row[form.statusCheck.receipt]);
}

/** Burn a claim: the root forgets its hash, whatever it named. Nothing is said back. */
export async function burnClaim(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  claim: string,
): Promise<void> {
  const same = form.link.sameDevice;
  if (!same) return;
  const root = await findRoot(records, catalog, roots, form, same.token, claim);
  if (root) await records.update({ table: root.table, key: root.key, values: { [same.token]: null, [same.expires]: null } });
}

/** Link the application a passed status check found (by its receipt) to the signed-in account. */
export async function linkByReceipt(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  receipt: string,
  account: string,
  now: Date,
): Promise<'linked' | 'owned' | 'gone'> {
  const root = await findRoot(records, catalog, roots, form, form.statusCheck.receipt, receipt);
  return root ? writeLink(records, form, root, account, 'status-check', now) : 'gone';
}

/**
 * The submitted, unowned applications that captured this verified address:
 * those the applicant also proved in the form (`silent`), and those the
 * account must confirm (`offer`). Compared exactly, after the engine's LIKE
 * found the candidates; at most a handful.
 */
export async function applicationsByEmail(
  records: Pick<WriteTransaction, 'query'>,
  roots: readonly string[],
  form: LinkForm,
  email: string,
): Promise<{ silent: string[]; offer: string[] }> {
  const wanted = addressOf(email);
  const link = form.link.email;
  const found = { silent: [] as string[], offer: [] as string[] };
  if (!link || !wanted) return found;
  for (const table of roots) {
    const result = await records.query({
      table,
      limit: 20,
      offset: 0,
      filter: { groups: [[{ column: link.column, op: 'like', value: likeExactly(wanted) }]] },
      columns: [
        ...new Set([
          form.statusCheck.receipt,
          form.save.draft.column,
          form.link.owner,
          link.column,
          ...(link.verified ? [link.verified] : []),
        ]),
      ],
    });
    for (const row of result.rows) {
      if (
        String(row[form.save.draft.column]) === form.save.draft.value ||
        !empty(row[form.link.owner]) ||
        addressOf(row[link.column]) !== wanted
      )
        continue;
      const reference = row[form.statusCheck.receipt];
      if (typeof reference !== 'string') continue;
      (link.verified && addressOf(row[link.verified]) === wanted ? found.silent : found.offer).push(reference);
    }
  }
  return found;
}

/** Link one application by the account's verified address: still submitted, still nobody's, still that address. */
export async function linkByEmail(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  receipt: string,
  account: string,
  email: string,
  now: Date,
): Promise<'linked' | 'owned' | 'gone'> {
  const link = form.link.email;
  if (!link) return 'gone';
  const root = await findRoot(records, catalog, roots, form, form.statusCheck.receipt, receipt);
  if (!root) return 'gone';
  const held = await records.query({
    table: root.table,
    limit: 1,
    offset: 0,
    columns: [link.column],
    filter: { groups: [Object.entries(root.key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  if (addressOf(held.rows[0]?.[link.column]) !== addressOf(email) || !addressOf(email)) return 'gone';
  return writeLink(records, form, root, account, 'email', now);
}

/**
 * Stamp a draft's proved address (`email.verified`): the applicant typed a
 * code sent to it, in the form, before submitting. The draft is the one the
 * resume token names, and only while it is a draft.
 */
export async function stampVerifiedEmail(
  records: Records,
  catalog: CommandCatalog,
  roots: readonly string[],
  form: LinkForm,
  tokenHash: string,
  email: string,
): Promise<boolean> {
  const verified = form.link.email?.verified;
  if (!verified) return false;
  for (const table of roots) {
    const meta = catalog[table];
    if (!meta || meta.key.length !== 1) continue;
    const result = await records.query({
      table,
      limit: 2,
      offset: 0,
      filter: { groups: [[{ column: form.save.resume.token, op: '=', value: tokenHash }]] },
      columns: [...new Set([...meta.key, form.save.draft.column])],
    });
    if (result.rows.length !== 1 || String(result.rows[0][form.save.draft.column]) !== form.save.draft.value) continue;
    const key = Object.fromEntries(meta.key.map((name) => [name, result.rows[0][name] as string | number]));
    await records.update({ table, key, values: { [verified]: addressOf(email) } });
    return true;
  }
  return false;
}

/** An account's own applications: the receipt and the state the status check shows, read by the owner column alone. */
export async function ownedApplications(
  records: Pick<WriteTransaction, 'query'>,
  roots: readonly string[],
  form: LinkForm,
  account: string,
): Promise<Array<{ reference: string; status: Record<string, string | null> }>> {
  const check = form.statusCheck;
  const found: Array<{ reference: string; status: Record<string, string | null>; at: number }> = [];
  for (const table of roots) {
    const result = await records.query({
      table,
      limit: 50,
      offset: 0,
      filter: { groups: [[{ column: form.link.owner, op: '=', value: account }]] },
      columns: [...new Set([check.receipt, form.save.draft.column, form.link.at, ...check.show])],
    });
    for (const row of result.rows) {
      if (String(row[form.save.draft.column]) === form.save.draft.value || typeof row[check.receipt] !== 'string') continue;
      found.push({
        reference: row[check.receipt] as string,
        at: instant(row[form.link.at]),
        status: Object.fromEntries(check.show.map((name) => [name, statusWords(check, name, row[name])])),
      });
    }
  }
  return found.sort((a, b) => (b.at || 0) - (a.at || 0)).map(({ reference, status }) => ({ reference, status }));
}

/* The link's record in the server's log: who, which application (a digest of
   its receipt, as the status check's), by which path, and what came of it. */
export function recordLink(
  form: string,
  event: 'form.link' | 'form.claim',
  outcome: string,
  detail: { account?: string; receipt?: string; via?: LinkPath },
): void {
  process.stderr.write(
    `${JSON.stringify({
      event,
      form,
      outcome,
      ...(detail.account ? { account: detail.account } : {}),
      ...(detail.via ? { via: detail.via } : {}),
      ...(detail.receipt ? { receipt: createHash('sha256').update(`${form}\u0000${detail.receipt}`).digest('hex').slice(0, 16) } : {}),
    })}\n`,
  );
}
