/**
 * What a command's new row may carry (businessCommandExecution.ts): a state
 * the machine lets a record be born in — its first, or one it names in
 * `entry` — and bytes only through a file resource's rule, within its cap,
 * with the audit keeping the file's name, type and size and never the bytes.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { catalogOf } from './support/commandCatalog.js';

const APP = {
  id: 'desk',
  name: 'Desk',
  sources: { desk: { connection: 'insert-rules-db', default: true } },
  resources: {
    ticket: {
      access: 'write',
      machine: {
        column: 'status',
        entry: ['open'],
        states: { draft: { on: { send: 'open' } }, open: { on: { close: 'closed' } }, closed: { final: true } },
      },
    },
    attachment: { access: 'write', file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 8 } },
  },
  auth: { providers: ['email'], roles: { agent: { read: true, write: ['ticket'], commands: ['raise', 'attach'] } } },
  views: { tickets: { kind: 'list', from: 'ticket' } },
  home: 'tickets',
  nav: ['tickets'],
};

type Attach = (db: any, files: readonly { name: string; type: string; size: number; data: Uint8Array }[]) => Promise<void>;

async function fixture(
  run: (f: {
    db: DatabaseSync;
    exec: (command: string, input: object, attach?: Attach, data?: string) => Promise<unknown>;
  }) => Promise<void>,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-insert-rules-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft', note BLOB);
    CREATE TABLE attachment (id INTEGER PRIMARY KEY, ticket_id INTEGER, file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(file);
  clearJournal('insert-rules-db');
  const registry = new Registry();
  registry.add({ id: 'insert-rules-db', name: 'Desk', url: file, writable: true, source: 'config' });
  let attach: Attach = async () => {};
  const commands = defineCommands({
    raise: defineCommand({
      source: 'desk',
      target: 'ticket',
      targets: 'none',
      input: { title: { type: 'text' }, status: { type: 'text' } },
      async handle({ db: tables }, input) {
        await tables.ticket.insert({ title: String(input.title), status: String(input.status) });
      },
    }),
    attach: defineCommand({
      source: 'desk',
      target: 'attachment',
      targets: 'none',
      track: 'audit',
      write: ['attachment'],
      async handle({ db: tables, files }) {
        await attach(tables, files ?? []);
      },
    }),
  });
  const app = parseAppConfig(APP, 'insert rules', {
    commands: catalogOf({ raise: { target: 'ticket', targets: 'none' }, attach: { target: 'attachment', targets: 'none' } }),
  });
  let request = 0;
  try {
    await run({
      db,
      exec: async (command, input, given, data) => {
        if (given) attach = given;
        const resources = await loadAppRuntimeResources(registry, app, 'insert-rules-db');
        const binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
        const bytes = data === undefined ? undefined : new TextEncoder().encode(data);
        return executeBusinessCommand(
          binding,
          { id: 'account-agent', appId: 'desk', roles: ['agent'] },
          {
            command,
            commandVersion: 1,
            key: {},
            expectedVersion: 0,
            idempotencyKey: `insert-rules-${String(++request).padStart(4, '0')}`,
            input,
          },
          { door: 'api', ...(bytes ? { files: [{ name: 'note.txt', type: 'text/plain', size: bytes.byteLength, data: bytes }] } : {}) },
        );
      },
    });
  } finally {
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
}

const code = (expected: string) => (error: unknown) => (error as { code?: string }).code === expected;

test('an insert starts in the first state or one the machine names in entry, and nowhere else', async () => {
  await fixture(async ({ db, exec }) => {
    await exec('raise', { title: 'Drafted', status: 'draft' });
    await exec('raise', { title: 'Phoned in', status: 'open' });
    await assert.rejects(exec('raise', { title: 'Born closed', status: 'closed' }), code('ineligible_state'));
    assert.deepEqual(
      db
        .prepare('SELECT title, status FROM ticket ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { title: 'Drafted', status: 'draft' },
        { title: 'Phoned in', status: 'open' },
      ],
    );
  });
});

test('a command stores bytes through a file rule, within its cap, and the audit keeps no content', async () => {
  await fixture(async ({ db, exec }) => {
    await exec(
      'attach',
      {},
      async (tables, files) => {
        for (const file of files) await tables.attachment.insertFile(file, { ticket_id: 1 });
      },
      'smoke',
    );
    assert.deepEqual(
      db
        .prepare('SELECT file_name, content_type, byte_size, data FROM attachment')
        .all()
        .map((row) => ({ ...row, data: String(Buffer.from(row.data as Uint8Array)) })),
      [{ file_name: 'note.txt', content_type: 'text/plain', byte_size: 5, data: 'smoke' }],
    );
    const audit = db
      .prepare(`SELECT changes_json FROM ${sqliteAuditRows} a`)
      .all()
      .map((row) => String(row.changes_json))
      .join('\n');
    assert.match(audit, /"file":"note\.txt"/);
    assert.match(audit, /"bytes":5/);
    assert.doesNotMatch(audit, /c21va2U|"smoke"/, 'no bytes, raw or base64');

    // Past the resource's 8 bytes: refused, nothing written.
    await assert.rejects(
      exec(
        'attach',
        {},
        async (tables, files) => {
          for (const file of files) await tables.attachment.insertFile(file, { ticket_id: 1 });
        },
        'much too long',
      ),
    );
    // Bytes anywhere but a file rule's content column are the handler's mistake.
    await assert.rejects(
      exec(
        'attach',
        {},
        async (tables, files) => {
          await tables.attachment.insert({ file_name: 'x', byte_size: 1, content_type: 'x', ticket_id: files[0].data });
        },
        'abc',
      ),
      code('invalid_result'),
    );
    assert.equal(db.prepare('SELECT count(*) AS n FROM attachment').get()!.n, 1);
  });
});
