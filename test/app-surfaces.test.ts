/**
 * Headless mode over HTTP: a front end the App does not draw names its surface in `X-Mistri-Surface`
 * (surfaces/<key>.surface.ts, `defineSurface`) and is held to it — a read or a command the surface does not name is
 * refused 403 `{ code: 'surface' }`, a headless App refuses a request that names no surface at all, and inside the
 * surface the reader's own grants still decide. A headless App's own screens answer 404; its sign-in still opens.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { HEADLESS_SCREEN, headlessHeld, headlessScreen, SurfaceRefused } from '../packages/mistri/src/server/http/surfaceGate.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { SURFACE_HEADER } from '../packages/mistri/src/shared/appSurfaces.js';
import { createApp } from './support/createApp.js';
import { namedCommands } from './support/commandCatalog.js';

const manager: Identity = { id: 'account-m', who: 'manager@example.test', role: 'manager' };
const viewer: Identity = { id: 'account-v', who: 'viewer@example.test', role: 'viewer' };
const assignInput = { reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' } } as const;

const APP = {
  id: 'loans',
  name: 'Loans',
  track: 'receipts',
  sources: { lending: { connection: 'loans-db' } },
  resources: {
    loan: {
      access: 'write',
      actions: {
        assign: { label: 'Assign', command: { id: 'assign', version: 1, target: 'loan', input: assignInput } },
        release: { label: 'Release', command: { id: 'release', version: 1, target: 'loan', input: {} } },
      },
    },
    reviewer: {},
    hidden: {},
  },
  auth: {
    roles: {
      manager: { read: true, commands: ['assign', 'release'] },
      viewer: { read: ['loan', 'reviewer'] },
    },
  },
  views: { loan: { kind: 'list', from: 'loan' } },
  home: 'loan',
  nav: ['loan'],
  ui: { headless: true },
};

/* The surface the front end is in: it lists loans and assigns a reviewer; it neither reads `hidden` nor releases. */
const DESK = { key: 'desk', at: 'surfaces/desk.surface.ts', fields: { label: 'Desk', reads: ['loan', 'reviewer'], commands: ['assign'] } };

/* A second App on the same server, drawn by its own screens: a request to it is not a surface's. */
const NOTES = {
  id: 'notes',
  name: 'Notes',
  sources: { main: { connection: 'notes-db' } },
  resources: { note: {} },
  views: { note: { kind: 'list', from: 'note' } },
  home: 'note',
  nav: ['note'],
};

async function serve(t: TestContext, options: { second?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-surfaces-'));
  const file = join(directory, 'loans.db');
  const seed = new DatabaseSync(file);
  seed.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, reviewer INTEGER);
    CREATE TABLE reviewer(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE hidden(id INTEGER PRIMARY KEY, name TEXT);
    INSERT INTO loan VALUES (1,0,NULL), (2,0,NULL); INSERT INTO reviewer VALUES (1,'Ada'); INSERT INTO hidden VALUES (1,'secret');`);
  seed.close();
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'loans-db', name: 'Loans', url: file, writable: true, source: 'config' });
  const hosts: AppHost[] = [];
  if (options.second) {
    const notesFile = join(directory, 'notes.db');
    const notesSeed = new DatabaseSync(notesFile);
    notesSeed.exec(`CREATE TABLE note(id INTEGER PRIMARY KEY, body TEXT); INSERT INTO note VALUES (1,'hello');`);
    notesSeed.close();
    registry.add({ id: 'notes-db', name: 'Notes', url: notesFile, source: 'config' });
    const notes = parseAppConfig(NOTES, 'notes fixture');
    hosts.push({ app: { app: notes, path: join(directory, 'notes.ts'), pages: [], sources: {} }, pages: [] });
  }
  /* A server of several Apps signs nobody in (an authenticated App has its own server), so there every reader is signed out. */
  const { auth: _auth, ...unsigned } = APP;
  const { app: raw, commands: catalog } = namedCommands(options.second ? unsigned : APP);
  // Without sign-in nothing runs a command, so there the desk only reads.
  const desk = options.second ? { ...DESK, fields: { ...DESK.fields, commands: [] } } : DESK;
  const app = parseAppConfig(raw, 'surfaces fixture', { commands: catalog, surfaces: [desk] });
  const control = { current: manager as Identity | null, calls: 0 };
  const handle = async ({ db, record }: { db: any; record: any }, input: { reviewer?: number }) => {
    control.calls++;
    const { version } = await db.loan.update(record, { reviewer: input.reviewer ?? null });
    return { version: Number(version) };
  };
  const output = { parse: (value: unknown) => ({ version: (value as { version: number }).version }) };
  const commands = defineCommands({
    assign: defineCommand({
      source: 'lending',
      target: 'loan',
      read: ['reviewer'],
      input: assignInput,
      validate: (input): { reviewer: number } => ({ reviewer: input.reviewer as number }),
      output,
      handle,
    }),
    release: defineCommand({ source: 'lending', target: 'loan', input: {}, validate: () => ({}), output, handle }),
  });
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    ...(options.second
      ? {}
      : {
          auth: {
            spec: app.auth!,
            store: join(directory, 'sessions.db'),
            close() {},
            handler: async () => {},
            session: async () => control.current,
          },
        }),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host, ...hosts], commands: { appId: 'loans', registry: commands } });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  t.after(async () => {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  const base = `http://${bound.host}:${bound.port}`;
  const headers = (surface: string | null) => ({
    'content-type': 'application/json',
    'x-mistri-account': control.current?.id ?? '',
    ...(surface === null ? {} : { [SURFACE_HEADER]: surface }),
  });
  type Reply = { status: number; body: { data?: unknown; rows?: unknown[]; code?: string; error?: string; [key: string]: unknown } };
  const reply = async (response: Response): Promise<Reply> => ({ status: response.status, body: await response.json() });
  /* A read of `table` in `app`, named in the body and — unless `addressed` is false — in the address too. */
  const read = async (table: string, surface: string | null = 'desk', { app = 'loans', addressed = true } = {}) =>
    reply(
      await fetch(`${base}/api/view/run${addressed ? `?app=${app}` : ''}`, {
        method: 'POST',
        headers: headers(surface),
        body: JSON.stringify({ app, view: { base: table }, count: 'none' }),
        signal: AbortSignal.timeout(5000),
      }),
    );
  let runs = 0;
  const commandBody = (command: string, idempotencyKey: string) => ({
    command,
    commandVersion: 1,
    key: { id: 1 },
    expectedVersion: 0,
    idempotencyKey,
    input: command === 'assign' ? { reviewer: 1 } : {},
  });
  const command = async (path: string, body: Record<string, unknown>, surface: string | null) =>
    reply(
      await fetch(`${base}${path}`, {
        method: 'POST',
        headers: headers(surface),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      }),
    );
  const run = async (
    name: string,
    surface: string | null = 'desk',
    idempotencyKey = `surface-request-${String(++runs).padStart(4, '0')}`,
  ) => command('/api/commands/execute', commandBody(name, idempotencyKey), surface);
  const status = async (name: string, idempotencyKey: string, surface: string | null = 'desk') =>
    command('/api/commands/status', commandBody(name, idempotencyKey), surface);
  const whoami = async () => reply(await fetch(`${base}/api/whoami`, { headers: headers(null), signal: AbortSignal.timeout(5000) }));
  const page = async (path: string) => {
    const response = await fetch(`${base}${path}`, { headers: { 'x-mistri-account': manager.id }, signal: AbortSignal.timeout(5000) });
    return { status: response.status, text: await response.text() };
  };
  return { base, headers, reply, control, read, run, status, whoami, page };
}

test('a read the surface names is answered; one it does not name is refused, and so is a request naming no surface', async (t) => {
  const { read } = await serve(t);
  const allowed = await read('loan');
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.equal((allowed.body.rows as unknown[]).length, 2);

  const outside = await read('hidden');
  assert.equal(outside.status, 403, JSON.stringify(outside.body));
  assert.equal(outside.body.code, 'surface');
  assert.match(String(outside.body.error), /"hidden" is not one of them/);
  assert.doesNotMatch(JSON.stringify(outside.body), /secret/);

  // A headless App serves its API to nothing but a surface: a request with no header is refused before it is read.
  const bare = await read('loan', null);
  assert.equal(bare.status, 403, JSON.stringify(bare.body));
  assert.equal(bare.body.code, 'surface');
  assert.match(String(bare.body.error), /served headless/);

  // A surface the App does not have is no surface at all.
  const unknown = await read('loan', 'elsewhere');
  assert.equal(unknown.status, 403);
  assert.equal(unknown.body.code, 'surface');
});

test('a command the surface runs goes through; one it does not run is refused before its handler', async (t) => {
  const { run, control } = await serve(t);
  const outside = await run('release');
  assert.equal(outside.status, 403, JSON.stringify(outside.body));
  assert.equal(outside.body.code, 'surface');
  assert.equal(control.calls, 0);

  const allowed = await run('assign');
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  assert.deepEqual(allowed.body.result, { version: 1 });
  assert.equal(control.calls, 1);
});

test("inside the surface the reader's own grants still decide: a person without the command's grant is refused", async (t) => {
  const { run, read, control } = await serve(t);
  control.current = viewer;
  // The surface is offered to the viewer — they read everything it reads — and its reads answer them.
  assert.equal((await read('loan')).status, 200);
  const refused = await run('assign');
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.notEqual(refused.body.code, 'surface', 'refused by the grant, not by the surface');
  assert.equal(control.calls, 0);
});

test("a headless App's own screens answer 404; its sign-in and an OAuth consent still open", async (t) => {
  const { page } = await serve(t);
  for (const path of ['/', '/loan', '/loan/1']) {
    const screen = await page(path);
    assert.equal(screen.status, 404, path);
    assert.equal(JSON.parse(screen.text).error, HEADLESS_SCREEN);
  }
  const at = (path: string, search = '') => ({
    path,
    url: new URL(`http://localhost${path}${search}`),
    appHosts: [{ app: { app: { id: 'loans', ui: { headless: true } } } }] as never,
  });
  assert.equal(headlessScreen(at('/loans')), true);
  assert.equal(headlessScreen(at('/loans/loan/1')), true);
  assert.equal(headlessScreen(at('/loans/sign-in')), false);
  assert.equal(headlessScreen(at('/loans', '?authorize=abc')), false);
  assert.equal(headlessScreen(at('/other')), false);
});

test('on a server of several Apps, a request to the headless one that names no surface is refused however it names the App', async (t) => {
  const { read, control } = await serve(t, { second: true });
  control.current = null;
  // Nobody is signed in: the headless App's list is read through its surface …
  const allowed = await read('loan');
  assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  // … and with no surface it is refused, whether the App is named in the address or only in the body.
  for (const addressed of [true, false]) {
    const bare = await read('loan', null, { addressed });
    assert.equal(bare.status, 403, `addressed: ${addressed} ${JSON.stringify(bare.body)}`);
    assert.equal(bare.body.code, 'surface');
    assert.match(String(bare.body.error), /served headless/);
  }
  // A surface needs an App to be judged by: naming one with no App in the address is refused.
  const unaddressed = await read('loan', 'desk', { addressed: false });
  assert.equal(unaddressed.status, 403, JSON.stringify(unaddressed.body));
  assert.equal(unaddressed.body.code, 'surface');
  // The other App, drawn by its own screens, is not a surface's and is not held to one.
  const notes = await read('note', null, { app: 'notes' });
  assert.equal(notes.status, 200, JSON.stringify(notes.body));
});

test('who is signed in, and signing in and out, are open to a headless front end with or without a surface', async (t) => {
  const { whoami } = await serve(t);
  const me = await whoami();
  assert.equal(me.status, 200, JSON.stringify(me.body));
  const at = (path: string) => ({ path, req: { headers: {} } as never });
  const app = { name: 'Loans', ui: { headless: true } } as never;
  assert.doesNotThrow(() => headlessHeld(at('/api/auth/embed/sign-out'), app));
  assert.doesNotThrow(() => headlessHeld(at('/api/whoami'), app));
  assert.throws(() => headlessHeld(at('/api/view/run'), app), SurfaceRefused);
});

test("a status call is the command it names: another command's status is refused by the surface, and its receipt answers only its own", async (t) => {
  const { run, status } = await serve(t);
  const ran = await run('assign', 'desk', 'surface-status-0001');
  assert.equal(ran.status, 200, JSON.stringify(ran.body));
  // The receipt is asked for as the command the surface runs: it answers with that command's result.
  const own = await status('assign', 'surface-status-0001');
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.deepEqual(own.body.result, { version: 1 });
  // The same key asked as a command the surface does not run is refused before any receipt is read.
  const other = await status('release', 'surface-status-0001');
  assert.equal(other.status, 403, JSON.stringify(other.body));
  assert.equal(other.body.code, 'surface');
});

test('on a server of several Apps, a command or a file of the headless App is held to a surface however `?app=` names another App', async (t) => {
  const { base, headers, reply, control } = await serve(t, { second: true });
  control.current = null;
  // The command catalog is the headless App's: naming the other App in the address does not let a bare request past.
  const execute = await reply(
    await fetch(`${base}/api/commands/execute?app=notes`, {
      method: 'POST',
      headers: headers(null),
      body: JSON.stringify({
        command: 'assign',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        idempotencyKey: 'surface-other-0001',
        input: { reviewer: 1 },
      }),
      signal: AbortSignal.timeout(5000),
    }),
  );
  assert.equal(execute.status, 403, JSON.stringify(execute.body));
  assert.equal(execute.body.code, 'surface');
  // A file is read from the App the address names: the headless App's table is not the other App's to answer.
  const file = await reply(
    await fetch(`${base}/api/file?app=notes&table=loan&id=1&column=reviewer`, {
      headers: headers(null),
      signal: AbortSignal.timeout(5000),
    }),
  );
  assert.equal(file.status, 403, JSON.stringify(file.body));
});
