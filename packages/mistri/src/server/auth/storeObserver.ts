/**
 * How a native auth binding observes its store after Better Auth has answered: the account, its eligibility and
 * roles, and the session a proof names. The file store reads synchronously (auth.ts builds that observer beside the
 * database it opens); a PostgreSQL store is read here, fresh, on its own pool.
 */
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';
import { denyTenant, tenantIdentifier } from '@mistriwork/engine/server/evidence.js';
import type { VerifiedSessionInstance } from './auth.js';
import { readPostgresEligibleAccountRoles } from './nativeAccountObservation.js';

export type AccountRoles = Readonly<{ accountId: string; roles: readonly string[] }>;
/** How a binding reads its store: synchronously (the file) or not (PostgreSQL). */
export type StoreObserver =
  | {
      readonly synchronous: true;
      lookupAccount(accountId: string): Readonly<{ accountId: string }> | null;
      lookupEligibleAccount(accountId: string): Readonly<{ accountId: string }> | null;
      lookupEligibleAccountRoles(accountId: string): AccountRoles | null;
      checkSession(proof: VerifiedSessionInstance, expectedCreatedAt?: number): void;
    }
  | {
      readonly synchronous: false;
      lookupAccount(accountId: string): Promise<Readonly<{ accountId: string }> | null>;
      lookupEligibleAccount(accountId: string): Promise<Readonly<{ accountId: string }> | null>;
      lookupEligibleAccountRoles(accountId: string): Promise<AccountRoles | null>;
      checkSession(proof: VerifiedSessionInstance, expectedCreatedAt?: number): Promise<void>;
    };

/** An instant the store returned: a Date, or PostgreSQL's ISO text. The
 * PostgreSQL adapter keeps dates as text by replacing `pg`'s module-wide
 * parsers, and a postgres:// auth store's pool shares that module, so Better
 * Auth may hand either back. Anything else is not an instant. */
export function instantOf(value: unknown): number {
  if (value instanceof Date) return Date.prototype.getTime.call(value);
  if (typeof value !== 'string') return NaN;
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}(?::\d{2})?)$/.exec(value);
  if (!parts) return NaN;
  const [, date, time, fraction = '', zone] = parts;
  return Date.parse(`${date}T${time}${fraction.slice(0, 4)}${zone === 'Z' || zone.includes(':') ? zone : `${zone}:00`}`);
}

/** The binding's observations on a PostgreSQL store: read fresh on the store's
 * own pool, by the rules the file store's synchronous reads apply.
 * A lone surrogate is refused, since PostgreSQL would match it as U+FFFD. */
export function postgresObserver(pool: PgQuery): StoreObserver {
  const exact = (value: string) => {
    tenantIdentifier(value, 1024);
    if (/\p{Cs}/u.test(value)) denyTenant();
  };
  // Instants are computed as epoch milliseconds in SQL, whatever `pg` parses.
  const time = (value: unknown): number | null => (value === null ? null : typeof value === 'number' ? value : NaN);
  const epoch = (column: string) => `floor(extract(epoch FROM ${column}) * 1000)::float8`;
  const accounts = runtimeTable('postgres', 'auth_user'),
    sessions = runtimeTable('postgres', 'auth_session');
  return {
    synchronous: false,
    async lookupAccount(accountId) {
      exact(accountId);
      const row = (await pool.query(`SELECT id FROM ${accounts} WHERE id = $1`, [accountId])).rows[0];
      if (!row) return null;
      if (row.id !== accountId) return denyTenant();
      return { accountId };
    },
    async lookupEligibleAccount(accountId) {
      exact(accountId);
      const row = (
        await pool.query(`SELECT id, banned, ${epoch('"banExpires"')} AS "banExpires" FROM ${accounts} WHERE id = $1`, [accountId])
      ).rows[0];
      if (!row) return null;
      if (row.id !== accountId || (row.banned !== null && typeof row.banned !== 'boolean')) return denyTenant();
      if (row.banned !== true) return { accountId };
      // A ban expires strictly before now, as on the file store.
      const until = time(row.banExpires);
      if (until !== null && !Number.isSafeInteger(until)) return denyTenant();
      return until !== null && until < Date.now() ? { accountId } : null;
    },
    lookupEligibleAccountRoles: (accountId) => readPostgresEligibleAccountRoles(pool, accountId),
    async checkSession(proof, expectedCreatedAt) {
      exact(proof.sessionId);
      const row = (
        await pool.query(
          `SELECT s."userId", ${epoch('s."expiresAt"')} AS "expiresAt", ${epoch('s."createdAt"')} AS "createdAt", s."impersonatedBy", u.banned
        FROM ${sessions} s JOIN ${accounts} u ON u.id = s."userId" WHERE s.id = $1`,
          [proof.sessionId],
        )
      ).rows[0];
      if (!row || row.userId !== proof.identity.id || row.impersonatedBy !== null || (row.banned !== null && row.banned !== false))
        return denyTenant();
      const expiresAt = time(row.expiresAt);
      if (expectedCreatedAt !== undefined && time(row.createdAt) !== expectedCreatedAt) return denyTenant();
      // Shortened sessions require fresh admission; a refresh never extends the
      // already-issued proof.
      if (expiresAt === null || !Number.isSafeInteger(expiresAt) || expiresAt < proof.expiresAt || expiresAt <= Date.now()) denyTenant();
    },
  };
}
