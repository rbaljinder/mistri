/**
 * The page follows the save (server/app/appLive.ts).
 *
 * The swap-or-keep decision is reloadApp's and has its own suite
 * (appreload.test.ts); what is proved here is what an open page is told
 * about it. A good save is one `reload` event on /api/app/live and the new
 * App on /api/app; a broken one is the same event, the last good App still
 * served, and the failure placed — file, line, code and the lines around it —
 * whether it did not parse, threw, or was refused. The watcher is not raced:
 * the reload and the announcement are called as serve.ts's watcher calls them.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadApp, mergeAppPages, reloadApp, type AppHost } from '../packages/mistri/src/server/app/apps.js';
import { appLive, placeLoadFailure, sayPlace } from '../packages/mistri/src/server/app/appLive.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const APP = `import { tasks } from './views.ts';
export default { id: 'live', name: 'Live', resources: { task: {} }, views: { tasks }, home: 'tasks', nav: ['tasks'] };
`;
const views = (label: string) => `export const tasks = {
  kind: 'list',
  from: 'task',
  label: '${label}',
  show: ['title'],
};
`;

describe('following an App’s saves', () => {
  let directory: string;
  let dir: string;
  before(() => {
    directory = mkdtempSync(join(tmpdir(), 'tablewalk-app-live-'));
    const db = new DatabaseSync(join(directory, 'live.db'));
    db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL); INSERT INTO task VALUES (1, 'First');`);
    db.close();
    dir = join(directory, 'app');
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  const writeApp = (label: string) => {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'app.ts'), APP);
    writeFileSync(join(dir, 'views.ts'), views(label));
  };

  test('a good save is told and served; a broken one is told, placed and the last good App kept', async () => {
    writeApp('Tasks');
    const loaded = await loadApp(dir);
    const live = appLive();
    const host: AppHost = { app: loaded, pages: mergeAppPages([], loaded), live };
    const registry = new Registry();
    registry.add({ id: 'live-db', name: 'live-db', url: join(directory, 'live.db'), source: 'config', writable: false });
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host] });
    const said: string[] = [];
    const error = console.error;
    console.error = (line: unknown) => said.push(String(line));
    const stream = new AbortController();
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      bound.port = (server.address() as { port: number }).port;
      const origin = `http://${bound.host}:${bound.port}`;
      const app = async () => (await fetch(`${origin}/api/app`, { signal: AbortSignal.timeout(5000) })).json();

      const first = await app();
      assert.equal(first.live, true, 'a watched App says so, so the page follows it');
      assert.equal(first.app.views.tasks.label, 'Tasks');

      /* The stream, read as the page reads it: one event per save. */
      const response = await fetch(`${origin}/api/app/live`, { signal: stream.signal });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
      const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
      let buffered = '';
      const nextEvent = async (name: string) => {
        for (;;) {
          const end = buffered.indexOf('\n\n');
          if (end >= 0) {
            const block = buffered.slice(0, end);
            buffered = buffered.slice(end + 2);
            if (block.includes(`event: ${name}`)) return JSON.parse(block.split('data: ')[1]);
            continue;
          }
          const { value, done } = await reader.read();
          if (done) throw new Error('the stream ended');
          buffered += value;
        }
      };
      assert.deepEqual(await nextEvent('hello'), { version: 0 });

      writeApp('Open tasks');
      assert.equal(await reloadApp(host, dir, []), true);
      await live.announce(host);
      assert.deepEqual(await nextEvent('reload'), { version: 1 });
      const reloaded = await app();
      assert.equal(reloaded.app.views.tasks.label, 'Open tasks');
      assert.equal(reloaded.loadError, undefined);
      assert.equal(reloaded.loadProblem, undefined);

      /* Does not parse: placed from the stack the worker sent back, in the imported module. */
      writeFileSync(join(dir, 'views.ts'), views('Broken').replace("  show: ['title'],", "  show: ['title']\n  extra: 1,"));
      assert.equal(await reloadApp(host, dir, []), false);
      await live.announce(host);
      assert.deepEqual(await nextEvent('reload'), { version: 2 });
      const broken = await app();
      assert.equal(broken.app.views.tasks.label, 'Open tasks', 'the last good App is still served');
      assert.ok(broken.loadError);
      assert.equal(broken.loadProblem.file, 'views.ts');
      assert.equal(broken.loadProblem.code, 'invalid-app');
      assert.ok(broken.loadProblem.line >= 5 && broken.loadProblem.line <= 6, `line ${broken.loadProblem.line}`);
      assert.ok(
        broken.loadProblem.frame.some((row: { line: number; text: string }) => row.line === broken.loadProblem.line),
        'the frame holds the line',
      );
      assert.ok(!JSON.stringify(broken.loadProblem).includes(directory), 'the file is said from the App, never the machine');
      assert.ok(
        said.some((line) => /^ {2}at views\.ts:\d/.test(line)),
        `the terminal places it too: ${said.join('\n')}`,
      );

      /* The next good save clears it. */
      writeApp('Tasks again');
      assert.equal(await reloadApp(host, dir, []), true);
      await live.announce(host);
      await nextEvent('reload');
      const fixed = await app();
      assert.equal(fixed.app.views.tasks.label, 'Tasks again');
      assert.equal(fixed.loadProblem, undefined);
    } finally {
      console.error = error;
      stream.abort();
      live.close();
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    }
  });

  test('an App that is not watched has no stream', async () => {
    writeApp('Tasks');
    const loaded = await loadApp(dir);
    const registry = new Registry();
    registry.add({ id: 'live-db', name: 'live-db', url: join(directory, 'live.db'), source: 'config', writable: false });
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [{ app: loaded, pages: [] }] });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      bound.port = (server.address() as { port: number }).port;
      const origin = `http://${bound.host}:${bound.port}`;
      assert.equal((await fetch(`${origin}/api/app/live`)).status, 404);
      assert.equal((await (await fetch(`${origin}/api/app`)).json()).live, undefined);
    } finally {
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    }
  });

  test('a reader the App’s problems are kept from holds no stream', async () => {
    /* An App that grants by role is read by people other than its author: they
       are not told its load error, nor that it moved on (they pick the new App
       up on their next fetch). */
    const app = parseAppConfig(
      {
        id: 'live',
        name: 'Live',
        resources: { task: {} },
        auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: ['task'] } } },
        views: { tasks: { kind: 'list', from: 'task', label: 'Tasks', show: ['title'] } },
        home: 'tasks',
        nav: ['tasks'],
      },
      'live roles fixture',
    );
    const reader: Identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };
    const live = appLive();
    const host: AppHost = {
      app: { path: join(dir, 'app.ts'), app, pages: [], sources: {} },
      pages: [],
      live,
      loadError: 'views.ts: Expected a comma',
      auth: {
        spec: app.auth!,
        store: join(directory, 'sessions.db'),
        handler: async () => {},
        close: async () => {},
        session: async (req: { headers: { cookie?: string } }) => (req.headers.cookie === 'session=viewer' ? reader : null),
      },
    };
    const registry = new Registry();
    registry.add({ id: 'live-db', name: 'live-db', url: join(directory, 'live.db'), source: 'config', writable: false });
    const bound = { host: '127.0.0.1', port: 0 };
    const server = createApp({ registry, bound, apps: [host] });
    try {
      server.listen(0, bound.host);
      await once(server, 'listening');
      bound.port = (server.address() as { port: number }).port;
      const origin = `http://${bound.host}:${bound.port}`;
      const asReader = { headers: { cookie: 'session=viewer' }, signal: AbortSignal.timeout(5000) };
      const payload = await (await fetch(`${origin}/api/app`, asReader)).json();
      assert.equal(payload.app.views.tasks.label, 'Tasks', 'the reader is served the App');
      assert.equal(payload.live, undefined);
      assert.equal(payload.loadProblem, undefined);
      assert.equal((await fetch(`${origin}/api/app/live`, asReader)).status, 404);
    } finally {
      live.close();
      const closed = new Promise<void>((done) => server.close(() => done()));
      server.closeAllConnections();
      await closed;
      await registry.closeAll();
    }
  });

  test('a throw is placed at its frame, and a refusal by its words', async () => {
    writeApp('Tasks');
    writeFileSync(join(dir, 'views.ts'), `${views('Tasks')}\nif (true) throw new Error('no tasks today');\n`);
    const host: AppHost = { app: { app: {} as never, path: join(dir, 'app.ts'), dir, pages: [], sources: {} }, pages: [] };
    assert.equal(await reloadApp(host, dir, []), false);
    const thrown = await placeLoadFailure(host.loadError!, dir, host.loadFailure?.error);
    assert.equal(thrown.file, 'views.ts');
    assert.equal(thrown.line, 8);
    assert.match(thrown.message, /no tasks today/);
    assert.doesNotMatch(thrown.message, /app\.ts: /, 'the manifest the loader names is the place, not the message');

    writeFileSync(join(dir, 'views.ts'), views('Tasks').replace("kind: 'list'", "kind: 'lisst'"));
    assert.equal(await reloadApp(host, dir, []), false);
    const refused = await placeLoadFailure(host.loadError!, dir, host.loadFailure?.error);
    assert.equal(refused.file, 'views.ts', JSON.stringify(refused));
    assert.equal(refused.line, 2);
    assert.match(refused.docs, /^https:\/\/mistriwork\.dev\/docs\/check-codes\/#/);
    assert.deepEqual(sayPlace(refused)[0], `  at views.ts:2 [${refused.code}]`);
    assert.ok(sayPlace(refused).some((line) => line.startsWith('  > 2 | ')));
  });
});
