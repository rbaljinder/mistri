/**
 * A public form saved on every step, at run time: the applicant's place in
 * the App's real tables, and the fence that keeps a step to its own
 * application.
 *
 * The first step's handler inserts the application's root row in its draft
 * state, spreading `draft.start` into it: the SHA-256 of a fresh 256-bit
 * token, the expiry, the first step's id. The token itself goes to the
 * browser once, in an HttpOnly, SameSite=Strict cookie scoped to the form's
 * own API path, and is never stored. Every later step and the submit find the
 * root again by the cookie's hash — in the draft state, before its expiry —
 * inside the step's own transaction, so a submit racing a step is ordered by
 * the database. Nothing the page sends names a row: no key, no position the
 * server did not map.
 *
 * Why a token and not an encrypted id: it is revocable (the hash is cleared on
 * submit), needs no key management, and there is no ciphertext to tamper with
 * or replay against another application.
 *
 * The fence (`applicationRecords`) is what makes "a step touches only its own
 * application" structural rather than the handler's good manners. Under it a
 * step reads and writes the root row by its key alone, and the tables that
 * reference the root only where their link column names it; it inserts child
 * rows with the link filled by the server; it writes no other table and never
 * the columns the platform keeps. A handler that reached for another
 * application's row would find nothing to read and be refused on a write.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { InsertRequest, InsertResult, WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { Condition, Filter } from '@mistriwork/engine/shared/filter.js';
import type { AppFormSave } from '../../shared/appSavedForms.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import { keyFilter, type CommandCatalog } from '../commands/commandDb.js';

/** What the route tells the executor about a saved form's step: never a request field. */
export interface SavedDraftRun {
  /** `start` creates the root; `step` saves into it; `submit` finishes it. */
  readonly phase: 'start' | 'step' | 'submit';
  /** The step's id; the submit's is `submit`. */
  readonly step: string;
  /** The SHA-256 (hex) of the applicant's token: on `start`, of the one just made. */
  readonly token: string;
  readonly save: AppFormSave;
  /** The form's step ids, in order: progress is kept in it. */
  readonly order: readonly string[];
  /** The tables a root may be in, where this request lands: local names. */
  readonly roots: readonly string[];
  /** The root's other columns the server keeps and no handler writes: the link's, the alert's (platformColumns). */
  readonly owned: readonly string[];
  /** A submit that leaves a claim in this browser (formLink.ts): its hash and expiry, written with the submit. */
  readonly claim?: {
    readonly columns: { readonly token: string; readonly expires: string };
    readonly hash: string;
    readonly until: string;
  };
}

/** What a saved step's handler is told (`context.draft`). */
export interface SavedDraftContext {
  /** The step's id, or `submit`. */
  readonly step: string;
  /**
   * On the first step, the columns the root row is inserted with: spread them
   * into it (`db.application.insert({ ...input, ...draft.start })`). Empty on
   * every later step.
   */
  readonly start: Readonly<Record<string, string>>;
  /** On every later step and the submit: the root row's key, resolved from the cookie. Null on the first. */
  readonly root: Readonly<Record<string, string | number>> | null;
}

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[0-9a-f]{64}$/;

/** A fresh token for a new application, and the hash the root row keeps. */
export function newDraftToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: draftTokenHash(token) };
}

export function draftTokenHash(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** The cookie's name: one per form, so two forms' drafts never meet. */
const draftCookieName = (form: string): string => `tw_form_${form}`;

/** The applicant's token from the request's cookie, or undefined for none or anything malformed. */
export function readDraftToken(req: Pick<IncomingMessage, 'headers'>, form: string): string | undefined {
  const header = req.headers.cookie;
  if (typeof header !== 'string' || header.length > 8192) return undefined;
  const name = draftCookieName(form);
  let found: string | undefined;
  for (const part of header.split(';')) {
    const at = part.indexOf('=');
    if (at < 0 || part.slice(0, at).trim() !== name) continue;
    // Two cookies of one name (a path trick from a sibling page) name nobody.
    if (found !== undefined) return undefined;
    found = part.slice(at + 1).trim();
  }
  return found !== undefined && TOKEN.test(found) ? found : undefined;
}

/**
 * The Set-Cookie value: the token for `days`, or a clearing one. HttpOnly —
 * no script on the page reads it, the App's own included — SameSite=Strict,
 * and scoped to the form's own API path so no other route of the App is sent
 * it. Secure wherever a browser would keep a Secure cookie: over TLS, behind
 * a proxy that said so, or on this machine; a plain-HTTP address on another
 * host could not resume at all with it, and the docs say to serve a saved
 * form over HTTPS.
 */
export function draftCookie(form: string, token: string | null, days: number, secure: boolean): string {
  const parts = [
    `${draftCookieName(form)}=${token ?? ''}`,
    `Path=/api/forms/${form}`,
    'HttpOnly',
    'SameSite=Strict',
    token === null ? 'Max-Age=0' : `Max-Age=${days * 86_400}`,
  ];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

/** Whether a browser keeps a Secure cookie from this request. */
export function secureRequest(req: Pick<IncomingMessage, 'headers' | 'socket'>, trustedForwarded: boolean): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  if (
    trustedForwarded &&
    String(req.headers['x-forwarded-proto'] ?? '')
      .split(',')[0]
      .trim() === 'https'
  )
    return true;
  const host = String(req.headers.host ?? '')
    .replace(/:\d+$/, '')
    .replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host.endsWith('.localhost');
}

/** The one sentence for every draft that cannot be continued: forged, expired, submitted or another's. */
export const DRAFT_GONE = 'This application can no longer be continued. Start a new one.';
const gone = (): never => {
  throw new BusinessCommandExecutionError('not_found', 'not_applied', undefined, undefined, DRAFT_GONE);
};
const deny = (): never => {
  throw new AppAccessDenied();
};

/** `a,b` in the form's step order: what the progress column holds. */
function progressText(order: readonly string[], saved: Iterable<string>): string {
  const set = new Set(saved);
  return order.filter((step) => set.has(step)).join(',');
}
function progressOf(value: unknown, order: readonly string[]): string[] {
  if (typeof value !== 'string') return [];
  const said = new Set(value.split(','));
  return order.filter((step) => said.has(step));
}

/**
 * A stored moment as milliseconds, or NaN. SQLite keeps what was written, and
 * a bare `YYYY-MM-DD HH:MM:SS` there is UTC, as it was written. PostgreSQL may
 * answer a timestamptz as its text, `2026-10-09 05:21:53.1234-04`, whose
 * hour-only offset JavaScript's parser refuses: read as `-04:00`, it is the
 * same moment. A value that reads as no moment is NaN, and an expiry that is
 * NaN has passed.
 */
export const storedInstant = (value: unknown): number => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' || typeof value === 'number') {
    let text = value;
    if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/.test(value)) {
      text = value.replace(' ', 'T');
      if (/[+-]\d{2}$/.test(text)) text = `${text}:00`;
      else if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(text)) text = `${text}Z`;
    }
    const time = new Date(text).getTime();
    return Number.isFinite(time) ? time : NaN;
  }
  return NaN;
};
const instant = storedInstant;

/** Every table of the footprint that references a root, and the column it references it by. */
export function draftChildren(catalog: CommandCatalog, root: string): ReadonlyMap<string, string> {
  const children = new Map<string, string>();
  const last = (name: string) => name.slice(name.lastIndexOf('.') + 1);
  for (const [name, table] of Object.entries(catalog)) {
    if (name === root) continue;
    const link = table.meta.columns.find((column) => column.references && last(column.references.table) === last(root));
    if (link) children.set(name, link.name);
  }
  return children;
}

const and = (filter: Filter | undefined, conditions: Condition[]): Filter => ({
  groups: filter?.groups.length ? filter.groups.map((group) => [...group, ...conditions]) : [conditions],
});
const same = (a: unknown, b: unknown) => a !== null && a !== undefined && String(a) === String(b);

interface Opened {
  readonly context: SavedDraftContext;
  /** The transaction the step runs under: its own application, and nothing else. */
  readonly records: WriteTransaction;
  /** After the handler, in the same transaction: keep the place, or finish it. */
  finish(): Promise<void>;
}

/**
 * Open the step's application inside its transaction: find the root by the
 * cookie's hash (a later step, the submit), or prepare its creation (the
 * first), and fence the handler's transaction to it.
 */
export async function openSavedDraft(run: SavedDraftRun, records: WriteTransaction, catalog: CommandCatalog, now: Date): Promise<Opened> {
  if (!HASH.test(run.token)) return gone();
  const { save } = run;
  const owned = new Set([save.resume.token, save.resume.expires, save.resume.progress, ...run.owned]);
  const roots = run.roots.filter((name) => Object.hasOwn(catalog, name));
  if (!roots.length) return deny();
  const draftState: Condition = { column: save.draft.column, op: '=', value: save.draft.value };
  const byToken: Condition = { column: save.resume.token, op: '=', value: run.token };

  if (run.phase === 'start') {
    if (save.abandoned === 'purge') for (const root of roots) await purgeExpired(records, catalog, root, run, now);
    const start = Object.freeze({
      [save.resume.token]: run.token,
      [save.resume.expires]: new Date(now.getTime() + save.resume.days * 86_400_000).toISOString(),
      [save.resume.progress]: run.step,
      [save.draft.column]: save.draft.value,
    });
    let created: { table: string; key: Readonly<Record<string, string | number>> } | undefined;
    const fence = applicationRecords(records, catalog, () => created, owned, save, false, {
      insertRoot: async (table, values) => {
        // One root, with exactly the columns the platform said.
        if (created || Object.entries(start).some(([column, value]) => values[column] !== value)) return deny();
        const result = await records.insert({ table, values });
        created = { table, key: Object.freeze({ ...result.key }) };
        return result;
      },
      roots,
    });
    return {
      context: Object.freeze({ step: run.step, start, root: null }),
      records: fence,
      finish: async () => {
        if (!created) throw new BusinessCommandExecutionError('invalid_result');
      },
    };
  }

  const found: Array<{ table: string; row: Record<string, unknown> }> = [];
  for (const table of roots) {
    const meta = catalog[table];
    if (meta.key.length !== 1) return deny();
    const result = await records.query({
      table,
      filter: { groups: [[byToken, draftState]] },
      limit: 2,
      offset: 0,
      columns: [...meta.key, save.resume.expires, save.resume.progress],
    });
    for (const row of result.rows) found.push({ table, row });
  }
  if (found.length !== 1) return gone();
  const [{ table: rootTable, row }] = found;
  const expires = instant(row[save.resume.expires]);
  if (!Number.isFinite(expires) || expires <= now.getTime()) return gone();
  const rootKey = Object.freeze(Object.fromEntries(catalog[rootTable].key.map((column) => [column, row[column] as string | number])));
  const saved = progressOf(row[save.resume.progress], run.order);
  if (run.phase === 'submit' && run.order.some((step) => !saved.includes(step))) {
    throw new BusinessCommandExecutionError(
      'ineligible_state',
      'not_applied',
      undefined,
      undefined,
      'Some steps of this application are not saved yet. Go back and continue them.',
    );
  }
  const root = { table: rootTable, key: rootKey };
  const fence = applicationRecords(records, catalog, () => root, owned, save, run.phase === 'step', { roots });
  return {
    context: Object.freeze({ step: run.step, start: Object.freeze({}), root: rootKey }),
    records: fence,
    finish: async () => {
      if (run.phase === 'step') {
        const progress = progressText(run.order, [...saved, run.step]);
        await records.update({ table: rootTable, key: { ...rootKey }, values: { [save.resume.progress]: progress } });
        return;
      }
      /* The submit moved the application out of its draft state (the handler
         did), and the token dies with it: a cookie that outlived the submit,
         or a copy of it, finds nothing. */
      const after = await records.query({
        table: rootTable,
        filter: keyFilter({ ...rootKey }),
        limit: 2,
        offset: 0,
        columns: [save.draft.column],
      });
      if (after.rows.length !== 1 || same(after.rows[0][save.draft.column], save.draft.value))
        throw new BusinessCommandExecutionError('invalid_result');
      await records.update({
        table: rootTable,
        key: { ...rootKey },
        values: {
          [save.resume.token]: null,
          ...(run.claim ? { [run.claim.columns.token]: run.claim.hash, [run.claim.columns.expires]: run.claim.until } : {}),
        },
      });
    },
  };
}

/**
 * The step's transaction, fenced to one application. `root()` is the root
 * once known (on the first step, after its insert). `holdState`: a step (not
 * the submit) leaves the draft column as it is.
 */
function applicationRecords(
  records: WriteTransaction,
  catalog: CommandCatalog,
  root: () => { table: string; key: Readonly<Record<string, string | number>> } | undefined,
  owned: ReadonlySet<string>,
  save: AppFormSave,
  holdState: boolean,
  options: { roots: readonly string[]; insertRoot?: (table: string, values: InsertRequest['values']) => Promise<InsertResult> },
): WriteTransaction {
  const isRoot = (table: string) => options.roots.includes(table);
  const childLink = (table: string): string | undefined => {
    const current = root();
    return current ? draftChildren(catalog, current.table).get(table) : undefined;
  };
  const rootValue = () => {
    const current = root()!;
    return Object.values(current.key)[0];
  };
  const keyConditions = (key: Readonly<Record<string, string | number>>): Condition[] =>
    Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }));
  /** The filter a read runs under: the root by its key, a child by its link, anything else as asked. */
  const scoped = (table: string, filter: Filter | undefined): Filter | undefined => {
    const current = root();
    if (isRoot(table)) {
      // Before the first step's insert there is no root to see; a root in another table is not this one.
      if (!current || current.table !== table)
        return {
          groups: [
            [
              { column: save.resume.token, op: 'isNull' },
              { column: save.resume.token, op: 'isNotNull' },
            ],
          ],
        };
      return and(filter, keyConditions(current.key));
    }
    const link = childLink(table);
    if (link) return and(filter, [{ column: link, op: '=', value: rootValue() }]);
    return filter;
  };
  const touchesOwned = (values: Record<string, unknown>) => Object.keys(values).some((column) => owned.has(column));
  /** The child row this key names, and only when it is this application's. */
  const ownChild = async (table: string, key: Record<string, string | number>): Promise<void> => {
    const link = childLink(table) ?? deny();
    const found = await records.query({
      table,
      filter: and(keyFilter(key), [{ column: link, op: '=', value: rootValue() }]),
      limit: 2,
      offset: 0,
      columns: Object.keys(key),
    });
    if (found.rows.length !== 1) deny();
  };
  return Object.freeze<WriteTransaction>({
    query: (request) => records.query({ ...request, filter: scoped(request.table, request.filter) }),
    count: (table, filter) => records.count(table, scoped(table, filter)),
    insert: async (request) => {
      if (isRoot(request.table)) return options.insertRoot ? options.insertRoot(request.table, request.values) : deny();
      const link = childLink(request.table) ?? deny();
      if (touchesOwned(request.values)) return deny();
      const given = request.values[link];
      if (given !== undefined && given !== null && !same(given, rootValue())) return deny();
      return records.insert({ ...request, values: { ...request.values, [link]: rootValue() } });
    },
    update: async (request) => {
      const current = root();
      if (touchesOwned(request.values)) return deny();
      if (isRoot(request.table)) {
        if (
          !current ||
          current.table !== request.table ||
          Object.keys(request.key).length !== Object.keys(current.key).length ||
          Object.entries(current.key).some(([column, value]) => !same(request.key[column], value))
        )
          return deny();
        if (holdState && Object.hasOwn(request.values, save.draft.column)) return deny();
        return records.update(request);
      }
      const link = childLink(request.table) ?? deny();
      if (Object.hasOwn(request.values, link) && !same(request.values[link], rootValue())) return deny();
      await ownChild(request.table, request.key);
      return records.update(request);
    },
    remove: async (request) => {
      if (isRoot(request.table)) return deny();
      await ownChild(request.table, request.key);
      return records.remove(request);
    },
  });
}

/**
 * The declared purge: drafts of this form past their expiry, removed with the
 * rows that reference them, a few at a time as new applications start in the
 * same place. A draft whose children are more than one pass removes is left
 * for the next.
 */
async function purgeExpired(
  records: WriteTransaction,
  catalog: CommandCatalog,
  root: string,
  run: SavedDraftRun,
  now: Date,
): Promise<void> {
  const { save } = run,
    meta = catalog[root];
  if (meta.key.length !== 1) return;
  const [key] = meta.key;
  const candidates = await records.query({
    table: root,
    limit: 25,
    offset: 0,
    columns: [key, save.resume.expires],
    filter: {
      groups: [
        [
          { column: save.draft.column, op: '=', value: save.draft.value },
          { column: save.resume.expires, op: 'isNotNull' },
        ],
      ],
    },
  });
  const expired = candidates.rows.filter((row) => {
    const at = instant(row[save.resume.expires]);
    return Number.isFinite(at) && at <= now.getTime();
  });
  for (const row of expired.slice(0, 10)) {
    const value = row[key] as string | number;
    const children = [...draftChildren(catalog, root)];
    const doomed: Array<{ table: string; key: Record<string, string | number> }> = [];
    let whole = true;
    for (const [table, link] of children) {
      const child = catalog[table];
      const rows = await records.query({
        table,
        limit: 101,
        offset: 0,
        columns: [...child.key],
        filter: { groups: [[{ column: link, op: '=', value }]] },
      });
      if (rows.rows.length > 100) {
        whole = false;
        break;
      }
      for (const found of rows.rows)
        doomed.push({ table, key: Object.fromEntries(child.key.map((column) => [column, found[column] as string | number])) });
    }
    if (!whole) continue;
    for (const entry of doomed) await records.remove(entry);
    await records.remove({ table: root, key: { [key]: value } });
  }
}

/** Whether a refusal is the one every draft that cannot be continued gets: the cookie is cleared with it. */
export function isDraftGone(error: unknown): boolean {
  return error instanceof BusinessCommandExecutionError && error.code === 'not_found' && error.reason === DRAFT_GONE;
}

/**
 * The resume: which steps of the applicant's draft are saved, by id — never
 * what was typed in them. Empty for no draft, a forged cookie, an expired or
 * a submitted one, alike.
 */
export async function readDraftProgress(
  records: Pick<WriteTransaction, 'query'>,
  catalog: CommandCatalog,
  roots: readonly string[],
  save: AppFormSave,
  token: string,
  order: readonly string[],
  now: Date,
): Promise<string[]> {
  if (!HASH.test(token)) return [];
  const found: Record<string, unknown>[] = [];
  for (const table of roots) {
    if (!Object.hasOwn(catalog, table)) continue;
    const result = await records.query({
      table,
      limit: 2,
      offset: 0,
      columns: [save.resume.expires, save.resume.progress],
      filter: {
        groups: [
          [
            { column: save.resume.token, op: '=', value: token },
            { column: save.draft.column, op: '=', value: save.draft.value },
          ],
        ],
      },
    });
    found.push(...result.rows);
  }
  if (found.length !== 1) return [];
  const expires = instant(found[0][save.resume.expires]);
  return Number.isFinite(expires) && expires > now.getTime() ? progressOf(found[0][save.resume.progress], order) : [];
}
