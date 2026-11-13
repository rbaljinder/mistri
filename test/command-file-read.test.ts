/**
 * A handler reads a stored file's bytes (`db.<file>.readFile`, server/commands/commandDb.ts): through the command's
 * own transaction, so a row its grants, row policy or tenant keep from the actor is no file at all (`not_found`), and
 * a row naming a bucket object outside this App, tenant and resource is the same. The bytes come back exactly as
 * stored, from the database or the bucket; one past the resource's `maxBytes`, or past what one command may read,
 * is refused in words that name the table. On SQLite, and on PostgreSQL where `TABLEWALK_TEST_PG` names one
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
import { Refusal, type Filter } from '../packages/engine/src/adapters/adapter.js';
import { refusalCause } from '../packages/engine/src/shared/refusal.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { migratePostgresCommandJournal } from '../packages/mistri/src/adapters/commands/postgresCommandJournal.js';
import { loadAppRuntimeResources, type RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import { bindBusinessCommands, type BusinessCommandBinding } from '../packages/mistri/src/server/commands/businessCommandAccess.js';
import { executeBusinessCommand } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { defineCommand, defineCommands, type BusinessCommandActor } from '../packages/mistri/src/server/commands/businessCommands.js';
import {
  COMMAND_FILE_READ_MOST,
  commandCatalog,
  createCommandDb,
  type UntypedRow,
  type WriteTable,
} from '../packages/mistri/src/server/commands/commandDb.js';
import { field } from '../packages/mistri/src/server/commands/commandFields.js';
import { bindScopedBusinessCommands } from '../packages/mistri/src/server/commands/scopedBusinessCommandAccess.js';
import { S3_CREDENTIAL_VARIABLES } from '../packages/mistri/src/server/files/fileStorage.js';
import { FAKE_S3_CREDENTIALS, startFakeS3, type FakeS3 } from './support/fakeS3.js';
import { parseTestApp } from './support/commandCatalog.js';
import { liveSkip } from './live.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 0, 255]);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
const writes = (table: unknown) => table as WriteTable<UntypedRow>;
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

/* The commands every fixture runs: file a photo and read it back in one run, read one by the key the caller names,
   and read the same one again and again, to meet the per-command bound. */
const read = { output: { parse: (value: unknown) => value } } as const;
const commands = (source: string) =>
  defineCommands({
    fileAndRead: defineCommand({
      source,
      target: 'read_photo',
      targets: 'none',
      read: ['read_photo'],
      write: ['read_photo'],
      input: {},
      ...read,
      async handle({ db }) {
        const photo = writes(db.read_photo);
        const row = await photo.insertFile({ name: 'front.png', type: 'image/png', data: PNG }, { desk: 1 });
        const file = await photo.readFile(row);
        return { name: file.name, type: file.type, size: file.size, hex: hex(file.data), frozen: Object.isFrozen(file) };
      },
    }),
    readPhoto: defineCommand({
      source,
      target: 'read_photo',
      targets: 'none',
      read: ['read_photo'],
      input: { photo: field.text() },
      ...read,
      async handle({ db }, input) {
        const file = await writes(db.read_photo).readFile(input.photo);
        return { name: file.name, type: file.type, size: file.size, hex: hex(file.data) };
      },
    }),
    readOften: defineCommand({
      source,
      target: 'read_photo',
      targets: 'none',
      read: ['read_photo'],
      input: { photo: field.text() },
      ...read,
      async handle({ db }, input) {
        let total = 0;
        for (let n = 0; n < 4; n++) total += (await writes(db.read_photo).readFile(input.photo)).size;
        return { total };
      },
    }),
  });
const IDS = ['fileAndRead', 'readPhoto', 'readOften'];

const appConfig = (connection: string, file: object, extra: object = {}) => ({
  id: 'readings',
  name: 'Readings',
  sources: { main: { connection, default: true } },
  resources: {
    read_photo: {
      access: 'write',
      noun: { one: 'photo', many: 'photos' },
      file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', ...file },
    },
  },
  auth: { roles: { clerk: { read: true, commands: IDS } } },
  views: { photos: { kind: 'list', from: 'read_photo' } },
  home: 'photos',
  ...extra,
});

const clerk: BusinessCommandActor = { id: 'account-ana', appId: 'readings', roles: ['clerk'] };
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
          idempotencyKey: `file-read-${randomUUID()}`,
          input,
        },
        { door: 'api' },
      )
    ).result as Record<string, unknown>;

/** The rows as the test plants and reads them, on either engine. */
interface Engine {
  url: string;
  exec(sql: string): Promise<void>;
  /** A photo row holding `size` zero bytes, its id. */
  plant(size: number, name: string): Promise<string>;
  close(): Promise<void>;
}

async function sqliteEngine(): Promise<Engine> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-file-read-'));
  const path = join(directory, 'readings.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE read_photo (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL DEFAULT 1, file_name TEXT NOT NULL,
    content_type TEXT, byte_size INTEGER, data BLOB, object_key TEXT, sha256 TEXT);`);
  migrateSqliteCommandJournal(path);
  return {
    url: path,
    exec: async (sql) => db.exec(sql),
    plant: async (size, name) =>
      String(
        db
          .prepare(
            `INSERT INTO read_photo (file_name, content_type, byte_size, data) VALUES (?, 'application/octet-stream', ?, zeroblob(?)) RETURNING id`,
          )
          .get(name, size, size)!.id,
      ),
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
const PG_RESET = 'DROP TABLE IF EXISTS public.read_photo CASCADE';
async function postgresEngine(): Promise<Engine> {
  const specifier = 'pg';
  const pg = (await import(specifier)) as { default?: { Client: new (c: unknown) => Control }; Client?: new (c: unknown) => Control };
  const Client = (pg.Client ?? pg.default?.Client)!;
  const control = new Client({ connectionString: LIVE });
  await control.connect();
  await control.query(PG_RESET);
  await control.query(`CREATE TABLE public.read_photo (id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
    desk integer NOT NULL DEFAULT 1, file_name text NOT NULL, content_type text, byte_size integer, data bytea, object_key text, sha256 text)`);
  await migratePostgresCommandJournal(LIVE!);
  return {
    url: LIVE!,
    exec: async (sql) => void (await control.query(sql)),
    plant: async (size, name) =>
      String(
        (
          await control.query({
            text: `INSERT INTO public.read_photo (file_name, content_type, byte_size, data)
              VALUES ($1, 'application/octet-stream', $2, decode(repeat('00', $2::int), 'hex')) RETURNING id`,
            values: [name, size],
          } as never)
        ).rows[0]!.id,
      ),
    close: async () => {
      await control.query(PG_RESET).catch(() => {});
      await control.end();
    },
  };
}

for (const [label, engine, skip] of [
  ['SQLite', sqliteEngine, false],
  ['PostgreSQL', postgresEngine, liveSkip('postgres', LIVE)],
] as const) {
  describe(`readFile from the database on ${label}`, { skip }, () => {
    let store: Engine;
    let registry: Registry;
    let run: ReturnType<typeof runner>;
    const CONNECTION = `file-read-${label.toLowerCase()}`;
    before(async () => {
      store = await engine();
      clearJournal(CONNECTION);
      registry = new Registry();
      registry.add({ id: CONNECTION, name: 'Readings', url: store.url, writable: true, source: 'config' });
      const app = parseTestApp(appConfig(CONNECTION, { maxBytes: 4096 }), 'file read fixture');
      const resources = await loadAppRuntimeResources(registry, app, CONNECTION);
      run = runner(bindBusinessCommands({ app, registry: commands('main'), resources, writableConnection: () => true }));
    });
    after(async () => {
      await registry.closeAll();
      clearJournal(CONNECTION);
      await store.close();
    });

    test('a file the handler has just filed reads back byte for byte, its name and type with it', async () => {
      assert.deepEqual(await run('fileAndRead'), {
        name: 'front.png',
        type: 'image/png',
        size: PNG.byteLength,
        hex: hex(PNG),
        frozen: true,
      });
    });

    test("a row named by its key reads in a later command, and one that isn't there is not_found", async () => {
      const id = await store.plant(16, 'notes.bin');
      assert.deepEqual(await run('readPhoto', { photo: id }), {
        name: 'notes.bin',
        type: 'application/octet-stream',
        size: 16,
        hex: '00'.repeat(16),
      });
      await assert.rejects(run('readPhoto', { photo: '987654' }), said('not_found'));
      await assert.rejects(run('readPhoto', { photo: 'not-a-key' }), said('not_found'));
    });

    test("a file past the resource's maxBytes is refused, naming the table and the cap", async () => {
      const id = await store.plant(5000, 'big.bin');
      await assert.rejects(
        run('readPhoto', { photo: id }),
        told(/read_photo: this file is 0\.1 MB; readFile hands over at most the resource's 0\.1 MB/),
      );
    });
  });
}

test('one command reads at most 50 MB of files, however it gets there', async () => {
  assert.equal(COMMAND_FILE_READ_MOST, 50 * 1024 * 1024);
  const store = await sqliteEngine();
  const registry = new Registry();
  try {
    registry.add({ id: 'file-read-budget', name: 'Readings', url: store.url, writable: true, source: 'config' });
    const app = parseTestApp(appConfig('file-read-budget', { maxBytes: 20 * 1024 * 1024 }), 'file read budget fixture');
    const resources = await loadAppRuntimeResources(registry, app, 'file-read-budget');
    const run = runner(bindBusinessCommands({ app, registry: commands('main'), resources, writableConnection: () => true }));
    const id = await store.plant(15 * 1024 * 1024, 'scan.tiff');
    // Three reads are 45 MB; the fourth would be 60.
    await assert.rejects(
      run('readOften', { photo: id }),
      told(/read_photo: one command reads at most 50 MB of files; this one has read 45 MB/),
    );
    // The bound is per command, not per App: the next run reads its own 45 MB before it is refused again.
    await assert.rejects(
      run('readOften', { photo: id }),
      told(/read_photo: one command reads at most 50 MB of files; this one has read 45 MB/),
    );
  } finally {
    await registry.closeAll();
    clearJournal('file-read-budget');
    await store.close();
  }
});

test('a role that may only add the file rows cannot read their bytes either', async () => {
  const store = await sqliteEngine();
  const registry = new Registry();
  try {
    registry.add({ id: 'file-read-adding', name: 'Readings', url: store.url, writable: true, source: 'config' });
    await store.exec(`CREATE TABLE read_desk (id INTEGER PRIMARY KEY, title TEXT NOT NULL)`);
    const config = appConfig('file-read-adding', { maxBytes: 4096 });
    const app = parseTestApp(
      {
        ...config,
        resources: { ...config.resources, read_desk: { access: 'write' } },
        auth: { roles: { clerk: { read: ['read_desk'], commands: ['fileAndRead'] } } },
        views: { desks: { kind: 'list', from: 'read_desk' } },
        home: 'desks',
      },
      'file read insert-only fixture',
    );
    const resources = await loadAppRuntimeResources(registry, app, 'file-read-adding');
    // Its target is the desk, so the photo table beside it is one the role may only add to.
    const fileOnDesk = defineCommand({
      source: 'main',
      target: 'read_desk',
      targets: 'none',
      read: ['read_desk'],
      write: ['read_photo'],
      input: {},
      ...read,
      async handle({ db }) {
        const photo = writes(db.read_photo);
        return {
          size: (await photo.readFile(await photo.insertFile({ name: 'front.png', type: 'image/png', data: PNG }, { desk: 1 }))).size,
        };
      },
    });
    const run = runner(
      bindBusinessCommands({ app, registry: defineCommands({ fileAndRead: fileOnDesk }), resources, writableConnection: () => true }),
    );
    await assert.rejects(run('fileAndRead'), said('forbidden', /cannot read photo records/));
  } finally {
    await registry.closeAll();
    clearJournal('file-read-adding');
    await store.close();
  }
});

test("under a row policy, a file on a row outside the member's rows is not_found", async (t) => {
  const store = await sqliteEngine();
  const adapter = new SqliteAdapter(store.url, 'readings');
  t.after(async () => {
    await adapter.close();
    await store.close();
  });
  const mine = await store.plant(8, 'mine.bin');
  const theirs = await store.plant(8, 'theirs.bin');
  await store.exec(`UPDATE read_photo SET desk = 2 WHERE id = ${Number(theirs)}`);
  const runtime = createAppSourceAdapter(
    { desk: { adapter, schema: await adapter.introspect(), writable: true, resources: { read_photo: 'read_photo' } } },
    'desk',
  );
  const anchor = runtime.forSource('desk');
  const resources: RuntimeResources = {
    adapter: runtime.adapter,
    schema: runtime.schema,
    connections: ['desk-db'],
    connectionFor: () => 'desk-db',
    toPhysical: (resource) => runtime.resolve(resource).physicalTable,
    toLogical: (physical) => runtime.catalogs.get('desk')!.toLogical(physical),
    toLogicalAt: (physical) => runtime.catalogs.get('desk')!.toLogical(physical),
    forConnection: (connection) => {
      if (connection !== 'desk-db') throw new Refusal('Unknown connection');
      return anchor;
    },
  };
  const config = appConfig('desk-db', { maxBytes: 4096 });
  const app = parseTestApp(
    { ...config, sources: { desk: { connection: 'desk-db', default: true } }, auth: { rows: 'policy', roles: config.auth.roles } },
    'file read row policy fixture',
  );
  const deskOne: Filter = { groups: [[{ column: 'desk', op: '=', value: 1 }]] };
  const binding = bindScopedBusinessCommands({
    app,
    resources,
    registry: commands('desk'),
    writableConnection: () => true,
    resultReferences: { fileAndRead: () => [], readPhoto: () => [], readOften: () => [] },
  }).withScope({ read_photo: deskOne }, () => {});
  const run = runner(binding);
  assert.equal((await run('readPhoto', { photo: mine })).name, 'mine.bin');
  await assert.rejects(run('readPhoto', { photo: theirs }), said('not_found'));
});

describe('readFile from a bucket', () => {
  let s3: FakeS3;
  let store: Engine;
  let registry: Registry;
  let binding: BusinessCommandBinding;
  const CONNECTION = 'file-read-bucket';
  before(async () => {
    s3 = await startFakeS3();
    process.env[S3_CREDENTIAL_VARIABLES.accessKeyId] = FAKE_S3_CREDENTIALS.accessKeyId;
    process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey] = FAKE_S3_CREDENTIALS.secretAccessKey;
    store = await sqliteEngine();
    clearJournal(CONNECTION);
    registry = new Registry();
    registry.add({ id: CONNECTION, name: 'Readings', url: store.url, writable: true, source: 'config' });
    const app = parseTestApp(
      appConfig(CONNECTION, {
        maxBytes: 4096,
        object: 'object_key',
        hash: 'sha256',
        storage: 'bucket',
        bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'reads/' },
      }),
      'file read bucket fixture',
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
  const keyOf = (id: string) =>
    String(new DatabaseSync(store.url).prepare('SELECT object_key FROM read_photo WHERE id = ?').get(id)!.object_key);
  const lastId = () => String(new DatabaseSync(store.url).prepare('SELECT max(id) AS id FROM read_photo').get()!.id);
  /* A row naming an object the bucket holds, written behind the App's back. Its last segment is an object id as the
     App mints one, so a refusal below is the fence's or the size's, never the key's shape. */
  const plantObject = async (place: string, bytes: Uint8Array, size: number | null = bytes.byteLength) => {
    const key = `${place}${randomUUID()}`;
    s3.objects.set(key, { bytes: Buffer.from(bytes), lastModified: new Date(), type: 'image/png' });
    await store.exec(
      `INSERT INTO read_photo (file_name, content_type, byte_size, object_key) VALUES ('planted.png', 'image/png', ${size ?? 'NULL'}, '${key}')`,
    );
    return lastId();
  };

  test('a file filed into the bucket reads back byte for byte, in the same command and a later one', async () => {
    const run = runner(binding);
    assert.deepEqual(await run('fileAndRead'), { name: 'front.png', type: 'image/png', size: PNG.byteLength, hex: hex(PNG), frozen: true });
    const id = lastId();
    assert.match(keyOf(id), /^reads\/readings\/-\/read_photo\//);
    assert.equal((await run('readPhoto', { photo: id })).hex, hex(PNG));
  });

  test("a row naming another App's, tenant's or resource's object is not_found, though the bucket holds it", async () => {
    const run = runner(binding);
    for (const key of ['reads/elsewhere/-/read_photo/', 'reads/readings/north/read_photo/', 'reads/readings/-/other/']) {
      const id = await plantObject(key, PNG);
      await assert.rejects(run('readPhoto', { photo: id }), said('not_found'), key);
    }
  });

  test('a bucket file whose row says it is past maxBytes is refused, and one whose bytes are is too', async () => {
    const run = runner(binding);
    const claimed = await plantObject('reads/readings/-/read_photo/', PNG, 5000);
    await assert.rejects(run('readPhoto', { photo: claimed }), told(/this file is 0\.1 MB; readFile hands over at most/));
    const quiet = await plantObject('reads/readings/-/read_photo/', new Uint8Array(5000), 12);
    await assert.rejects(run('readPhoto', { photo: quiet }), told(/this file is 0\.1 MB; readFile hands over at most/));
  });

  test('a bucket file whose row has no size is fetched no further than the most it may hand over, then refused', async () => {
    const run = runner(binding);
    const unsized = await plantObject('reads/readings/-/read_photo/', new Uint8Array(5000), null);
    await assert.rejects(run('readPhoto', { photo: unsized }), told(/this file is 0\.1 MB; readFile hands over at most/));
    const asked = s3.seen.filter((seen) => seen.method === 'GET').at(-1);
    assert.equal(asked?.range, 'bytes=0-4096', 'the read asks for one byte past maxBytes, not the whole object');
    // And one that fits still reads whole through the same ranged read.
    const sized = await plantObject('reads/readings/-/read_photo/', PNG, null);
    assert.equal((await run('readPhoto', { photo: sized })).hex, hex(PNG));
  });

  test('readFile outside a command run, with nobody to say whose objects a row may name, is refused before any read', async () => {
    const adapter = new SqliteAdapter(store.url, 'file-read-scope');
    try {
      const schema = await adapter.introspect();
      const catalog = commandCatalog(schema, ['read_photo'], (local) => local)!;
      const before = s3.seen.length;
      const db = createCommandDb({
        tx: {} as never,
        catalog,
        read: ['read_photo'],
        write: [],
        now: () => new Date(),
        fileReads: new Map([['read_photo', { maxBytes: 4096 } as never]]),
      }) as unknown as Record<string, { readFile(given: unknown): Promise<unknown> }>;
      await assert.rejects(db.read_photo.readFile(1), /read_photo: readFile was asked outside a command run that says whose files/);
      assert.equal(s3.seen.length, before, 'no object is asked for');
    } finally {
      await adapter.close();
    }
  });

  test("under a tenant, the run files into the tenant's place and reads only from it", async () => {
    const owner = { storeId: 'store', sourceId: 'main', tenantId: 'north' };
    // The binding as it was, so a form's empty key is still a creation; only the place its run is owned by differs.
    const tenant: BusinessCommandBinding = {
      ...binding,
      authorize: (id, actor) => ({ ...binding.authorize(id, actor), receiptOwner: owner }),
    };
    const run = runner(tenant);
    assert.equal((await run('fileAndRead')).hex, hex(PNG));
    const id = lastId();
    assert.match(keyOf(id), /^reads\/readings\/north\/read_photo\//);
    assert.equal((await run('readPhoto', { photo: id })).hex, hex(PNG));
    const south = await plantObject('reads/readings/south/read_photo/', PNG);
    await assert.rejects(run('readPhoto', { photo: south }), said('not_found'));
    const app = await plantObject('reads/readings/-/read_photo/', PNG);
    await assert.rejects(run('readPhoto', { photo: app }), said('not_found'), "the App's own objects are not a tenant's");
    await assert.rejects(runner(binding)('readPhoto', { photo: id }), said('not_found'), "and a tenant's are not the App's");
  });
});
