/**
 * Hot-reloading the app directory.
 *
 * The property under test is the swap-or-keep decision: a good save replaces
 * everything the server serves about the app — the manifest and the merged
 * pages together — and a broken save replaces nothing but the error. The
 * decision lives in `reloadApp`, a plain function, so all of that is proved
 * without racing fs.watch; the watcher itself gets one smoke test with a
 * polling wait, because its whole job is "an event arrives eventually".
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appForConnection,
  appPayload,
  assertAppScopes,
  loadApp,
  mergeAppPages,
  reloadApp,
  watchApp,
  loadedFiles,
  type AppHost,
} from '../packages/mistri/src/server/app/apps.js';
import { AUTHORITY_CHANGED } from '../packages/mistri/src/server/app/authorityLock.js';
import { once } from 'node:events';
import { createApp } from './support/createApp.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { PageDef } from '../packages/engine/src/shared/page.js';

/** Just enough schema for a payload to resolve against. */
const col = (name: string) => ({ name, type: 'text', nullable: true, primaryKey: false });

const SCHEMA: DatabaseSchema = {
  label: 'demo',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { name: 'work_order', schema: '', id: 'work_order', columns: [col('reference')], isView: false },
    { name: 'customer', schema: '', id: 'customer', columns: [col('name')], isView: false },
  ],
  foreignKeys: [],
};

/** The reload, not the home, is under test: a manifest with no view of its own gets the one list and home every App needs. */
const withHome = (manifest: unknown) =>
  manifest && typeof manifest === 'object' && !('home' in manifest) && !('views' in manifest)
    ? {
        views: { orders: { kind: 'list', from: 'work_order' } },
        home: 'orders',
        ...manifest,
        resources: { work_order: {}, ...(manifest as { resources?: object }).resources },
      }
    : manifest;

describe('reloadApp', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-appreload-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const writeApp = (dir: string, manifest: unknown): string => {
    const full = join(tmp, dir);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'app.json'), JSON.stringify(withHome(manifest)));
    return full;
  };

  /** A host as the server builds it at startup: loaded once, merged once. */
  const startup = async (dir: string, configPages: PageDef[] = []): Promise<AppHost> => {
    const app = await loadApp(dir);
    return { app, pages: mergeAppPages(configPages, app) };
  };

  test('a good save swaps the manifest and the merged pages together', async () => {
    const dir = writeApp('swap', {
      name: 'Field Ops',
      pages: { order: { base: 'work_order' } },
    });
    const host = await startup(dir);
    assert.equal(host.app.app.name, 'Field Ops');
    assert.deepEqual(
      host.pages.map((p) => p.id),
      ['order'],
    );

    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify(
        withHome({
          name: 'Field Ops v2',
          pages: { order: { base: 'work_order' }, customer: { base: 'customer' } },
        }),
      ),
    );
    assert.equal(await reloadApp(host, dir, []), true);
    assert.equal(host.app.app.name, 'Field Ops v2');
    assert.deepEqual(
      host.pages.map((p) => p.id),
      ['order', 'customer'],
    );
    assert.equal(host.loadError, undefined);
  });

  test('a broken save keeps the last good app and captures the error', async () => {
    const dir = writeApp('broken', { name: 'Ops', pages: { order: { base: 'work_order' } } });
    const host = await startup(dir);
    const goodApp = host.app;
    const goodPages = host.pages;

    // The save an editor makes between two keystrokes.
    writeFileSync(join(dir, 'app.json'), '{ "name": "Ops v');
    assert.equal(await reloadApp(host, dir, []), false);
    assert.equal(host.app, goodApp, 'the manifest did not move');
    assert.equal(host.pages, goodPages, 'the merged pages did not move');
    assert.match(host.loadError ?? '', /broken[/\\]app\.json:/);

    // The next good save wins, and takes the error with it.
    writeFileSync(join(dir, 'app.json'), JSON.stringify(withHome({ name: 'Ops v2' })));
    assert.equal(await reloadApp(host, dir, []), true);
    assert.equal(host.app.app.name, 'Ops v2');
    assert.equal(host.loadError, undefined);
  });

  test('a save whose pages collide with the config file swaps nothing', async () => {
    /* loadApp succeeds here and mergeAppPages refuses, so this is the case
       that proves the two move together: a half-applied reload would serve
       v2's manifest with v1's pages. */
    const configPage = { id: 'order', name: 'Order', base: 'work_order', source: 'config' } as unknown as PageDef;
    const dir = writeApp('collide', { name: 'Ops' });
    const host = await startup(dir, [configPage]);
    const goodApp = host.app;

    writeFileSync(
      join(dir, 'app.json'),
      JSON.stringify(
        withHome({
          name: 'Ops v2',
          pages: { order: { base: 'work_order' } },
        }),
      ),
    );
    assert.equal(await reloadApp(host, dir, [configPage], '/etc/mistri.json'), false);
    assert.equal(host.app, goodApp);
    assert.match(host.loadError ?? '', /page id "order" is already defined in \/etc\/mistri\.json/);
  });

  test('reloading picks up a pages/ folder that did not exist at startup', async () => {
    const dir = writeApp('late-pages', { name: 'Ops' });
    const host = await startup(dir);
    assert.equal(host.pages.length, 0);

    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'order.json'), JSON.stringify({ base: 'work_order' }));
    assert.equal(await reloadApp(host, dir, []), true);
    assert.deepEqual(
      host.pages.map((p) => p.id),
      ['order'],
    );
  });

  test('the load error rides /api/app beside the last good app', async () => {
    const dir = writeApp('payload', { name: 'Ops' });
    const host = await startup(dir);
    writeFileSync(join(dir, 'app.json'), '{ nope');
    await reloadApp(host, dir, []);

    const got = appPayload(host.app, 'db', 'db', SCHEMA, host.loadError);
    assert.equal(got.app?.name, 'Ops', 'the last good app is still the answer');
    assert.match(got.loadError ?? '', /payload[/\\]app\.json:/);

    // And a healthy directory does not carry the field at all.
    const healthy = appPayload(host.app, 'db', 'db', SCHEMA, undefined);
    assert.equal('loadError' in healthy, false);
  });

  test('adding or removing authentication fails closed until a restart, with nothing half-swapped', async () => {
    for (const [name, before, after] of [
      ['add-auth', undefined, {}],
      ['remove-auth', {}, undefined],
    ] as const) {
      const original = { name: 'Atlas', auth: before, pages: { customer: { base: 'customer' } } };
      const dir = writeApp(name, original);
      const host = await startup(dir);
      const app = host.app;
      const pages = host.pages;
      writeApp(name, { name: 'Changed', auth: after, pages: {} });
      assert.equal(await reloadApp(host, dir, []), false);
      assert.equal(host.app, app);
      assert.equal(host.pages, pages);
      assert.equal(host.unavailable, AUTHORITY_CHANGED, name);
      assert.ok((host.loadError ?? '').startsWith(`${AUTHORITY_CHANGED}\n`), host.loadError);
      assert.match(host.loadError ?? '', /The sign-in configuration changed/);
      writeApp(name, original);
      assert.equal(await reloadApp(host, dir, []), false, `${name}: a revert does not reopen it`);
      assert.equal(host.unavailable, AUTHORITY_CHANGED);
    }
  });

  test('a changed provider, session store, sign-up, default role or App id fails closed, naming no secret', async () => {
    const original = { providers: ['email'], signUp: 'invite', defaultRole: 'user', store: '/private/auth-store.db' };
    const changes: Array<[string, Record<string, unknown>]> = [
      ['providers', { auth: { ...original, providers: ['email', 'github'] } }],
      ['store', { auth: { ...original, store: '/private/other-secret-store.db' } }],
      ['sign-up', { auth: { ...original, signUp: 'open' } }],
      ['default-role', { auth: { ...original, defaultRole: 'admin' } }],
      ['app-id', { id: 'other-id', auth: original }],
    ];
    for (const [what, change] of changes) {
      const dir = writeApp(`auth-settings-${what}`, { name: 'Atlas', id: 'atlas', auth: original });
      const host = await startup(dir);
      const app = host.app;
      writeApp(`auth-settings-${what}`, { name: 'Atlas', id: 'atlas', ...change });
      assert.equal(await reloadApp(host, dir, []), false, what);
      assert.equal(host.app, app, what);
      assert.equal(host.unavailable, AUTHORITY_CHANGED, what);
      assert.match(host.loadError ?? '', /The sign-in configuration changed/, what);
      assert.doesNotMatch(host.loadError ?? '', /private|secret-store/, what);
    }
  });

  test('a signed-out App that gains auth on reload answers 503 on its APIs until a restart', async () => {
    const dir = writeApp('gains-auth', { name: 'Atlas' });
    const host = await startup(dir);
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry: new Registry(), bound, apps: [host] });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      bound.port = address.port;
      const call = (path: string): Promise<Response> =>
        fetch(`http://127.0.0.1:${address.port}${path}`, { signal: AbortSignal.timeout(3_000) });
      assert.ok(!(await (await call('/api/app')).text()).includes(AUTHORITY_CHANGED), 'before the reload, nothing is closed');
      writeApp('gains-auth', { name: 'Atlas', auth: {} });
      assert.equal(await reloadApp(host, dir, []), false);
      writeApp('gains-auth', { name: 'Atlas' });
      assert.equal(await reloadApp(host, dir, []), false, 'a revert does not reopen it');
      for (const path of ['/api/app', '/api/schema', '/api/runtime']) {
        const response = await call(path);
        assert.equal(response.status, 503, path);
        assert.equal(response.headers.get('cache-control'), 'no-store', path);
        assert.deepEqual(await response.json(), { error: AUTHORITY_CHANGED }, path);
      }
    } finally {
      server.close();
    }
  });

  const atlas = {
    name: 'Atlas',
    auth: { providers: ['email'], signUp: 'invite', defaultRole: 'user', roles: { user: { read: true } } },
    resources: { customer: {} },
    pages: { customer: { base: 'customer' } },
  };

  test('edits that keep the authority reload, with auth keys reordered', async () => {
    const dir = writeApp('same-authority', atlas);
    const host = await startup(dir);
    const app = host.app;
    writeApp('same-authority', {
      ...atlas,
      auth: { roles: { user: { read: true } }, defaultRole: 'user', signUp: 'invite', providers: ['email'] },
      pages: { order: { base: 'customer' } },
    });
    assert.equal(await reloadApp(host, dir, []), true);
    assert.notEqual(host.app, app);
    assert.deepEqual(
      host.pages.map((page) => page.id),
      ['order'],
    );
    assert.equal(host.loadError, undefined);
    assert.equal(host.unavailable, undefined);
  });

  test('a reload that changes the authority fails closed until a restart, and a revert does not reopen it', async () => {
    const dir = writeApp('access-only', atlas);
    const host = await startup(dir);
    writeApp('access-only', {
      ...atlas,
      auth: { ...atlas.auth, roles: { user: { read: true, write: true } } },
      resources: { customer: {}, work_order: { access: 'write' } },
    });
    /* Neither the old authority nor the new one is served: every App
       request answers with this until the server restarts. The difference
       is the operator's, in the load error the log prints. */
    assert.equal(await reloadApp(host, dir, []), false);
    assert.equal(host.unavailable, AUTHORITY_CHANGED);
    assert.ok((host.loadError ?? '').startsWith(`${AUTHORITY_CHANGED}\n`), host.loadError);
    assert.match(host.loadError ?? '', /\+ resource work_order access write — the App/);
    writeApp('access-only', atlas);
    assert.equal(await reloadApp(host, dir, []), false, 'closed: nothing reloads until a restart');
    assert.equal(host.unavailable, AUTHORITY_CHANGED);
  });
});

describe('watchApp', () => {
  let tmp: string;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-appwatch-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  /** Poll until the counter moves, because fs.watch promises only "eventually". */
  const waitFor = async (check: () => boolean, ms: number): Promise<boolean> => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return check();
  };

  /**
   * Write, and write again if the watcher did not see it.
   *
   * fs.watch arms asynchronously — on macOS the kernel subscription lands a
   * few milliseconds after `watch()` returns, and a change inside that gap is
   * *missed*, not delayed; the same gap opens again when `pages/` is created
   * and its own watcher attaches. Under a loaded machine the gap is wider and
   * this test hit it about one run in ten, then waited ten seconds for an
   * event that was never coming. The contract under test is "a save is seen,
   * once, debounced" — not "the very first save after arming is seen" — so a
   * save nobody saw is made again, up to a few times, and each attempt gets
   * a couple of seconds, which covers latency without covering a real fault.
   */
  const saveUntilSeen = async (file: string, body: string, moved: () => boolean): Promise<boolean> => {
    for (let attempt = 0; attempt < 5; attempt++) {
      writeFileSync(file, body);
      if (await waitFor(moved, 2_000)) return true;
    }
    return moved();
  };

  test('a save in the directory lands as one debounced call', async () => {
    const dir = join(tmp, 'app');
    mkdirSync(dir);
    writeFileSync(join(dir, 'app.json'), JSON.stringify(withHome({ name: 'Ops' })));

    let calls = 0;
    const stop = watchApp(
      dir,
      () => {
        calls += 1;
      },
      50,
    );
    try {
      assert.ok(
        await saveUntilSeen(join(dir, 'app.json'), JSON.stringify(withHome({ name: 'Ops v2' })), () => calls >= 1),
        'the change was never seen',
      );

      /* And a pages/ born after the watch started is watched too: the mkdir
         is an event on the parent, which re-attaches. The mkdir itself may or
         may not be reported — that is the parent watcher's business — so the
         count is read after it settles and the assertion is on the file. */
      mkdirSync(join(dir, 'pages'));
      await waitFor(() => calls >= 2, 1_000);
      const before = calls;
      assert.ok(
        await saveUntilSeen(join(dir, 'pages', 'order.json'), JSON.stringify({ base: 'work_order' }), () => calls > before),
        'the pages/ file was never seen',
      );
    } finally {
      stop();
    }
  });

  test('a file the App does not load never reloads it, and a module it imports does', async () => {
    /* Field report N1: a server started with its output redirected into the App folder reloaded in a loop (28 times in
       15 s), because the watcher took the log it was writing for an edit. Only what the load read is a change. */
    const dir = join(tmp, 'quiet');
    mkdirSync(join(dir, 'lib'), { recursive: true });
    writeFileSync(join(dir, 'lib', 'name.ts'), "export const name = 'Quiet';\n");
    writeFileSync(join(dir, 'data.json'), '{"home":"orders"}');
    writeFileSync(
      join(dir, 'app.ts'),
      "import { name } from './lib/name.ts';\nimport data from './data.json' with { type: 'json' };\n" +
        "export default { name, home: data.home, resources: { work_order: {} }, views: { orders: { kind: 'list', from: 'work_order' } } };\n",
    );
    let loaded = await loadApp(dir);
    assert.ok(
      loaded.modules?.some((file) => file.endsWith('name.ts')),
      'the load reports the modules it imported',
    );
    let calls = 0;
    const stop = watchApp(
      dir,
      () => {
        calls += 1;
      },
      50,
      undefined,
      () => loadedFiles(loaded),
    );
    try {
      // Written the way a redirected server writes: a log, a JSON beside the source, an editor's swap file, a database's journal.
      for (let i = 0; i < 4; i++) {
        writeFileSync(join(dir, 'server.log'), `request ${i}\n`);
        writeFileSync(join(dir, 'report.json'), `{"i":${i}}`);
        writeFileSync(join(dir, '.app.ts.swp'), `swap ${i}`);
        writeFileSync(join(dir, 'app.db-journal'), `${i}`);
        await new Promise((resolve) => setTimeout(resolve, 60));
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(calls, 0, 'an unrelated file written in the App folder reloaded the App');

      assert.ok(
        await saveUntilSeen(join(dir, 'lib', 'name.ts'), "export const name = 'Quiet v2';\n", () => calls >= 1),
        'an edit to an imported module was never seen',
      );
      const before = calls;
      assert.ok(
        await saveUntilSeen(join(dir, 'data.json'), '{ "home": "orders" }', () => calls > before),
        'an edit to an imported JSON file was never seen',
      );
      loaded = await loadApp(dir);
      assert.equal(loaded.app.name, 'Quiet v2');
    } finally {
      stop();
    }
  });
});

describe('app.mjs: the typed veneer', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-appmjs-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const dirWith = (name: string, files: Record<string, string>): string => {
    const full = join(tmp, name);
    mkdirSync(full, { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(full, file), text);
    return full;
  };

  test('a directory holding app.mjs loads through the same parse path', async () => {
    const dir = dirWith('typed', {
      'app.mjs':
        "export default { name: 'Typed', resources: { x: {} }, views: { x: { kind: 'list', from: 'x' } }, home: 'x', nav: ['x'] };\n",
    });
    const loaded = await loadApp(dir);
    assert.equal(loaded.app.name, 'Typed');
    assert.equal((loaded.app.views.x as import('../packages/mistri/src/shared/app.js').AppListView).table, 'x');
  });

  test('both app.json and app.mjs is refused rather than guessed at', async () => {
    const dir = dirWith('both', {
      'app.json': '{ "name": "A" }',
      'app.mjs': "export default { name: 'B' };\n",
    });
    await assert.rejects(() => loadApp(dir), /app\.json and app\.mjs — keep one/);
  });

  test('app.mjs beside app.ts is refused by name, not reported as missing', async () => {
    /* The rethrow used to match on the text `app.json`, so this pair fell
       through to "does not exist" and sent the author looking for a
       directory that was right there. */
    const dir = dirWith('both-typed', {
      'app.mjs': "export default { name: 'A' };\n",
      'app.ts': "export default { name: 'B' };\n",
    });
    await assert.rejects(() => loadApp(dir), /app\.mjs and app\.ts — keep one/);
  });

  test('a world-writable app directory is refused with the chmod', { skip: process.platform === 'win32' }, async () => {
    /* Hot reload evaluates whatever lands in the directory; a directory
       anyone can write to is code execution for every account on the box. */
    const dir = dirWith('open', { 'app.json': '{ "name": "Open" }' });
    chmodSync(dir, 0o777);
    try {
      await assert.rejects(() => loadApp(dir), /writable by everyone.*chmod o-w/);
    } finally {
      chmodSync(dir, 0o755);
    }
  });

  test('an app loaded from a directory remembers the directory, for the reload and the watcher', async () => {
    /* The reload target used to be derived from the manifest's extension,
       and the derivation knew `.json` and `.mjs`: an app.ts was reloaded by
       file, so `pages/` was skipped and its pages vanished on the first save. */
    const dir = dirWith('typed-dir', {
      'app.ts': "export default { name: 'T', resources: { t: {} }, views: { t: { kind: 'list', from: 't' } }, home: 't' };\n",
    });
    mkdirSync(join(dir, 'pages'));
    writeFileSync(join(dir, 'pages', 'one.json'), '{ "base": "x", "sections": [{ "kind": "fields" }] }');
    const fromDir = await loadApp(dir);
    assert.equal(fromDir.dir, dir);
    assert.equal(fromDir.pages.length, 1);
    const fromFile = await loadApp(join(dir, 'app.ts'));
    assert.equal(fromFile.dir, undefined, 'a file target has no directory to reload');
  });

  test('a module that does not default-export an object says so', async () => {
    const dir = dirWith('bare', { 'app.mjs': 'export const nope = 1;\n' });
    await assert.rejects(() => loadApp(dir), /must default-export the app object/);
  });

  test("app.ts loads on the runtime's own type stripping", async () => {
    const dir = dirWith('typed-ts', {
      'app.ts':
        "const name: string = 'FromTS';\nexport default { name, resources: { t: {} }, views: { t: { kind: 'list', from: 't' } }, home: 't' } as const;\n",
    });
    const loaded = await loadApp(dir);
    assert.equal(loaded.app.name, 'FromTS');
  });

  test('an app spread across files reloads whole — the imported file too', async () => {
    /* The worker loader's whole reason: a fresh module cache per load,
       so editing part.mjs is seen without touching app.mjs. The old
       query-string bust refreshed only the entry file. */
    const dir = dirWith('split', {
      'part.mjs': "export const label = 'Before';\n",
      'app.mjs':
        "import { label } from './part.mjs';\nexport default { name: label, resources: { t: {} }, views: { t: { kind: 'list', from: 't' } }, home: 't' };\n",
    });
    const first = await loadApp(dir);
    assert.equal(first.app.name, 'Before');
    writeFileSync(join(dir, 'part.mjs'), "export const label = 'After';\n");
    const second = await loadApp(dir);
    assert.equal(second.app.name, 'After');
  });

  test('a function smuggled into the manifest is refused at the boundary', async () => {
    const dir = dirWith('func', {
      'app.mjs': "export default { name: 'F', nav: [], oops: () => 1 };\n",
    });
    await assert.rejects(() => loadApp(dir), /plain data/);
  });

  test('a reload sees the saved module, not the import cache', async () => {
    /* import() caches by URL; the loader busts it by mtime, because a hot
       reload serving the version from before the save is a loop that lies. */
    const dir = dirWith('busted', {
      'app.mjs': "export default { name: 'First', resources: { t: {} }, views: { t: { kind: 'list', from: 't' } }, home: 't' };\n",
    });
    const file = join(dir, 'app.mjs');
    assert.equal((await loadApp(dir)).app.name, 'First');
    writeFileSync(file, "export default { name: 'Second', resources: { t: {} }, views: { t: { kind: 'list', from: 't' } }, home: 't' };\n");
    /* mtime resolution can be a whole second on some filesystems; nudge it
       forward so the cache key provably moves. */
    const { utimes } = await import('node:fs/promises');
    await utimes(file, new Date(), new Date(Date.now() + 2000));
    assert.equal((await loadApp(dir)).app.name, 'Second');
  });
});

describe('more than one app', () => {
  let tmp: string;
  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'tablewalk-multiapp-'));
  });
  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });
  const appDir = (name: string, manifest: unknown): string => {
    const full = join(tmp, name);
    mkdirSync(full, { recursive: true });
    writeFileSync(join(full, 'app.json'), JSON.stringify(withHome(manifest)));
    return full;
  };

  test('every app must name its connection, and no two the same one', async () => {
    const a = await loadApp(appDir('a', { name: 'A', connection: 'one' }));
    const b = await loadApp(appDir('b', { name: 'B', connection: 'two' }));
    const bare = await loadApp(appDir('bare', { name: 'Bare' }));
    const twin = await loadApp(appDir('twin', { name: 'Twin', connection: 'one' }));

    assert.doesNotThrow(() => assertAppScopes([a, b]));
    // One app keeps today's behaviour: unscoped means every connection.
    assert.doesNotThrow(() => assertAppScopes([bare]));
    assert.throws(() => assertAppScopes([a, bare]), /must name its "connection".*"Bare"/);
    assert.throws(() => assertAppScopes([a, twin]), /"A" and "Twin" both claim connection "one"/);
  });

  test('duplicate app IDs are refused before resolving any source ownership', async () => {
    const a = await loadApp(appDir('id-a', { name: 'A', id: 'shared-id', connection: 'one' }));
    const b = await loadApp(appDir('id-b', { name: 'B', id: 'shared-id', connection: 'two' }));
    let resolutions = 0;
    assert.throws(
      () =>
        assertAppScopes([a, b], (value) => {
          resolutions++;
          return value;
        }),
      /App ID "shared-id" is duplicated/,
    );
    assert.equal(resolutions, 0);
    const c = await loadApp(appDir('id-c', { name: 'A', connection: 'three' }));
    const d = await loadApp(appDir('id-d', { name: 'A', connection: 'four' }));
    assert.throws(() => assertAppScopes([c, d]), /App ID "a" is duplicated/);
  });

  test('the connection picks the app; a lone unscoped app answers for everyone', async () => {
    const a = await loadApp(appDir('pick-a', { name: 'A', connection: 'one' }));
    const b = await loadApp(appDir('pick-b', { name: 'B', connection: 'Two Name' }));
    const hosts = [{ app: a }, { app: b }];
    assert.equal(appForConnection(hosts, 'one', undefined)?.app.app.name, 'A');
    // By name as well as by id, the id-or-name convention everywhere else.
    assert.equal(appForConnection(hosts, 'conn2', 'Two Name')?.app.app.name, 'B');
    assert.equal(appForConnection(hosts, 'three', undefined), undefined);

    const bare = await loadApp(appDir('pick-bare', { name: 'Bare' }));
    assert.equal(appForConnection([{ app: bare }], 'anything', undefined)?.app.app.name, 'Bare');
  });
});
