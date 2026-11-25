/**
 * A page loader's `elevate` (`defineLoader({ elevate: { read } })`, a field report): the desk's page proposes a next
 * visit from a note's follow-up asks, and the desk's role reads no note. A loader read only what its reader reads, so
 * that read had to be a read-only command, with a command's cost. `elevate` is a command's, in a command's shape: the
 * table is read under the App's own authority and reaches the reader only as what `load` returns. Without it a loader
 * still reads nothing its reader cannot, and it is refused where a command's is.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { checkPageLoaders } from '../packages/mistri/src/server/app/pageLoaderCheck.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { loaderElevations } from '../packages/mistri/src/server/build/checkCommands.js';
import { defineLoader, defineLoaders, type PageLoader } from '../packages/mistri/src/server/commands/pageLoaders.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { connect } from '../packages/engine/src/adapters/connect.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const SQL = `CREATE TABLE visit (id INTEGER PRIMARY KEY, patient TEXT NOT NULL);
  CREATE TABLE note (id INTEGER PRIMARY KEY, visit_id INTEGER NOT NULL REFERENCES visit(id), body TEXT NOT NULL, follow_up TEXT);
  CREATE TABLE fee (id INTEGER PRIMARY KEY, cents INTEGER NOT NULL);
  INSERT INTO visit VALUES (1, 'Ada'), (2, 'Grace');
  INSERT INTO note VALUES (1, 1, 'Crown on 14, sensitive', 'Recall in 6 months'), (2, 2, 'Routine', NULL);
  INSERT INTO fee VALUES (1, 12000);`;

const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });
const page = (key: string, loader: string, more: Record<string, unknown> = {}) => ({
  kind: 'page',
  label: key,
  component: component(key),
  reads: ['visit'],
  loader,
  ...more,
});
const APP = {
  id: 'chair',
  name: 'Chair',
  sources: { main: { connection: 'chair-db', default: true } },
  resources: { visit: {}, note: {}, fee: {} },
  auth: { roles: { dentist: { read: ['visit', 'note'] }, desk: { read: ['visit'] } } },
  views: {
    visits: { kind: 'list', from: 'visit', label: 'Visits' },
    today: page('today', 'nextVisit'),
    peek: page('peek', 'peek'),
    crossed: page('crossed', 'crossed'),
  },
  home: 'visits',
  nav: ['visits', 'today', 'peek', 'crossed'],
};
const parse = (change: Record<string, unknown> = {}) => parseTestApp({ ...APP, ...change }, 'chair');

/* The follow-up asks of the notes, and nothing else of them: what the desk's page is drawn with. */
const nextVisit = defineLoader({
  reads: ['visit', 'note'],
  elevate: { read: ['note'] },
  load: async ({ db }) => ({
    visits: await db.visit.count(),
    asks: (await db.note.where('follow_up != ""').orderBy('id')).map((row) => String(row.follow_up)),
    notes: await db.note.count(),
  }),
});
const LOADERS = defineLoaders({
  nextVisit,
  /* The same read with no `elevate`: a loader is its reader, and the desk reads no note. */
  peek: defineLoader({ reads: ['visit', 'note'], load: async ({ db }) => ({ asks: (await db.note.where({})).length }) }),
  /* One statement under two authorities: the reader's visits, asked about the elevated notes. */
  crossed: defineLoader({
    reads: ['visit', 'note'],
    elevate: { read: ['note'] },
    load: async ({ db }) => ({ flagged: (await db.visit.where('any note where follow_up != ""')).length }),
  }),
}) as unknown as Readonly<Record<string, PageLoader>>;

test("a loader's elevate takes a command's shape, and is refused in a command's words", () => {
  const made = nextVisit as unknown as PageLoader;
  assert.deepEqual(made.reads, ['visit', 'note']);
  assert.deepEqual(made.elevate, { read: ['note'] });
  const elevated = (elevate: unknown, reads: string[] = ['visit', 'note']) =>
    defineLoader({ reads, elevate: elevate as never, load: () => null });
  assert.throws(() => elevated({ read: ['fee'] }), /Loader elevate read names "fee", which is not in its reads; add it to reads\./);
  assert.throws(() => elevated({ read: [] }), /Loader elevate read names no table/);
  assert.throws(() => elevated({ write: ['note'] }), /Loader elevate has an unknown option: write\. It takes read\./);
  assert.throws(() => elevated(['note']), /Loader elevate must be a plain object/);
  assert.throws(() => elevated({ read: 'note' }), /Loader elevate read must be a list of table names/);
  assert.throws(
    () => elevated({ read: ['note'] }, ['visit', 'note', 'note.open_asks']),
    /Loader elevate read names "note", and its reads ask for "note\.open_asks": an elevated read is of the table's own columns/,
  );
});

test('check holds an elevating loader to where a command may elevate, and a loader without elevate to its page', () => {
  const only = (name: string) => ({
    views: { visits: APP.views.visits, [name]: (APP.views as Record<string, unknown>)[name] },
    nav: ['visits', name],
  });
  assert.doesNotThrow(() => checkPageLoaders(parse(only('today')), LOADERS, 'chair'));
  // The negative: without `elevate`, a loader that reads what its page does not is refused, as it always was.
  assert.throws(
    () => checkPageLoaders(parse(only('peek')), LOADERS, 'chair'),
    /\[page-loader\].*its loader "peek" reads "note", which the page does not declare in its reads/,
  );
  // Under a row policy a command's elevate is refused, and a loader's in the same words.
  assert.throws(
    () => checkPageLoaders(parse({ ...only('today'), auth: { ...APP.auth, rows: 'policy' } }), LOADERS, 'chair'),
    /\[loader-elevate\].*its loader "nextVisit" elevates its read of "note", but the App's rows are its policy's: a loader reads the caller's rows there, so no read is elevated\. Grant the role the table, or drop elevate\./,
  );
  // A signed-out visitor holds no role to read above.
  assert.throws(
    () =>
      checkPageLoaders(
        parse({
          ...only('today'),
          auth: { ...APP.auth, public: { read: ['visit'] } },
          views: { visits: APP.views.visits, today: page('today', 'nextVisit', { public: true }) },
        }),
        LOADERS,
        'chair',
      ),
    /\[loader-elevate\].*a public page has no role to read above: drop its elevate/,
  );
  // An audited resource's reads are recorded, and an elevated loader's would not be.
  assert.throws(
    () =>
      checkPageLoaders(parse({ ...only('today'), resources: { ...APP.resources, note: { audit: { reads: true } } } }), LOADERS, 'chair'),
    /\[loader-elevate\].*"note", which audits its reads \(audit\.reads\)/,
  );
  // A surface's loader reads what its reader reads.
  const surfaced = {
    ...parse(only('today')),
    surfaces: { site: { key: 'site', label: 'Site', reads: ['visit'], commands: [], loader: 'nextVisit' } },
  };
  assert.throws(
    () => checkPageLoaders(surfaced as never, LOADERS, 'chair'),
    /\[loader-elevate\].*a surface's loader reads what its reader reads/,
  );
});

test('check --design lists each elevating loader with its page and the roles it reads above', async (t) => {
  const at = await catalog(t);
  const only = { views: { visits: APP.views.visits, today: APP.views.today }, nav: ['visits', 'today'] };
  assert.deepEqual(loaderElevations(parse(only), LOADERS, at.schema), [
    'loader "nextVisit" (page "today") reads "note" under its own authority, for role "desk"',
  ]);
  assert.deepEqual(loaderElevations(parse({ views: { visits: APP.views.visits }, nav: ['visits'] }), LOADERS, at.schema), []);
});

async function catalog(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-loader-elevate-'));
  const file = join(directory, 'chair.db');
  const seed = new DatabaseSync(file);
  seed.exec(SQL);
  seed.close();
  const adapter = connect(file);
  t.after(async () => {
    await adapter.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, file, schema: await adapter.introspect() };
}

/** Every statement the process's SQLite connections were handed while `work` ran. */
async function statements<T>(work: () => Promise<T>): Promise<{ value: T; sql: string[] }> {
  const sql: string[] = [];
  const proto = DatabaseSync.prototype as unknown as Record<'prepare' | 'exec', (text: string, ...rest: unknown[]) => unknown>;
  const { prepare, exec } = proto;
  proto.prepare = function (this: unknown, text, ...rest) {
    sql.push(text);
    return prepare.call(this, text, ...rest);
  };
  proto.exec = function (this: unknown, text, ...rest) {
    sql.push(text);
    return exec.call(this, text, ...rest);
  };
  try {
    return { value: await work(), sql };
  } finally {
    proto.prepare = prepare;
    proto.exec = exec;
  }
}

async function serve(t: TestContext, rows?: 'policy') {
  const { directory, file } = await catalog(t);
  const registry = new Registry();
  registry.add({ id: 'chair-db', name: 'Chair', url: file, source: 'config', writable: false });
  const app = parse(rows ? { auth: { ...APP.auth, rows } } : {});
  const pages = parsePagesConfig({ pages: [] }, 'chair pages');
  const control = { identity: { id: 'dana', who: 'dana@example.test', role: 'desk' } as Identity | null };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages, sources: {}, loaders: LOADERS },
    pages,
    auth: {
      spec: app.auth!,
      store: join(directory, 'sessions.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async () => {},
    },
  };
  let policy: Awaited<ReturnType<typeof loadHttpAppPolicy>> | undefined;
  if (rows) {
    const policyFile = join(directory, 'policy.mjs');
    writeFileSync(policyFile, `export default { appId: 'chair', resolveRows() { return { visit: true, note: true, fee: true }; } };`);
    policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  }
  const bound = { host: '127.0.0.1', port: 0 };
  const server: Server = createApp({ registry, apps: [host], ...(policy ? { policy } : {}), pages, bound });
  server.listen(0, bound.host);
  await once(server, 'listening');
  bound.port = (server.address() as { port: number }).port;
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await policy?.retire();
    await registry.closeAll();
  });
  const call = async (path: string, body: object) => {
    const response = await fetch(`http://${bound.host}:${bound.port}${path}?app=chair`, {
      signal: AbortSignal.timeout(5000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'chair', ...body }),
    });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as { data?: unknown; code?: string; error?: string } };
  };
  return { control, call };
}

test("the desk's loader reads the notes it elevates, and only what it returns reaches the desk", async (t) => {
  const { control, call } = await serve(t);
  const loaded = await call('/api/pages/load', { page: 'today' });
  assert.equal(loaded.status, 200, loaded.text);
  assert.deepEqual(loaded.body.data, { visits: 2, asks: ['Recall in 6 months'], notes: 2 });
  assert.doesNotMatch(loaded.text, /Crown|sensitive/, 'the note itself is not what the loader returns');
  // The elevation is the loader's alone: the desk's own read of the table is what it was.
  const own = await call('/api/view/run', { view: { base: 'note' }, count: 'none' });
  assert.equal(own.status, 404, own.text);
  assert.doesNotMatch(own.text, /Crown|Recall/);

  // The negative: the same read by a loader that does not elevate is refused, and no statement names the table.
  const refused = await statements(() => call('/api/pages/load', { page: 'peek' }));
  assert.equal(refused.value.status, 403, refused.value.text);
  assert.equal(refused.value.body.code, 'page_undeclared');
  assert.match(String(refused.value.body.error), /The loader "peek" reads what this reader cannot\./);
  assert.deepEqual(
    refused.sql.filter((text) => /\bnote\b/i.test(text)),
    [],
  );
  // One statement is read under one authority: the reader's visits are not asked about the elevated notes.
  const crossed = await statements(() => call('/api/pages/load', { page: 'crossed' }));
  assert.equal(crossed.value.status, 403, crossed.value.text);
  assert.equal(crossed.value.body.code, 'loader_refused');
  assert.match(String(crossed.value.body.error), /asks "visit" about its "note" rows, and only one of the two is elevated/);
  assert.deepEqual(
    crossed.sql.filter((text) => /\bnote\b/i.test(text)),
    [],
  );

  // A reader who is granted the table is answered the same: the read is the App's either way.
  control.identity = { id: 'lee', who: 'lee@example.test', role: 'dentist' };
  assert.deepEqual((await call('/api/pages/load', { page: 'today' })).body.data, { visits: 2, asks: ['Recall in 6 months'], notes: 2 });
  assert.deepEqual(
    (await call('/api/pages/load', { page: 'peek' })).body.data,
    { asks: 2 },
    'and the plain loader reads what the dentist reads',
  );
});

test('under a row policy the elevating loader is refused where it would read, whatever check was told', async (t) => {
  /* `check` refuses this App (above); a host that served it all the same reads nothing above the caller's rows. */
  const { call } = await serve(t, 'policy');
  const refused = await statements(() => call('/api/pages/load', { page: 'today' }));
  assert.equal(refused.value.status, 403, refused.value.text);
  assert.equal(refused.value.body.code, 'loader_refused');
  assert.deepEqual(
    refused.sql.filter((text) => /\bFROM\s+"?note\b/i.test(text)),
    [],
  );
});
