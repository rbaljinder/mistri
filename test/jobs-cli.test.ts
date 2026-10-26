/**
 * Activating durable jobs: the `--jobs` flag's refusals, `mistri check`'s
 * effective automation line and its refusals when a store is missing, the
 * `@mistriwork/mistri/jobs` entry, the load-time checks a jobs module must pass, and
 * the per-attempt authorization of a server-declared principal.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import * as jobsEntry from '@mistriwork/mistri/jobs';
import ignitionCommands from '../test/fixtures/apps/ignition/commands.js';
import ignitionJobs from '../test/fixtures/apps/ignition/jobs.js';
import { APPLICANTS_SCHEMA } from '../examples/databases/ignition/schema.mjs';
import { seed as seedTick } from '../examples/databases/tick/seed.mjs';
import { ignitionTenantFixture, SUPPORT_SECRET } from './support/ignitionTenantFixture.js';
import { COMMAND_EVENT_TABLES } from '../packages/mistri/src/adapters/events/commandEventSchema.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineEvent, defineEventProjection } from '../packages/mistri/src/server/commands/businessEvents.js';
import { int, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { createJobAuthorizer } from '../packages/mistri/src/server/jobs/jobAuthorization.js';
import { describeJobs, jobDeployment, jobGrantProblems } from '../packages/mistri/src/server/jobs/jobLoader.js';
import {
  capturedJobModule,
  defineJob,
  defineJobs,
  JobDeclarationError,
  type JobsOptions,
} from '../packages/mistri/src/server/jobs/jobModule.js';
import { buildReadiness } from '../packages/mistri/src/server/operations/operations.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { VALIDATE, validating } from './support/validation.js';
import { published } from '../scripts/pack-manifest.mjs';

const ROOT = resolve('.');
/* An App's starts are mistri's (test/support/bins.ts). */
const ENTRY = join(ROOT, 'packages', 'mistri', 'src', 'server', 'index.ts');
interface Ran {
  code: number;
  out: string;
  err: string;
}
function run(args: string[], env: Record<string, string> = {}, timeout = 60_000): Promise<Ran> {
  return new Promise((done, reject) => {
    const child = validating(args, { ...process.env, ...env });
    execFile(
      process.execPath,
      ['--import', 'tsx', ENTRY, ...child.args],
      { cwd: ROOT, timeout, killSignal: 'SIGKILL', env: child.env },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`tablewalk ${args.join(' ')} did not exit`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

describe('the --jobs flag', () => {
  const cases: Array<[string[], RegExp]> = [
    [['--jobs'], /--jobs requires a file and the HTTP App runtime/],
    [
      ['--jobs', 'jobs.ts', '--app', 'test/fixtures/apps/ignition'],
      /Tenant applications are not enabled without explicit --policy enrollment/,
    ],
    [['--jobs', 'jobs.ts', '--commands', 'commands.ts'], /--jobs requires exactly one explicit --app/],
    [
      ['--jobs', 'a.ts', '--jobs', 'b.ts', '--commands', 'commands.ts', '--app', 'test/fixtures/apps/ignition'],
      /--jobs \(may be supplied only once\)/,
    ],
  ];
  /* --mcp is the database browser's: mistri refuses it by that name before it reads --jobs. */
  test('refuses --jobs jobs.ts --mcp, naming the database browser', async () => {
    const ran = await run(['--jobs', 'jobs.ts', '--mcp']);
    assert.equal(ran.code, 2);
    assert.match(ran.err, /--mcp is the database browser's, a command of its own: npx tablewalk/);
  });
  for (const [args, refusal] of cases) {
    test(`refuses ${args.join(' ')}`, async () => {
      const ran = await run(args);
      assert.equal(ran.code, 1);
      assert.match(ran.err, refusal);
    });
  }
  test('refuses --jobs for an App with no commands, which would load the jobs and never run one', async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-jobs-tick-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const database = join(directory, 'tick.db');
    seedTick(database);
    const ran = await run(['--config', `${database}.json`, '--jobs', 'jobs.ts', '--app', 'examples/apps/tick', VALIDATE]);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /--jobs requires the App command registry its jobs run: keep commands\.ts beside the App or pass --commands/);
  });
});

describe('mistri check with --jobs, over Ignition on the SQLite mirror of its schema', () => {
  /* Ignition is a tenant App now, so every run here carries its `--policy`: the
     effective automation line is printed by a server that got as far as loading
     the policy, the commands and the jobs together. The fixture provisions the
     tenant store, the command journal, the tenant event store and the job store
     the way a deployment's own maintenance steps do, which is what makes the
     attestation these tests exercise the same attestation. */
  const applicants = (directory: string) => {
    const file = join(directory, 'applicants.db');
    const db = new DatabaseSync(file);
    /* The platform-only source, tables and no rows: mistri check reads a source's
       schema. `public.` is PostgreSQL's; SQLite takes the rest of the DDL as it
       stands, so the one schema stays the one place the shape is written. */
    try {
      db.exec(APPLICANTS_SCHEMA.replaceAll('public.', ''));
    } finally {
      db.close();
    }
    return file;
  };
  const fixture = async (t: TestContext) => {
    const seeded = await ignitionTenantFixture(t, { events: true, jobs: { commands: ignitionCommands, jobs: ignitionJobs } });
    const config = join(seeded.directory, 'server.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          { name: 'loans', url: seeded.path, writable: true },
          { name: 'applicants', url: applicants(seeded.directory), writable: false },
        ],
      }),
    );
    return { ...seeded, config };
  };
  /* Ignition's policy declares support, so startup attests the support audit
     store before it reaches anything this suite is about — and attests it under
     the key the *child* derives. It must therefore be the key the fixture
     provisioned that store under, not merely some key of the right length: a
     store written under another one refuses exactly as a missing one does, and
     the refusal says neither. */
  const check = (config: string, jobs = true) =>
    run(
      [
        '--config',
        config,
        '--app',
        'test/fixtures/apps/ignition',
        '--policy',
        'test/fixtures/apps/ignition/tenant-policy.ts',
        '--commands',
        'test/fixtures/apps/ignition/commands.ts',
        ...(jobs ? ['--jobs', 'test/fixtures/apps/ignition/jobs.ts'] : []),
        VALIDATE,
      ],
      { MISTRI_AUDIT_KEY: SUPPORT_SECRET },
    );

  test('prints the effective automation and passes', async (t) => {
    const ran = await check((await fixture(t)).config);
    assert.equal(ran.code, 0, ran.err);
    assert.equal(
      ran.out,
      'Ignition: ok\njobs: reviewDue@1 on application.submitted@1 (convertLead@1) → flagOverdueReview@1 as review-clock\n',
    );
  });

  /* The next two once named the step to provision, because Ignition was a
     single-tenant App and its stores were attested by the jobs and command
     startup checks. It is a tenant App now, so its job and event stores are
     attested inside the tenant enrollment instead, which answers with one
     sentence for every cause and keeps the reason to itself. So these assert
     what is true today: the check refuses, and nothing about the App's own
     declarations changed to make it. When that refusal carries its cause again,
     both should go back to naming the store and the step — the assertion is
     weaker than it was, and deliberately marked so rather than quietly dropped. */
  test('refuses a source whose job store was never provisioned', async (t) => {
    const seeded = await fixture(t);
    seeded.db().exec(`DROP TABLE "${JOB_TABLES.attempt}"; DROP TABLE "${JOB_TABLES.job}"; DROP TABLE "${JOB_TABLES.policy}"`);
    const ran = await check(seeded.config);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /Tenant startup error: .*existing tenant store, ownership and command\/administration journals/);
    assert.doesNotMatch(ran.out, /Ignition: ok/);
  });

  test('refuses an emitting command whose source has no event store, even without --jobs', async (t) => {
    const seeded = await fixture(t);
    const db = seeded.db();
    const delivery = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '\\_\\_mistri\\_delivery\\_%' ESCAPE '\\'")
      .all()
      .map((row) => String(row.name))
      .sort()
      .reverse();
    for (const table of [...delivery, COMMAND_EVENT_TABLES.event, COMMAND_EVENT_TABLES.meta]) db.exec(`DROP TABLE "${table}"`);
    const ran = await check(seeded.config, false);
    assert.equal(ran.code, 1);
    assert.match(ran.err, /Tenant startup error: .*existing tenant store, ownership and command\/administration journals/);
    assert.doesNotMatch(ran.out, /Ignition: ok/);
  });
});

describe('@mistriwork/mistri/jobs', () => {
  test('the package maps and builds the entry, and it exports the declarations', () => {
    const pkg = published(JSON.parse(readFileSync(new URL('../packages/mistri/package.json', import.meta.url), 'utf8')));
    assert.deepEqual(pkg.exports['./jobs'], { types: './dist/server/jobs.d.ts', default: './dist/server/jobs.js' });
    const commands = JSON.parse(readFileSync(new URL('../tsconfig.commands.json', import.meta.url), 'utf8'));
    assert.ok(commands.include.includes('packages/mistri/src/server/jobs.ts'));
    assert.deepEqual(Object.keys(jobsEntry).sort(), [
      'DecisionDeclarationError',
      'JobDeclarationError',
      'defineDecision',
      'defineDecisions',
      'defineInbound',
      'defineJob',
      'defineJobs',
      'hmac',
    ]);
  });
});

// A small registry: `start` and `follow` emit `thing.done`, `quiet` emits nothing, `elsewhere` is on another source.
type Thing = { id: number };
const done = defineEvent('thing.done', shape({ id: int() }));
// An event's job names the record its command acts on; a public command, and one with targets: 'none', names none.
const command = (options: { source?: string; events?: boolean; public?: true; record?: false } = {}) =>
  defineCommand({
    source: options.source ?? 'main',
    target: 'thing',
    input: {},
    output: { parse: (value: unknown) => value as Thing },
    ...(options.events === false ? {} : { events: { done: defineEventProjection<Thing, Thing>(done, (output) => ({ id: output.id })) } }),
    ...(options.public
      ? { public: true as const, targets: 'none' as const }
      : options.record === false
        ? { targets: 'none' as const }
        : {}),
    handle: () => ({ id: 1 }),
  });
const registry = defineCommands({
  start: command(),
  follow: command(),
  quiet: command({ events: false }),
  elsewhere: command({ source: 'other', events: false }),
  open: command({ events: false, public: true }),
  creates: command({ events: false, record: false }),
});
const job = (from: string, runs: string) =>
  defineJob({ on: { event: done, command: from }, runAs: 'clock', command: runs, schedule: (event) => ({ key: { id: event.id } }) });
const options: JobsOptions = { principals: { clock: { roles: ['automation'] } } };
const deploy = (jobs: Record<string, ReturnType<typeof job>>, extra: Partial<JobsOptions> = {}) =>
  jobDeployment(capturedJobModule(defineJobs(jobs, { ...options, ...extra })), { appId: 'things', commands: registry });
const refused = (pattern: RegExp) => (error: unknown) => error instanceof JobDeclarationError && pattern.test(error.message);

describe('the load-time checks', () => {
  test('a valid module derives one destination a job, on the one source, with the job store beside it', () => {
    const deployment = deploy({ reminder: job('start', 'follow') });
    assert.equal(deployment.sourceId, 'main');
    assert.deepEqual(deployment.events, { appId: 'things', storeId: 'app:things', sourceId: 'main' });
    assert.deepEqual(
      deployment.destinations.map(({ job, policy }) => [job, policy.destinationId, policy.routes]),
      [
        [
          'reminder',
          'job:reminder@1',
          [{ scope: 'app', commandId: 'start', commandVersion: 1, manifest: [{ name: 'thing.done', version: 1 }] }],
        ],
      ],
    );
    assert.equal(deployment.store.namespace, 'things', 'the namespace defaults to the App id');
    assert.equal(deployment.store.maxInFlight, 1);
    assert.ok(deployment.attemptTimeoutMs < deployment.store.leaseMs);
    assert.deepEqual(describeJobs(capturedJobModule(defineJobs({ reminder: job('start', 'follow') }, options))), [
      'jobs: reminder@1 on thing.done@1 (start@1) → follow@1 as clock',
    ]);
  });
  test('every reference resolves to a registered command', () => {
    assert.throws(
      () => deploy({ reminder: job('start', 'nothing') }),
      refused(/runs command "nothing", which the commands module does not register/),
    );
    assert.throws(
      () => deploy({ reminder: job('missing', 'follow') }),
      refused(/starts on command "missing", which the commands module does not register/),
    );
    assert.throws(
      () => deploy({ reminder: job('quiet', 'follow') }),
      refused(/starts on event "thing.done" version 1, which command "quiet" version 1 does not declare/),
    );
    assert.throws(() => deploy({ reminder: job('start', 'open') }), refused(/runs command "open", which is public/));
    // An event's job names the one record its command acts on: a command with targets: 'none' names none.
    assert.throws(() => deploy({ reminder: job('start', 'creates') }), refused(/runs command "creates", which names no record/));
  });
  test('every principal is declared', () => {
    assert.throws(
      () => defineJobs({ reminder: job('start', 'follow') }, { principals: { other: { roles: ['automation'] } } }),
      refused(/Job "reminder" runs as "clock", which the module's principals do not declare/),
    );
    assert.throws(
      () => defineJobs({ reminder: job('start', 'follow') }, { principals: { clock: { roles: [] } } }),
      refused(/nonempty list of distinct role names/),
    );
  });
  test('the subscription graph is acyclic', () => {
    assert.throws(
      () => deploy({ forth: job('start', 'follow'), back: job('follow', 'start') }),
      refused(/the subscription graph has a cycle, so a job could start itself again: start@1 → forth@1 → follow@1 → back@1 → start@1/),
    );
    assert.throws(() => deploy({ again: job('start', 'start') }), refused(/cycle.*start@1 → again@1 → start@1/));
  });
  test('all jobs share one source, which holds the job store', () => {
    assert.throws(
      () => deploy({ reminder: job('start', 'elsewhere') }),
      refused(/must share one source.*"elsewhere" is on "other", "start" is on "main"/),
    );
  });
  test("maxInFlight stays within the source's writer", () => {
    assert.throws(
      () => deploy({ reminder: job('start', 'follow') }, { store: { maxInFlight: 2 } }),
      refused(/store maxInFlight 2 is more than the source's 1 writer/),
    );
    assert.throws(() => deploy({ reminder: job('start', 'follow') }, { store: { leaseMs: 5 } }), refused(/the store bounds are invalid/));
  });
});

describe('a server-declared principal', async () => {
  const loaded = await loadApp(resolve('test/fixtures/apps/ignition'));
  const module = capturedJobModule((await import('../test/fixtures/apps/ignition/jobs.js')).default);
  const withRole = (grant: Record<string, unknown>): AppDef => ({
    ...loaded.app,
    auth: { ...loaded.app.auth!, roles: { ...loaded.app.auth!.roles!, automation: { ...loaded.app.auth!.roles!.automation, ...grant } } },
  });
  const clock = { now: 1_000 };
  let app = loaded.app;
  const authorize = createJobAuthorizer({ module, appId: 'ignition', app: () => app, attemptTimeoutMs: 10_000, now: () => clock.now });
  const request = {
    audience: 'mistri.jobs' as const,
    jobId: '00000000-0000-4000-8000-000000000000',
    job: 'reviewDue',
    version: 1,
    attempt: 1,
    provenance: { appId: 'ignition', actorId: 'account-a' },
  };

  test('holds exactly the grants its roles hold in the App loaded now', () => {
    assert.deepEqual(jobGrantProblems(module, loaded.app), []);
    assert.deepEqual(authorize(request), {
      audience: 'mistri.jobs',
      job: 'reviewDue',
      version: 1,
      appId: 'ignition',
      expiresAt: 11_000,
    });
    // Revoked in the App: the next attempt is not authorized; restored, it is again.
    app = withRole({ commands: [] });
    assert.equal(authorize(request), null);
    assert.deepEqual(jobGrantProblems(module, app), [
      'principal "review-clock" (roles automation) is not granted command "flagOverdueReview" in App "ignition".',
    ]);
    app = loaded.app;
    assert.ok(authorize(request));
    assert.equal(authorize({ ...request, version: 2 }), null);
    assert.equal(authorize({ ...request, provenance: { ...request.provenance, appId: 'elsewhere' } }), null);
  });
  test('refuses a role that grants generic writes or operations', () => {
    for (const [grant, problem] of [
      [{ write: true }, 'grants generic writes'],
      [{ write: ['review_alert'] }, 'grants generic writes'],
      [{ operations: ['readiness'] }, 'grants operations'],
    ] as const) {
      app = withRole(grant);
      assert.equal(authorize(request), null);
      assert.deepEqual(jobGrantProblems(module, app), [
        `principal "review-clock" cannot run job "reviewDue": role "automation" ${problem}.`,
      ]);
    }
    app = loaded.app;
  });
});

test("readiness carries the job host's codes", () => {
  const snapshot = buildReadiness('app', [
    { name: 'jobs', state: 'degraded', code: 'backlog_pressure' },
    { name: 'events.delivery', state: 'degraded', code: 'work_failed' },
    { name: 'worker', state: 'not_ready', code: 'worker_halted' },
  ]);
  assert.deepEqual(snapshot.summary, { total: 3, ready: 0, degraded: 2, notReady: 1 });
});
