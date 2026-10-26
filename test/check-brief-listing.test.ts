/**
 * What `mistri check` lists of an App's automation — a line per job, workflow and inbound endpoint, printed before
 * the App's verdict — is information, not a finding (TR12): `--brief` printed each as an `invalid-app` error once the
 * App had a real problem, and `--json` gave the first of them as the failed step's verdict.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores, type ProvisionStoresOptions, type StoresApp } from '../packages/mistri/src/server/maintenance.js';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);

const run = (args: string[], env: Record<string, string>): Promise<{ code: number; out: string; err: string }> =>
  new Promise((done) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...args],
      { cwd: ROOT, timeout: 180_000, env: { ...process.env, MISTRI_OPEN: '0', ...env } },
      (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
    );
  });

test('a broken App with jobs: --brief says its problem and nothing of the jobs it lists', { timeout: 300_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-brief-listing-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = join(directory, 'desk.db');
  const raw = new DatabaseSync(db);
  raw.exec(`CREATE TABLE item (id INTEGER PRIMARY KEY, status TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO item VALUES (1, 'open', 0);`);
  raw.close();
  migrateSqliteCommandJournal(db);
  const dir = join(directory, 'desk');
  mkdirSync(dir);
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { desk: { connection: 'desk', default: true } },
      resources: { item: { access: 'write' } },
      auth: {
        providers: ['email'],
        store: join(directory, 'auth.db'),
        roles: { integration: { read: true, service: true, commands: ['close', 'sweep'] } },
      },
      // The one real problem: a filter on a column the table does not have.
      views: { items: { kind: 'list', from: 'item', filters: ['stauts'] } },
      home: 'items',
    }),
  );
  writeFileSync(
    join(dir, 'commands.mjs'),
    `import { defineCommand, defineCommands, field } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ close: defineCommand({ source: 'desk', target: 'item', input: { note: field.text({ max: 40 }) },
  async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); } }),
  sweep: defineCommand({ source: 'desk', target: 'item', targets: 'none', input: {}, async handle() {} }) });
`,
  );
  writeFileSync(
    join(dir, 'jobs.mjs'),
    `import { defineInbound, defineJob, defineJobs, hmac } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({ nightly: defineJob({ every: '0 2 * * *', timezone: 'UTC', runAs: 'provider', command: 'sweep' }) },
  { principals: { provider: { roles: ['integration'] } }, inbound: { closed: defineInbound({
  verify: hmac({ secret: 'DESK_CALLBACK_SECRET', signature: { header: 'x-signature' }, timestamp: { header: 'x-timestamp', window: '5 minutes' } }),
  runAs: 'provider', command: 'close', key: body => body.id, input: body => ({ note: body.note }), target: body => ({ id: body.item }) }) } });
`,
  );
  // The job store, provisioned as an operator does, so that the App's one problem is the view's.
  const loaded = async (file: string) => ((await import(pathToFileURL(join(dir, file)).href)) as { default: unknown }).default;
  await provisionStores(
    { sqlite: db },
    {
      app: { id: 'desk', commands: (await loaded('commands.mjs')) as NonNullable<StoresApp['commands']> },
      jobs: (await loaded('jobs.mjs')) as NonNullable<ProvisionStoresOptions['jobs']>,
    },
  );
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: db, writable: true }] }));
  const env = {
    XDG_CONFIG_HOME: join(directory, 'config'),
    BETTER_AUTH_SECRET: 'synthetic-brief-listing-secret-at-least-thirty-two-characters',
    DESK_CALLBACK_SECRET: 'synthetic-callback-secret',
  };
  const args = ['check', '--config', config, '--app', dir, '--commands', join(dir, 'commands.mjs'), '--jobs', join(dir, 'jobs.mjs')];

  const brief = await run([...args, '--brief'], env);
  assert.notEqual(brief.code, 0, `${brief.out}\n${brief.err}`);
  const lines = brief.out.trim().split('\n');
  assert.ok(lines.length >= 1 && lines.some((line) => /"stauts"/.test(line)), brief.out);
  assert.deepEqual(
    lines.filter((line) => /\b(jobs|inbound|workflows|integrations): /.test(line)),
    [],
    `the automation listing is not a problem:\n${brief.out}`,
  );

  const json = JSON.parse((await run([...args, '--json'], env)).out) as {
    steps: Array<{ step: string; detail: string }>;
    problems: Array<{ severity: string; message: string }>;
  };
  const validation = json.steps.find((step) => step.step === 'validation')!;
  assert.match(validation.detail, /^Desk: 1 problem$/);
  const listed = json.problems.filter((found) => /^(jobs|inbound): /.test(found.message));
  assert.equal(listed.length, 2, JSON.stringify(json.problems));
  assert.ok(
    listed.every((found) => found.severity === 'info'),
    JSON.stringify(listed),
  );
});
