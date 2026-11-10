/**
 * A targeted command that only a free-form page runs: the page's `commands` declaration is the offer, so `check`
 * does not warn that preparing it is refused, and the role it is granted to prepares and runs it with no action
 * beside it. The grants are the same: a role the command is not granted to is still refused.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { unofferedCommandWarnings } from '../packages/mistri/src/server/app/appCommandOfferChecks.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { unformedCommands } from '../packages/mistri/src/server/commands/commandContracts.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'desk';
const component = (key: string) => ({ id: `page-${key}`, module: `./pages/${key}.page.tsx`, kind: 'page' });

test('a command only a page runs is offered by the page; an ungranted role is still refused', { timeout: 20_000 }, async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-page-only-command-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'new', version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO lead (id, name) VALUES (1, 'Ada');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: appId,
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      // No action names the command: the page below is its only surface.
      resources: { lead: { access: 'write' } },
      auth: { roles: { sales: { read: true, commands: ['reschedule'] }, reader: { read: true } } },
      views: {
        leads: { kind: 'list', from: 'lead' },
        board: { kind: 'page', label: 'Board', component: component('board'), reads: ['lead'], commands: ['reschedule'] },
      },
      home: 'leads',
      nav: ['leads', 'board'],
    },
    'page-only command fixture',
    { reschedule: { target: 'lead' } },
  );
  const commands = defineCommands({
    reschedule: defineCommand({
      source: 'desk',
      target: 'lead',
      input: {},
      output: { parse: (value: unknown) => value as { message: string } },
      async handle({ db: tables, record }) {
        await tables.lead.update(record, { status: 'moved' });
        return { message: 'Moved.' };
      },
    }),
  });
  assert.deepEqual(unofferedCommandWarnings(app, commands), []);
  const who: { current: Identity } = { current: { id: 'account-sam', who: 'sam@example.test', role: 'sales' } };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: { spec: app.auth!, store: join(directory, 'auth.db'), close() {}, handler: async () => {}, session: async () => who.current },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://${bound.host}:${address.port}`;
    const call = async (path: string, body: Record<string, unknown>) => {
      const response = await fetch(`${base}${path}`, {
        signal: AbortSignal.timeout(5_000),
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: base, 'x-mistri-account': who.current.id },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: JSON.parse(await response.text()) };
    };
    const request = { command: 'reschedule', commandVersion: 1, key: { id: 1 } };
    const prepared = await call('/api/commands/prepare', request);
    assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
    const ran = await call('/api/commands/execute', {
      ...request,
      expectedVersion: prepared.body.expectedVersion,
      idempotencyKey: 'reschedule-000001',
      input: {},
    });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(db.prepare('SELECT status FROM lead WHERE id = 1').get()!.status, 'moved');
    // The page is not a grant: a role the command is not granted to is refused at both doors.
    who.current = { id: 'account-rae', who: 'rae@example.test', role: 'reader' };
    assert.equal((await call('/api/commands/prepare', request)).status, 403);
    const refused = await call('/api/commands/execute', { ...request, expectedVersion: 1, idempotencyKey: 'reschedule-000002', input: {} });
    assert.equal(refused.status, 403, JSON.stringify(refused.body));
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a command nothing offers, page or action, is still warned of', () => {
  const app = parseTestApp(
    {
      id: appId,
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: { lead: { access: 'write' } },
      auth: { roles: { sales: { read: true, commands: ['reschedule'] } } },
      views: { leads: { kind: 'list', from: 'lead' } },
      home: 'leads',
      nav: ['leads'],
    },
    'unoffered fixture',
    { reschedule: { target: 'lead' } },
  );
  const registry = { reschedule: { target: 'lead', source: 'desk' } } as unknown as Parameters<typeof unofferedCommandWarnings>[1];
  assert.match(unofferedCommandWarnings(app, registry)[0] ?? '', /command-unoffered/);
});

test("a command's label is what its served form and its hidden page action are called", () => {
  const registry = defineCommands({
    book: defineCommand({
      source: 'desk',
      target: 'lead',
      targets: 'none',
      label: 'Book an appointment',
      input: {},
      output: { parse: (value: unknown) => value as { message: string } },
      async handle() {
        return { message: 'Booked.' };
      },
    }),
    plain: defineCommand({
      source: 'desk',
      target: 'lead',
      targets: 'none',
      input: {},
      output: { parse: (value: unknown) => value as { message: string } },
      async handle() {
        return { message: 'Done.' };
      },
    }),
  });
  const served = unformedCommands({ views: {} }, registry, () => true);
  assert.equal(served.book?.label, 'Book an appointment');
  // Left out, there is no label: the client says the name as words, as it always did.
  assert.equal(served.plain?.label, undefined);
  assert.throws(
    () => defineCommand({ source: 'desk', target: 'lead', input: {}, label: '', async handle() {} } as never),
    /Command label is text/,
  );
});

test('a page-declared targeted command is offered by a hidden action named for its label', () => {
  const app = parseTestApp(
    {
      id: appId,
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: { lead: { access: 'write' } },
      auth: { roles: { sales: { read: true, commands: ['reschedule'] } } },
      views: {
        leads: { kind: 'list', from: 'lead' },
        board: { kind: 'page', label: 'Board', component: component('board'), reads: ['lead'], commands: ['reschedule'] },
      },
      home: 'leads',
      nav: ['leads', 'board'],
    },
    'hidden action fixture',
    { reschedule: { target: 'lead' } },
  );
  const [action] = app.resources!.lead!.actions!;
  assert.equal(action?.id, 'reschedule');
  assert.equal(action?.label, 'Reschedule');
  assert.equal((action as { header?: boolean }).header, false);
});
