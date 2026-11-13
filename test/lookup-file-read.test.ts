/**
 * A command's lookup reads a file its own form attached (`files.read` in `lookup`, server/commands/stagedFiles.ts
 * `readHeldFile`): before the transaction opens, by the id a `field.files` or `field.signature` in this very input
 * names, and only one held for whoever is running the command. The read leaves the file held, so the command's own
 * transaction still takes it; another visitor's or account's id, one the input does not name, and one used up are
 * all refused alike. On SQLite, and on PostgreSQL where `TABLEWALK_TEST_PG` names one (`TABLEWALK_REQUIRE_LIVE=1`
 * fails rather than skips).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { runtimeName, runtimeTable } from '../packages/engine/src/shared/runtimeTables.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { COMMAND_STAGED_TABLE } from '../packages/mistri/src/adapters/commands/commandStaging.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands, type BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { publicPrincipal } from '../packages/mistri/src/server/commands/formHttp.js';
import { lookupFileWarnings, newVisitorToken, stageCommandFile } from '../packages/mistri/src/server/commands/stagedFiles.js';
import { parseTestApp } from './support/commandCatalog.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const APP = 'repairs';
const PNG = (fill: number, size = 24) => {
  const bytes = new Uint8Array(size).fill(fill);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64');
const staff = (id = 'account-ana'): BusinessCommandActor => ({ id, appId: APP, roles: ['tech'] });
const refusedAt = (code: string, at?: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code, String(error));
  if (at !== undefined) assert.equal((error as { field?: string }).field, at);
  return true;
};

const photos = field.files('repair_photo', { max: 3, accept: 'image/*' });
const input = { title: field.text(), photos, also: field.text({ optional: true }) };
/* What each lookup read, in order: the file's name and size, so a test can tell a refused read from one never tried. */
const lookedAt: string[] = [];
const report = (pub: boolean) =>
  defineCommand({
    source: 'main',
    target: 'repair',
    targets: 'none',
    write: ['repair', 'repair_photo'],
    ...(pub ? { public: true as const } : {}),
    input,
    // The result is what the test reads back: what the lookup saw, and how many files the handler stored.
    output: { parse: (result: unknown) => result },
    // `also` lets a test name an id the form did not attach in a field that holds no files.
    async lookup({ files }, value) {
      const file = await files.read((value.also || value.photos[0]) as string);
      lookedAt.push(`${file.name}:${file.size}`);
      return { name: file.name, size: file.size, first: file.data[8] };
    },
    async handle({ db, lookup }, value) {
      const repair = await db.repair.insert({ title: value.title });
      for (const photo of value.photos) await db.repair_photo.insertFile(photo, { repair_id: repair.id as number });
      return { lookup, stored: value.photos.length };
    },
  });
const commands = defineCommands({ fileReport: report(false), report: report(true) });

interface Engine {
  url: string;
  /** Where this engine keeps held files: PostgreSQL keeps them in the runtime schema, under its own name. */
  staged: string;
  count(sql: string): Promise<number>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-lookup-files-'));
  const path = join(directory, 'repairs.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE repair (id INTEGER PRIMARY KEY, title TEXT NOT NULL);
    CREATE TABLE repair_photo (id INTEGER PRIMARY KEY, repair_id INTEGER NOT NULL REFERENCES repair(id), file_name TEXT NOT NULL,
      content_type TEXT, byte_size INTEGER, data BLOB);`);
  migrateSqliteCommandJournal(path);
  return {
    url: path,
    staged: `"${COMMAND_STAGED_TABLE}"`,
    count: async (sql) => Number((db.prepare(sql).get() as { n: number }).n),
    close: async () => {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

interface Control extends PgQuery {
  connect(): Promise<void>;
  end(): Promise<void>;
}
const PG_RESET = 'DROP TABLE IF EXISTS public.repair_photo, public.repair CASCADE';
const PG_STAGED = runtimeTable('postgres', runtimeName('postgres', COMMAND_STAGED_TABLE));
async function postgresEngine(): Promise<Engine> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const control = new Client({ connectionString: LIVE });
  await control.connect();
  await control.query(PG_RESET);
  await control.query(`CREATE TABLE public.repair (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, title text NOT NULL)`);
  await control.query(`CREATE TABLE public.repair_photo (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    repair_id integer NOT NULL REFERENCES public.repair(id), file_name text NOT NULL, content_type text, byte_size integer, data bytea)`);
  await migratePostgresCommandJournal(LIVE!);
  await control.query(`DELETE FROM ${PG_STAGED}`);
  return {
    url: LIVE!,
    staged: PG_STAGED,
    count: async (sql) => Number((await control.query(sql)).rows[0]!.n),
    close: async () => {
      await control.query(PG_RESET).catch(() => {});
      await control.query(`DELETE FROM ${PG_STAGED}`).catch(() => {});
      await control.end();
    },
  };
}

for (const [label, engine, skip] of [
  ['SQLite', sqliteEngine, false],
  ['PostgreSQL', postgresEngine, liveSkip('postgres', LIVE)],
] as const) {
  describe(`a lookup reads its form's held file on ${label}`, { skip }, () => {
    let store: Engine;
    let registry: Registry;
    let binding: BusinessCommandBinding;
    const CONNECTION = `lookup-files-${label.toLowerCase()}`;
    const run = async (command: string, value: object, actor: BusinessCommandActor = staff(), visitor?: string) =>
      (
        await executeBusinessCommand(
          binding,
          actor,
          {
            command,
            commandVersion: 1,
            key: {},
            expectedVersion: 0,
            idempotencyKey: `lookup-files-${label}-${randomUUID()}`,
            input: value,
          },
          { door: 'api', ...(visitor ? { visitor } : {}) },
        )
      ).result as Record<string, unknown>;
    const hold = async (fill: number, actor: BusinessCommandActor, command: string, visitor?: string) =>
      (
        await stageCommandFile(
          binding,
          actor,
          { command, field: 'photos', file: { name: `photo-${fill}.png`, type: 'image/png', data: base64(PNG(fill)) } },
          visitor ? { visitor } : {},
        )
      ).id;
    const held = () => store.count(`SELECT count(*) AS n FROM ${store.staged}`);
    const stored = () => store.count('SELECT count(*) AS n FROM repair_photo');

    before(async () => {
      store = await engine();
      clearJournal(CONNECTION);
      registry = new Registry();
      registry.add({ id: CONNECTION, name: 'Repairs', url: store.url, writable: true, source: 'config' });
      const app = parseTestApp(
        {
          id: APP,
          name: 'Repairs',
          sources: { main: { connection: CONNECTION, default: true } },
          resources: {
            repair: { access: 'write' },
            repair_photo: {
              access: 'write',
              file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 4096 },
            },
          },
          auth: { roles: { tech: { read: true, commands: ['fileReport'] } } },
          views: {
            repairs: { kind: 'list', from: 'repair' },
            report: {
              kind: 'form',
              label: 'Report',
              public: true,
              done: { title: 'Thanks' },
              command: { id: 'report', version: 1, input },
            },
          },
          home: 'repairs',
        },
        'lookup file read fixture',
      );
      const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
      binding = bindBusinessCommands({ app, registry: commands, resources, writableConnection: () => true });
    });
    after(async () => {
      await registry.closeAll();
      clearJournal(CONNECTION);
      await store.close();
    });

    test('a signed-in lookup reads the bytes, the file stays held for the transaction, and the handler takes it', async () => {
      lookedAt.length = 0;
      const id = await hold(7, staff(), 'fileReport');
      const before = await stored();
      const result = await run('fileReport', { title: 'Bent frame', photos: [id] });
      assert.deepEqual(result, { lookup: { name: 'photo-7.png', size: 24, first: 7 }, stored: 1 });
      assert.deepEqual(lookedAt, ['photo-7.png:24']);
      assert.equal(await stored(), before + 1, 'the handler was handed the file the lookup had read');
      assert.equal(await held(), 0, 'and its transaction used it up');
      // Used up, it is no file to read either.
      await assert.rejects(run('fileReport', { title: 'Again', photos: [id] }), refusedAt('invalid_input', 'photos'));
      assert.deepEqual(lookedAt, ['photo-7.png:24']);
    });

    test("another account's held id is refused in the lookup, and the file stays held for its owner", async () => {
      lookedAt.length = 0;
      const id = await hold(8, staff('account-bea'), 'fileReport');
      await assert.rejects(run('fileReport', { title: 'Not mine', photos: [id] }), refusedAt('invalid_input', 'photos'));
      assert.deepEqual(lookedAt, [], 'the read itself was refused');
      assert.equal(await held(), 1);
      await run('fileReport', { title: 'Mine', photos: [id] }, staff('account-bea'));
      assert.equal(await held(), 0);
    });

    test("a visitor cannot read another visitor's held id, and the owner's submission still takes it", async () => {
      lookedAt.length = 0;
      const visitor = publicPrincipal(APP, 'report') as BusinessCommandActor;
      const mine = newVisitorToken();
      const theirs = newVisitorToken();
      const id = await hold(9, visitor, 'report', mine);
      await assert.rejects(run('report', { title: 'Theirs', photos: [id] }, visitor, theirs), refusedAt('invalid_input', 'photos'));
      await assert.rejects(run('report', { title: 'Nobody', photos: [id] }, visitor), refusedAt('invalid_input', 'photos'));
      // A signed-in person cannot read a visitor's file through a lookup either.
      await assert.rejects(run('fileReport', { title: 'Staff', photos: [id] }), refusedAt('invalid_input', 'photos'));
      assert.deepEqual(lookedAt, []);
      assert.equal(await held(), 1, "refused, the visitor's file is still held");
      const result = await run('report', { title: 'Mine', photos: [id] }, visitor, mine);
      assert.deepEqual(result.lookup, { name: 'photo-9.png', size: 24, first: 9 });
      assert.equal(await held(), 0);
    });

    test('an id the input does not name at a file field is refused, though the same person holds it', async () => {
      lookedAt.length = 0;
      const attached = await hold(10, staff(), 'fileReport');
      const other = await hold(11, staff(), 'fileReport');
      // `also` is a text field: an id there is not one the form attached.
      await assert.rejects(run('fileReport', { title: 'Sideways', photos: [attached], also: other }), refusedAt('invalid_input'));
      await assert.rejects(run('fileReport', { title: 'Made up', photos: [attached], also: 'x'.repeat(43) }), refusedAt('invalid_input'));
      assert.deepEqual(lookedAt, []);
      assert.equal(await held(), 2, 'both are still held');
      await run('fileReport', { title: 'Plain', photos: [attached, other] });
      assert.equal(await held(), 0);
    });
  });
}

test('check advises a lookup that reads files.read on a command whose form attaches none', () => {
  const warnings = lookupFileWarnings(
    defineCommands({
      quote: defineCommand({
        source: 'main',
        target: 'repair',
        targets: 'none',
        write: ['repair'],
        input: { title: field.text(), photo: field.text() },
        async lookup({ files }, value) {
          return { size: (await files.read(value.photo)).size };
        },
        async handle() {},
      }),
      attached: report(false),
    }),
  );
  assert.equal(warnings.length, 1, warnings.join('\n'));
  assert.match(warnings[0]!, /command "quote" reads files\.read in its lookup and takes no file \[lookup-files-unattached\]/);
  assert.deepEqual(lookupFileWarnings(undefined), []);
});
