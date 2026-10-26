import { execFileSync } from 'node:child_process';
import { spawn } from './spawned.js';
import { once } from 'node:events';
import { constants, copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TMP } from './fixtures.js';

/** Forecourt's staff account, bootstrapped on the disposable server's first start. */
export const FORECOURT_STAFF = { email: 'staff@forecourt.example.test', password: 'disposable-forecourt-staff-password' };
export const PAYDAY_ADMIN = { email: 'admin@payday.example.test', password: 'disposable-payday-admin-password' };
/** Depot's manager, the bootstrapped administrator; operators and purchasers are made from it (e2e/depot.spec.ts). */
export const DEPOT_ADMIN = { email: 'admin@depot.example.test', password: 'disposable-depot-admin-password' };
/** Commons' bootstrapped administrator, who moderates. */
export const COMMONS_ADMIN = { email: 'admin@commons.example.test', password: 'disposable-commons-admin-password' };
export const LOANER_ADMIN = { email: 'admin@loaner.example.test', password: 'disposable-loaner-admin-password' };
/** Atelier's owner, the bootstrapped administrator; staff and warehouse accounts are made from it (e2e/atelier.spec.ts). */
export const ATELIER_ADMIN = { email: 'admin@atelier.example.test', password: 'disposable-atelier-admin-password' };

/* Depot's ledger, Commons' forum and Forecourt's images each cost several
   seconds to generate per browser test. Seed once per worker (and day when
   date-dependent), then copy the closed database: every journey still gets
   its own writable fixture and runtime stores. */
const seedTemplates = new Map<string, string>();

export function seedExpensiveSampleDatabase(name: 'depot' | 'commons' | 'forecourt', seed: string, db: string): void {
  const chosen = name === 'forecourt' ? undefined : process.env[name === 'depot' ? 'DEPOT_TODAY' : 'COMMONS_TODAY'];
  /* Forecourt dates its desk back from today, as Depot does, so a template
     is a day's: a worker that runs past midnight seeds again. */
  const today =
    name === 'forecourt'
      ? (process.env.FORECOURT_TODAY ?? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date()))
      : name === 'depot' && !/^\d{4}-\d{2}-\d{2}$/.test(chosen ?? '')
        ? new Date().toISOString().slice(0, 10)
        : (chosen ?? new Date().toISOString().slice(0, 10));
  const key = `${name}:${today}`;
  let template = seedTemplates.get(key);
  if (!template || !existsSync(template)) {
    const directory = mkdtempSync(join(tmpdir(), `tablewalk-${name}-seed-template-`));
    const database = join(directory, 'fixture.db');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', seed, database]);
      if (existsSync(`${database}-wal`) || existsSync(`${database}-shm`)) {
        throw new Error(`${name} seed left SQLite sidecars; copying only its database would lose committed rows.`);
      }
      template = database;
      seedTemplates.set(key, template);
      process.once('exit', () => rmSync(directory, { recursive: true, force: true }));
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }
  copyFileSync(template, db, constants.COPYFILE_EXCL);
  const config = JSON.parse(readFileSync(`${template}.json`, 'utf8')) as { connections: Array<{ url: string; kind?: string }> };
  for (const connection of config.connections) {
    if (connection.kind === 'email') continue;
    if (connection.url !== template) throw new Error(`${name} seed config does not name its template database.`);
    connection.url = db;
  }
  writeFileSync(`${db}.json`, `${JSON.stringify(config, null, 2)}\n`, { flag: 'wx' });
}

/**
 * Real CLI process and fresh seeded data; never connects to a preview database.
 * `built` serves the App from `mistri build` output instead of its source:
 * built into the fixture directory, started with the build's own entries.
 */
export async function startSample(
  /* 'forecourt' is the older fixture (test/fixtures/apps/forecourt); 'forecourt-market' the marketplace
     fixture over the same seed (test/fixtures/apps/forecourt-market). */
  name:
    | 'relay'
    | 'thread'
    | 'service-desk'
    | 'tick'
    | 'forecourt'
    | 'forecourt-market'
    | 'payday'
    | 'depot'
    | 'commons'
    | 'loaner-desk'
    | 'atelier',
  /* `dev` serves the dev observer (--dev), for a spec that counts what a room asks the database. */
  /* `jobs` serves the App's jobs module (--jobs), for a spec that watches its flows run. */
  /* `env` adds to the server's environment: a spec that compares the server's drawing on and off (MISTRI_SSR=0). */
  options: { built?: boolean; dev?: boolean; jobs?: boolean; env?: Record<string, string> } = {},
) {
  /* Tick is the one public example served here. The others were examples once: their seeds live beside the
     fixtures (test/fixtures/databases), not inside the App. */
  const publicApp = name === 'tick';
  const separateSeed =
    name === 'thread' || name === 'payday' || name === 'depot' || name === 'commons' || name === 'loaner-desk' || name === 'atelier';
  const market = name === 'forecourt-market';
  const forecourt = name === 'forecourt' || market;
  const commanded =
    forecourt || name === 'payday' || name === 'depot' || name === 'commons' || name === 'loaner-desk' || name === 'atelier';
  const account =
    name === 'payday'
      ? PAYDAY_ADMIN
      : name === 'depot'
        ? DEPOT_ADMIN
        : name === 'commons'
          ? COMMONS_ADMIN
          : name === 'loaner-desk'
            ? LOANER_ADMIN
            : name === 'atelier'
              ? ATELIER_ADMIN
              : FORECOURT_STAFF;
  const source = market
    ? resolve('test/fixtures/apps/forecourt-market')
    : resolve(publicApp ? 'examples/apps' : 'test/fixtures/apps', name);
  const directory = mkdtempSync(join(TMP, `${name}-`));
  const db = join(directory, 'fixture.db');
  const seed = forecourt
    ? resolve('test/fixtures/databases/forecourt/seed.mjs')
    : publicApp
      ? resolve(`examples/databases/${name}/seed.mjs`)
      : separateSeed
        ? resolve(`test/fixtures/databases/${name}/seed.mjs`)
        : join(source, 'seed.mjs');
  // Command-backed samples migrate their journal through the public SDK.
  if (name === 'depot' || name === 'commons' || forecourt) seedExpensiveSampleDatabase(forecourt ? 'forecourt' : name, seed, db);
  else execFileSync(process.execPath, [...(commanded ? ['--import', 'tsx'] : []), seed, db]);
  const appDirectory = options.built ? join(directory, 'build') : source;
  if (options.built) {
    execFileSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/mistri/src/server/index.ts',
        'build',
        '--app',
        source,
        '--out',
        appDirectory,
        ...(commanded ? ['--commands', join(source, 'commands.ts')] : []),
        ...(forecourt ? ['--policy', join(source, 'policy.ts')] : []),
      ],
      { stdio: 'pipe' },
    );
  }
  const commands = options.built ? join(appDirectory, 'server', 'commands.mjs') : join(source, 'commands.ts');
  const policy = options.built ? join(appDirectory, 'server', 'policy.mjs') : join(source, 'policy.ts');
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      'packages/mistri/src/server/index.ts',
      '--config',
      `${db}.json`,
      '--app',
      appDirectory,
      ...(commanded ? ['--commands', commands] : []),
      ...(forecourt ? ['--policy', policy] : []),
      ...(options.dev ? ['--dev'] : []),
      ...(options.jobs ? ['--jobs', join(source, 'jobs.ts')] : []),
      '--port',
      String(port),
    ],
    {
      env: {
        ...process.env,
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        MISTRI_OPEN: '0',
        ...(name === 'tick' ? { MISTRI_CLOCK: '2026-09-08T12:00:00Z' } : {}),
        ...(commanded
          ? {
              BETTER_AUTH_SECRET: 'disposable-forecourt-browser-secret-at-least-thirty-two-characters',
              MISTRI_AUTH_ADMIN_EMAIL: account.email,
              MISTRI_AUTH_ADMIN_PASSWORD: account.password,
            }
          : {}),
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    log += String(chunk);
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      /* A commanded sample loads its TypeScript commands before it listens:
         nine seconds on a quiet machine, past fifteen on a busy one. */
      const timer = setTimeout(() => done(new Error(`Sample startup timed out: ${log}`)), 30_000);
      const ready = () => {
        if (log.includes('Listening on ')) done();
      };
      const failed = () => done(new Error(`Sample exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        child.stdout.off('data', ready);
        child.off('exit', failed);
        child.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      child.stdout.on('data', ready);
      child.once('exit', failed);
      child.once('error', done);
      ready();
    });
    return { origin, db, stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}

/**
 * Follow the confirmation link a sign-up was sent. Where an App's sign-up is
 * open, `me` and the inbox wait for a proven address; a sample's mail service
 * is `log:`, so the link is a JSON line in the server's output.
 */
export async function confirmEmail(
  request: { get(url: string): Promise<{ ok(): boolean; text(): Promise<string> }> },
  log: () => string,
  email: string,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    for (const line of log().split('\n')) {
      if (!line.startsWith('{')) continue;
      let message: { to?: unknown; text?: unknown };
      try {
        message = JSON.parse(line) as { to?: unknown; text?: unknown };
      } catch {
        continue;
      }
      const link = typeof message.text === 'string' ? /https?:\/\/\S+verify-email\?token=\S+/.exec(message.text)?.[0] : undefined;
      if (!link || !JSON.stringify(message.to ?? '').includes(email)) continue;
      const answer = await request.get(link);
      if (!answer.ok()) throw new Error(`Confirming ${email} failed: ${await answer.text()}`);
      return;
    }
    if (Date.now() > deadline) throw new Error(`No confirmation link was sent to ${email}.`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
