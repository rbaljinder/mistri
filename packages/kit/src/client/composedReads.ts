/**
 * The answers a composed record page brought, kept for the requests they
 * answer (shared/recordReads.ts says why a record page is one request).
 *
 * `request` (core.js) asks here before it sends a read: a section asking
 * exactly what the server already asked on its behalf is answered at once,
 * and only a request built differently, or one the server could not answer,
 * goes out as it always did. Each answer is for one asking — a refetch, a
 * tab coming back, a second look, is a fresh read — and none outlives
 * LIFETIME, the session it was read in, its connection or the next write.
 *
 * The record's own row is kept whole: every reader of it (the root probe,
 * each fields section, the header, a custom section's record fields) is
 * answered with exactly its columns, once per set of columns.
 *
 * It tells the request path of itself as it loads (composedHook.ts), so
 * the request path asks it only where a module that reads record pages is
 * loaded: the public page carries none of it.
 */
import { canonicalText, rowPart, rowRead } from '@mistriwork/engine/shared/recordReadKeys.js';
import { commandKeyText } from '@mistriwork/engine/shared/commandWire.js';
import { composedConnection, setComposedReads } from './composedHook.js';
import { sessionIdentity } from './sessionIdentity.js';

/** One read the server asked for the page, and its answer (server/http/recordCompose.ts). */
export interface ComposedRead {
  path: string;
  body: Record<string, unknown>;
  status: number;
  reply: unknown;
}

/* Long enough for a panel opened just after the page to find its answer, and
   no longer: past it a read is the reader's own again. */
const LIFETIME = 15_000;
/* How long a record's own read waits for a compose already on its way. */
const WAIT = 5_000;

interface Held {
  identity: ReturnType<typeof sessionIdentity>;
  connection: string | null;
  until: number;
  exact: Map<string, unknown>;
  rows: Array<{ base: string; filter: string; columns: Set<string>; reply: RowReply; asked: Set<string> }>;
  checks: Map<string, boolean>;
}
interface RowReply {
  view: { columns: Array<{ path: string }> } & Record<string, unknown>;
  columns: string[];
  rows: Array<Record<string, unknown>>;
  resolved?: Array<{ path: string; name?: string }>;
}

let held: Held[] = [];
const pending = new Map<Promise<unknown>, { connection: string | null; since: number }>();
/* Counts every write sent and every write answered (core.js). A compose's
   answers are the record as the server read it, which is only the record
   now if no write was sent or answered while it was out: one begun before a
   command, or while it ran, read the row from before it, and landing after
   the write it would answer the next read of the page — the refresh the
   write itself asked for — with the old row. On PostgreSQL, where a tenant's
   compose takes seconds, that was the page left showing the old status and
   fields after a command, a post or a tag, and the next change refused as
   stale. */
let writes = 0;

/* A selector is the transport's, never part of what is asked. */
const asked = (body: Record<string, unknown> | undefined) => {
  if (!body) return {};
  const { app: _app, conn: _conn, ...rest } = body;
  return rest;
};
const exactKey = (path: string, body: Record<string, unknown>) => `${path}\u0000${canonicalText(asked(body))}`;
const checkKey = (command: string, version: number, key: unknown) =>
  `${command}\u0000${version}\u0000${commandKeyText(key as Record<string, string | number>)}`;
const clone = <T>(value: T): T =>
  typeof structuredClone === 'function' ? structuredClone(value) : (JSON.parse(JSON.stringify(value)) as T);

function live(connection: string | null): Held[] {
  const now = Date.now(),
    identity = sessionIdentity();
  held = held.filter((batch) => batch.until > now && batch.identity === identity);
  return held.filter((batch) => batch.connection === connection);
}

/** Where the writes stand: a compose takes it as it is sent and hands it back with its answers. */
export const composedEpoch = (): number => writes;

/** A composed page's reads, kept for the requests they answer — unless a write was sent or answered since `since`, the epoch its compose began in. */
export function holdComposed(connection: string | null, reads: readonly ComposedRead[], since: number): void {
  if (since !== writes) return;
  const batch: Held = {
    identity: sessionIdentity(),
    connection,
    until: Date.now() + LIFETIME,
    exact: new Map(),
    rows: [],
    checks: new Map(),
  };
  for (const read of reads) {
    if (read.status >= 400 || !read.reply || typeof read.reply !== 'object') continue;
    const row = read.path === '/api/view/run' ? rowRead(read.body) : undefined;
    if (row && Array.isArray((read.reply as RowReply).rows)) {
      batch.rows.push({
        base: row.base,
        filter: row.filter,
        columns: new Set(row.columns),
        reply: read.reply as RowReply,
        asked: new Set(),
      });
      continue;
    }
    if (read.path === '/api/commands/availability') {
      const checks = (read.body as { checks?: Array<{ command: string; commandVersion: number; keys: unknown[] }> }).checks ?? [];
      const answers = (read.reply as { checks?: Array<{ command: string; commandVersion: number; available: boolean[] }> }).checks ?? [];
      checks.forEach((check, i) =>
        check.keys.forEach((key, k) => {
          const answer = answers[i];
          if (
            answer?.command === check.command &&
            answer.commandVersion === check.commandVersion &&
            typeof answer.available?.[k] === 'boolean'
          ) {
            batch.checks.set(checkKey(check.command, check.commandVersion, key), answer.available[k]);
          }
        }),
      );
      continue;
    }
    batch.exact.set(exactKey(read.path, read.body), read.reply);
  }
  held.push(batch);
}

/** A compose on its way: a record's own read asked meanwhile waits for it rather than asking beside it. */
export function composing(connection: string | null, work: Promise<unknown>): void {
  const entry = { connection, since: Date.now() };
  pending.set(work, entry);
  const done = () => {
    pending.delete(work);
  };
  work.then(done, done);
}

/** Every answer forgotten, and every compose still out with them: after a write, what was read before it is not the record any more. */
function forgetComposed(): void {
  writes += 1;
  held = [];
  /* A record's own read no longer waits for a compose begun before the write: it could not answer it. */
  pending.clear();
}

const COMPOSABLE = new Set(['/api/view/run', '/api/run', '/api/breakdown', '/api/record-history']);
/** Whether a compose kept, or on its way, could answer this request: asked before waiting on one, so any other request goes out in the same moment it always did. */
export function mayBeComposed(path: string): boolean {
  return COMPOSABLE.has(path) && (held.length > 0 || pending.size > 0);
}

/**
 * The answer the page's compose brought for this request, once, or
 * undefined. A read of the record's own row waits for a compose still on
 * its way; everything else a page asks is asked after its plan, which comes
 * with the answers.
 */
export async function composedReply(path: string, body: Record<string, unknown> | undefined): Promise<unknown> {
  if (!COMPOSABLE.has(path)) return undefined;
  const connection = ((body?.app ?? body?.conn) as string | undefined) ?? composedConnection();
  const given = asked(body);
  const row = path === '/api/view/run' ? rowRead(given) : undefined;
  if (row) {
    await composeUnderway(connection);
    const once = row.columns.slice().sort().join('\u0000');
    for (const batch of live(connection)) {
      const found = batch.rows.find(
        (kept) =>
          kept.base === row.base &&
          kept.filter === row.filter &&
          !kept.asked.has(once) &&
          row.columns.every((column) => kept.columns.has(column)),
      );
      if (!found) continue;
      found.asked.add(once);
      return clone(rowPart(found.reply, row.columns));
    }
    return undefined;
  }
  if (!held.length) return undefined;
  const key = exactKey(path, given);
  for (const batch of live(connection)) {
    if (!batch.exact.has(key)) continue;
    const reply = batch.exact.get(key);
    batch.exact.delete(key);
    return clone(reply);
  }
  return undefined;
}

/** The composes on their way for this connection, as one wait no longer than WAIT; undefined when none is out. */
export function composeUnderway(connection: string | null): Promise<void> | undefined {
  const now = Date.now();
  const waiting = [...pending].filter(([, entry]) => entry.connection === connection && now - entry.since < WAIT).map(([work]) => work);
  if (!waiting.length) return undefined;
  return Promise.race([Promise.allSettled(waiting), new Promise((resolve) => setTimeout(resolve, WAIT))]).then(() => {});
}

/** Whether a command is available on a record, as the page's compose was told, once; undefined where it was not asked. */
export function composedCheck(connection: string | null, command: string, version: number, key: unknown): boolean | undefined {
  if (!held.length) return undefined;
  const wanted = checkKey(command, version, key);
  for (const batch of live(connection)) {
    const answer = batch.checks.get(wanted);
    if (answer === undefined) continue;
    batch.checks.delete(wanted);
    return answer;
  }
  return undefined;
}

setComposedReads({ reply: composedReply, may: mayBeComposed, forget: forgetComposed });
