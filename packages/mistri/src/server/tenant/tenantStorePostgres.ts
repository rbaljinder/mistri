/**
 * The tenant store on PostgreSQL. Maintenance migrates it explicitly; the
 * PostgreSQL tenant sources (tenantReadSource.ts, tenantWriteSource.ts)
 * attest and read it, and fence every business write with it.
 *
 * Same logical layout, names and reserved prefix as the SQLite store
 * (tenantStore.ts), in the business database's runtime schema (runtimeTables.ts), beside the
 * command journal: the App catalog hides runtime state by the unqualified
 * `__mistri_` prefix (shared/runtimeTables.ts), and scoped command
 * transactions refuse it as a target, so one rule covers both engines.
 * The contract — binding, change shapes, CAS revisions, terminal states and
 * the refusal of anything unexpected with one opaque TenantContextError — is
 * tenantStoreContract.ts, shared with SQLite, not a copy.
 *
 * What is different, and why:
 *
 * - Attestation compares a catalog description (columns with types,
 *   collations and defaults, every constraint and index, no triggers, rules,
 *   row security or policies) with the pinned one, the way the PostgreSQL
 *   command journal does, and then requires the tables to be this role's
 *   alone: owned by it or a role it inherits, with no privilege held by any
 *   other role, PUBLIC included. A role that could write the membership
 *   table could grant itself a tenant.
 * - Identity columns are `COLLATE "C"`, so equality, the live-membership
 *   unique index and discovery order are byte-exact whatever the database's
 *   default collation is — what `COLLATE BINARY` says on SQLite.
 * - The fence. SQLite's `BEGIN IMMEDIATE` excludes every other writer for the
 *   whole file, so a membership read on the writer is ordered against every
 *   revocation. PostgreSQL has no such fence, so it is made per tenant with
 *   row locks held to COMMIT: the business path takes the tenant row, then
 *   the membership row, `FOR SHARE`; every administrative change takes the
 *   tenant row `FOR UPDATE` first, then the membership row. `FOR UPDATE`
 *   conflicts with `FOR SHARE`, so whichever transaction locks the tenant row
 *   first commits first: a revocation waits for an in-flight business commit,
 *   and a business transaction waits for an in-flight revocation and then —
 *   READ COMMITTED takes a fresh snapshot per statement — reads it and
 *   refuses. One lock order (tenant, then membership) on both paths, and the
 *   business path takes no store lock after its business row locks, so the
 *   two cannot deadlock each other.
 * - The store is attested when an adapter first uses it, not in every
 *   transaction (postgresStoreFence.ts), and takes no table locks: the fence
 *   is the row locks above.
 * - `valid_until` is `bigint`; node-postgres returns int8 as a string, so it
 *   is read as `float8`, exact for the stored range (at most 2^53 - 1).
 * - Ill-formed UTF-16 (a lone surrogate) is refused. PostgreSQL would store
 *   it as U+FFFD, which would then compare equal to a genuine U+FFFD.
 */
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../../adapters/commands/postgresCommandJournal.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { attestOnce } from './postgresStoreFence.js';
import { captureTenantData, denyTenant, denyTenantFor, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  parseTenantSelector,
  type TenantMembershipEvidence,
  type TenantMembershipLookup,
  type TenantMembershipRecord,
} from './tenantMembership.js';
import {
  assertCurrentPlatformRecord,
  platformEvidenceQuery,
  platformLookup,
  platformMembershipRecord,
  PLATFORM_TENANT_ID,
  type PlatformMembershipEvidence,
  type PlatformMembershipLookup,
  type PlatformMembershipRecord,
} from './tenantPlatform.js';
import {
  assertCurrentRecord,
  binding,
  clock,
  evidenceQuery,
  lookup,
  membershipRecord,
  nextRevision,
  revision,
  roles,
  time,
  TENANT_STORE_PREFIX,
  TENANT_TABLES,
  TenantStoreOfAnotherApp,
  type IntakeAnchorEvidence,
  type MembershipChange,
  type PlatformChange,
  type PlatformMembershipChange,
  type TenantChange,
  type TenantMembershipGuard,
  type TenantMembershipListLookup,
  type TenantStoreAdministration,
  type TenantStoreBinding,
  denyAgain,
  denyLayout,
} from './tenantStoreContract.js';

/* As on SQLite (tenantStore.ts): a tenant row says its kind, one
   reserved `@platform` row anchors the platform realm's memberships, and a
   membership says its kind, with the support columns the support owner fills
   (tenantSupportTransaction.ts).
   Every member read takes tenant rows and member rows only. */
const POSTGRES_TENANT_STORE_VERSION = 1;
const tables = postgresRuntimeNames(TENANT_TABLES);
const LIVE_INDEX = `${TENANT_STORE_PREFIX}live_membership`;
const LIVE_SUPPORT_INDEX = `${TENANT_STORE_PREFIX}live_support`;
const PLATFORM_INDEX = `${TENANT_STORE_PREFIX}platform`;
const q = (name: string) => runtimeTable('postgres', name);
const SCHEMA = runtimeSchema('postgres');

import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { postgresRuntimeNames, runtimeName, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { postgresRuntimeSchemaProblems } from '@mistriwork/engine/adapters/postgresMaintenance.js';

export class TenantStoreUnavailable extends Refusal {
  constructor(
    message = 'The PostgreSQL tenant store is missing, is not the layout this version expects ' +
      `(reserved "${TENANT_STORE_PREFIX}*" tables in "${runtimeSchema('postgres')}", version ${POSTGRES_TENANT_STORE_VERSION}), or is bound to another App, ` +
      'source or store. migratePostgresTenantStore(url, binding) creates it once; an existing layout that differs is refused, not altered.',
  ) {
    super(message);
    this.name = 'TenantStoreUnavailable';
  }
}

const definitions: readonly string[] = [
  `CREATE TABLE ${q(tables.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${POSTGRES_TENANT_STORE_VERSION}),
  app_id text COLLATE "C" NOT NULL,
  source_id text COLLATE "C" NOT NULL,
  store_id text COLLATE "C" NOT NULL
)`,
  `CREATE TABLE ${q(tables.tenant)} (
  id text COLLATE "C" PRIMARY KEY,
  status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'suspended', 'closed')),
  version text COLLATE "C" NOT NULL,
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('tenant', 'platform')),
  CHECK ((kind = 'platform') = (id = '${PLATFORM_TENANT_ID}'))
)`,
  `CREATE TABLE ${q(tables.membership)} (
  id text COLLATE "C" PRIMARY KEY,
  tenant_id text COLLATE "C" NOT NULL REFERENCES ${q(tables.tenant)} (id) ON DELETE RESTRICT,
  account_id text COLLATE "C" NOT NULL,
  status text COLLATE "C" NOT NULL CHECK (status IN ('active', 'revoked', 'invited')),
  version text COLLATE "C" NOT NULL,
  roles_json text NOT NULL CHECK (octet_length(roles_json) <= 262144 AND json_typeof(roles_json::json) = 'array'),
  valid_until bigint NOT NULL CHECK (valid_until >= 0 AND valid_until <= 9007199254740991),
  kind text COLLATE "C" NOT NULL CHECK (kind IN ('member', 'support')),
  parent_id text COLLATE "C" REFERENCES ${q(tables.membership)} (id) ON DELETE RESTRICT,
  parent_version text COLLATE "C",
  platform_version text COLLATE "C",
  CHECK ((kind = 'support') = (parent_id IS NOT NULL AND parent_version IS NOT NULL AND platform_version IS NOT NULL)),
  CHECK (kind = 'member' OR status IN ('active', 'revoked'))
)`,
  `CREATE UNIQUE INDEX "${LIVE_INDEX}" ON ${q(tables.membership)} (tenant_id, account_id) WHERE status <> 'revoked' AND kind = 'member'`,
  `CREATE UNIQUE INDEX "${LIVE_SUPPORT_INDEX}" ON ${q(tables.membership)} (account_id) WHERE kind = 'support' AND status = 'active'`,
  `CREATE UNIQUE INDEX "${PLATFORM_INDEX}" ON ${q(tables.tenant)} (kind) WHERE kind = 'platform'`,
];

/* ---------- catalog description ---------- */

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Column = PostgresRelationDescription['columns'][number];
const column = (name: string, type: string, collation: string | null): Column => ({ name, type, notnull: true, collation, default: null });
const id = (name: string) => column(name, 'text', 'C');
const nullable = (name: string): Column => ({ ...id(name), notnull: false });
const table = (name: string, columns: Column[], constraints: string[], indexes: string[]): PostgresRelationDescription => ({
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
const pkey = (name: string, columns: string) => `CREATE UNIQUE INDEX ${name}_pkey ON ${SCHEMA}.${name} USING btree (${columns})`;

/* The description the DDL above produces, read back from a PostgreSQL 18
   catalog. Pinned rather than derived, so the attestation is of this layout
   and not of whatever is there. */
const layout: readonly PostgresRelationDescription[] = [
  table(
    tables.membership,
    [
      id('id'),
      id('tenant_id'),
      id('account_id'),
      id('status'),
      id('version'),
      column('roles_json', 'text', 'default'),
      column('valid_until', 'bigint', null),
      id('kind'),
      nullable('parent_id'),
      nullable('parent_version'),
      nullable('platform_version'),
    ],
    [
      `CHECK (((octet_length(roles_json) <= 262144) AND (json_typeof((roles_json)::json) = 'array'::text)))`,
      `CHECK (((valid_until >= 0) AND (valid_until <= '9007199254740991'::bigint)))`,
      `CHECK ((status = ANY (ARRAY['active'::text, 'revoked'::text, 'invited'::text])))`,
      `CHECK ((kind = ANY (ARRAY['member'::text, 'support'::text])))`,
      `CHECK (((kind = 'support'::text) = ((parent_id IS NOT NULL) AND (parent_version IS NOT NULL) AND (platform_version IS NOT NULL))))`,
      `CHECK (((kind = 'member'::text) OR (status = ANY (ARRAY['active'::text, 'revoked'::text]))))`,
      `FOREIGN KEY (tenant_id) REFERENCES ${tables.tenant}(id) ON DELETE RESTRICT`,
      `FOREIGN KEY (parent_id) REFERENCES ${tables.membership}(id) ON DELETE RESTRICT`,
      'PRIMARY KEY (id)',
    ],
    [
      pkey(tables.membership, 'id'),
      `CREATE UNIQUE INDEX ${LIVE_INDEX} ON ${SCHEMA}.${tables.membership} USING btree (tenant_id, account_id) WHERE ((status <> 'revoked'::text) AND (kind = 'member'::text))`,
      `CREATE UNIQUE INDEX ${LIVE_SUPPORT_INDEX} ON ${SCHEMA}.${tables.membership} USING btree (account_id) WHERE ((kind = 'support'::text) AND (status = 'active'::text))`,
    ],
  ),
  table(
    tables.meta,
    [column('singleton', 'integer', null), column('version', 'integer', null), id('app_id'), id('source_id'), id('store_id')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${POSTGRES_TENANT_STORE_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [pkey(tables.meta, 'singleton')],
  ),
  table(
    tables.tenant,
    [id('id'), id('status'), id('version'), id('kind')],
    [
      `CHECK ((status = ANY (ARRAY['active'::text, 'suspended'::text, 'closed'::text])))`,
      `CHECK ((kind = ANY (ARRAY['tenant'::text, 'platform'::text])))`,
      `CHECK (((kind = 'platform'::text) = (id = '${PLATFORM_TENANT_ID}'::text)))`,
      'PRIMARY KEY (id)',
    ],
    [
      pkey(tables.tenant, 'id'),
      `CREATE UNIQUE INDEX ${PLATFORM_INDEX} ON ${SCHEMA}.${tables.tenant} USING btree (kind) WHERE (kind = 'platform'::text)`,
    ],
  ),
].sort((a, b) => byCodeUnit(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

/** What makes the runtime schema, or the reserved relations under `prefix` in it, not solely
 * this role's, as sentences; empty when they are (adapters/postgresMaintenance.ts). */
export const reservedTableOwnershipProblems = (client: PgQuery, prefix: string): Promise<string[]> =>
  postgresRuntimeSchemaProblems(client, runtimeName('postgres', prefix));

/** A savepoint is the one statement that only works inside a transaction
 * block; row locks and pins outside one would release at once. */
async function assertPostgresTransaction(client: PgQuery): Promise<void> {
  await client.query('SAVEPOINT mistri_tenant_store');
  await client.query('RELEASE SAVEPOINT mistri_tenant_store');
}

async function isLayout(client: PgQuery, owner: TenantStoreBinding): Promise<boolean> {
  if (canonical(await describePostgresRelations(client, TENANT_STORE_PREFIX)) !== canonical(layout)) return false;
  const rows = (await client.query(`SELECT singleton, version, app_id, source_id, store_id FROM ${q(tables.meta)}`)).rows;
  if (rows.length === 1 && typeof rows[0].app_id === 'string' && rows[0].app_id !== owner.appId)
    throw new TenantStoreOfAnotherApp(rows[0].app_id, owner.appId);
  return rows.length === 1 && bound(owner)(rows[0]);
}
/* Clients a read snapshot has already attested the store on, with its
   relations locked ACCESS SHARE for the rest of that snapshot. Each is a
   wrapper made inside one snapshot and dropped with it, never the pooled
   client itself, so membership here cannot outlive the transaction that
   earned it. */
const attestedStores = new WeakSet<PgQuery>();

/**
 * A handle on a read snapshot whose store is already attested: the layout,
 * the meta row's binding and sole ownership, checked in this same
 * transaction (or proved unchanged there by the source's catalog
 * digest, adapters/postgresCatalogDigest.ts) after `LOCK ... IN ACCESS SHARE
 * MODE` on every store table. Reads through it skip repeating that
 * attestation; the membership rows themselves are still read every time.
 * Only a tenant read source calls this, inside the snapshot it attested.
 */
export function attestedPostgresTenantStore(client: PgQuery): PgQuery {
  const handle: PgQuery = Object.freeze({
    query: ((...args: unknown[]) => (client.query as (...values: unknown[]) => unknown)(...args)) as PgQuery['query'],
  });
  attestedStores.add(handle);
  return handle;
}

/* Attested in full when an adapter first uses it (postgresStoreFence.ts): what a fence reads after that is rows. */
const bound = (owner: TenantStoreBinding) => (row: Record<string, unknown>) =>
  row.singleton === 1 &&
  row.version === POSTGRES_TENANT_STORE_VERSION &&
  row.app_id === owner.appId &&
  row.source_id === owner.source.id &&
  row.store_id === owner.storeId;

async function attest(client: PgQuery, owner: TenantStoreBinding): Promise<void> {
  // A read snapshot's handle says it attested already.
  if (attestedStores.has(client)) return;
  return attestOnce(client, TENANT_STORE_PREFIX, canonical(owner), async () => {
    await assertPostgresTransaction(client);
    let layout: boolean;
    try {
      layout = await isLayout(client, owner);
    } catch (error) {
      return denyTenantFor(error);
    }
    if (!layout)
      return denyLayout(
        layoutRefusal('The PostgreSQL tenant store', await postgresLayoutVersion(client, q(tables.meta)), POSTGRES_TENANT_STORE_VERSION),
      );
    if ((await reservedTableOwnershipProblems(client, TENANT_STORE_PREFIX)).length) denyTenant();
  });
}

/** Attest inside the caller's transaction. Never creates or repairs. */
export async function assertPostgresTenantStore(client: PgQuery, input: TenantStoreBinding): Promise<void> {
  try {
    await attest(client, binding(input));
  } catch (error) {
    // Another App's store, or a layout from another mistri, stays the recorded cause, for the operator a startup refusal reports it to.
    denyAgain(error);
  }
}

/**
 * Explicit maintenance, never run when an App opens. Creates the layout when
 * no relation carries the prefix; is idempotent once the exact layout bound
 * to the same App, source and store is there; refuses anything else — another
 * version, a hand-made table, an extra index, another binding, a table another
 * role owns or may use — unchanged. Under the server-wide maintenance lock the
 * command journal and auth store migrations share.
 */
export async function migratePostgresTenantStore(
  url: string,
  input: TenantStoreBinding,
): Promise<{ version: typeof POSTGRES_TENANT_STORE_VERSION; migrated: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) throw new Refusal('Tenant store migration requires a postgres:// URL.');
  let owner: TenantStoreBinding;
  try {
    owner = binding(input);
  } catch {
    throw new Refusal('Tenant store migration requires a binding: { appId, source: { id, connection }, storeId }.');
  }
  return withPostgresMaintenanceTransaction(url, async (client) => {
    const migrated = (await describePostgresRelations(client, TENANT_STORE_PREFIX)).length === 0;
    if (migrated) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(tables.meta)} (singleton, version, app_id, source_id, store_id) VALUES (1, $1, $2, $3, $4)`, [
        POSTGRES_TENANT_STORE_VERSION,
        owner.appId,
        owner.source.id,
        owner.storeId,
      ]);
    }
    if (!(await isLayout(client, owner)))
      throw new TenantStoreUnavailable(
        layoutRefusal('The PostgreSQL tenant store', await postgresLayoutVersion(client, q(tables.meta)), POSTGRES_TENANT_STORE_VERSION),
      );
    const problems = await reservedTableOwnershipProblems(client, TENANT_STORE_PREFIX);
    if (problems.length) {
      throw new TenantStoreUnavailable(
        `The PostgreSQL tenant store is refused, not altered: ${problems.join('; ')}. ` +
          'Its tables must be owned by the connecting role, or a role whose privileges it inherits, and no other role, ' +
          `PUBLIC included, may hold a privilege on them (check ALTER DEFAULT PRIVILEGES in "${SCHEMA}").`,
      );
    }
    return { version: POSTGRES_TENANT_STORE_VERSION, migrated };
  });
}

/* ---------- reads and the fence ---------- */

const wellFormed = (...values: readonly string[]) => {
  if (values.some((value) => /\p{Cs}/u.test(value))) denyTenant();
};

function record(owner: TenantStoreBinding, accountId: string, tenantId: string, row: Record<string, unknown>): TenantMembershipRecord {
  return membershipRecord(owner, accountId, tenantId, row);
}

/** Unlocked read on the caller's snapshot: the read path's counterpart of
 * `readSqliteTenantMembershipSnapshot`. Neither starts nor ends a transaction. */
export async function readPostgresTenantMembership(
  client: PgQuery,
  input: TenantStoreBinding,
  inputLookup: TenantMembershipLookup,
): Promise<TenantMembershipRecord | null> {
  try {
    const owner = binding(input),
      query = lookup(inputLookup, owner);
    wellFormed(query.accountId);
    await attest(client, owner);
    const rows = (
      await client.query(
        `SELECT t.status AS tenant_status, t.version AS tenant_version,
        m.id, m.status, m.version, m.roles_json, m.valid_until::float8 AS valid_until
      FROM ${q(tables.tenant)} AS t JOIN ${q(tables.membership)} AS m ON m.tenant_id = t.id
      WHERE t.id = $1 AND t.kind = 'tenant' AND m.account_id = $2 AND m.kind = 'member' AND m.status <> 'revoked'`,
        [query.tenantId, query.accountId],
      )
    ).rows;
    if (rows.length > 1) return denyTenant();
    return rows[0] ? record(owner, query.accountId, query.tenantId, rows[0]) : null;
    // A refusal stays one; a database that failed to answer is a fault.
  } catch (error) {
    return denyTenantFor(error);
  }
}

/** The read path's revalidation on the caller's snapshot, the counterpart of
 * `assertSqliteTenantMembershipSnapshot`: samples the clock, then attests the
 * store and rereads the evidence's tenant and membership, unlocked. A read-only
 * snapshot cannot take row locks, and needs none: the reader releases only what
 * this same snapshot showed. Never starts or ends a transaction; grants nothing. */
export async function assertPostgresTenantMembershipSnapshot(
  client: PgQuery,
  input: TenantStoreBinding,
  evidence: TenantMembershipEvidence,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = evidenceQuery(value, owner);
    wellFormed(query.accountId, value.membershipId, ...value.roles);
    const instant = clock(now);
    assertCurrentRecord(value, await readPostgresTenantMembership(client, owner, query), instant);
  } catch (error) {
    denyTenantFor(error);
  }
}

/** Complete bounded discovery on the caller's snapshot, in exact byte order. */
export async function readPostgresTenantMemberships(
  client: PgQuery,
  input: TenantStoreBinding,
  inputLookup: TenantMembershipListLookup,
  now: () => number = Date.now,
): Promise<readonly TenantMembershipRecord[]> {
  try {
    const owner = binding(input),
      query = captureTenantData(inputLookup);
    tenantRecord(query, ['appId', 'accountId', 'source', 'deployment']);
    lookup({ ...query, tenantId: 'discovery' }, owner);
    wellFormed(query.accountId);
    const instant = clock(now);
    await attest(client, owner);
    const rows = (
      await client.query(
        `SELECT t.id AS tenant_id, t.status AS tenant_status, t.version AS tenant_version,
        m.id, m.status, m.version, m.roles_json, m.valid_until::float8 AS valid_until
      FROM ${q(tables.tenant)} AS t JOIN ${q(tables.membership)} AS m ON m.tenant_id = t.id
      WHERE m.account_id = $1 AND t.kind = 'tenant' AND m.kind = 'member'
        AND t.status = 'active' AND m.status = 'active' AND m.valid_until > $2
      ORDER BY t.id LIMIT 257`,
        [query.accountId, instant],
      )
    ).rows;
    if (rows.length > 256) return denyTenant();
    const result = rows.map((row) => {
      if (typeof row.tenant_id !== 'string') return denyTenant();
      return record(owner, query.accountId, row.tenant_id, row);
    });
    const completed = clock(now);
    if (completed < instant || result.some((entry) => completed >= entry.validUntil)) return denyTenant();
    return captureTenantData(result);
  } catch {
    return denyTenant();
  }
}

/** The tenant row, then the membership row, each `FOR SHARE` and held to the
 * end of the caller's transaction. Separate statements, so the lock order is
 * fixed and the membership read takes a snapshot after the tenant lock. */
const TENANT_LOCKED = `SELECT status, version FROM ${q(tables.tenant)} WHERE id = $1 AND kind = 'tenant' FOR SHARE`;
const MEMBER_LOCKED = `SELECT id, status, version, roles_json, valid_until::float8 AS valid_until
    FROM ${q(tables.membership)} WHERE tenant_id = $1 AND account_id = $2 AND kind = 'member' AND status <> 'revoked' FOR SHARE`;

async function lockedRead(
  client: PgQuery,
  owner: TenantStoreBinding,
  query: TenantMembershipLookup,
): Promise<TenantMembershipRecord | null> {
  const tenant = (await client.query(TENANT_LOCKED, [query.tenantId])).rows;
  if (tenant.length !== 1) return null;
  const member = (await client.query(MEMBER_LOCKED, [query.tenantId, query.accountId])).rows;
  if (member.length > 1) return denyTenant();
  if (!member[0]) return null;
  return record(owner, query.accountId, query.tenantId, {
    ...member[0],
    tenant_status: tenant[0].status,
    tenant_version: tenant[0].version,
  });
}

/**
 * The membership fence, for the owner of a business transaction on the same
 * client (`PostgresAdapter.scopeVerifiedTransaction` and its command variant
 * hand it the writer). Attests the store (once per adapter), samples the clock, then
 * locks and rereads the evidence's tenant and membership. Admission-time
 * evidence that no longer matches — revoked, re-granted, role-changed,
 * suspended, closed or expired — refuses. Never starts, commits or ends the
 * transaction, and grants nothing.
 */
export async function assertPostgresTenantMembershipFence(
  client: PgQuery,
  input: TenantStoreBinding,
  evidence: TenantMembershipEvidence,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = evidenceQuery(value, owner);
    wellFormed(query.accountId, value.membershipId, ...value.roles);
    await attest(client, owner);
    const instant = clock(now);
    assertCurrentRecord(value, await lockedRead(client, owner, query), instant);
  } catch (error) {
    denyTenantFor(error);
  }
}

/**
 * What the membership fence sends on a writer whose store this transaction
 * keeps attested (tenantWriteSource.ts), exactly and in its order — the
 * tenant row, then the membership row, FOR SHARE —
 * so they can leave behind the transaction's BEGIN (writeAhead.ts). Sent in
 * that order, one after another on the one connection, the membership is
 * still read after the tenant row is locked. The fence still judges every
 * answer; nothing for evidence it would refuse.
 */
export function postgresTenantMembershipFenceAhead(
  input: TenantStoreBinding,
  evidence: TenantMembershipEvidence,
): readonly (string | { text: string; values: readonly unknown[] })[] {
  try {
    const query = evidenceQuery(captureTenantData(evidence), binding(input));
    return [
      { text: TENANT_LOCKED, values: [query.tenantId] },
      { text: MEMBER_LOCKED, values: [query.tenantId, query.accountId] },
    ];
  } catch {
    return [];
  }
}

/* ---------- the platform realm ---------- */

/** The `@platform` row, then the account's membership in it: the tenant
 * fence's order on the platform realm's anchor. Locked FOR SHARE on the
 * writer, unlocked on a read snapshot, where two statements see one state. */
async function platformRead(
  client: PgQuery,
  owner: TenantStoreBinding,
  query: PlatformMembershipLookup,
  lock: boolean,
): Promise<PlatformMembershipRecord | null> {
  /* Unlocked, the anchor and the membership are one statement, on one
     snapshot either way. Locked, they stay two: the fence's lock order is the
     anchor, then the membership, and `FOR SHARE` cannot reach the nullable
     side of the join that would make them one. */
  if (!lock) {
    const rows = (
      await client.query(
        `SELECT p.status AS platform_status, p.version AS platform_version,
        m.id, m.status, m.version, m.roles_json, m.valid_until::float8 AS valid_until
      FROM ${q(tables.tenant)} AS p LEFT JOIN ${q(tables.membership)} AS m
        ON m.tenant_id = p.id AND m.account_id = $2 AND m.kind = 'member' AND m.status <> 'revoked'
      WHERE p.id = $1 AND p.kind = 'platform'`,
        [PLATFORM_TENANT_ID, query.accountId],
      )
    ).rows;
    if (rows.length > 1) return denyTenant();
    if (!rows[0] || rows[0].id === null) return null;
    const { platform_status, platform_version, ...member } = rows[0];
    return platformMembershipRecord(owner, query.accountId, { ...member, platform_status, platform_version });
  }
  const platform = (
    await client.query(`SELECT status, version FROM ${q(tables.tenant)} WHERE id = $1 AND kind = 'platform'${lock ? ' FOR SHARE' : ''}`, [
      PLATFORM_TENANT_ID,
    ])
  ).rows;
  if (platform.length !== 1) return null;
  const member = (
    await client.query(
      `SELECT id, status, version, roles_json, valid_until::float8 AS valid_until
    FROM ${q(tables.membership)} WHERE tenant_id = $1 AND account_id = $2 AND kind = 'member' AND status <> 'revoked'${lock ? ' FOR SHARE' : ''}`,
      [PLATFORM_TENANT_ID, query.accountId],
    )
  ).rows;
  if (member.length > 1) return denyTenant();
  if (!member[0]) return null;
  return platformMembershipRecord(owner, query.accountId, {
    ...member[0],
    platform_status: platform[0].status,
    platform_version: platform[0].version,
  });
}

/** Unlocked read on the caller's snapshot: the platform twin of readPostgresTenantMembership. */
export async function readPostgresPlatformMembership(
  client: PgQuery,
  input: TenantStoreBinding,
  inputLookup: PlatformMembershipLookup,
): Promise<PlatformMembershipRecord | null> {
  try {
    const owner = binding(input),
      query = platformLookup(inputLookup, owner);
    wellFormed(query.accountId);
    await attest(client, owner);
    return await platformRead(client, owner, query, false);
  } catch {
    return denyTenant();
  }
}

/** The read path's platform revalidation on the caller's snapshot, unlocked:
 * the same membership and `@platform` version, both still active. */
export async function assertPostgresPlatformMembershipSnapshot(
  client: PgQuery,
  input: TenantStoreBinding,
  evidence: PlatformMembershipEvidence,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = platformEvidenceQuery(value, owner);
    wellFormed(query.accountId, value.membershipId, ...value.roles);
    const instant = clock(now);
    assertCurrentPlatformRecord(value, await readPostgresPlatformMembership(client, owner, query), instant);
  } catch {
    denyTenant();
  }
}

/**
 * The platform membership fence for a platform command's writer:
 * attests the store (once per adapter), samples the clock, then locks the `@platform` row and the
 * membership FOR SHARE, held to COMMIT. Platform administration takes the
 * `@platform` row FOR UPDATE first, so a revocation and an in-flight platform
 * command order exactly as a tenant's do; the two realms' anchors are distinct
 * rows, so neither fence waits on the other.
 */
export async function assertPostgresPlatformMembershipFence(
  client: PgQuery,
  input: TenantStoreBinding,
  evidence: PlatformMembershipEvidence,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    const query = platformEvidenceQuery(value, owner);
    wellFormed(query.accountId, value.membershipId, ...value.roles);
    await attest(client, owner);
    const instant = clock(now);
    assertCurrentPlatformRecord(value, await platformRead(client, owner, query, true), instant);
  } catch {
    denyTenant();
  }
}

/* ---------- public intake ---------- */

/** A tenant's row, or `@platform` for the platform's own triage, when active:
 * FOR SHARE on the writer, the membership fence's first lock and order, so a
 * suspension waits for an in-flight submission or refuses it. */
async function intakeAnchor(client: PgQuery, tenantId: string, lock: boolean): Promise<string | null> {
  const platform = tenantId === PLATFORM_TENANT_ID;
  if (!platform) parseTenantSelector([tenantId]);
  const rows = (
    await client.query(`SELECT status, version FROM ${q(tables.tenant)} WHERE id = $1 AND kind = $2${lock ? ' FOR SHARE' : ''}`, [
      tenantId,
      platform ? 'platform' : 'tenant',
    ])
  ).rows;
  if (rows.length !== 1 || rows[0].status !== 'active') return null;
  revision(rows[0].version);
  return rows[0].version as string;
}

/** The tenants active on the caller's snapshot, by id, in code-unit order:
 * whom a job at times per tenant runs for. Each run is admitted again on its
 * own tenant's row, so this list is a plan, never authority. */
export async function readPostgresActiveTenants(client: PgQuery, input: TenantStoreBinding): Promise<readonly string[]> {
  try {
    const owner = binding(input);
    await attest(client, owner);
    const rows = (
      await client.query(`SELECT id FROM ${q(tables.tenant)} WHERE kind = 'tenant' AND status = 'active' ORDER BY id COLLATE "C"`)
    ).rows;
    return Object.freeze(rows.map((row) => parseTenantSelector([row.id as string])));
  } catch {
    return denyTenant();
  }
}

/** The anchor's current version on the caller's snapshot, unlocked, or null
 * when it is missing, suspended or closed. */
export async function readPostgresIntakeAnchor(client: PgQuery, input: TenantStoreBinding, tenantId: string): Promise<string | null> {
  try {
    const owner = binding(input);
    await attest(client, owner);
    return await intakeAnchor(client, tenantId, false);
  } catch {
    return denyTenant();
  }
}

/** The writer's intake fence: attests the store (once per adapter), samples the clock,
 * then locks the anchor FOR SHARE, held to COMMIT, at the resolved version —
 * for a tenant's submission its row, then `@platform`, the tenant fence's
 * first lock and then the platform fence's. No administration locks both. */
export async function assertPostgresIntakeAnchorFence(
  client: PgQuery,
  input: TenantStoreBinding,
  evidence: IntakeAnchorEvidence,
  now: () => number = Date.now,
): Promise<void> {
  try {
    const owner = binding(input),
      value = captureTenantData(evidence);
    revision(value.tenantVersion);
    revision(value.platformVersion);
    time(value.verifiedAt);
    time(value.validUntil);
    const platform = value.tenantId === PLATFORM_TENANT_ID;
    if (platform && value.platformVersion !== value.tenantVersion) denyTenant();
    await attest(client, owner);
    const instant = clock(now);
    if (
      (await intakeAnchor(client, value.tenantId, true)) !== value.tenantVersion ||
      (!platform && (await intakeAnchor(client, PLATFORM_TENANT_ID, true)) !== value.platformVersion) ||
      instant < value.verifiedAt ||
      instant >= value.validUntil
    )
      denyTenant();
  } catch {
    denyTenant();
  }
}

/* ---------- administration and the guard ---------- */

function queued<T>(operations: TransactionOperations, input: T, work: (captured: T) => Promise<void>): Promise<void> {
  let captured: T,
    invalid = false;
  try {
    captured = captureTenantData(input);
  } catch {
    invalid = true;
  }
  return operations.run(async () => {
    try {
      if (invalid) return denyTenant();
      await work(captured!);
    } catch {
      return denyTenant();
    }
  });
}
const one = (result: { rowCount?: number | null }) => {
  if (result.rowCount !== 1) denyTenant();
};

/** The trusted maintenance capability on the owner's open transaction and
 * queue, with the SQLite store's exact CAS and terminal-state rules. The owner
 * must drain operations before COMMIT/ROLLBACK and discard the facade. */
export function createPostgresTenantAdministration(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
): TenantStoreAdministration {
  const owner = binding(input);
  if (!client || typeof client.query !== 'function' || (assertActive !== undefined && typeof assertActive !== 'function'))
    return denyTenant();
  const active = () => {
    if (!assertActive) return;
    const result = assertActive() as unknown;
    if (result instanceof Promise) void result.catch(() => {});
    if (result !== undefined) denyTenant();
  };
  // One anchor row, a tenant's or the platform's: the same version protocol.
  const putAnchor = async (id: string, kind: 'tenant' | 'platform', status: string, expectedVersion: string | null) => {
    if (!['active', 'suspended', 'closed'].includes(status)) return denyTenant();
    if (expectedVersion !== null) revision(expectedVersion);
    await attest(client, owner);
    const previous = (await client.query(`SELECT status, version, kind FROM ${q(tables.tenant)} WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (expectedVersion === null) {
      if (previous || status !== 'active') return denyTenant();
      one(await client.query(`INSERT INTO ${q(tables.tenant)} (id, status, version, kind) VALUES ($1, $2, '1', $3)`, [id, status, kind]));
    } else {
      if (!previous || previous.kind !== kind || previous.status === 'closed' || previous.version !== expectedVersion) return denyTenant();
      one(
        await client.query(`UPDATE ${q(tables.tenant)} SET status = $1, version = $2 WHERE id = $3 AND kind = $4`, [
          status,
          nextRevision(expectedVersion),
          id,
          kind,
        ]),
      );
    }
  };
  // One ordinary membership, in a tenant or in the platform realm: the same
  // protocol. Support memberships are the support owner's
  // (tenantSupportTransaction.ts); none are written here.
  const putMember = async (anchorId: string, kind: 'tenant' | 'platform', value: Omit<MembershipChange, 'tenantId'>) => {
    tenantIdentifier(value.accountId, 1024);
    tenantIdentifier(value.membershipId, 1024);
    roles(value.roles);
    time(value.validUntil);
    wellFormed(value.accountId, value.membershipId, ...value.roles);
    if (!['active', 'revoked', 'invited'].includes(value.status)) return denyTenant();
    if (value.expectedVersion !== null) revision(value.expectedVersion);
    await attest(client, owner);
    // The anchor row first, FOR UPDATE: the lock order the fence shares.
    const anchor = (await client.query(`SELECT status FROM ${q(tables.tenant)} WHERE id = $1 AND kind = $2 FOR UPDATE`, [anchorId, kind]))
      .rows[0];
    if (!anchor || (anchor.status !== 'active' && value.status !== 'revoked')) return denyTenant();
    const previous = (
      await client.query(
        `SELECT tenant_id, account_id, status, version FROM ${q(tables.membership)}
      WHERE id = $1 AND kind = 'member' FOR UPDATE`,
        [value.membershipId],
      )
    ).rows[0];
    const json = JSON.stringify(value.roles);
    if (value.expectedVersion === null) {
      if (previous || value.status === 'revoked') return denyTenant();
      one(
        await client.query(
          `INSERT INTO ${q(tables.membership)} (id, tenant_id, account_id, status, version, roles_json, valid_until, kind)
        VALUES ($1, $2, $3, $4, '1', $5, $6, 'member')`,
          [value.membershipId, anchorId, value.accountId, value.status, json, value.validUntil],
        ),
      );
    } else {
      if (
        !previous ||
        previous.status === 'revoked' ||
        previous.tenant_id !== anchorId ||
        previous.account_id !== value.accountId ||
        previous.version !== value.expectedVersion ||
        (previous.status === 'active' && value.status === 'invited')
      )
        return denyTenant();
      one(
        await client.query(
          `UPDATE ${q(tables.membership)} SET status = $1, version = $2, roles_json = $3, valid_until = $4
        WHERE id = $5 AND kind = 'member'`,
          [value.status, nextRevision(value.expectedVersion), json, value.validUntil, value.membershipId],
        ),
      );
    }
  };
  return Object.freeze({
    putTenant(change: TenantChange): Promise<void> {
      return queued(operations, change, async (value) => {
        active();
        tenantRecord(value, ['tenantId', 'status', 'expectedVersion']);
        parseTenantSelector([value.tenantId]);
        await putAnchor(value.tenantId, 'tenant', value.status, value.expectedVersion);
        active();
      });
    },
    putMembership(change: MembershipChange): Promise<void> {
      return queued(operations, change, async (value) => {
        active();
        tenantRecord(value, ['tenantId', 'accountId', 'membershipId', 'status', 'roles', 'validUntil', 'expectedVersion']);
        parseTenantSelector([value.tenantId]);
        await putMember(value.tenantId, 'tenant', value);
        active();
      });
    },
    putPlatform(change: PlatformChange): Promise<void> {
      return queued(operations, change, async (value) => {
        active();
        tenantRecord(value, ['status', 'expectedVersion']);
        await putAnchor(PLATFORM_TENANT_ID, 'platform', value.status, value.expectedVersion);
        active();
      });
    },
    putPlatformMembership(change: PlatformMembershipChange): Promise<void> {
      return queued(operations, change, async (value) => {
        active();
        tenantRecord(value, ['accountId', 'membershipId', 'status', 'roles', 'validUntil', 'expectedVersion']);
        await putMember(PLATFORM_TENANT_ID, 'platform', value);
        active();
      });
    },
  });
}

/** Same-writer revalidation on the owner's transaction and queue, as the
 * SQLite guard: the fence above, queued behind the transaction's other work. */
export function createPostgresTenantMembershipGuard(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  now: () => number = Date.now,
): TenantMembershipGuard {
  const owner = binding(input);
  if (!client || typeof client.query !== 'function' || typeof now !== 'function') return denyTenant();
  return Object.freeze({
    assertCurrent(evidence: TenantMembershipEvidence): Promise<void> {
      return queued(operations, evidence, (value) => assertPostgresTenantMembershipFence(client, owner, value, now));
    },
    assertPlatformCurrent(evidence: PlatformMembershipEvidence): Promise<void> {
      return queued(operations, evidence, (value) => assertPostgresPlatformMembershipFence(client, owner, value, now));
    },
  });
}
