/**
 * The read snapshot a trusted owner is lent (postgres.ts `readSnapshot`): one `REPEATABLE READ, READ ONLY` transaction
 * on a leased reader, with its prologue sent in the BEGIN's own message, an `ahead` form whose first statements leave
 * behind the BEGIN, a `whole` form that is a single round trip, and the `finish` that commits it and reads a fence in a
 * fresh snapshot. Apart from the adapter because it needs nothing of it but the reader pool and its introspection.
 */
import { Refusal, TransactionOutcomeUnknown, type QueryResult, type SqlFragment } from './adapter.js';
import { pipelinesAs, type PgConnectionManager, type PgQuery, type PgResult } from './postgresPool.js';
import { toJsonSafe, withBytes } from './postgresValues.js';
import type { DatabaseSchema } from '../shared/schema.js';

/** What a trusted read-snapshot owner is lent: the leased reader inside its
 * transaction, the adapter's own introspection on it, and scoped-read
 * execution on it with the adapter's value mapping. Never retained. */
export interface PostgresReadSnapshot {
  readonly client: PgQuery;
  /** The results of the owner's prologue, in order, when it passed one. */
  readonly prologue?: readonly PgResult<Record<string, unknown>>[];
  /**
   * For an owner that asked `ahead`: the same results, still on their way.
   * The owner is handed the snapshot as soon as its BEGIN is sent, so what it
   * asks next leaves right behind it on a reader that pipelines; it must
   * await this, and stand on what it says, before it relies on anything it
   * read. A BEGIN that failed rejects it, and fails every statement behind.
   */
  readonly opened?: Promise<readonly PgResult<Record<string, unknown>>[]>;
  /** Present only for observed checkouts; native local lifetime, not a grant. */
  assertCurrent?(): void;
  /**
   * Commit this snapshot and read `next` — parameter-free statements — in a
   * fresh snapshot of its own, committed too, all in the one message: the
   * COMMIT and a question that must see what committed after this snapshot
   * began (a release fence) in one round trip where they were three. Its
   * answers are `next`'s, in order. Nothing is asked on the snapshot once it
   * is called. Absent from a whole snapshot and an observed checkout.
   */
  finish?(next: string): Promise<readonly PgResult<Record<string, unknown>>[]>;
  describe(): Promise<DatabaseSchema>;
  /** A file's read keeps its bytes (`hint.binary`); every other read gets the `<n bytes>` label. */
  execute(statement: SqlFragment, hint?: { binary?: true }): Promise<QueryResult>;
}

const BEGIN_SNAPSHOT = 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY';

/**
 * Run `run` in a snapshot on `connections`' reader. `describe` is the adapter's own introspection on the leased
 * client; `onCheckout` says it is a pinned owner's, whose introspection is the class's and not an instance's.
 */
export async function readSnapshotOn<T>(
  connections: PgConnectionManager,
  describe: (db: PgQuery, checkout: boolean) => Promise<DatabaseSchema>,
  run: (snapshot: PostgresReadSnapshot) => Promise<T>,
  observeCheckout: boolean,
  prologue: string | undefined,
  ahead: boolean,
  whole: boolean,
): Promise<T> {
  if (
    typeof run !== 'function' ||
    (prologue !== undefined && (typeof prologue !== 'string' || !prologue.trim())) ||
    (ahead && (observeCheckout || prologue === undefined)) ||
    (whole && (observeCheckout || ahead || prologue === undefined))
  ) {
    throw new Refusal('This read snapshot is unavailable.');
  }
  /* The answer is final once `run` returns: a read-only transaction's
       COMMIT changes nothing it showed. So the caller has it then, and the
       COMMIT finishes on the lease, which goes back to the pool (or is
       discarded, should the COMMIT fail) only after it. Against a server a
       round trip away that is one round trip off every snapshot. Not for an
       observed checkout: its owner hands its response off inside the
       snapshot (postgresReadCatalog.ts), so a COMMIT it never heard
       acknowledged is an uncertain outcome it must be told of. */
  let deliver!: (value: T) => void;
  const answered = new Promise<T>((resolve) => {
    deliver = resolve;
  });
  const work = async (client: PgQuery, checkout?: () => void) => {
    let out: T;
    let active = true;
    const current = () => {
      if (!active || !checkout) throw new Refusal('The read snapshot is unavailable.');
      checkout();
    };
    /* The owner's prologue rides with BEGIN in one simple-protocol
         message: statements without parameters (its LOCK, its first query),
         so the snapshot is still taken where the owner put its first query,
         and the owner is handed their results. A failure here, as of BEGIN
         alone, discards the client, and the server rolls back with it. */
    /* Asked ahead, the owner is handed the snapshot with its BEGIN in
         flight rather than answered, so its own first statements leave in
         the same flight on a reader that pipelines: one round trip where
         BEGIN and each of them were one each. The owner waits on the BEGIN's
         answer before it trusts anything; a BEGIN that failed fails what was
         sent behind it, and the owner hears the BEGIN's failure first. */
    const begun = (
      client.query(prologue === undefined ? BEGIN_SNAPSHOT : `${BEGIN_SNAPSHOT}; ${prologue}${whole ? '; COMMIT' : ''}`) as Promise<unknown>
    ).then((opened) =>
      Object.freeze(
        prologue === undefined
          ? []
          : ((Array.isArray(opened) ? opened : [opened]).slice(1, whole ? -1 : undefined) as PgResult<Record<string, unknown>>[]),
      ),
    );
    let results: readonly PgResult<Record<string, unknown>>[] | undefined;
    if (ahead) void begun.catch(() => {});
    else results = await begun;
    /* Committed already (`whole`, `finish`): there is no snapshot left to ask of, and no COMMIT to send. */
    let ended = whole;
    /* The client otherwise, until the snapshot has ended: a statement asked after `finish` would run outside any
         transaction, on a connection the snapshot no longer holds. It pipelines where the client does (postgresPool.ts). */
    const asked: PgQuery = Object.freeze({
      query: ((...args: unknown[]) =>
        ended
          ? Promise.reject(new Refusal('The read snapshot is unavailable.'))
          : (client.query as (...values: unknown[]) => Promise<unknown>)(...args)) as unknown as PgQuery['query'],
    });
    pipelinesAs(asked, client);
    const finish = async (next: string): Promise<readonly PgResult<Record<string, unknown>>[]> => {
      if (ended || typeof next !== 'string' || !next.trim()) throw new Refusal('The read snapshot is unavailable.');
      ended = true;
      if (ahead) await begun;
      const closed = (await client.query(`COMMIT; ${BEGIN_SNAPSHOT}; ${next}; COMMIT`)) as unknown;
      return Object.freeze((Array.isArray(closed) ? closed : [closed]).slice(2, -1) as PgResult<Record<string, unknown>>[]);
    };
    try {
      out = await run(
        Object.freeze({
          client: asked,
          ...(results === undefined ? {} : prologue === undefined ? {} : { prologue: results }),
          ...(ahead ? { opened: begun } : {}),
          ...(checkout ? { assertCurrent: current } : { ...(whole ? {} : { finish }) }),
          describe: () => describe(asked, checkout !== undefined),
          execute: async (statement: SqlFragment, hint?: { binary?: true }): Promise<QueryResult> => {
            if (ended) throw new Refusal('The read snapshot is unavailable.');
            const started = performance.now();
            const result = await asked.query(statement.text, statement.params);
            return {
              columns: result.fields.map((field) => field.name),
              rows: result.rows.map(hint?.binary ? withBytes : toJsonSafe),
              ms: Math.round(performance.now() - started),
              sql: { text: statement.text, params: statement.params },
            };
          },
        }),
      );
      // Never an answer from a snapshot whose BEGIN failed, whether or not its owner waited to hear.
      if (ahead) await begun;
      if (checkout) current();
    } catch (error) {
      active = false;
      /* A BEGIN that failed is the failure, as it is when awaited first: no
           transaction to roll back, and the client is discarded. */
      if (ahead) {
        const failed = await begun.then(
          () => undefined,
          (reason: unknown) => ({ reason }),
        );
        if (failed) throw failed.reason;
      }
      try {
        await client.query('ROLLBACK');
      } catch (rollback) {
        throw new TransactionOutcomeUnknown(rollback);
      }
      throw error;
    }
    active = false;
    if (!observeCheckout) deliver(out);
    if (!ended) await client.query('COMMIT');
    return out;
  };
  const leased = observeCheckout ? connections.withObservedReadClient(work) : connections.withReadClient(work, false, true);
  // Whichever settles first: the answer, or a failure before there was one.
  return Promise.race([answered, leased]);
}
