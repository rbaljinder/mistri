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
import type { AuthStoreReads } from './authStoreReads.js';

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

/** What a session observation reads of its row and its account, instants as epoch milliseconds. */
type ObservedSession = Readonly<{
  userId: unknown;
  expiresAt: unknown;
  createdAt: unknown;
  impersonatedBy: unknown;
  banned: unknown;
}>;

/** Where a session's observed row is kept among the store's reads. */
export const observedSessionKey = (sessionId: string) => `session-row:${sessionId}`;

/**
 * The row a session observation would read, from what Better Auth's own read
 * of the session and its account returned, or undefined where that does not
 * say all of it. Kept beside that read (auth.ts), so the observations that
 * follow it in a request cost nothing: they are the same rows, read once.
 */
export function observedSessionOf(
  session: Record<string, unknown> | undefined,
  user: Record<string, unknown> | undefined,
): ObservedSession | undefined {
  if (!session || !user) return undefined;
  const expiresAt = instantOf(session.expiresAt),
    createdAt = instantOf(session.createdAt);
  if (!Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(createdAt)) return undefined;
  if (session.impersonatedBy === undefined || user.banned === undefined || typeof session.userId !== 'string') return undefined;
  return Object.freeze({ userId: session.userId, expiresAt, createdAt, impersonatedBy: session.impersonatedBy, banned: user.banned });
}

/** The binding's observations on a PostgreSQL store, by the rules the file
 * store's synchronous reads apply: a session's row read on the store's own
 * pool, or kept from a read of it a moment ago (authStoreReads.ts says how
 * long, and what drops it); the account lookups always fresh.
 * A lone surrogate is refused, since PostgreSQL would match it as U+FFFD. */
export function postgresObserver(pool: PgQuery, reads?: AuthStoreReads): StoreObserver {
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
      const load = async (): Promise<ObservedSession | undefined> => {
        const found = (
          await pool.query(
            `SELECT s."userId", ${epoch('s."expiresAt"')} AS "expiresAt", ${epoch('s."createdAt"')} AS "createdAt", s."impersonatedBy", u.banned
        FROM ${sessions} s JOIN ${accounts} u ON u.id = s."userId" WHERE s.id = $1`,
            [proof.sessionId],
          )
        ).rows[0];
        return found
          ? Object.freeze({
              userId: found.userId,
              expiresAt: found.expiresAt,
              createdAt: found.createdAt,
              impersonatedBy: found.impersonatedBy,
              banned: found.banned,
            })
          : undefined;
      };
      // A missing row is never kept: an ended session is refused by a fresh read every time.
      const row = reads ? await reads.read(observedSessionKey(proof.sessionId), load, { keep: Boolean }) : await load();
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
