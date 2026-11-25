/**
 * The as-of clock (engine http/clock.ts): `mistri dev --as-of`, MISTRI_AS_OF and the test kit's `asOf` start App
 * logic's clock at another moment and let it move on in real time, so seed data dated for one day reads as it was
 * written on every later one. A field report: moving the machine's clock instead broke sign-in. A date alone is
 * midnight in the App's zone; the flag is refused wherever it would reach a deployment; and only App logic reads it
 * — today, a window, a stamp — while sign-in keeps the real clock.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { appClockOffset, appTime, clockNow, configureAsOf, parseAsOf } from '../packages/engine/src/server/http/clock.js';
import { appClockNow, setAppClockOffset } from '../packages/engine/src/shared/appClock.js';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.js';
import { ROOT, childEnv, runCli } from './appApiCli.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);

afterEach(() => setAppClockOffset(0));

const iso = (at: Date | undefined) => at?.toISOString();

describe('parseAsOf', () => {
  test('a date alone is midnight in the zone given, UTC without one, across a daylight-saving change', () => {
    assert.equal(iso(parseAsOf('2026-01-05')), '2026-01-05T00:00:00.000Z');
    assert.equal(iso(parseAsOf('2026-01-05', 'America/Chicago')), '2026-01-05T06:00:00.000Z');
    assert.equal(iso(parseAsOf('2026-07-01', 'America/Chicago')), '2026-07-01T05:00:00.000Z');
    assert.equal(iso(parseAsOf('2026-01-05', 'Asia/Kolkata')), '2026-01-04T18:30:00.000Z');
  });

  test('a date and time is that wall clock in the zone, and one with an offset is that instant', () => {
    assert.equal(iso(parseAsOf('2026-01-05T09:30', 'America/Chicago')), '2026-01-05T15:30:00.000Z');
    assert.equal(iso(parseAsOf('2026-01-05 09:30:15')), '2026-01-05T09:30:15.000Z');
    assert.equal(iso(parseAsOf('2026-01-05T09:30Z', 'America/Chicago')), '2026-01-05T09:30:00.000Z');
    assert.equal(iso(parseAsOf('2026-01-05T09:30:00.250-05:00')), '2026-01-05T14:30:00.250Z');
    assert.equal(iso(parseAsOf('2026-01-05T09:30+0530')), '2026-01-05T04:00:00.000Z');
  });

  test('what names no moment names none: no rollover into the next day or hour', () => {
    for (const given of ['', 'tomorrow', '2026-02-30', '2026-13-01', '2026-01-05T24:00', '2026-01-05T09:61', '5 Jan 2026'])
      assert.equal(parseAsOf(given), undefined, given);
  });
});

describe('configureAsOf', () => {
  const NOW = Date.UTC(2026, 5, 1, 12);

  test('nothing asked sets nothing', () => {
    assert.equal(configureAsOf(undefined, { dev: false, env: {} }), undefined);
    assert.equal(configureAsOf(undefined, { dev: true, env: { MISTRI_AS_OF: '' } }), undefined);
    assert.equal(appClockOffset(), 0);
  });

  test('mistri dev, or a test process, starts the clock at the moment and lets it run on', () => {
    const at = configureAsOf('2026-01-05', { dev: true, env: {}, now: NOW, zone: 'America/Chicago' });
    assert.equal(iso(at), '2026-01-05T06:00:00.000Z');
    assert.equal(appClockOffset(), Date.UTC(2026, 0, 5, 6) - NOW);
    assert.equal(appTime(NOW + 90_000).toISOString(), '2026-01-05T06:01:30.000Z');
    const moved = appClockNow().getTime() - Date.now();
    assert.equal(moved, appClockOffset());

    setAppClockOffset(0);
    configureAsOf(undefined, { dev: false, env: { NODE_ENV: 'test', MISTRI_AS_OF: '2026-01-05T09:30Z' }, now: NOW });
    assert.equal(appClockOffset(), Date.UTC(2026, 0, 5, 9, 30) - NOW);
    assert.ok(Math.abs(clockNow().getTime() - (Date.now() + appClockOffset())) < 1000, 'clockNow reads it');
  });

  test('the flag wins over the variable', () => {
    configureAsOf('2026-03-01', { dev: true, env: { MISTRI_AS_OF: '2026-01-05' }, now: NOW, zone: 'UTC' });
    assert.equal(appClockOffset(), Date.UTC(2026, 2, 1) - NOW);
  });

  test('refused under production, for a build, and outside dev and tests, naming what asked', () => {
    assert.throws(
      () => configureAsOf('2026-01-05', { dev: true, env: { NODE_ENV: 'production' } }),
      /--as-of moves App logic's clock .* NODE_ENV is production\. Remove --as-of to serve\./,
    );
    assert.throws(
      () => configureAsOf(undefined, { dev: true, env: { NODE_ENV: 'production', MISTRI_AS_OF: '2026-01-05' } }),
      /MISTRI_AS_OF .* NODE_ENV is production\. Remove MISTRI_AS_OF/,
    );
    assert.throws(() => configureAsOf('2026-01-05', { dev: true, build: true, env: {} }), /--as-of .* serves a build/);
    assert.throws(() => configureAsOf('2026-01-05', { dev: false, env: {} }), /neither mistri dev nor a test process/);
    assert.equal(appClockOffset(), 0, 'a refusal moves nothing');
  });

  test('the MISTRI_CLOCK pin is held to the same rule: refused in production, for a build and outside dev and tests', () => {
    const PIN = { MISTRI_CLOCK: '2026-09-08T12:00:00Z' };
    assert.throws(
      () => configureAsOf(undefined, { dev: true, env: { ...PIN, NODE_ENV: 'production' } }),
      /MISTRI_CLOCK pins App logic's clock .* NODE_ENV is production\. Remove MISTRI_CLOCK to serve\./,
    );
    assert.throws(() => configureAsOf(undefined, { dev: true, build: true, env: { ...PIN } }), /MISTRI_CLOCK .* serves a build/);
    assert.throws(() => configureAsOf(undefined, { dev: false, env: { ...PIN } }), /MISTRI_CLOCK .* neither mistri dev nor a test/);
    assert.equal(configureAsOf(undefined, { dev: true, env: { ...PIN } }), undefined, 'honored under mistri dev');
    assert.equal(configureAsOf(undefined, { dev: false, env: { ...PIN, NODE_ENV: 'test' } }), undefined, 'and in a test process');
    assert.equal(configureAsOf(undefined, { dev: false, env: { MISTRI_CLOCK: '', NODE_ENV: 'production' } }), undefined);
  });

  test('a pin that reaches a production process is not read', (t) => {
    const saved = { clock: process.env.MISTRI_CLOCK, node: process.env.NODE_ENV };
    t.after(() => {
      for (const [key, value] of [
        ['MISTRI_CLOCK', saved.clock],
        ['NODE_ENV', saved.node],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    });
    process.env.MISTRI_CLOCK = '2020-01-01T00:00:00Z';
    process.env.NODE_ENV = 'test';
    assert.equal(clockNow().toISOString(), '2020-01-01T00:00:00.000Z');
    process.env.NODE_ENV = 'production';
    assert.ok(Math.abs(clockNow().getTime() - Date.now()) < 1000);
  });

  test('a value that names no moment is refused, saying what it takes', () => {
    assert.throws(() => configureAsOf('', { dev: true, env: {} }), /--as-of takes a date .* it got ""/);
    assert.throws(
      () => configureAsOf(undefined, { dev: true, env: { MISTRI_AS_OF: 'next tuesday' } }),
      /MISTRI_AS_OF takes a date \(2026-01-05, midnight in the App's zone\).* it got "next tuesday"/,
    );
    assert.equal(appClockOffset(), 0);
  });
});

test(
  'an App served as of another day reads today, its windows and its stamps from that day; sign-in still works',
  { timeout: 120_000 },
  async (t) => {
    const workspace = await createTestWorkspace();
    t.after(() => workspace.close());
    const database = await workspace.database('desk.db', (db) =>
      db.exec(`
      CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, due_on TEXT NOT NULL, opened_on TEXT NOT NULL,
        done_at TEXT);
      INSERT INTO task (id, title, due_on, opened_on) VALUES
        (1, 'Due on the day', '2026-01-05', '2026-01-02'),
        (2, 'Due the day after', '2026-01-06', '2025-11-01'),
        (3, 'Due the day before', '2026-01-04', '2026-01-04');
    `),
    );
    await workspace.write('app/app.json', {
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: {
        task: { access: 'write', actions: { finish: { label: 'Finish', set: { done_at: { auto: 'now' } }, when: 'done_at is empty' } } },
      },
      auth: { providers: ['email'], store: workspace.path('auth.db'), roles: { desk: { read: true, write: true } } },
      views: { tasks: { kind: 'list', from: 'task' } },
      home: 'tasks',
      nav: ['tasks'],
    });
    const host = await startTestApp({ workspace, directory: workspace.path('app'), database, asOf: '2026-01-05' });
    t.after(() => host.close());

    /* The App names no zone, so the 5th is midnight in the server's own: the zone its `today` is counted in. */
    /* Signing in is the real clock's: a session made as of January would have expired long before now. */
    const desk = await host.as('desk');
    const payload = (await (await desk.request(`/api/app?app=${await desk.appId()}`)).json()) as { app: { ui: { clockOffset?: number } } };
    const offset = payload.app.ui.clockOffset;
    assert.ok(offset !== undefined && Math.abs(offset - (new Date(2026, 0, 5).getTime() - Date.now())) < 120_000, `offset ${offset}`);

    const ids = (read: Awaited<ReturnType<typeof desk.rows>>) => {
      assert.ok(read.ok, JSON.stringify(read));
      return read.value.map((row) => Number(row.id)).sort();
    };
    assert.deepEqual(ids(await desk.rows('task', { where: 'due_on = today' })), [1]);
    assert.deepEqual(ids(await desk.rows('task', { where: 'opened_on = last 7 days' })), [1, 3]);

    const finished = await desk.act('task', 'finish', { where: 'id = 2' });
    assert.ok(finished.ok, JSON.stringify(finished));
    const read = await desk.rows('task', { where: 'id = 2' });
    assert.ok(read.ok, JSON.stringify(read));
    assert.match(String(read.value[0].done_at), /^2026-01-05/, 'the stamp an action writes is the as-of day');
  },
);

test(
  'a job and a workflow read the as-of day in w.now(), w.until() and the commands they run, without shifting real timers twice',
  { timeout: 120_000 },
  async (t) => {
    const workspace = await createTestWorkspace();
    t.after(() => workspace.close());
    const database = await workspace.database('desk.db', (db) =>
      db.exec(`
      CREATE TABLE task (id INTEGER PRIMARY KEY, due_on DATE NOT NULL);
      CREATE TABLE stamp (id INTEGER PRIMARY KEY, source TEXT NOT NULL, due_ids TEXT NOT NULL, clock TEXT NOT NULL);
      INSERT INTO task (id, due_on) VALUES (1, '2026-01-05'), (2, '2026-01-06'), (3, '2026-01-04');
    `),
    );
    await workspace.write('app/app.json', {
      id: 'desk',
      name: 'Desk',
      ui: { timezone: 'UTC' },
      sources: { desk: { connection: 'desk' } },
      resources: { task: { access: 'write' }, stamp: { access: 'write' } },
      auth: {
        providers: ['email'],
        store: workspace.path('auth.db'),
        roles: {
          desk: { read: true, commands: ['kickoff'] },
          automation: { read: true, service: true, commands: ['jobStamp', 'workflowStamp'] },
        },
      },
      views: { stamps: { kind: 'list', from: 'stamp' } },
      home: 'stamps',
    });
    const events = workspace.path('app/events.mjs');
    writeFileSync(
      events,
      `import { defineEvent, shape, text } from ${src('packages/mistri/src/server/commands.ts')};
export const Started = defineEvent('desk.started', shape({ key: text() }));
`,
    );
    const commands = workspace.path('app/commands.mjs');
    writeFileSync(
      commands,
      `import { defineCommand, defineCommands, defineEventProjection, field, shape, text } from ${src('packages/mistri/src/server/commands.ts')};
import { Started } from './events.mjs';
export default defineCommands({
  kickoff: defineCommand({
    source: 'desk',
    target: 'stamp',
    targets: 'none',
    input: { key: field.text() },
    output: shape({ key: text() }),
    events: { started: defineEventProjection(Started, (out) => ({ key: out.key })) },
    async handle(_ctx, input) { return { key: input.key }; },
  }),
  jobStamp: defineCommand({
    source: 'desk',
    target: 'stamp',
    targets: 'none',
    read: ['task'],
    write: ['stamp'],
    input: {},
    async handle({ db }) {
      const due = await db.task.where('due_on = today');
      await db.stamp.insert({
        source: 'job',
        due_ids: due.map((row) => row.id).sort().join(','),
        clock: due.map((row) => row.due_on).join(','),
      });
    },
  }),
  workflowStamp: defineCommand({
    source: 'desk',
    target: 'stamp',
    targets: 'none',
    read: ['task'],
    write: ['stamp'],
    input: { clock: field.text() },
    async handle({ db }, input) {
      const due = await db.task.where('due_on = today');
      await db.stamp.insert({
        source: 'workflow',
        due_ids: due.map((row) => row.id).sort().join(','),
        clock: input.clock,
      });
    },
  }),
});
`,
    );
    const jobs = workspace.path('app/jobs.mjs');
    writeFileSync(
      jobs,
      `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
import { defineWorkflow, defineWorkflows } from ${src('packages/mistri/src/server/workflows.ts')};
import { Started } from './events.mjs';
export default defineJobs(
  { daily: defineJob({ every: '* * * * *', runAs: 'clock', command: 'jobStamp' }) },
  {
    principals: { clock: { roles: ['automation'] } },
    workflows: defineWorkflows({
      follow: defineWorkflow({
        runAs: 'clock',
        start: { event: Started, key: (event) => event.key },
        async run(w) {
          const at = await w.now('startedAt');
          await w.until('brief', new Date(at.getTime() + 40));
          await w.run('stamp', 'workflowStamp', { input: { clock: at.toISOString() } });
          return { clock: at.toISOString() };
        },
      }),
    }),
  },
);
`,
    );
    const config = workspace.path('mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: database, writable: true }] }));
    const env = childEnv({ XDG_CONFIG_HOME: workspace.path('config') });
    const up = await runCli(
      ['migrate', 'stores', 'up', '--app', workspace.path('app'), '--commands', commands, '--jobs', jobs, '--config', config],
      env,
    );
    assert.equal(up.code, 0, up.out + up.err);

    const host = await startTestApp({
      workspace,
      directory: workspace.path('app'),
      config,
      args: ['--commands', commands, '--jobs', jobs],
      environment: { XDG_CONFIG_HOME: workspace.path('config') },
      asOf: '2026-01-05T09:30:00Z',
      jobs: 'manual',
    });
    t.after(() => host.close());

    const ran = await host.runJob('daily');
    assert.equal(ran.state, 'succeeded', `${JSON.stringify(ran)}\n${host.logs()}`);
    const desk = await host.as('desk');
    const kicked = await desk.command('kickoff', {}, { key: 'run-1' });
    assert.ok(kicked.ok, JSON.stringify(kicked));

    const deadline = Date.now() + 15_000;
    let stamps: ReadonlyArray<Record<string, unknown>> = [];
    while (Date.now() < deadline) {
      const read = await desk.rows('stamp', {});
      assert.ok(read.ok, JSON.stringify(read));
      stamps = read.value;
      if (stamps.length >= 2) break;
      await delay(50);
    }
    assert.equal(stamps.length, 2, `${JSON.stringify(stamps)}\n${host.logs()}`);
    const byJob = stamps.find((row) => row.source === 'job')!;
    const byWorkflow = stamps.find((row) => row.source === 'workflow')!;
    assert.equal(byJob.due_ids, '1', 'a job command counts today once on the as-of day, not twice');
    assert.equal(byJob.clock, '2026-01-05');
    assert.equal(byWorkflow.due_ids, '1', 'a workflow step command counts today on the as-of day');
    assert.match(String(byWorkflow.clock), /^2026-01-05T09:30:/, 'w.now() and w.until() run on the as-of clock');
  },
);
