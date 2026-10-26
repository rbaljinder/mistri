/**
 * A tenant App's API tokens, made by its own members (G54): the self-service
 * half of `mistri api-token`, on the lease a member already holds.
 *
 * A member asks on their tenant context, so who they are and where they stand
 * is the admitted membership the request carries, never a field they send:
 *
 * - **issue** binds the token to that one membership — its tenant, its id and
 *   its version — and to roles no wider than it holds (and the App's `api`
 *   allows), with an expiry of at most a year. The subject and the actor are
 *   the member. The secret is answered once and kept only as a digest.
 * - **list** answers the member's own tokens of this tenant. A tenant's
 *   administrator — a member whose role the administration policy lets end
 *   memberships (`revokeMembership`, by delegate rule or as a named operator
 *   of this tenant) — also sees the others', each no wider than their own
 *   roles. Nobody sees another tenant's.
 * - **revoke** ends one of those, under the same rule.
 *
 * The records are written by the operator CLI's own maintenance functions
 * (sqlite/postgresApiTokenMaintenance.ts) against the native auth store, each
 * in its own transaction, so the checks they make — an eligible native
 * account, roles within the membership's and the API's, operations within the
 * catalog — are made here exactly as there. Every API request then observes
 * the token again (tenantApiReadOwner.ts): a membership changed after issue
 * leaves the token without authority, never with more.
 */
import { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LoadedApp } from '../app/apps.js';
import { appAuthStore } from '../auth/auth.js';
import { isPostgresAuthStore } from '../auth/authStore.js';
import { SQLITE_API_TOKEN_TABLES } from '../../adapters/auth/sqliteApiTokenLayout.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { withPostgresMaintenanceTransaction } from '../../adapters/commands/postgresCommandJournal.js';
import { inspectSqliteApiToken, issueSqliteApiTenantToken, revokeSqliteApiToken } from '../auth/sqliteApiTokenMaintenance.js';
import { inspectPostgresApiToken, issuePostgresApiTenantToken, revokePostgresApiToken } from '../auth/postgresApiTokenMaintenance.js';
import { assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import type { AdministrationPolicy } from './tenantAdministrationModel.js';

type Catalog = Readonly<{ operations: readonly Readonly<{ id: string; eligibleRoles: readonly string[] }>[] }>;

/** What a member is told about a token: never its secret or digest. */
interface TenantTokenSummary {
  readonly id: string;
  readonly label: string;
  readonly roles: readonly string[];
  readonly operations: readonly string[] | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  /** True when the token's subject is the member asking. */
  readonly mine: boolean;
}

/** A request the service will not carry out: the status and a stable code, never a store's detail. */
export class TenantTokenRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'TenantTokenRefusal';
  }
}

const DAY = 86_400_000;
/** A member's token lives at most a year: a longer one is an operator's, issued with the CLI. */
const TENANT_TOKEN_MAX_DAYS = 366;

const refusal = (status: number, code: string, message: string): never => {
  throw new TenantTokenRefusal(status, code, message);
};

function names(value: unknown, what: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 256 || value.some((name) => typeof name !== 'string' || !name || name.length > 256))
    return refusal(400, 'invalid_input', `"${what}" is a list of names.`);
  return [...new Set(value as string[])];
}

export function createTenantTokenService(
  input: Readonly<{ loaded: LoadedApp; catalog: Catalog; now?: () => number; administration?: AdministrationPolicy }>,
) {
  const app = input.loaded.app;
  const api = app.api;
  if (!api || app.auth?.rows !== 'tenant') throw new Error('Tenant tokens need a tenant App with an `api` block.');
  const now = input.now ?? Date.now;
  const store = appAuthStore(input.loaded);
  const postgres = isPostgresAuthStore(store);
  const path = postgres ? '' : resolve(store);
  let storeId: string | undefined;

  /* The token store's id, read once from its metadata: the maintenance
     functions bind every write to it. An unprovisioned store is said so. */
  async function storeOf(): Promise<string> {
    if (storeId) return storeId;
    let id: unknown;
    try {
      if (postgres) {
        id = await withPostgresMaintenanceTransaction(store, async (client) => {
          const result = await client.query(`SELECT store_id FROM ${runtimeTable('postgres', 'auth_api_token_meta')}`);
          return result.rows.length === 1 ? result.rows[0].store_id : undefined;
        });
      } else {
        const uri = pathToFileURL(path);
        uri.searchParams.set('mode', 'ro');
        const db = new DatabaseSync(uri.href, { readOnly: true });
        try {
          const rows = db.prepare(`SELECT store_id FROM main."${SQLITE_API_TOKEN_TABLES.meta}"`).all();
          id = rows.length === 1 ? rows[0].store_id : undefined;
        } finally {
          db.close();
        }
      }
      assertApiTokenSecretId(id);
    } catch {
      return refusal(409, 'tokens_unprovisioned', 'This deployment keeps no API tokens yet: its operator provisions the store once.');
    }
    storeId = id;
    return id;
  }

  /* Every token of this App in one tenant, from the store's own rows. */
  async function rowsOf(tenantId: string): Promise<Array<Record<string, unknown>>> {
    const sql = (table: string, mark: (n: number) => string) =>
      `SELECT token_id, subject_kind, subject_id, label, roles_json, operations_json, created_at, expires_at, revoked_at
         FROM ${table} WHERE app_id = ${mark(1)} AND tenant_id = ${mark(2)} ORDER BY created_at DESC, token_id LIMIT 500`;
    try {
      if (postgres)
        return await withPostgresMaintenanceTransaction(store, async (client) => {
          const result = await client.query(
            sql(runtimeTable('postgres', 'auth_api_token'), (n) => `$${n}`),
            [app.id, tenantId],
          );
          return result.rows as Array<Record<string, unknown>>;
        });
      const uri = pathToFileURL(path);
      uri.searchParams.set('mode', 'ro');
      const db = new DatabaseSync(uri.href, { readOnly: true });
      try {
        return db.prepare(sql(`main."${SQLITE_API_TOKEN_TABLES.token}"`, () => '?')).all(app.id, tenantId) as Array<
          Record<string, unknown>
        >;
      } finally {
        db.close();
      }
    } catch {
      return refusal(503, 'tokens_unavailable', 'The token store could not be read.');
    }
  }

  const instant = (value: unknown) => new Date(Number(value)).toISOString();
  const within = (principal: TenantMembershipEvidence, roles: readonly string[]) => roles.every((role) => principal.roles.includes(role));
  /* Who may end someone's membership here may end their tokens: the tenant's
     administrator, as the administration policy names one. */
  const administers = (principal: TenantMembershipEvidence) =>
    !!input.administration &&
    ((input.administration.delegates ?? []).some(
      (rule) => rule.operations.includes('revokeMembership') && principal.roles.includes(rule.role),
    ) ||
      input.administration.operators.some(
        (operator) =>
          operator.accountId === principal.accountId &&
          operator.operations.includes('revokeMembership') &&
          operator.tenants.includes(principal.tenantId),
      ));
  /** A token this member may see and end: their own, or, for the tenant's
   * administrator, anyone's no wider than they are. */
  const reaches = (principal: TenantMembershipEvidence, token: { roles: readonly string[]; mine: boolean }) =>
    within(principal, token.roles) && (token.mine || administers(principal));

  function summary(principal: TenantMembershipEvidence, row: Record<string, unknown>): TenantTokenSummary {
    return Object.freeze({
      id: String(row.token_id),
      label: String(row.label),
      roles: JSON.parse(String(row.roles_json)) as string[],
      operations: row.operations_json == null ? null : (JSON.parse(String(row.operations_json)) as string[]),
      createdAt: instant(row.created_at),
      expiresAt: instant(row.expires_at),
      revokedAt: row.revoked_at == null ? null : instant(row.revoked_at),
      mine: row.subject_kind === 'account' && row.subject_id === principal.accountId,
    });
  }

  const tenantOf = (principal: TenantMembershipEvidence) =>
    Object.freeze({
      tenantId: principal.tenantId,
      membershipId: principal.membershipId,
      membershipVersion: principal.membershipVersion,
      roles: [...principal.roles],
    });

  return Object.freeze({
    /** What this member may put in a token: the API's roles they hold, and the operations those reach. */
    choices(principal: TenantMembershipEvidence) {
      const roles = api.roles.filter((role) => principal.roles.includes(role));
      return Object.freeze({
        roles,
        operations: input.catalog.operations
          .filter((operation) => operation.eligibleRoles.some((role) => roles.includes(role)))
          .map((o) => o.id),
        maxDays: TENANT_TOKEN_MAX_DAYS,
      });
    },

    async list(principal: TenantMembershipEvidence): Promise<TenantTokenSummary[]> {
      const rows = await rowsOf(principal.tenantId);
      return rows.map((row) => summary(principal, row)).filter((token) => reaches(principal, token));
    },

    async issue(principal: TenantMembershipEvidence, raw: Record<string, unknown>) {
      const label = typeof raw.label === 'string' ? raw.label.trim() : '';
      if (!label || label.length > 200) return refusal(400, 'invalid_input', 'A token needs a label of at most 200 characters.');
      const days = raw.days === undefined ? 90 : raw.days;
      if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1 || days > TENANT_TOKEN_MAX_DAYS)
        return refusal(400, 'invalid_input', `"days" is a whole number from 1 to ${TENANT_TOKEN_MAX_DAYS}.`);
      const offered = this.choices(principal);
      const roles = names(raw.roles, 'roles') ?? offered.roles;
      const operations = names(raw.operations, 'operations');
      // Never wider than the member: each role theirs and the API's.
      if (!roles.length || roles.some((role) => !offered.roles.includes(role)))
        return refusal(403, 'role_not_held', 'A token carries only roles you hold that the App API allows.');
      if (
        operations?.some(
          (id) =>
            !input.catalog.operations.some((operation) => operation.id === id && operation.eligibleRoles.some((r) => roles.includes(r))),
        )
      )
        return refusal(400, 'invalid_input', 'An operation is not one these roles can use.');
      const id = await storeOf();
      const options = {
        storeId: id,
        subjectId: principal.accountId,
        actorId: principal.accountId,
        roles,
        label,
        expiresAt: now() + days * DAY,
        tenant: tenantOf(principal),
        ...(operations === undefined ? {} : { operations }),
      };
      let issued: Readonly<{ token: string; tokenId: string }>;
      try {
        issued = postgres
          ? await issuePostgresApiTenantToken(store, app, input.catalog, { ...options, excludeConnections: [] }, now)
          : issueSqliteApiTenantToken(path, app, input.catalog, { ...options, exclusions: [] }, now());
      } catch {
        return refusal(503, 'tokens_unavailable', 'The token could not be issued; nothing was kept.');
      }
      return Object.freeze({ token: issued.token, id: issued.tokenId, expiresAt: new Date(options.expiresAt).toISOString() });
    },

    async revoke(principal: TenantMembershipEvidence, tokenId: unknown): Promise<void> {
      try {
        assertApiTokenSecretId(tokenId);
      } catch {
        return refusal(400, 'invalid_input', '"id" names a token.');
      }
      const id = await storeOf();
      const owner = { appId: app.id, storeId: id, tokenId };
      let found: Readonly<{
        record: {
          subject: { kind: string; id: string };
          tenant?: { tenantId: string };
          roles: readonly string[];
          revokedAt?: number;
        };
        version: string;
      }> | null;
      try {
        found = postgres
          ? await inspectPostgresApiToken(store, { ...owner, excludeConnections: [] })
          : inspectSqliteApiToken(path, { ...owner, exclusions: [] });
      } catch {
        return refusal(503, 'tokens_unavailable', 'The token store could not be read.');
      }
      // Another tenant's token, another member's (to anyone but the tenant's
      // administrator), or one wider than the member, is answered as no token at all.
      const mine = found?.record.subject.kind === 'account' && found.record.subject.id === principal.accountId;
      if (!found || found.record.tenant?.tenantId !== principal.tenantId || !reaches(principal, { roles: found.record.roles, mine }))
        return refusal(404, 'not_found', 'No such token.');
      if (found.record.revokedAt !== undefined) return;
      const revoke = { ...owner, expectedVersion: found.version, actorId: principal.accountId };
      try {
        if (postgres) await revokePostgresApiToken(store, { ...revoke, excludeConnections: [] }, now);
        else revokeSqliteApiToken(path, { ...revoke, exclusions: [] }, now());
      } catch {
        return refusal(503, 'tokens_unavailable', 'The token could not be revoked; ask again.');
      }
    },
  });
}
export type TenantTokenService = ReturnType<typeof createTenantTokenService>;
