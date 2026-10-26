/**
 * A table a command writes, edited in place by the roles granted that; a
 * column a role never reads, withheld from it while its commands still run;
 * and a role that edits and never creates. The leads desk of the Keystone
 * suite met all three: a salesperson logs a contact (a command that moves the
 * lead's status) and edits the lead's phone, never sees the applicant's SSN,
 * and works leads someone else brought in.
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
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { parseTestApp } from './support/commandCatalog.js';

const appId = 'desk';

async function serve(
  run: (
    call: (path: string, body?: Record<string, unknown>) => Promise<{ status: number; body: any }>,
    db: DatabaseSync,
    seen: { handler: unknown[]; initial: unknown[]; availability: unknown[] },
  ) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-and-edit-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE lead (id INTEGER PRIMARY KEY, name TEXT NOT NULL, phone TEXT, ssn TEXT,
      status TEXT NOT NULL DEFAULT 'new', contacted_at TEXT, version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE note (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id), body TEXT NOT NULL);
    CREATE TABLE activity (id INTEGER PRIMARY KEY, lead_id INTEGER NOT NULL REFERENCES lead(id), body TEXT NOT NULL);
    INSERT INTO lead (id, name, phone, ssn) VALUES (1, 'Ada', '555-0100', '123-45-6789');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, writable: true, source: 'config' });
  const logInput = { note: { label: 'Note', type: 'text', optional: true } } as const;
  const app = parseTestApp(
    {
      id: appId,
      name: 'Desk',
      sources: { desk: { connection: 'desk-db', default: true } },
      resources: {
        lead: {
          access: 'write',
          // Only the command moves these; a role edits the rest of the lead in place.
          fields: { read: ['id', 'name', 'phone', 'ssn', 'status', 'contacted_at', 'version'], write: ['name', 'phone'] },
          actions: { logContact: { label: 'Log contact', command: { id: 'log-contact', version: 1, target: 'lead', input: logInput } } },
        },
        note: { access: 'write' },
        activity: { access: 'write' },
      },
      auth: {
        roles: {
          // Edits leads, never makes one, and never reads the SSN.
          sales: {
            read: true,
            write: ['lead', 'note'],
            create: ['note'],
            commands: ['log-contact'],
            fields: { lead: { read: ['id', 'name', 'phone', 'status', 'contacted_at', 'version'], write: ['name', 'phone'] } },
          },
        },
      },
      views: { leads: { kind: 'list', from: 'lead' } },
      home: 'leads',
      nav: ['leads'],
    },
    'command and edit fixture',
  );
  const seen = { handler: [] as unknown[], initial: [] as unknown[], availability: [] as unknown[] };
  const commands = defineCommands({
    'log-contact': defineCommand({
      source: 'desk',
      target: 'lead',
      write: ['activity'],
      input: logInput,
      output: { parse: (value: unknown) => value as { message: string } },
      initial({ record }) {
        seen.initial.push(record.ssn);
        return { note: `Called ${String(record.name)}` };
      },
      availability({ records }) {
        seen.availability.push(...records.map((record) => record.ssn));
        return records.map((record) => record.status !== 'closed');
      },
      async handle({ db: tables, record }, input) {
        // The handler is the App's own server code: it reads the row whole.
        seen.handler.push(record.ssn);
        await tables.lead.update(record, { status: 'contacted', contacted_at: '2026-09-26T12:00:00Z' });
        if (input.note) await tables.activity.insert({ lead_id: record.id, body: input.note });
        return { message: 'Logged.' };
      },
    }),
  });
  const who: Identity = { id: 'account-sam', who: 'sam@example.test', role: 'sales' };
  const host: AppHost = {
    app: { app, path: join(directory, 'app.ts'), pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close() {},
      handler: async () => {},
      session: async () => who,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId, registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const base = `http://${bound.host}:${address.port}`;
    await run(
      async (path, body) => {
        const commandPath = path.startsWith('/api/commands/');
        const response = await fetch(`${base}${path}${body ? '' : `?app=${appId}`}`, {
          signal: AbortSignal.timeout(5_000),
          ...(body
            ? {
                method: 'POST',
                headers: { 'content-type': 'application/json', origin: base, 'x-mistri-account': who.id },
                body: JSON.stringify(commandPath ? body : { app: appId, ...body }),
              }
            : {}),
        });
        const text = await response.text();
        return { status: response.status, body: JSON.parse(text) };
      },
      db,
      seen,
    );
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test('a role edits a command-written table in place, never the columns the command owns', { timeout: 20_000 }, async () => {
  await serve(async (call, db) => {
    const schema = await call('/api/schema');
    assert.equal(schema.status, 200, JSON.stringify(schema.body));
    const lead = schema.body.tables.find((table: { id: string }) => table.id === 'lead');
    const writable = Object.fromEntries(lead.columns.map((column: { name: string; writable?: boolean }) => [column.name, column.writable]));
    assert.deepEqual(writable, { id: false, name: true, phone: true, status: false, contacted_at: false, version: false });

    const phone = await call('/api/update', { table: 'lead', key: { id: 1 }, values: { phone: '555-0199' } });
    assert.equal(phone.status, 200, JSON.stringify(phone.body));
    for (const values of [{ status: 'closed' }, { version: 7 }, { contacted_at: '2020-01-01' }, { ssn: '000-00-0000' }]) {
      const refused = await call('/api/update', { table: 'lead', key: { id: 1 }, values });
      assert.equal(refused.status, 403, `${JSON.stringify(values)}: ${JSON.stringify(refused.body)}`);
    }
    assert.deepEqual(
      { ...db.prepare('SELECT phone, status, version, ssn FROM lead WHERE id = 1').get() },
      { phone: '555-0199', status: 'new', version: 0, ssn: '123-45-6789' },
    );

    const logged = await call('/api/commands/execute', {
      command: 'log-contact',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'log-contact-000001',
      input: {},
    });
    assert.equal(logged.status, 200, JSON.stringify(logged.body));
    assert.deepEqual(
      { ...db.prepare('SELECT phone, status, version FROM lead WHERE id = 1').get() },
      { phone: '555-0199', status: 'contacted', version: 1 },
    );
  });
});

test(
  'a column a role never reads stays out of its reads, its prefill and its buttons, while its command reads the row whole',
  { timeout: 20_000 },
  async () => {
    await serve(async (call, _db, seen) => {
      const prepared = await call('/api/commands/prepare', { command: 'log-contact', commandVersion: 1, key: { id: 1 } });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      assert.deepEqual(prepared.body, { expectedVersion: 0, initial: { note: 'Called Ada' } });
      const available = await call('/api/commands/availability', {
        checks: [{ command: 'log-contact', commandVersion: 1, keys: [{ id: 1 }] }],
      });
      assert.equal(available.status, 200, JSON.stringify(available.body));
      assert.deepEqual(available.body.checks[0].available, [true]);
      const executed = await call('/api/commands/execute', {
        command: 'log-contact',
        commandVersion: 1,
        key: { id: 1 },
        expectedVersion: 0,
        idempotencyKey: 'log-contact-000002',
        input: { note: 'Left a message' },
      });
      assert.equal(executed.status, 200, JSON.stringify(executed.body));
      // What reaches the person is narrowed; the handler is not.
      assert.deepEqual(seen.initial, [undefined]);
      assert.ok(
        seen.availability.length >= 2 && seen.availability.every((value) => value === undefined),
        JSON.stringify(seen.availability),
      );
      assert.deepEqual(seen.handler, ['123-45-6789']);
      assert.doesNotMatch(JSON.stringify(executed.body), /123-45/);
      const listed = await call('/api/run', { q: 'lead', exactCount: true });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.doesNotMatch(JSON.stringify(listed.body), /123-45/);
      const probed = await call('/api/run', { q: 'lead ssn = "123-45-6789"' });
      assert.ok(probed.status >= 400 || probed.body.errors?.length, JSON.stringify(probed.body));
    });
  },
);

test(
  'a role that edits and never creates is offered no New, and its insert is refused where it does not create',
  { timeout: 20_000 },
  async () => {
    await serve(async (call, db) => {
      const schema = await call('/api/schema');
      const tables = Object.fromEntries(
        schema.body.tables.map((table: { id: string; insertable?: boolean }) => [table.id, table.insertable]),
      );
      assert.equal(tables.lead, false);
      assert.notEqual(tables.note, false);
      const lead = await call('/api/insert', { table: 'lead', values: { name: 'Grace' } });
      assert.equal(lead.status, 403, JSON.stringify(lead.body));
      const note = await call('/api/insert', { table: 'note', values: { lead_id: 1, body: 'Asked for a callback' } });
      assert.equal(note.status, 200, JSON.stringify(note.body));
      assert.equal(db.prepare('SELECT count(*) AS n FROM lead').get()!.n, 1);
    });
  },
);
