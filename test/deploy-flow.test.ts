/**
 * `mistri deploy` end to end against a fake runner (packages/mistri/src/server/deploy): the plan and its refusals,
 * the order of the run, the fingerprint loop, the record, rollback. Nothing here calls wrangler, the network or a
 * database server; the real runner (effects.ts) is the one file these do not reach.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { openMigrationDb } from '@mistriwork/engine/server/migrate/database.js';
import { parseDeployArgs } from '../packages/mistri/src/server/deploy/args.js';
import { runDeployCommand } from '../packages/mistri/src/server/deploy/command.js';
import { parseJsonc } from '../packages/mistri/src/server/deploy/config.js';
import { initFiles, referencedNames, writeInit } from '../packages/mistri/src/server/deploy/init.js';
import { sqlLedger } from '../packages/mistri/src/server/deploy/ledger.js';
import { rollbackTarget } from '../packages/mistri/src/server/deploy/manage.js';
import type {
  CheckFinding,
  DeployLedger,
  DeployRow,
  DeployRunner,
  HttpAnswer,
  PendingMigration,
} from '../packages/mistri/src/server/deploy/types.js';

const TOKEN = 't'.repeat(40);
let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-')));
  process.chdir(dir);
  writeFileSync('mistri.json', JSON.stringify({ connections: [{ url: 'postgres://u:${APP_DB_PASSWORD}@h/db?x=${OTHER}' }] }));
  writeInit({
    app: 'apps/shop',
    config: 'mistri.json',
    dir: join(dir, 'deploy/cloudflare'),
    force: false,
    configText: readFileSync('mistri.json', 'utf8'),
  });
});
afterEach(() => {
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

interface Script {
  check?: CheckFinding[];
  pending?: PendingMigration[];
  secrets?: string[];
  dirty?: boolean;
  token?: string | undefined;
  backupExit?: number;
  migrateFails?: boolean;
  /** The history problems migrations.pending reports (a recorded file missing from the directory). */
  problems?: string[];
  connections?: string[];
  /** `wrangler deployments list --json`, as wrangler prints it; absent, the text form. */
  deployments?: unknown[];
  /** What `GET /` answers instead of the page, by url. */
  pages?: Record<string, HttpAnswer>;
  /** `/readyz` by elapsed seconds since the first poll: the answers in order, the last one repeating. */
  readyz?: Array<HttpAnswer | { error: string }>;
}

function memoryLedger(rows: DeployRow[], ensured: string[] = []): DeployLedger {
  return {
    async ensure() {
      ensured.push('ensure');
    },
    async start(row) {
      rows.unshift({ ...row });
    },
    async finish(id, patch) {
      Object.assign(
        rows.find((row) => row.id === id)!,
        patch,
      );
    },
    async recent(limit) {
      return rows.slice(0, limit);
    },
    async close() {},
  };
}

function fake(script: Script = {}, rows: DeployRow[] = []) {
  const calls: string[] = [];
  const said: string[] = [];
  const ensured: string[] = [];
  let clock = 1_800_000_000_000;
  let ids = 0;
  let polls = 0;
  let deployId = '';
  const runner: DeployRunner = {
    say: (line) => said.push(line),
    confirm: async () => (calls.push('confirm'), true),
    async wrangler(args) {
      calls.push(`wrangler ${args.join(' ')}`);
      if (args[0] === 'secret')
        return {
          code: 0,
          stdout: JSON.stringify(
            (script.secrets ?? ['BETTER_AUTH_SECRET', 'APP_DB_PASSWORD', 'OTHER', 'MISTRI_RESTART_TOKEN']).map((name) => ({
              name,
              type: 'secret_text',
            })),
          ),
          stderr: '',
        };
      if (args[0] === 'deploy') {
        deployId = args[2].split(':')[1];
        return { code: 0, stdout: 'Current Version ID: 11111111-2222-3333-4444-555555555555\n', stderr: '' };
      }
      if (args[0] === 'rollback') return { code: 0, stdout: '', stderr: '' };
      if (args[0] === 'deployments')
        return {
          code: 0,
          stdout: script.deployments ? JSON.stringify(script.deployments) : 'DEPLOYMENTS',
          stderr: '',
        };
      return { code: 0, stdout: '', stderr: '' };
    },
    async http(url, init) {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/readyz')) {
        /* The old container answers first, as it does until a restart reaches it. */
        const answers = script.readyz ?? [
          { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', deploy: 'old', build: 'build-old' }) },
          { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', deploy: deployId, build: 'build-new' }) },
        ];
        return answers[Math.min(polls++, answers.length - 1)];
      }
      if (script.pages?.[url]) return script.pages[url];
      if (url.endsWith('/app.js')) return { status: 200, headers: {}, body: '' };
      return { status: 200, headers: {}, body: '<script type="module" src="/app.js"></script>' };
    },
    async hook(command) {
      calls.push(`hook ${command}`);
      return command.includes('backup') ? (script.backupExit ?? 0) : 0;
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    newId: () => `00000000-0000-0000-0000-00000000000${++ids}`,
    env: (name) => (name === 'MISTRI_RESTART_TOKEN' ? ('token' in script ? script.token : TOKEN) : undefined),
    git: async () => ({ sha: 'abcdef1234567', dirty: script.dirty ?? false }),
    operator: () => 'me@laptop',
    check: async () => ({ problems: script.check ?? [], connections: script.connections ?? [] }),
    build: async () => (calls.push('build'), { out: 'build/shop', buildId: 'build-new' }),
    migrations: {
      pending: async () => ({ files: script.pending ?? [], problems: script.problems ?? [] }),
      up: async () => {
        calls.push('migrate');
        if (script.migrateFails) throw new Error('V2__x.sql: boom');
        return (script.pending ?? []).map((file) => file.script);
      },
    },
    ledger: async () => memoryLedger(rows, ensured),
  };
  return { runner, calls, said, rows, ensured };
}

async function run(argv: string[], script?: Script, rows?: DeployRow[]) {
  const made = fake(script, rows);
  const printed: string[] = [];
  const log = console.log;
  const error = console.error;
  console.log = (...a: unknown[]) => printed.push(a.join(' '));
  console.error = (...a: unknown[]) => printed.push(a.join(' '));
  try {
    const code = await runDeployCommand(argv, { runner: async () => made.runner, env: () => undefined });
    return { code, ...made, printed };
  } finally {
    console.log = log;
    console.error = error;
  }
}

const base = ['--dir', 'deploy/cloudflare'];
const contract: PendingMigration = { script: 'V3__drop.sql', sql: '-- mistri: contract\nALTER TABLE t DROP COLUMN c;\n' };
const expand: PendingMigration = { script: 'V2__add.sql', sql: 'ALTER TABLE t ADD COLUMN d int;\n' };

test('init writes the Worker from the build request and names every secret the configuration reads', () => {
  assert.deepEqual(referencedNames('a ${X} b ${Y} c ${X}'), ['X', 'Y']);
  const index = readFileSync('deploy/cloudflare/src/index.ts', 'utf8');
  assert.match(index, /secrets: \['BETTER_AUTH_SECRET', 'APP_DB_PASSWORD', 'OTHER', 'MISTRI_AUDIT_KEY'/);
  assert.match(index, /from '@mistriwork\/cloudflare'/);
  const wrangler = parseJsonc(readFileSync('deploy/cloudflare/wrangler.jsonc', 'utf8')) as any;
  assert.equal(wrangler.name, 'shop');
  assert.equal(wrangler.containers[0].image, '../../Dockerfile');
  assert.equal(wrangler.vars.MISTRI_PUBLIC_URL, 'https://app.example.com');
  const stored = JSON.parse(readFileSync('deploy/cloudflare/mistri-deploy.json', 'utf8'));
  assert.deepEqual([stored.app, stored.config], ['apps/shop', 'mistri.json']);
  assert.equal(JSON.parse(readFileSync('deploy/cloudflare/package.json', 'utf8')).devDependencies.wrangler, '^4.0.0');
  assert.equal(initFiles({ app: 'a', dir: join(dir, 'd'), force: false }).length, 4);
});

test('init refuses to overwrite without --force and creates nothing else', async () => {
  const before = readFileSync('deploy/cloudflare/src/index.ts', 'utf8');
  writeFileSync('deploy/cloudflare/src/index.ts', 'mine');
  const refused = await run(['init', 'cloudflare', '--app', 'apps/shop']);
  assert.equal(refused.code, 1);
  assert.match(refused.printed.join('\n'), /already exist.*--force/);
  assert.equal(readFileSync('deploy/cloudflare/src/index.ts', 'utf8'), 'mine');
  const forced = await run(['init', 'cloudflare', '--app', 'apps/shop', '--force']);
  assert.equal(forced.code, 0);
  assert.equal(readFileSync('deploy/cloudflare/src/index.ts', 'utf8'), before);
  assert.equal(existsSync('Dockerfile'), false);
});

test('flags: the migrate url falls back to the environment, --roll and --verbose are read, and a bad timeout is refused', () => {
  const parsed = parseDeployArgs(['--roll-timeout', '5', '--yes'], (name) =>
    name === 'MISTRI_MIGRATE_URL' ? 'postgres://direct' : undefined,
  );
  assert.equal(parsed.flags.migrateUrl, 'postgres://direct');
  assert.equal(parsed.flags.rollTimeoutMs, 300_000);
  assert.equal(parsed.flags.roll, false);
  assert.equal(parsed.flags.verbose, false);
  const verifying = parseDeployArgs(['--roll', '--verbose'], () => undefined);
  assert.equal(verifying.flags.roll, true);
  assert.equal(verifying.flags.verbose, true);
  assert.throws(() => parseDeployArgs(['--roll-timeout', 'soon'], () => undefined), /number of minutes/);
  assert.throws(() => parseDeployArgs(['--nope'], () => undefined), /unknown option/);
});

test('the plan refuses a dirty tree, a missing secret, a failed check and a missing restart token, and changes nothing', async () => {
  const result = await run([...base, '--yes'], {
    dirty: true,
    secrets: ['BETTER_AUTH_SECRET'],
    token: undefined,
    check: [{ code: 'store-on-disk', severity: 'error', message: 'sessions are on a disk.', fix: 'use postgres' }],
  });
  assert.equal(result.code, 7);
  const text = result.said.join('\n');
  assert.match(text, /uncommitted changes/);
  assert.match(text, /secret APP_DB_PASSWORD is not set/);
  assert.match(text, /secret MISTRI_RESTART_TOKEN is not set/);
  assert.match(text, /check --deploy: sessions are on a disk/);
  assert.match(text, /MISTRI_RESTART_TOKEN must be set here/);
  assert.deepEqual(
    result.calls.filter((c) => !c.startsWith('wrangler secret')),
    [],
  );
});

test('a contract migration refuses unless --allow-contract, and the other pending files are only named', async () => {
  const refused = await run([...base, '--yes'], { pending: [expand, contract] });
  assert.equal(refused.code, 7);
  assert.match(refused.said.join('\n'), /V3__drop\.sql is a contract step.*--allow-contract/);
  assert.ok(!refused.calls.includes('migrate'));
  const allowed = await run([...base, '--yes', '--allow-contract'], { pending: [expand, contract] });
  assert.equal(allowed.code, 0);
  assert.equal(allowed.rows[0].contract, true);
  assert.deepEqual(allowed.rows[0].migrations, ['V2__add.sql', 'V3__drop.sql']);
});

test('--dry-run prints the plan and does nothing; a declined confirmation does nothing', async () => {
  const dry = await run([...base, '--dry-run'], { pending: [expand] });
  assert.equal(dry.code, 0);
  assert.match(dry.said.join('\n'), /Dry run: nothing was changed/);
  assert.ok(!dry.calls.some((c) => c === 'build' || c === 'migrate' || c.startsWith('wrangler deploy')));
  assert.equal(dry.rows.length, 0);
});

test('a deploy runs build, backup check, migrations, wrangler deploy, the roll and the smoke in that order, and records it', async () => {
  const result = await run([...base, '--yes', '--backup-check', './backup-fresh.sh', '--smoke', './smoke.sh'], { pending: [expand] });
  assert.equal(result.code, 0, result.said.join('\n'));
  const order = result.calls.filter(
    (c) => !c.startsWith('wrangler secret') && !c.includes('/readyz') && !c.includes('/__mistri/status') && !c.endsWith('/app.js'),
  );
  assert.deepEqual(order.slice(0, 4), ['build', 'hook ./backup-fresh.sh', 'migrate', order[3]]);
  assert.match(order[3], /^wrangler deploy --var MISTRI_DEPLOY_ID:00000000-0000-0000-0000-000000000001$/);
  assert.equal(order[4], `POST https://app.example.com/`);
  assert.equal(order.at(-1), 'hook ./smoke.sh');
  const [row] = result.rows;
  assert.deepEqual(
    [row.result, row.buildId, row.workerVersion, row.gitSha, row.operator, row.migrations],
    ['ok', 'build-new', '11111111-2222-3333-4444-555555555555', 'abcdef1234567', 'me@laptop', ['V2__add.sql']],
  );
  assert.ok(row.finishedAt);
});

test('a failing backup check refuses before anything is migrated or deployed, and says so in the record', async () => {
  const result = await run([...base, '--yes', '--backup-check', './backup-stale.sh'], { pending: [expand], backupExit: 3 });
  assert.equal(result.code, 1);
  assert.ok(!result.calls.includes('migrate') && !result.calls.some((c) => c.startsWith('wrangler deploy')));
  assert.equal(result.rows[0].result, 'failed');
  assert.match(result.rows[0].note!, /backup check exited 3/);
});

test('a failing migration leaves the code alone and says the old code still runs', async () => {
  const result = await run([...base, '--yes'], { pending: [expand], migrateFails: true });
  assert.equal(result.code, 1);
  assert.ok(!result.calls.some((c) => c.startsWith('wrangler deploy')));
  assert.match(result.rows[0].note!, /V2__x\.sql: boom.*still runs/);
});

test('the roll restarts a container that answers with the old fingerprint, waits through a start, and finishes on the new one', async () => {
  const old: HttpAnswer = { status: 200, headers: {}, body: JSON.stringify({ status: 'ok', deploy: 'old', build: 'build-old' }) };
  const result = await run([...base, '--yes'], {
    readyz: [
      old,
      { error: 'connection refused' },
      { status: 503, headers: {}, body: '{}' },
      old,
      { status: 200, headers: {}, body: JSON.stringify({ deploy: '00000000-0000-0000-0000-000000000001', build: 'build-new' }) },
    ],
  });
  assert.equal(result.code, 0, result.said.join('\n'));
  const restarts = result.calls.filter((c) => c === 'POST https://app.example.com/');
  /* One at once, and one more only after the gap: a container still starting is not restarted under itself. */
  assert.ok(restarts.length >= 1 && restarts.length <= 2, String(restarts.length));
  assert.match(result.said.join('\n'), /restart 1: sent; saw deploy old, build build-old/);
});

test('a roll that never matches fails after --roll-timeout with what it last saw, and records the failure', async () => {
  const stale: HttpAnswer = { status: 200, headers: {}, body: JSON.stringify({ deploy: 'old', build: 'build-old' }) };
  const result = await run([...base, '--yes', '--roll-timeout', '3'], { readyz: [stale] });
  assert.equal(result.code, 1);
  assert.match(result.said.join('\n'), /never reported the new fingerprint: last saw deploy old, build build-old after \d+ restarts?/);
  assert.equal(result.rows[0].result, 'failed');
});

test('smoke fails on a page that does not answer, a missing script, or a public process timing entry', async () => {
  const noPage = fake();
  noPage.runner.http = async (url) =>
    url.endsWith('/readyz')
      ? { status: 200, headers: {}, body: JSON.stringify({ deploy: 'x', build: 'b' }) }
      : { status: 502, headers: {}, body: '' };
  const { smoke } = await import('../packages/mistri/src/server/deploy/run.js');
  assert.match((await smoke(noPage.runner, 'https://a.test', undefined)).join(), /answered 502/);
  noPage.runner.http = async (url): Promise<HttpAnswer> =>
    url.endsWith('.js')
      ? { status: 404, headers: {}, body: '' }
      : { status: 200, headers: { 'server-timing': 'db;dur=3, proc;dur=1' }, body: '<script src="/a.js"></script>' };
  const problems = (await smoke(noPage.runner, 'https://a.test', undefined)).join('\n');
  assert.match(problems, /proc entry/);
  assert.match(problems, /script \/a\.js answered 404/);
});

test('rollback goes to the previous successful deploy, verifies its fingerprint and records it; a contract migration since refuses', async () => {
  const row = (id: string, at: string, extra: Partial<DeployRow> = {}): DeployRow => ({
    id,
    startedAt: at,
    finishedAt: at,
    operator: 'o',
    gitSha: 'g',
    buildId: `build-${id}`,
    workerVersion: `ver-${id}`,
    migrations: [],
    contract: false,
    result: 'ok',
    rollbackOf: null,
    note: null,
    ...extra,
  });
  const older = row('aaaaaaaa-1', '2026-10-01T00:00:00.000Z');
  const newer = row('bbbbbbbb-2', '2026-10-02T00:00:00.000Z');
  const ok = await run(
    [...base, 'rollback', '--yes'],
    { readyz: [{ status: 200, headers: {}, body: JSON.stringify({ deploy: 'aaaaaaaa-1', build: 'build-aaaaaaaa-1' }) }] },
    [newer, older],
  );
  assert.equal(ok.code, 0, ok.said.join('\n'));
  assert.ok(ok.calls.some((c) => c.startsWith('wrangler rollback ver-aaaaaaaa-1')));
  assert.equal(ok.rows[0].rollbackOf, 'aaaaaaaa-1');
  assert.equal(ok.rows[0].result, 'ok');

  const contractLater = row('bbbbbbbb-2', '2026-10-02T00:00:00.000Z', { contract: true, migrations: ['V9__drop.sql'] });
  const refused = await run([...base, 'rollback', '--yes'], {}, [contractLater, older]);
  assert.equal(refused.code, 7);
  assert.match(refused.said.join('\n'), /contract migration \(V9__drop\.sql\).*only go forward/);
  assert.ok(!refused.calls.some((c) => c.startsWith('wrangler rollback')));

  assert.deepEqual(rollbackTarget([newer], undefined), { refusal: 'there is no earlier successful deploy recorded to roll back to.' });
  assert.ok('target' in rollbackTarget([newer, older], 'aaaaaaaa'));
  assert.ok('refusal' in rollbackTarget([row('c', '2026-10-03T00:00:00.000Z', { result: 'failed' }), newer, older], 'c'));
});

test('status lists the recorded deploys beside wrangler deployments list', async () => {
  const rows: DeployRow[] = [
    {
      id: 'abcdef12-0',
      startedAt: '2026-10-02T00:00:00.000Z',
      finishedAt: null,
      operator: 'o',
      gitSha: 'g',
      buildId: 'b1',
      workerVersion: 'v',
      migrations: ['V2.sql'],
      contract: false,
      result: 'ok',
      rollbackOf: null,
      note: null,
    },
  ];
  const result = await run([...base, 'status'], {}, rows);
  assert.equal(result.code, 0);
  const text = result.said.join('\n');
  assert.match(text, /abcdef12\s+ok\s+build b1.*version v.*migrations V2\.sql/);
  assert.equal(result.ensured.length, 0, 'a read creates no table');
});

test('the record is a table in the migration database, created if absent, and reads back what was written', async () => {
  const file = join(dir, 'm.db');
  const db = await openMigrationDb(file, [], true);
  const ledger = sqlLedger(db);
  await ledger.ensure();
  await ledger.ensure();
  const row: DeployRow = {
    id: 'one',
    startedAt: '2026-10-01T00:00:00.000Z',
    finishedAt: null,
    operator: 'o',
    gitSha: null,
    buildId: '',
    workerVersion: null,
    migrations: [],
    contract: false,
    result: 'running',
    rollbackOf: null,
    note: null,
  };
  await ledger.start(row);
  await ledger.start({ ...row, id: 'two', startedAt: '2026-10-02T00:00:00.000Z', rollbackOf: 'one' });
  await ledger.finish('one', {
    buildId: 'b',
    migrations: ['V1__a.sql'],
    contract: true,
    result: 'ok',
    note: null,
    finishedAt: '2026-10-01T00:01:00.000Z',
  });
  const [two, one] = await ledger.recent(10);
  assert.equal(two.id, 'two');
  assert.equal(two.rollbackOf, 'one');
  assert.deepEqual([one.result, one.buildId, one.migrations, one.contract], ['ok', 'b', ['V1__a.sql'], true]);
  await ledger.close();
});

const row = (id: string, at: string, extra: Partial<DeployRow> = {}): DeployRow => ({
  id,
  startedAt: at,
  finishedAt: at,
  operator: 'o',
  gitSha: 'g',
  buildId: `build-${id}`,
  workerVersion: `ver-${id}`,
  migrations: [],
  contract: false,
  result: 'ok',
  rollbackOf: null,
  note: null,
  ...extra,
});
const ready = (deploy: string, build: string): HttpAnswer => ({ status: 200, headers: {}, body: JSON.stringify({ deploy, build }) });

test('a history problem is a refusal that names it, and nothing is migrated', async () => {
  const result = await run([...base, '--yes'], {
    pending: [expand],
    problems: ['V1__init.sql was applied but is no longer in the migrations directory.', 'V2__add.sql changed since it was applied.'],
  });
  assert.equal(result.code, 7);
  const text = result.said.join('\n');
  assert.match(text, /REFUSED: migrations: V1__init\.sql was applied but is no longer/);
  assert.match(text, /REFUSED: migrations: V2__add\.sql changed/);
  assert.ok(!result.calls.includes('migrate') && !result.calls.includes('build'));
});

test('--migrations and --connection-limit are read; a bad limit is refused', () => {
  const parsed = parseDeployArgs(['--migrations', 'db/migrations', '--connection-limit', '22', '--verbose'], () => undefined);
  assert.equal(parsed.flags.migrationsDir, 'db/migrations');
  assert.equal(parsed.flags.connectionLimit, 22);
  assert.equal(parsed.flags.verbose, true);
  assert.throws(() => parseDeployArgs(['--connection-limit', 'many'], () => undefined), /connections the database allows/);
});

test('server timing reads as on only for "1"; the plan prints a count of warnings, three of them and the connection math', async () => {
  const wrangler = readFileSync('deploy/cloudflare/wrangler.jsonc', 'utf8');
  const withTiming = (value: string) =>
    writeFileSync('deploy/cloudflare/wrangler.jsonc', wrangler.replace('"vars": {', `"vars": {\n"MISTRI_SERVER_TIMING": "${value}",`));
  withTiming('0');
  const off = await run([...base, '--dry-run']);
  assert.match(off.said.join('\n'), /server timing off/);
  assert.ok(!off.said.join('\n').includes('Server-Timing is on'));
  withTiming('1');
  const on = await run([...base, '--dry-run']);
  assert.match(on.said.join('\n'), /server timing on/);
  assert.match(on.said.join('\n'), /Server-Timing is on with no MISTRI_SERVER_TIMING_TOKEN/);

  const many = Array.from({ length: 38 }, (_, i): CheckFinding => ({ code: 'w', severity: 'warning', message: `warning number ${i}.` }));
  const connections = ['shop: 1 process x 16 connections = 16 (limit 22)'];
  const brief = await run([...base, '--dry-run'], { check: many, connections });
  const text = brief.said.join('\n');
  assert.match(text, /warnings\s+40 \(the first 3 below; --verbose for all\)/);
  assert.match(text, /warning number 0\./);
  assert.ok(!text.includes('warning number 3.'));
  assert.match(text, /connections\s+shop: 1 process x 16 connections = 16 \(limit 22\)/);
  const all = await run([...base, '--dry-run', '--verbose'], { check: many });
  assert.match(all.said.join('\n'), /warning number 37\./);
});

test('init names the Worker after the App, reads every source of a secret, and sets no pooler', async () => {
  rmSync('deploy', { recursive: true });
  writeFileSync('app-entry.ts', "export default { db: '${ENTRY_DB_URL}', title: `${title}` };\n");
  writeFileSync('policy.ts', 'const key = process.env.POLICY_TOKEN; const region = process.env.POLICY_REGION; export default {};\n');
  writeFileSync(
    'mistri.json',
    JSON.stringify({ apps: [{ dir: 'apps/shop', env: ['STORE_REGION', { name: 'STRIPE_KEY', secret: true }] }] }),
  );
  const printed: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => printed.push(a.join(' '));
  try {
    const code = await runDeployCommand(
      [
        'init',
        'cloudflare',
        '--app',
        'apps/shop',
        '--app-entry',
        'app-entry.ts',
        '--policy',
        'policy.ts',
        '--config',
        'mistri.json',
        '--dir',
        join(dir, 'deploy/cloudflare'),
      ],
      { appName: async () => 'Shop Front & Co', env: () => undefined },
    );
    assert.equal(code, 0);
  } finally {
    console.log = log;
  }
  assert.ok(
    printed.some((line) => line === 'wrote deploy/cloudflare/wrangler.jsonc'),
    printed.join('\n'),
  );
  const wrangler = parseJsonc(readFileSync('deploy/cloudflare/wrangler.jsonc', 'utf8')) as any;
  assert.equal(wrangler.name, 'shop-front-co');
  assert.ok(!('MISTRI_POOLER' in wrangler.vars));
  const index = readFileSync('deploy/cloudflare/src/index.ts', 'utf8');
  const listed = (key: string) => (new RegExp(`${key}: \\[([^\\]]*)\\]`).exec(index)![1].match(/[A-Z_]+/g) ?? []) as string[];
  const secrets = listed('secrets');
  for (const name of [
    'BETTER_AUTH_SECRET',
    'ENTRY_DB_URL',
    'MISTRI_AUDIT_KEY',
    'MISTRI_FORM_KEY',
    'MISTRI_SECRETS_KEY',
    'MISTRI_SERVER_TIMING_TOKEN',
    'POLICY_TOKEN',
    'STRIPE_KEY',
  ])
    assert.ok(secrets.includes(name), name);
  assert.ok(!secrets.includes('title') && !secrets.includes('TITLE'));
  const vars = listed('vars');
  for (const name of [
    'MISTRI_PUBLIC_URL',
    'MISTRI_ALLOWED_HOSTS',
    'MISTRI_WRITE_POOL',
    'MISTRI_READ_POOL',
    'MISTRI_AUTH_POOL',
    'MISTRI_SERVER_TIMING',
    'STORE_REGION',
    'POLICY_REGION',
  ])
    assert.ok(vars.includes(name), name);
  const stored = JSON.parse(readFileSync('deploy/cloudflare/mistri-deploy.json', 'utf8'));
  assert.deepEqual(
    stored.secrets,
    ['BETTER_AUTH_SECRET', 'ENTRY_DB_URL', 'POLICY_TOKEN'].filter((name) => stored.secrets.includes(name)),
  );
  assert.ok(stored.optionalSecrets.includes('MISTRI_AUDIT_KEY') && !stored.secrets.includes('MISTRI_AUDIT_KEY'));
  const pinned = JSON.parse(readFileSync('deploy/cloudflare/package.json', 'utf8')).dependencies['@mistriwork/cloudflare'];
  assert.equal(pinned, JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8')).version);
});

test('an optional secret that is not set is only noted, never a refusal', async () => {
  const result = await run([...base, '--dry-run']);
  assert.equal(result.code, 0);
  assert.match(result.said.join('\n'), /optional, not set: MISTRI_AUDIT_KEY/);
});

test('the instance type is read from the container, either spelling, or from the Worker source', async () => {
  const { readWorker } = await import('../packages/mistri/src/server/deploy/config.js');
  assert.equal(readWorker('deploy/cloudflare').instanceType, 'basic');
  const text = readFileSync('deploy/cloudflare/wrangler.jsonc', 'utf8');
  writeFileSync('deploy/cloudflare/wrangler.jsonc', text.replace('"instance_type": "basic"', '"instanceType": "standard-1"'));
  assert.equal(readWorker('deploy/cloudflare').instanceType, 'standard-1');
  writeFileSync('deploy/cloudflare/wrangler.jsonc', text.replace('"instance_type": "basic",', ''));
  assert.equal(readWorker('deploy/cloudflare').instanceType, undefined);
  writeFileSync('deploy/cloudflare/src/index.ts', "static override options = { instanceType: 'standard-2' };\n");
  assert.equal(readWorker('deploy/cloudflare').instanceType, 'standard-2');
});

test('the address a deploy sends its restart token to is https, or http on this machine only', async () => {
  const { readWorker } = await import('../packages/mistri/src/server/deploy/config.js');
  const text = readFileSync('deploy/cloudflare/wrangler.jsonc', 'utf8');
  const at = (url: string) => {
    writeFileSync('deploy/cloudflare/wrangler.jsonc', text.replace('"https://app.example.com"', JSON.stringify(url)));
    return () => readWorker('deploy/cloudflare').url;
  };
  try {
    for (const url of [
      'http://app.example.com',
      'http://203.0.113.9:8080',
      'ftp://app.example.com',
      'app.example.com',
      'http://localhost.example.com',
    ])
      assert.throws(at(url), /must be https:\/\//, url);
    for (const url of ['https://app.example.com', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787'])
      assert.equal(at(url)(), url, url);
  } finally {
    writeFileSync('deploy/cloudflare/wrangler.jsonc', text);
  }
});

test('init prints a path under the working directory relative to it, and one outside it in full', () => {
  const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'deploy-out-')));
  try {
    const outside = writeInit({ app: 'apps/shop', dir: join(elsewhere, 'd'), force: false });
    assert.ok(
      outside.every((path) => path.startsWith(elsewhere)),
      outside.join(),
    );
    const inside = writeInit({ app: 'apps/shop', dir: join(dir, 'other'), force: false });
    assert.ok(inside.includes('other/wrangler.jsonc'), inside.join());
  } finally {
    rmSync(elsewhere, { recursive: true, force: true });
  }
});

test('read-only commands create nothing: status and a rollback dry run never call ensure', async () => {
  const older = row('aaaaaaaa-1', '2026-10-01T00:00:00.000Z');
  const newer = row('bbbbbbbb-2', '2026-10-02T00:00:00.000Z');
  const status = await run([...base, 'status'], {}, []);
  assert.equal(status.code, 0);
  assert.match(status.said.join('\n'), /none yet/);
  assert.equal(status.ensured.length, 0);
  const dry = await run([...base, 'rollback', '--dry-run'], {}, [newer, older]);
  assert.equal(dry.code, 0);
  assert.equal(dry.ensured.length, 0);
  const real = await run([...base, 'rollback', '--yes'], { readyz: [ready('aaaaaaaa-1', 'build-aaaaaaaa-1')] }, [newer, older]);
  assert.equal(real.code, 0);
  assert.equal(real.ensured.length, 1);
});

test('status shows the live fingerprint and its record, the recorded deploys with versions, and only the newest five deployments', async () => {
  const rows = [row('bbbbbbbb-2', '2026-10-02T00:00:00.000Z'), row('aaaaaaaa-1', '2026-10-01T00:00:00.000Z')];
  const deployments = Array.from({ length: 8 }, (_, i) => ({
    id: `d${i}`,
    created_on: `2026-10-0${i + 1}T00:00:00.000Z`,
    source: i % 2 ? 'wrangler' : 'api',
    versions: [{ version_id: `0000000${i}-aaaa-bbbb-cccc-dddddddddddd`, percentage: 100 }],
  }));
  const result = await run([...base, 'status'], { readyz: [ready('bbbbbbbb-2', 'build-bbbbbbbb-2')], deployments }, rows);
  const text = result.said.join('\n');
  assert.match(text, /Live .*deploy bbbbbbbb-2, build build-bbbbbbbb-2/);
  assert.match(text, /matches deploy bbbbbbbb \(ok\)/);
  assert.ok(text.indexOf('bbbbbbbb  ok') < text.indexOf('aaaaaaaa  ok'), 'newest first');
  assert.match(text, /version ver-bbbbbbbb-2/);
  const listed = text
    .split('Cloudflare')[1]
    .split('\n')
    .filter((l) => /\d{4}-\d\d-\d\dT/.test(l));
  assert.equal(listed.length, 5);
  assert.match(listed[0], /2026-10-08.*00000007-aaaa-bbbb-cccc-dddddddddddd\s+\(active\)/);
  assert.ok(!text.includes('2026-10-03T'));
});

test('a roll that matches says it was verified, and a restart the Worker refuses is explained', async () => {
  const ok = await run([...base, '--yes']);
  assert.match(ok.said.join('\n'), /  verified: deploy 00000000 build build-new after 1 restart, 0m05s/);
  /* The fake answers every POST with the page, so a refused restart is a fake of its own. */
  const made = fake({ readyz: [ready('old', 'build-old'), ready('00000000-0000-0000-0000-000000000001', 'build-new')] });
  const http = made.runner.http;
  made.runner.http = async (url, init) => (init?.method === 'POST' ? { status: 405, headers: {}, body: '' } : http(url, init));
  const { rollTo } = await import('../packages/mistri/src/server/deploy/run.js');
  assert.deepEqual(
    await rollTo(made.runner, 'https://a.test', { deployId: '00000000-0000-0000-0000-000000000001', buildId: 'build-new' }, TOKEN, 600_000),
    { ok: true },
  );
  assert.match(
    made.said.join('\n'),
    /restart 1: the Worker answered 405 \(the serving Worker does not take the x-mistri-restart header yet/,
  );
  made.runner.http = async (url, init) => (init?.method === 'POST' ? { status: 500, headers: {}, body: '' } : http(url, init));
  const other = fake({ readyz: [ready('old', 'build-old'), ready('x', 'b')] });
  other.runner.http = async (url, init) =>
    init?.method === 'POST'
      ? { status: 500, headers: {}, body: '' }
      : url.endsWith('/readyz')
        ? ready('old', 'build-old')
        : { status: 200, headers: {}, body: '' };
  await rollTo(other.runner, 'https://a.test', { deployId: 'new', buildId: 'b' }, TOKEN, 5_000);
  assert.match(other.said.join('\n'), /restart 1: the Worker answered 500; saw/);
});

test('smoke follows up to five same-origin redirects, and names the chain of a loop, a foreign origin or too many', async () => {
  const { smoke } = await import('../packages/mistri/src/server/deploy/run.js');
  const redirect = (to: string): HttpAnswer => ({ status: 303, headers: { location: to }, body: '' });
  const page: HttpAnswer = { status: 200, headers: {}, body: '<script src="app.js"></script>' };
  const run1 = (pages: Record<string, HttpAnswer>) => {
    const made = fake({ pages });
    return { made, smoke: () => smoke(made.runner, 'https://a.test', undefined) };
  };
  const followed = run1({
    'https://a.test/': redirect('/shop'),
    'https://a.test/shop': page,
    'https://a.test/app.js': { status: 200, headers: {}, body: '' },
  });
  assert.deepEqual(await followed.smoke(), []);
  assert.ok(followed.made.calls.includes('GET https://a.test/app.js'));
  /* The script is resolved against the page it came from. */
  const nested = run1({
    'https://a.test/': redirect('/shop/'),
    'https://a.test/shop/': page,
    'https://a.test/shop/app.js': { status: 200, headers: {}, body: '' },
  });
  assert.deepEqual(await nested.smoke(), []);
  const foreign = await run1({ 'https://a.test/': redirect('https://evil.test/x') }).smoke();
  assert.match(foreign.join(), /another origin \(https:\/\/a\.test\/ -> https:\/\/evil\.test\/x\)/);
  const loop = await run1({ 'https://a.test/': redirect('/b'), 'https://a.test/b': redirect('/') }).smoke();
  assert.match(loop.join(), /loop \(https:\/\/a\.test\/ -> https:\/\/a\.test\/b -> https:\/\/a\.test\/\)/);
  const long = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [`https://a.test/${i === 0 ? '' : `h${i}`}`, redirect(`/h${i + 1}`)]),
  );
  assert.match((await run1(long).smoke()).join(), /more than 5 times/);
  const five = Object.fromEntries(
    Array.from({ length: 5 }, (_, i) => [`https://a.test/${i === 0 ? '' : `h${i}`}`, redirect(`/h${i + 1}`)]),
  );
  five['https://a.test/h5'] = page;
  assert.deepEqual(await run1(five).smoke(), []);
});

test('verify repairs a record whose deploy is live, and marks one that is not as failed with why', async () => {
  const live = row('bbbbbbbb-2', '2026-10-02T00:00:00.000Z', { result: 'failed', note: 'smoke failed: x' });
  const rows = [live, row('aaaaaaaa-1', '2026-10-01T00:00:00.000Z')];
  const ok = await run([...base, 'verify'], { readyz: [ready('bbbbbbbb-2', 'build-bbbbbbbb-2')] }, rows);
  assert.equal(ok.code, 0, ok.said.join('\n'));
  assert.deepEqual([rows[0].result, rows[0].note], ['ok', null]);
  assert.ok(!ok.calls.some((c) => c.startsWith('POST ')), 'no restart without --roll');

  const down = [row('cccccccc-3', '2026-10-03T00:00:00.000Z', { result: 'ok' })];
  const bad = await run([...base, 'verify', '--roll-timeout', '1'], { readyz: [ready('old', 'build-old')] }, down);
  assert.equal(bad.code, 1);
  assert.equal(down[0].result, 'failed');
  assert.match(down[0].note!, /verify failed: the container never reported the fingerprint: last saw deploy old.*--roll/);
  assert.ok(!bad.calls.some((c) => c.startsWith('POST ')));

  const rolled = [row('dddddddd-4', '2026-10-04T00:00:00.000Z', { result: 'failed' })];
  const roll = await run(
    [...base, 'verify', '--roll'],
    { readyz: [ready('old', 'build-old'), ready('dddddddd-4', 'build-dddddddd-4')] },
    rolled,
  );
  assert.equal(roll.code, 0, roll.said.join('\n'));
  assert.ok(roll.calls.some((c) => c.startsWith('POST ')));
  assert.equal(rolled[0].result, 'ok');

  const none = await run([...base, 'verify'], {}, []);
  assert.equal(none.code, 1);
  assert.equal((await run([...base, 'verify', '--roll'], { token: undefined }, rolled)).code, 7);
});

test('a failure after wrangler deploy says the new version is serving and what to do next', async () => {
  const previous = row('aaaaaaaa-1', '2026-10-01T00:00:00.000Z');
  const stale: HttpAnswer = ready('old', 'build-old');
  const timeout = await run([...base, '--yes', '--roll-timeout', '1'], { readyz: [stale] }, [previous]);
  assert.equal(timeout.code, 1);
  const text = timeout.said.join('\n');
  assert.match(text, /new Worker version 11111111-2222-3333-4444-555555555555 is serving/);
  assert.match(text, /mistri deploy verify/);
  assert.match(text, /mistri deploy rollback aaaaaaaa/);
  const smokeFail = await run([...base, '--yes'], { pages: { 'https://app.example.com/': { status: 502, headers: {}, body: '' } } }, []);
  assert.equal(smokeFail.code, 1);
  assert.match(smokeFail.said.join('\n'), /smoke failed: .*502.*is serving.*mistri deploy verify\./s);
  assert.ok(!smokeFail.said.join('\n').includes('mistri deploy rollback'), 'no earlier deploy to go back to');
  const early = await run([...base, '--yes'], { migrateFails: true, pending: [expand] }, []);
  assert.ok(!early.said.join('\n').includes('is serving'));
});

/** A fake Worker for the roll: `/readyz` and the status probe each follow the elapsed seconds since the first poll
 * (a probe of 'resetting' fails the way a Durable Object aborting itself does). */
function rolling(options: {
  probe: (seconds: number) => unknown | undefined;
  ready: (seconds: number) => { deploy: string; build: string } | undefined;
}) {
  const made = fake();
  const first = made.runner.now();
  const seconds = () => Math.round((made.runner.now() - first) / 1000);
  made.runner.http = async (url, init) => {
    made.calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/readyz')) {
      const body = options.ready(seconds());
      return body ? { status: 200, headers: {}, body: JSON.stringify(body) } : { status: 503, headers: {}, body: '{}' };
    }
    if (url.endsWith('/__mistri/status')) {
      const body = options.probe(seconds());
      if (body === 'resetting') return { status: 500, headers: {}, body: 'Durable Object reset' };
      return body ? { status: 200, headers: {}, body: JSON.stringify(body) } : { status: 200, headers: {}, body: '<html>the App</html>' };
    }
    return { status: 200, headers: {}, body: '' };
  };
  return made;
}
const NEW = '00000000-0000-0000-0000-000000000001';
const probeOf = (version: string | null, wants: string, started: string | null, running = true) => ({
  workerVersion: version,
  desired: { image: 'img', deployId: wants },
  startedWith: started ? { image: 'img', deployId: started, at: '2026-10-29T00:00:00.000Z' } : null,
  container: { running, image: null },
});

test('a roll polls the probe and prints a timeline, and sends no restart when the container upgrades itself', async () => {
  const made = rolling({
    probe: (s) => (s < 10 ? probeOf('v-old', 'old', 'old') : s < 40 ? probeOf('v-new', NEW, 'old') : probeOf('v-new', NEW, NEW)),
    ready: (s) => (s < 50 ? { deploy: 'old', build: 'build-old' } : { deploy: NEW, build: 'build-new' }),
  });
  const { rollTo } = await import('../packages/mistri/src/server/deploy/run.js');
  assert.deepEqual(await rollTo(made.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 600_000), { ok: true });
  assert.ok(!made.calls.some((c) => c.startsWith('POST ')), 'no restart');
  const said = made.said.join('\n');
  assert.match(said, /\+0s probe: worker version v-old, Durable Object wants deploy old, container started with deploy old \(running\)/);
  assert.match(said, /\+10s probe: worker version v-new, Durable Object wants deploy 00000000/);
  assert.match(said, /\+10s Durable Object wants the new deploy 00000000/);
  assert.match(said, /\+40s container started on the new deploy/);
  assert.match(said, /\+50s \/readyz matched/);
  assert.match(said, /verified: deploy 00000000 build build-new after 0 restarts, 0m50s/);
  /* The probe is read each poll with the token. */
  assert.ok(made.calls.filter((c) => c.endsWith('/__mistri/status')).length >= 10);
});

test('the fallback restart goes in only when the Durable Object wants the new deploy and the container lags it for over a minute', async () => {
  const { rollTo } = await import('../packages/mistri/src/server/deploy/run.js');
  /* The Durable Object is still on the old Worker version: a restart there would bring the old image back. */
  const old = rolling({ probe: () => probeOf('v-old', 'old', 'old'), ready: () => ({ deploy: 'old', build: 'build-old' }) });
  assert.equal((await rollTo(old.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 300_000)).ok, false);
  assert.ok(!old.calls.some((c) => c.startsWith('POST ')));
  /* It wants the new deploy but the container does not follow: one restart after 60 s, then one per minute. */
  const lag = rolling({
    probe: () => probeOf('v-new', NEW, 'old'),
    ready: (s) => (s < 200 ? { deploy: 'old', build: 'build-old' } : { deploy: NEW, build: 'build-new' }),
  });
  assert.equal((await rollTo(lag.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 600_000)).ok, true);
  const restarts = lag.calls.filter((c) => c.startsWith('POST '));
  assert.equal(restarts.length, 3, lag.said.join('\n'));
  assert.match(lag.said.join('\n'), /\+6\ds restart 1: sent; saw deploy old/);
  /* No restart at all with restart: false (verify without --roll). */
  const waiting = rolling({ probe: () => probeOf('v-new', NEW, 'old'), ready: () => ({ deploy: 'old', build: 'build-old' }) });
  await rollTo(waiting.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 200_000, false);
  assert.ok(!waiting.calls.some((c) => c.startsWith('POST ')));
});

test('against an older Worker with no probe, the roll restarts as before with a gap of at most a minute', async () => {
  const { rollTo } = await import('../packages/mistri/src/server/deploy/run.js');
  const made = rolling({ probe: () => undefined, ready: () => ({ deploy: 'old', build: 'build-old' }) });
  const result = await rollTo(made.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 600_000);
  assert.equal(result.ok, false);
  /* 10 minutes at one per 60 s, not the old doubling gap (which sent four). */
  assert.equal(made.calls.filter((c) => c.startsWith('POST ')).length, 10);
  assert.ok(!made.said.join('\n').includes('probe:'));
});

test('a probe that fails while the Durable Object resets itself sends no restart', async () => {
  const { rollTo } = await import('../packages/mistri/src/server/deploy/run.js');
  const made = rolling({
    probe: (s) => (s < 10 ? 'resetting' : s < 25 ? probeOf('v-new', NEW, 'old') : probeOf('v-new', NEW, NEW)),
    ready: (s) => (s < 30 ? { deploy: 'old', build: 'build-old' } : { deploy: NEW, build: 'build-new' }),
  });
  assert.deepEqual(await rollTo(made.runner, 'https://a.test', { deployId: NEW, buildId: 'build-new' }, TOKEN, 600_000), { ok: true });
  assert.ok(!made.calls.some((c) => c.startsWith('POST ')), made.said.join('\n'));
  assert.match(made.said.join('\n'), /verified: deploy 00000000 build build-new after 0 restarts/);
});
