/**
 * Native accounts made on someone's behalf. Two callers do it: the operator's
 * `createAppAccounts` step (@mistriwork/mistri/maintenance) and an account-creating
 * invitation's claim. Both go through Better Auth's own user creation — the
 * admin plugin's createUser, called from the server with no request, as the
 * deployment's admin bootstrap already is — never through an insert into its
 * tables, so the password is hashed and the credential account linked exactly
 * as sign-up does.
 *
 * auth.ts registers every runtime it builds here, with the store it opened; a
 * runtime nobody registered has no account capability, so a structural
 * look-alike cannot create accounts. Nothing here logs, returns or keeps a
 * password, and no refusal repeats one.
 *
 * Each account made here is a row of the account trail (accountAudit.ts), in
 * the transaction Better Auth creates it in, as an administrator's are: made
 * by the operator's maintenance step, or by the invitation it claims.
 *
 * An email is compared lower-cased, as Better Auth stores it. The lookups are
 * private observations of the auth store, not an account directory: the only
 * callers are the operator's own step and a claim that already proved its
 * invitation token.
 */
import type { DatabaseSync } from 'node:sqlite';
import { runtimeTable } from '@mistriwork/engine/shared/runtimeTables.js';

/* The account table of a PostgreSQL store (postgresAuthStore.ts); the file keeps Better Auth's `user`. */
const ACCOUNTS = runtimeTable('postgres', 'auth_user');
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import { rolesOf } from '../../shared/accountAdministration.js';
import { profileName } from '../../shared/accountProfile.js';
import type { AccountAuditStore } from './accountAudit.js';
import type { AppAuthRuntime } from './auth.js';

export interface NativeAccountInput {
  readonly email: string;
  readonly name: string;
  readonly password: string;
}
interface NativeAccountRegistration {
  /** Better Auth's createUser, server-side. */
  readonly create: (body: Record<string, unknown>) => Promise<unknown>;
  /** The file store's handle, or the PostgreSQL store's pool. */
  readonly file?: DatabaseSync;
  readonly pool?: PgQuery;
  /** The store's account trail: a made account's row commits with it. */
  readonly audit: AccountAuditStore;
  readonly closed: () => boolean;
}

/** Who made an account on someone's behalf, as its row of the trail says:
 * the operator's maintenance step, or the invitation the account claims. */
type NativeAccountMaker = { readonly by: 'maintenance' } | { readonly by: 'invitation'; readonly invitationId: string };

/** Why an account was not made. `exists` is only ever said to a caller that
 * is entitled to know the address has an account (see the module comment). */
export class NativeAccountRefusal extends Error {
  constructor(readonly reason: 'invalid' | 'exists' | 'unavailable') {
    super(
      reason === 'invalid'
        ? 'The account details are not valid: an email address, a name of 1 to 120 characters and a password of 8 to 128.'
        : reason === 'exists'
          ? 'An account with this email address already exists.'
          : 'The account could not be created.',
    );
    this.name = 'NativeAccountRefusal';
  }
}

const registrations = new WeakMap<AppAuthRuntime, NativeAccountRegistration>();
const suiteObservations = new WeakMap<
  AppAuthRuntime,
  {
    source: AppAuthRuntime;
    eligible: (accountId: string) => boolean | Promise<boolean>;
    current: () => void;
  }
>();

/** A projected App can observe only accounts explicitly granted to that App.
 * This conveys no native account-creation or administration capability. */
export function registerSuiteAccountObservations(
  runtime: AppAuthRuntime,
  source: AppAuthRuntime,
  /** Asynchronous where the suite's grants are (PostgreSQL); awaited after every read of the native store either way. */
  eligible: (accountId: string) => boolean | Promise<boolean>,
  current: () => void,
): void {
  registered(source);
  if (registrations.has(runtime) || suiteObservations.has(runtime)) throw new NativeAccountRefusal('unavailable');
  suiteObservations.set(runtime, Object.freeze({ source, eligible, current }));
}

/** auth.ts's alone, once per runtime it builds. */
export function registerNativeAccounts(runtime: AppAuthRuntime, registration: NativeAccountRegistration): void {
  if (
    registrations.has(runtime) ||
    typeof registration.create !== 'function' ||
    typeof registration.audit?.transaction !== 'function' ||
    !registration.file === !registration.pool
  ) {
    throw new NativeAccountRefusal('unavailable');
  }
  registrations.set(runtime, Object.freeze({ ...registration }));
}
function registered(runtime: AppAuthRuntime): NativeAccountRegistration {
  const found = registrations.get(runtime);
  if (!found || found.closed()) throw new NativeAccountRefusal('unavailable');
  return found;
}

/* An address as Better Auth keeps it: lower-cased. Deliberately narrower than
   the RFC — no quoted local parts, no IP literals — and never longer than a
   deliverable address may be. */
const EMAIL = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
export function nativeAccountEmail(value: unknown): string {
  if (typeof value !== 'string' || value !== value.trim()) throw new NativeAccountRefusal('invalid');
  const email = value.toLowerCase();
  if (email.length > 254 || !EMAIL.test(email) || email.includes('..') || email.startsWith('.') || email.split('@')[0].endsWith('.')) {
    throw new NativeAccountRefusal('invalid');
  }
  return email;
}
export function nativeAccountPassword(value: unknown): string {
  // Better Auth's own sign-up bounds; its server-side createUser checks neither.
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new NativeAccountRefusal('invalid');
  return value;
}
/** Exactly `{ email, name, password }`, each checked; the password is kept as given. */
export function nativeAccountInput(value: unknown): NativeAccountInput {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype)
    throw new NativeAccountRefusal('invalid');
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 3 || !['email', 'name', 'password'].every((key) => keys.includes(key))) throw new NativeAccountRefusal('invalid');
  const read = (key: string) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !('value' in descriptor)) throw new NativeAccountRefusal('invalid');
    return descriptor.value as unknown;
  };
  const name = profileName(read('name'));
  if (name === undefined) throw new NativeAccountRefusal('invalid');
  return Object.freeze({ email: nativeAccountEmail(read('email')), name, password: nativeAccountPassword(read('password')) });
}

const exact = (value: string) => {
  if (/\p{Cs}/u.test(value) || !value.length || value.length > 1024) throw new NativeAccountRefusal('unavailable');
};

/** The account holding this address, or null. More than one is a store nobody should trust. */
export async function findNativeAccountByEmail(runtime: AppAuthRuntime, input: string): Promise<string | null> {
  const projection = suiteObservations.get(runtime);
  if (projection) {
    projection.current();
    const id = await findNativeAccountByEmail(projection.source, input);
    projection.current();
    return id !== null && (await projection.eligible(id)) ? id : null;
  }
  const store = registered(runtime),
    email = nativeAccountEmail(input);
  const rows = store.file
    ? store.file.prepare('SELECT id FROM "user" WHERE lower(email) = ? LIMIT 2').all(email)
    : (await store.pool!.query(`SELECT id FROM ${ACCOUNTS} WHERE lower(email) = $1 LIMIT 2`, [email])).rows;
  if (store.closed() || rows.length > 1) throw new NativeAccountRefusal('unavailable');
  if (!rows.length) return null;
  const id = rows[0].id;
  if (typeof id !== 'string') throw new NativeAccountRefusal('unavailable');
  exact(id);
  return id;
}

/** The account's address, lower-cased, or null when there is no such account:
 * what an email invitation's acceptance compares with its principal. */
export async function nativeAccountEmailOf(runtime: AppAuthRuntime, accountId: string): Promise<string | null> {
  const projection = suiteObservations.get(runtime);
  if (projection) {
    projection.current();
    if (!(await projection.eligible(accountId))) return null;
    const email = await nativeAccountEmailOf(projection.source, accountId);
    projection.current();
    return (await projection.eligible(accountId)) ? email : null;
  }
  const store = registered(runtime);
  exact(accountId);
  const rows = store.file
    ? store.file.prepare('SELECT id, email FROM "user" WHERE id = ? COLLATE BINARY').all(accountId)
    : (await store.pool!.query(`SELECT id, email FROM ${ACCOUNTS} WHERE id = $1`, [accountId])).rows;
  if (store.closed() || rows.length > 1) throw new NativeAccountRefusal('unavailable');
  if (!rows.length) return null;
  if (rows[0].id !== accountId || typeof rows[0].email !== 'string') throw new NativeAccountRefusal('unavailable');
  return rows[0].email.toLowerCase();
}

/**
 * One account, through Better Auth, with the deployment's default native role
 * (a native role grants no tenant or platform authority). An address that
 * already has an account is refused before anything is written. The new id,
 * which Better Auth chose.
 *
 * `unavailable` after the call went out does not prove nothing was made: the
 * caller that must know looks the address up again.
 */
export async function createNativeAccount(runtime: AppAuthRuntime, input: NativeAccountInput, maker: NativeAccountMaker): Promise<string> {
  const store = registered(runtime),
    account = nativeAccountInput({ ...input });
  const invitation = maker.by === 'invitation' ? maker.invitationId : undefined;
  if (maker.by !== 'maintenance' && (typeof invitation !== 'string' || !invitation)) throw new NativeAccountRefusal('unavailable');
  if ((await findNativeAccountByEmail(runtime, account.email)) !== null) throw new NativeAccountRefusal('exists');
  try {
    // The account and its row of the trail, in one transaction: a row that cannot be written unmakes the account.
    return await store.audit.transaction(async () => {
      const created = await store.create({ email: account.email, name: account.name, password: account.password });
      const user = created && typeof created === 'object' ? (created as { user?: unknown }).user : undefined;
      const { id, email, role } = (user && typeof user === 'object' ? user : {}) as { id?: unknown; email?: unknown; role?: unknown };
      if (typeof id !== 'string' || typeof email !== 'string' || email.toLowerCase() !== account.email)
        throw new NativeAccountRefusal('unavailable');
      exact(id);
      /* Nobody signed in made it: the operator's step, or its own holder
         through the invitation's token, which is what vouched for them. */
      await store.audit.write({
        action: 'create',
        ...(invitation === undefined
          ? { actorId: 'maintenance', actorEmail: '', principal: 'maintenance' }
          : { actorId: id, actorEmail: account.email, principal: `invitation:${invitation}` }),
        targetId: id,
        targetEmail: account.email,
        before: null,
        after: { email: account.email, name: account.name, roles: rolesOf(role), active: true },
      });
      return id;
    });
  } catch (error) {
    if (error instanceof NativeAccountRefusal) throw error;
    // Better Auth's own words, matched and dropped: they never reach a caller.
    const message = error instanceof Error ? error.message : '';
    if (/already exists/i.test(message)) throw new NativeAccountRefusal('exists');
    if (/invalid email/i.test(message)) throw new NativeAccountRefusal('invalid');
    throw new NativeAccountRefusal('unavailable');
  }
}

/** An address's account as the platform's own mail sees it: who, which roles, whether its email is verified. */
interface NativeMailAccount {
  id: string;
  roles: string[];
  verified: boolean;
}

/**
 * The account an address signs in as, for mail the platform sends on its
 * own: a notification's recipient, which must be an account that may read
 * what it is told of, and an account whose verified email may find an
 * application. Null for no account, and for one that is banned.
 */
export async function nativeMailAccount(runtime: AppAuthRuntime, input: string): Promise<NativeMailAccount | null> {
  const store = registered(runtime);
  let email: string;
  try {
    email = nativeAccountEmail(input.trim());
  } catch {
    return null;
  }
  const rows = store.file
    ? store.file
        .prepare('SELECT id, role, banned, banExpires, "emailVerified" AS verified FROM "user" WHERE lower(email) = ? LIMIT 2')
        .all(email)
    : (
        await store.pool!.query(
          `SELECT id, role, banned, "banExpires", "emailVerified" AS verified FROM ${ACCOUNTS} WHERE lower(email) = $1 LIMIT 2`,
          [email],
        )
      ).rows;
  if (store.closed() || rows.length > 1) throw new NativeAccountRefusal('unavailable');
  if (!rows.length) return null;
  const row = rows[0] as Record<string, unknown>;
  if (typeof row.id !== 'string') throw new NativeAccountRefusal('unavailable');
  exact(row.id);
  const banned = row.banned === true || row.banned === 1;
  const until = row.banExpires === null || row.banExpires === undefined ? null : new Date(row.banExpires as string).getTime();
  if (banned && !(until !== null && Number.isFinite(until) && until < Date.now())) return null;
  const roles =
    typeof row.role === 'string'
      ? [
          ...new Set(
            row.role
              .split(',')
              .map((role) => role.trim())
              .filter(Boolean),
          ),
        ]
      : [];
  return { id: row.id, roles, verified: row.verified === true || row.verified === 1 };
}
