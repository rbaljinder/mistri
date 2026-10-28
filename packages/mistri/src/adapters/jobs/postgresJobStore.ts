/**
 * The durable job store on PostgreSQL: the same namespace, rows, history and
 * rules as the SQLite store (shared through jobStoreRules.ts), behind the
 * same contract, for several hosts sharing one database.
 *
 * What is different, and why:
 *
 * - Claims select due rows `FOR UPDATE SKIP LOCKED` under a transaction-scoped
 *   advisory lock on the namespace. The lock makes the in-flight count and
 *   the claim one atomic step, so `maxInFlight` holds across hosts; SKIP
 *   LOCKED keeps a claim from waiting on a row another transaction is
 *   settling or cancelling. Settlement locks only its own row.
 * - "Now" is the database's `clock_timestamp()`, read inside each
 *   transaction, not the caller's. Hosts whose clocks disagree by a few
 *   milliseconds would otherwise trip each other's persisted clock floor and
 *   halt. The floor stays, as a guard against the database clock itself
 *   running backwards; it is read before the clock, so a floor another
 *   transaction has just committed is never ahead of this reading.
 * - Insertion order is a sequence, so an enqueue does not serialise on the
 *   namespace; a duplicate key racing another enqueue waits on the unique
 *   index and then replays the winner.
 * - Every transaction leases one writer client and returns it before the
 *   call resolves: never across a handler, a transport call or a tick.
 * - Attestation compares a catalog description with the one pinned below,
 *   exactly as the command journal does. The meta row is read in every
 *   transaction; the description stands for the layout trust window and is
 *   taken again after any failure (postgresRelations.ts LayoutTrust).
 */
import { jobEnqueued } from '../events/commandEventSignal.js';
import { NOTIFY_COMMAND_EVENTS } from '../events/postgresCommandEventWake.js';
import { createHash, randomUUID } from 'node:crypto';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import { layoutTrust, type LayoutTrust } from '../commands/postgresRelations.js';
import type { PgQuery, PgWriteClientSource } from '@mistriwork/engine/adapters/postgresPool.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { JobStore } from './jobStoreContract.js';
import { JOB_PREFIX, JOB_TABLES as t } from './jobStoreSchema.js';
import {
  assertJobRedrivable,
  captureJobEnqueue,
  captureJobId,
  captureJobInspectFilter,
  captureJobOperator,
  captureJobOutcome,
  captureJobPrune,
  captureJobResult,
  inspectJobRow,
  jobAttemptInspection,
  jobClaimOf,
  JOB_HELD as held,
  JOB_MAX_CLOCK,
  jobRelease,
  oneAtATimeSql,
  verifyJobRow,
  withoutOverlap,
  type JobRow,
} from './jobStoreRules.js';
import {
  captureJobPolicy,
  jobFail,
  jobInteger,
  jobStanding,
  JobRefusal,
  jobRefuse,
  JobStoreUnavailable,
  JOB_ATTEMPT_OUTCOMES,
  JOB_CODES,
  JOB_HISTORY_LIMIT,
  JOB_REDRIVE_LIMIT,
  JOB_STATES,
  type JobAttemptOutcome,
  type JobInspection,
  type JobOutcomeCode,
  type JobPolicy,
  type JobPolicyInput,
  type JobState,
} from './jobStoreTypes.js';

const q = (name: string) => runtimeTable('postgres', name);
const SCHEMA = runtimeSchema('postgres');
const SEQUENCE = `${JOB_PREFIX}seq`;
const list = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');

/* Postgres text cannot hold NUL, so the SQLite `instr(…, char(0))` half of
   each bound is the engine's own rule here. A CHECK that evaluates to NULL
   passes, so every conditional column is tested with IS [NOT] NULL first. */
/* PostgreSQL: a policy row per namespace, and every job row
   names its namespace, so several Apps sharing one database each keep their
   own store (an App's namespace defaults to its id, jobLoader.ts). Every
   read, claim and settlement is of this namespace's rows only. SQLite keeps
   one namespace per file. */
const POSTGRES_JOB_STORE_VERSION = 1;
const VERSION = POSTGRES_JOB_STORE_VERSION;
const POLICY_DDL = `CREATE TABLE ${q(t.policy)} (
  namespace text COLLATE "C" PRIMARY KEY CHECK (octet_length(namespace) BETWEEN 1 AND 128),
  version integer NOT NULL CHECK (version = ${VERSION}),
  policy_json text COLLATE "C" NOT NULL CHECK (octet_length(policy_json) BETWEEN 1 AND 4096),
  last_clock bigint NOT NULL CHECK (last_clock >= 0)
)`;
const DUE_DDL = `CREATE INDEX "${runtimeName('postgres', `${JOB_PREFIX}due`)}" ON ${q(t.job)} (namespace, state, run_at, seq)`;
const JOB_POSTGRES_DEFINITIONS: readonly string[] = [
  POLICY_DDL,
  `CREATE SEQUENCE ${q(SEQUENCE)} AS bigint MINVALUE 0 START WITH 0 NO CYCLE`,
  `CREATE TABLE ${q(t.job)} (
  id text COLLATE "C" PRIMARY KEY CHECK (octet_length(id) = 36),
  seq bigint NOT NULL UNIQUE CHECK (seq >= 0),
  job text COLLATE "C" NOT NULL CHECK (octet_length(job) BETWEEN 1 AND 128),
  version bigint NOT NULL CHECK (version >= 1),
  idempotency_key text COLLATE "C" NOT NULL CHECK (octet_length(idempotency_key) BETWEEN 1 AND 128),
  fingerprint text COLLATE "C" NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  input_json text COLLATE "C" NOT NULL CHECK (octet_length(input_json) BETWEEN 1 AND 65536),
  provenance_json text COLLATE "C" NOT NULL CHECK (octet_length(provenance_json) BETWEEN 1 AND 1024),
  state text COLLATE "C" NOT NULL CHECK (state IN (${list(JOB_STATES)})),
  attempts integer NOT NULL CHECK (attempts BETWEEN 0 AND ${JOB_HISTORY_LIMIT}),
  max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 32),
  redrives integer NOT NULL CHECK (redrives BETWEEN 0 AND ${JOB_REDRIVE_LIMIT}),
  attempt_limit integer NOT NULL CHECK (attempt_limit BETWEEN 1 AND ${JOB_HISTORY_LIMIT}),
  run_at bigint NOT NULL CHECK (run_at >= 0),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= 0),
  fence text COLLATE "C",
  lease_until bigint,
  cancel_requested integer NOT NULL CHECK (cancel_requested IN (0, 1)),
  last_code text COLLATE "C" CHECK (last_code IN (${list(JOB_CODES)})),
  result_json text COLLATE "C" CHECK (result_json IS NULL OR octet_length(result_json) BETWEEN 1 AND 65536),
  namespace text COLLATE "C" NOT NULL REFERENCES ${q(t.policy)} (namespace) ON DELETE RESTRICT,
  UNIQUE (namespace, job, idempotency_key),
  CHECK (attempts <= attempt_limit),
  CHECK ((state IN ('leased', 'unknown') AND fence IS NOT NULL AND octet_length(fence) = 36
      AND lease_until IS NOT NULL AND lease_until >= 0 AND attempts > 0)
    OR (state NOT IN ('leased', 'unknown') AND fence IS NULL AND lease_until IS NULL)),
  CHECK (state <> 'scheduled' OR (attempts = 0 AND last_code IS NULL)),
  CHECK (result_json IS NULL OR state = 'succeeded')
)`,
  `CREATE TABLE ${q(t.attempt)} (
  job_id text COLLATE "C" NOT NULL REFERENCES ${q(t.job)} (id) ON DELETE RESTRICT,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND ${JOB_HISTORY_LIMIT}),
  fence text COLLATE "C" UNIQUE CHECK (fence IS NULL OR octet_length(fence) = 36),
  started_at bigint NOT NULL CHECK (started_at >= 0),
  deadline bigint,
  outcome text COLLATE "C" NOT NULL CHECK (outcome IN (${list(JOB_ATTEMPT_OUTCOMES)})),
  code text COLLATE "C" CHECK (code IN (${list(JOB_CODES)})),
  finished_at bigint,
  operator text COLLATE "C" CHECK (operator IS NULL OR octet_length(operator) BETWEEN 1 AND 128),
  PRIMARY KEY (job_id, attempt),
  CHECK ((outcome = 'redriven' AND fence IS NULL AND deadline IS NULL AND code IS NOT NULL AND code = 'redriven'
      AND finished_at IS NOT NULL AND finished_at = started_at AND operator IS NOT NULL)
    OR (outcome <> 'redriven' AND fence IS NOT NULL AND deadline IS NOT NULL AND deadline > started_at AND operator IS NULL
      AND ((outcome = 'leased' AND code IS NULL AND finished_at IS NULL)
        OR (outcome <> 'leased' AND code IS NOT NULL AND code <> 'redriven' AND finished_at IS NOT NULL AND finished_at >= started_at))))
)`,
  DUE_DDL,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const relation = (
  name: string,
  columns: PostgresRelationDescription['columns'],
  constraints: string[],
  indexes: string[],
): PostgresRelationDescription => ({
  schema: SCHEMA,
  name,
  kind: 'r',
  rls: false,
  columns,
  constraints: [...constraints].sort(byCodeUnit),
  indexes: [...indexes].sort(byCodeUnit),
  triggers: 0,
  rules: 0,
  policies: 0,
});
const column = (name: string, type: string, notnull: boolean, collation: string | null, fallback: string | null = null) => ({
  name,
  type,
  notnull,
  collation,
  default: fallback,
});
/* Read back from a PostgreSQL 18 catalog after the DDL above ran. Pinned
   rather than derived at runtime, so attestation is of this layout and not
   of whatever is there. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  relation(
    'job_attempt',
    [
      column('job_id', 'text', true, 'C'),
      column('attempt', 'integer', true, null),
      column('fence', 'text', false, 'C'),
      column('started_at', 'bigint', true, null),
      column('deadline', 'bigint', false, null),
      column('outcome', 'text', true, 'C'),
      column('code', 'text', false, 'C'),
      column('finished_at', 'bigint', false, null),
      column('operator', 'text', false, 'C'),
    ],
    [
      "CHECK ((((outcome = 'redriven'::text) AND (fence IS NULL) AND (deadline IS NULL) AND (code IS NOT NULL) AND (code = 'redriven'::text) AND (finished_at IS NOT NULL) AND (finished_at = started_at) AND (operator IS NOT NULL)) OR ((outcome <> 'redriven'::text) AND (fence IS NOT NULL) AND (deadline IS NOT NULL) AND (deadline > started_at) AND (operator IS NULL) AND (((outcome = 'leased'::text) AND (code IS NULL) AND (finished_at IS NULL)) OR ((outcome <> 'leased'::text) AND (code IS NOT NULL) AND (code <> 'redriven'::text) AND (finished_at IS NOT NULL) AND (finished_at >= started_at))))))",
      'CHECK (((attempt >= 1) AND (attempt <= 131)))',
      'CHECK (((fence IS NULL) OR (octet_length(fence) = 36)))',
      'CHECK (((operator IS NULL) OR ((octet_length(operator) >= 1) AND (octet_length(operator) <= 128))))',
      "CHECK ((code = ANY (ARRAY['succeeded'::text, 'rejected'::text, 'not_authorized'::text, 'timeout'::text, 'shutdown'::text, 'lease_expired'::text, 'cancelled'::text, 'input_invalid'::text, 'handler_error'::text, 'redriven'::text])))",
      "CHECK ((outcome = ANY (ARRAY['leased'::text, 'succeeded'::text, 'failed'::text, 'retry'::text, 'unknown'::text, 'cancelled'::text, 'redriven'::text])))",
      'CHECK ((started_at >= 0))',
      'FOREIGN KEY (job_id) REFERENCES job_job(id) ON DELETE RESTRICT',
      'PRIMARY KEY (job_id, attempt)',
      'UNIQUE (fence)',
    ],
    [
      `CREATE UNIQUE INDEX job_attempt_fence_key ON ${SCHEMA}.job_attempt USING btree (fence)`,
      `CREATE UNIQUE INDEX job_attempt_pkey ON ${SCHEMA}.job_attempt USING btree (job_id, attempt)`,
    ],
  ),
  relation(
    'job_job',
    [
      column('id', 'text', true, 'C'),
      column('seq', 'bigint', true, null),
      column('job', 'text', true, 'C'),
      column('version', 'bigint', true, null),
      column('idempotency_key', 'text', true, 'C'),
      column('fingerprint', 'text', true, 'C'),
      column('input_json', 'text', true, 'C'),
      column('provenance_json', 'text', true, 'C'),
      column('state', 'text', true, 'C'),
      column('attempts', 'integer', true, null),
      column('max_attempts', 'integer', true, null),
      column('redrives', 'integer', true, null),
      column('attempt_limit', 'integer', true, null),
      column('run_at', 'bigint', true, null),
      column('created_at', 'bigint', true, null),
      column('updated_at', 'bigint', true, null),
      column('fence', 'text', false, 'C'),
      column('lease_until', 'bigint', false, null),
      column('cancel_requested', 'integer', true, null),
      column('last_code', 'text', false, 'C'),
      column('result_json', 'text', false, 'C'),
      column('namespace', 'text', true, 'C'),
    ],
    [
      "CHECK ((((state = ANY (ARRAY['leased'::text, 'unknown'::text])) AND (fence IS NOT NULL) AND (octet_length(fence) = 36) AND (lease_until IS NOT NULL) AND (lease_until >= 0) AND (attempts > 0)) OR ((state <> ALL (ARRAY['leased'::text, 'unknown'::text])) AND (fence IS NULL) AND (lease_until IS NULL))))",
      'CHECK (((attempt_limit >= 1) AND (attempt_limit <= 131)))',
      'CHECK (((attempts >= 0) AND (attempts <= 131)))',
      'CHECK (((max_attempts >= 1) AND (max_attempts <= 32)))',
      'CHECK (((octet_length(idempotency_key) >= 1) AND (octet_length(idempotency_key) <= 128)))',
      'CHECK (((octet_length(input_json) >= 1) AND (octet_length(input_json) <= 65536)))',
      'CHECK (((octet_length(job) >= 1) AND (octet_length(job) <= 128)))',
      'CHECK (((octet_length(provenance_json) >= 1) AND (octet_length(provenance_json) <= 1024)))',
      'CHECK (((redrives >= 0) AND (redrives <= 3)))',
      'CHECK (((result_json IS NULL) OR ((octet_length(result_json) >= 1) AND (octet_length(result_json) <= 65536))))',
      "CHECK (((result_json IS NULL) OR (state = 'succeeded'::text)))",
      "CHECK (((state <> 'scheduled'::text) OR ((attempts = 0) AND (last_code IS NULL))))",
      'CHECK ((attempts <= attempt_limit))',
      'CHECK ((cancel_requested = ANY (ARRAY[0, 1])))',
      'CHECK ((created_at >= 0))',
      "CHECK ((fingerprint ~ '^[0-9a-f]{64}$'::text))",
      "CHECK ((last_code = ANY (ARRAY['succeeded'::text, 'rejected'::text, 'not_authorized'::text, 'timeout'::text, 'shutdown'::text, 'lease_expired'::text, 'cancelled'::text, 'input_invalid'::text, 'handler_error'::text, 'redriven'::text])))",
      'CHECK ((octet_length(id) = 36))',
      'CHECK ((run_at >= 0))',
      'CHECK ((seq >= 0))',
      "CHECK ((state = ANY (ARRAY['scheduled'::text, 'leased'::text, 'retry'::text, 'succeeded'::text, 'failed'::text, 'cancelled'::text, 'unknown'::text])))",
      'CHECK ((updated_at >= 0))',
      'CHECK ((version >= 1))',
      'FOREIGN KEY (namespace) REFERENCES job_policy(namespace) ON DELETE RESTRICT',
      'PRIMARY KEY (id)',
      'UNIQUE (namespace, job, idempotency_key)',
      'UNIQUE (seq)',
    ],
    [
      `CREATE INDEX job_due ON ${SCHEMA}.job_job USING btree (namespace, state, run_at, seq)`,
      `CREATE UNIQUE INDEX job_job_namespace_job_idempotency_key_key ON ${SCHEMA}.job_job USING btree (namespace, job, idempotency_key)`,
      `CREATE UNIQUE INDEX job_job_pkey ON ${SCHEMA}.job_job USING btree (id)`,
      `CREATE UNIQUE INDEX job_job_seq_key ON ${SCHEMA}.job_job USING btree (seq)`,
    ],
  ),
  relation(
    'job_policy',
    [
      column('namespace', 'text', true, 'C'),
      column('version', 'integer', true, null),
      column('policy_json', 'text', true, 'C'),
      column('last_clock', 'bigint', true, null),
    ],
    [
      'CHECK (((octet_length(namespace) >= 1) AND (octet_length(namespace) <= 128)))',
      'CHECK (((octet_length(policy_json) >= 1) AND (octet_length(policy_json) <= 4096)))',
      'CHECK ((last_clock >= 0))',
      'CHECK ((version = 1))',
      'PRIMARY KEY (namespace)',
    ],
    [`CREATE UNIQUE INDEX job_policy_pkey ON ${SCHEMA}.job_policy USING btree (namespace)`],
  ),
  {
    schema: SCHEMA,
    name: 'job_seq',
    kind: 'S',
    rls: false,
    columns: [
      { name: 'last_value', type: 'bigint', notnull: true, collation: null, default: null },
      { name: 'log_cnt', type: 'bigint', notnull: true, collation: null, default: null },
      { name: 'is_called', type: 'boolean', notnull: true, collation: null, default: null },
    ],
    constraints: [],
    indexes: [],
    triggers: 0,
    rules: 0,
    policies: 0,
  },
];

const BIGINTS = new Set([
  'seq',
  'version',
  'run_at',
  'created_at',
  'updated_at',
  'lease_until',
  'started_at',
  'deadline',
  'finished_at',
  'last_clock',
  'now',
]);
/** pg returns bigint as text. A value past 2^53 is damage here, never a number to round. */
function normal(row: Record<string, unknown>): JobRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    out[key] =
      BIGINTS.has(key) && typeof value === 'string'
        ? /^(0|[1-9][0-9]{0,15})$/.test(value) && Number.isSafeInteger(Number(value))
          ? Number(value)
          : Number.NaN
        : value;
  }
  return out;
}
const read = async (client: PgQuery, text: string, values: unknown[] = []): Promise<JobRow[]> =>
  (await client.query(text, values)).rows.map(normal);
const safe = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Exact layout, this namespace's row, the policy it was provisioned with.
 * Nothing outside the reserved prefix is read. A tenant enrollment attests
 * it in its read snapshot too. */
export async function assertPostgresJobStore(client: PgQuery, policy: JobPolicy, trust?: LayoutTrust): Promise<void> {
  try {
    const described = async () => {
      const actual = await describePostgresRelations(client, JOB_PREFIX);
      if (canonicalCommandJson(actual, 1_048_576) !== canonicalCommandJson(LAYOUT, 1_048_576))
        return jobFail(layoutRefusal('The job store', await postgresLayoutVersion(client, q(t.policy)), VERSION));
    };
    await (trust ? trust.through(JOB_PREFIX, described) : described());
    const meta = await read(client, `SELECT version, policy_json, last_clock FROM ${q(t.policy)} WHERE namespace = $1`, [policy.namespace]);
    if (
      meta.length !== 1 ||
      meta[0].version !== VERSION ||
      meta[0].policy_json !== canonicalCommandJson(policy) ||
      !safe(meta[0].last_clock)
    )
      return jobFail(layoutRefusal('The job store', meta.length === 1 ? meta[0].version : undefined, VERSION));
  } catch (error) {
    if (error instanceof JobStoreUnavailable) throw error;
    return jobFail();
  }
}

/** Explicit maintenance, idempotent for the same policy, under the shared
 * migration lock. A database without the store gets its tables, a namespace
 * without a row gets one; the same policy is left alone; a namespace held
 * with other bounds is refused unchanged. */
export async function migratePostgresJobStore(url: string, input: JobPolicyInput): Promise<{ version: 1; migrated: boolean }> {
  const policy = captureJobPolicy(input);
  try {
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      if (!(await describePostgresRelations(client, JOB_PREFIX)).length)
        for (const ddl of JOB_POSTGRES_DEFINITIONS) await client.query(ddl);
      const migrated =
        (
          await client.query(
            `INSERT INTO ${q(t.policy)} (namespace, version, policy_json, last_clock) VALUES ($1, $2, $3, 0)
        ON CONFLICT (namespace) DO NOTHING`,
            [policy.namespace, VERSION, canonicalCommandJson(policy)],
          )
        ).rowCount === 1;
      await assertPostgresJobStore(client, policy);
      return { version: VERSION as 1, migrated };
    });
  } catch {
    return jobFail();
  }
}

export interface PostgresJobStoreOptions {
  /** 'database' (the default) takes now from the database in each
   * transaction; 'caller' uses the `now` each call passes, as SQLite does. */
  readonly clock?: 'database' | 'caller';
}

type Mode = 'read' | 'write' | 'namespace';

export async function openPostgresJobStore(
  connection: PgWriteClientSource,
  input: JobPolicyInput,
  options: PostgresJobStoreOptions = {},
): Promise<JobStore> {
  const policy = captureJobPolicy(input),
    clock = options.clock ?? 'database';
  if (!connection || typeof connection.withWriteClient !== 'function' || (clock !== 'database' && clock !== 'caller')) return jobFail();
  const ns = policy.namespace;
  const lock = createHash('sha256').update(`mistri.jobs ${policy.namespace}`).digest().readBigInt64BE(0).toString();
  let closed = false;
  /* The layout every transaction attests, kept across them (postgresRelations.ts LayoutTrust). */
  const trust = layoutTrust();

  /** One transaction on one leased client. A coded refusal rolls back and
   * keeps the client; anything else destroys it and is unavailability. */
  const transaction = async <T>(mode: Mode, host: number | undefined, work: (client: PgQuery, now: number) => Promise<T>): Promise<T> => {
    if (closed) return jobFail();
    if (host !== undefined) jobInteger(host, 0, JOB_MAX_CLOCK);
    let refusal: JobRefusal | undefined;
    try {
      const result = await connection.withWriteClient(async (client) => {
        /* A read verifies a row against its history in a second statement, so it
           reads one snapshot: at READ COMMITTED a host's attempt committing
           between the two made a sound row look inconsistent, and the read refused. */
        await client.query(mode === 'read' ? 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ' : 'BEGIN');
        try {
          await assertPostgresJobStore(client, policy, trust);
          if (mode === 'namespace') await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
          let now = 0;
          if (host !== undefined) {
            const floor = (await read(client, `SELECT last_clock FROM ${q(t.policy)} WHERE namespace = $1`, [ns]))[0]?.last_clock;
            now =
              clock === 'caller'
                ? host
                : ((await read(client, 'SELECT floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS now'))[0].now as number);
            // A backward clock stops the store rather than shortening a lease.
            if (!safe(floor) || !safe(now) || now > JOB_MAX_CLOCK || now < floor) return jobFail();
            if (mode === 'namespace')
              await client.query(`UPDATE ${q(t.policy)} SET last_clock = $1 WHERE namespace = $2 AND last_clock < $1`, [now, ns]);
          }
          const value = await work(client, now);
          await client.query('COMMIT');
          return value;
        } catch (error) {
          // Any failure re-attests next time: a moved table or column surfaces here first.
          trust.forget();
          try {
            await client.query('ROLLBACK');
          } catch {
            throw new JobStoreUnavailable();
          }
          if (error instanceof JobRefusal) {
            refusal = error;
            return undefined as T;
          }
          throw error;
        }
      });
      if (refusal) throw refusal;
      return result;
    } catch (error) {
      if (error instanceof JobRefusal || error instanceof JobStoreUnavailable) throw error;
      return jobFail();
    }
  };
  await transaction('read', undefined, async () => {});

  const history = (client: PgQuery, id: string) =>
    read(
      client,
      `SELECT a.* FROM ${q(t.attempt)} a JOIN ${q(t.job)} j ON j.id = a.job_id AND j.namespace = $2
      WHERE a.job_id = $1 ORDER BY a.attempt LIMIT ${JOB_HISTORY_LIMIT + 1}`,
      [id, ns],
    );
  const verifyRow = async (client: PgQuery, row: JobRow): Promise<JobInspection> =>
    verifyJobRow(policy, row, await history(client, row.id as string));
  const rowById = async (client: PgQuery, id: string, lockRow = false): Promise<JobRow | undefined> =>
    (
      await read(client, `SELECT * FROM ${q(t.job)} WHERE id = $1 AND namespace = $2${lockRow ? ' FOR UPDATE' : ''}`, [
        captureJobId(id),
        ns,
      ])
    )[0];
  const live = async (client: PgQuery, id: string, fence: string, now: number): Promise<JobRow> => {
    const row = await rowById(client, id, true);
    if (!row) return jobRefuse('job_not_found');
    if (typeof fence !== 'string' || row.state !== 'leased' || row.fence !== fence || now >= (row.lease_until as number))
      return jobRefuse('fence_stale');
    await verifyRow(client, row);
    return row;
  };
  const settleAttempt = async (client: PgQuery, row: JobRow, outcome: JobAttemptOutcome, code: JobOutcomeCode, now: number) => {
    const changed = await client.query(
      `UPDATE ${q(t.attempt)} SET outcome = $1, code = $2, finished_at = $3
      WHERE job_id = $4 AND attempt = $5 AND fence = $6 AND outcome = 'leased'`,
      [outcome, code, now, row.id, row.attempts, row.fence],
    );
    if (changed.rowCount !== 1) return jobFail();
  };
  const settleJob = async (
    client: PgQuery,
    row: JobRow,
    state: JobState,
    code: JobOutcomeCode,
    now: number,
    runAt: number,
    resultJson: string | null = null,
  ): Promise<JobInspection> => {
    const keep = held.includes(state);
    const changed = await client.query(
      `UPDATE ${q(t.job)} SET state = $1, run_at = $2, updated_at = $3, last_code = $4, result_json = $5,
      fence = ${keep ? 'fence' : 'NULL'}, lease_until = ${keep ? 'lease_until' : 'NULL'}
      WHERE id = $6 AND fence = $7 AND state IN ('leased', 'unknown')`,
      [state, runAt, now, code, resultJson, row.id, row.fence],
    );
    if (changed.rowCount !== 1) return jobFail();
    return inspectJobRow(policy, (await rowById(client, row.id as string))!);
  };
  const release = (client: PgQuery, row: JobRow, code: JobOutcomeCode, now: number): Promise<JobInspection> => {
    const next = jobRelease(policy, row, now);
    return settleJob(client, row, next.state, next.cancelled ? 'cancelled' : code, now, next.runAt);
  };
  const expire = async (client: PgQuery, now: number): Promise<number> => {
    const rows = await read(
      client,
      `SELECT * FROM ${q(t.job)} WHERE namespace = $2 AND state IN ('leased', 'unknown') AND lease_until <= $1
      ORDER BY lease_until, seq LIMIT 64 FOR UPDATE SKIP LOCKED`,
      [now, ns],
    );
    for (const row of rows) {
      await verifyRow(client, row);
      if (row.state === 'leased') await settleAttempt(client, row, 'unknown', 'lease_expired', now);
      await release(client, row, row.state === 'leased' ? 'lease_expired' : (row.last_code as JobOutcomeCode), now);
    }
    return rows.length;
  };

  const store: JobStore = {
    policy,
    enqueue: async (request, now) => {
      const value = captureJobEnqueue(policy, request);
      const enqueued = await transaction('write', now, async (client, at) => {
        const found = async () =>
          (
            await read(
              client,
              `SELECT id, fingerprint, run_at FROM ${q(t.job)}
          WHERE namespace = $3 AND job = $1 AND idempotency_key = $2`,
              [value.job, value.key, ns],
            )
          )[0];
        const replay = (existing: JobRow) =>
          existing.fingerprint !== value.fingerprint
            ? jobRefuse('idempotency_conflict')
            : Object.freeze({ id: existing.id as string, runAt: existing.run_at as number, replayed: true });
        const existing = await found();
        if (existing) return replay(existing);
        const id = randomUUID(),
          runAt = value.runAt ?? at;
        const inserted = await client.query(
          `INSERT INTO ${q(t.job)}
          (id, seq, job, version, idempotency_key, fingerprint, input_json, provenance_json, state, attempts, max_attempts, redrives,
           attempt_limit, run_at, created_at, updated_at, fence, lease_until, cancel_requested, last_code, result_json, namespace)
          VALUES ($1, nextval('${q(SEQUENCE)}'), $2, $3, $4, $5, $6, $7, 'scheduled', 0, $8, 0, $8, $9, $10, $10, NULL, NULL, 0, NULL, NULL, $11)
          ON CONFLICT (namespace, job, idempotency_key) DO NOTHING RETURNING id`,
          [
            id,
            value.job,
            value.version,
            value.key,
            value.fingerprint,
            value.inputJson,
            value.provenanceJson,
            value.maxAttempts,
            runAt,
            at,
            ns,
          ],
        );
        if (inserted.rowCount === 1) {
          /* A host in another process hears it at this transaction's commit, and never for one that rolls back
             (postgresCommandEventWake.ts): it waits for what is due, not on a timer. */
          await client.query(NOTIFY_COMMAND_EVENTS);
          return Object.freeze({ id, runAt, replayed: false });
        }
        // Another enqueue of the same key committed first: it is the job.
        const raced = await found();
        return raced ? replay(raced) : jobFail();
      });
      // Committed: a host in this process looks now, without waiting for the notification's round trip.
      if (!enqueued.replayed) jobEnqueued();
      return enqueued;
    },
    claim: async (now, limit = policy.maxInFlight) => {
      jobInteger(limit, 1, 64);
      return transaction('namespace', now, async (client, at) => {
        await expire(client, at);
        const inFlight = Number(
          (await client.query(`SELECT count(*)::int AS n FROM ${q(t.job)} WHERE namespace = $1 AND state IN ('leased', 'unknown')`, [ns]))
            .rows[0].n,
        );
        const room = Math.min(limit, policy.maxInFlight - inFlight);
        if (!Number.isSafeInteger(inFlight) || room <= 0) return Object.freeze([]);
        const due = withoutOverlap(
          await read(
            client,
            `SELECT * FROM ${q(t.job)} AS j WHERE namespace = $3 AND state IN ('scheduled', 'retry') AND run_at <= $1
          AND NOT (${oneAtATimeSql('j')} AND EXISTS (SELECT 1 FROM ${q(t.job)} AS o
            WHERE o.namespace = j.namespace AND o.job = j.job AND o.state IN ('leased', 'unknown') AND ${oneAtATimeSql('o')}))
          ORDER BY run_at, seq LIMIT $2 FOR UPDATE OF j SKIP LOCKED`,
            [at, room, ns],
          ),
        );
        const claims = [];
        for (const row of due) {
          await verifyRow(client, row);
          const attempt = (row.attempts as number) + 1,
            fence = randomUUID(),
            deadline = at + policy.leaseMs;
          await client.query(
            `UPDATE ${q(t.job)} SET state = 'leased', attempts = $1, fence = $2, lease_until = $3, updated_at = $4
            WHERE id = $5`,
            [attempt, fence, deadline, at, row.id],
          );
          await client.query(
            `INSERT INTO ${q(t.attempt)} (job_id, attempt, fence, started_at, deadline, outcome, code, finished_at, operator)
            VALUES ($1, $2, $3, $4, $5, 'leased', NULL, NULL, NULL)`,
            [row.id, attempt, fence, at, deadline],
          );
          claims.push(jobClaimOf(row, attempt, fence, deadline));
        }
        return Object.freeze(claims);
      });
    },
    succeed: async (id, fence, now, result) => {
      const resultJson = captureJobResult(policy, result);
      return transaction('write', now, async (client, at) => {
        const row = await live(client, id, fence, at);
        await settleAttempt(client, row, 'succeeded', 'succeeded', at);
        return settleJob(client, row, 'succeeded', 'succeeded', at, row.run_at as number, resultJson);
      });
    },
    fail: async (id, fence, now, outcome) => {
      const value = captureJobOutcome(outcome),
        state = value === 'cancelled' ? 'cancelled' : 'failed';
      return transaction('write', now, async (client, at) => {
        const row = await live(client, id, fence, at);
        await settleAttempt(client, row, state, value, at);
        return settleJob(client, row, state, value, at, row.run_at as number);
      });
    },
    retry: async (id, fence, now, outcome) => {
      const value = captureJobOutcome(outcome);
      return transaction('write', now, async (client, at) => {
        const row = await live(client, id, fence, at);
        const again = row.cancel_requested !== 1 && (row.attempts as number) < (row.attempt_limit as number);
        await settleAttempt(client, row, again ? 'retry' : 'failed', value, at);
        return release(client, row, value, at);
      });
    },
    unknown: async (id, fence, now, outcome) => {
      const value = captureJobOutcome(outcome);
      return transaction('write', now, async (client, at) => {
        const row = await live(client, id, fence, at);
        await settleAttempt(client, row, 'unknown', value, at);
        return settleJob(client, row, 'unknown', value, at, row.run_at as number);
      });
    },
    cancel: (id, now) =>
      transaction('write', now, async (client, at) => {
        const row = await rowById(client, id, true);
        if (!row) return jobRefuse('job_not_found');
        await verifyRow(client, row);
        if (row.state === 'scheduled' || row.state === 'retry') {
          await client.query(`UPDATE ${q(t.job)} SET state = 'cancelled', last_code = 'cancelled', updated_at = $1 WHERE id = $2`, [
            at,
            row.id,
          ]);
          return Object.freeze({ outcome: 'cancelled' as const, state: 'cancelled' as const });
        }
        if (held.includes(row.state as string)) {
          await client.query(`UPDATE ${q(t.job)} SET cancel_requested = 1, updated_at = $1 WHERE id = $2`, [at, row.id]);
          return Object.freeze({ outcome: 'requested' as const, state: row.state as JobState });
        }
        return Object.freeze({ outcome: 'unchanged' as const, state: row.state as JobState });
      }),
    expireLeases: (now) => transaction('namespace', now, (client, at) => expire(client, at)),
    cancelRequested: (id, fence) =>
      transaction('read', undefined, async (client) => {
        const row = await rowById(client, id);
        if (!row || row.fence !== fence || !held.includes(row.state as string)) return jobRefuse('fence_stale');
        return row.cancel_requested === 1;
      }),
    inspect: async (filter = {}, limit = 32) => {
      const captured = captureJobInspectFilter(filter, limit);
      const clauses = ['namespace = $1'],
        values: (string | number)[] = [ns];
      if (captured.state !== undefined) {
        values.push(captured.state);
        clauses.push(`state = $${values.length}`);
      }
      if (captured.job !== undefined) {
        values.push(captured.job);
        clauses.push(`job = $${values.length}`);
      }
      if (captured.afterId !== undefined) {
        values.push(captured.afterId);
        clauses.push(`seq > (SELECT seq FROM ${q(t.job)} WHERE id = $${values.length})`);
      }
      values.push(captured.limit);
      return transaction('read', undefined, async (client) => {
        const rows = await read(
          client,
          `SELECT * FROM ${q(t.job)} WHERE ${clauses.join(' AND ')} ORDER BY seq LIMIT $${values.length}`,
          values,
        );
        const inspected = [];
        for (const row of rows) inspected.push(await verifyRow(client, row));
        return Object.freeze(inspected);
      });
    },
    /* One statement, no row verified: the host's readiness and its next wake read this, where they inspected
       pages of rows, each checked against its history, every few seconds (jobHost.ts). */
    standing: (now) => {
      jobInteger(now, 0, JOB_MAX_CLOCK);
      return transaction('read', undefined, async (client) => {
        const [row] = await read(
          client,
          `WITH c AS (SELECT ${clock === 'caller' ? '$2::bigint' : 'floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint'} AS at)
          SELECT c.at,
            EXISTS (SELECT 1 FROM ${q(t.job)} WHERE namespace = $1 AND state IN ('failed', 'unknown')) AS failed,
            (SELECT min(run_at) FROM ${q(t.job)} WHERE namespace = $1 AND state IN ('scheduled', 'retry')) AS waiting,
            least((SELECT min(run_at) FROM ${q(t.job)} WHERE namespace = $1 AND state IN ('scheduled', 'retry') AND run_at > c.at),
              (SELECT min(lease_until) FROM ${q(t.job)} WHERE namespace = $1 AND state IN ('leased', 'unknown') AND lease_until > c.at)) AS next
          FROM c`,
          clock === 'caller' ? [ns, now] : [ns],
        );
        return jobStanding(row);
      });
    },
    attempts: async (id) => {
      if (typeof id !== 'string' || id.length !== 36) return jobFail();
      return transaction('read', undefined, async (client) => Object.freeze((await history(client, id)).map(jobAttemptInspection)));
    },
    redrive: async (id, operator, now) => {
      const who = captureJobOperator(operator);
      return transaction('namespace', now, async (client, at) => {
        const row = await rowById(client, id, true);
        if (!row) return jobRefuse('job_not_found');
        await verifyRow(client, row);
        assertJobRedrivable(row, at);
        const attempt = (row.attempts as number) + 1;
        await client.query(
          `INSERT INTO ${q(t.attempt)} (job_id, attempt, fence, started_at, deadline, outcome, code, finished_at, operator)
          VALUES ($1, $2, NULL, $3, NULL, 'redriven', 'redriven', $3, $4)`,
          [row.id, attempt, at, who],
        );
        const changed = await client.query(
          `UPDATE ${q(t.job)} SET state = 'retry', attempts = $1, redrives = redrives + 1,
          attempt_limit = $2, run_at = $3, updated_at = $3, fence = NULL, lease_until = NULL, last_code = 'redriven'
          WHERE id = $4 AND attempts = $5`,
          [attempt, attempt + (row.max_attempts as number), at, row.id, row.attempts],
        );
        if (changed.rowCount !== 1) return jobFail();
        // Runnable again: a host anywhere hears it at commit, as it hears an enqueue.
        await client.query(NOTIFY_COMMAND_EVENTS);
        return verifyRow(client, (await rowById(client, row.id as string))!);
      });
    },
    prune: async (olderThanMs, now, limit = 256) => {
      captureJobPrune(olderThanMs, limit);
      return transaction('write', now, async (client, at) => {
        const ids = (
          await read(
            client,
            `SELECT id FROM ${q(t.job)} WHERE namespace = $3 AND state = 'succeeded' AND updated_at < $1
          ORDER BY updated_at, seq LIMIT $2 FOR UPDATE SKIP LOCKED`,
            [at - olderThanMs, limit, ns],
          )
        ).map((row) => row.id as string);
        if (ids.length) {
          await client.query(`DELETE FROM ${q(t.attempt)} WHERE job_id = ANY($1::text[])`, [ids]);
          const gone = await client.query(`DELETE FROM ${q(t.job)} WHERE id = ANY($1::text[]) AND state = 'succeeded'`, [ids]);
          if (gone.rowCount !== ids.length) return jobFail();
        }
        return Object.freeze({ pruned: ids.length, more: ids.length === limit });
      });
    },
    close: async () => {
      closed = true;
    },
  };
  return Object.freeze(store);
}
