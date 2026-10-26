/** Explicitly provisioned, dedicated AN2 database: its `experiment_*` tables
 * in the runtime schema. Opening only attests. Each operation owns its
 * connection/transaction; epoch-row locks serialize writes. Raw unit IDs are
 * hashed before storage and are never returned by this port.
 */
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { ensurePostgresRuntimeSchema, postgresRuntimeSchemaProblems } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import { createHash } from 'node:crypto';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  EXPERIMENT_LIMITS,
  ExperimentCapacityExceeded,
  ExperimentConflict,
  ExperimentStoreUnavailable,
  digest,
  ensure,
  identifier,
  identifyEpoch,
  integer,
  json,
  normalizeBinding,
  normalizeReference,
  opaqueIdentifier,
  record,
  time,
  unitKey,
  type CommitGuard,
  type DecisionEvidence,
  type DecisionEvidenceInput,
  type EpochReference,
  type ExperimentBinding,
  type ExperimentResult,
  type ExperimentStore,
  type RegisteredEpoch,
} from './contracts.js';
import { prepareExposure } from './exposure.js';
import { prepareConversion } from './conversions.js';
import { buildExperimentResult, experimentResultStatistics, normalizeDelivery, type ArmAggregate } from './results.js';

interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface PostgresExperimentStoreOptions {
  readonly url: string;
  readonly binding: ExperimentBinding;
}
const schema = RUNTIME_SCHEMA;
/** Every table, index and row type of the store is named under it, beside other stores' in the runtime schema. */
const PREFIX = 'experiment_';
const table = (name: string) => `${schema}.${PREFIX}${name}`;
const immutable = `${schema}.experiment_immutable`;
/** A name prefix as a LIKE pattern, its underscores literal. */
const like = (prefix: string) => `${prefix.replaceAll('_', '\\_')}%`;
const immutableBody = "BEGIN RAISE EXCEPTION 'Experiment metadata, facts and evidence are append-only.'; END";
type Column = readonly [name: string, type: 'text' | 'bigint' | 'integer', collation?: 'C'];
interface Layout {
  readonly columns: readonly Column[];
  readonly key: readonly string[];
  readonly immutable?: boolean;
  readonly checks?: readonly string[];
}
const baseLayouts: Record<string, Layout> = {
  binding: {
    columns: [
      ['singleton', 'integer'],
      ['version', 'integer'],
      ['suite_id', 'text', 'C'],
      ['deployment_id', 'text', 'C'],
    ],
    key: ['singleton'],
    immutable: true,
    checks: ['singleton=1', 'version=1'],
  },
  epochs: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['fingerprint', 'text', 'C'],
      ['declaration', 'text'],
      ['registered_at', 'bigint'],
    ],
    key: ['epoch_key'],
    immutable: true,
  },
  progress: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['data_revision', 'bigint'],
      ['evidence_revision', 'bigint'],
      ['exposures', 'bigint'],
      ['conversions', 'bigint'],
    ],
    key: ['epoch_key'],
  },
  exposures: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['unit_key', 'text', 'C'],
      ['arm_id', 'text', 'C'],
      ['used_at', 'bigint'],
      ['received_at', 'bigint'],
    ],
    key: ['epoch_key', 'unit_key'],
  },
  conversions: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['source_key', 'text', 'C'],
      ['metric_id', 'text', 'C'],
      ['unit_key', 'text', 'C'],
      ['occurred_at', 'bigint'],
      ['received_at', 'bigint'],
    ],
    key: ['epoch_key', 'source_key', 'metric_id'],
    immutable: true,
  },
  results: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['revision', 'bigint'],
      ['document', 'text'],
    ],
    key: ['epoch_key', 'revision'],
    immutable: true,
  },
  decisions: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['decision_id', 'text', 'C'],
      ['document', 'text'],
    ],
    key: ['epoch_key', 'decision_id'],
    immutable: true,
  },
};
const layouts: Record<string, Layout> = {
  ...baseLayouts,
  exposure_coverage: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['started_at', 'bigint'],
    ],
    key: ['epoch_key'],
    immutable: true,
  },
  exposure_obligations: {
    columns: [
      ['epoch_key', 'text', 'C'],
      ['unit_key', 'text', 'C'],
      ['arm_id', 'text', 'C'],
    ],
    key: ['epoch_key', 'unit_key'],
    immutable: true,
  },
};
const extraIndexes = {
  conversions: `CREATE INDEX experiment_conversions_unit ON ${table('conversions')} USING btree (epoch_key, unit_key, metric_id, occurred_at)`,
  exposures: `CREATE INDEX experiment_exposures_maturity ON ${table('exposures')} USING btree (epoch_key, used_at, arm_id)`,
};
function checks(layout: Layout): string[] {
  return [
    ...(layout.checks ?? []),
    ...layout.columns.flatMap(([name, type]) =>
      type === 'bigint'
        ? [`${name}>=0 AND ${name}<=9007199254740991`]
        : type === 'text'
          ? [`octet_length(${name})<=${name === 'document' || name === 'declaration' ? EXPERIMENT_LIMITS.documentBytes : 128}`]
          : [],
    ),
  ];
}
function optionsOf(input: unknown): PostgresExperimentStoreOptions {
  const raw = record(input, ['url', 'binding']);
  ensure(typeof raw.url === 'string' && /^postgres(ql)?:\/\//.test(raw.url));
  const url = new URL(raw.url);
  ensure(url.hostname.length > 0 && url.pathname.length > 1 && url.username.length > 0);
  return Object.freeze({ url: raw.url, binding: normalizeBinding(raw.binding) });
}
async function withClient<T>(options: PostgresExperimentStoreOptions, work: (client: Client) => Promise<T>): Promise<T> {
  const module = 'pg';
  const pg = (await import(module)) as { Client: new (options: unknown) => Client };
  const client = new pg.Client({
    ...pgConnectionOptions(options.url),
    connectionTimeoutMillis: 5000,
    application_name: 'mistri-experiments',
    query_timeout: 15000,
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}
async function transaction<T>(client: Client, readOnly: boolean, work: () => Promise<T>, guard?: CommitGuard): Promise<T> {
  await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    const result = await work();
    if (guard) await guard();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}
/** The database holds nothing but this store: in the runtime schema only its
 * own tables and trigger function (none of them yet, when provisioning). */
async function databaseOwner(client: Client, provision: boolean): Promise<void> {
  const rows = (
    await client.query(
      `SELECT d.datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
    current_setting('session_replication_role')='origin' AS origin,
    NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname NOT IN ('public',$1) AND left(nspname,3)<>'pg_' AND nspname<>'information_schema') AS schemas,
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' OR (n.nspname=$1 AND NOT (lower(c.relname) LIKE ANY ($2::text[])))) AS relations,
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' OR (n.nspname=$1 AND p.proname <> ALL($3::text[]))) AS routines,
    NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AS types,
    NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql') AS extensions,
    NOT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname IN ('public',$1)) AS collations,
    NOT EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname IN ('public',$1)) AS operators,
    NOT EXISTS (SELECT 1 FROM pg_foreign_server) AS foreign_servers,
    NOT EXISTS (SELECT 1 FROM pg_event_trigger) AS event_triggers,
    NOT EXISTS (SELECT 1 FROM pg_publication) AS publications
    FROM pg_database d WHERE d.datname=current_database()`,
      [schema, provision ? [] : [like(PREFIX)], provision ? [] : ['experiment_immutable']],
    )
  ).rows;
  if (rows.length !== 1 || Object.values(rows[0]).some((value) => value !== true)) throw new ExperimentStoreUnavailable();
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const sqlShape = (sql: string) =>
  sql
    .replaceAll('::bigint', '')
    .replace(/[\s()']/g, '')
    .toLowerCase();
async function attest(client: Client, binding: ExperimentBinding, writer = false): Promise<void> {
  await databaseOwner(client, false);
  const names = Object.keys(layouts).sort();
  await client.query(`LOCK TABLE ${names.map(table).join(', ')} IN ${writer ? 'ROW EXCLUSIVE' : 'ACCESS SHARE'} MODE`);
  const relations = (
    await client.query(
      `SELECT c.relname AS name, c.relkind AS kind,
    c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned, c.relrowsecurity AS rls,
    c.relforcerowsecurity AS forced, c.relpersistence AS persistence
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND lower(c.relname) LIKE $2
    ORDER BY c.relname COLLATE "C"`,
      [schema, like(PREFIX)],
    )
  ).rows;
  const expectedNames = [...names.flatMap((name) => [name, `${name}_pkey`]), 'conversions_unit', 'exposures_maturity'].sort();
  if (
    !same(
      relations,
      expectedNames.map((name) => ({
        name: `${PREFIX}${name}`,
        kind: names.includes(name) ? 'r' : 'i',
        owned: true,
        rls: false,
        forced: false,
        persistence: 'p',
      })),
    )
  )
    throw new ExperimentStoreUnavailable();
  // A suite's experiment control may run as a role of its own, granted USAGE and CREATE on the schema by its owner.
  if ((await postgresRuntimeSchemaProblems(client as unknown as PgQuery, PREFIX, { delegated: true })).length)
    throw new ExperimentStoreUnavailable();
  for (const name of names) {
    const layout = layouts[name],
      relation = table(name);
    const columns = (
      await client.query(
        `SELECT a.attname AS name, format_type(a.atttypid,a.atttypmod) AS type,
      co.collname AS collation, NOT a.attnotnull AS nullable, pg_get_expr(d.adbin,d.adrelid) AS default
      FROM pg_attribute a LEFT JOIN pg_collation co ON co.oid=a.attcollation
      LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=$1::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
        [relation],
      )
    ).rows;
    if (
      !same(
        columns,
        layout.columns.map(([name, type, collation]) => ({
          name,
          type,
          collation: type === 'text' ? (collation ?? 'default') : null,
          nullable: false,
          default: null,
        })),
      )
    )
      throw new ExperimentStoreUnavailable();
    const constraints = (
      await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass`, [relation])
    ).rows;
    const expected = [`PRIMARY KEY (${layout.key.join(', ')})`, ...checks(layout).map((check) => `CHECK (${check})`)];
    if (!same(constraints.map((row) => sqlShape(String(row.definition))).sort(), expected.map(sqlShape).sort()))
      throw new ExperimentStoreUnavailable();
    const indexes = (
      await client.query(`SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1::regclass`, [relation])
    ).rows;
    const indexDefinitions = [
      `CREATE UNIQUE INDEX ${PREFIX}${name}_pkey ON ${relation} USING btree (${layout.key.join(', ')})`,
      ...(name === 'conversions' || name === 'exposures' ? [extraIndexes[name]] : []),
    ];
    if (!same(indexes.map((row) => row.definition).sort(), indexDefinitions.sort())) throw new ExperimentStoreUnavailable();
  }
  const extras = (
    await client.query(
      `SELECT
    (SELECT count(*)::integer FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND lower(c.relname) LIKE $2) AS policies,
    (SELECT count(*)::integer FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname=$1 AND lower(c.relname) LIKE $2) AS rules`,
      [schema, like(PREFIX)],
    )
  ).rows;
  if (!same(extras, [{ policies: 0, rules: 0 }])) throw new ExperimentStoreUnavailable();
  const triggers = (
    await client.query(
      `SELECT c.relname AS relation, t.tgname AS name, t.tgtype::integer AS type,
    t.tgenabled AS enabled, t.tgisinternal AS internal, t.tgfoid=$2::regprocedure AS function,
    t.tgnargs::integer AS arguments, t.tgqual IS NULL AS unconditional
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND lower(c.relname) LIKE $3 ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C"`,
      [schema, `${immutable}()`, like(PREFIX)],
    )
  ).rows;
  if (
    !same(
      triggers,
      names
        .filter((name) => layouts[name].immutable)
        .map((name) => ({
          relation: `${PREFIX}${name}`,
          name: `${PREFIX}${name}_immutable`,
          type: 58,
          enabled: 'O',
          internal: false,
          function: true,
          arguments: 0,
          unconditional: true,
        })),
    )
  )
    throw new ExperimentStoreUnavailable();
  const functions = (
    await client.query(
      `SELECT p.proname AS name, p.prosrc AS source, l.lanname AS language,
    p.prosecdef AS definer, p.proconfig AS config, p.pronargs::integer AS arguments,
    p.prorettype='trigger'::regtype AS trigger, p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname=$1 AND lower(p.proname) LIKE $2`,
      [schema, like(PREFIX)],
    )
  ).rows;
  if (
    !same(functions, [
      {
        name: 'experiment_immutable',
        source: immutableBody,
        language: 'plpgsql',
        definer: false,
        config: ['search_path=pg_catalog'],
        arguments: 0,
        trigger: true,
        owned: true,
      },
    ])
  )
    throw new ExperimentStoreUnavailable();
  const types = (
    await client.query(
      `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=$1 AND (lower(t.typname) LIKE $2 OR lower(t.typname) LIKE $3) ORDER BY t.typname COLLATE "C"`,
      [schema, like(PREFIX), like(`_${PREFIX}`)],
    )
  ).rows.map((row) => row.name);
  if (!same(types, names.flatMap((name) => [`${PREFIX}${name}`, `_${PREFIX}${name}`]).sort())) throw new ExperimentStoreUnavailable();
  if (
    !same((await client.query(`SELECT singleton,version,suite_id,deployment_id FROM ${table('binding')}`)).rows, [
      { singleton: 1, version: POSTGRES_EXPERIMENT_STORE_VERSION, suite_id: binding.suiteId, deployment_id: binding.deploymentId },
    ])
  )
    throw new ExperimentStoreUnavailable();
}
const POSTGRES_EXPERIMENT_STORE_VERSION = 1;
/** Open-time attestation that says which way the layout differs when the version row does (layoutRefusal.ts). */
async function attestSaying(client: Client, binding: ExperimentBinding, writer = false): Promise<void> {
  try {
    await attest(client, binding, writer);
  } catch (error) {
    if (!(error instanceof ExperimentStoreUnavailable)) throw error;
    const found = await client.query(`SELECT version FROM ${table('binding')}`).then(
      (result) => versionOfRows(result.rows),
      () => null,
    );
    const message = layoutRefusal('The experiment store', found, POSTGRES_EXPERIMENT_STORE_VERSION);
    throw message === undefined ? error : new ExperimentStoreUnavailable(message);
  }
}

export async function provisionPostgresExperimentStore(input: PostgresExperimentStoreOptions): Promise<void> {
  const options = optionsOf(input);
  await withClient(options, (client) =>
    transaction(client, false, async () => {
      const lock = createHash('sha256').update('mistri.experiments.provision.v1').digest().readBigInt64BE().toString();
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      await databaseOwner(client, true);
      await ensurePostgresRuntimeSchema(client as unknown as PgQuery);
      for (const [name, layout] of Object.entries(layouts)) {
        await client.query(`CREATE TABLE ${table(name)} (${layout.columns
          .map(([column, type, collation]) => `${column} ${type}${collation ? ' COLLATE "C"' : ''} NOT NULL`)
          .join(', ')}, PRIMARY KEY (${layout.key.join(', ')}),
        ${checks(layout)
          .map((check) => `CHECK (${check})`)
          .join(', ')})`);
      }
      for (const ddl of Object.values(extraIndexes)) await client.query(ddl);
      await client.query(
        `CREATE FUNCTION ${immutable}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS '${immutableBody.replaceAll("'", "''")}'`,
      );
      for (const [name, layout] of Object.entries(layouts))
        if (layout.immutable) {
          await client.query(
            `CREATE TRIGGER ${PREFIX}${name}_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${table(name)} FOR EACH STATEMENT EXECUTE FUNCTION ${immutable}()`,
          );
        }
      await client.query(`INSERT INTO ${table('binding')} VALUES (1,1,$1,$2)`, [options.binding.suiteId, options.binding.deploymentId]);
      await attest(client, options.binding, true);
    }),
  );
}
/** Coverage is computed in the same epoch-locked transaction as evidence.
 * Missing/late instrumentation and every unacknowledged assignment survive
 * process restart; browser loss counters never act as a completeness proof. */
async function exposureDelivery(
  client: Client,
  reference: EpochReference,
  declaration: RegisteredEpoch['declaration'],
  delivery: import('./contracts.js').DeliveryCompleteness,
  now: number,
) {
  const started = (await client.query(`SELECT started_at FROM ${table('exposure_coverage')} WHERE epoch_key=$1`, [reference.key])).rows[0];
  const unknown = numberOf(
    (
      await client.query(
        `SELECT count(*) AS count FROM ${table('exposure_obligations')} o
    WHERE o.epoch_key=$1 AND NOT EXISTS (SELECT 1 FROM ${table('exposures')} e WHERE e.epoch_key=o.epoch_key AND e.unit_key=o.unit_key AND e.arm_id=o.arm_id)`,
        [reference.key],
      )
    ).rows[0].count,
  );
  const missing = !started;
  if (started) time(numberOf(started.started_at));
  const expired = now >= declaration.endsAtMs + declaration.conversionWindowMs + declaration.deliveryGraceMs;
  return normalizeDelivery({
    ...delivery,
    pending: delivery.pending + (expired ? 0 : unknown),
    incomplete: delivery.incomplete + (missing ? 1 : 0) + (expired ? unknown : 0),
  });
}

function numberOf(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new ExperimentStoreUnavailable();
  return integer(Number(value));
}
function parsed(value: unknown): unknown {
  if (typeof value !== 'string' || Buffer.byteLength(value) > EXPERIMENT_LIMITS.documentBytes) throw new ExperimentStoreUnavailable();
  return JSON.parse(value);
}
async function clock(client: Client): Promise<number> {
  return time(numberOf((await client.query('SELECT floor(extract(epoch FROM clock_timestamp())*1000)::bigint AS now')).rows[0].now));
}
async function registered(client: Client, binding: ExperimentBinding, reference: EpochReference): Promise<RegisteredEpoch> {
  const row = (await client.query(`SELECT fingerprint,declaration FROM ${table('epochs')} WHERE epoch_key=$1`, [reference.key])).rows[0];
  if (!row || row.fingerprint !== reference.fingerprint) throw new ExperimentConflict();
  const epoch = identifyEpoch(binding, parsed(row.declaration) as RegisteredEpoch['declaration']);
  if (epoch.key !== reference.key || epoch.fingerprint !== reference.fingerprint) throw new ExperimentStoreUnavailable();
  return epoch;
}
async function progress(client: Client, key: string, lock = true) {
  const row = (
    await client.query(
      `SELECT data_revision,evidence_revision,exposures,conversions FROM ${table('progress')} WHERE epoch_key=$1${lock ? ' FOR UPDATE' : ''}`,
      [key],
    )
  ).rows[0];
  if (!row) throw new ExperimentStoreUnavailable();
  return {
    dataRevision: numberOf(row.data_revision),
    evidenceRevision: numberOf(row.evidence_revision),
    exposures: integer(numberOf(row.exposures), 0, EXPERIMENT_LIMITS.exposures),
    conversions: integer(numberOf(row.conversions), 0, EXPERIMENT_LIMITS.conversions),
  };
}
function guardOf(guard: CommitGuard): CommitGuard {
  ensure(typeof guard === 'function', 'Trusted commit guard required.');
  return guard;
}
function decodeResult(value: unknown, reference: EpochReference, declaration: RegisteredEpoch['declaration']): ExperimentResult {
  const raw = record(parsed(value), [
    'epoch',
    'declaration',
    'dataRevision',
    'evidenceRevision',
    'capturedAtMs',
    'delivery',
    'diagnostics',
    'input',
    'statisticsVersion',
    'statistics',
  ]);
  ensure(raw.statisticsVersion === 'an2-binary-v1', 'Unsupported evidence method version.');
  const storedReference = normalizeReference(raw.epoch);
  if (!same(storedReference, reference) || json(raw.declaration) !== json(declaration)) throw new ExperimentStoreUnavailable();
  const input = raw.input as ExperimentResult['input'];
  ensure(input && Array.isArray(input.arms) && input.arms.length <= 16);
  const rebuilt = buildExperimentResult({
    epoch: reference,
    declaration,
    dataRevision: integer(raw.dataRevision),
    evidenceRevision: integer(raw.evidenceRevision, 1),
    capturedAtMs: time(raw.capturedAtMs),
    delivery: normalizeDelivery(raw.delivery),
    diagnostics: raw.diagnostics as ExperimentResult['diagnostics'],
    aggregates: input.arms.map((arm: ExperimentResult['input']['arms'][number]) => {
      ensure(arm.primary !== null && arm.guardrails.every((value) => value !== null));
      return {
        arm: arm.id,
        exposed: arm.exposed,
        mature: arm.mature,
        primary: arm.primary,
        guardrails: arm.guardrails as readonly number[],
      };
    }),
  });
  if (json(rebuilt) !== json(raw)) throw new ExperimentStoreUnavailable();
  return rebuilt;
}
function decisionInput(value: unknown): DecisionEvidenceInput {
  const raw = record(value, ['decisionId', 'evidenceRevision', 'expectedDataRevision', 'arm', 'actorId', 'reason', 'controlRevision']);
  ensure(
    typeof raw.reason === 'string' &&
      raw.reason.length > 0 &&
      raw.reason.length <= 1024 &&
      raw.reason.trim() === raw.reason &&
      !/[\p{Cc}\p{Cs}]/u.test(raw.reason),
  );
  return Object.freeze({
    decisionId: opaqueIdentifier(raw.decisionId),
    evidenceRevision: integer(raw.evidenceRevision, 1),
    expectedDataRevision: integer(raw.expectedDataRevision),
    arm: identifier(raw.arm),
    actorId: opaqueIdentifier(raw.actorId),
    reason: raw.reason,
    controlRevision: integer(raw.controlRevision, 1),
  });
}
function decodeDecision(value: unknown, reference: EpochReference): DecisionEvidence {
  const raw = record(parsed(value), [
    'decisionId',
    'evidenceRevision',
    'expectedDataRevision',
    'arm',
    'reason',
    'controlRevision',
    'actorKey',
    'epoch',
    'recordedAtMs',
  ]);
  const storedReference = normalizeReference(raw.epoch);
  if (!same(storedReference, reference)) throw new ExperimentStoreUnavailable();
  ensure(typeof raw.actorKey === 'string' && /^[a-f0-9]{64}$/.test(raw.actorKey));
  const fields = decisionInput({
    decisionId: raw.decisionId,
    evidenceRevision: raw.evidenceRevision,
    expectedDataRevision: raw.expectedDataRevision,
    arm: raw.arm,
    actorId: 'stored-actor',
    reason: raw.reason,
    controlRevision: raw.controlRevision,
  });
  const { actorId: _actorId, ...rest } = fields;
  return Object.freeze({ ...rest, actorKey: raw.actorKey, epoch: storedReference, recordedAtMs: time(raw.recordedAtMs) });
}

export async function openPostgresExperimentStore(input: PostgresExperimentStoreOptions): Promise<ExperimentStore> {
  const options = optionsOf(input);
  await withClient(options, (client) => transaction(client, true, () => attestSaying(client, options.binding)));
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const run = <T>(readOnly: boolean, work: (client: Client) => Promise<T>, guard?: CommitGuard): Promise<T> => {
    if (closed) return Promise.reject(new ExperimentStoreUnavailable());
    const result = withClient(options, (client) =>
      transaction(
        client,
        readOnly,
        async () => {
          await attestSaying(client, options.binding, !readOnly);
          return work(client);
        },
        guard,
      ),
    );
    active.add(result);
    void result.then(
      () => active.delete(result),
      () => active.delete(result),
    );
    return result;
  };
  const store: ExperimentStore = {
    binding: options.binding,
    registerEpoch(inputEpoch, guard) {
      const epoch = identifyEpoch(options.binding, inputEpoch);
      guardOf(guard);
      return run(
        false,
        async (client) => {
          const inserted = await client.query(
            `INSERT INTO ${table('epochs')} VALUES ($1,$2,$3,$4) ON CONFLICT (epoch_key) DO NOTHING RETURNING epoch_key`,
            [epoch.key, epoch.fingerprint, json(epoch.declaration), await clock(client)],
          );
          const existing = await registered(client, options.binding, epoch);
          await client.query(`INSERT INTO ${table('progress')} VALUES ($1,0,0,0,0) ON CONFLICT (epoch_key) DO NOTHING`, [epoch.key]);
          // Activation requires registration; only a newly registered epoch can
          // establish coverage. Re-registering a legacy epoch cannot heal loss.
          if (inserted.rows.length)
            await client.query(`INSERT INTO ${table('exposure_coverage')} VALUES ($1,$2) ON CONFLICT (epoch_key) DO NOTHING`, [
              epoch.key,
              await clock(client),
            ]);
          return existing;
        },
        guard,
      );
    },
    readEpoch(inputReference) {
      const reference = normalizeReference(inputReference);
      return run(true, (client) => registered(client, options.binding, reference));
    },
    enrollExposure(inputReference, assignment, guard) {
      const reference = normalizeReference(inputReference);
      guardOf(guard);
      const raw = record(assignment, ['unit', 'arm']),
        unit = record(raw.unit, ['kind', 'id']),
        arm = identifier(raw.arm);
      return run(
        false,
        async (client) => {
          const epoch = await registered(client, options.binding, reference),
            state = await progress(client, reference.key);
          const now = await clock(client),
            declaration = epoch.declaration;
          ensure(now >= declaration.startsAtMs && now < declaration.endsAtMs, 'Assignment outside enrollment horizon.');
          ensure(declaration.arms.some((value) => value.id === arm && value.weight > 0));
          const key = unitKey(reference, unit as unknown as Parameters<ExperimentStore['enrollExposure']>[1]['unit'], declaration.unit);
          const prior = (
            await client.query(`SELECT arm_id FROM ${table('exposure_obligations')} WHERE epoch_key=$1 AND unit_key=$2`, [
              reference.key,
              key,
            ])
          ).rows[0];
          if (prior) {
            if (prior.arm_id !== arm) throw new ExperimentConflict();
            return;
          }
          const count = numberOf(
            (await client.query(`SELECT count(*) AS count FROM ${table('exposure_obligations')} WHERE epoch_key=$1`, [reference.key]))
              .rows[0].count,
          );
          if (count >= EXPERIMENT_LIMITS.exposures) throw new ExperimentCapacityExceeded();
          await client.query(`INSERT INTO ${table('exposure_obligations')} VALUES ($1,$2,$3)`, [reference.key, key, arm]);
          await client.query(`UPDATE ${table('progress')} SET data_revision=$2 WHERE epoch_key=$1`, [
            reference.key,
            integer(state.dataRevision + 1),
          ]);
        },
        guard,
      );
    },
    readDataRevision(inputReference) {
      const reference = normalizeReference(inputReference);
      return run(true, async (client) => {
        await registered(client, options.binding, reference);
        return (await progress(client, reference.key, false)).dataRevision;
      });
    },
    ingestExposure(inputReference, inputFact, guard) {
      const reference = normalizeReference(inputReference);
      guardOf(guard);
      // Capture before awaiting any I/O, including nested unit identity.
      const raw = record(inputFact, ['unit', 'arm', 'usedAtMs']);
      const fact = { unit: record(raw.unit, ['kind', 'id']), arm: raw.arm, usedAtMs: raw.usedAtMs };
      return run(
        false,
        async (client) => {
          const epoch = await registered(client, options.binding, reference),
            state = await progress(client, reference.key);
          const observation = prepareExposure(reference, epoch.declaration, fact as unknown as typeof inputFact, await clock(client));
          const obligation = (
            await client.query(`SELECT arm_id FROM ${table('exposure_obligations')} WHERE epoch_key=$1 AND unit_key=$2`, [
              reference.key,
              observation.unitKey,
            ])
          ).rows[0];
          if (obligation && obligation.arm_id !== observation.arm) throw new ExperimentConflict();
          const rows = (
            await client.query(`SELECT arm_id,used_at,received_at FROM ${table('exposures')} WHERE epoch_key=$1 AND unit_key=$2`, [
              reference.key,
              observation.unitKey,
            ])
          ).rows;
          if (rows.length && rows[0].arm_id !== observation.arm) throw new ExperimentConflict();
          if (rows.length && numberOf(rows[0].used_at) <= observation.usedAtMs)
            return Object.freeze({
              status: 'duplicate' as const,
              dataRevision: state.dataRevision,
              late:
                numberOf(rows[0].received_at) >
                epoch.declaration.endsAtMs + epoch.declaration.conversionWindowMs + epoch.declaration.deliveryGraceMs,
            });
          const revision = integer(state.dataRevision + 1);
          if (!rows.length) {
            if (state.exposures >= EXPERIMENT_LIMITS.exposures) throw new ExperimentCapacityExceeded();
            await client.query(`INSERT INTO ${table('exposures')} VALUES ($1,$2,$3,$4,$5)`, [
              reference.key,
              observation.unitKey,
              observation.arm,
              observation.usedAtMs,
              observation.receivedAtMs,
            ]);
          } else {
            await client.query(`UPDATE ${table('exposures')} SET used_at=$3,received_at=$4 WHERE epoch_key=$1 AND unit_key=$2`, [
              reference.key,
              observation.unitKey,
              observation.usedAtMs,
              observation.receivedAtMs,
            ]);
          }
          await client.query(`UPDATE ${table('progress')} SET data_revision=$2,exposures=$3 WHERE epoch_key=$1`, [
            reference.key,
            revision,
            state.exposures + (rows.length ? 0 : 1),
          ]);
          return Object.freeze({
            status: rows.length ? ('earlier-exposure' as const) : ('inserted' as const),
            dataRevision: revision,
            late: observation.late,
          });
        },
        guard,
      );
    },
    ingestConversion(inputReference, inputFact, guard) {
      const reference = normalizeReference(inputReference);
      guardOf(guard);
      const raw = record(inputFact, ['unit', 'source', 'eventId', 'event', 'eventVersion', 'metric', 'occurredAtMs']);
      const fact = { ...raw, unit: record(raw.unit, ['kind', 'id']) };
      return run(
        false,
        async (client) => {
          const epoch = await registered(client, options.binding, reference),
            state = await progress(client, reference.key);
          const observation = prepareConversion(reference, epoch.declaration, fact as unknown as typeof inputFact, await clock(client));
          const prior = (
            await client.query(
              `SELECT unit_key,occurred_at,received_at FROM ${table('conversions')} WHERE epoch_key=$1 AND source_key=$2 AND metric_id=$3`,
              [reference.key, observation.sourceKey, observation.metric],
            )
          ).rows[0];
          if (prior) {
            if (prior.unit_key !== observation.unitKey || numberOf(prior.occurred_at) !== observation.occurredAtMs)
              throw new ExperimentConflict();
            return Object.freeze({
              status: 'duplicate' as const,
              dataRevision: state.dataRevision,
              late:
                numberOf(prior.received_at) >
                epoch.declaration.endsAtMs + epoch.declaration.conversionWindowMs + epoch.declaration.deliveryGraceMs,
            });
          }
          if (state.conversions >= EXPERIMENT_LIMITS.conversions) throw new ExperimentCapacityExceeded();
          const exposed = (
            await client.query(`SELECT 1 FROM ${table('exposures')} WHERE epoch_key=$1 AND unit_key=$2`, [
              reference.key,
              observation.unitKey,
            ])
          ).rows.length;
          if (!exposed) {
            const pending = numberOf(
              (
                await client.query(
                  `SELECT count(*) AS count FROM ${table('conversions')} c WHERE c.epoch_key=$1
            AND NOT EXISTS (SELECT 1 FROM ${table('exposures')} e WHERE e.epoch_key=c.epoch_key AND e.unit_key=c.unit_key)`,
                  [reference.key],
                )
              ).rows[0].count,
            );
            if (pending >= EXPERIMENT_LIMITS.pendingConversions) throw new ExperimentCapacityExceeded();
          }
          const revision = integer(state.dataRevision + 1);
          await client.query(`INSERT INTO ${table('conversions')} VALUES ($1,$2,$3,$4,$5,$6)`, [
            reference.key,
            observation.sourceKey,
            observation.metric,
            observation.unitKey,
            observation.occurredAtMs,
            observation.receivedAtMs,
          ]);
          await client.query(`UPDATE ${table('progress')} SET data_revision=$2,conversions=$3 WHERE epoch_key=$1`, [
            reference.key,
            revision,
            state.conversions + 1,
          ]);
          return Object.freeze({ status: 'inserted' as const, dataRevision: revision, late: observation.late });
        },
        guard,
      );
    },
    publishResults(inputReference, inputPublication, guard) {
      const reference = normalizeReference(inputReference),
        raw = record(inputPublication, ['expectedDataRevision', 'delivery']);
      guardOf(guard);
      const expectedDataRevision = integer(raw.expectedDataRevision),
        delivery = normalizeDelivery(raw.delivery);
      return run(
        false,
        async (client) => {
          const epoch = await registered(client, options.binding, reference),
            state = await progress(client, reference.key);
          if (state.dataRevision !== expectedDataRevision) throw new ExperimentConflict();
          const now = await clock(client),
            declaration = epoch.declaration,
            revision = integer(state.evidenceRevision + 1, 1);
          const cutoff = now - declaration.conversionWindowMs;
          const finalAt = declaration.endsAtMs + declaration.conversionWindowMs + declaration.deliveryGraceMs;
          // At most 16*17 grouped rows reach JS; unique units, not event volume,
          // form all denominators. EXISTS supplies one binary outcome per metric.
          const totals = (
            await client.query(
              `SELECT arm_id,count(*) AS exposed,count(*) FILTER (WHERE used_at<=$2) AS mature
          FROM ${table('exposures')} WHERE epoch_key=$1 GROUP BY arm_id`,
              [reference.key, cutoff],
            )
          ).rows;
          const metrics = [declaration.primary, ...declaration.guardrails].map((metric) => metric.id);
          const outcomes = (
            await client.query(
              `SELECT e.arm_id,m.metric_id,count(*) AS converted FROM ${table('exposures')} e
          CROSS JOIN unnest($3::text[]) AS m(metric_id) WHERE e.epoch_key=$1 AND e.used_at<=$2
          AND EXISTS (SELECT 1 FROM ${table('conversions')} c WHERE c.epoch_key=e.epoch_key AND c.unit_key=e.unit_key
            AND c.metric_id=m.metric_id AND c.occurred_at>e.used_at AND c.occurred_at<=e.used_at+$4)
          GROUP BY e.arm_id,m.metric_id`,
              [reference.key, cutoff, metrics, declaration.conversionWindowMs],
            )
          ).rows;
          const aggregates: ArmAggregate[] = declaration.arms.map((arm) => {
            const total = totals.find((row) => row.arm_id === arm.id);
            const converted = (metric: string) => {
              const row = outcomes.find((row) => row.arm_id === arm.id && row.metric_id === metric);
              return row ? numberOf(row.converted) : 0;
            };
            return {
              arm: arm.id,
              exposed: total ? numberOf(total.exposed) : 0,
              mature: total ? numberOf(total.mature) : 0,
              primary: converted(declaration.primary.id),
              guardrails: declaration.guardrails.map((metric) => converted(metric.id)),
            };
          });
          if (
            totals.some((row) => !declaration.arms.some((arm) => arm.id === row.arm_id)) ||
            aggregates.reduce((n, arm) => n + arm.exposed, 0) !== state.exposures
          )
            throw new ExperimentStoreUnavailable();
          const counts = (
            await client.query(
              `SELECT count(*) AS total,count(*) FILTER (WHERE e.unit_key IS NULL) AS pending,
          count(*) FILTER (WHERE e.unit_key IS NOT NULL AND NOT (c.occurred_at>e.used_at AND c.occurred_at<=e.used_at+$2)) AS unattributed,
          count(*) FILTER (WHERE c.received_at>$3) AS late FROM ${table('conversions')} c LEFT JOIN ${table('exposures')} e
          ON e.epoch_key=c.epoch_key AND e.unit_key=c.unit_key WHERE c.epoch_key=$1`,
              [reference.key, declaration.conversionWindowMs, finalAt],
            )
          ).rows[0];
          if (numberOf(counts.total) !== state.conversions) throw new ExperimentStoreUnavailable();
          const lateExposures = numberOf(
            (
              await client.query(`SELECT count(*) AS count FROM ${table('exposures')} WHERE epoch_key=$1 AND received_at>$2`, [
                reference.key,
                finalAt,
              ])
            ).rows[0].count,
          );
          const result = buildExperimentResult({
            epoch: reference,
            declaration,
            dataRevision: state.dataRevision,
            evidenceRevision: revision,
            capturedAtMs: now,
            delivery: await exposureDelivery(client, reference, declaration, delivery, now),
            aggregates,
            diagnostics: {
              pendingConversions: numberOf(counts.pending),
              unattributedConversions: numberOf(counts.unattributed),
              lateConversions: numberOf(counts.late),
              lateExposures,
            },
          });
          await client.query(`INSERT INTO ${table('results')} VALUES ($1,$2,$3)`, [reference.key, revision, json(result)]);
          await client.query(`UPDATE ${table('progress')} SET evidence_revision=$2 WHERE epoch_key=$1`, [reference.key, revision]);
          return result;
        },
        guard,
      );
    },
    readResults(inputReference, inputRevision) {
      const reference = normalizeReference(inputReference),
        revision = inputRevision === undefined ? null : integer(inputRevision, 1);
      return run(true, async (client) => {
        const epoch = await registered(client, options.binding, reference);
        const row = (
          await client.query(
            `SELECT document FROM ${table('results')} WHERE epoch_key=$1 AND ($2::bigint IS NULL OR revision=$2)
          ORDER BY revision DESC LIMIT 1`,
            [reference.key, revision],
          )
        ).rows[0];
        if (!row) throw new ExperimentConflict();
        const result = decodeResult(row.document, reference, epoch.declaration);
        if (revision !== null && result.evidenceRevision !== revision) throw new ExperimentStoreUnavailable();
        return result;
      });
    },
    appendDecisionEvidence(inputReference, inputDecision, guard) {
      const reference = normalizeReference(inputReference),
        decision = decisionInput(inputDecision);
      guardOf(guard);
      return run(
        false,
        async (client) => {
          const epoch = await registered(client, options.binding, reference),
            state = await progress(client, reference.key);
          const actorKey = digest(['mistri.experiments.actor.v1', options.binding, decision.actorId]);
          const { actorId: _actorId, ...fields } = decision;
          const prior = (
            await client.query(`SELECT document FROM ${table('decisions')} WHERE epoch_key=$1 AND decision_id=$2`, [
              reference.key,
              decision.decisionId,
            ])
          ).rows[0];
          if (prior) {
            const existing = decodeDecision(prior.document, reference);
            if (!same({ ...fields, actorKey, epoch: reference, recordedAtMs: existing.recordedAtMs }, existing))
              throw new ExperimentConflict();
            return Object.freeze(existing);
          }
          if (state.dataRevision !== decision.expectedDataRevision || state.evidenceRevision !== decision.evidenceRevision)
            throw new ExperimentConflict();
          const row = (
            await client.query(`SELECT document FROM ${table('results')} WHERE epoch_key=$1 AND revision=$2`, [
              reference.key,
              decision.evidenceRevision,
            ])
          ).rows[0];
          if (!row) throw new ExperimentConflict();
          const result = decodeResult(row.document, reference, epoch.declaration);
          ensure(
            result.dataRevision === state.dataRevision && experimentResultStatistics(result).status === 'final-evidence',
            'Decision requires complete final statistical evidence.',
          );
          ensure(epoch.declaration.arms.some((arm) => arm.id === decision.arm && arm.weight > 0));
          const evidence: DecisionEvidence = Object.freeze({ ...fields, actorKey, epoch: reference, recordedAtMs: await clock(client) });
          await client.query(`INSERT INTO ${table('decisions')} VALUES ($1,$2,$3)`, [reference.key, decision.decisionId, json(evidence)]);
          return evidence;
        },
        guard,
      );
    },
    decisions(inputReference, inputQuery) {
      const reference = normalizeReference(inputReference),
        query = record(inputQuery, ['after', 'limit']);
      const limit = integer(query.limit, 1, EXPERIMENT_LIMITS.page),
        after = query.after === undefined ? null : opaqueIdentifier(query.after);
      return run(true, async (client) => {
        await registered(client, options.binding, reference);
        const rows = (
          await client.query(
            `SELECT document FROM ${table('decisions')} WHERE epoch_key=$1
          AND ($2::text IS NULL OR decision_id>$2 COLLATE "C") ORDER BY decision_id COLLATE "C" LIMIT $3`,
            [reference.key, after, limit + 1],
          )
        ).rows;
        const entries = rows.slice(0, limit).map((row) => decodeDecision(row.document, reference));
        return Object.freeze({ entries: Object.freeze(entries), nextAfter: rows.length > limit ? entries.at(-1)!.decisionId : null });
      });
    },
    async close() {
      closed = true;
      await Promise.allSettled([...active]);
    },
  };
  return Object.freeze(store);
}
