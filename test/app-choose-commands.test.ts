/**
 * An App's `choose` at the command door (http/commandRoutes.ts): a command that runs for a signed-in person is told
 * the App-wide row they picked as `ctx.chosen`, and its `where` text can say `chosen.site`. Both the one-shot execute
 * and a signed-in form's draft step carry it. The pick is the tab's header, else the person's stored pick (POST
 * /api/choose), and is re-read under the person's own grants: a site they cannot read is not chosen, which reads as
 * undefined in `ctx.chosen` and matches no row in a where, never every row.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { literal, shape } from '../packages/mistri/src/server/commands/commandShapes.js';
import { commandEnvelope } from '../packages/mistri/src/server/testing/appRequests.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { refusalReasons } from '../packages/engine/src/server/evidence.js';
import { createApp } from './support/createApp.js';
import { policyServer, sourceUrl } from './support/policyServer.js';
import { parseTestApp } from './support/commandCatalog.js';

const nameInput = { full_name: { label: 'Full name', type: 'text', max: 60 } } as const;
const submitInput = { consent: { label: 'These details are true', type: 'boolean' } } as const;
const reference = (id: string, input: object) => ({ id, version: 1, input });

let envelopes = 0;
const envelope = (command: string, input: object) =>
  commandEnvelope({
    command,
    commandVersion: 1,
    key: {},
    expectedVersion: 0,
    input,
    idempotencyKey: `choose-commands-${String(++envelopes).padStart(6, '0')}-key`,
  });

/** What the handlers saw: `ctx.chosen`, and the visit ids a `where` naming `chosen.site` matched. */
const seen: Array<{ door: string; chosen: Record<string, unknown>; ids: number[] }> = [];

const READ = ['visit', 'onboarding', 'person'] as const;
const base = { targets: 'none', source: 'main', target: 'onboarding', read: READ } as const;
const commands = defineCommands({
  // The one-shot door: records what it was told and writes a row, so it is a real command.
  tally: defineCommand({
    ...base,
    write: ['onboarding'],
    input: nameInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, chosen }, input) {
      const rows = await db.visit.where('site_id = chosen.site');
      seen.push({ door: 'execute', chosen: { ...chosen }, ids: rows.map((row) => row.id as number).sort() });
      await db.onboarding.insert({ ...input, status: 'submitted', person_id: 1 });
      return { message: 'Saved.' as const };
    },
  }),
  // The draft door: a signed-in form's step, which runs the same handler context.
  startOnboarding: defineCommand({
    ...base,
    write: ['onboarding'],
    input: nameInput,
    output: shape({ message: literal('Saved.') }),
    async handle({ db, draft, chosen }, input) {
      if (!draft) return refuse('forbidden');
      const rows = await db.visit.where('site_id = chosen.site');
      seen.push({ door: 'draft', chosen: { ...chosen }, ids: rows.map((row) => row.id as number).sort() });
      if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
      else await db.onboarding.insert({ ...input, ...draft.start });
      return { message: 'Saved.' as const };
    },
  }),
  submitOnboarding: defineCommand({
    ...base,
    write: ['onboarding'],
    input: submitInput,
    output: shape({ message: literal('Saved.') }),
    async handle() {
      return { message: 'Saved.' as const };
    },
  }),
});

const config = {
  id: 'clinic',
  name: 'Clinic',
  auth: {
    providers: ['email'],
    me: { from: 'person', column: 'email' },
    roles: {
      // A nurse reads sites; a clerk reads visits but no site, so no site is theirs to pick.
      nurse: { read: true, commands: ['tally', 'startOnboarding', 'submitOnboarding'] },
      clerk: { read: ['visit', 'onboarding', 'person'], commands: ['tally', 'startOnboarding', 'submitOnboarding'] },
      automation: { read: true, commands: ['tally'], service: true },
    },
  },
  sources: { main: { connection: 'clinic-db' } },
  resources: { site: {}, visit: {}, person: {}, onboarding: { access: 'write' } },
  choose: { site: { from: 'site', label: 'name' } },
  views: {
    visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' },
    onboard: {
      kind: 'form',
      label: 'Onboarding',
      command: reference('submitOnboarding', submitInput),
      steps: [{ id: 'you', label: 'You', command: reference('startOnboarding', nameInput) }],
      resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
      draft: { status: 'in_progress' },
      owner: 'person_id',
    },
  },
  home: 'visits',
  nav: ['visits', 'onboard'],
};

async function prove(door: 'execute' | 'draft') {
  {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-choose-commands-'));
    const previous = process.env.XDG_CONFIG_HOME;
    const file = join(directory, 'clinic.db');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT);
      CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
      CREATE TABLE onboarding (id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id),
        full_name TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
      INSERT INTO site VALUES (1, 'North'), (2, 'South'), (3, 'East');
      INSERT INTO visit VALUES (10, 1, 'a'), (11, 2, 'b'), (12, 3, 'c'), (13, 1, 'd');
      INSERT INTO person VALUES (1, 'ana@clinic.test'), (2, 'bo@clinic.test');
    `);
    db.close();
    migrateSqliteCommandJournal(file);
    provisionSqlitePreferences(file);
    clearJournal('clinic-db');
    const registry = new Registry();
    registry.add({ id: 'clinic-db', name: 'Clinic', url: file, writable: true, source: 'config' });
    const app = parseTestApp(config, 'choose commands fixture');
    const as = { email: 'ana@clinic.test', role: 'nurse' };
    const host: AppHost = {
      app: { app, path: '/private/clinic/app.ts', pages: [], sources: {} },
      pages: [],
      auth: {
        spec: app.auth!,
        store: join(directory, 'sessions.db'),
        close() {},
        handler: async () => {},
        session: async () => ({ id: `account-${as.email}`, who: as.email, role: as.role }),
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [], commands: { appId: 'clinic', registry: commands } });
    process.env.XDG_CONFIG_HOME = directory;
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const base = `http://${bound.host}:${address.port}`;
      const post = async (route: string, body: Record<string, unknown>, chosen?: string) => {
        const response = await fetch(`${base}${route}`, {
          signal: AbortSignal.timeout(10_000),
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: base,
            ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      /* One run through each door; what the handler saw, or undefined where it was refused before running. */
      const execute = async (chosen?: string) => {
        seen.length = 0;
        const reply = await post('/api/commands/execute', { ...envelope('tally', { full_name: 'x' }) }, chosen);
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(seen.length, 1);
        return seen[0];
      };
      const step = async (chosen?: string) => {
        seen.length = 0;
        const reply = await post(
          '/api/commands/draft',
          { form: 'onboard', op: 'step', step: 'you', request: envelope('startOnboarding', { full_name: 'y' }) },
          chosen,
        );
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        assert.equal(seen.length, 1);
        return seen[0];
      };
      const run = door === 'execute' ? execute : step;
      {
        as.email = 'ana@clinic.test';
        as.role = 'nurse';
        const label = (what: string) => `${door}: ${what}`;
        // (a) The header's pick reaches ctx.chosen, and the where is narrowed to that site.
        assert.deepEqual(await run('site=1'), { door, chosen: { site: 1 }, ids: [10, 13] }, label('header'));
        assert.deepEqual(await run('site=2'), { door, chosen: { site: 2 }, ids: [11] }, label('another header'));
        // A site that is no row is not chosen: nothing is chosen, so the where matches nothing rather than everything.
        assert.deepEqual(await run('site=999'), { door, chosen: { site: undefined }, ids: [] }, label('forged'));
        // (b) With no header, the stored pick is the default; a header still wins.
        assert.deepEqual(await run(), { door, chosen: { site: undefined }, ids: [] }, label('nothing stored yet'));
        assert.equal((await post('/api/choose', { app: 'clinic', name: 'site', value: '2' })).status, 200);
        assert.deepEqual(await run(), { door, chosen: { site: 2 }, ids: [11] }, label('stored'));
        assert.deepEqual(await run('site=1'), { door, chosen: { site: 1 }, ids: [10, 13] }, label('header beats stored'));
        // (c) A clerk reads no site: whatever the tab sends, nothing is chosen and the where matches no row.
        as.email = 'bo@clinic.test';
        as.role = 'clerk';
        assert.deepEqual(await run('site=1'), { door, chosen: { site: undefined }, ids: [] }, label('a pick the grant cannot read'));
        // The nurse's stored pick is theirs alone: the clerk's own default is nothing.
        assert.deepEqual(await run(), { door, chosen: { site: undefined }, ids: [] }, label("another's stored pick"));
        // Clear the nurse's pick so the next door starts as the first did.
        as.email = 'ana@clinic.test';
        as.role = 'nurse';
        assert.equal((await post('/api/choose', { app: 'clinic', name: 'site', value: null })).status, 200);
      }
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal('clinic-db');
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

test(
  "a command's ctx.chosen and chosen.site are the header's pick, else the stored one, re-read under the person",
  { timeout: 30_000 },
  () => prove('execute'),
);

test("the same holds on a signed-in form's draft step", { timeout: 30_000 }, () => prove('draft'));

test('a job runs with nothing chosen: its where naming chosen.site is refused, and says to take the site as input', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-choose-job-'));
  const file = join(directory, 'clinic.db');
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT);
    CREATE TABLE person (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
    CREATE TABLE onboarding (id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id),
      full_name TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    INSERT INTO site VALUES (1, 'North');
    INSERT INTO visit VALUES (10, 1, 'a');
  `);
  db.close();
  migrateSqliteCommandJournal(file);
  clearJournal('clinic-db');
  const registry = new Registry();
  registry.add({ id: 'clinic-db', name: 'Clinic', url: file, writable: true, source: 'config' });
  try {
    const app = parseTestApp(config, 'choose job fixture');
    const resources = await loadAppRuntimeResources(registry, app, 'clinic-db');
    const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
    seen.length = 0;
    // The caller is told only that the command could not be completed; the words are the trusted record's, below it.
    const refused = await executeBusinessCommand(
      binding,
      { id: 'service:clock', kind: 'service', appId: 'clinic', roles: ['automation'] },
      envelope('tally', { full_name: 'x' }),
      { door: 'job' },
    ).then(
      () => assert.fail('a job has nothing chosen, so its where cannot run'),
      (error: unknown) => error,
    );
    assert.deepEqual(
      refusalReasons(refused).map((reason) => reason.replace(/^visit: /, '')),
      [
        `chosen.site is the person's App choice, and nothing here runs for a person at a desk (a job, a workflow step, an API call): take it as input, or quote it ("chosen.site") to mean the text.`,
      ],
    );
    assert.deepEqual(seen, [], 'the handler never got past its where');
  } finally {
    await registry.closeAll();
    clearJournal('clinic-db');
    rmSync(directory, { recursive: true, force: true });
  }
});

/* The same under a row policy (`auth.rows: 'policy'`), over the real server: a command's `ctx.chosen` is read under the
   rows the policy gives the person, so a site their rows hide is not theirs to pick. The handlers hand back what they
   saw as their result, since they run in the server's own process. */
const POLICY_SQL = `CREATE TABLE site(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE visit(id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT);
  CREATE TABLE person(id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL);
  CREATE TABLE log(id INTEGER PRIMARY KEY, note TEXT);
  CREATE TABLE onboarding(id INTEGER PRIMARY KEY, status TEXT NOT NULL, person_id INTEGER NOT NULL REFERENCES person(id),
    full_name TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
  INSERT INTO site VALUES (1, 'North'), (2, 'South'), (3, 'East');
  INSERT INTO visit VALUES (10, 1, 'a'), (11, 2, 'b'), (12, 3, 'c'), (13, 1, 'd');
  INSERT INTO person VALUES (1, 'ana@example.org'), (2, 'bo@example.org');`;
// Ana's rows hold sites 1 and 2; Bo's hold site 3 only.
const POLICY = `export default { appId: 'clinic',
  resultReferences: { tally: () => [], startOnboarding: () => [], submitOnboarding: () => [] },
  async resolveRows(principal) {
    const sites = principal.email === 'ana@example.org' ? [1, 2] : [3];
    return {
      site: { groups: [[{ column: 'id', op: 'in', value: sites }]] },
      visit: { groups: [[{ column: 'site_id', op: 'in', value: sites }]] },
      person: true, log: true, onboarding: true,
    };
  } };`;
const POLICY_COMMANDS = `import { defineCommand, defineCommands } from ${sourceUrl('packages/mistri/src/server/commands/businessCommands.ts')};
const base = { targets: 'none', source: 'main', target: 'onboarding', read: ['visit', 'onboarding', 'person'], write: ['onboarding'], output: { parse: (value) => value } };
const saw = async (db, chosen) => ({ chosen: Object.fromEntries(Object.entries(chosen).map(([name, key]) => [name, key ?? null])), ids: (await db.visit.where('site_id = chosen.site')).map((row) => row.id).sort() });
export default defineCommands({
  tally: defineCommand({ ...base, write: ['log'], input: { note: { type: 'text', max: 20 } },
    async handle({ db, chosen }, input) { const seen = await saw(db, chosen); await db.log.insert({ note: input.note }); return seen; } }),
  startOnboarding: defineCommand({ ...base, input: { full_name: { type: 'text', max: 60 } },
    async handle({ db, draft, chosen }, input) {
      const seen = await saw(db, chosen);
      if (draft.root) await db.onboarding.update(await db.onboarding.get(draft.root), input);
      else await db.onboarding.insert({ ...input, ...draft.start });
      return seen;
    } }),
  submitOnboarding: defineCommand({ ...base, input: { consent: { type: 'boolean' } },
    async handle() { return { chosen: {}, ids: [] }; } }),
});`;
const POLICY_APP = {
  id: 'clinic',
  name: 'Clinic',
  auth: {
    signUp: 'open',
    store: 'accounts.db',
    defaultRole: 'member',
    rows: 'policy',
    me: { from: 'person', column: 'email' },
    roles: { member: { read: true, commands: ['tally', 'startOnboarding', 'submitOnboarding'] } },
  },
  resources: { site: {}, visit: {}, person: {}, log: { access: 'write' }, onboarding: { access: 'write' } },
  choose: { site: { from: 'site', label: 'name' } },
  views: {
    visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' },
    onboard: {
      kind: 'form',
      label: 'Onboarding',
      command: 'submitOnboarding',
      steps: [{ label: 'You', command: 'startOnboarding' }],
      resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
      draft: { status: 'in_progress' },
      owner: 'person_id',
    },
  },
  home: 'visits',
  nav: ['visits', 'onboard'],
};

for (const door of ['execute', 'draft'] as const) {
  test(
    `under a row policy, a command's ctx.chosen on ${door} is the header's or stored pick, read in the person's rows`,
    { timeout: 60_000 },
    async (t) => {
      const server = await policyServer(t, { app: POLICY_APP, sql: POLICY_SQL, commands: POLICY_COMMANDS, policy: POLICY });
      // The preferences store sits beside the business data, as `migrate stores up` leaves it.
      provisionSqlitePreferences(server.url);
      const signUp = async (name: string) => {
        const cookie = await server.signUp(name);
        // Open sign-up leaves an address unproven, and `me` is nobody's until it is: prove it in the App's own store.
        const store = new DatabaseSync(join(dirname(server.url), 'app', 'accounts.db'));
        try {
          store.prepare('UPDATE user SET emailVerified = 1 WHERE email = ?').run(`${name}@example.org`);
        } finally {
          store.close();
        }
        return cookie;
      };
      let n = 0;
      const post = async (route: string, body: unknown, cookie: string, chosen?: string) => {
        const response = await fetch(`${server.origin}/api/${route}?app=clinic`, {
          method: 'POST',
          signal: AbortSignal.timeout(10_000),
          headers: {
            'content-type': 'application/json',
            origin: server.origin,
            cookie,
            ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }),
          },
          body: JSON.stringify(body),
        });
        return { status: response.status, body: (await response.json()) as any };
      };
      const envelope = (command: string, input: object) => ({
        command,
        commandVersion: 1,
        key: {},
        expectedVersion: 0,
        input,
        idempotencyKey: `policy-choose-${String(++n).padStart(6, '0')}-key`,
      });
      const run = async (cookie: string, chosen?: string) => {
        const reply =
          door === 'execute'
            ? await post('commands/execute', envelope('tally', { note: 'x' }), cookie, chosen)
            : await post(
                'commands/draft',
                { form: 'onboard', op: 'step', step: 'you', request: envelope('startOnboarding', { full_name: 'y' }) },
                cookie,
                chosen,
              );
        assert.equal(reply.status, 200, JSON.stringify(reply.body));
        const { chosen: saw, ids } = reply.body.result;
        return { chosen: saw, ids };
      };
      const ana = await signUp('ana');
      const bo = await signUp('bo');
      assert.deepEqual(await run(ana, 'site=1'), { chosen: { site: 1 }, ids: [10, 13] }, 'the header');
      // A site that is no row, and one the policy gives another desk, are not chosen: nothing matches, not everything.
      assert.deepEqual(await run(ana, 'site=999'), { chosen: { site: null }, ids: [] }, 'forged');
      assert.deepEqual(await run(ana, 'site=3'), { chosen: { site: null }, ids: [] }, "a site Ana's rows do not hold");
      assert.deepEqual(await run(ana), { chosen: { site: null }, ids: [] }, 'nothing stored yet');
      assert.equal((await post('choose', { name: 'site', value: '2' }, ana)).status, 200);
      assert.deepEqual(await run(ana), { chosen: { site: 2 }, ids: [11] }, 'the stored pick');
      assert.deepEqual(await run(ana, 'site=1'), { chosen: { site: 1 }, ids: [10, 13] }, 'the header beats it');
      // Bo's rows hold site 3 alone: Ana's site is no pick of theirs, and her stored pick is not theirs.
      assert.deepEqual(await run(bo, 'site=1'), { chosen: { site: null }, ids: [] }, "a site Bo's rows do not hold");
      assert.deepEqual(await run(bo), { chosen: { site: null }, ids: [] }, "another's stored pick");
      assert.deepEqual(await run(bo, 'site=3'), { chosen: { site: 3 }, ids: [12] }, 'their own');
    },
  );
}
