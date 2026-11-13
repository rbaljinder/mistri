/**
 * A handler moves a stored file to another file resource (`db.<file>.moveFile`, server/commands/commandDb.ts): the
 * bytes read as `readFile` reads them, a new row in the other resource held to its rules, the old row removed, all in
 * the command's one transaction. In a bucket the new row's object is its own, under its own resource, and the old
 * object goes once the command has committed; a rollback keeps it. A row the actor cannot read, or one naming another
 * tenant's object, is not_found. On SQLite, and on PostgreSQL where `TABLEWALK_TEST_PG` names one
 * (`TABLEWALK_REQUIRE_LIVE=1` fails rather than skips).
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import type { PgQuery } from '../packages/engine/src/adapters/postgresPool.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { bindBusinessCommands, type BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import type { UntypedRow, WriteTable } from '../packages/mistri/src/server/commands/commandDb.js';
import { refuse } from '../packages/mistri/src/server/commands/commandErrors.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { S3_CREDENTIAL_VARIABLES } from '../packages/mistri/src/server/files/fileStorage.js';
import { FAKE_S3_CREDENTIALS, startFakeS3, type FakeS3 } from './support/fakeS3.js';
import { parseTestApp } from './support/commandCatalog.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const writes = (table: unknown) => table as WriteTable<UntypedRow>;
const bytesOf = (size: number, seed: number) => Uint8Array.from({ length: size }, (_, at) => (at * 31 + seed) % 256);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
/* An author's mistake carries its words as the refusal's cause, beneath whatever the executor re-issued it as. */
const told = (pattern: RegExp) => (error: unknown) => {
  const words: string[] = [];
  for (let at: unknown = error, depth = 0; at !== undefined && at !== null && depth < 8; depth++) {
    if (typeof at === 'string') words.push(at);
    else if (at instanceof Error) words.push(at.message);
    at = typeof at === 'object' ? (refusalCause(at) ?? (at as { cause?: unknown }).cause) : undefined;
  }
  assert.match(words.join(' | '), pattern);
  return true;
};
const said = (code: string, message?: RegExp) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code, String(error));
  if (message) assert.match((error as Error).message, message);
  return true;
};
/* The old object is deleted after the command has answered; give it a moment. */
const eventually = async (check: () => boolean, what: string) => {
  for (let tries = 0; tries < 50 && !check(); tries++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(check(), what);
};

const handled = { output: { parse: (value: unknown) => value } } as const;
const both = ['move_inbox', 'move_archive'];
/* File a scan into the inbox, move one to the archive (and then refuse, to roll the move back), and read one back. */
const commands = (source: string) =>
  defineCommands({
    fileScan: defineCommand({
      source,
      target: 'move_inbox',
      targets: 'none',
      write: ['move_inbox'],
      input: { size: field.number(), seed: field.number() },
      ...handled,
      async handle({ db }, input) {
        const row = await writes(db.move_inbox).insertFile({
          name: 'scan.pdf',
          type: 'application/pdf',
          data: bytesOf(input.size, input.seed),
        });
        return { id: String(row.id) };
      },
    }),
    archive: defineCommand({
      source,
      target: 'move_inbox',
      targets: 'none',
      read: both,
      write: both,
      input: { scan: field.text(), caseRef: field.text() },
      ...handled,
      async handle({ db }, input) {
        const row = await writes(db.move_inbox).moveFile(input.scan, 'move_archive', { case_ref: input.caseRef });
        return { id: String(row.id), caseRef: row.case_ref };
      },
    }),
    archiveThenRefuse: defineCommand({
      source,
      target: 'move_inbox',
      targets: 'none',
      read: both,
      write: both,
      input: { scan: field.text() },
      ...handled,
      async handle({ db }, input) {
        await writes(db.move_inbox).moveFile(input.scan, 'move_archive', { case_ref: 'C-0' });
        return refuse('ineligible_state');
      },
    }),
    moveInPlace: defineCommand({
      source,
      target: 'move_inbox',
      targets: 'none',
      read: both,
      write: both,
      input: { scan: field.text() },
      ...handled,
      async handle({ db }, input) {
        await writes(db.move_inbox).moveFile(input.scan, 'move_inbox');
        return {};
      },
    }),
    readArchived: defineCommand({
      source,
      target: 'move_archive',
      targets: 'none',
      read: ['move_archive'],
      input: { record: field.text() },
      ...handled,
      async handle({ db }, input) {
        const file = await writes(db.move_archive).readFile(input.record);
        return { name: file.name, type: file.type, hex: hex(file.data) };
      },
    }),
    // Its target is the archive, so the inbox beside it is one the filer may only add to.
    archiveAsFiler: defineCommand({
      source,
      target: 'move_archive',
      targets: 'none',
      read: ['move_archive'],
      write: both,
      input: { scan: field.text() },
      ...handled,
      async handle({ db }, input) {
        await writes(db.move_inbox).moveFile(input.scan, 'move_archive', { case_ref: 'C-9' });
        return {};
      },
    }),
  });
const IDS = ['fileScan', 'archive', 'archiveThenRefuse', 'moveInPlace', 'readArchived'];

const FILE = { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' };
const appConfig = (connection: string, file: object = {}) => ({
  id: 'movings',
  name: 'Movings',
  sources: { main: { connection, default: true } },
  resources: {
    move_inbox: { access: 'write', noun: { one: 'scan', many: 'scans' }, file: { ...FILE, maxBytes: 1024 * 1024, ...file } },
    move_archive: { access: 'write', noun: { one: 'filed scan', many: 'filed scans' }, file: { ...FILE, maxBytes: 200_000, ...file } },
  },
  auth: {
    roles: {
      clerk: { read: true, commands: IDS },
      filer: { read: ['move_archive'], commands: ['archiveAsFiler'] },
    },
  },
  views: { scans: { kind: 'list', from: 'move_inbox' } },
  home: 'scans',
});

const clerk: BusinessCommandActor = { id: 'account-ana', appId: 'movings', roles: ['clerk'] };
const filer: BusinessCommandActor = { id: 'account-bo', appId: 'movings', roles: ['filer'] };
const runner =
  (binding: BusinessCommandBinding, actor: BusinessCommandActor = clerk) =>
  async (command: string, input: object = {}) =>
    (
      await executeBusinessCommand(
        binding,
        actor,
        {
          command,
          commandVersion: 1,
          key: {},
          expectedVersion: 0,
          idempotencyKey: `file-move-${randomUUID()}`,
          input,
        },
        { door: 'api' },
      )
    ).result as Record<string, unknown>;

const COLUMNS = 'file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, object_key TEXT, sha256 TEXT';
interface Engine {
  url: string;
  rows(sql: string): Promise<Record<string, unknown>[]>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-file-move-'));
  const path = join(directory, 'movings.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE move_inbox (id INTEGER PRIMARY KEY, ${COLUMNS}, data BLOB);
    CREATE TABLE move_archive (id INTEGER PRIMARY KEY, case_ref TEXT NOT NULL, ${COLUMNS}, data BLOB);`);
  migrateSqliteCommandJournal(path);
  return {
    url: path,
    rows: async (sql) => db.prepare(sql).all() as Record<string, unknown>[],
    exec: async (sql) => db.exec(sql),
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
const PG_RESET = 'DROP TABLE IF EXISTS public.move_inbox, public.move_archive CASCADE';
async function postgresEngine(): Promise<Engine> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const control = new Client({ connectionString: LIVE });
  await control.connect();
  await control.query(PG_RESET);
  const columns = COLUMNS.replaceAll('TEXT', 'text').replace('INTEGER', 'integer');
  await control.query(`CREATE TABLE public.move_inbox (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, ${columns}, data bytea)`);
  await control.query(
    `CREATE TABLE public.move_archive (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY, case_ref text NOT NULL, ${columns}, data bytea)`,
  );
  await migratePostgresCommandJournal(LIVE!);
  return {
    url: LIVE!,
    rows: async (sql) => (await control.query(sql)).rows as Record<string, unknown>[],
    exec: async (sql) => void (await control.query(sql)),
    close: async () => {
      await control.query(PG_RESET).catch(() => {});
      await control.end();
    },
  };
}

const count = async (store: Engine, table: string) => Number((await store.rows(`SELECT count(*) AS n FROM ${table}`))[0]!.n);

for (const [label, engine, skip] of [
  ['SQLite', sqliteEngine, false],
  ['PostgreSQL', postgresEngine, liveSkip('postgres', LIVE)],
] as const) {
  describe(`moveFile in the database on ${label}`, { skip }, () => {
    let store: Engine;
    let registry: Registry;
    let binding: BusinessCommandBinding;
    let run: ReturnType<typeof runner>;
    const CONNECTION = `file-move-${label.toLowerCase()}`;
    before(async () => {
      store = await engine();
      clearJournal(CONNECTION);
      registry = new Registry();
      registry.add({ id: CONNECTION, name: 'Movings', url: store.url, writable: true, source: 'config' });
      const app = parseTestApp(appConfig(CONNECTION), 'file move fixture');
      const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
      binding = bindBusinessCommands({ app, registry: commands('main'), resources, writableConnection: () => true });
      run = runner(binding);
    });
    after(async () => {
      await registry.closeAll();
      clearJournal(CONNECTION);
      await store.close();
    });

    test('the file arrives byte for byte in a new archive row with its values, and the inbox row is gone', async () => {
      const { id } = await run('fileScan', { size: 3000, seed: 7 });
      const moved = await run('archive', { scan: id, caseRef: 'C-1' });
      assert.equal(moved.caseRef, 'C-1');
      assert.deepEqual(await run('readArchived', { record: moved.id }), {
        name: 'scan.pdf',
        type: 'application/pdf',
        hex: hex(bytesOf(3000, 7)),
      });
      assert.deepEqual(await store.rows(`SELECT id FROM move_inbox WHERE id = ${Number(id)}`), []);
      await assert.rejects(run('archive', { scan: id, caseRef: 'C-1' }), said('not_found'), 'a moved row is not there to move again');
    });

    test('a refusal after the move keeps both rows as they were', async () => {
      const { id } = await run('fileScan', { size: 64, seed: 1 });
      const archived = await count(store, 'move_archive');
      await assert.rejects(run('archiveThenRefuse', { scan: id }), said('ineligible_state'));
      assert.equal((await store.rows(`SELECT id FROM move_inbox WHERE id = ${Number(id)}`)).length, 1);
      assert.equal(await count(store, 'move_archive'), archived);
    });

    test("a file past the archive's maxBytes is refused in words, and nothing moves", async () => {
      const { id } = await run('fileScan', { size: 300_000, seed: 2 });
      await assert.rejects(
        run('archive', { scan: id, caseRef: 'C-2' }),
        told(/move_inbox: this file is 0\.3 MB; moveFile moves it into move_archive, which takes at most 0\.2 MB/),
      );
      assert.equal((await store.rows(`SELECT id FROM move_inbox WHERE id = ${Number(id)}`)).length, 1);
    });

    test('a move into its own resource is an author mistake', async () => {
      const { id } = await run('fileScan', { size: 8, seed: 3 });
      await assert.rejects(run('moveInPlace', { scan: id }), told(/moveFile moves a file to another file resource this command writes/));
    });

    test('a role that may only add inbox rows cannot move one out', async () => {
      const { id } = await run('fileScan', { size: 8, seed: 4 });
      await assert.rejects(runner(binding, filer)('archiveAsFiler', { scan: id }), said('forbidden', /cannot read scan records/));
      assert.equal((await store.rows(`SELECT id FROM move_inbox WHERE id = ${Number(id)}`)).length, 1);
    });
  });
}

describe('moveFile between buckets', () => {
  let s3: FakeS3;
  let store: Engine;
  let registry: Registry;
  let binding: BusinessCommandBinding;
  const CONNECTION = 'file-move-bucket';
  // The binding as it was, so a form's empty key is still a creation; only the place its run is owned by differs.
  const tenant = (id: string): BusinessCommandBinding => ({
    ...binding,
    authorize: (command, actor) => ({
      ...binding.authorize(command, actor),
      receiptOwner: { storeId: 'store', sourceId: 'main', tenantId: id },
    }),
  });
  before(async () => {
    s3 = await startFakeS3();
    process.env[S3_CREDENTIAL_VARIABLES.accessKeyId] = FAKE_S3_CREDENTIALS.accessKeyId;
    process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey] = FAKE_S3_CREDENTIALS.secretAccessKey;
    store = await sqliteEngine();
    clearJournal(CONNECTION);
    registry = new Registry();
    registry.add({ id: CONNECTION, name: 'Movings', url: store.url, writable: true, source: 'config' });
    const app = parseTestApp(
      appConfig(CONNECTION, {
        object: 'object_key',
        hash: 'sha256',
        storage: 'bucket',
        bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'moves/' },
      }),
      'file move bucket fixture',
    );
    const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
    binding = bindBusinessCommands({ app, registry: commands('main'), resources, writableConnection: () => true });
  });
  after(async () => {
    await registry.closeAll();
    clearJournal(CONNECTION);
    await store.close();
    delete process.env[S3_CREDENTIAL_VARIABLES.accessKeyId];
    delete process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey];
    await s3.close();
  });
  const row = async (table: string, id: unknown) =>
    (await store.rows(`SELECT object_key, sha256 FROM ${table} WHERE id = ${Number(id)}`))[0] as
      | { object_key: string; sha256: string }
      | undefined;
  const under = (prefix: string) => [...s3.objects.keys()].filter((key) => key.startsWith(prefix)).length;

  for (const [who, place] of [
    ['the App', '-'],
    ['a tenant', 'north'],
  ] as const) {
    test(`for ${who}, the new row's object is its own under the archive, and the old one goes after commit`, async () => {
      const run = runner(place === '-' ? binding : tenant(place));
      const { id } = await run('fileScan', { size: 5000, seed: 9 });
      const before = (await row('move_inbox', id))!;
      assert.match(before.object_key, new RegExp(`^moves/movings/${place}/move_inbox/`));
      const moved = await run('archive', { scan: id, caseRef: 'C-3' });
      const after = (await row('move_archive', moved.id))!;
      assert.match(after.object_key, new RegExp(`^moves/movings/${place}/move_archive/`));
      assert.notEqual(after.object_key, before.object_key);
      assert.equal(after.sha256, before.sha256, 'the same bytes');
      assert.equal(hex(new Uint8Array(s3.objects.get(after.object_key)!.bytes)), hex(bytesOf(5000, 9)));
      assert.equal(await row('move_inbox', id), undefined);
      await eventually(() => !s3.objects.has(before.object_key), 'the old object is deleted once the move commits');
    });
  }

  test('a rollback keeps the old object and leaves no new one', async () => {
    const run = runner(binding);
    const { id } = await run('fileScan', { size: 700, seed: 5 });
    const before = (await row('move_inbox', id))!;
    const archived = under('moves/movings/-/move_archive/');
    await assert.rejects(run('archiveThenRefuse', { scan: id }), said('ineligible_state'));
    assert.equal((await row('move_inbox', id))?.object_key, before.object_key);
    assert.ok(s3.objects.has(before.object_key), 'the old object stays with the row that names it');
    await eventually(() => under('moves/movings/-/move_archive/') === archived, 'the object placed for the new row is deleted');
  });

  test("a tenant cannot move a row naming another tenant's object, nor the App's", async () => {
    const run = runner(tenant('north'));
    for (const key of ['moves/movings/south/move_inbox/s1', 'moves/movings/-/move_inbox/a1']) {
      s3.objects.set(key, { bytes: Buffer.from(bytesOf(16, 6)), lastModified: new Date(), type: 'application/pdf' });
      await store.exec(
        `INSERT INTO move_inbox (file_name, content_type, byte_size, object_key) VALUES ('planted.pdf', 'application/pdf', 16, '${key}')`,
      );
      const id = (await store.rows('SELECT max(id) AS id FROM move_inbox'))[0]!.id;
      await assert.rejects(run('archive', { scan: String(id), caseRef: 'C-4' }), said('not_found'), key);
      assert.ok(s3.objects.has(key), key);
      assert.ok(await row('move_inbox', id), key);
    }
  });
});
