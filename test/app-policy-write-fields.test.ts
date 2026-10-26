import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { Refusal } from '../packages/engine/src/adapters/adapter.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { createAppPolicyContext, type AppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { defineCommand } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const owner = 'private-write-fields-owner';

async function fixture(t: TestContext, writable = true) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-policy-write-fields-'));
  const path = join(directory, 'records.db');
  const db = new DatabaseSync(path);
  const registry = new Registry();
  t.after(async () => {
    try {
      await registry.closeAll();
    } finally {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
  db.exec(`
    CREATE TABLE physical_note (id INTEGER PRIMARY KEY, title TEXT, body TEXT, secret TEXT);
    CREATE TABLE physical_loan (id INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    CREATE TABLE physical_hidden (id INTEGER PRIMARY KEY, secret TEXT);
    INSERT INTO physical_note VALUES (1, 'Title', 'Body', 'Private');
    INSERT INTO physical_loan VALUES (1, 0);
    CREATE VIEW physical_summary AS SELECT id, title FROM physical_note;
  `);
  await migrateSqliteCommandJournal(path);
  registry.add({ id: owner, name: 'Write fields fixture', url: path, writable, source: 'config' });
  const app = parseAppConfig(
    {
      id: 'write-fields',
      name: 'Write fields',
      sources: { operations: { connection: owner } },
      resources: {
        note: { physical: 'physical_note', access: 'write', fields: { read: ['id', 'title', 'body'], write: ['title', 'body'] } },
        loan: { physical: 'physical_loan', access: 'write' },
        hidden: { physical: 'physical_hidden', access: 'write' },
        summary: { physical: 'physical_summary', access: 'write' },
      },
      auth: {
        roles: {
          narrow: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'title'], write: ['title'] } } },
          body: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'body'], write: ['body'] } } },
          reader: { read: ['note', 'loan'] },
          empty: { read: ['note'], write: ['note'], fields: { note: { read: ['id', 'title'], write: [] } } },
          inactive: { read: ['hidden'], write: ['hidden'] },
          commandonly: { read: ['loan'], commands: ['advance'] },
          view: { read: ['summary'], write: ['summary'] },
        },
      },
      views: { notes: { kind: 'list', from: 'note' } },
      home: 'notes',
    },
    'write fields fixture',
  );
  const resources = await loadAppRuntimeResources(registry, app, owner);
  const command = defineCommand({
    source: 'operations',
    target: 'loan',
    read: ['loan'],
    write: ['loan'],
    input: {},
    output: { parse: () => ({ advanced: true }) },
    async handle({ db, record }) {
      await db.loan.update(record, { version: Number(record.version) + 1 });
      return { advanced: true };
    },
  });
  const issue = (commands = false) =>
    createAppPolicyContext<string>({
      app,
      resources,
      sourceConnections: new Map([['operations', owner]]),
      verifySession: async (role) => ({ id: 'verified-actor', who: 'private@example.test', role }),
      resolveRows: () => ({ note: true, loan: true, hidden: true, summary: true }),
      ...(commands
        ? { commands: { registry: { advance: command }, writableConnection: () => writable, resultReferences: { advance: () => [] } } }
        : {}),
    });
  return { app, resources, registry, issue, db };
}

test('writeFields contains only the current readable/writable column intersection', async (t) => {
  const f = await fixture(t);
  await f.issue().withContext('narrow', async (context) => {
    assert.deepEqual(context.writeFields, { note: ['title'] });
    assert.deepEqual(
      context.schema.tables[0].columns.map((column) => column.name),
      ['id', 'title'],
    );
    await context.data.update!({ table: 'note', key: { id: 1 }, values: { title: 'Changed' } });
  });
  assert.equal(f.db.prepare('SELECT title FROM physical_note').get()!.title, 'Changed');
  await assert.rejects(
    f.issue().withContext('narrow', async (context) => {
      await context.data.update!({ table: 'note', key: { id: 1 }, values: { body: 'Denied' } });
    }),
    Refusal,
  );
  assert.equal(f.db.prepare('SELECT body FROM physical_note').get()!.body, 'Body');
});

for (const role of ['reader', 'unknown', '']) {
  test(`writeFields excludes inactive grants for ${role || 'no roles'}`, async (t) => {
    const f = await fixture(t);
    await f.issue().withContext(role, async (context) => {
      assert.deepEqual(context.writeFields, {});
      assert.ok(Object.isFrozen(context.writeFields));
      for (const method of ['insert', 'update', 'remove']) assert.equal(Object.hasOwn(context.data, method), false);
    });
  });
}

test('combined verified roles union field grants within the root ceiling', async (t) => {
  const f = await fixture(t);
  await f.issue().withContext(' body, narrow, body, reader ', async (context) => {
    assert.deepEqual(context.writeFields, { note: ['title', 'body'] });
    assert.ok(!Object.hasOwn(context.writeFields, 'loan'));
    assert.ok(!Object.hasOwn(context.writeFields, 'hidden'));
  });
});

test('explicit empty field writes stay empty and views do not become generic writable resources', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  await issuer.withContext('empty', async (context) => {
    assert.deepEqual(context.writeFields, { note: [] });
    assert.ok(Object.isFrozen(context.writeFields.note));
  });
  await issuer.withContext('view', async (context) => {
    assert.deepEqual(context.writeFields, {});
  });
});

test('resources without field rules use their guarded catalog columns', async (t) => {
  const f = await fixture(t);
  await f.issue().withContext('inactive', async (context) => {
    assert.deepEqual(context.writeFields, { hidden: ['id', 'secret'] });
  });
});

test('command-only execution never adds generic writeFields or CRUD methods', async (t) => {
  const f = await fixture(t);
  await f.issue(true).withContext('commandonly', async (context) => {
    assert.deepEqual(context.writeFields, {});
    for (const method of ['insert', 'update', 'remove']) assert.equal(Object.hasOwn(context.data, method), false);
    const result = await context.commands!.execute({
      command: 'advance',
      commandVersion: 1,
      key: { id: 1 },
      expectedVersion: 0,
      idempotencyKey: 'write-fields-command',
      input: {},
    });
    assert.equal(result.status, 'applied');
    assert.deepEqual(context.writeFields, {});
  });
  assert.equal(f.db.prepare('SELECT version FROM physical_loan').get()!.version, 1);
  await f.issue(true).withContext('commandonly,narrow', async (context) => {
    assert.deepEqual(context.writeFields, { note: ['title'] });
  });
});

test('writeFields is a detached frozen snapshot across input mutation, requests and retirement', async (t) => {
  const f = await fixture(t);
  const issuer = f.issue();
  let retained!: AppPolicyContext;
  await issuer.withContext('narrow', async (context) => {
    retained = context;
    const fields: Readonly<Record<string, readonly string[]>> = context.writeFields;
    assert.ok(Object.isFrozen(fields));
    assert.ok(Object.isFrozen(fields.note));
    assert.throws(() => {
      (fields.note as string[]).push('secret');
    }, TypeError);
    assert.throws(() => {
      (fields as Record<string, readonly string[]>).note = ['secret'];
    }, TypeError);
    assert.throws(() => {
      (fields as Record<string, readonly string[]>).hidden = ['secret'];
    }, TypeError);
    assert.throws(() => {
      (context as { writeFields: unknown }).writeFields = {};
    }, TypeError);
    f.app.auth!.roles!.narrow.fields!.note.write!.push('body');
    f.app.auth!.roles!.narrow.fields!.note.read!.push('body');
    f.resources.schema.tables.find((table) => table.id === 'note')!.columns[1].name = 'changed';
    assert.deepEqual(fields, { note: ['title'] });
  });
  await issuer.withContext('narrow', async (context) => {
    assert.deepEqual(context.writeFields, { note: ['title'] });
    assert.notEqual(context.writeFields, retained.writeFields);
    assert.notEqual(context.writeFields.note, retained.writeFields.note);
  });
  await issuer.withContext('reader', async (context) => {
    assert.deepEqual(context.writeFields, {});
  });
  issuer.retire();
  assert.deepEqual(retained.writeFields, { note: ['title'] });
  await assert.rejects(retained.data.count('note'), Refusal);
});

test('sidecar exposes only logical data and preserves physical source flags and capability boundaries', async (t) => {
  const f = await fixture(t);
  const before = f.registry.list().map((connection) => ({ id: connection.id, writable: connection.writable }));
  await f.issue().withContext('narrow', async (context) => {
    assert.deepEqual(Reflect.ownKeys(context).sort(), [
      'data',
      'principal',
      'readsAt',
      'schema',
      'sources',
      'transaction',
      'trial',
      'writeFields',
    ]);
    assert.deepEqual(Reflect.ownKeys(context.data).sort(), [
      'count',
      'countBreakdown',
      'countView',
      'insert',
      'query',
      'remove',
      'runBreakdown',
      'runView',
      'update',
    ]);
    assert.deepEqual(Reflect.ownKeys(context.writeFields), ['note']);
    assert.deepEqual(JSON.parse(JSON.stringify(context.writeFields)), { note: ['title'] });
    for (const privateName of ['access', 'rows', 'resources', 'adapter', 'connectionFor', 'scopeReads', 'scopeTransaction', 'journal']) {
      assert.equal(Object.hasOwn(context, privateName), false);
      assert.equal(Object.hasOwn(context.writeFields, privateName), false);
    }
  });
  assert.deepEqual(
    f.registry.list().map((connection) => ({ id: connection.id, writable: connection.writable })),
    before,
  );
});

test('a physical read-only source stays read-only and refuses generic write grants', async (t) => {
  const f = await fixture(t, false);
  const issuer = f.issue();
  await issuer.withContext('reader', async (context) => {
    assert.deepEqual(context.writeFields, {});
  });
  await assert.rejects(
    issuer.withContext('narrow', async () => {
      assert.fail('Read-only source accepted writes');
    }),
    Refusal,
  );
  assert.equal(f.registry.list()[0].writable, false);
});
