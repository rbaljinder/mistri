/**
 * An App's `choose` (`choose: { site: { from: 'sites', label: 'name' } }`): an App-wide row the person picks, which
 * pages read as `chosen.site` and `ctx.chosen.site`. The choice is never a grant: the id the tab sends is re-read
 * under the person's own row policy on every request, and one they cannot read is dropped — not chosen, which
 * matches no row.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { provisionSqlitePreferences } from '../packages/mistri/src/adapters/preferences/sqlitePreferences.js';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { createApp } from './support/createApp.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { chooseProblems, readChosen } from '../packages/mistri/src/server/app/appChoices.js';
import { runPageLoader } from '../packages/mistri/src/server/commands/pageLoaderRun.js';
import { defineLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import { ANYONE, ANYONE_ONCE, type QueryPerson } from '../packages/engine/src/shared/queryOperands.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string) => ({ name, type, nullable: true, primaryKey: name === 'id' });
const visit: TableMeta = {
  name: 'visit',
  schema: '',
  id: 'visit',
  isView: false,
  columns: [column('id', 'INTEGER'), column('site_id', 'INTEGER'), column('note', 'TEXT')],
};
const schema: DatabaseSchema = { label: 'clinic', dialect: 'sqlite', tables: [visit], foreignKeys: [], readAt: '' };
const read = (text: string, me?: QueryPerson) => parseQuery(`visit ${text}`, { schema, ...(me ? { me } : {}) });
const person = (chosen: QueryPerson['chosen']): QueryPerson => ({ email: 'ana@clinic.test', chosen });

test('chosen.<name> is the picked row key, in a comparison and in a list', () => {
  const { query, errors } = read('site_id = chosen.site', person({ site: 2 }));
  assert.deepEqual(errors, []);
  assert.deepEqual(query!.filter.groups, [[{ column: 'site_id', op: '=', value: 2 }]]);
  const listed = read('site_id in (chosen.site, 9)', person({ site: 2 }));
  assert.deepEqual(listed.errors, []);
  assert.deepEqual(listed.query!.filter.groups[0][0].value, [2, 9]);
  // An id past 2^53 stays its digits.
  const big = read('site_id = chosen.site', person({ site: '9007199254740993' }));
  assert.equal(big.query!.filter.groups[0][0].value, '9007199254740993');
});

test('nothing chosen (or a pick that was dropped) matches no row, and is left out of a list', () => {
  const { query, errors } = read('site_id = chosen.site', person({ site: null }));
  assert.deepEqual(errors, []);
  assert.deepEqual(query!.filter.groups, [[{ column: 'site_id', op: 'in', value: [] }]]);
  const listed = read('site_id in (chosen.site, 9)', person({ site: null }));
  assert.deepEqual(listed.query!.filter.groups[0][0].value, [9]);
});

test('an undeclared choice, a query with no App choice meant, and a once-read query are refused by name', () => {
  assert.match(
    read('site_id = chosen.region', person({ site: 2 })).errors[0].message,
    /chosen\.region names no choice: the App's choose declares site/,
  );
  assert.match(read('site_id = chosen.site').errors[0].message, /no App choice is meant here/);
  assert.match(read('site_id = chosen.site', ANYONE_ONCE).errors[0].message, /read once for every request/);
  // A check before any request reads the word as written: it compiles, and says nothing of a value.
  assert.deepEqual(read('site_id = chosen.site', ANYONE).errors, []);
  // Quoted, it is the text.
  assert.equal(read('note = "chosen.site"').query!.filter.groups[0][0].value, 'chosen.site');
});

const clinic = (choose: unknown, extra: Record<string, unknown> = {}) =>
  parseAppConfig(
    {
      id: 'clinic',
      name: 'Clinic',
      resources: { site: {}, visit: {} },
      views: { visits: { kind: 'list', from: 'visit' } },
      home: 'visits',
      ...(choose === undefined ? {} : { choose }),
      ...extra,
    },
    'clinic fixture',
  );

test('choose is declared by name over a declared resource, a few at most', () => {
  const app = clinic({ site: { from: 'site', label: 'name', required: true } });
  assert.deepEqual(app.choose, { site: { from: 'site', label: 'name', required: true } });
  assert.deepEqual(clinic({ site: { from: 'site', required: false } }).choose, { site: { from: 'site' } });
  assert.throws(() => clinic({ site: { from: 'clinic_site' } }), /choose\.site\.from names a declared resource/);
  assert.throws(
    () => clinic({ a: { from: 'site' }, b: { from: 'site' }, c: { from: 'site' }, d: { from: 'site' } }),
    /names 1 to 3 choices/,
  );
  assert.throws(() => clinic({}), /names 1 to 3 choices/);
  assert.throws(() => clinic({ 'the-site': { from: 'site' } }), /is not a name a page can say as chosen/);
  assert.throws(() => clinic({ site: { from: 'site', label: 'a b' } }), /label is the column of site/);
  assert.throws(() => clinic({ site: { from: 'site', default: 1 } }), /default/);
});

/* A clinic of three sites; Ana works at 1 and 2, so her row policy reads only those. */
async function world() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-choose-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL)');
  db.exec('CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT)');
  db.exec("INSERT INTO site VALUES (1, 'North'), (2, 'South'), (3, 'East')");
  db.exec("INSERT INTO visit VALUES (10, 1, 'a'), (11, 2, 'b'), (12, 3, 'c'), (13, 1, 'd')");
  const adapter = new SqliteAdapter(file, 'clinic');
  const schema = await adapter.introspect();
  const ana = await adapter.scopeReads({
    site: { groups: [[{ column: 'id', op: 'in', value: [1, 2] }]] },
    visit: { groups: [[{ column: 'site_id', op: 'in', value: [1, 2] }]] },
  });
  return {
    adapter,
    schema,
    ana,
    async close() {
      await adapter.close();
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('a picked id is read again under the person: theirs is kept, a forged one is dropped, a header asks only declared names', async () => {
  const w = await world();
  try {
    const app = clinic({ site: { from: 'site', label: 'name' } });
    assert.deepEqual(await readChosen(app, w.schema, w.ana, 'site=2'), { site: 2 });
    // Site 3 exists, but not for Ana: it is not chosen, so it narrows to nothing rather than to site 3.
    assert.deepEqual(await readChosen(app, w.schema, w.ana, 'site=3'), { site: null });
    assert.deepEqual(await readChosen(app, w.schema, w.ana, 'site=999'), { site: null });
    assert.deepEqual(await readChosen(app, w.schema, w.ana, "site=1' OR 1=1"), { site: null });
    assert.deepEqual(await readChosen(app, w.schema, w.ana, undefined), { site: null });
    assert.deepEqual(await readChosen(app, w.schema, w.ana, `region=1&site=${'9'.repeat(200)}`), { site: null });
    // The first of a repeated name is the one asked.
    assert.deepEqual(await readChosen(app, w.schema, w.ana, 'site=1&site=3'), { site: 1 });
    // An App with no choose has none to read: chosen.<name> is refused there, not read as nothing.
    assert.equal(await readChosen(clinic(undefined), w.schema, w.ana, 'site=1'), undefined);
  } finally {
    await w.close();
  }
});

test("a loader reads chosen.site in a handle's where and as ctx.chosen", async () => {
  const w = await world();
  try {
    const app = clinic({ site: { from: 'site' } });
    const load = async (header: string | undefined) =>
      runPageLoader({
        name: 'atSite',
        loader: defineLoader({
          reads: ['visit'],
          load: async ({
            db,
            chosen,
          }: {
            db: Record<string, { where(text: string): Promise<Array<{ id: number }>> }>;
            chosen: unknown;
          }) => ({
            ids: (await db.visit!.where('site_id = chosen.site')).map((row) => row.id),
            chosen,
          }),
        } as never) as never,
        reader: { query: w.ana.query, count: w.ana.count, aggregate: w.ana.aggregate },
        schema: w.schema,
        params: {},
        viewer: { roles: [] },
        now: new Date(),
        chosen: (await readChosen(app, w.schema, w.ana, header))!,
      });
    assert.deepEqual(await load('site=1'), { ids: [10, 13], chosen: { site: 1 } });
    // Forged: nothing is chosen, so the loader's read matches nothing and ctx.chosen.site is undefined (gone from the
    // result, which reaches the page as JSON).
    assert.deepEqual(await load('site=3'), { ids: [], chosen: {} });
  } finally {
    await w.close();
  }
});

test('mistri check: a choice reads a served table by its key and label, and every chosen.<name> said is declared', async () => {
  const w = await world();
  try {
    const good = clinic(
      { site: { from: 'site', label: 'name' } },
      { views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' } } },
    );
    assert.deepEqual(chooseProblems(good, w.schema), []);
    const said = clinic(
      { site: { from: 'site', label: 'title' } },
      { views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.region and note != "chosen.quoted"' } } },
    );
    assert.deepEqual(chooseProblems(said, w.schema), [
      'choose.site: label "title" is not a column of "site".',
      "chosen.region names no choice: the App's choose declares site.",
    ]);
    const none = clinic(undefined, { views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' } } });
    assert.deepEqual(chooseProblems(none, w.schema), ['chosen.site names no choice: the App declares no choose.']);
    const missing = { ...good, choose: { site: { from: 'branch' } } };
    assert.deepEqual(chooseProblems(missing, w.schema), ['choose.site: "branch" is not a table the App serves.']);
  } finally {
    await w.close();
  }
});

test(
  'over HTTP, a view and a query read chosen.site from the header, re-read under the signed-in person',
  { timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-choose-http-'));
    const previous = process.env.XDG_CONFIG_HOME;
    const connection = 'choose-connection';
    const file = join(directory, 'clinic.db');
    const db = new DatabaseSync(file);
    db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT);
    INSERT INTO site VALUES (1, 'North'), (2, 'South'), (3, 'East');
    INSERT INTO visit VALUES (10, 1, 'a'), (11, 2, 'b'), (12, 3, 'c'), (13, 1, 'd');
  `);
    db.close();
    clearJournal(connection);
    const registry = new Registry();
    registry.add({ id: connection, name: 'Clinic', url: file, source: 'config' });
    const manifest = parseAppConfig(
      {
        id: 'clinic',
        name: 'Clinic',
        connection,
        resources: { site: {}, visit: {} },
        choose: { site: { from: 'site', label: 'name' } },
        auth: { providers: ['email'], defaultRole: 'nurse', roles: { nurse: { read: ['site', 'visit'] }, clerk: { read: ['visit'] } } },
        views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' } },
        home: 'visits',
      },
      'choose fixture',
    );
    let who: Identity = { id: 'account-ana', who: 'ana@clinic.test', role: 'nurse' };
    const host: AppHost = {
      app: { path: '/clinic/app.ts', app: manifest, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: manifest.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async () => who,
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    process.env.XDG_CONFIG_HOME = directory;
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const post = async (route: string, body: Record<string, unknown>, chosen?: string) => {
        const response = await fetch(`http://${bound.host}:${address.port}${route}`, {
          signal: AbortSignal.timeout(5_000),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }) },
          body: JSON.stringify({ app: 'clinic', ...body }),
        });
        return { status: response.status, body: await response.json() };
      };
      const ids = async (chosen?: string) => {
        const { body } = await post('/api/run', { q: 'visit site_id = chosen.site', exactCount: true }, chosen);
        assert.deepEqual(body.errors, [], chosen);
        return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
      };
      assert.deepEqual(await ids('site=1'), [10, 13]);
      assert.deepEqual(await ids('site=2'), [11]);
      // A site that is no row is dropped, and the query matches nothing rather than everything. (A row the person's
      // policy hides is dropped the same way: the re-read runs on the request's scoped reader, proven above.)
      assert.deepEqual(await ids('site=999'), []);
      assert.deepEqual(await ids(), []);
      const viewed = await post(
        '/api/view/run',
        { view: { id: 'v', name: '', base: 'visit', columns: [{ path: 'id' }] }, query: 'site_id = chosen.site' },
        'site=1',
      );
      assert.deepEqual((viewed.body.rows as Array<{ id: number }>).map((row) => row.id).sort(), [10, 13]);
      // A clerk may read visits but not sites: no site is theirs to pick, whatever the tab sends.
      who = { id: 'account-bo', who: 'bo@clinic.test', role: 'clerk' };
      assert.deepEqual(await ids('site=1'), []);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal(connection);
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);

test(
  "a person's pick is kept in the App's preferences store: served with the App, the default of every request, and never another's",
  { timeout: 20_000 },
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'mistri-choose-store-'));
    const previous = process.env.XDG_CONFIG_HOME;
    const connection = 'choose-store-connection';
    const file = join(directory, 'clinic.db');
    const db = new DatabaseSync(file);
    db.exec(`
    CREATE TABLE site (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE visit (id INTEGER PRIMARY KEY, site_id INTEGER REFERENCES site(id), note TEXT);
    INSERT INTO site VALUES (1, 'North'), (2, 'South');
    INSERT INTO visit VALUES (10, 1, 'a'), (11, 2, 'b'), (13, 1, 'd');
  `);
    db.close();
    provisionSqlitePreferences(file);
    clearJournal(connection);
    const registry = new Registry();
    registry.add({ id: connection, name: 'Clinic', url: file, source: 'config' });
    const manifest = parseAppConfig(
      {
        id: 'clinic',
        name: 'Clinic',
        connection,
        resources: { site: {}, visit: {} },
        choose: { site: { from: 'site', label: 'name' } },
        auth: { providers: ['email'], defaultRole: 'nurse', roles: { nurse: { read: ['site', 'visit'] }, clerk: { read: ['visit'] } } },
        views: { visits: { kind: 'list', from: 'visit', query: 'site_id = chosen.site' } },
        home: 'visits',
      },
      'choose store fixture',
    );
    let who: Identity = { id: 'account-ana', who: 'ana@clinic.test', role: 'nurse' };
    const host: AppHost = {
      app: { path: '/clinic/app.ts', app: manifest, pages: [], sources: {} },
      pages: [],
      auth: {
        spec: manifest.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async () => who,
      },
    };
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host], pages: [] });
    process.env.XDG_CONFIG_HOME = directory;
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const origin = `http://${bound.host}:${address.port}`;
      const post = async (route: string, body: Record<string, unknown>, chosen?: string) => {
        const response = await fetch(`${origin}${route}`, {
          signal: AbortSignal.timeout(5_000),
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(chosen === undefined ? {} : { 'x-mistri-chosen': chosen }) },
          body: JSON.stringify({ app: 'clinic', ...body }),
        });
        return { status: response.status, body: await response.json() };
      };
      const served = async () =>
        (await (await fetch(`${origin}/api/app?app=clinic`, { signal: AbortSignal.timeout(5_000) })).json()) as {
          app: { picks?: Record<string, string>; views: Record<string, unknown> };
        };
      const ids = async (chosen?: string) => {
        const { body } = await post('/api/run', { q: 'visit site_id = chosen.site', exactCount: true }, chosen);
        return (body.rows as Array<{ id: number }>).map((row) => row.id).sort();
      };
      // A view that reads a choice is served (it was once judged with nobody to pick, and dropped), and the store's
      // presence is told by `picks`, empty until something is picked.
      const first = await served();
      assert.ok(first.app.views.visits);
      assert.deepEqual(first.app.picks, {});
      assert.deepEqual(await ids(), []);
      assert.deepEqual(await post('/api/choose', { name: 'site', value: '1' }), { status: 200, body: { ok: true } });
      assert.deepEqual((await served()).app.picks, { site: '1' });
      // The stored pick is every request's default; a tab's own header wins, name by name.
      assert.deepEqual(await ids(), [10, 13]);
      assert.deepEqual(await ids('site=2'), [11]);
      assert.deepEqual(await ids('site=999'), []);
      // Refused, not stored: an undeclared name, an unreadable row, a value that is not text.
      assert.equal((await post('/api/choose', { name: 'region', value: '1' })).status, 400);
      assert.equal((await post('/api/choose', { name: 'site', value: '999' })).status, 422);
      assert.equal((await post('/api/choose', { name: 'site', value: 1 })).status, 400);
      assert.deepEqual((await served()).app.picks, { site: '1' });
      // Another person holds their own, and one the row policy hides from them is no pick to make.
      who = { id: 'account-bo', who: 'bo@clinic.test', role: 'clerk' };
      assert.deepEqual((await served()).app.picks, {});
      assert.equal((await post('/api/choose', { name: 'site', value: '1' })).status, 422);
      assert.deepEqual(await ids(), []);
      // Clearing is a pick of nothing, and leaves the others' alone.
      who = { id: 'account-ana', who: 'ana@clinic.test', role: 'nurse' };
      assert.equal((await post('/api/choose', { name: 'site', value: null })).status, 200);
      assert.deepEqual((await served()).app.picks, {});
      assert.deepEqual(await ids(), []);
    } finally {
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
      clearJournal(connection);
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previous;
      rmSync(directory, { recursive: true, force: true });
    }
  },
);
