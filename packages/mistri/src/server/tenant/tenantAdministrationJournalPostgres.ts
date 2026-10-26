/**
 * The tenant administration journal on PostgreSQL — maintenance API,
 * beside the PostgreSQL tenant store (tenantStorePostgres.ts); nothing on the
 * request path opens it yet.
 *
 * Same names, receipt and audit shapes and validation as the SQLite journal
 * (tenantAdministrationJournalContract.ts): one row per operation, its receipt
 * and its audit together, in the runtime schema under the reserved
 * `__mistri_admin_` prefix. Differences, and why:
 *
 * - Attestation is the store's: a pinned catalog description plus sole
 *   ownership by this role, and the tenant store itself is attested first,
 *   exactly as the SQLite journal attests the SQLite store.
 * - Duplicate attempts are serialised by a transaction-level advisory lock on
 *   the receipt scope, taken in `read` and `commit`, as the PostgreSQL command
 *   journal does. SQLite got this from `BEGIN IMMEDIATE`. Two connections
 *   running the same operation for the same actor, tenant and key queue, and
 *   the second reads the first's receipt; the unique constraint stays as the
 *   backstop for a commit without a read.
 * - `operation_version` is `bigint`, read back as `float8` (exact up to 2^53 - 1).
 */
import { createHash } from 'node:crypto';
import { isPromise, isProxy } from 'node:util/types';
import { Refusal, type TransactionOperations } from '@mistriwork/engine/adapters/adapter.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import {
  describePostgresRelations,
  withPostgresMaintenanceTransaction,
  type PostgresRelationDescription,
} from '../../adapters/commands/postgresCommandJournal.js';
import { canonicalCommandJson } from '../commands/commandPayload.js';
import { captureTenantData, denyTenant, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  ADMINISTRATION_JOURNAL_PREFIX,
  ADMINISTRATION_JOURNAL_TABLES,
  binding,
  receiptFields,
  scopeFields,
  scopeValues,
  validateAudit,
  validatePair,
  validateReceipt,
  type AdministrationAudit,
  type AdministrationReceiptScope,
  type StoredAdministrationReceipt,
  type TenantAdministrationJournal,
} from './tenantAdministrationJournalContract.js';
import { denyAgain, denyLayout, type TenantStoreBinding } from './tenantStoreContract.js';
import { assertPostgresTenantStore, reservedTableOwnershipProblems } from './tenantStorePostgres.js';
import { attestOnce } from './postgresStoreFence.js';

const POSTGRES_ADMINISTRATION_JOURNAL_VERSION = 1;
const tables = postgresRuntimeNames(ADMINISTRATION_JOURNAL_TABLES);
const q = (name: string) => runtimeTable('postgres', name);
const SCHEMA = runtimeSchema('postgres');
const SCOPE_KEY = `${tables.receipt}_scope`;

import { layoutRefusal, postgresLayoutVersion } from '@mistriwork/engine/adapters/layoutRefusal.js';
import { postgresRuntimeNames, runtimeSchema, runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

export class TenantAdministrationJournalUnavailable extends Refusal {
  constructor(
    message = 'The PostgreSQL tenant administration journal is missing, is not the layout this version expects ' +
      `(reserved "${ADMINISTRATION_JOURNAL_PREFIX}*" tables in "${runtimeSchema('postgres')}", version ${POSTGRES_ADMINISTRATION_JOURNAL_VERSION}), ` +
      'is bound to another App, source or store, or has no matching PostgreSQL tenant store. Run migratePostgresTenantStore(url, binding) ' +
      'and then migratePostgresTenantAdministrationJournal(url, binding); an existing layout that differs is refused, not altered.',
  ) {
    super(message);
    this.name = 'TenantAdministrationJournalUnavailable';
  }
}

/* The SQLite journal's identifier columns, byte-bounded the same way. */
const bounded = (name: string, maximum = 256) => `${name} text COLLATE "C" NOT NULL CHECK (octet_length(${name}) BETWEEN 1 AND ${maximum})`;
const definitions: readonly string[] = [
  `CREATE TABLE ${q(tables.meta)} (
  singleton integer PRIMARY KEY CHECK (singleton = 1),
  version integer NOT NULL CHECK (version = ${POSTGRES_ADMINISTRATION_JOURNAL_VERSION}),
  ${bounded('app_id', 1024)},
  ${bounded('source_id')},
  ${bounded('store_id', 1024)}
)`,
  `CREATE TABLE ${q(tables.receipt)} (
  ${bounded('id', 1024)} PRIMARY KEY,
  ${bounded('actor_id', 1024)},
  ${bounded('tenant_id', 128)},
  ${bounded('operation')},
  operation_version bigint NOT NULL CHECK (operation_version BETWEEN 1 AND 9007199254740991),
  ${bounded('idempotency_key')},
  ${bounded('fingerprint')},
  result_json text NOT NULL CHECK (octet_length(result_json) <= 16384 AND result_json::json IS NOT NULL),
  ${bounded('request_id', 1024)},
  ${bounded('completed_at', 32)},
  ${bounded('policy_id')},
  ${bounded('policy_version')},
  ${bounded('deployment')},
  ${bounded('session_id', 1024)},
  change_json text NOT NULL CHECK (octet_length(change_json) <= 65536 AND change_json::json IS NOT NULL),
  CONSTRAINT "${SCOPE_KEY}" UNIQUE (actor_id, tenant_id, operation, operation_version, idempotency_key)
)`,
];

/* ---------- catalog description (pinned, read back from PostgreSQL 18) ---------- */

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type Column = PostgresRelationDescription['columns'][number];
const column = (name: string, type: string, collation: string | null): Column => ({ name, type, notnull: true, collation, default: null });
const id = (name: string) => column(name, 'text', 'C');
const size = (name: string, maximum = 256) => `CHECK (((octet_length(${name}) >= 1) AND (octet_length(${name}) <= ${maximum})))`;
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
const layout: readonly PostgresRelationDescription[] = [
  table(
    tables.meta,
    [column('singleton', 'integer', null), column('version', 'integer', null), id('app_id'), id('source_id'), id('store_id')],
    [
      'CHECK ((singleton = 1))',
      `CHECK ((version = ${POSTGRES_ADMINISTRATION_JOURNAL_VERSION}))`,
      'PRIMARY KEY (singleton)',
      size('app_id', 1024),
      size('source_id'),
      size('store_id', 1024),
    ],
    [pkey(tables.meta, 'singleton')],
  ),
  table(
    tables.receipt,
    [
      id('id'),
      id('actor_id'),
      id('tenant_id'),
      id('operation'),
      column('operation_version', 'bigint', null),
      id('idempotency_key'),
      id('fingerprint'),
      column('result_json', 'text', 'default'),
      id('request_id'),
      id('completed_at'),
      id('policy_id'),
      id('policy_version'),
      id('deployment'),
      id('session_id'),
      column('change_json', 'text', 'default'),
    ],
    [
      size('id', 1024),
      size('actor_id', 1024),
      size('tenant_id', 128),
      size('operation'),
      size('idempotency_key'),
      size('fingerprint'),
      size('request_id', 1024),
      size('completed_at', 32),
      size('policy_id'),
      size('policy_version'),
      size('deployment'),
      size('session_id', 1024),
      'CHECK (((octet_length(change_json) <= 65536) AND ((change_json)::json IS NOT NULL)))',
      `CHECK (((operation_version >= 1) AND (operation_version <= '9007199254740991'::bigint)))`,
      'CHECK (((octet_length(result_json) <= 16384) AND ((result_json)::json IS NOT NULL)))',
      'PRIMARY KEY (id)',
      'UNIQUE (actor_id, tenant_id, operation, operation_version, idempotency_key)',
    ],
    [
      pkey(tables.receipt, 'id'),
      `CREATE UNIQUE INDEX ${SCOPE_KEY} ON ${SCHEMA}.${tables.receipt} USING btree (actor_id, tenant_id, operation, operation_version, idempotency_key)`,
    ],
  ),
].sort((a, b) => byCodeUnit(`${a.schema}.${a.name}`, `${b.schema}.${b.name}`));

const canonical = (value: unknown) => canonicalCommandJson(value, 1_048_576);

async function isLayout(client: PgQuery, owner: TenantStoreBinding): Promise<boolean> {
  if (canonical(await describePostgresRelations(client, ADMINISTRATION_JOURNAL_PREFIX)) !== canonical(layout)) return false;
  const rows = (await client.query(`SELECT singleton, version, app_id, source_id, store_id FROM ${q(tables.meta)}`)).rows;
  return rows.length === 1 && bound(owner)(rows[0]);
}
const bound = (owner: TenantStoreBinding) => (row: Record<string, unknown>) =>
  row.singleton === 1 &&
  row.version === POSTGRES_ADMINISTRATION_JOURNAL_VERSION &&
  row.app_id === owner.appId &&
  row.source_id === owner.source.id &&
  row.store_id === owner.storeId;
/* Attested in full when an adapter first uses it, after its tenant store (postgresStoreFence.ts). */
async function attest(client: PgQuery, owner: TenantStoreBinding): Promise<void> {
  await assertPostgresTenantStore(client, owner);
  await attestOnce(client, ADMINISTRATION_JOURNAL_PREFIX, canonical(owner), async () => {
    if (!(await isLayout(client, owner)))
      return denyLayout(
        layoutRefusal(
          'The PostgreSQL tenant administration journal',
          await postgresLayoutVersion(client, q(tables.meta)),
          POSTGRES_ADMINISTRATION_JOURNAL_VERSION,
        ),
      );
    if ((await reservedTableOwnershipProblems(client, ADMINISTRATION_JOURNAL_PREFIX)).length) denyTenant();
  });
}

/** Attest the journal (and its tenant store) inside the caller's transaction. */
export async function assertPostgresTenantAdministrationJournal(client: PgQuery, input: TenantStoreBinding): Promise<void> {
  try {
    await attest(client, binding(input));
  } catch (error) {
    denyAgain(error);
  }
}

/** Explicit maintenance after `migratePostgresTenantStore`: creates the
 * journal once, is idempotent on the exact layout and binding, and refuses
 * anything else unchanged, under the shared maintenance lock. */
export async function migratePostgresTenantAdministrationJournal(
  url: string,
  input: TenantStoreBinding,
): Promise<{ version: 1; migrated: boolean }> {
  if (typeof url !== 'string' || !/^postgres(ql)?:\/\//i.test(url))
    throw new Refusal('Administration journal migration requires a postgres:// URL.');
  let owner: TenantStoreBinding;
  try {
    owner = binding(input);
  } catch {
    throw new Refusal('Administration journal migration requires a binding: { appId, source: { id, connection }, storeId }.');
  }
  return withPostgresMaintenanceTransaction(url, async (client) => {
    try {
      await assertPostgresTenantStore(client, owner);
    } catch {
      throw new TenantAdministrationJournalUnavailable();
    }
    const migrated = (await describePostgresRelations(client, ADMINISTRATION_JOURNAL_PREFIX)).length === 0;
    if (migrated) {
      for (const ddl of definitions) await client.query(ddl);
      await client.query(`INSERT INTO ${q(tables.meta)} (singleton, version, app_id, source_id, store_id) VALUES (1, $1, $2, $3, $4)`, [
        POSTGRES_ADMINISTRATION_JOURNAL_VERSION,
        owner.appId,
        owner.source.id,
        owner.storeId,
      ]);
    }
    if (!(await isLayout(client, owner)))
      throw new TenantAdministrationJournalUnavailable(
        layoutRefusal(
          'The PostgreSQL tenant administration journal',
          await postgresLayoutVersion(client, q(tables.meta)),
          POSTGRES_ADMINISTRATION_JOURNAL_VERSION,
        ),
      );
    const problems = await reservedTableOwnershipProblems(client, ADMINISTRATION_JOURNAL_PREFIX);
    if (problems.length) {
      throw new TenantAdministrationJournalUnavailable(
        `The PostgreSQL tenant administration journal is refused, not altered: ${problems.join('; ')}. ` +
          'Its tables must be owned by the connecting role, or a role whose privileges it inherits, and no other role, PUBLIC included, may hold a privilege on them.',
      );
    }
    return { version: 1, migrated };
  });
}

/** The receipt scope's advisory-lock key, namespaced away from the command
 * journal's: the first eight bytes of a digest over the binding and the
 * exact uniqueness columns. */
function scopeLock(owner: TenantStoreBinding, values: readonly (string | number)[]): string {
  return createHash('sha256')
    .update(canonicalCommandJson(['mistri.tenant-administration', owner.appId, owner.source.id, owner.storeId, ...values]))
    .digest()
    .readBigInt64BE(0)
    .toString();
}

/** Owner-only composition on the owner's open transaction and queue, the
 * PostgreSQL counterpart of `createSqliteTenantAdministrationJournal`. */
export function createPostgresTenantAdministrationJournal(
  client: PgQuery,
  operations: TransactionOperations,
  input: TenantStoreBinding,
  assertActive?: () => void,
): TenantAdministrationJournal {
  const owner = binding(input);
  if (
    !client ||
    typeof client.query !== 'function' ||
    isProxy(client) ||
    (assertActive !== undefined && (typeof assertActive !== 'function' || isProxy(assertActive)))
  )
    return denyTenant();
  const verified = async () => {
    await attest(client, owner);
    if (assertActive) {
      const result = assertActive() as unknown;
      if (isPromise(result)) void Promise.prototype.then.call(result, undefined, () => {});
      if (result !== undefined) return denyTenant();
    }
  };
  const invoke = <A, R>(value: A, work: (captured: A) => Promise<R>): Promise<R> => {
    let captured: A,
      invalid = false;
    try {
      captured = captureTenantData(value);
    } catch {
      invalid = true;
    }
    const pending = operations
      .run(async () => {
        try {
          if (invalid) return denyTenant();
          await verified();
          const result = await work(captured!);
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
  return Object.freeze({
    read: (scope: AdministrationReceiptScope) =>
      invoke(scope, async (value) => {
        tenantRecord(value, scopeFields);
        const lookup = scopeValues(value);
        // Held to COMMIT/ROLLBACK: a duplicate on another connection waits here
        // and then reads on a snapshot that includes this attempt's receipt.
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [scopeLock(owner, lookup)]);
        const rows = (
          await client.query(
            `SELECT id, actor_id AS "actorId", tenant_id AS "tenantId", operation,
        operation_version::float8 AS "operationVersion", idempotency_key AS "idempotencyKey", fingerprint,
        result_json AS "resultJson", request_id AS "requestId", completed_at AS "completedAt",
        policy_id AS "policyId", policy_version AS "policyVersion", deployment, session_id AS "sessionId", change_json AS "changeJson"
        FROM ${q(tables.receipt)}
        WHERE actor_id = $1 AND tenant_id = $2 AND operation = $3 AND operation_version = $4 AND idempotency_key = $5`,
            [...lookup],
          )
        ).rows;
        if (rows.length > 1) return denyTenant();
        const row = rows[0];
        if (!row) return null;
        const receipt = Object.fromEntries(receiptFields.map((field) => [field, row[field]])) as unknown as StoredAdministrationReceipt;
        validateReceipt(receipt);
        const audit = {
          policyId: row.policyId,
          policyVersion: row.policyVersion,
          deployment: row.deployment,
          sessionId: row.sessionId,
          changeJson: row.changeJson,
        } as AdministrationAudit;
        validateAudit(audit);
        validatePair(receipt, audit);
        return Object.freeze(receipt);
      }),
    commit: (receipt: StoredAdministrationReceipt, audit: AdministrationAudit) =>
      invoke({ receipt, audit }, async ({ receipt, audit }) => {
        validateReceipt(receipt);
        validateAudit(audit);
        validatePair(receipt, audit);
        const scope = scopeValues(receipt);
        await client.query('SELECT pg_catalog.pg_advisory_xact_lock($1::bigint)', [scopeLock(owner, scope)]);
        const written = await client.query(
          `INSERT INTO ${q(tables.receipt)}
        (id, actor_id, tenant_id, operation, operation_version, idempotency_key, fingerprint, result_json, request_id, completed_at,
        policy_id, policy_version, deployment, session_id, change_json)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
          [
            receipt.id,
            ...scope,
            receipt.fingerprint,
            receipt.resultJson,
            receipt.requestId,
            receipt.completedAt,
            audit.policyId,
            audit.policyVersion,
            audit.deployment,
            audit.sessionId,
            audit.changeJson,
          ],
        );
        if (written.rowCount !== 1) denyTenant();
      }),
  });
}
