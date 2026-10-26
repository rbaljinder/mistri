/**
 * A dashboard that greets its reader, and the pieces a dashboard section
 * gained with the Tray look: a section's mark and bars.
 *
 * The greeting is said by the server, from the verified session, into the
 * App it serves; the browser never fills it. Where there is no name — a
 * public reader, an account without one — the line is not drawn, never
 * "Hello, " or a brace.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'node:test';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { checkGreeting, greetReader, READER_NAME } from '../packages/mistri/src/shared/appGreeting.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

const manifest = (extra: Record<string, unknown> = {}, auth: unknown = { roles: { staff: { read: true } } }) => ({
  id: 'greeting',
  name: 'Greeting',
  connection: 'greeting-db',
  resources: { task: {} },
  ...(auth ? { auth } : {}),
  views: {
    today: {
      kind: 'dashboard',
      label: 'Today',
      heading: `Hello, ${READER_NAME}`,
      description: `Here is your day, ${READER_NAME}.`,
      sections: [
        { kind: 'metric', title: 'Open', from: 'task', icon: 'list-checks' },
        { kind: 'chart', title: 'By status', from: 'task', by: 'status', shape: 'bar', icon: 'chart-bar' },
        { kind: 'rows', title: 'Latest', from: 'task', icon: 'clock' },
      ],
    },
    tasks: { kind: 'list', from: 'task' },
  },
  home: 'today',
  nav: ['today', 'tasks'],
  ...extra,
});

describe('the words', () => {
  test('{me.name} is the one reader placeholder, and only where somebody signs in', () => {
    assert.doesNotThrow(() => checkGreeting('Hello, {me.name}', 'here', true));
    assert.throws(
      () => checkGreeting('Hello, {me.email}', 'here', true),
      /names "\{me\.email\}"\. The one reader placeholder is \{me\.name\}/,
    );
    assert.throws(() => checkGreeting('Hello, {me.name}', 'here', false), /signs nobody in, so there is never a name to say/);
    assert.throws(
      () => parseAppConfig(manifest({}, null), 'no auth'),
      /views "today", "heading" greets \{me\.name\}, and this App signs nobody in/,
    );
    assert.throws(
      () =>
        parseAppConfig(
          manifest({
            views: {
              today: { kind: 'dashboard', label: 'Today', description: 'Hi {me.role}', sections: [{ kind: 'metric', from: 'task' }] },
            },
            home: 'today',
            nav: ['today'],
          }),
          'other',
        ),
      /names "\{me\.role\}"/,
    );
  });

  test('said to a name, or left out where there is none; an App that greets nobody is returned as it was', () => {
    const app = {
      views: {
        today: { label: 'Today', heading: 'Hello, {me.name}', description: 'Your day, {me.name}.', sections: [] },
        tasks: { table: 'task', label: 'Tasks {me.name}' },
      },
    };
    const greeted = greetReader(app, 'Ada');
    assert.deepEqual(greeted.views.today, { label: 'Today', heading: 'Hello, Ada', description: 'Your day, Ada.', sections: [] });
    // A list is not a dashboard: its words are its own.
    assert.equal(greeted.views.tasks, app.views.tasks);
    assert.deepEqual(greetReader(app, undefined).views.today, { label: 'Today', sections: [] });
    assert.equal(app.views.today.heading, 'Hello, {me.name}', 'the served App, cached per principal shape, is never written to');
    const plain = { views: { today: { label: 'Today', sections: [] } } };
    assert.equal(greetReader(plain, 'Ada'), plain);
  });

  test('a section may carry a curated mark and draw bars; an unknown mark is refused by name', () => {
    const def = parseAppConfig(manifest(), 'marks');
    const today = def.views!.today as unknown as { sections: Array<Record<string, unknown>> };
    assert.deepEqual(
      today.sections.map((section) => section.icon),
      ['list-checks', 'chart-bar', 'clock'],
    );
    assert.equal(today.sections[1]!.shape, 'bar');
    assert.throws(
      () =>
        parseAppConfig(
          manifest({
            views: { today: { kind: 'dashboard', label: 'Today', sections: [{ kind: 'metric', from: 'task', icon: 'rocket' }] } },
            home: 'today',
            nav: ['today'],
          }),
          'bad mark',
        ),
      /rocket/,
    );
    assert.throws(
      () =>
        parseAppConfig(
          manifest({
            views: {
              today: { kind: 'dashboard', label: 'Today', sections: [{ kind: 'chart', from: 'task', by: 'status', shape: 'pie' }] },
            },
            home: 'today',
            nav: ['today'],
          }),
          'pie',
        ),
      /"shape" of "pie"\. Use "line", "bar", "donut", "stacked", "scatter", "heatmap", "waterfall" or "treemap"/,
    );
  });
});

type Call = (path: string) => Promise<{ status: number; body: Record<string, any> }>;
async function serve(def: AppDef, who: () => { name?: string } | null, run: (call: Call) => Promise<void>) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-greeting-'));
  const file = join(directory, 'greeting.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE task (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT); INSERT INTO task VALUES (1, 'First', 'open');`);
  db.close();
  const registry = new Registry();
  registry.add({ id: 'greeting-db', name: 'greeting-db', url: file, source: 'config', writable: false });
  const host: AppHost = {
    app: { app: def, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: def.auth!,
      store: 'not-used',
      close() {},
      handler: async () => {},
      session: async () => {
        const person = who();
        return person && { id: 'person-1', who: 'ada@example.test', role: 'staff', ...person };
      },
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host] });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run(async (path) => {
      const response = await fetch(`http://${bound.host}:${bound.port}${path}`, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: JSON.parse(await response.text()) };
    });
  } finally {
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('served', () => {
  test('/api/app says the greeting to the verified session’s name, and leaves it out for an account with none', async () => {
    let person: { name?: string } | null = { name: 'Ada Lovelace' };
    await serve(
      parseAppConfig(manifest(), 'served'),
      () => person,
      async (call) => {
        const named = await call('/api/app');
        assert.equal(named.status, 200);
        assert.equal(named.body.app.views.today.heading, 'Hello, Ada Lovelace');
        assert.equal(named.body.app.views.today.description, 'Here is your day, Ada Lovelace.');
        // The marks' glyphs ride with the App, as a menu's do.
        for (const icon of ['list-checks', 'chart-bar', 'clock']) assert.ok(named.body.app.icons?.[icon], icon);
        person = {};
        const nameless = await call('/api/app');
        assert.equal(nameless.body.app.views.today.heading, undefined);
        assert.equal(nameless.body.app.views.today.description, undefined);
        assert.equal(nameless.body.app.views.today.label, 'Today');
        assert.ok(!JSON.stringify(nameless.body).includes(READER_NAME));
      },
    );
  });
});
