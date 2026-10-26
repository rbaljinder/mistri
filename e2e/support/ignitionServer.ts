/**
 * Ignition in a browser, deployed exactly the way its README deploys it.
 *
 * The sample is PostgreSQL-only and two-realm, so there is no SQLite shortcut
 * to a fixture here and no hand-built App either: this starts two dedicated
 * databases, runs the public seed (`examples/databases/ignition/seed-postgres.mjs`)
 * against them, and serves `test/fixtures/apps/ignition` with `--policy`,
 * `--commands` and `--jobs`. Everything a spec signs in as — the accounts, the
 * memberships, the intake addresses — is what the seed made, read back out of
 * the `0600` credentials file it wrote. Nothing is asserted about a deployment
 * the maintainer would not recognise.
 *
 * Why its own databases per run, and never a shared one: the node suites learned
 * this the expensive way (`test/support/tenantDialects.ts`, `uuidPostgresDatabase`)
 * — two suites sharing a PostgreSQL fixture failed 41 of 44 tests the moment they
 * overlapped. A tenant App's database must also hold *only* its declared
 * resources and the reserved `__mistri_*` tables, or startup refuses the
 * source, so this cannot borrow a database another suite seeded.
 *
 * The database creation is written out here rather than imported from
 * `test/support/tenantDialects.ts` on purpose: that module pulls the adapter and
 * tenant-runtime graph in behind it, and the browser gate's only need is two
 * empty databases and `pg`.
 *
 * Skipping: the browser gate has never required a live PostgreSQL, and a
 * developer without one must still be able to run it. `IGNITION_SKIP` carries
 * the same decision the node suites make — a reason when `TABLEWALK_TEST_PG` is
 * unset, and a thrown error instead when `TABLEWALK_REQUIRE_LIVE=1` says this
 * run must not pass by skipping.
 */
import { spawn } from './spawned.js';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { liveSkip } from '../../test/live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
/** `false` to run, or the reason these specs are skipped. Throws under `TABLEWALK_REQUIRE_LIVE=1`. */
export const IGNITION_SKIP: false | string = liveSkip('postgres', LIVE);

export const IGNITION_APP_ID = 'ignition';
/** The dealership ids the seed creates, as `schema.mjs` names them. */
export const DEALERS = { north: 'north-motors', harbor: 'harbor-auto', valley: 'valley-vehicles', suspended: 'parkside' } as const;
/** What each dealership is called, as `schema.mjs` names it: the profile row's name the chooser and the bar say. */
export const DEALER_NAMES: Readonly<Record<string, string>> = {
  'north-motors': 'Demo North Motors',
  'harbor-auto': 'Demo Harbor Auto',
  'valley-vehicles': 'Demo Valley Vehicles',
  parkside: 'Demo Parkside Motors',
};
/** The lender's own choice in the tenant chooser, from `tenancy.platform.label`. */
export const LENDER = 'Lender';

export interface IgnitionAccount {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly realm: 'platform' | 'tenant';
  readonly roles: readonly (string | { tenant: string; role: string })[];
}
interface Credentials {
  readonly accounts: readonly IgnitionAccount[];
  readonly intakeLinks: readonly { readonly dealer: string; readonly path: string }[];
}

/** Two disposable databases named by one UUID, and a drop that ends both. */
async function ownedDatabases(): Promise<{ lending: string; applicants: string; drop: () => Promise<void> }> {
  /* A specifier the compiler does not follow, as packages/engine/src/adapters/postgresPool.ts
     loads it: pg ships no types, and test/built-client-vitals.mjs brings this
     file into `tsc --noEmit`, which refuses an untyped module. */
  const specifier = 'pg';
  const { Client } = (await import(specifier)) as {
    Client: new (options: { connectionString?: string; connectionTimeoutMillis: number }) => {
      connect(): Promise<void>;
      query(text: string): Promise<unknown>;
      end(): Promise<void>;
    };
  };
  const run = async (sql: string) => {
    const admin = new Client({ connectionString: LIVE, connectionTimeoutMillis: 10_000 });
    await admin.connect();
    try {
      await admin.query(sql);
    } finally {
      await admin.end().catch(() => {});
    }
  };
  const tag = randomUUID().replaceAll('-', '');
  const names = { lending: `ign_e2e_lending_${tag}`, applicants: `ign_e2e_applicants_${tag}` };
  const url = (name: string) => {
    const value = new URL(LIVE!);
    value.pathname = `/${name}`;
    return value.href;
  };
  await run(`CREATE DATABASE "${names.lending}"`);
  try {
    await run(`CREATE DATABASE "${names.applicants}"`);
  } catch (error) {
    await run(`DROP DATABASE IF EXISTS "${names.lending}" WITH (FORCE)`);
    throw error;
  }
  let dropped = false;
  return {
    lending: url(names.lending),
    applicants: url(names.applicants),
    drop: async () => {
      if (dropped) return;
      dropped = true;
      for (const name of Object.values(names)) await run(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    },
  };
}

/** A port nothing is listening on, released before it is handed back. */
async function freePort(): Promise<number> {
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const { port } = reservation.address() as { port: number };
  await new Promise<void>((done, fail) => reservation.close((error) => (error ? fail(error) : done())));
  return port;
}

/** Run a child to completion, and fail with everything it said. */
async function complete(what: string, command: readonly string[], env: NodeJS.ProcessEnv, cwd: string): Promise<void> {
  const child = spawn(process.execPath, [...command], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  const [code] = (await once(child, 'exit')) as [number | null];
  if (code !== 0) throw new Error(`${what} exited ${code}: ${log}`);
}

export interface IgnitionFixture {
  readonly origin: string;
  /** Every seeded account, by the email the fixture signs in with. */
  readonly accounts: ReadonlyMap<string, IgnitionAccount>;
  /** One account holding exactly this role, tenant-realm roles named by dealership. */
  account(role: string, tenant?: string): IgnitionAccount;
  /** The published intake path for a dealership, `?via=` and all. */
  intake(dealer: string): string;
  /** The lending database's URL, for a spec that reads back what a command wrote. */
  readonly lendingUrl: string;
  /** What another start over the same databases needs (`mistri shot`): the connections file and its environment. */
  readonly config: string;
  readonly env: Readonly<Record<string, string>>;
  /** What the server has written to stdout and stderr so far. */
  output(): string;
  stop(): Promise<void>;
}

/**
 * Seed two databases and serve Ignition on them. One per spec file (`beforeAll`):
 * seeding creates fourteen native accounts and about seven hundred rows, which is
 * seconds rather than milliseconds, and no test here mutates what another reads
 * except through the App itself.
 */
export async function startIgnition(
  options: {
    directory?: string;
    port?: number;
    /** The server to run, when not the source under tsx: test/built-client-vitals.mjs serves the build. */
    entry?: readonly string[];
    /** The App asks for live sync, its change store provisioned in the lending database (a copy of the
        fixture with `live: true`, since the sample itself does not ask). */
    live?: boolean;
    /** The address the server reaches each database by, when not the database's own: a latency relay's. */
    route?: (url: string) => string;
    /** More of the server's environment (e2e/write-storm.spec.ts asks for its write-ahead report). */
    env?: Readonly<Record<string, string>>;
  } = {},
): Promise<IgnitionFixture> {
  if (IGNITION_SKIP) throw new Error(`The Ignition browser fixture needs a live PostgreSQL: ${IGNITION_SKIP}`);
  const cwd = process.cwd();
  const directory = options.directory ?? join(cwd, 'e2e', '.tmp', `ignition-${randomUUID()}`);
  const databases = await ownedDatabases();
  let child: ReturnType<typeof spawn> | undefined;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      try {
        if (child && child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill('SIGTERM');
          const force = setTimeout(() => child?.kill('SIGKILL'), 5_000);
          try {
            await closed;
          } finally {
            clearTimeout(force);
          }
        }
      } finally {
        await databases.drop();
        rmSync(directory, { recursive: true, force: true });
      }
    })());
  try {
    /* The seed and the server must agree on XDG_CONFIG_HOME: Ignition declares no
       `auth.store`, so its native accounts live at
       `$XDG_CONFIG_HOME/tablewalk/auth/ignition.db` (auth.ts, `defaultStore`) —
       the seed creates them there and the server signs them in from there. */
    const xdg = join(directory, 'xdg');
    const audit = `ignition-browser-audit-key-${randomUUID()}`;
    const shared = {
      ...process.env,
      DATABASE_URL: '',
      XDG_CONFIG_HOME: xdg,
      MISTRI_OPEN: '0',
      MISTRI_AUDIT_KEY: audit,
      // Kept apart from the audit key, as the README insists.
      BETTER_AUTH_SECRET: `ignition-browser-session-secret-${randomUUID()}`,
      MISTRI_AUTH_ADMIN_EMAIL: '',
      MISTRI_AUTH_ADMIN_PASSWORD: '',
    };
    const fixture = join(directory, 'fixture');
    await complete(
      'The Ignition seed',
      ['--import', 'tsx', 'examples/databases/ignition/seed-postgres.mjs', fixture],
      {
        ...shared,
        IGNITION_LENDING_SEED_URL: databases.lending,
        IGNITION_APPLICANTS_SEED_URL: databases.applicants,
      },
      cwd,
    );
    const credentials = JSON.parse(readFileSync(join(fixture, 'credentials.json'), 'utf8')) as Credentials;
    let authored = 'test/fixtures/apps/ignition';
    if (options.live) {
      authored = join(directory, 'app');
      cpSync(join(cwd, 'test/fixtures/apps/ignition'), authored, { recursive: true });
      const source = join(authored, 'app.ts');
      const text = readFileSync(source, 'utf8');
      if (!text.includes("id: 'ignition',")) throw new Error('The Ignition fixture no longer says its id where live sync is added.');
      writeFileSync(source, text.replace("id: 'ignition',", "id: 'ignition',\n  live: true,"));
      const { provisionPostgresLiveChange } = await import('../../packages/mistri/src/adapters/live/postgresLiveChange.js');
      await provisionPostgresLiveChange(databases.lending);
    }
    const route = options.route ?? ((url: string) => url);

    const port = options.port ?? (await freePort());
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      [
        ...(options.entry ?? ['--import', 'tsx', 'packages/mistri/src/server/index.ts']),
        '--config',
        join(fixture, 'server.json'),
        '--app',
        authored,
        '--policy',
        join(authored, 'tenant-policy.ts'),
        '--commands',
        join(authored, 'commands.ts'),
        '--jobs',
        join(authored, 'jobs.ts'),
        '--port',
        String(port),
      ],
      {
        cwd,
        env: {
          ...shared,
          IGNITION_LENDING_DATABASE_URL: route(databases.lending),
          IGNITION_APPLICANTS_DATABASE_URL: route(databases.applicants),
          ...options.env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const serving = child;
    let log = '';
    serving.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    serving.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    await new Promise<void>((done, fail) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        serving.stdout!.off('data', ready);
        serving.off('exit', exited);
        serving.off('error', finish);
        if (error) fail(error);
        else done();
      };
      const ready = () => {
        if (log.includes('Listening on ')) finish();
      };
      const exited = () => finish(new Error(`The Ignition server exited: ${log}`));
      const timer = setTimeout(() => finish(new Error(`The Ignition server did not start: ${log}`)), 60_000);
      serving.stdout!.on('data', ready);
      serving.once('exit', exited);
      serving.once('error', finish);
      ready();
    });

    const accounts = new Map(credentials.accounts.map((account) => [account.email, account]));
    const intakes = new Map(credentials.intakeLinks.map((link) => [link.dealer, link.path]));
    const account = (role: string, tenant?: string): IgnitionAccount => {
      const found = credentials.accounts.find((entry) =>
        entry.roles.some((held) =>
          typeof held === 'string' ? held === role && tenant === undefined : held.role === role && held.tenant === tenant,
        ),
      );
      if (!found) throw new Error(`The seed granted no ${role}${tenant ? ` at ${tenant}` : ''}.`);
      return found;
    };
    const intake = (dealer: string): string => {
      const path = intakes.get(dealer);
      if (!path) throw new Error(`The seed published no intake link for ${dealer}.`);
      return path;
    };
    return {
      origin,
      accounts,
      account,
      intake,
      lendingUrl: databases.lending,
      stop,
      output: () => log,
      config: join(fixture, 'server.json'),
      env: {
        IGNITION_LENDING_DATABASE_URL: databases.lending,
        IGNITION_APPLICANTS_DATABASE_URL: databases.applicants,
        MISTRI_AUDIT_KEY: audit,
      },
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
