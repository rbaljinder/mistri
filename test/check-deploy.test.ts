/**
 * `mistri check --deploy`: each thing that would not survive a replaced
 * container is refused with its fix, and a deployment that is safe passes.
 * The findings are a pure function of what the command read (checkDeploy.ts),
 * so each refusal is tested there; one run of the command holds the wiring:
 * the step, the exit code 7 and the report's schema.
 */
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { deployFindings, type DeployInput } from '../packages/mistri/src/server/build/checkDeploy.js';

const secret = 'x'.repeat(40);
const postgres = { id: 'main', name: 'main', url: 'postgres://u:p@db.example/app' };
const input = (more: Partial<DeployInput> = {}): DeployInput => ({
  app: { id: 'a', connection: 'main' },
  connections: [postgres],
  cache: false,
  env: {},
  ...more,
});
const withAuth = (store?: string): DeployInput['app'] =>
  ({
    id: 'a',
    connection: 'main',
    auth: { providers: ['email'], signUp: 'invite', defaultRole: 'user', rows: 'all', ...(store ? { store } : {}) },
  }) as DeployInput['app'];
const codes = (findings: ReturnType<typeof deployFindings>) => findings.map((finding) => `${finding.severity} ${finding.code}`);

describe('deployFindings', () => {
  test('server timing left on without a token is a warning; with a token, or off, it is clean', () => {
    const found = deployFindings(input({ env: { MISTRI_SERVER_TIMING: '1' } }));
    assert.deepEqual(codes(found), ['warning deploy-server-timing-public']);
    assert.match(found[0].fix, /MISTRI_SERVER_TIMING_TOKEN/);
    assert.deepEqual(deployFindings(input({ env: { MISTRI_SERVER_TIMING: '1', MISTRI_SERVER_TIMING_TOKEN: 'abc' } })), []);
    assert.deepEqual(deployFindings(input({ env: { MISTRI_SERVER_TIMING_TOKEN: 'abc' } })), []);
  });

  test('a network database and no sign-in is clean', () => {
    assert.deepEqual(deployFindings(input()), []);
  });

  test('an App source on a SQLite file is refused, named, with its fix', () => {
    const found = deployFindings(input({ connections: [{ id: 'main', name: 'main', url: '/data/app.db' }] }));
    assert.deepEqual(codes(found), ['error deploy-sqlite-source']);
    assert.match(found[0].message, /"main" is a SQLite file/);
    assert.match(found[0].fix, /postgres:\/\//);
    assert.deepEqual(codes(deployFindings(input({ connections: [{ id: 'main', name: 'main', url: 'sqlite:///data/app.db' }] }))), [
      'error deploy-sqlite-source',
    ]);
  });

  test('every bound source is judged, and a connection the App does not use is not', () => {
    const found = deployFindings(
      input({
        app: { id: 'a', sources: { crm: { connection: 'main', default: true }, legacy: { connection: 'old', default: false } } },
        connections: [postgres, { id: 'old', name: 'old', url: 'legacy.db' }, { id: 'scratch', name: 'scratch', url: 'scratch.db' }],
      }),
    );
    assert.deepEqual(codes(found), ['error deploy-sqlite-source']);
    assert.match(found[0].message, /"old"/);
  });

  test('a reference resolves against the environment: a network URL passes, a file is refused, an unset name is named', () => {
    const referenced = (env: NodeJS.ProcessEnv) =>
      deployFindings(input({ connections: [{ id: 'main', name: 'main', url: '${DATABASE_URL}' }], env }));
    assert.deepEqual(referenced({ DATABASE_URL: 'postgres://db/app' }), []);
    assert.deepEqual(codes(referenced({ DATABASE_URL: 'app.db' })), ['error deploy-sqlite-source']);
    const unset = referenced({});
    assert.deepEqual(codes(unset), ['error deploy-unset-reference']);
    assert.match(unset[0].message, /\$DATABASE_URL/);
  });

  test('an HTTP connection is not a database file', () => {
    assert.deepEqual(deployFindings(input({ connections: [{ id: 'main', name: 'main', url: 'https://api.example', http: {} }] })), []);
  });

  test('the default auth.store is refused', () => {
    const found = deployFindings(input({ app: withAuth(), env: { BETTER_AUTH_SECRET: secret, MISTRI_PUBLIC_URL: 'https://x.example' } }));
    assert.deepEqual(codes(found), ['error deploy-default-auth-store']);
    assert.match(found[0].fix, /postgres:\/\//);
  });

  test('an auth.store on a SQLite file is refused; a PostgreSQL one, by reference or written, is not', () => {
    const env = { BETTER_AUTH_SECRET: secret, MISTRI_PUBLIC_URL: 'https://x.example', AUTH_URL: 'postgres://db/auth' };
    assert.deepEqual(codes(deployFindings(input({ app: withAuth('./auth.db'), env }))), ['error deploy-sqlite-auth-store']);
    assert.deepEqual(deployFindings(input({ app: withAuth('${AUTH_URL}'), env })), []);
    assert.deepEqual(deployFindings(input({ app: withAuth('postgres://db/auth'), env })), []);
    assert.deepEqual(codes(deployFindings(input({ app: withAuth('${NOPE}'), env }))), ['error deploy-unset-reference']);
  });

  test('a missing or short BETTER_AUTH_SECRET is refused, only for an App that signs people in', () => {
    const store = 'postgres://db/auth';
    const base = { MISTRI_PUBLIC_URL: 'https://x.example' };
    assert.deepEqual(codes(deployFindings(input({ app: withAuth(store), env: base }))), ['error deploy-missing-secret']);
    const short = deployFindings(input({ app: withAuth(store), env: { ...base, BETTER_AUTH_SECRET: 'short' } }));
    assert.match(short[0].message, /shorter than 32/);
    assert.deepEqual(deployFindings(input({ app: withAuth(store), env: { ...base, BETTER_AUTH_SECRET: secret } })), []);
    assert.deepEqual(deployFindings(input({ env: {} })), []);
  });

  test('a missing MISTRI_PUBLIC_URL is a warning', () => {
    const found = deployFindings(input({ app: withAuth('postgres://db/auth'), env: { BETTER_AUTH_SECRET: secret } }));
    assert.deepEqual(codes(found), ['warning deploy-public-url']);
  });

  test('per-process rate limits are warned of for several replicas without a cache, and only then', () => {
    assert.deepEqual(codes(deployFindings(input({ replicas: 3 }))), ['warning deploy-per-process-limits']);
    assert.deepEqual(deployFindings(input({ replicas: 3, cache: true })), []);
    assert.deepEqual(deployFindings(input({ replicas: 1 })), []);
    assert.deepEqual(deployFindings(input()), []);
  });

  test("a public page's door without MISTRI_FORM_KEY is warned of, and refused for several replicas", () => {
    const doors = {
      id: 'a',
      connection: 'main',
      views: { lobby: { kind: 'page', page: { public: true, commands: ['enrol'] } } },
    } as unknown as DeployInput['app'];
    assert.deepEqual(codes(deployFindings(input({ app: doors }))), ['warning deploy-form-key']);
    assert.deepEqual(codes(deployFindings(input({ app: doors, replicas: 3, cache: true }))), ['error deploy-form-key']);
    assert.deepEqual(deployFindings(input({ app: doors, replicas: 3, cache: true, env: { MISTRI_FORM_KEY: secret } })), []);
    assert.deepEqual(deployFindings(input({ replicas: 3, cache: true })), [], 'no door, no ticket');
  });
});

describe('mistri check --deploy', () => {
  const ROOT = resolve('.');
  const work = mkdtempSync(join(tmpdir(), 'tablewalk-check-deploy-'));
  after(() => rmSync(work, { recursive: true, force: true }));
  mkdirSync(join(work, 'node_modules'));
  mkdirSync(join(work, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(ROOT, 'packages', 'mistri'), join(work, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  const db = join(work, 'tick.db');
  spawnSync(process.execPath, [join(ROOT, 'examples/databases/tick/seed.mjs'), db], { encoding: 'utf8' });
  const config = `${db}.json`;
  const dir = join(work, 'app');
  mkdirSync(dir);
  writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, 'app.ts'),
    "export default { id: 'tiny', name: 'Tiny', connection: 'tick', resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };\n",
  );
  const validate = new Ajv2020({ allErrors: true, strict: false }).compile(
    JSON.parse(readFileSync(join(ROOT, 'packages/mistri/schema/check.schema.json'), 'utf8')),
  );

  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ code: number; out: string; err: string }>((done) => {
      execFile(
        process.execPath,
        ['--import', 'tsx', join(ROOT, 'packages/mistri/src/server/index.ts'), ...args],
        {
          cwd: ROOT,
          env: { ...process.env, XDG_CONFIG_HOME: join(work, 'xdg'), BETTER_AUTH_SECRET: '', ...env },
          timeout: 180_000,
          killSignal: 'SIGKILL',
        },
        (error, out, err) => done({ code: (error as { code?: number } | null)?.code ?? 0, out, err }),
      );
    });

  test('a SQLite-backed App fails the deploy step with exit 7, in the report too', async () => {
    const ran = await run(['check', '--app', dir, '--config', config, '--deploy', '--replicas', '2', '--json']);
    assert.equal(ran.code, 7, ran.out + ran.err);
    const report = JSON.parse(ran.out) as { problems: Array<{ step: string; code: string; severity: string; fix?: string }> };
    assert.ok(validate(report), JSON.stringify(validate.errors));
    const deploy = report.problems.filter((problem) => problem.step === 'deploy');
    assert.deepEqual(
      deploy.map((problem) => `${problem.severity} ${problem.code}`),
      ['error deploy-sqlite-source', 'warning deploy-per-process-limits'],
    );
    assert.ok(deploy.every((problem) => problem.fix));
  });

  test('server timing left on without a token is a warning in the report, not a failure of its own', async () => {
    const ran = await run(['check', '--app', dir, '--config', config, '--deploy', '--json'], { MISTRI_SERVER_TIMING: '1' });
    const report = JSON.parse(ran.out) as { problems: Array<{ step: string; code: string; severity: string }> };
    assert.ok(report.problems.some((problem) => problem.code === 'deploy-server-timing-public' && problem.severity === 'warning'));
    const tokened = await run(['check', '--app', dir, '--config', config, '--deploy', '--json'], {
      MISTRI_SERVER_TIMING: '1',
      MISTRI_SERVER_TIMING_TOKEN: 'abc',
    });
    assert.ok(!JSON.parse(tokened.out).problems.some((problem: { code: string }) => problem.code === 'deploy-server-timing-public'));
  });

  test('a pending migration that breaks the running code is a warning, an error with --strict-migrations, a note when marked', async () => {
    const migrations = join(work, 'migrations');
    mkdirSync(migrations);
    writeFileSync(join(migrations, 'V1__shrink.sql'), 'ALTER TABLE task DROP COLUMN note;\n-- mistri: contract\nDROP VIEW old_tasks;\n');
    type Found = { step: string; code: string; severity: string; message: string };
    const found = async (...more: string[]) => {
      const ran = await run(['check', '--app', dir, '--config', config, '--deploy', '--migrations', migrations, '--json', ...more]);
      const report = JSON.parse(ran.out) as { problems: Found[] };
      assert.ok(validate(report), JSON.stringify(validate.errors));
      return report.problems.filter((problem) => problem.code === 'migration-breaks-running-code');
    };
    const lax = await found();
    assert.deepEqual(
      lax.map((problem) => problem.severity),
      ['warning', 'info'],
    );
    assert.match(lax[0].message, /V1__shrink\.sql:1 DROP COLUMN/);
    assert.match(lax[1].message, /V1__shrink\.sql:3 DROP VIEW, marked as a contract step/);
    assert.deepEqual(
      (await found('--strict-migrations')).map((problem) => problem.severity),
      ['error', 'info'],
    );
    const alone = await run(['check', '--app', dir, '--config', config, '--strict-migrations']);
    assert.equal(alone.code, 1);
    assert.match(alone.err, /--strict-migrations makes --deploy fail/);
  });

  test('without --deploy nothing about deployment is judged, and --replicas alone is refused', async () => {
    const without = await run(['check', '--app', dir, '--config', config, '--json']);
    assert.ok(!JSON.parse(without.out).problems.some((problem: { step: string }) => problem.step === 'deploy'));
    const alone = await run(['check', '--app', dir, '--config', config, '--replicas', '2']);
    assert.equal(alone.code, 1);
    assert.match(alone.err, /--replicas says how many instances --deploy judges for/);
    const limit = await run(['check', '--app', dir, '--config', config, '--connection-limit', '100']);
    assert.equal(limit.code, 1);
    assert.match(limit.err, /--connection-limit says what --deploy holds the pools to/);
    const cpus = await run(['check', '--app', dir, '--config', config, '--deploy', '--cpus', '0']);
    assert.equal(cpus.code, 1);
    assert.match(cpus.err, /--cpus takes the cores the deployment has/);
    const bad = await run(['check', '--app', dir, '--config', config, '--deploy', '--connection-limit', 'many']);
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--connection-limit takes the connections the database allows/);
  });
});
