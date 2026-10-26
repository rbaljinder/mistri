/**
 * The tenant switch on PostgreSQL: its layout, its attestation, and the steps
 * the assistant and decision stores take inside their own provisioning (they
 * share one table, so neither provisions it alone). Attested as the
 * assistant's is: the catalog description compared with the one provisioning
 * produces.
 */
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { canonicalCommandJson } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../commands/postgresCommandJournal.js';
import { TENANT_SWITCH_LIMITS, TENANT_SWITCH_PREFIX, TENANT_SWITCH_TABLES, TENANT_SWITCH_VERSION } from './tenantSwitch.js';

const { meta, tenant } = postgresRuntimeNames(TENANT_SWITCH_TABLES);
const q = (name: string) => runtimeTable('postgres', name);

const definitions: readonly string[] = [
  `CREATE TABLE ${q(meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${TENANT_SWITCH_VERSION})
)`,
  `CREATE TABLE ${q(tenant)} (
  app text COLLATE "C" NOT NULL CHECK (octet_length(app) <= ${TENANT_SWITCH_LIMITS.app}),
  tenant text COLLATE "C" NOT NULL CHECK (octet_length(tenant) <= ${TENANT_SWITCH_LIMITS.tenant}),
  feature text COLLATE "C" NOT NULL CHECK (octet_length(feature) <= ${TENANT_SWITCH_LIMITS.feature}),
  enabled integer NOT NULL CHECK (enabled IN (0, 1)),
  consent text NOT NULL CHECK (octet_length(consent) <= ${TENANT_SWITCH_LIMITS.consent}),
  changed_at text NOT NULL,
  PRIMARY KEY (app, tenant, feature)
)`,
];

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (name: string, type: string, collation: string | null = null): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  notnull: true,
  collation,
  default: null,
});
const table = (
  name: string,
  columns: PostgresRelationDescription['columns'],
  constraints: string[],
  indexes: string[],
): PostgresRelationDescription => ({
  schema: runtimeSchema('postgres'),
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

/* What the DDL above reads back as, pinned so the attestation is of this layout, in the catalog's name order. */
const LAYOUT: readonly PostgresRelationDescription[] = [
  table(
    meta,
    [column('singleton', 'integer'), column('version', 'integer')],
    ['CHECK ((singleton = 1))', `CHECK ((version = ${TENANT_SWITCH_VERSION}))`, 'PRIMARY KEY (singleton)'],
    [`CREATE UNIQUE INDEX ${meta}_pkey ON ${runtimeSchema('postgres')}.${meta} USING btree (singleton)`],
  ),
  table(
    tenant,
    [
      column('app', 'text', 'C'),
      column('tenant', 'text', 'C'),
      column('feature', 'text', 'C'),
      column('enabled', 'integer'),
      column('consent', 'text', 'default'),
      column('changed_at', 'text', 'default'),
    ],
    [
      `CHECK ((octet_length(app) <= ${TENANT_SWITCH_LIMITS.app}))`,
      `CHECK ((octet_length(consent) <= ${TENANT_SWITCH_LIMITS.consent}))`,
      'CHECK ((enabled = ANY (ARRAY[0, 1])))',
      `CHECK ((octet_length(feature) <= ${TENANT_SWITCH_LIMITS.feature}))`,
      `CHECK ((octet_length(tenant) <= ${TENANT_SWITCH_LIMITS.tenant}))`,
      'PRIMARY KEY (app, tenant, feature)',
    ],
    [`CREATE UNIQUE INDEX ${tenant}_pkey ON ${runtimeSchema('postgres')}.${tenant} USING btree (app, tenant, feature)`],
  ),
].sort((a, b) => byCodeUnit(a.name, b.name));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);
const sortedDescription = (relations: PostgresRelationDescription[]) =>
  relations
    .map((relation) => ({
      ...relation,
      constraints: [...relation.constraints].sort(byCodeUnit),
      indexes: [...relation.indexes].sort(byCodeUnit),
    }))
    .sort((a, b) => byCodeUnit(a.name, b.name));

/** Whether the reserved relations are exactly this version's layout. */
export async function postgresTenantSwitchReady(client: PgQuery): Promise<boolean> {
  try {
    const actual = sortedDescription(await describePostgresRelations(client, TENANT_SWITCH_PREFIX));
    if (canonical(actual) !== canonical(LAYOUT)) return false;
    const rows = (await client.query(`SELECT singleton, version FROM ${q(meta)}`)).rows;
    return rows.length === 1 && rows[0].singleton === 1 && rows[0].version === TENANT_SWITCH_VERSION;
  } catch {
    return false;
  }
}

/**
 * Inside the caller's maintenance transaction: creates the store where none
 * is there, changes nothing where it is, and refuses anything else. Returns
 * whether this call made it.
 */
export async function provisionPostgresTenantSwitch(client: PgQuery): Promise<boolean> {
  let provisioned = false;
  if (!(await describePostgresRelations(client, TENANT_SWITCH_PREFIX)).length) {
    for (const ddl of definitions) await client.query(ddl);
    await client.query(`INSERT INTO ${q(meta)} (singleton, version) VALUES (1, $1)`, [TENANT_SWITCH_VERSION]);
    provisioned = true;
  }
  if (!(await postgresTenantSwitchReady(client)))
    throw new Refusal(
      layoutRefusal('The tenant switch store', await postgresLayoutVersion(client, q(meta)), TENANT_SWITCH_VERSION) ??
        'The tenant switch store is not the layout this version expects.',
    );
  return provisioned;
}

/** Explicit maintenance for the store on its own, under the shared migration lock. */
export async function provisionPostgresTenantSwitchAt(
  url: string,
): Promise<{ version: typeof TENANT_SWITCH_VERSION; provisioned: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Tenant switch store provisioning requires a postgres:// URL.');
  return withPostgresMaintenanceTransaction(url, async (client) => ({
    version: TENANT_SWITCH_VERSION,
    provisioned: await provisionPostgresTenantSwitch(client),
  }));
}
