/**
 * Decisions running in a real server (the CLI, over SQLite), answered by the
 * scripted providers: no network. An event decision is asked after its
 * command commits and acts on its probability — applied with a pinned model,
 * suggested between the thresholds, and only suggested beside a value a
 * person already set; a clock decision sweeps the records `where` holds,
 * one run each. Every row says what was asked, of whom, and what came of it;
 * no input value is stored. The decided fields ride the App payload.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { createTestWorkspace, startTestApp } from '../packages/mistri/src/server/testing.js';
import { openSqliteDecisions } from '../packages/mistri/src/adapters/decide/sqliteDecisions.js';
import type { StoredDecision } from '../packages/mistri/src/adapters/decide/decisionStore.js';
import { decisionDigests } from '../packages/mistri/src/server/decide/decisionCheck.js';
import { decisionLockText, readDecisionLock, withPin } from '../packages/mistri/src/server/decide/decisionLock.js';
import { capturedJobModule } from '../packages/mistri/src/server/jobs/jobModule.js';
import { ROOT, childEnv, runCli } from './appApiCli.js';

const src = (path: string) => JSON.stringify(pathToFileURL(join(ROOT, path)).href);
const settle = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 30_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (done(value) || Date.now() > deadline) return value;
    await settle(200);
  }
}

test('decisions run after a commit and on a clock, act on their probability, and record each outcome', { timeout: 240_000 }, async (t) => {
  const workspace = await createTestWorkspace();
  t.after(() => workspace.close());
  const database = await workspace.database('desk.db', (db) =>
    db.exec(`
      CREATE TABLE team (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE incident (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new',
        category TEXT, team_id INTEGER REFERENCES team(id), secret TEXT);
      INSERT INTO team VALUES (1, 'Network team'), (2, 'Service desk');
      INSERT INTO incident (id, title, status, category, secret) VALUES
        (1, 'VPN down for everyone', 'new', NULL, 's1'), (2, 'Printer jams on floor 3', 'new', NULL, 's2'),
        (3, 'Laptop is slow', 'new', 'hardware', 's3'), (4, 'Old ticket', 'closed', NULL, 's4');
    `),
  );
  await workspace.write('app/app.json', {
    id: 'desk',
    name: 'Desk',
    sources: { desk: { connection: 'desk' } },
    resources: {
      incident: {
        access: 'write',
        actions: {
          flag: { label: 'Flag', command: 'flag' },
          categorize: { label: 'Categorize', command: 'categorize' },
          route: { label: 'Route', command: 'route' },
        },
      },
      team: {},
    },
    auth: {
      providers: ['email'],
      store: workspace.path('auth.db'),
      roles: {
        automation: { read: true, commands: ['categorize', 'route'] },
        agent: { read: true, commands: ['flag', 'categorize', 'route'] },
        // Reads every incident, and may accept none of the suggestions on them.
        viewer: { read: true },
        // May accept a category, and not a team.
        sorter: { read: true, commands: ['categorize'] },
      },
    },
    views: { incidents: { kind: 'list', from: 'incident' } },
    home: 'incidents',
  });
  writeFileSync(
    workspace.path('app/commands.mjs'),
    `import { defineCommand, defineCommands, defineEvent, defineEventProjection, field, int, shape } from ${src('packages/mistri/src/server/commands.ts')};
export const flagged = defineEvent('incident.flagged', shape({ id: int() }));
export default defineCommands({
  flag: defineCommand({ source: 'desk', target: 'incident', input: {}, output: shape({ id: int() }),
    events: { flagged: defineEventProjection(flagged, (output) => ({ id: output.id })) },
    async handle({ db, record }) { await db.incident.update(record, { status: 'flagged' }); return { id: record.id }; } }),
  categorize: defineCommand({ source: 'desk', target: 'incident',
    input: { category: field.choice(['network', 'hardware', 'printer']) },
    async handle({ db, record }, input) { await db.incident.update(record, { category: input.category }); } }),
  route: defineCommand({ source: 'desk', target: 'incident', read: ['team'],
    input: { team_id: field.reference('team', { by: 'id', labelColumn: 'name' }) },
    async handle({ db, record }, input) { await db.incident.update(record, { team_id: input.team_id }); } }),
});
`,
  );
  writeFileSync(
    workspace.path('app/jobs.mjs'),
    `import { defineDecision, defineDecisions, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
import { flagged } from './commands.mjs';
export default defineJobs({}, {
  principals: { triage: { roles: ['automation'] } },
  decisions: defineDecisions({
    triageCategory: defineDecision({
      question: 'Which category is this incident?', target: 'incident', inputs: ['title'],
      answer: { command: 'categorize', field: 'category' },
      on: { event: flagged, command: 'flag', key: (event) => ({ id: event.id }) },
      apply: 0.9, runAs: 'triage', provider: 'jev',
    }),
    routeTeam: defineDecision({
      question: 'Which team should take it?', target: 'incident', inputs: ['title', 'category'],
      answer: { command: 'route', field: 'team_id' },
      every: '0 0 1 1 *', where: 'status = flagged', runAs: 'triage', provider: ['jev', 'anthropic'],
    }),
  }),
});
`,
  );
  const config = workspace.path('mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: database, writable: true }] }));
  const jobsFile = workspace.path('app/jobs.mjs');
  const env = childEnv({ XDG_CONFIG_HOME: workspace.path('config') });
  const up = await runCli(['migrate', 'stores', 'up', '--app', workspace.path('app'), '--jobs', jobsFile, '--config', config], env);
  assert.equal(up.code, 0, up.out + up.err);

  // The lock pins the scripted model for the event decision: only it may apply.
  const commands = (await import(pathToFileURL(workspace.path('app/commands.mjs')).href)).default;
  const module = capturedJobModule((await import(pathToFileURL(jobsFile).href)).default);
  const digests = decisionDigests(module.decisions!.values(), commands);
  const digest = digests.get('triageCategory')!;
  const lock = withPin(new Map([['triageCategory', { version: 1, digest, pins: [] }]]), 'triageCategory', digest, {
    provider: 'jev',
    modelVersion: 'jev-1-2026-10',
    error: 0.01,
    n: 200,
    at: '2026-10-23',
  });
  lock.set('routeTeam', { version: 1, digest: digests.get('routeTeam')!, pins: [] });
  writeFileSync(workspace.path('app/decisions.lock'), decisionLockText(lock));
  assert.equal(readDecisionLock(decisionLockText(lock)).get('triageCategory')?.pins.length, 1);

  const host = await startTestApp({
    workspace,
    directory: workspace.path('app'),
    config,
    args: ['--commands', workspace.path('app/commands.mjs'), '--jobs', jobsFile],
    environment: { XDG_CONFIG_HOME: workspace.path('config') },
    decisions: {
      model: 'jev-1',
      modelVersion: 'jev-1-2026-10',
      decisions: {
        triageCategory: [
          { when: { title: 'VPN' }, answer: 'network', probability: 0.97 },
          { when: { title: 'Printer' }, answer: 'printer', probability: 0.72 },
          { when: { title: 'Laptop' }, answer: 'printer', probability: 0.95 },
        ],
        routeTeam: [
          { when: { category: 'network' }, answer: 1, probability: 0.8 },
          { answer: 2, probability: 0.4 },
        ],
      },
    },
  });
  const agent = await host.as('agent');

  // The decided fields ride the App payload: where a record reserves a suggestion's place.
  const payload = (await (await agent.request(`/api/app?app=${await agent.appId()}`)).json()) as { app: { decisions?: unknown } };
  assert.deepEqual(payload.app.decisions, {
    incident: {
      category: { decision: 'triageCategory', command: 'categorize' },
      team_id: { decision: 'routeTeam', command: 'route' },
    },
  });

  for (const id of [1, 2, 3]) {
    const flagged = await agent.command('flag', { id });
    assert.ok(flagged.ok, JSON.stringify(flagged) + host.logs());
  }
  const store = openSqliteDecisions(database);
  t.after(() => store.close());
  const owner = { app: 'desk', tenant: '' };
  const rows = async (key: number) => store.ofRecord(owner, 'incident', JSON.stringify({ id: key }), 10);
  const settled = (list: StoredDecision[]) => list.length > 0 && list.every((row) => row.outcomeReason !== 'pending');
  const [vpn, printer, laptop] = await Promise.all([1, 2, 3].map((id) => eventually(() => rows(id), settled)));

  const read = () => {
    const db = new DatabaseSync(database, { readOnly: true, timeout: 10_000 });
    try {
      return db.prepare('SELECT id, category, team_id FROM incident ORDER BY id').all() as Array<{
        id: number;
        category: string | null;
        team_id: number | null;
      }>;
    } finally {
      db.close();
    }
  };
  // p ≥ apply on a pinned model, into an empty field: the command ran.
  assert.deepEqual([vpn[0].outcome, vpn[0].answer, vpn[0].probability], ['applied', 'network', 0.97]);
  assert.equal(read()[0].category, 'network');
  // Between the thresholds: offered, nothing written.
  assert.deepEqual([printer[0].outcome, printer[0].answer], ['suggested', 'printer']);
  assert.equal(read()[1].category, null);
  // Confident, but the field holds a person's value: never overwritten, only offered beside it.
  assert.deepEqual([laptop[0].outcome, laptop[0].outcomeReason], ['suggested', 'filled']);
  assert.equal(read()[2].category, 'hardware');
  // What was asked is named and digested, never kept: the row holds field names, a digest and the answer.
  assert.deepEqual(vpn[0].inputFields, ['title']);
  assert.match(vpn[0].inputsDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual([vpn[0].provider, vpn[0].modelVersion, vpn[0].contractVersion], ['jev', 'jev-1-2026-10', 1]);
  assert.ok(!JSON.stringify(vpn).includes('VPN'), 'no input value is stored');
  // The waiting suggestions of a list, newest per decision per record.
  assert.deepEqual((await store.waiting(owner, 'incident', ['{"id":1}', '{"id":2}', '{"id":3}'])).map((row) => row.recordKey).sort(), [
    '{"id":2}',
    '{"id":3}',
  ]);

  // A record's waiting suggestions, as the person reading it is served them: the answer by its words, where it stands.
  const appId = await agent.appId();
  const post = async (path: string, json: Record<string, unknown>) => {
    const response = await agent.request(path, { method: 'POST', json: { app: appId, ...json } });
    assert.equal(response.status, 200, `${path}: ${response.status} ${await response.clone().text()}`);
    return (await response.json()) as Record<string, any>;
  };
  const suggestions = async (id: number | string) => (await post('/api/record-decisions', { table: 'incident', key: { id } })).suggestions;
  const [onPrinter] = await suggestions(2);
  assert.deepEqual(
    [onPrinter.field, onPrinter.label, onPrinter.command, onPrinter.probability, onPrinter.filled],
    ['category', 'printer', 'categorize', 0.72, false],
  );
  const [onLaptop] = await suggestions(3);
  assert.equal(onLaptop.filled, true, 'beside a value a person set, it trails that value');
  assert.deepEqual(await suggestions('3'), [onLaptop], "a record's address carries its key as text, and still finds it");
  assert.deepEqual(await suggestions(1), [], 'applied is a value like any other: its provenance is the history line');
  // "Why this?": the question, the inputs by name with what they hold now, and who answered how surely. No reasoning.
  const reason = await post('/api/record-decisions/why', { id: onPrinter.id });
  assert.equal(reason.question, 'Which category is this incident?');
  assert.deepEqual(reason.inputs, [{ name: 'title', label: 'Title', value: 'Printer jams on floor 3', readable: true }]);
  assert.deepEqual([reason.provider, reason.modelVersion, reason.probability], ['jev', 'jev-1-2026-10', 0.72]);
  // Accept runs the answer command as the person; settling reads what landed.
  assert.ok((await agent.command('categorize', { id: 2 }, { category: 'printer' })).ok);
  assert.deepEqual(await post('/api/record-decisions/settle', { id: onPrinter.id, action: 'done' }), { outcome: 'accepted' });
  assert.deepEqual(await post('/api/record-decisions/settle', { id: onLaptop.id, action: 'dismiss' }), { outcome: 'ignored' });
  assert.deepEqual(await suggestions(3), []);
  const outcome = async (id: number, decision: string) => (await rows(id)).find((row) => row.decision === decision)!;
  assert.deepEqual(
    [(await outcome(2, 'triageCategory')).outcome, (await outcome(2, 'triageCategory')).outcomeBy !== ''],
    ['accepted', true],
  );
  assert.equal((await outcome(3, 'triageCategory')).outcomeReason, 'dismissed');
  // Another reader's record, or a key that is not one, is not answered.
  const stranger = await agent.request('/api/record-decisions', {
    method: 'POST',
    json: { app: appId, table: 'incident', key: { id: 99 } },
  });
  assert.equal(stranger.status, 403);

  // A clock decision: the sweep finds the flagged records, and each is a run of its own.
  const swept = await host.runJob('decide-routeTeam');
  assert.equal(swept.state, 'succeeded', JSON.stringify(swept));
  const route = async (id: number) => (await rows(id)).filter((row) => row.decision === 'routeTeam');
  const [one, two, three] = await Promise.all([1, 2, 3].map((id) => eventually(() => route(id), settled)));
  assert.deepEqual([one[0].outcome, one[0].answer], ['suggested', 1], 'no apply threshold: it only suggests');
  assert.deepEqual([two[0].outcome, three[0].outcome], ['below', 'below']);
  assert.match(one[0].trigger, /^every:manual-/);
  assert.equal(one[0].choicesDigest.length, 64, 'a reference answer records the choices offered');
  assert.deepEqual(await route(4), [], 'a record `where` does not hold is not asked about');
  assert.equal(read()[0].team_id, null);
  // A list's marks: the rows with a suggestion waiting on an empty field, said by its words.
  const marks = await post('/api/record-decisions/marks', { table: 'incident', keys: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] });
  assert.deepEqual(marks.marks, [{ row: 0, field: 'team_id', label: 'Network team' }]);

  /* A suggestion is for the people who could accept it: those granted its answer command. A reader of the same
     field who is not is told of none — no payload field, no suggestion, no mark — and refused its "Why this?" and
     its settling, by the server, whatever the page asks. */
  const asking = async (role: string) => {
    const client = await host.as(role);
    const said = async (path: string, json: Record<string, unknown>) => {
      const response = await client.request(path, { method: 'POST', json: { app: appId, ...json } });
      return { status: response.status, body: (await response.json()) as Record<string, any> };
    };
    const payload = (await (await client.request(`/api/app?app=${appId}`)).json()) as { app: { decisions?: unknown } };
    return { said, decisions: payload.app.decisions };
  };
  const viewer = await asking('viewer');
  assert.equal(viewer.decisions, undefined, 'no decided field is reserved for a reader who could accept none');
  assert.deepEqual((await viewer.said('/api/record-decisions', { table: 'incident', key: { id: 1 } })).body, { suggestions: [] });
  assert.deepEqual((await viewer.said('/api/record-decisions/marks', { table: 'incident', keys: [{ id: 1 }, { id: 2 }] })).body, {
    marks: [],
  });
  const [teamSuggestion] = (await post('/api/record-decisions', { table: 'incident', key: { id: 1 } })).suggestions;
  assert.equal(teamSuggestion.field, 'team_id', 'the agent, who may route, is offered the team');
  assert.equal((await viewer.said('/api/record-decisions/why', { id: teamSuggestion.id })).status, 403);
  assert.equal((await viewer.said('/api/record-decisions/settle', { id: teamSuggestion.id, action: 'dismiss' })).status, 403);
  // Granted one answer command and not the other: offered that decision's field alone.
  const sorter = await asking('sorter');
  assert.deepEqual(sorter.decisions, { incident: { category: { decision: 'triageCategory', command: 'categorize' } } });
  assert.deepEqual((await sorter.said('/api/record-decisions', { table: 'incident', key: { id: 1 } })).body, { suggestions: [] });
  assert.deepEqual((await sorter.said('/api/record-decisions/marks', { table: 'incident', keys: [{ id: 1 }, { id: 2 }] })).body, {
    marks: [],
  });
  assert.equal((await sorter.said('/api/record-decisions/why', { id: teamSuggestion.id })).status, 403);
  // The refusals moved nothing: the agent still has the suggestion waiting.
  assert.deepEqual(
    (await post('/api/record-decisions', { table: 'incident', key: { id: 1 } })).suggestions.map((each: { id: string }) => each.id),
    [teamSuggestion.id],
  );
  // A person changing an applied value corrects it: what auto-apply's accuracy is judged by.
  assert.ok((await agent.command('categorize', { id: 1 }, { category: 'hardware' })).ok);
  await suggestions(1);
  const corrected = await outcome(1, 'triageCategory');
  assert.deepEqual([corrected.outcome, corrected.outcomeReason, corrected.correctedTo], ['corrected', 'edited', 'hardware']);
  const usage = await store.usage('desk', undefined, '2000-01-01');
  assert.equal(usage[0].calls, 6, 'three event decisions and three swept: one call each');
});
