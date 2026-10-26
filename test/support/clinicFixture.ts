/**
 * The clinic fixture (test/fixtures/apps/clinic) served as a deployment serves it, on SQLite or PostgreSQL: the
 * business tables seeded, its stores made by `mistri migrate stores up --app --policy`, an operator account made
 * first (the policy names it by id), and the App started by the public test kit with its policy and commands.
 *
 * On PostgreSQL the clinic gets a database of its own beside TABLEWALK_TEST_PG, made for the run and dropped after
 * it: a tenant App's database holds only its declared tables and its stores.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TestContext } from 'node:test';
import { createTestWorkspace, startTestApp, type TestWorkspace } from '../../packages/mistri/src/server/testing.ts';
import { createAppAccounts } from '../../packages/mistri/src/server/maintenance.ts';
import { ADDRESSES, seedPostgres, seedSqlite } from '../fixtures/databases/clinic/seed.mjs';

export const CLINIC = resolve('test/fixtures/apps/clinic');
export const POLICY = resolve(CLINIC, 'server/tenant-policy.ts');
export const COMMANDS = resolve(CLINIC, 'commands.ts');
export { ADDRESSES };
const ENTRY = resolve('packages/mistri/src/server/index.ts');
const TSX = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

export type Engine = 'sqlite' | 'postgres';

/** The CLI, as an operator runs it, in the workspace's environment. */
export function cli(workspace: TestWorkspace, args: readonly string[], env: Record<string, string>) {
  return spawnSync(process.execPath, ['--import', TSX, ENTRY, ...args], {
    encoding: 'utf8',
    cwd: workspace.directory,
    env: {
      PATH: process.env.PATH,
      ...env,
      TSX_TSCONFIG_PATH: resolve('tsconfig.json'),
      XDG_CONFIG_HOME: workspace.path('config'),
      HOME: workspace.directory,
      NODE_ENV: 'test',
    },
    timeout: 60_000,
  });
}

/** A database for the clinic: a SQLite file in the workspace, or a fresh PostgreSQL database dropped when the test ends. */
async function database(workspace: TestWorkspace, engine: Engine): Promise<string> {
  if (engine === 'sqlite') {
    const file = workspace.path('clinic.db');
    seedSqlite(file);
    return file;
  }
  const module = 'pg';
  type Client = { connect(): Promise<void>; query(sql: string): Promise<unknown>; end(): Promise<void> };
  const pg = (await import(module)) as { default: { Client: new (options: unknown) => Client } };
  const admin = new URL(process.env.TABLEWALK_TEST_PG!);
  const name = `clinic_${randomBytes(6).toString('hex')}`;
  const control = new pg.default.Client({ connectionString: admin.href });
  await control.connect();
  await control.query(`CREATE DATABASE ${name}`);
  await control.end();
  const url = new URL(admin.href);
  url.pathname = `/${name}`;
  const client = new pg.default.Client({ connectionString: url.href });
  await client.connect();
  try {
    await seedPostgres(client);
  } finally {
    await client.end();
  }
  workspace.own(async () => {
    const dropper = new pg.default.Client({ connectionString: admin.href });
    await dropper.connect();
    try {
      await dropper.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    } finally {
      await dropper.end();
    }
  });
  return url.href;
}

/**
 * The clinic served on `engine`. `operator` is the native account the policy lets create and suspend clinics in
 * Manage tenants: made before the start, as a deployment makes its own.
 */
export async function startClinic(t: TestContext, engine: Engine) {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const url = await database(workspace, engine);
  const config = await workspace.write('mistri.json', { connections: [{ name: 'clinic-db', url, writable: true }] });
  const environment = { MISTRI_AUDIT_KEY: randomBytes(32).toString('base64'), MISTRI_TEST_AUTH_LIMITS: 'off' };
  // The stores, as the docs say to make them: one command, with the server stopped.
  const up = cli(workspace, ['migrate', 'stores', 'up', '--app', CLINIC, '--policy', POLICY, '--config', config], environment);
  if (up.status !== 0) throw new Error(`migrate stores up failed (${up.status}): ${up.stdout}${up.stderr}`);
  // The operator's account, in the auth store the served App will open (its XDG_CONFIG_HOME is the workspace's).
  const operator = { email: 'operator@clinic.example.test', name: 'Olive Operator', password: randomBytes(18).toString('base64url') };
  const saved = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = workspace.path('config');
  let operatorId: string;
  try {
    [operatorId] = await createAppAccounts(CLINIC, [operator]);
  } finally {
    if (saved === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = saved;
  }
  const host = await startTestApp({
    workspace,
    directory: CLINIC,
    config,
    args: ['--policy', POLICY, '--commands', COMMANDS],
    environment: { ...environment, CLINIC_OPERATOR_ID: operatorId },
    timeoutMs: 60_000,
  });
  return { workspace, host, config, url, environment, operator: { ...operator, accountId: operatorId }, up };
}
export type Clinic = Awaited<ReturnType<typeof startClinic>>;
