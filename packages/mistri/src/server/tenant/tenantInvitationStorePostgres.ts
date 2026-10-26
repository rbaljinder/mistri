/** Private PG invitation storage. Enrollment/auth refusal remains unchanged.
 * The pinned layout was verified against this module's DDL in an owned native
 * PostgreSQL fixture; it is never learned from deployment tables. */
import { isPromise, isProxy } from 'node:util/types';
import type { TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../../adapters/commands/postgresCommandJournal.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { assertPostgresTenantAdministrationJournal } from './tenantAdministrationJournalPostgres.js';
import { reservedTableOwnershipProblems } from './tenantStorePostgres.js';
import { attestOnce } from './postgresStoreFence.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { TenantStoreBinding } from './tenantStore.js';
import { denyAgain, denyLayout } from './tenantStoreContract.js';
import { INVITATION_TABLES } from './tenantInvitationStore.js';
import {
  captureStoredTenantInvitation,
  decodeInvitationRow,
  invitationBinding,
  invitationColumns,
  invitationFields,
  invitationRowValues,
  type StoredTenantInvitation,
} from './tenantInvitationStoreContract.js';
import { invitationUuid, invitationRevision, planInvitationTransition } from './tenantInvitationTransition.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

const prefix = '__mistri_invitation_';
const tables = postgresRuntimeNames(INVITATION_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
const bounded = (name: string, max: number) => `${name} text COLLATE "C" NOT NULL CHECK (octet_length(${name}) BETWEEN 1 AND ${max})`;
const revision = (name: string) => `${bounded(name, 128)} CHECK (${name} ~ '^[1-9][0-9]*$')`;
const time = (name: string) => `${name} bigint NOT NULL CHECK (${name} BETWEEN 0 AND 9007199254740991)`;
const widths: Readonly<Record<string, number>> = {
  invitation_id: 36,
  version: 128,
  tenant_id: 128,
  membership_id: 36,
  account_id: 1024,
  inviter_id: 1024,
  issuance_operation: 17,
  roles_json: 262144,
  expected_tenant_version: 128,
  policy_id: 256,
  policy_version: 256,
  status: 8,
  digest: 64,
};

// Exported privately for the owned native catalog test, not package authoring.
export const postgresInvitationDefinitions = Object.freeze([
  `CREATE TABLE ${q(tables.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = 1),
  ${bounded('app_id', 1024)}, ${bounded('source_id', 256)}, ${bounded('store_id', 1024)}
)`,
  `CREATE TABLE ${q(tables.invitation)} (
  ${bounded('invitation_id', 36)} PRIMARY KEY,
  ${revision('version')}, ${bounded('tenant_id', 128)},
  ${bounded('membership_id', 36)} UNIQUE,
  ${bounded('account_id', 1024)}, ${bounded('inviter_id', 1024)},
  ${bounded('issuance_operation', 17)} CHECK (issuance_operation IN ('issueInvitation', 'reissueInvitation')),
  ${bounded('roles_json', 262144)} CHECK (json_typeof(roles_json::json) = 'array' AND json_array_length(roles_json::json) BETWEEN 1 AND 256),
  ${revision('expected_tenant_version')}, ${bounded('policy_id', 256)}, ${bounded('policy_version', 256)},
  ${time('created_at')}, ${time('redeem_until')}, ${time('valid_until')},
  ${bounded('status', 8)} CHECK (status IN ('pending', 'accepted', 'revoked')),
  ${bounded('digest', 64)} CHECK (octet_length(digest) = 64 AND digest ~ '^[0-9a-f]{64}$'),
  CHECK (created_at < redeem_until AND redeem_until <= valid_until)
)`,
  // A tenant's pending invitations, in id order, are what listing and the pending ceiling read.
  `CREATE INDEX "${tables.invitation}_tenant" ON ${q(tables.invitation)} (tenant_id, status, invitation_id)`,
]);

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const column = (name: string, type: string, collation: string | null): PostgresRelationDescription['columns'][number] => ({
  name,
  type,
  collation,
  notnull: true,
  default: null,
});
const size = (name: string, max: number) => `CHECK (((octet_length(${name}) >= 1) AND (octet_length(${name}) <= ${max})))`;
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
  constraints: constraints.sort(byCode),
  indexes: indexes.sort(byCode),
  triggers: 0,
  rules: 0,
  policies: 0,
});
const pkey = (name: string, key: string) => `CREATE UNIQUE INDEX ${name}_pkey ON ${runtimeSchema('postgres')}.${name} USING btree (${key})`;
/** Pinned spellings verified from code-owned DDL, not an encountered target.
 * No enrollment/public capability consumes this module. */
export const postgresInvitationLayout = [
  table(
    tables.meta,
    [
      column('singleton', 'integer', null),
      column('version', 'integer', null),
      ...['app_id', 'source_id', 'store_id'].map((name) => column(name, 'text', 'C')),
    ],
    [
      'PRIMARY KEY (singleton)',
      'CHECK ((singleton = 1))',
      'CHECK ((version = 1))',
      size('app_id', 1024),
      size('source_id', 256),
      size('store_id', 1024),
    ],
    [pkey(tables.meta, 'singleton')],
  ),
  table(
    tables.invitation,
    invitationColumns.map((name) => column(name, name in widths ? 'text' : 'bigint', name in widths ? 'C' : null)),
    [
      ...Object.entries(widths).map(([name, max]) => size(name, max)),
      'PRIMARY KEY (invitation_id)',
      'UNIQUE (membership_id)',
      "CHECK ((version ~ '^[1-9][0-9]*$'::text))",
      "CHECK ((expected_tenant_version ~ '^[1-9][0-9]*$'::text))",
      "CHECK ((issuance_operation = ANY (ARRAY['issueInvitation'::text, 'reissueInvitation'::text])))",
      "CHECK (((json_typeof((roles_json)::json) = 'array'::text) AND ((json_array_length((roles_json)::json) >= 1) AND (json_array_length((roles_json)::json) <= 256))))",
      ...['created_at', 'redeem_until', 'valid_until'].map(
        (name) => `CHECK (((${name} >= 0) AND (${name} <= '9007199254740991'::bigint)))`,
      ),
      "CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'revoked'::text])))",
      "CHECK (((octet_length(digest) = 64) AND (digest ~ '^[0-9a-f]{64}$'::text)))",
      'CHECK (((created_at < redeem_until) AND (redeem_until <= valid_until)))',
    ],
    [
      pkey(tables.invitation, 'invitation_id'),
      `CREATE UNIQUE INDEX ${tables.invitation}_membership_id_key ON ${runtimeSchema('postgres')}.${tables.invitation} USING btree (membership_id)`,
      `CREATE INDEX ${tables.invitation}_tenant ON ${runtimeSchema('postgres')}.${tables.invitation} USING btree (tenant_id, status, invitation_id)`,
    ],
  ),
].sort((a, b) => byCode(a.name, b.name));
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
freeze(postgresInvitationLayout);
const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

async function layoutMatches(client: PgQuery, owner: TenantStoreBinding): Promise<boolean> {
  if (canonical(await describePostgresRelations(client, prefix)) !== canonical(postgresInvitationLayout)) return false;
  const rows = (await client.query(`SELECT singleton,version,app_id,source_id,store_id FROM ${q(tables.meta)}`)).rows;
  return (
    rows.length === 1 &&
    rows[0].singleton === 1 &&
    rows[0].version === 1 &&
    rows[0].app_id === owner.appId &&
    rows[0].source_id === owner.source.id &&
    rows[0].store_id === owner.storeId
  );
}
/* Attested in full when an adapter first uses it, after the administration journal (postgresStoreFence.ts). */
async function attest(client: PgQuery, owner: TenantStoreBinding): Promise<void> {
  await assertPostgresTenantAdministrationJournal(client, owner);
  await attestOnce(client, prefix, canonical(owner), async () => {
    if (!(await layoutMatches(client, owner)))
      return denyLayout(layoutRefusal('The PostgreSQL tenant invitation store', await postgresLayoutVersion(client, q(tables.meta)), 1));
    if ((await reservedTableOwnershipProblems(client, prefix)).length) denyTenant();
  });
}
export async function assertPostgresTenantInvitations(client: PgQuery, input: TenantStoreBinding): Promise<void> {
  try {
    await attest(client, invitationBinding(input));
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit maintenance only; existing partial/wrong layouts are never altered. */
export async function migratePostgresTenantInvitations(url: string, input: TenantStoreBinding): Promise<{ version: 1; migrated: boolean }> {
  try {
    if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url)) return denyTenant();
    const owner = invitationBinding(input);
    return await withPostgresMaintenanceTransaction(url, async (client) => {
      await assertPostgresTenantAdministrationJournal(client, owner);
      const migrated = (await describePostgresRelations(client, prefix)).length === 0;
      if (migrated) {
        for (const ddl of postgresInvitationDefinitions) await client.query(ddl);
        await client.query(`INSERT INTO ${q(tables.meta)}(singleton,version,app_id,source_id,store_id) VALUES(1,1,$1,$2,$3)`, [
          owner.appId,
          owner.source.id,
          owner.storeId,
        ]);
      }
      await attest(client, owner);
      return { version: 1, migrated };
    });
  } catch {
    return denyTenant();
  }
}

/** Borrowed owner transaction only. Membership linkage and auth remain the
 * owner's entry/final fences, never inferred from an invitation row. */
export function createPostgresTenantInvitations(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
) {
  const owner = invitationBinding(input);
  if (
    !client ||
    isProxy(client) ||
    typeof client.query !== 'function' ||
    (assertActive !== undefined && (typeof assertActive !== 'function' || isProxy(assertActive)))
  )
    return denyTenant();
  const active = () => {
    if (!assertActive) return;
    const result = assertActive() as unknown;
    if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
    if (result !== undefined) denyTenant();
  };
  const verified = async () => {
    active();
    await attest(client, owner);
    active();
  };
  const invoke = <A, R>(input: A, work: (value: A) => Promise<R>): Promise<R> => {
    let value: A,
      invalid = false;
    try {
      value = captureTenantData(input);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          await verified();
          const result = await work(value!);
          await verified();
          return result;
        } catch (error) {
          return denyAgain(error);
        }
      })
      .catch((error) => denyAgain(error));
    void pending.catch(() => {});
    return pending;
  };
  const read = async (key: 'invitation_id' | 'membership_id', id: string) => {
    invitationUuid(id);
    const selected = invitationColumns
      .map(
        (name, index) =>
          `${name}${['created_at', 'redeem_until', 'valid_until'].includes(name) ? '::float8' : ''} AS "${invitationFields[index]}"`,
      )
      .join(',');
    const rows = (await client.query(`SELECT ${selected} FROM ${q(tables.invitation)} WHERE ${key}=$1`, [id])).rows;
    active();
    if (rows.length > 1) return denyTenant();
    const row = rows[0] ? decodeInvitationRow(rows[0]) : null;
    if (row && (key === 'invitation_id' ? row.invitationId : row.membershipId) !== id) return denyTenant();
    return row;
  };
  return Object.freeze({
    read: (id: string) => invoke(id, (value) => read('invitation_id', value)),
    forMembership: (id: string) => invoke(id, (value) => read('membership_id', value)),
    insert: (input: StoredTenantInvitation) =>
      invoke(input, async (value) => {
        const row = captureStoredTenantInvitation(value);
        if (row.status !== 'pending' || row.version !== '1') return denyTenant();
        const result = await client.query(
          `INSERT INTO ${q(tables.invitation)} (${invitationColumns.join(',')}) VALUES (${invitationColumns.map((_, index) => `$${index + 1}`).join(',')})`,
          [...invitationRowValues(row)],
        );
        active();
        if (result.rowCount !== 1) denyTenant();
      }),
    transition: (input: { invitationId: string; expectedVersion: string; status: 'accepted' | 'revoked' }) =>
      invoke(input, async (value) => {
        tenantRecord(value, ['invitationId', 'expectedVersion', 'status']);
        invitationUuid(value.invitationId);
        invitationRevision(value.expectedVersion);
        const row = await read('invitation_id', value.invitationId);
        const plan = planInvitationTransition(
          row && {
            invitationId: row.invitationId,
            version: row.version,
            status: row.status,
          },
          value,
        );
        const result = await client.query(
          `UPDATE ${q(tables.invitation)} SET status=$1,version=$2 WHERE invitation_id=$3 AND version=$4 AND status='pending'`,
          [plan.status, plan.nextVersion, plan.invitationId, plan.expectedVersion],
        );
        active();
        if (result.rowCount !== 1) denyTenant();
      }),
  });
}
