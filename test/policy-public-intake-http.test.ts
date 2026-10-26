import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { literal, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseTestApp } from './support/commandCatalog.js';

async function fixture(t: TestContext, enrolled = true) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-intake-http-'));
  const file = join(directory, 'data.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE inbox(id INTEGER PRIMARY KEY, name TEXT NOT NULL, desk INTEGER NOT NULL DEFAULT 1)');
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'data', name: 'Data', url: file, source: 'config', writable: true });
  const input = { name: { label: 'Name', type: 'text' } } as const;
  const form = { kind: 'form', public: true, label: 'Contact', command: { id: 'contact', version: 1, input } };
  const app = parseTestApp(
    {
      id: 'intake',
      name: 'Intake',
      sources: { main: { connection: 'data' } },
      auth: { rows: 'policy', roles: { staff: { read: true } } },
      resources: { inbox: { access: 'write' } },
      views: { inbox: { kind: 'list', from: 'inbox' }, contact: form, unavailable: form },
      home: 'inbox',
      nav: ['inbox'],
    },
    'HTTP policy intake fixture',
  );
  const state = { identity: null as Identity | null, calls: 0, actors: [] as string[], verifierCalls: 0 };
  const commands = defineCommands({
    contact: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'inbox',
      public: true,
      input,
      output: shape({ reference: text(), message: literal('Received.') }),
      async handle(context, value) {
        state.calls++;
        state.actors.push(context.actor.id);
        await context.tx.insert({ table: 'inbox', values: { name: value.name } });
        return { reference: `CONTACT-${state.calls}`, message: 'Received.' };
      },
    }),
  });
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close: async () => {},
      session: async () => state.identity,
      handler: async (_req, res) => {
        res.writeHead(204);
        res.end();
      },
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `export default {
    appId: 'intake', resolveRows() { throw new Error('Public intake must not resolve account rows'); }, resultReferences: {},
    ${enrolled ? "publicForms: { contact: { rows: { inbox: { groups: [[{ column: 'desk', op: '=', value: 1 }]] } }, resultReferences: () => [] } }" : ''}
  };`,
  );
  const policy = await loadHttpAppPolicy({
    app,
    registry,
    file: policyFile,
    commands,
    verifySession: async () => {
      state.verifierCalls++;
      return state.identity;
    },
  });
  const opened = await registry.open('data');
  opened.adapter.transaction = async () => {
    throw new Error('Unscoped writer must not run');
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], policy, pages: [] });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy.retire();
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = (body: unknown, form = 'contact') =>
    fetch(`${base}/api/forms/${form}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
  return { state, post, base, policy, app, db };
}

test('enrolled policy public forms execute anonymously and signed in with identical public receipts', async (t) => {
  const f = await fixture(t);
  const body = { input: { name: 'Visitor' }, submission: 'public-submission-0001' };
  const response = await f.post(body);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const first = await response.json();
  assert.deepEqual(Object.keys(first).sort(), ['receipt', 'reference']);
  assert.equal(first.reference, 'CONTACT-1');
  f.state.identity = { id: 'staff-identity', who: 'staff@example.test', role: 'staff' };
  const replay = await f.post(body);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), first);
  const second = await f.post({ ...body, submission: 'public-submission-0002' });
  assert.equal(second.status, 200);
  assert.deepEqual(f.state.actors, ['public:contact', 'public:contact']);
  assert.equal(f.state.verifierCalls, 0);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM inbox').get()!.n, 2);
  const conflict = await f.post({ ...body, input: { name: 'Changed' } });
  assert.equal(conflict.status, 409);
  const denied = await f.post(body, 'unavailable');
  assert.equal(denied.status, 503);
  assert.doesNotMatch(await denied.text(), /desk|staff-identity/);
});

test('policy forms without enrollment are closed to submissions; presentation remains readable', async (t) => {
  const f = await fixture(t, false);
  assert.equal((await fetch(`${f.base}/api/forms/contact`)).status, 200);
  // Without enrollment the form takes no submission for good: forbidden, not a 503 a visitor would retry.
  const closed = await f.post({ input: { name: 'Visitor' }, submission: 'public-submission-0001' });
  assert.equal(closed.status, 403);
  assert.equal(((await closed.json()) as { code: string }).code, 'forbidden');
  assert.equal(f.state.calls, 0);
});

test('public intake refuses forged envelopes, changed App definitions and retired deployments', async (t) => {
  const f = await fixture(t);
  const body = { input: { name: 'Visitor' }, submission: 'public-submission-0001' };
  assert.equal((await f.post({ ...body, actor: 'staff' })).status, 400);
  f.app.name = 'Changed since deployment';
  assert.equal((await f.post(body)).status, 503);
  f.app.name = 'Intake';
  await f.policy.retire();
  assert.equal((await f.post(body)).status, 503);
  assert.equal(f.state.calls, 0);
});
