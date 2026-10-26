/**
 * The shared cache of a form's choices from a table, on SQLite and on PostgreSQL, in a database each case owns.
 * The App does not ask for live sync, and still its choice table's writes are captured: the cache is dropped by the
 * change signal, never by time. Seen from outside:
 *
 * - the public form is served its rows with it, under an ETag that answers 304 until a row changes;
 * - a write through the App (this process's capture and nudge) drops the entry, and so does a change another process
 *   commits (a change row and, on PostgreSQL, NOTIFY): the next read has the new row and a new tag;
 * - a submission never asks the cache: each key is read by the key column in the command's own transaction, so a row
 *   deleted behind the capture's back (no change row said so) is refused at its field while the form still offers it
 *   until a change is heard, and a row added since is a choice at once;
 * - an entry is one resolved resource on one connection: two sources that each have a `make` table keep two, and a
 *   key of one is refused for the other;
 * - a row-policy App keeps nothing: its form is served without rows, and each read is its own.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { parseTrustedProxies } from '../packages/engine/src/server/http/trust.js';
import { appendSqliteLiveChange, provisionSqliteLiveChange } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import { appendPostgresLiveChange, provisionPostgresLiveChange } from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { dropLiveHub } from '../packages/mistri/src/server/live/liveHub.js';
import { cachedChoices, clearChoiceCache } from '../packages/mistri/src/server/forms/choiceCache.js';
import { choiceSourceResources } from '../packages/mistri/src/server/live/liveBinding.js';
import { parseTestApp } from './support/commandCatalog.js';
import { pgClient, uuidPostgresDatabase } from './support/tenantDialects.js';

const PG = process.env.TABLEWALK_TEST_PG;
const askInput = { make: { label: 'Make', type: 'choice', from: 'make', labelColumn: 'name' } } as const;
const RAW = {
  id: 'cars',
  name: 'Cars',
  sources: { main: { connection: 'cars-db' } },
  auth: { roles: { clerk: { read: true } }, public: { read: ['make'] } },
  resources: { make: {}, inquiry: { access: 'write' } },
  views: {
    inquiries: { kind: 'list', from: 'inquiry' },
    ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask' },
  },
  home: 'inquiries',
  nav: ['inquiries'],
};
const CONTRACTS = { ask: { public: true, input: askInput } };

interface Engine {
  url: string;
  /** Run SQL as another process would: its own connection, nothing of this server's capture. */
  other(sql: string, params?: unknown[]): Promise<void>;
  /** Another process's commit through its own capture: the row, its change row and (PostgreSQL) the wake. */
  committedElsewhere(name: string, id: number): Promise<void>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-choice-cache-'));
  const file = join(directory, 'cars.db');
  const setup = new DatabaseSync(file);
  setup.exec(`CREATE TABLE make(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE inquiry(id INTEGER PRIMARY KEY, make_id INTEGER NOT NULL);
    INSERT INTO make VALUES (1, 'Audi'), (2, 'BMW');`);
  setup.close();
  migrateSqliteCommandJournal(file);
  provisionSqliteLiveChange(file);
  const other = new DatabaseSync(file);
  return {
    url: file,
    other: async (sql, params = []) => {
      other.prepare(sql).run(...(params as never[]));
    },
    committedElsewhere: async (name, id) => {
      other.exec('BEGIN IMMEDIATE');
      other.prepare('INSERT INTO make VALUES (?, ?)').run(id, name);
      appendSqliteLiveChange(other, {
        at: Date.now(),
        actor: '',
        tenant: null,
        entries: [{ table: 'make', kind: 'insert', keys: [{ id }] }],
      });
      other.exec('COMMIT');
    },
    close: async () => {
      other.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

async function postgresEngine(): Promise<Engine> {
  const owned = await uuidPostgresDatabase('tw_choice_cache');
  const setup = await pgClient(owned.url);
  await setup.query(`CREATE TABLE make(id integer PRIMARY KEY, name text NOT NULL);
    CREATE TABLE inquiry(id serial PRIMARY KEY, make_id integer NOT NULL);
    INSERT INTO make VALUES (1, 'Audi'), (2, 'BMW');`);
  await setup.end();
  await migratePostgresCommandJournal(owned.url);
  await provisionPostgresLiveChange(owned.url);
  const other = await pgClient(owned.url);
  return {
    url: owned.url,
    other: async (sql, params = []) => {
      await other.query(
        sql.replace(
          /\?/g,
          (() => {
            let n = 0;
            return () => `$${++n}`;
          })(),
        ),
        params,
      );
    },
    committedElsewhere: async (name, id) => {
      await other.query('BEGIN');
      await other.query('INSERT INTO make VALUES ($1, $2)', [id, name]);
      await appendPostgresLiveChange(other as never, {
        at: Date.now(),
        actor: '',
        tenant: null,
        entries: [{ table: 'make', kind: 'insert', keys: [{ id }] }],
      });
      await other.query('COMMIT');
      await other.query(`SELECT pg_notify('mistri_live', '')`);
    },
    close: async () => {
      await other.end();
      await owned.drop();
    },
  };
}

interface Running {
  base: string;
  registry: Registry;
  inquiries: number[];
}

async function serve(t: TestContext, engine: Engine, raw: object = RAW): Promise<Running> {
  resetPublicFormLimits();
  const app = parseTestApp(raw, 'choice cache fixture', CONTRACTS);
  const registry = new Registry();
  registry.add({ id: 'cars-db', name: 'Cars', url: engine.url, writable: true, source: 'config' });
  const inquiries: number[] = [];
  const commands = defineCommands({
    ask: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inquiry',
      read: ['make', 'inquiry'],
      write: ['inquiry'],
      public: true,
      input: askInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        inquiries.push(Number(input.make));
        await context.tx.insert({ table: 'inquiry', values: { make_id: Number(input.make) } });
        return { reference: `ASK-${inquiries.length}` };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: '/private/auth.db', close() {}, handler: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'cars', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    clearChoiceCache(registry);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    const dialed = registry.dialedAdapter('cars-db');
    if (dialed) await dropLiveHub(dialed);
    await registry.closeAll();
    resetPublicFormLimits();
  });
  return { base: `http://${bound.host}:${bound.port}`, registry, inquiries };
}

async function form(run: Running, etag?: string) {
  const response = await fetch(`${run.base}/api/forms/ask`, {
    headers: { origin: run.base, ...(etag ? { 'if-none-match': etag } : {}) },
    signal: AbortSignal.timeout(8_000),
  });
  const body =
    response.status === 200
      ? ((await response.json()) as { form: { input: Array<{ options?: Array<{ value: unknown; label: string }> }> } })
      : undefined;
  return { status: response.status, etag: response.headers.get('etag') ?? undefined, options: body?.form.input[0].options };
}

const labels = (options: Array<{ label: string }> | undefined) => (options ?? []).map((option) => option.label);

/* What a change drops is dropped a moment later, when the hub has read the change row. */
async function until(what: string, check: () => Promise<boolean>, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(50);
  }
  assert.fail(`never: ${what}`);
}

let n = 0;
const submit = (run: Running, make: number) =>
  fetch(`${run.base}/api/forms/ask`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: run.base },
    body: JSON.stringify({ input: { make }, submission: `choice-cache-key-${String(++n).padStart(6, '0')}` }),
    signal: AbortSignal.timeout(8_000),
  }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));

async function invalidation(t: TestContext, engine: Engine) {
  const run = await serve(t, engine);
  // After hooks run in the order they were added: the server lets go of the database before the engine drops it.
  t.after(() => engine.close());
  const first = await form(run);
  assert.equal(first.status, 200);
  assert.deepEqual(labels(first.options), ['Audi', 'BMW'], 'served with the form, sorted by the label');
  assert.ok(first.etag, 'under an ETag');
  assert.equal((await form(run, first.etag)).status, 304, 'unchanged: 304');
  await until(
    'the entry is kept',
    async () => cachedChoices(run.registry, 'cars-db', 'cars', { resource: 'make', by: 'id', labelColumn: 'name' }) !== undefined,
  );

  // A write through the App: this process's capture drops the entry.
  const { adapter } = await run.registry.open('cars-db');
  await adapter.insert!({ table: 'make', values: { id: 3, name: 'Citroen' } });
  await until('this process’s write is heard', async () => labels((await form(run)).options).includes('Citroen'));
  const second = await form(run);
  assert.notEqual(second.etag, first.etag);
  assert.equal((await form(run, first.etag)).status, 200, 'the old tag no longer validates');

  // Another process's commit: its change row (and NOTIFY on PostgreSQL) drops it too.
  await engine.committedElsewhere('Dacia', 4);
  await until('another process’s commit is heard', async () => labels((await form(run)).options).includes('Dacia'));

  // Submission never asks the cache. A row gone behind its back (no change row said so) is still offered by the form …
  assert.deepEqual(labels((await form(run)).options), ['Audi', 'BMW', 'Citroen', 'Dacia']);
  await engine.other('DELETE FROM make WHERE id = ?', [1]);
  assert.deepEqual(labels((await form(run)).options), ['Audi', 'BMW', 'Citroen', 'Dacia'], 'the form is drawn from the cache');
  // … and refused at its field, read by its key in the command's transaction.
  const gone = await submit(run, 1);
  assert.equal(gone.status, 400, JSON.stringify(gone.body));
  assert.equal(gone.body.field, 'make');
  // A row added since, unheard, is a choice at once; one that never was is refused.
  await engine.other('INSERT INTO make VALUES (?, ?)', [5, 'Eagle']);
  const reread = await submit(run, 5);
  assert.equal(reread.status, 200, JSON.stringify(reread.body));
  const refused = await submit(run, 99);
  assert.equal(refused.status, 400);
  assert.equal(refused.body.field, 'make');
  assert.deepEqual(run.inquiries, [5]);
}

test('the App asks for no live sync, and still its choice table is followed', () => {
  const app = parseTestApp(RAW, 'x', CONTRACTS);
  assert.equal(app.live, undefined);
  assert.deepEqual([...choiceSourceResources(app)], ['make']);
});

test(
  'SQLite: served under an ETag, dropped by a write here and by a commit elsewhere; a submission reads its key',
  { timeout: 30_000 },
  async (t) => {
    await invalidation(t, await sqliteEngine());
  },
);

test(
  'PostgreSQL: served under an ETag, dropped by a write here and by NOTIFY from elsewhere; a submission reads its key',
  { skip: PG ? false : 'TABLEWALK_TEST_PG is not set', timeout: 60_000 },
  async (t) => {
    await invalidation(t, await postgresEngine());
  },
);

test('without the change store nothing is kept: every read reads', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-choice-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'cars.db');
  const setup = new DatabaseSync(file);
  setup.exec(`CREATE TABLE make(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE inquiry(id INTEGER PRIMARY KEY, make_id INTEGER);
    INSERT INTO make VALUES (1, 'Audi');`);
  migrateSqliteCommandJournal(file);
  const run = await serve(t, { url: file, other: async () => {}, committedElsewhere: async () => {}, close: async () => setup.close() });
  assert.deepEqual(labels((await form(run)).options), ['Audi']);
  assert.equal(cachedChoices(run.registry, 'cars-db', 'cars', { resource: 'make', by: 'id', labelColumn: 'name' }), undefined);
  setup.prepare('INSERT INTO make VALUES (2, ?)').run('BMW');
  assert.deepEqual(labels((await form(run)).options), ['Audi', 'BMW'], 'an unheard write is read at once: nothing was kept');
});

test('two sources that each have a make table: two entries, and a key of one is refused for the other', { timeout: 30_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-choice-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = { main: join(directory, 'cars.db'), other: join(directory, 'boats.db') };
  for (const [file, rows] of [
    [files.main, `(1, 'Audi'), (2, 'BMW')`],
    [files.other, `(7, 'Beneteau'), (8, 'Catalina')`],
  ] as const) {
    const setup = new DatabaseSync(file);
    setup.exec(`CREATE TABLE make(id INTEGER PRIMARY KEY, name TEXT NOT NULL); CREATE TABLE inquiry(id INTEGER PRIMARY KEY, make_id INTEGER NOT NULL);
      INSERT INTO make VALUES ${rows};`);
    setup.close();
    migrateSqliteCommandJournal(file);
    provisionSqliteLiveChange(file);
  }
  resetPublicFormLimits();
  const raw = {
    id: 'cars',
    name: 'Cars',
    sources: { main: { connection: 'cars-db', default: true }, boats: { connection: 'boats-db' } },
    auth: { roles: { clerk: { read: true } }, public: { read: ['make', 'boats.make'] } },
    resources: { make: {}, inquiry: { access: 'write' }, 'boats.make': {}, 'boats.inquiry': { access: 'write' } },
    views: {
      inquiries: { kind: 'list', from: 'inquiry' },
      ask: { kind: 'form', label: 'Ask', public: true, done: { title: 'Thanks' }, command: 'ask' },
      'ask-boat': { kind: 'form', label: 'Ask about a boat', public: true, done: { title: 'Thanks' }, command: 'askBoat' },
    },
    home: 'inquiries',
    nav: ['inquiries'],
  };
  const app = parseTestApp(raw, 'two sources fixture', {
    ask: { public: true, input: askInput },
    askBoat: { public: true, input: askInput },
  });
  const registry = new Registry();
  registry.add({ id: 'cars-db', name: 'Cars', url: files.main, writable: true, source: 'config' });
  registry.add({ id: 'boats-db', name: 'Boats', url: files.other, writable: true, source: 'config' });
  const asked: Array<[string, number]> = [];
  const command = (id: string, source: string) =>
    defineCommand({
      targets: 'none',
      source,
      target: 'inquiry',
      read: ['make', 'inquiry'],
      write: ['inquiry'],
      public: true,
      input: askInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        asked.push([id, Number(input.make)]);
        await context.tx.insert({ table: 'inquiry', values: { make_id: Number(input.make) } });
        return { reference: `ASK-${asked.length}` };
      },
    });
  const commands = defineCommands({ ask: command('ask', 'main'), askBoat: command('askBoat', 'boats') });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: '/private/auth.db', close() {}, handler: async () => {}, session: async () => null },
  };
  const bound = { host: '127.0.0.1', port: 0, trustedProxies: parseTrustedProxies([]).ranges };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'cars', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    clearChoiceCache(registry);
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    for (const id of ['cars-db', 'boats-db']) {
      const dialed = registry.dialedAdapter(id);
      if (dialed) await dropLiveHub(dialed);
    }
    await registry.closeAll();
    resetPublicFormLimits();
  });
  const base = `http://${bound.host}:${bound.port}`;
  const served = async (key: string) =>
    labels(
      (
        (await (await fetch(`${base}/api/forms/${key}`, { signal: AbortSignal.timeout(8_000) })).json()) as {
          form: { input: Array<{ options?: Array<{ label: string }> }> };
        }
      ).form.input[0].options,
    );
  const post = (key: string, make: number, submission = `two-sources-key-${String(++n).padStart(6, '0')}`) =>
    fetch(`${base}/api/forms/${key}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ input: { make }, submission }),
      signal: AbortSignal.timeout(8_000),
    }).then(async (response) => ({ status: response.status, body: (await response.json()) as Record<string, unknown> }));

  assert.deepEqual(await served('ask'), ['Audi', 'BMW']);
  assert.deepEqual(await served('ask-boat'), ['Beneteau', 'Catalina'], "the boats' make, never the cars' kept entry");
  await until('both entries are kept', async () =>
    [
      cachedChoices(registry, 'cars-db', 'cars', { resource: 'make', by: 'id', labelColumn: 'name' }),
      cachedChoices(registry, 'boats-db', 'cars', { resource: 'boats.make', by: 'id', labelColumn: 'name' }),
    ].every(Boolean),
  );
  // A key of the boats' make is no choice of the cars' form, and the other way about.
  const crossed = await post('ask', 7, 'two-sources-fixed-000001');
  assert.equal(crossed.status, 400, JSON.stringify(crossed.body));
  assert.equal(crossed.body.field, 'make');
  assert.equal((await post('ask-boat', 1)).status, 400);
  assert.equal((await post('ask-boat', 7)).status, 200);
  // The refused submission, fixed, goes under the same key: a refusal kept nothing that binds it.
  const fixed = await post('ask', 1, 'two-sources-fixed-000001');
  assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
  assert.deepEqual(asked, [
    ['askBoat', 7],
    ['ask', 1],
  ]);
});

/* A public page's command offers the same rows (P1): served in the App's payload as the public reads them, under its
   tag, and a change to the rows is a new one. */
const PAGE_RAW = {
  ...RAW,
  views: {
    ...RAW.views,
    lobby: {
      kind: 'page',
      label: 'Lobby',
      component: { id: 'page-lobby', module: './pages/lobby.page.tsx', kind: 'page' },
      reads: ['make'],
      commands: ['ask'],
      public: true,
    },
  },
  home: [{ view: 'lobby', signedOut: true }, { view: 'inquiries' }],
};

async function payload(run: Running, etag?: string) {
  const response = await fetch(`${run.base}/api/app`, {
    headers: { origin: run.base, ...(etag ? { 'if-none-match': etag } : {}) },
    signal: AbortSignal.timeout(8_000),
  });
  const body =
    response.status === 200
      ? ((await response.json()) as {
          app: { publicCommands?: Record<string, { input: Array<{ name: string; options?: Array<{ value: unknown; label: string }> }> }> };
        })
      : undefined;
  return { status: response.status, etag: response.headers.get('etag') ?? undefined, body };
}

test(
  "a public page's command is served its table's rows, read as the public reads them, under the payload's tag",
  { timeout: 30_000 },
  async (t) => {
    const engine = await sqliteEngine();
    const run = await serve(t, engine, PAGE_RAW);
    t.after(() => engine.close());
    const first = await payload(run);
    assert.equal(first.status, 200);
    const make = first.body?.app.publicCommands?.ask.input.find((field) => field.name === 'make');
    assert.deepEqual(make?.options, [
      { value: 1, label: 'Audi' },
      { value: 2, label: 'BMW' },
    ]);
    assert.ok(first.etag);
    assert.equal((await payload(run, first.etag)).status, 304, 'unchanged: 304');
    const { adapter } = await run.registry.open('cars-db');
    await adapter.insert!({ table: 'make', values: { id: 3, name: 'Citroen' } });
    await until('the write is heard', async () =>
      labels((await payload(run)).body?.app.publicCommands?.ask.input[0].options).includes('Citroen'),
    );
    assert.notEqual((await payload(run)).etag, first.etag);
  },
);
