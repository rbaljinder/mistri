/**
 * A command that files a photo or a signature for a role that cannot browse the file table (a field report): the
 * run goes ahead and the row lands, read is not elevated for it, and anything the handler would read, change or
 * remove of those rows is refused in words that name the table. `check` does not call the grant dead.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { commandUnreadable } from '../packages/mistri/src/server/build/checkCommands.js';
import { bindBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import type { AppDef } from '../packages/mistri/src/shared/app.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseTestApp } from './support/commandCatalog.js';

const APP = 'repairs';
const CONNECTION = 'insert-only-files-db';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
type Handle = Record<string, Record<string, (...args: never[]) => Promise<Record<string, unknown>>>>;

const file = (then?: (db: Handle) => Promise<unknown>) =>
  defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    input: { title: field.text() },
    async handle({ db }, input) {
      const handle = db as unknown as Handle;
      const repair = await handle.repair.insert({ title: input.title } as never);
      await handle.repair_photo.insertFile({ name: 'front.png', type: 'image/png', data: PNG } as never, { repair_id: repair.id } as never);
      await then?.(handle);
    },
  });

const commands = defineCommands({
  fileReport: file(),
  countPhotos: file((db) => db.repair_photo.count() as never),
  findPhoto: file((db) => db.repair_photo.find({ file_name: 'front.png' } as never)),
});

let directory: string;
let db: DatabaseSync;
let registry: Registry;
let app: AppDef;
let resources: Awaited<ReturnType<typeof loadAppRuntimeResources>>;
let binding: ReturnType<typeof bindBusinessCommands>;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mistri-insert-only-files-'));
  const path = join(directory, 'repairs.db');
  db = new DatabaseSync(path);
  db.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE repair_photo (id INTEGER PRIMARY KEY, repair_id INTEGER NOT NULL REFERENCES repair(id), file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(path);
  clearJournal(CONNECTION);
  registry = new Registry();
  registry.add({ id: CONNECTION, name: 'Repairs', url: path, writable: true, source: 'config' });
  app = parseTestApp(
    {
      id: APP,
      name: 'Repairs',
      sources: { main: { connection: CONNECTION, default: true } },
      resources: {
        repair: { access: 'write' },
        repair_photo: {
          access: 'write',
          noun: { one: 'photo', many: 'photos' },
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 4096 },
        },
      },
      auth: { roles: { clerk: { read: ['repair'], commands: ['fileReport', 'countPhotos', 'findPhoto'] } } },
      views: { repairs: { kind: 'list', from: 'repair' } },
      home: 'repairs',
    },
    'insert-only files fixture',
  );
  resources = await loadAppRuntimeResources(registry, app, CONNECTION);
  binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
});

after(async () => {
  db.close();
  await registry.closeAll();
  clearJournal();
  rmSync(directory, { recursive: true, force: true });
});

let request = 0;
const run = (command: string) =>
  executeBusinessCommand(
    binding,
    { id: 'account-ana', appId: APP, roles: ['clerk'] } as never,
    {
      command,
      commandVersion: 1,
      key: {},
      expectedVersion: 0,
      idempotencyKey: `insert-only-${String(++request).padStart(6, '0')}`,
      input: { title: 'Leaking tap' },
    },
    { door: 'api' },
  );
const photos = () => Number((db.prepare('SELECT count(*) AS n FROM repair_photo').get() as { n: number }).n);

test('a role that cannot read the file table still files a photo through the command', async () => {
  const before = photos();
  await run('fileReport');
  assert.equal(photos(), before + 1);
});

test('a handler that reads the rows it may only add is refused, naming them, and nothing lands', async () => {
  for (const command of ['countPhotos', 'findPhoto']) {
    const before = photos();
    await assert.rejects(run(command), (error: unknown) => {
      assert.equal((error as { code?: string }).code, 'forbidden');
      assert.match((error as Error).message, /cannot read photo records, which "[^"]+" reads: it may only add them/);
      return true;
    });
    assert.equal(photos(), before);
  }
});

test('check does not call the grant dead for a file table the command only adds to', () => {
  assert.deepEqual(commandUnreadable(app, commands, resources.schema), []);
});

test('a table the author names in read and in write is a read the caller must hold; written alone it is not', () => {
  const said = (read: string[]) =>
    commandUnreadable(
      app,
      defineCommands({
        fileReport: defineCommand({
          source: 'main',
          target: 'repair',
          targets: 'none',
          read,
          write: ['repair', 'repair_photo'],
          input: { title: field.text() },
          async handle() {},
        }),
      }),
      resources.schema,
    );
  assert.equal(said([]).length, 0, 'write alone stays insert-only');
  const advisory = said(['repair_photo']);
  assert.equal(advisory.length, 1);
  assert.match(
    advisory[0],
    /command "fileReport" is granted to role "clerk", which cannot read "repair_photo" its read names, .*\[command-reads-unreadable\]/,
  );
});

test('a command spread back into defineCommand keeps which written tables its author also read', () => {
  /* A registered command's `read` holds every table it writes, so a spread (a second module copy adopting it, or an
     author's `{ ...command, handle }`) once read every written table as declared: an add-only table became a read
     the caller must hold, and the grant was called dead. */
  const original = defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    input: { title: field.text() },
    async handle() {},
  });
  const { version: _version, ...definition } = original as unknown as Record<string, unknown>;
  const respread = defineCommand(definition as unknown as Parameters<typeof defineCommand>[0]);
  assert.deepEqual(commandUnreadable(app, defineCommands({ fileReport: respread }), resources.schema), [], 'still insert-only');
  const declared = defineCommand({ ...definition, read: ['repair_photo'] } as unknown as Parameters<typeof defineCommand>[0]);
  const { version: _again, ...again } = declared as unknown as Record<string, unknown>;
  assert.equal(
    commandUnreadable(
      app,
      defineCommands({ fileReport: defineCommand(again as unknown as Parameters<typeof defineCommand>[0]) }),
      resources.schema,
    ).length,
    1,
    'a declared read survives the spread too',
  );
});
