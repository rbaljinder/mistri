/**
 * One transaction's own handle on a leased PostgreSQL client.
 *
 * A writer's client is pooled: the same object serves one transaction after
 * another. Something true of one transaction only — the membership rows its
 * fence locked, held to its end (tenantWriteSource.ts) — must
 * therefore be kept on an object that is that transaction's alone: made at
 * its BEGIN, used for every statement it sends, dropped with it. Never on the
 * client, and never keyed by a pool connection.
 *
 * It also counts the rollbacks that pass through it. A `ROLLBACK TO
 * SAVEPOINT` undoes everything since the savepoint, the locks taken there
 * included, so whatever was established before it is no longer vouched for.
 * Any statement that says ROLLBACK anywhere counts, a string literal
 * included: a false count only costs a repeated check.
 */
import { pipelines, type PgQuery, type PgResult } from './postgresPool.js';
import { EpochCache } from './epochCache.js';

/* Each handle's transaction, shared with its views: the one object what is
   true of that transaction may be kept on. */
interface TransactionState {
  count: number;
  pipelines: boolean;
  /** Answers to statements sent before their turn (sendAhead), by what each says: each answers the next identical query once. */
  ahead: Map<string, Promise<unknown>[]>;
  /** What became of them (aheadReport). */
  report: AheadReport;
  /** Moves with every statement sent that is not a read or a lock, and every one that fails (generationOf). */
  generation: number;
  /** Reads sent ahead for a caller to answer from (holdAhead), by what each said, and whether one was. */
  held: Map<string, { taken: boolean }>;
  /** The leased client's own query: what is sent ahead goes straight to it, not through the handle that waits to answer it. */
  send: (...args: unknown[]) => Promise<unknown>;
  /** Writes no one reads an answer of before COMMIT (beforeCommit), sent with the next statement that leaves. */
  tail: unknown[][];
  /** Called the moment a write a caller waits for is sent (behindWrite), so what they send leaves right behind it. */
  riders: Array<{ match: (text: string) => boolean; ride: () => void }>;
  /** The adapter the transaction runs on: what its runtime stores were attested for (attestOnce). */
  origin?: object;
}
const transactions = new WeakMap<PgQuery, TransactionState>();

/** What became of a transaction's statements sent ahead. */
export interface AheadReport {
  /** Sent before their turn. */
  sent: number;
  /** Of those, the ones a later identical query took. */
  taken: number;
  /** Statements asked in their turn while answers sent ahead were still waiting: each cost a round trip one sent ahead might have saved. */
  missed: number;
  /** Answers sent ahead that nothing took before they were dropped, by what each said. */
  left: string[];
  /** Times the transaction began again without them, because one failed. */
  redone: number;
  /** Reads answered from a row read ahead (holdAhead) instead of being sent. */
  answered: number;
  /** What was asked in its turn while answers sent ahead were waiting, by its first words: the missed, and what dropped them. */
  asked: string[];
}

/* What leaves answers sent ahead standing: a read or a row or table lock.
   Anything else — this transaction's own write, a savepoint, a notification,
   a statement that fails — may change what they read, and they are dropped,
   to be asked again in their turn. */
const KEEPS = /^\s*(?:SELECT|WITH|LOCK)\b/i;
const CHANGES = /\b(?:INSERT\s+INTO|DELETE\s+FROM|MERGE\s+INTO|UPDATE\s+(?:ONLY\s+)?[^\s(]+\s+SET|ROLLBACK|pg_notify|nextval|setval)\b/i;
/* A row lock asked in its turn: answers read ahead of it were read before it
   was granted, so they are dropped (a read after a lock sees what the lock
   waited for). A table LOCK pins a catalog, not rows, and leaves them. */
const ROW_LOCK = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;

const textOf = (request: unknown): unknown =>
  typeof request === 'string' ? request : request && typeof request === 'object' ? (request as { text?: unknown }).text : undefined;

/** What a statement says, as the key an answer sent ahead is found by; undefined for one that cannot be compared. */
function said(args: readonly unknown[]): string | undefined {
  const [request, params] = args;
  try {
    if (typeof request === 'string') return JSON.stringify([request, params ?? []]);
    if (request && typeof request === 'object' && typeof (request as { text?: unknown }).text === 'string') {
      const { text, values, rowMode } = request as { text: string; values?: unknown[]; rowMode?: unknown };
      return JSON.stringify([text, values ?? params ?? [], rowMode ?? null]);
    }
  } catch {
    /* A value JSON cannot say (a bigint): asked in its turn. */
  }
  return undefined;
}

export function transactionHandle(client: PgQuery, origin?: object): PgQuery {
  const state: TransactionState = {
    origin,
    count: 0,
    pipelines: pipelines(client),
    ahead: new Map(),
    report: { sent: 0, taken: 0, missed: 0, left: [], redone: 0, answered: 0, asked: [] },
    generation: 0,
    held: new Map(),
    send: (...args) => (client.query as (...values: unknown[]) => Promise<unknown>)(...args),
    tail: [],
    riders: [],
  };
  // Every argument passes through as given: a statement with no parameters
  // stays one the simple protocol may carry.
  const query = ((...args: unknown[]) => {
    const text = textOf(args[0]);
    // Counted before it is sent: a rollback that fails half way still counts.
    if (typeof text !== 'string' || /\bROLLBACK\b/i.test(text)) state.count += 1;
    if (state.ahead.size) {
      const key = said(args);
      const waiting = key === undefined ? undefined : state.ahead.get(key);
      if (waiting?.length) {
        const answer = waiting.shift()!;
        if (!waiting.length) state.ahead.delete(key!);
        state.report.taken += 1;
        return answer;
      }
    }
    // A rollback of the whole transaction: what waited for its COMMIT is never sent.
    if (typeof text === 'string' && /^\s*ROLLBACK\s*;?\s*$/i.test(text)) {
      state.tail = [];
      state.riders = [];
    }
    // A transaction that changes the catalog itself no longer stands on the version it read: it reads one again.
    if (typeof text === 'string' && changesCatalog(text)) catalogVersions.delete(handle);
    // What waited for the COMMIT leaves in front of whatever leaves next, in its order.
    const tail = state.tail.length ? state.tail.splice(0) : undefined;
    const changes = !!tail || typeof text !== 'string' || !KEEPS.test(text) || CHANGES.test(text);
    if (changes) state.generation += 1;
    if (state.ahead.size) {
      const first = typeof text === 'string' ? text.replace(/\s+/g, ' ').slice(0, 120) : '(not a statement)';
      if (changes || ROW_LOCK.test(text as string)) {
        state.report.asked.push(`dropped by: ${first}`);
        drop(state);
      } else {
        state.report.missed += 1;
        state.report.asked.push(first);
      }
    }
    const before = tail?.map((statement) => state.send(...statement));
    const commit = typeof text === 'string' && /^\s*COMMIT\s*;?\s*$/i.test(text);
    let answer =
      before && commit ? commitBehind(client, before, args) : (client.query as (...values: unknown[]) => Promise<unknown>)(...args);
    if (state.riders.length && typeof text === 'string')
      for (const rider of state.riders.filter((candidate) => candidate.match(text))) {
        state.riders.splice(state.riders.indexOf(rider), 1);
        rider.ride();
      }
    // A submittable or a callback's query answers no promise: it is passed back as it is.
    if (typeof (answer as { catch?: unknown } | undefined)?.catch !== 'function') return answer;
    if (before) answer = behind(before, answer, commit);
    // A statement that fails aborts the transaction: nothing sent ahead of it can be taken after, nor any row read before it trusted.
    return answer.catch((error: unknown) => {
      state.generation += 1;
      drop(state);
      if (state.origin && suspectsStores(error)) forgetAttestations(state.origin, handle, error);
      throw error;
    });
  }) as PgQuery['query'];
  const handle: PgQuery = Object.freeze({ query });
  transactions.set(handle, state);
  return handle;
}

/**
 * Send statements now that the transaction will ask for later, so they leave
 * in the flight already going out (behind its BEGIN) instead of each in a
 * round trip of its own. Each answer is kept for the first later query that
 * says exactly the same thing, and given to it once; the query then sends
 * nothing. Only reads and locks are sent ahead, in the order the transaction
 * would ask them, and every kept answer is dropped the moment the transaction
 * sends anything else — a write of its own, a rollback to a savepoint — so a
 * read after this transaction's own change is always asked again.
 *
 * The caller awaits the returned answers before it relies on any of them: one
 * that failed has aborted the transaction, which then begins again without
 * them (nothing has used them yet). On a client that does not pipeline
 * nothing is sent: each would cost its own round trip either way.
 */
export function sendAhead(client: PgQuery, statements: readonly PipelinedStatement[]): Promise<unknown>[] {
  const state = transactions.get(client);
  if (!state?.pipelines) return [];
  state.report.sent += statements.length;
  return statements.map((statement) => {
    const args: unknown[] =
      typeof statement === 'string' ? [statement] : statement.values?.length ? [statement.text, [...statement.values]] : [statement.text];
    const key = said(args);
    const answer = state.send(...args);
    // Heard here, so one never used never rejects unheard; whoever takes it hears its failure.
    answer.catch(() => {});
    if (key !== undefined) {
      const waiting = state.ahead.get(key);
      if (waiting) waiting.push(answer);
      else state.ahead.set(key, [answer]);
    }
    return answer;
  });
}

/**
 * Whether an answer sent ahead still waits for exactly `statement`: asking it
 * then sends nothing. False once a statement of the transaction's own has
 * dropped it, or where nothing was sent ahead.
 */
export function waitsAhead(client: PgQuery, statement: Readonly<{ text: string; values?: readonly unknown[] }>): boolean {
  const state = transactions.get(client);
  if (!state?.ahead.size) return false;
  const key = said(statement.values?.length ? [statement.text, [...statement.values]] : [statement.text]);
  return key !== undefined && (state.ahead.get(key)?.length ?? 0) > 0;
}

/**
 * Send a read now that a caller will answer later reads from itself (a row
 * read in full, answered by projection: scoped/keyRows.ts), rather than the
 * handle answering one identical query with it. `take` says it answered one,
 * so a read never used is reported left like any statement sent ahead.
 * Undefined where the client does not pipeline.
 */
export function holdAhead(
  client: PgQuery,
  statement: PipelinedStatement,
): { answer: Promise<PgResult<Record<string, unknown>>>; take(): void } | undefined {
  const state = transactions.get(client);
  if (!state?.pipelines) return undefined;
  state.report.sent += 1;
  const args: unknown[] =
    typeof statement === 'string' ? [statement] : statement.values?.length ? [statement.text, [...statement.values]] : [statement.text];
  const key = said(args) ?? String(args[0]);
  const answer = state.send(...args) as Promise<PgResult<Record<string, unknown>>>;
  answer.catch(() => {});
  const entry = { taken: false };
  state.held.set(key, entry);
  return {
    answer,
    take: () => {
      state.report.answered += 1;
      if (!entry.taken) state.report.taken += 1;
      entry.taken = true;
    },
  };
}

/**
 * The transaction's statement generation: a number that moves with every
 * statement sent through its handle that is not a read or a lock (a write, a
 * savepoint, a rollback, a notification) and with every one that fails.
 * Something read while it stood still was read in a transaction that has
 * changed nothing since. Undefined for anything that is not a handle.
 */
export const generationOf = (client: PgQuery): number | undefined => transactions.get(client)?.generation;

/** Whether statements sent ahead on this transaction leave in one flight: its client pipelines. */
export const sendsAhead = (client: PgQuery): boolean => transactions.get(client)?.pipelines === true;

function drop(state: TransactionState): void {
  for (const [key, waiting] of state.ahead) for (let i = 0; i < waiting.length; i++) state.report.left.push(key);
  state.ahead.clear();
}

/* A COMMIT sent behind writes that waited for it, unless one of them never
   reached the server. A write the server refuses aborts the transaction
   there, and the COMMIT is answered as a ROLLBACK; but one the driver refused
   as it was handed over (a value it cannot send, a fault in its query) was
   never sent at all, and a COMMIT behind it would commit everything else. Such
   a refusal is heard within the turn it was asked, so the COMMIT waits that
   turn, which costs no round trip: nothing has come back from the server yet. */
function commitBehind(client: PgQuery, before: Promise<unknown>[], args: unknown[]): Promise<unknown> {
  let refused: { reason: unknown } | undefined;
  for (const sent of before) sent.catch((reason: unknown) => void (refused ??= { reason }));
  return new Promise<void>((turn) => setImmediate(turn)).then(() => {
    if (!refused) return (client.query as (...values: unknown[]) => Promise<unknown>)(...args);
    const { reason } = refused;
    const fail = () => {
      throw new RolledBackAtCommit(reason);
    };
    return (client.query as (text: string) => Promise<unknown>)('ROLLBACK').then(fail, fail);
  });
}

/* What a statement sent behind writes that waited for it answers: the first of
   those writes that failed, if one did (the statement then failed only because
   the transaction was aborted, or, a COMMIT, was answered as a ROLLBACK),
   else its own answer. Every answer is heard. */
function behind(before: Promise<unknown>[], answer: Promise<unknown>, commit: boolean): Promise<unknown> {
  return Promise.allSettled([...before, answer]).then((settled) => {
    const failed = settled.slice(0, -1).find((outcome) => outcome.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failed) throw commit ? new RolledBackAtCommit(failed.reason) : failed.reason;
    const own = settled[settled.length - 1];
    if (own.status === 'rejected') throw own.reason;
    return own.value;
  });
}

/**
 * A COMMIT that the server answered as a ROLLBACK, because a write sent in
 * front of it in the same flight (beforeCommit) failed: nothing committed.
 * `cause` is that write's own failure.
 */
export class RolledBackAtCommit extends Error {
  constructor(readonly cause: unknown) {
    super('The transaction rolled back at its COMMIT: a write sent with it failed.');
    this.name = 'RolledBackAtCommit';
  }
}

/**
 * Queue writes whose answers nothing reads before COMMIT (a receipt, its
 * audit, a live change and its notification), to leave with the next
 * statement the transaction sends — its COMMIT, at best — in the same flight
 * instead of a round trip each. A write that fails then fails what it was
 * sent with: the statement behind it throws the write's own failure, and a
 * COMMIT throws RolledBackAtCommit (nothing committed). False where the
 * client does not pipeline or is not a transaction's handle: the caller sends
 * them in their turn.
 */
export function beforeCommit(client: PgQuery, statements: readonly PipelinedStatement[]): boolean {
  const state = transactions.get(client);
  if (!state?.pipelines) return false;
  for (const statement of statements)
    state.tail.push(
      typeof statement === 'string' ? [statement] : statement.values?.length ? [statement.text, [...statement.values]] : [statement.text],
    );
  return true;
}

/**
 * Run `ride` the moment the transaction sends a statement `match` accepts (a
 * write the caller is about to wait on), so what `ride` sends leaves right
 * behind it, in its flight, and reads what it wrote. Answers a withdraw: true
 * when `ride` had not run (it never will now). Undefined where the client
 * does not pipeline: the caller asks in its turn.
 */
export function behindWrite(client: PgQuery, match: (text: string) => boolean, ride: () => void): (() => boolean) | undefined {
  const state = transactions.get(client);
  if (!state?.pipelines) return undefined;
  const rider = { match, ride };
  state.riders.push(rider);
  return () => {
    const at = state.riders.indexOf(rider);
    if (at < 0) return false;
    state.riders.splice(at, 1);
    return true;
  };
}

/** Drop every answer sent ahead and not yet taken, and count a beginning again without them (one failed). */
export function redoWithoutAhead(client: PgQuery): void {
  const state = transactions.get(client);
  if (!state) return;
  state.ahead.clear();
  state.held.clear();
  state.generation += 1;
  state.report.redone += 1;
}

/** What became of this transaction's statements sent ahead, those still waiting counted as left; undefined for anything else. */
export function aheadReport(client: PgQuery): AheadReport | undefined {
  const state = transactions.get(client);
  if (!state) return undefined;
  drop(state);
  for (const [key, entry] of state.held) if (!entry.taken) state.report.left.push(key);
  state.held.clear();
  return { ...state.report, left: [...state.report.left], asked: [...state.report.asked] };
}

/** The same transaction seen through `query`, which must send every
 * statement on through `client` (a caller's checkpoints around each one):
 * so the rollbacks are still counted by the handle, and what the transaction
 * has established is still found. On a bare client, a bare view. */
export function transactionView(client: PgQuery, query: PgQuery['query']): PgQuery {
  const view: PgQuery = Object.freeze({ query });
  const state = transactions.get(client);
  if (state) transactions.set(view, state);
  return view;
}

/** The transaction a handle or view belongs to, as an object only they
 * share; undefined for a bare client, so nothing is kept on one. */
export function transactionOf(client: PgQuery): object | undefined {
  return transactions.get(client);
}

/* ---------- runtime stores, attested once per adapter ---------- */

/* What each adapter has attested of its runtime stores (the journal, the tenant
   store, the event store...), by a key the store chooses. A store is
   attested in full when an adapter first uses it, which is when the process
   opens it, and not again: a GRANT or DDL on a runtime table made later is
   seen at the next start, or when a statement fails the way a moved catalog
   fails one (suspectsStores), which forgets them all and has the next use
   attest in full again. The database role is the boundary (reservedSql.ts),
   as it always was for what happens between two checks. */
const attestations = new WeakMap<object, Set<string>>();

/** A statement failed for a table, column or privilege that is not what it was, or a reference that broke: a runtime store may have moved. */
export function suspectsStores(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return movedCatalog(code) || code === '23503';
}
/* A table, column or privilege that is not what it was: the catalog itself moved. A reference that broke (23503)
   is that too only where a store grew a key it should not have, which the version moves with; it is far more often
   an App's own row naming one that is not there, and forgets one adapter's attestations, never the process's. */
const movedCatalog = (code: unknown): boolean => code === '42P01' || code === '42703' || code === '42501';
export const attestedOn = (origin: object, key: string): boolean => attestations.get(origin)?.has(key) === true;
export function keepAttestedOn(origin: object, key: string): void {
  let kept = attestations.get(origin);
  if (!kept) attestations.set(origin, (kept = new Set()));
  kept.add(key);
}
export const forgetAttestations = (origin: object, client?: PgQuery, error?: unknown): void => {
  attestations.delete(origin);
  /* What `client`'s transaction stood on, shared under the version it read, is dropped with it when the catalog
     moved under it. Only that: a transaction that read no version (one whose epoch probe failed on a database
     without the store) stood on none. */
  const read = client && catalogVersions.get(client);
  if (read && movedCatalog((error as { code?: unknown } | null)?.code)) sharedAttestations.forget(read.database);
};

/* A tenant App's start opened a dozen adapters and read snapshots on one database — startup's checks, a trial
   enrollment and the host's, each read source — and each attested the same stores in full: on Ignition 42 layout
   descriptions and 32 ownership checks, one round trip each. What a full attestation reads of the catalog — the
   layout, the owners, grants and objects of the runtime schema, the roles — is what the catalog digest and the
   schema epoch move with (postgresCatalogDigest.ts, postgresSchemaEpoch.ts), so one that passed stands for any
   transaction on the same database that read the same exact version before attesting: kept here by the database
   and that version, and asked of nothing else. The store's meta row — which App, source and store it is bound to —
   is data the digest does not see, and the next adapter to open must see it changed: an adapter that finds the
   catalog attested reads it again (`rebound`), one statement, and a row that no longer binds attests in full, which
   refuses. A store that names no such read is not shared. A transaction that read no exact version — a time-filed
   one, or none — attests as before.

   Filed only where the attestation saw the version it is filed under. A snapshot's every statement sees the catalog
   its first one did. A write's (READ COMMITTED) each sees what had committed when it ran, so DDL committing between
   its version read and its attestation would be filed under a version it never saw, for a snapshot begun before the
   DDL to find; it reads the version again after attesting (`reread`) and files only if it has not moved. */
const sharedAttestations = new EpochCache<Set<string>>(32);
/* DDL, or code that may run it, where a statement may begin: the start of the message, after a `;`, or after a
   comment, block (nested or not) or line, so a comment before it hides nothing. A word that only looks like one
   there (a column at the start of a line) costs a transaction its sharing, never its correctness. */
const CATALOG_WRITE =
  /(?:^|;|\*\/|\n)\s*(?:(?:CREATE|ALTER|DROP|GRANT|REVOKE|REASSIGN|SECURITY\s+LABEL|IMPORT\s+FOREIGN|CALL)\b|DO\s*(?:\$|'|LANGUAGE\b))/i;
/** Whether a message may change the catalog: DDL, or code that may run it. */
export const changesCatalog = (text: string): boolean => CATALOG_WRITE.test(text);
const catalogVersions = new WeakMap<PgQuery, Readonly<{ database: string; version: string; reread?: () => Promise<string | undefined> }>>();
/* How a transaction on an adapter's handle that read no exact version — the epoch store absent, so a write's
   catalog answers are time-filed — reads one when it first has a store to attest: the digest, one statement where
   each store's attestation is two. */
const catalogReaders = new WeakMap<object, Readonly<{ database: string; read: (client: PgQuery) => Promise<string> }>>();

/** Say the exact catalog version `client`'s transaction read, before anything it attests: its digest or its epoch.
 * `reread` reads it again, for a transaction whose statements each see the latest commit (READ COMMITTED); a
 * snapshot's needs none. Undefined unsays it, for a transaction begun again on the same client that read none. */
export function noteCatalogVersion(
  client: PgQuery,
  database: string,
  version: string | undefined,
  reread?: () => Promise<string | undefined>,
): void {
  if (version === undefined) catalogVersions.delete(client);
  else catalogVersions.set(client, Object.freeze({ database, version, ...(reread ? { reread } : {}) }));
}

/** How a transaction on `origin`'s handles reads an exact catalog version of `database` when it has read none. */
export function readsCatalogVersion(origin: object, database: string, read: (client: PgQuery) => Promise<string>): void {
  catalogReaders.set(origin, Object.freeze({ database, read }));
}

/** The adapter a handle's transaction runs on, as transactionHandle was told; undefined for anything else. */
const transactionOrigin = (client: PgQuery): object | undefined => transactions.get(client)?.origin;

/**
 * Attest a runtime store in full (`full`, which refuses) unless the adapter
 * this transaction runs on attested it under `key` already, or any transaction
 * on the same database did under the exact catalog version this one read
 * (sharedAttestations) — read now, if it read none and its adapter says how —
 * and its meta row still binds it (`rebound`, without which nothing is shared).
 * Otherwise, off a handle or on one made without an adapter, always in full.
 */
export async function attestOnce(client: PgQuery, key: string, full: () => Promise<void>, rebound?: () => Promise<boolean>): Promise<void> {
  const origin = transactionOrigin(client);
  if (origin && attestedOn(origin, key)) return;
  if (!rebound) {
    await full();
    if (origin) keepAttestedOn(origin, key);
    return;
  }
  let read = catalogVersions.get(client);
  const reader = origin && !read ? catalogReaders.get(origin) : undefined;
  if (reader) {
    // An adapter's handle is a write's: READ COMMITTED.
    noteCatalogVersion(client, reader.database, await reader.read(client), () => reader.read(client));
    read = catalogVersions.get(client);
  }
  if (!read || !sharedAttestations.get(read.version, read.database)?.has(key) || !(await rebound())) {
    await full();
    if (read && (!read.reread || (await read.reread()) === read.version)) {
      const kept = sharedAttestations.get(read.version, read.database) ?? sharedAttestations.set(read.version, read.database, new Set());
      kept.add(key);
    }
  }
  if (origin) keepAttestedOn(origin, key);
}

/** How many rollbacks have passed through this transaction's handle; undefined
 * for anything that is not one. */
export function transactionRollbacks(client: PgQuery): number | undefined {
  return transactions.get(client)?.count;
}

/** A statement for pipelined(): bare text goes by the simple protocol, which may carry several. */
export type PipelinedStatement = string | Readonly<{ text: string; values?: readonly unknown[] }>;

/**
 * Statements asked together and answered in order, on a transaction's handle
 * or view: one round trip where its client pipelines (a writer's,
 * postgresPool.ts), one each where it does not, with the same answers.
 *
 * Only inside the transaction — the handle's BEGIN sent first, on this handle
 * or as the first statement here. There a statement that fails aborts the
 * transaction, and every one sent behind it fails without effect ("current
 * transaction is aborted"), so nothing runs that depended on one that did not;
 * outside a transaction block each would commit on its own, which is why a
 * bare client is refused. Every answer is awaited before this returns or
 * throws, so the connection is never left mid-pipeline, and the first failure
 * in order is the one thrown: the ones behind it only say it happened.
 *
 * `check` reads each answer as it arrives, in order, before the next one is
 * read: a check that throws is the failure (the caller rolls the transaction
 * back), and no later answer reaches a check. Behind a transaction-mode pooler
 * (PgBouncer) a pipeline stays on its one server connection: the server says
 * it is idle only after the COMMIT or ROLLBACK that ends the transaction, which
 * this never sends ahead of a statement that could still fail.
 */
export async function pipelined(
  client: PgQuery,
  statements: readonly PipelinedStatement[],
  check?: (result: PgResult<Record<string, unknown>> | PgResult<Record<string, unknown>>[], index: number) => void,
): Promise<Array<PgResult<Record<string, unknown>> | PgResult<Record<string, unknown>>[]>> {
  const state = transactions.get(client);
  if (!state) throw new TypeError('pipelined() runs on a transaction handle, inside its transaction.');
  const ask = (statement: PipelinedStatement) =>
    (typeof statement === 'string'
      ? client.query(statement)
      : statement.values?.length
        ? client.query(statement.text, [...statement.values])
        : client.query(statement.text)) as Promise<PgResult<Record<string, unknown>> | PgResult<Record<string, unknown>>[]>;
  const answers: Array<PgResult<Record<string, unknown>> | PgResult<Record<string, unknown>>[]> = [];
  if (!state.pipelines) {
    for (const [index, statement] of statements.entries()) {
      const answer = await ask(statement);
      check?.(answer, index);
      answers.push(answer);
    }
    return answers;
  }
  const sent = statements.map(ask);
  // Each is handled here, so one behind a failure never rejects unheard.
  const settled = await Promise.allSettled(sent);
  let failure: { error: unknown } | undefined;
  for (const [index, outcome] of settled.entries()) {
    if (failure) continue;
    if (outcome.status === 'rejected') failure = { error: outcome.reason };
    else
      try {
        check?.(outcome.value, index);
        answers.push(outcome.value);
      } catch (error) {
        failure = { error };
      }
  }
  if (failure) throw failure.error;
  return answers;
}
