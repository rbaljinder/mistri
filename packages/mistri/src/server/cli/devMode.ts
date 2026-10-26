/**
 * `mistri dev [<app-dir>]`: the App on this machine with nothing to set up first.
 *
 * Serving an App with sign-in wants a session secret, an administrator and an
 * account per role before anyone can look at a role's screens; an agent
 * building one used to invent all three. This is a convenience over the one
 * serve path, not a second server: it settles the environment, rewrites the
 * arguments to `--app <dir> --dev …`, and once the server answers, makes the
 * accounts and prints a sign-in for each.
 *
 * Everything it keeps lives in `<app-dir>/.mistri/` — the secret and the
 * passwords (dev.json), the auth store (XDG_CONFIG_HOME points there) — so a
 * restart signs the same people in, and deleting the folder starts over. The
 * folder ignores itself, and the scaffold's .gitignore names it as well.
 * Every credential it prints is throwaway, local and for development only,
 * which is why it refuses to run under NODE_ENV=production.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import type { LoadedApp } from '../app/apps.js';
import { configLocations } from '@mistriwork/engine/server/config/locations.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { isTenantApp } from '../../shared/appModel.js';
import { columnKind, primaryKey, tableNamed } from '@mistriwork/engine/shared/schema.js';
import type { Options } from '@mistriwork/engine/server/cli/args.js';

const USAGE = 'mistri dev [<app-dir>] [<db> | --db <target> | --config <path>] [serve options]';
const ADMIN = 'admin@example.test';

export class DevRefusal extends Error {}

interface DevFile {
  secret: string;
  passwords: Record<string, string>;
  /** A tenant App's dev accounts by role: made once with the maintenance step, and each a member where it works. */
  accounts?: Record<string, string>;
}

const password = () => randomBytes(18).toString('base64url');
const emailOf = (role: string) => (role === 'admin' ? ADMIN : `${role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@example.test`);

/** The dev folder's record, made on the first start and read on every one after. */
function devFile(folder: string): { file: string; dev: DevFile } {
  mkdirSync(folder, { recursive: true });
  /* The folder ignores itself, so it stays out of a commit even in a project whose .gitignore does not name it. */
  if (!existsSync(join(folder, '.gitignore'))) writeFileSync(join(folder, '.gitignore'), '*\n');
  const file = join(folder, 'dev.json');
  let dev: DevFile | undefined;
  try {
    const read = JSON.parse(readFileSync(file, 'utf8')) as Partial<DevFile>;
    if (typeof read.secret === 'string' && read.secret.length >= 32)
      dev = {
        secret: read.secret,
        passwords: read.passwords && typeof read.passwords === 'object' ? read.passwords : {},
        ...(read.accounts && typeof read.accounts === 'object' ? { accounts: read.accounts } : {}),
      };
  } catch {
    /* None yet, or unreadable: a new one, and the accounts it named are signed in to with new passwords below. */
  }
  dev ??= { secret: randomBytes(32).toString('base64url'), passwords: {} };
  dev.passwords.admin ??= password();
  writeFileSync(file, `${JSON.stringify(dev, null, 2)}\n`, { mode: 0o600 });
  return { file, dev };
}

/** Whether the person named where the data is: then it is theirs to say, and dev mode does not look for a config. */
const namesData = (args: string[]) =>
  args.some((arg) => arg === '--db' || arg === '-d' || arg === '--config' || arg === '--no-config') ||
  (args.length > 0 && !args[0].startsWith('-'));

export interface DevSession {
  /** The arguments the serve path reads, in place of `dev …`. */
  argv: string[];
  /** Once the server listens: the accounts per role, and a sign-in for each. */
  serving(opts: Options, loadedApps: LoadedApp[], registry: Registry): void;
}

/** Settles the environment for a dev start and says what to serve; refuses with a DevRefusal. */
export function prepareDev(argv: string[], env: NodeJS.ProcessEnv = process.env): DevSession {
  if (env.NODE_ENV === 'production')
    throw new DevRefusal(
      'dev makes throwaway accounts and a session secret kept on this machine, and NODE_ENV is production. ' +
        'Serve a deployment with mistri --app <dir>, BETTER_AUTH_SECRET and its own accounts.',
    );
  let args = [...argv];
  let dir = '.';
  const named = args.indexOf('--app');
  if (named >= 0) {
    dir = args[named + 1] ?? '';
    args.splice(named, 2);
  } else if (args[0] && !args[0].startsWith('-') && existsSync(args[0]) && statSync(args[0]).isDirectory()) {
    dir = args[0];
    args = args.slice(1);
  }
  const app = resolve(dir);
  if (!['app.ts', 'app.mjs', 'app.json'].some((name) => existsSync(join(app, name))))
    throw new DevRefusal(`${app} has no app.ts (or app.mjs / app.json): name the App's directory. ${USAGE}`);

  /* The config is found before XDG_CONFIG_HOME moves into .mistri/: the App's own mistri.json, else the one a
     plain `mistri` would read (the working directory's, then the person's own). */
  if (!namesData(args)) {
    const config = [join(app, 'mistri.json'), ...configLocations(undefined, env)].find((file) => existsSync(file));
    if (config) args.push('--config', config);
  }

  const folder = join(app, '.mistri');
  const { file, dev } = devFile(folder);
  env.BETTER_AUTH_SECRET = dev.secret;
  env.MISTRI_AUTH_ADMIN_EMAIL = ADMIN;
  env.MISTRI_AUTH_ADMIN_PASSWORD = dev.passwords.admin;
  /* The default auth store is under XDG_CONFIG_HOME (auth.ts defaultStore): here, it is the App's dev folder, so
     these accounts never meet the ones a real start of the same App keeps. */
  env.XDG_CONFIG_HOME = join(folder, 'config');

  return {
    argv: ['--app', app, ...args, ...(args.includes('--dev') ? [] : ['--dev'])],
    serving(opts, loadedApps, registry) {
      const tenant = loadedApps.find((loaded) => isTenantApp(loaded.app));
      void (tenant ? tenantAccounts(opts, tenant, dev, file, registry) : accounts(opts, loadedApps, dev, file, registry)).catch(
        (error: Error) => {
          console.error(`mistri dev: could not make the dev accounts: ${error.message}`);
        },
      );
    },
  };
}

interface Person {
  email: string;
  name?: string;
}

/**
 * Who each role's dev account is, where the App says who people are (`auth.me`): a row of that table, a different
 * one per role. A throwaway address matched no row, so a view of `mechanic_id = me` — My bench — was empty for the
 * one account made to look at it. A row naming the role in one of its words (a `role` of 'mechanic', a title of
 * 'Manager') is that role's first; then a role named as the table is, then the rest in the order they are declared. A role left
 * over, or an App with no `auth.me` (or a tenant App, where `me` is a membership), keeps its throwaway address.
 */
export async function devPeople(loaded: LoadedApp, roles: readonly string[], registry: Registry): Promise<Map<string, Person>> {
  const me = loaded.app.auth?.me;
  const chosen = new Map<string, Person>();
  if (!me || isTenantApp(loaded.app)) return chosen;
  const sources = Object.values(loaded.app.sources ?? {});
  const bound = loaded.app.connection ?? (sources.length === 1 ? sources[0].connection : undefined);
  const connection = registry.list().find((c) => c.id === bound || c.name === bound) ?? (bound ? undefined : registry.list()[0]);
  if (!connection) return chosen;
  const { adapter, schema } = await registry.open(connection.id);
  const table = tableNamed(schema, me.from);
  const key = table && primaryKey(table)[0];
  if (!table || !key || !table.columns.some((column) => column.name === me.column)) return chosen;
  const named = ['name', 'full_name', 'display_name', 'title'].find((column) => table.columns.some((c) => c.name === column));
  /* Every text column by name: the adapter's own pick may leave the email out, as a reader's grid does. */
  const columns = table.columns.filter((column) => column.name === key || columnKind(column.type) === 'text').map((column) => column.name);
  const result = await adapter.query({ table: table.id, columns, orderBy: [{ column: key, direction: 'asc' }], limit: 200, offset: 0 });
  const rows = result.rows.filter((row) => typeof row[me.column] === 'string' && /@/.test(row[me.column] as string));
  const taken = new Set<unknown>();
  const take = (role: string, row: Record<string, unknown>) => {
    taken.add(row);
    chosen.set(role, { email: row[me.column] as string, ...(named && typeof row[named] === 'string' ? { name: row[named] } : {}) });
  };
  const word = (role: string) => role.toLowerCase().replace(/[_-]+/g, ' ');
  /* A role named as the table is (mechanic, of mechanic or mechanics) is the one the table's rows are people of: it
     is given a row first, so a manager declared before it does not take the row its views are about. */
  const singular = (name: string) => word(name).replace(/s$/, '');
  roles = [...roles].sort((a, b) => Number(singular(b) === singular(me.from)) - Number(singular(a) === singular(me.from)));
  for (const role of roles) {
    const own = rows.find(
      (row) =>
        !taken.has(row) &&
        Object.entries(row).some(
          ([column, value]) => column !== me.column && typeof value === 'string' && value.toLowerCase() === word(role),
        ),
    );
    if (own) take(role, own);
  }
  for (const role of roles) {
    if (chosen.has(role)) continue;
    const next = rows.find((row) => !taken.has(row));
    if (next) take(role, next);
  }
  return chosen;
}

/** Where the server answers, once it answers ready. */
async function ready(opts: Options): Promise<{ origin: () => string; base: string }> {
  const host = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host.includes(':') ? `[${opts.host}]` : opts.host;
  const base = (opts.basePath ?? '').replace(/\/$/, '');
  /* The port is read each time: it is the one the server bound, which the serve path writes back on listening. */
  const origin = () => `http://${host}:${opts.port}`;
  for (let tries = 0; ; tries++) {
    const answered = await fetch(`${origin()}${base}/readyz`).then(
      (response) => response.ok,
      () => false,
    );
    if (answered) return { origin, base };
    if (tries > 600) throw new Error('the server did not answer ready within a minute.');
    await new Promise((done) => setTimeout(done, 100));
  }
}

/** How long a dev membership lasts: a restart after it ends grants another. */
const DEV_MEMBERSHIP_DAYS = 30;

/**
 * A tenant App's sign-ins: an account per role, each a member where its role works — a tenant role in the first two
 * tenants of the profile table (made active if the tenant store has none yet), a platform role in the platform realm.
 * People in a tenant App are memberships, not role grants, so these are made as an operator makes them, by the
 * maintenance steps on this machine's database (tenant/tenantLocalAccess.ts), never through a door of the App.
 */
async function tenantAccounts(opts: Options, loaded: LoadedApp, dev: DevFile, file: string, registry: Registry) {
  if (!opts.policy) return;
  await ready(opts);
  const app = loaded.app;
  const declared = (app.auth?.roles ?? {}) as Record<string, { realm?: string; service?: boolean }>;
  const roles = Object.keys(declared).filter((role) => !declared[role].service);
  if (!roles.length || !loaded.dir) return;
  const local = await import('../tenant/tenantLocalAccess.js');
  const access = await local.tenantLocalAccess(loaded, registry, opts.policy);
  const tenants = await local.profileTenants(loaded, registry, 2);
  const save = () => writeFileSync(file, `${JSON.stringify(dev, null, 2)}\n`, { mode: 0o600 });
  /* Each password is kept before its account is made with it, so a start cut short never leaves an account no one can sign in to. */
  let changed = false;
  for (const role of roles) if (!dev.passwords[role]) changed = Boolean((dev.passwords[role] = password()));
  if (changed) save();
  const accounts = (dev.accounts ??= {});
  const missing = roles.filter((role) => !accounts[role]);
  if (missing.length) {
    const { createAppAccounts } = await import('../tenant/tenantMaintenance.js');
    const made = await createAppAccounts(
      loaded.dir,
      missing.map((role) => ({ email: emailOf(role), name: `Dev ${role}`, password: dev.passwords[role] })),
    ).catch((error: Error) => {
      throw new Error(`${error.message} If ${file} was replaced after the accounts were made, delete ${join(file, '..')} and start again.`);
    });
    missing.forEach((role, at) => (accounts[role] = made[at]));
    save();
  }
  const platform = (role: string) => declared[role].realm === 'platform';
  for (const role of roles)
    for (const tenantId of platform(role) ? ['@platform'] : tenants) {
      await local.ensureLocalTenant(access, tenantId, 'mistri-dev');
      await local.grantLocalMembership(access, {
        tenantId,
        accountId: accounts[role],
        roles: [role],
        days: DEV_MEMBERSHIP_DAYS,
        operator: 'mistri-dev',
      });
    }
  const label = (app.auth?.tenancy?.label ?? 'tenant').toLowerCase();
  const width = Math.max(...roles.map((role) => role.length));
  console.log(`mistri dev: sign in to ${app.name} as any role — throwaway accounts, local and for development only:`);
  /* A sign-in stays one line of role, address and password, which a script reads; where it works goes under it. */
  for (const role of roles) {
    console.log(`  ${role.padEnd(width)}  ${emailOf(role)}  ${dev.passwords[role]}`);
    const where = platform(role) ? [app.auth?.tenancy?.platform?.label ?? 'the platform'] : tenants;
    if (where.length) console.log(`  ${' '.repeat(width)}  a member of ${where.join(' and ')}`);
  }
  if (!tenants.length && roles.some((role) => !platform(role)))
    console.log(
      `  No ${label} is in ${app.auth?.tenancy?.profile ?? 'the profile table'} yet, so the ${label} roles are members of none: add a row and start again.`,
    );
  console.log(`  Kept in ${relative(process.cwd(), join(file, '..')) || '.mistri'}; delete it to start over.`);
}

/** Waits for the server to answer ready, then makes an account per declared role and prints a sign-in for each. */
async function accounts(opts: Options, loadedApps: LoadedApp[], dev: DevFile, file: string, registry: Registry) {
  const withRoles = loadedApps.filter((loaded) => loaded.app.auth);
  if (!withRoles.length) return;
  const { origin, base } = await ready(opts);
  const { createTestClient } = await import('../testing/client.js');
  const rolesOf = (loaded: LoadedApp) => ['admin', ...Object.keys(loaded.app.auth?.roles ?? {}).filter((role) => role !== 'admin')];
  /* Each password is kept before its account is made with it, so a start cut short never leaves an account no one can sign in to. */
  let changed = false;
  for (const role of withRoles.flatMap(rolesOf)) if (!dev.passwords[role]) changed = Boolean((dev.passwords[role] = password()));
  if (changed) writeFileSync(file, `${JSON.stringify(dev, null, 2)}\n`, { mode: 0o600 });
  for (const loaded of withRoles) {
    const roles = rolesOf(loaded);
    const admin = createTestClient(origin(), { app: loaded.app.id, base });
    const signedIn = await admin.request('/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: ADMIN, password: dev.passwords.admin },
    });
    if (signedIn.status !== 200)
      throw new Error(
        `signing in ${ADMIN} answered ${signedIn.status}. If ${file} was replaced after the accounts were made, delete ${join(file, '..')} and start again.`,
      );
    const persons = await devPeople(loaded, roles.slice(1), registry).catch((error: Error) => {
      console.error(`mistri dev: the accounts keep throwaway addresses; reading ${loaded.app.auth?.me?.from} failed: ${error.message}`);
      return new Map<string, Person>();
    });
    const addressOf = (role: string) => persons.get(role)?.email ?? emailOf(role);
    for (const role of roles.slice(1)) {
      const made = await admin.request('/api/accounts', {
        method: 'POST',
        json: {
          app: loaded.app.id,
          operation: 'create',
          name: persons.get(role)?.name ?? `Dev ${role}`,
          email: addressOf(role),
          roles: [role],
          password: dev.passwords[role],
        },
      });
      /* Already there is the usual case after the first start: the password is the one dev.json kept. */
      if (made.status !== 200 && !/exist|already/i.test(await made.text()))
        throw new Error(`making an account for "${role}" answered ${made.status}.`);
    }
    const width = Math.max(...roles.map((role) => role.length));
    console.log(`mistri dev: sign in to ${loaded.app.name} as any role — throwaway accounts, local and for development only:`);
    /* A sign-in stays one line of role, address and password, which a script reads; whose row it is goes under it. */
    for (const role of roles) {
      const person = persons.get(role);
      console.log(`  ${role.padEnd(width)}  ${addressOf(role)}  ${dev.passwords[role]}`);
      if (person) console.log(`  ${' '.repeat(width)}  ${person.name ?? 'a row'} in ${loaded.app.auth!.me!.from}: \`me\` is that row`);
    }
    if (persons.size)
      console.log(
        `  An account takes the email of a ${loaded.app.auth!.me!.from} row (auth.me), one per role, so a view of \`= me\` shows that person's records.`,
      );
    console.log(`  Kept in ${relative(process.cwd(), join(file, '..')) || '.mistri'}; delete it to start over.`);
  }
}
