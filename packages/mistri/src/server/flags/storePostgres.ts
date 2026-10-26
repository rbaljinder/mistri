/** Dedicated PostgreSQL control database. Explicit provisioning owns an empty
 * database and its `flag_*` tables in the runtime schema; opening never
 * repairs/migrates them. Only URL-owned connections are accepted, so a
 * caller's transaction cannot be committed, rolled back or closed by this
 * store. No connections survive an operation. */
import { RUNTIME_SCHEMA } from '@mistriwork/engine/shared/runtimeTables.js';
import { createHash } from 'node:crypto';
import { pgConnectionOptions } from '@mistriwork/engine/adapters/postgresValues.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { ensurePostgresRuntimeSchema, postgresRuntimeSchemaProblems } from '@mistriwork/engine/adapters/postgresMaintenance.js';
import { layoutRefusal, versionOfRows } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  normalizeFlagCatalog,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagOverrideSnapshot,
  type FlagScope,
} from '../../shared/appFlags.js';
import {
  FlagRevisionConflict,
  FlagStoreUnavailable,
  flagStoreRecord,
  normalizeFlagHistoryQuery,
  normalizeFlagStoreBinding,
  normalizeFlagStoreMutation,
  type FlagHistoryEntry,
  type FlagStore,
  type FlagStoreBinding,
} from './store.js';

interface Client {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, values?: readonly unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
export interface PostgresFlagStoreOptions {
  readonly url: string;
  readonly binding: FlagStoreBinding;
}
const schema = RUNTIME_SCHEMA;
/** The store's tables, its indexes and their row types are named under it, beside other stores' in the runtime schema. */
const PREFIX = 'flag_';
const table = (name: string) => `${schema}.${PREFIX}${name}`;
const immutable = `${schema}.flag_immutable`;
/** What a suite may keep beside its flag control in one database: its grants, preferences and authority history
 * (suiteStoresPostgres.ts allows the flag control in turn), each of which attests its own tables. */
const NEIGHBOURS = ['suite_grant', 'suite_preference', 'suite_authority'];
/** A name prefix as a LIKE pattern, its underscores literal. */
const like = (prefix: string) => `${prefix.replaceAll('_', '\\_')}%`;
const meta = table('binding'),
  state = table('state'),
  audit = table('audit');
const LIMIT = 1_048_576;
const keyColumns = ['suite_id', 'deployment_id', 'app_id', 'environment', 'tenant_key'];
const where = keyColumns.map((key, index) => `${key}=$${index + 1} COLLATE "C"`).join(' AND ');
const immutableBody = "BEGIN RAISE EXCEPTION 'Flag control metadata and audit are append-only.'; END";
const keyDdl = keyColumns.map((key) => `${key} text COLLATE "C" NOT NULL`).join(', ');
const POSTGRES_FLAG_STORE_VERSION = 1;
const evidenceCheck = "CHECK (((operation = 'decide') = (decision_evidence IS NOT NULL)))";
const definitions = [
  `CREATE TABLE ${meta} (singleton integer PRIMARY KEY CHECK (singleton=1), version integer NOT NULL CHECK (version=1),
    suite_id text COLLATE "C" NOT NULL, deployment_id text COLLATE "C" NOT NULL)`,
  `CREATE TABLE ${state} (${keyDdl}, revision bigint NOT NULL CHECK (revision>=0 AND revision<=9007199254740991),
    snapshot text NOT NULL CHECK (octet_length(snapshot)<=${LIMIT}), PRIMARY KEY (${keyColumns.join(', ')}))`,
  `CREATE TABLE ${audit} (${keyDdl}, revision bigint NOT NULL CHECK (revision>0 AND revision<=9007199254740991),
    flag_id text COLLATE "C" NOT NULL, operation text NOT NULL CHECK (operation IN ('set','kill','revert','decide')),
    actor_id text COLLATE "C" NOT NULL, reason text NOT NULL, at text NOT NULL, revert_revision bigint,
    before_snapshot text NOT NULL CHECK (octet_length(before_snapshot)<=${LIMIT}),
    after_snapshot text NOT NULL CHECK (octet_length(after_snapshot)<=${LIMIT}),
    decision_evidence text CHECK (octet_length(decision_evidence)<=${LIMIT}), ${evidenceCheck},
    PRIMARY KEY (${keyColumns.join(', ')}, revision))`,
  `CREATE FUNCTION ${immutable}() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS '${immutableBody.replaceAll("'", "''")}'`,
  `CREATE TRIGGER flag_binding_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${meta} FOR EACH STATEMENT EXECUTE FUNCTION ${immutable}()`,
  `CREATE TRIGGER flag_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON ${audit} FOR EACH STATEMENT EXECUTE FUNCTION ${immutable}()`,
];

function optionsOf(input: unknown): PostgresFlagStoreOptions {
  const value = flagStoreRecord(input, ['url', 'binding']);
  if (typeof value.url !== 'string' || !/^postgres(ql)?:\/\//.test(value.url)) throw new FlagStoreUnavailable();
  return Object.freeze({ url: value.url, binding: normalizeFlagStoreBinding(value.binding) });
}
async function withClient<T>(options: PostgresFlagStoreOptions, work: (client: Client) => Promise<T>): Promise<T> {
  const module = 'pg';
  const pg = (await import(module)) as { Client: new (options: unknown) => Client };
  const client = new pg.Client({
    ...pgConnectionOptions(options.url),
    connectionTimeoutMillis: 5000,
    application_name: 'mistri-flags',
    query_timeout: 15000,
  });
  try {
    await client.connect();
    return await work(client);
  } finally {
    await client.end();
  }
}
async function transaction<T>(
  client: Client,
  readOnly: boolean,
  work: () => Promise<T>,
  beforeCommit?: () => void | Promise<void>,
): Promise<T> {
  // This client was just created here. No public function accepts a client,
  // connection factory or an existing transaction to take ownership of.
  await client.query(readOnly ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN ISOLATION LEVEL READ COMMITTED');
  try {
    await client.query("SET LOCAL search_path=pg_catalog; SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'");
    const result = await work();
    if (beforeCommit) await beforeCommit();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  }
}

/** An empty dedicated database is stronger than a reserved prefix in a
 * business DB. Reject foreign schemas, relations, functions, types and
 * extensions instead of claiming them for flags: the runtime schema may hold
 * only this store's tables and its trigger function. A suite's own grants,
 * preferences and authority tables are not foreign: a suite may keep its
 * flag control in the one database it keeps those in, and each of those
 * stores attests its own tables. */
async function databaseOwner(client: Client, provision: boolean): Promise<void> {
  const result = await client.query(
    `SELECT d.datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user) AS owned,
    current_setting('session_replication_role')='origin' AS origin,
    NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname <> ALL($1::text[]) AND left(nspname,3)<>'pg_' AND nspname<>'information_schema') AS schemas,
    NOT EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' OR (n.nspname=$2 AND NOT (lower(c.relname) LIKE ANY ($3::text[])))) AS relations,
    NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' OR (n.nspname=$2 AND p.proname <> ALL($4::text[]))) AS routines,
    NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public') AS types,
    NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname<>'plpgsql') AS extensions,
    NOT EXISTS (SELECT 1 FROM pg_collation c JOIN pg_namespace n ON n.oid=c.collnamespace WHERE n.nspname='public') AS collations,
    NOT EXISTS (SELECT 1 FROM pg_operator o JOIN pg_namespace n ON n.oid=o.oprnamespace WHERE n.nspname='public') AS operators,
    NOT EXISTS (SELECT 1 FROM pg_foreign_server) AS foreign_servers,
    NOT EXISTS (SELECT 1 FROM pg_event_trigger) AS event_triggers,
    NOT EXISTS (SELECT 1 FROM pg_publication) AS publications
    FROM pg_database d WHERE d.datname=current_database()`,
    [
      ['public', schema],
      schema,
      // Provisioning claims no table or function of its own that is already there.
      [...(provision ? [] : [PREFIX]), ...NEIGHBOURS].map(like),
      provision ? [] : ['flag_immutable'],
    ],
  );
  if (result.rows.length !== 1 || Object.values(result.rows[0]).some((value) => value !== true)) throw new FlagStoreUnavailable();
}

const column = (name: string, type = 'text', collation: string | null = 'default', nullable = false) => ({
  name,
  type,
  collation,
  nullable,
  default: null,
});
const keyLayout = keyColumns.map((name) => column(name, 'text', 'C'));
const layouts = {
  binding: [
    column('singleton', 'integer', null),
    column('version', 'integer', null),
    column('suite_id', 'text', 'C'),
    column('deployment_id', 'text', 'C'),
  ],
  state: [...keyLayout, column('revision', 'bigint', null), column('snapshot')],
  audit: [
    ...keyLayout,
    column('revision', 'bigint', null),
    column('flag_id', 'text', 'C'),
    column('operation'),
    column('actor_id', 'text', 'C'),
    column('reason'),
    column('at'),
    column('revert_revision', 'bigint', null, true),
    column('before_snapshot'),
    column('after_snapshot'),
    column('decision_evidence', 'text', 'default', true),
  ],
};
const constraints: Record<keyof typeof layouts, string[]> = {
  binding: ['CHECK ((singleton = 1))', 'CHECK ((version = 1))', 'PRIMARY KEY (singleton)'],
  state: [
    "CHECK (((revision >= 0) AND (revision <= '9007199254740991'::bigint)))",
    `CHECK ((octet_length(snapshot) <= ${LIMIT}))`,
    `PRIMARY KEY (${keyColumns.join(', ')})`,
  ],
  audit: [
    "CHECK (((revision > 0) AND (revision <= '9007199254740991'::bigint)))",
    "CHECK ((operation = ANY (ARRAY['set'::text, 'kill'::text, 'revert'::text, 'decide'::text])))",
    `CHECK ((octet_length(before_snapshot) <= ${LIMIT}))`,
    `CHECK ((octet_length(after_snapshot) <= ${LIMIT}))`,
    `CHECK ((octet_length(decision_evidence) <= ${LIMIT}))`,
    "CHECK (((operation = 'decide'::text) = (decision_evidence IS NOT NULL)))",
    `PRIMARY KEY (${keyColumns.join(', ')}, revision)`,
  ],
};
const same = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
async function attest(client: Client, binding: FlagStoreBinding, writer = false): Promise<void> {
  await databaseOwner(client, false);
  // Hold relation locks throughout the operation. Concurrent ALTER/DROP must
  // wait, rather than swapping a checked layout before the write.
  // Writers also exclude CREATE/DISABLE TRIGGER (SHARE ROW EXCLUSIVE), while
  // remaining compatible with writers working on different scope rows.
  await client.query(`LOCK TABLE ${meta}, ${state}, ${audit} IN ${writer ? 'ROW EXCLUSIVE' : 'ACCESS SHARE'} MODE`);
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
  const expectedRelations = ['audit', 'audit_pkey', 'binding', 'binding_pkey', 'state', 'state_pkey'].map((name) => ({
    name: `${PREFIX}${name}`,
    kind: name.endsWith('_pkey') ? 'i' : 'r',
    owned: true,
    rls: false,
    forced: false,
    persistence: 'p',
  }));
  if (!same(relations, expectedRelations)) throw new FlagStoreUnavailable();
  // A suite's flag control may run as a role of its own, granted USAGE and CREATE on the schema by its owner.
  if ((await postgresRuntimeSchemaProblems(client as unknown as PgQuery, PREFIX, { delegated: true })).length)
    throw new FlagStoreUnavailable();
  for (const name of Object.keys(layouts) as Array<keyof typeof layouts>) {
    const relation = table(name);
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
    const checks = (
      await client.query(`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=$1::regclass`, [relation])
    ).rows
      .map((row) => row.definition)
      .sort();
    const indexes = (
      await client.query(`SELECT pg_get_indexdef(indexrelid) AS definition FROM pg_index WHERE indrelid=$1::regclass`, [relation])
    ).rows.map((row) => row.definition);
    const columnsInKey = name === 'binding' ? 'singleton' : [...keyColumns, ...(name === 'audit' ? ['revision'] : [])].join(', ');
    const expectedColumns = layouts[name];
    const expectedChecks = [...constraints[name]];
    if (
      !same(columns, expectedColumns) ||
      !same(checks, expectedChecks.sort()) ||
      !same(indexes, [`CREATE UNIQUE INDEX ${PREFIX}${name}_pkey ON ${relation} USING btree (${columnsInKey})`])
    )
      throw new FlagStoreUnavailable();
  }
  const extras = (
    await client.query(
      `SELECT
    (SELECT count(*)::integer FROM pg_policy WHERE polrelid IN ($1::regclass,$2::regclass,$3::regclass)) AS policies,
    (SELECT count(*)::integer FROM pg_rewrite WHERE ev_class IN ($1::regclass,$2::regclass,$3::regclass)) AS rules`,
      [meta, state, audit],
    )
  ).rows;
  if (!same(extras, [{ policies: 0, rules: 0 }])) throw new FlagStoreUnavailable();
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
      ['flag_audit', 'flag_binding'].map((relation) => ({
        relation,
        name: `${relation}_immutable`,
        type: 58,
        enabled: 'O',
        internal: false,
        function: true,
        arguments: 0,
        unconditional: true,
      })),
    )
  )
    throw new FlagStoreUnavailable();
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
        name: 'flag_immutable',
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
    throw new FlagStoreUnavailable();
  const types = (
    await client.query(
      `SELECT t.typname AS name FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
    WHERE n.nspname=$1 AND (lower(t.typname) LIKE $2 OR lower(t.typname) LIKE $3) ORDER BY t.typname COLLATE "C"`,
      [schema, like(PREFIX), like(`_${PREFIX}`)],
    )
  ).rows.map((row) => row.name);
  if (!same(types, ['_flag_audit', '_flag_binding', '_flag_state', 'flag_audit', 'flag_binding', 'flag_state']))
    throw new FlagStoreUnavailable();
  const rows = (await client.query(`SELECT singleton, version, suite_id, deployment_id FROM ${meta}`)).rows;
  if (!same(rows, [{ singleton: 1, version: POSTGRES_FLAG_STORE_VERSION, suite_id: binding.suiteId, deployment_id: binding.deploymentId }]))
    throw new FlagStoreUnavailable();
}

/** Open-time attestation that says which way the layout differs when the version row does (layoutRefusal.ts). */
async function attestSaying(client: Client, binding: FlagStoreBinding, writer = false): Promise<void> {
  try {
    await attest(client, binding, writer);
  } catch (error) {
    if (!(error instanceof FlagStoreUnavailable)) throw error;
    const found = await client.query(`SELECT version FROM ${meta}`).then(
      (result) => versionOfRows(result.rows),
      () => null,
    );
    const message = layoutRefusal('The flag store', found, POSTGRES_FLAG_STORE_VERSION);
    throw message === undefined ? error : new FlagStoreUnavailable(message);
  }
}

export async function provisionPostgresFlagStore(input: PostgresFlagStoreOptions): Promise<void> {
  const options = optionsOf(input);
  await withClient(options, (client) =>
    transaction(client, false, async () => {
      // Serialize explicit provisioning. Existing flag tables are always refused.
      const lock = createHash('sha256').update('mistri.flags.provision.v1').digest().readBigInt64BE().toString();
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lock]);
      await databaseOwner(client, true);
      await ensurePostgresRuntimeSchema(client as unknown as PgQuery);
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${meta} VALUES (1,1,$1,$2)`, [options.binding.suiteId, options.binding.deploymentId]);
      await attest(client, options.binding, true);
    }),
  );
}

function key(binding: FlagStoreBinding, scope: FlagScope): readonly string[] {
  // '' cannot be a tenant identifier, so it is an unambiguous null encoding.
  return [binding.suiteId, binding.deploymentId, scope.appId, scope.environment, scope.tenantId ?? ''];
}
function serialized(snapshot: FlagOverrideSnapshot): string {
  const value = JSON.stringify(snapshot);
  if (Buffer.byteLength(value) > LIMIT) throw new FlagStoreUnavailable();
  return value;
}
function snapshotOf(value: unknown, scope: FlagScope, catalog: FlagCatalog, revision: number): FlagOverrideSnapshot {
  if (typeof value !== 'string' || Buffer.byteLength(value) > LIMIT) throw new FlagStoreUnavailable();
  const snapshot = normalizeFlagSnapshot(JSON.parse(value), catalog);
  if (
    snapshot.appId !== scope.appId ||
    snapshot.environment !== scope.environment ||
    snapshot.tenantId !== scope.tenantId ||
    snapshot.revision !== revision
  )
    throw new FlagStoreUnavailable();
  return snapshot;
}
function revisionOf(value: unknown): number {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value)) throw new FlagStoreUnavailable();
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) throw new FlagStoreUnavailable();
  return revision;
}
function entryOf(row: Record<string, unknown>, scope: FlagScope, catalog: FlagCatalog): FlagHistoryEntry {
  const revision = revisionOf(row.revision);
  const before = snapshotOf(row.before_snapshot, scope, catalog, revision - 1),
    after = snapshotOf(row.after_snapshot, scope, catalog, revision);
  const entry = {
    scope,
    revision,
    flagId: row.flag_id,
    operation: row.operation,
    actorId: row.actor_id,
    reason: row.reason,
    at: row.at,
    revertRevision: row.revert_revision === null ? null : revisionOf(row.revert_revision),
    before,
    after,
  };
  const mutation = {
    scope,
    catalog,
    flagId: entry.flagId,
    actorId: entry.actorId,
    reason: entry.reason,
    expectedRevision: revision - 1,
    operation: entry.operation,
    ...(entry.operation === 'set' ? { override: after.overrides[String(entry.flagId)] } : {}),
    ...(entry.operation === 'decide' && typeof row.decision_evidence === 'string' && Buffer.byteLength(row.decision_evidence) <= LIMIT
      ? { evidence: JSON.parse(row.decision_evidence) }
      : {}),
    ...(entry.operation === 'revert' ? { revertRevision: entry.revertRevision } : {}),
  };
  const normalized = normalizeFlagStoreMutation(mutation);
  if (normalized.operation === 'decide') {
    if (!same(after.overrides[String(entry.flagId)], { value: normalized.evidence.winnerVariant })) throw new FlagStoreUnavailable();
  } else if (row.decision_evidence !== null) throw new FlagStoreUnavailable();
  if (
    typeof entry.at !== 'string' ||
    !Number.isFinite(Date.parse(entry.at)) ||
    new Date(entry.at).toISOString() !== entry.at ||
    (entry.operation !== 'revert' && entry.revertRevision !== null)
  )
    throw new FlagStoreUnavailable();
  return Object.freeze({ ...entry, ...(normalized.operation === 'decide' ? { evidence: normalized.evidence } : {}) }) as FlagHistoryEntry;
}

export async function openPostgresFlagStore(input: PostgresFlagStoreOptions): Promise<FlagStore> {
  const options = optionsOf(input);
  await withClient(options, (client) => transaction(client, true, () => attestSaying(client, options.binding)));
  let closed = false;
  const active = new Set<Promise<unknown>>();
  const run = <T>(readOnly: boolean, work: (client: Client) => Promise<T>, guard?: () => void | Promise<void>): Promise<T> => {
    if (closed) return Promise.reject(new FlagStoreUnavailable());
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
  return Object.freeze({
    binding: options.binding,
    read(inputScope, inputCatalog) {
      const scope = normalizeFlagScope(inputScope),
        catalog = normalizeFlagCatalog(inputCatalog);
      return run(true, async (client) => {
        const rows = (await client.query(`SELECT revision, snapshot FROM ${state} WHERE ${where}`, key(options.binding, scope))).rows;
        return rows.length
          ? snapshotOf(rows[0].snapshot, scope, catalog, revisionOf(rows[0].revision))
          : normalizeFlagSnapshot({ ...scope, revision: 0, overrides: {} }, catalog);
      });
    },
    readRequestScopes(inputScope, inputCatalog) {
      const scope = normalizeFlagScope(inputScope),
        catalog = normalizeFlagCatalog(inputCatalog);
      return run(true, async (client) => {
        const read = async (selected: FlagScope) => {
          const rows = (await client.query(`SELECT revision, snapshot FROM ${state} WHERE ${where}`, key(options.binding, selected))).rows;
          return rows.length
            ? snapshotOf(rows[0].snapshot, selected, catalog, revisionOf(rows[0].revision))
            : normalizeFlagSnapshot({ ...selected, revision: 0, overrides: {} }, catalog);
        };
        // run(true) owns a single REPEATABLE READ transaction, including both
        // reads and catalog attestation. Never replace this with two read()s.
        const global = await read({ ...scope, tenantId: null });
        const tenant = scope.tenantId === null ? null : await read(scope);
        return Object.freeze({ global, tenant });
      });
    },
    history(inputScope, inputCatalog, inputQuery) {
      const scope = normalizeFlagScope(inputScope),
        catalog = normalizeFlagCatalog(inputCatalog),
        query = normalizeFlagHistoryQuery(inputQuery, catalog);
      return run(true, async (client) => {
        const rows = (
          await client.query(
            `SELECT * FROM ${audit} WHERE ${where} AND flag_id=$6 COLLATE "C" AND ($7::bigint IS NULL OR revision<$7)
          ORDER BY revision DESC LIMIT $8`,
            [...key(options.binding, scope), query.flagId, query.beforeRevision ?? null, query.limit + 1],
          )
        ).rows;
        const entries = rows.slice(0, query.limit).map((row) => entryOf(row, scope, catalog));
        return Object.freeze({
          entries: Object.freeze(entries),
          nextBeforeRevision: rows.length > query.limit ? entries.at(-1)!.revision : null,
        });
      });
    },
    mutate(inputChange, beforeCommit) {
      const change = normalizeFlagStoreMutation(inputChange),
        { scope, catalog, flagId } = change;
      if (typeof beforeCommit !== 'function') throw new FlagStoreUnavailable();
      return run(
        false,
        async (client) => {
          const values = key(options.binding, scope),
            empty = normalizeFlagSnapshot({ ...scope, revision: 0, overrides: {} }, catalog);
          await client.query(
            `INSERT INTO ${state} (${keyColumns.join(',')},revision,snapshot) VALUES ($1,$2,$3,$4,$5,0,$6)
          ON CONFLICT (${keyColumns.join(',')}) DO NOTHING`,
            [...values, serialized(empty)],
          );
          const row = (await client.query(`SELECT revision,snapshot FROM ${state} WHERE ${where} FOR UPDATE`, values)).rows[0];
          if (!row) throw new FlagStoreUnavailable();
          const revision = revisionOf(row.revision);
          if (revision !== change.expectedRevision) throw new FlagRevisionConflict();
          const before = snapshotOf(row.snapshot, scope, catalog, revision),
            overrides = { ...before.overrides };
          if (change.operation === 'set') overrides[flagId] = change.override;
          else if (change.operation === 'decide') overrides[flagId] = { value: change.evidence.winnerVariant };
          else if (change.operation === 'kill') overrides[flagId] = { ...overrides[flagId], disabled: true };
          else if (change.revertRevision === 0) delete overrides[flagId];
          else {
            if (change.revertRevision > revision) throw new FlagStoreUnavailable();
            const previous = (
              await client.query(`SELECT * FROM ${audit} WHERE ${where} AND flag_id=$6 COLLATE "C" AND revision=$7`, [
                ...values,
                flagId,
                change.revertRevision,
              ])
            ).rows;
            if (previous.length !== 1) throw new FlagStoreUnavailable();
            const restored = entryOf(previous[0], scope, catalog).after.overrides[flagId];
            if (restored) overrides[flagId] = restored;
            else delete overrides[flagId];
          }
          const after = normalizeFlagSnapshot({ ...scope, revision: revision + 1, overrides }, catalog);
          const beforeJson = serialized(before),
            afterJson = serialized(after);
          const updated = await client.query(`UPDATE ${state} SET revision=$6,snapshot=$7 WHERE ${where} AND revision=$8`, [
            ...values,
            after.revision,
            afterJson,
            revision,
          ]);
          if (updated.rowCount !== 1) throw new FlagRevisionConflict();
          const inserted = (
            await client.query(
              `INSERT INTO ${audit} (${keyColumns.join(',')},revision,flag_id,operation,actor_id,reason,at,revert_revision,before_snapshot,after_snapshot,decision_evidence)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),$11,$12,$13,$14) RETURNING *`,
              [
                ...values,
                after.revision,
                flagId,
                change.operation,
                change.actorId,
                change.reason,
                change.operation === 'revert' ? change.revertRevision : null,
                beforeJson,
                afterJson,
                change.operation === 'decide' ? JSON.stringify(change.evidence) : null,
              ],
            )
          ).rows[0];
          return entryOf(inserted, scope, catalog);
        },
        beforeCommit,
      );
    },
    async close() {
      closed = true;
      await Promise.allSettled([...active]);
    },
  } satisfies FlagStore);
}
