/**
 * `mistri shot --as <role> --tenant <id>` on a tenant App: an account of
 * that role in the context it names, made the way an operator makes one.
 *
 * An ordinary App's roles are its auth store's, so shot makes a fresh account
 * in its own temporary store and is done. A tenant App's authority is its
 * memberships, which live in the tenant store in the App's own database: a
 * fresh account holds none, and the chooser it signs in to offers nothing. So
 * the account is made in shot's temporary store (never the reader's) and given
 * one membership through the public maintenance steps (@mistriwork/mistri/maintenance),
 * journaled under `maintenance:mistri-shot` as any operator's grant is.
 * `release` revokes it through the same steps when the shot ends, however it
 * ends, so the App's tenant store keeps no live grant for a shot that is over;
 * the hour it is valid for is the backstop for a shot killed outright, and it
 * is held by an account whose store is gone by then. A platform role's
 * membership is the platform realm's, and `--tenant` is not asked for.
 */
import { randomBytes } from 'node:crypto';
import type { LoadedApp } from '../app/apps.js';
import { asRoleRefusal } from './shotRoles.js';
import { resolveConnection } from '@mistriwork/engine/server/auth/credentials.js';
import { loadAppTenantPolicy } from '../policy/appTenantPolicy.js';
import {
  createAppAccounts,
  grantPlatformMembership,
  grantTenantMembership,
  revokePlatformMembership,
  revokeTenantMembership,
  type TenantMaintenanceTarget,
} from '../maintenance.js';
import { homeSourceOf } from '../../shared/app.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';

const OPERATOR = 'mistri-shot';
/* Longer than any shot, and short enough that one left behind by a killed shot soon grants nothing. */
const LIFETIME = 60 * 60 * 1000;

export interface TenantShotAccount {
  email: string;
  password: string;
  /** The chooser's choice for the context, by the id it sends: the tenant's, or the platform realm's reserved one. */
  choice: string;
  realm: 'tenant' | 'platform';
  /** The column that owns a table's rows for a tenant, where one does: a first record is looked for among the tenant's own. */
  owner: (table: string) => string | undefined;
  tenant?: string;
  /** Revokes the membership, journaled as its grant was; a second call does nothing. Never throws: it says what it could not do. */
  release: () => Promise<string | undefined>;
}

/** The account, its membership granted; `refuse` says why not in shot's words. */
export async function tenantShotAccount(input: {
  loaded: LoadedApp;
  appDir: string;
  role: string;
  tenant: string | undefined;
  policy: string | undefined;
  connection: { name: string; url: string };
  xdg: string;
  refuse: (why: string) => never;
}): Promise<TenantShotAccount> {
  const { loaded, role, tenant, refuse } = input;
  const app = loaded.app;
  if (!(app.auth?.providers ?? ['email']).includes('email')) refuse('--as signs in by email and password, which this App does not offer.');
  if (app.auth?.store) refuse('--as makes an account in a store of its own, and this App names its auth.store.');
  const roles = app.auth?.roles ?? {};
  const refused = asRoleRefusal(app.name, roles, role, false);
  if (refused) refuse(refused);
  const realm = roles[role].realm === 'platform' ? 'platform' : 'tenant';
  if (realm === 'tenant' && !tenant) refuse(`--as ${role} is a role within a tenant: --tenant <id> says which one.`);
  if (realm === 'platform' && tenant) refuse(`--as ${role} is a role of the platform realm, which is one context: leave --tenant out.`);
  if (!input.policy) refuse('--as on a tenant App needs its --policy, which names the tenant store its memberships are in.');
  const policy = await loadAppTenantPolicy(input.policy!).catch(() => refuse(`--policy ${input.policy} did not load as a tenant policy.`));
  const source = homeSourceOf(app)!;
  const binding = { appId: app.id, source: { id: source, connection: app.sources![source].connection }, storeId: policy.storeId };
  const { url } = await resolveConnection(input.connection.name, input.connection.url);
  const where: TenantMaintenanceTarget = /^postgres(ql)?:\/\//i.test(url)
    ? { postgres: url }
    : { sqlite: url.replace(/^sqlite:(\/\/)?/i, '') };
  const email = `shot-${role.replace(/[^A-Za-z0-9._-]+/g, '-')}@example.invalid`;
  const password = randomBytes(18).toString('base64url');
  /* The account is made in shot's own store: the auth store lives under the
     config directory, which is the temporary one for these two steps only. */
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = input.xdg;
  let granted: { membershipId: string; version: string } | undefined;
  try {
    const [accountId] = await createAppAccounts(input.appDir, [{ email, name: `A ${role}`, password }]);
    const validUntil = Date.now() + LIFETIME;
    granted =
      realm === 'platform'
        ? await grantPlatformMembership(where, binding, { app: input.appDir, accountId, roles: [role], validUntil, operator: OPERATOR })
        : await grantTenantMembership(where, binding, {
            app: input.appDir,
            tenantId: tenant!,
            accountId,
            roles: [role],
            validUntil,
            operator: OPERATOR,
          });
  } catch (error) {
    refuse(`--as ${role}${tenant ? ` --tenant ${tenant}` : ''}: ${(error as Error).message.split('\n')[0]}`);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
  let released: Promise<string | undefined> | undefined;
  const release = () =>
    (released ??= (async () => {
      const { membershipId, version: expectedVersion } = granted!;
      try {
        if (realm === 'platform') await revokePlatformMembership(where, binding, { membershipId, expectedVersion, operator: OPERATOR });
        else await revokeTenantMembership(where, binding, { tenantId: tenant!, membershipId, expectedVersion, operator: OPERATOR });
        return undefined;
      } catch (error) {
        return (
          `the ${realm} membership ${membershipId} shot granted was not revoked (${(error as Error).message.split('\n')[0]}); ` +
          'it lapses within the hour it was granted for.'
        );
      }
    })());
  const ownership = policy.ownership as Readonly<Record<string, { kind: string; column?: string }>>;
  return {
    email,
    password,
    realm,
    choice: realm === 'platform' ? PLATFORM_TENANT_ID : tenant!,
    owner: (table) => (realm === 'tenant' && ownership[table]?.kind === 'tenant' ? ownership[table].column : undefined),
    ...(tenant ? { tenant } : {}),
    release,
  };
}
