/**
 * A file resource whose bytes are kept in an S3-compatible bucket
 * (files/fileStorage.ts), against an in-memory bucket that checks every
 * signature (support/fakeS3.ts): an upload stores the object before its row
 * and deletes it when the row is refused; the file route reads the row as
 * always and then passes the bucket's bytes on (whole, a range, a 304) or
 * redirects to a presigned URL; a row naming an object outside its App,
 * tenant or resource reads as no file; and `mistri migrate files` moves
 * files to the bucket and back, resumably, and sweeps what no row names.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { runMigrate } from '../packages/engine/src/server/migrate/cli.js';
import { MIGRATE_APPS } from '../packages/mistri/src/server/cli/appTargets.js';
import { checkApiReadCatalog } from '../packages/mistri/src/server/api/apiReadCatalog.js';
import { apiWriteProblems } from '../packages/mistri/src/server/api/apiGenericWrites.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { FILES_SWEEP_JOB, filesSweepEvery } from '../packages/mistri/src/server/files/filesCli.js';
import { tenantFilesSweep } from '../packages/mistri/src/server/tenant/tenantFilesSweep.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { JOB_TABLES } from '../packages/mistri/src/adapters/jobs/jobStoreSchema.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { openSqliteJobStore } from '../packages/mistri/src/adapters/jobs/jobStore.js';
import { jobStorePolicy } from '../packages/mistri/src/server/jobs/jobLoader.js';
import { capturedJobModule } from '../packages/mistri/src/server/jobs/jobModule.js';
import {
  bucketCredentialsProblem,
  newObjectKey,
  objectBelongs,
  probeBuckets,
  S3_CREDENTIAL_VARIABLES,
  unsweptBuckets,
} from '../packages/mistri/src/server/files/fileStorage.js';
import { imageHashOfHex } from '../packages/mistri/src/server/http/imageVariants.js';
import { FAKE_S3_CREDENTIALS, startFakeS3, type FakeS3 } from './support/fakeS3.js';

const appId = 'files';
const owner = 'files-db';
let s3: FakeS3;

before(async () => {
  s3 = await startFakeS3();
  process.env[S3_CREDENTIAL_VARIABLES.accessKeyId] = FAKE_S3_CREDENTIALS.accessKeyId;
  process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey] = FAKE_S3_CREDENTIALS.secretAccessKey;
});
after(async () => {
  delete process.env[S3_CREDENTIAL_VARIABLES.accessKeyId];
  delete process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey];
  await s3.close();
});

const definition = (storage: 'bucket' | 'database', bucket: Record<string, unknown> = {}) => ({
  id: appId,
  name: 'Files',
  connection: owner,
  resources: {
    issue: { access: 'write' },
    attachment: {
      access: 'write',
      file: {
        content: 'data',
        name: 'file_name',
        type: 'content_type',
        size: 'byte_size',
        object: 'object_key',
        hash: 'sha256',
        storage,
        bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'files/', ...bucket },
      },
    },
  },
  views: { issues: { kind: 'list', from: 'issue', label: 'Issues' } },
  home: 'issues',
  nav: ['issues'],
});
const SQL = `CREATE TABLE issue (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE attachment (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), file_name TEXT NOT NULL,
    content_type TEXT, byte_size INTEGER, data BLOB, object_key TEXT, sha256 TEXT);
  INSERT INTO issue VALUES (1, 'First');`;

interface Served {
  upload: (body: object) => Promise<{ status: number; body: any }>;
  post: ((path: string, body: object) => Promise<{ status: number; body: any }>) & { base: string };
  download: (query: string, headers?: Record<string, string>, method?: string) => Promise<Response>;
  db: DatabaseSync;
  file: string;
}

async function serve(run: (f: Served) => Promise<void>, app: object = definition('bucket'), identity?: () => Identity) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-files-'));
  const file = join(directory, 'files.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Files', url: file, source: 'config', writable: true });
  const parsed = parseAppConfig(app, 'files fixture');
  const pages = parsePagesConfig({ pages: [] }, 'files pages');
  const host: AppHost = {
    app: { path: 'files-fixture.ts', app: parsed, pages, sources: {} },
    pages,
    ...(identity
      ? {
          auth: {
            spec: parsed.auth!,
            store: join(directory, 'auth.db'),
            close: async () => {},
            session: async () => identity(),
            handler: async (_req, res) => {
              res.writeHead(204);
              res.end();
            },
          },
        }
      : {}),
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  const post = Object.assign(
    async (path: string, body: object) => {
      const response = await fetch(`${base}${path}`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    },
    { base },
  );
  try {
    await run({
      db,
      file,
      post,
      upload: async (body) => {
        const response = await fetch(`${base}/api/file/upload`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
      download: (query, headers = {}, method = 'GET') =>
        fetch(`${base}/api/file?app=${appId}&${query}`, { method, headers, redirect: 'manual', signal: AbortSignal.timeout(5000) }),
    });
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
    await registry.closeAll();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
    s3.objects.clear();
    s3.seen.length = 0;
    s3.failing = false;
  }
}

const bytes = Buffer.from([0, 1, 2, 250, 255, ...Buffer.from(' hello, bucket')]);
const key = (id: number) => `table=attachment&key=${encodeURIComponent(JSON.stringify({ id }))}`;
const row = (db: DatabaseSync, id = 1) =>
  ({ ...(db.prepare('SELECT data, object_key, sha256, byte_size FROM attachment WHERE id = ?').get(id) as object) }) as {
    data: Uint8Array | null;
    object_key: string | null;
    sha256: string | null;
    byte_size: number;
  };
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('an upload is stored in the bucket first, and its row names the object instead of holding the bytes', async () => {
  await serve(async ({ upload, download, db }) => {
    const sent = await upload({
      table: 'attachment',
      values: { issue_id: 1 },
      file: { name: 'notes "v2" ✓.txt', type: 'text/plain', data: bytes.toString('base64') },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const stored = row(db);
    assert.equal(stored.data, null);
    assert.match(stored.object_key ?? '', /^files\/files\/-\/attachment\/[0-9a-f-]{36}$/);
    assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(stored.byte_size, bytes.byteLength);
    const object = s3.objects.get(stored.object_key!);
    assert.deepEqual(object?.bytes, bytes);
    // Never served under the uploader's claim, should the bucket be public by mistake.
    assert.equal(object?.type, 'application/octet-stream');

    const got = await download(key(1));
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('content-security-policy') ?? '', /^sandbox/);
    assert.equal(got.headers.get('accept-ranges'), 'bytes');
    assert.equal(
      got.headers.get('content-disposition'),
      `attachment; filename="notes _v2_ _.txt"; filename*=UTF-8''notes%20%22v2%22%20%E2%9C%93.txt`,
    );
    const etag = got.headers.get('etag');
    assert.ok(etag);

    // A range is the bucket's to cut: asked of it, and its 206 passed on.
    const part = await download(key(1), { range: 'bytes=5-9' });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 5-9/${bytes.byteLength}`);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(5, 10));
    assert.ok(s3.seen.some((request) => request.method === 'GET' && request.range === 'bytes=5-9'));
    assert.equal((await download(key(1), { range: 'bytes=900-' })).status, 416);

    // The same tag is a 304, and HEAD sends headers alone.
    assert.equal((await download(key(1), { 'if-none-match': etag! })).status, 304);
    const head = await download(key(1), {}, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(Buffer.from(await head.arrayBuffer()).byteLength, 0);
  });
});

test('a database-kept file answers a range too, and a picture drawn in place is sniffed and tagged from the bucket bytes', async () => {
  await serve(async ({ upload, download }) => {
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'p.png', data: PNG.toString('base64') } })).status,
      200,
    );
    const inline = await download(`${key(1)}&inline=1`);
    assert.equal(inline.status, 200);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline;/);
    const tag = inline.headers.get('etag');
    assert.equal((await download(`${key(1)}&inline=1`, { 'if-none-match': tag! })).status, 304);
    // At a width: the resize cache works off the bucket's bytes (or sends them as they are without sharp).
    const sized = await download(`${key(1)}&inline=1&w=320`);
    assert.equal(sized.status, 200);
    assert.match(sized.headers.get('content-type') ?? '', /^image\//);
  });
  await serve(async ({ upload, download, db }) => {
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.bin', data: bytes.toString('base64') } })).status,
      200,
    );
    assert.ok(row(db).data);
    assert.equal(s3.objects.size, 0);
    const part = await download(key(1), { range: 'bytes=-5' });
    assert.equal(part.status, 206);
    assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(bytes.byteLength - 5));
    assert.equal((await download(key(1), { range: 'bytes=999-' })).status, 416);
  }, definition('database'));
});

test('presign: a download redirects to a URL signed for a minute, whose reply the signature fixes', async () => {
  await serve(
    async ({ upload, download }) => {
      assert.equal(
        (
          await upload({
            table: 'attachment',
            values: { issue_id: 1 },
            file: { name: 'r.txt', type: 'text/html', data: bytes.toString('base64') },
          })
        ).status,
        200,
      );
      const redirect = await download(key(1));
      assert.equal(redirect.status, 302);
      assert.equal(redirect.headers.get('cache-control'), 'private, no-store');
      const location = new URL(redirect.headers.get('location')!);
      assert.equal(location.searchParams.get('X-Amz-Expires'), '60');
      const followed = await fetch(location);
      assert.equal(followed.status, 200);
      assert.deepEqual(Buffer.from(await followed.arrayBuffer()), bytes);
      assert.match(followed.headers.get('content-disposition') ?? '', /^attachment; filename="r\.txt"/);
      // Changing what the signature fixes is refused by the bucket.
      location.searchParams.set('response-content-disposition', 'inline');
      assert.equal((await fetch(location)).status, 403);
      // A picture asked for in place still comes through the server, to be sniffed and sized.
      assert.equal((await download(`${key(1)}&inline=1`)).status, 200);
    },
    definition('bucket', { presign: true }),
  );
});

test('a refused row deletes its object; a bucket that is down stores nothing; access is decided by the row as before', async () => {
  await serve(async ({ upload, download, db }) => {
    // The issue does not exist: the insert is refused, and the object stored for it goes.
    const refused = await upload({ table: 'attachment', values: { issue_id: 99 }, file: { name: 'a.txt', data: 'aGk=' } });
    assert.ok(refused.status !== 200 || refused.body.errors, JSON.stringify(refused.body));
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n), 0);
    assert.equal(s3.objects.size, 0);
    assert.ok(s3.seen.some((request) => request.method === 'DELETE'));

    s3.failing = true;
    const down = await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.txt', data: 'aGk=' } });
    assert.equal(down.status, 503);
    assert.doesNotMatch(down.body.error, /tw-files|AKID/);
    assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n), 0);
    s3.failing = false;

    // No row: no file, and the bucket is not asked.
    s3.seen.length = 0;
    assert.equal((await download(key(7))).status, 404);
    assert.equal(s3.seen.length, 0);

    // A row naming another App's, another tenant's or another resource's object reads as no file.
    s3.objects.set('files/other-app/-/attachment/00000000-0000-4000-8000-000000000000', {
      bytes: Buffer.from('secret'),
      lastModified: new Date(),
      type: '',
    });
    for (const [id, object] of [
      [2, 'files/other-app/-/attachment/00000000-0000-4000-8000-000000000000'],
      [3, 'files/files/tenant-a/attachment/00000000-0000-4000-8000-000000000000'],
      [4, 'files/files/-/issue/00000000-0000-4000-8000-000000000000'],
      [5, 'files/files/-/attachment/../../other-app/-/attachment/00000000-0000-4000-8000-000000000000'],
    ] as const) {
      db.prepare("INSERT INTO attachment (id, issue_id, file_name, object_key) VALUES (?, 1, 'x', ?)").run(id, object);
      assert.equal((await download(key(id))).status, 404, object);
    }
    assert.equal(s3.seen.filter((request) => request.method === 'GET').length, 0);
  });
});

test('without credentials an upload is refused before anything is stored', async () => {
  const saved = process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey];
  delete process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey];
  try {
    await serve(async ({ upload, db }) => {
      const sent = await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.txt', data: 'aGk=' } });
      assert.equal(sent.status, 503);
      assert.equal(Number((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n), 0);
      assert.equal(s3.seen.length, 0);
    });
  } finally {
    process.env[S3_CREDENTIAL_VARIABLES.secretAccessKey] = saved;
  }
});

test('keys are filed by App, tenant and resource, and a reader accepts only its own', () => {
  const rule = { resource: 'attachment', bucket: { name: 'b', prefix: 'p/' } };
  const a = newObjectKey(rule, { app: 'desk', tenant: 'acme' });
  const b = newObjectKey(rule, { app: 'desk', tenant: 'globex' });
  assert.match(a, /^p\/desk\/acme\/attachment\/[0-9a-f-]{36}$/);
  assert.notEqual(a, newObjectKey(rule, { app: 'desk', tenant: 'acme' }));
  assert.ok(objectBelongs(rule, { app: 'desk', tenant: 'acme' }, a));
  assert.ok(!objectBelongs(rule, { app: 'desk', tenant: 'globex' }, a));
  assert.ok(!objectBelongs(rule, { app: 'desk' }, a));
  assert.ok(!objectBelongs(rule, { app: 'other', tenant: 'acme' }, a));
  assert.ok(!objectBelongs({ ...rule, resource: 'photo' }, { app: 'desk', tenant: 'acme' }, a));
  // The platform realm reads any tenant's of its own App, and nothing else.
  assert.ok(objectBelongs(rule, { app: 'desk', anyTenant: true }, a));
  assert.ok(objectBelongs(rule, { app: 'desk', anyTenant: true }, b));
  assert.ok(!objectBelongs(rule, { app: 'desk', anyTenant: true }, newObjectKey(rule, { app: 'desk' })));
  assert.ok(!objectBelongs(rule, { app: 'other', anyTenant: true }, a));
  // A tenant id with a slash stays one segment: it cannot reach into another tenant's prefix.
  assert.match(newObjectKey(rule, { app: 'desk', tenant: 'acme/attachment' }), /^p\/desk\/acme%2Fattachment\/attachment\//);
  assert.ok(!objectBelongs(rule, { app: 'desk', tenant: 'acme' }, `${a}/x`));
  // Nor can one climb out: a dot segment is spelled escaped, and the platform realm refuses one a row names.
  const dots = newObjectKey(rule, { app: 'desk', tenant: '..' });
  assert.match(dots, /^p\/desk\/%2E%2E\/attachment\/[0-9a-f-]{36}$/);
  assert.ok(objectBelongs(rule, { app: 'desk', tenant: '..' }, dots));
  assert.ok(!objectBelongs(rule, { app: 'desk', anyTenant: true }, `p/desk/../attachment/${a.split('/').at(-1)}`));
  assert.ok(!objectBelongs(rule, { app: 'desk', anyTenant: true }, `p/desk/./attachment/${a.split('/').at(-1)}`));
});

test('migrate files: status, up to the bucket and back, resumable, dry runs, and the sweep', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-migrate-'));
  const appDir = join(directory, 'app');
  mkdirSync(appDir);
  const file = join(directory, 'files.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  const insert = db.prepare('INSERT INTO attachment (issue_id, file_name, data, byte_size) VALUES (1, ?, ?, ?)');
  for (let i = 0; i < 5; i++) insert.run(`f${i}.bin`, Buffer.from(`file ${i} `.repeat(i + 1)), 0);
  const writeApp = (storage: 'bucket' | 'database') => writeFileSync(join(appDir, 'app.json'), JSON.stringify(definition(storage)));
  const run = async (...argv: string[]) => {
    const lines: string[] = [];
    const code = await runMigrate(['files', ...argv, '--app', appDir, file], (line) => lines.push(line), undefined, MIGRATE_APPS);
    return { code, text: lines.join('\n') };
  };
  try {
    writeApp('bucket');
    let said = await run('status');
    assert.equal(said.code, 0, said.text);
    assert.match(
      said.text,
      /attachment: 5 files in the database, 0 in the bucket tw-files; new files go to the bucket tw-files, 5 to move/,
    );

    said = await run('up', '--dry-run');
    assert.match(said.text, /would move 5 files/);
    assert.equal(s3.objects.size, 0);

    // A bucket that fails part way: what moved stays moved, the rest is left, and the run says so.
    let puts = 0;
    s3.refuse = (method) => method === 'PUT' && ++puts > 2;
    try {
      said = await run('up');
    } finally {
      s3.refuse = undefined;
    }
    assert.equal(said.code, 3, said.text);
    assert.match(said.text, /moved 2 files .*3 left where they are/);
    const count = (where: string) => Number((db.prepare(`SELECT COUNT(*) AS n FROM attachment WHERE ${where}`).get() as { n: number }).n);
    assert.equal(count('object_key IS NOT NULL AND data IS NULL'), 2);

    // Run again: only what is left moves.
    said = await run('up');
    assert.equal(said.code, 0, said.text);
    assert.match(said.text, /moved 3 files/);
    assert.equal(count('object_key IS NOT NULL AND data IS NULL'), 5);
    assert.equal(count('sha256 IS NOT NULL'), 5);
    assert.equal(s3.objects.size, 5);
    const first = db.prepare('SELECT object_key FROM attachment WHERE id = 3').get() as { object_key: string };
    assert.deepEqual(s3.objects.get(first.object_key)?.bytes, Buffer.from('file 2 '.repeat(3)));
    said = await run('status');
    assert.match(said.text, /Every file is where its storage says/);

    // The sweep: an orphan older than an hour goes, a young one and every named one stay.
    const orphan = 'files/files/-/attachment/11111111-1111-4111-8111-111111111111';
    const young = 'files/files/-/attachment/22222222-2222-4222-8222-222222222222';
    s3.objects.set(orphan, { bytes: Buffer.from('gone'), lastModified: new Date(Date.now() - 2 * 3600_000), type: '' });
    s3.objects.set(young, { bytes: Buffer.from('fresh'), lastModified: new Date(), type: '' });
    s3.objects.set('files/elsewhere/x', { bytes: Buffer.from('not ours'), lastModified: new Date(0), type: '' });
    // Pre-made copies of a public picture sit beside the App's folder, named by hash: a live hash's stay, a dead one's go.
    const liveHash = imageHashOfHex((db.prepare('SELECT sha256 FROM attachment WHERE id = 3').get() as { sha256: string }).sha256)!;
    const deadHash = 'A'.repeat(32);
    const old = new Date(Date.now() - 2 * 3600_000);
    const copy = (hash: string, name: string) =>
      s3.objects.set(`files/_variants/files/${hash}${name}`, { bytes: Buffer.from('v'), lastModified: old, type: '' });
    copy(liveHash, '-640.webp');
    copy(liveHash, '.json');
    copy(deadHash, '-640.webp');
    copy(deadHash, '.json');
    said = await run('sweep', '--dry-run');
    assert.match(said.text, /would delete files\/files\/-\/attachment\/1111/);
    assert.match(said.text, /would delete files\/_variants\/files\/A{32}-640\.webp/);
    assert.ok(s3.objects.has(orphan));
    assert.ok(s3.objects.has(`files/_variants/files/${deadHash}.json`), 'a dry run deletes nothing');
    said = await run('sweep');
    assert.match(said.text, /4 pre-made copies; deleted 2/);
    assert.ok(!s3.objects.has(`files/_variants/files/${deadHash}-640.webp`) && !s3.objects.has(`files/_variants/files/${deadHash}.json`));
    assert.ok(s3.objects.has(`files/_variants/files/${liveHash}-640.webp`) && s3.objects.has(`files/_variants/files/${liveHash}.json`));
    assert.equal(said.code, 0, said.text);
    assert.match(said.text, /7 objects, 5 named by a row; deleted 1, kept 1 written in the last hour/);
    assert.ok(!s3.objects.has(orphan));
    assert.ok(s3.objects.has(young));
    assert.ok(s3.objects.has('files/elsewhere/x'));

    // And back: storage says the database, the bucket still named so its objects can be read.
    writeApp('database');
    said = await run('up');
    assert.equal(said.code, 0, said.text);
    assert.match(said.text, /moved 5 files .* to the database/);
    assert.equal(count('data IS NOT NULL AND object_key IS NULL'), 5);
    assert.deepEqual(
      Buffer.from((db.prepare('SELECT data FROM attachment WHERE id = 3').get() as { data: Uint8Array }).data),
      Buffer.from('file 2 '.repeat(3)),
    );
    assert.equal([...s3.objects.keys()].filter((each) => each.startsWith('files/files/')).length, 1);
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
    s3.objects.clear();
    s3.seen.length = 0;
  }
});

test('the DSL refuses a bucket without its object column, a bad name, and a content column that cannot be null', () => {
  const base = definition('bucket');
  const withFile = (file: Record<string, unknown>) => ({
    ...base,
    resources: { ...base.resources, attachment: { access: 'write', file: { content: 'data', name: 'file_name', ...file } } },
  });
  assert.throws(() => parseAppConfig(withFile({ storage: 'bucket' }), 'x'), /needs the "bucket" it names/);
  assert.throws(() => parseAppConfig(withFile({ bucket: { name: 'tw-files' } }), 'x'), /needs "object"/);
  assert.throws(() => parseAppConfig(withFile({ object: 'object_key', bucket: { name: 'Bad_Name' } }), 'x'), /must be a bucket name/);
  assert.throws(
    () => parseAppConfig(withFile({ object: 'object_key', bucket: { name: 'tw-files', endpoint: 'https://k:s@r2.example.com' } }), 'x'),
    /no credentials or query/,
  );
  assert.throws(() => parseAppConfig(withFile({ object: 'object_key', storage: 'cloud' }), 'x'), /'database' or 'bucket'/);
});

test('a role that reads and writes only the file column has its object and hash kept for it, and never sees them', async () => {
  const roles = {
    clerk: {
      read: ['issue', 'attachment'],
      write: ['attachment'],
      fields: { attachment: { read: ['id', 'issue_id', 'file_name', 'data'], write: ['issue_id', 'file_name', 'data'] } },
    },
    names: { read: ['issue', 'attachment'], fields: { attachment: { read: ['id', 'issue_id', 'file_name'] } } },
  };
  const base = definition('bucket');
  const app = {
    ...base,
    auth: { roles },
    resources: {
      ...base.resources,
      attachment: {
        access: 'write',
        file: {
          content: 'data',
          name: 'file_name',
          object: 'object_key',
          hash: 'sha256',
          storage: 'bucket',
          bucket: base.resources.attachment.file.bucket,
        },
      },
    },
  };
  let role = 'clerk';
  await serve(
    async ({ upload, download, db, post }) => {
      const sent = await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.bin', data: bytes.toString('base64') } });
      assert.equal(sent.status, 200, JSON.stringify(sent.body));
      assert.match(row(db).object_key ?? '', /^files\/files\/-\/attachment\//);
      assert.equal(row(db).sha256, createHash('sha256').update(bytes).digest('hex'));
      assert.doesNotMatch(JSON.stringify(sent.body), /object_key|sha256|files\/files/);
      const got = await download(key(1));
      assert.equal(got.status, 200);
      assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);

      // Neither the catalog, the App's payload nor a list of the rows names them.
      for (const path of [`/api/schema?app=${appId}`, `/api/app?app=${appId}`]) {
        const text = await (await fetch(`${post.base}${path}`)).text();
        assert.doesNotMatch(text, /object_key|sha256/, path);
      }
      const listed = await post('/api/run', { q: 'attachment', limit: 50, offset: 0, app: appId });
      assert.equal(listed.status, 200, JSON.stringify(listed.body));
      assert.equal(listed.body.rows.length, 1);
      assert.doesNotMatch(JSON.stringify(listed.body), /object_key|sha256|files\/files/);

      // A role that may not read the file is refused it, as it always was.
      role = 'names';
      s3.seen.length = 0;
      assert.notEqual((await download(key(1))).status, 200);
      assert.equal(s3.seen.length, 0);
    },
    app,
    () => ({ id: 'clerk-1', who: 'clerk@example.test', role }),
  );
});

const deletable = () => {
  const app = definition('bucket');
  return { ...app, resources: { ...app.resources, attachment: { ...app.resources.attachment, delete: true } } };
};

test("no door names a file's object or hash: a select, filter, sort, query, export or write of them is refused or finds nothing", async () => {
  await serve(async ({ upload, download, post, db }) => {
    const sent = await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.txt', data: bytes.toString('base64') } });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const stored = row(db);
    const objectKey = stored.object_key!;
    const uuid = objectKey.split('/').at(-1)!;
    const leaks = (reply: unknown) => /object_key|sha256/.test(JSON.stringify(reply)) || JSON.stringify(reply).includes(uuid);
    const refused = async (path: string, body: object) => {
      const reply = await post(path, { app: appId, ...body });
      assert.notEqual(reply.status, 200, `${path} ${JSON.stringify(body)} answered ${JSON.stringify(reply.body)}`);
      assert.ok(!JSON.stringify(reply.body).includes(uuid), path);
    };
    const filterOn = (column: string, value: string) => ({ groups: [[{ column, op: '=', value }]] });

    // Structured reads: a column, a filter, a sort, a count.
    await refused('/api/query', { table: 'attachment', columns: ['id', 'object_key'], limit: 5, offset: 0 });
    await refused('/api/query', { table: 'attachment', columns: ['id', 'sha256'], limit: 5, offset: 0 });
    await refused('/api/query', { table: 'attachment', filter: filterOn('object_key', objectKey), limit: 5, offset: 0 });
    await refused('/api/query', { table: 'attachment', filter: filterOn('sha256', stored.sha256!), limit: 5, offset: 0 });
    await refused('/api/query', { table: 'attachment', orderBy: [{ column: 'object_key', direction: 'asc' }], limit: 5, offset: 0 });
    await refused('/api/count', { table: 'attachment', filter: filterOn('object_key', objectKey) });
    // The default projection and the record read leave them out.
    const whole = await post('/api/query', { app: appId, table: 'attachment', limit: 5, offset: 0 });
    assert.equal(whole.status, 200, JSON.stringify(whole.body));
    assert.equal(whole.body.rows.length, 1);
    assert.ok(!leaks(whole.body), JSON.stringify(whole.body));

    // The query language: a column, a condition, a sort, a word — none reaches them.
    await refused('/api/run', { q: 'attachment', columns: ['object_key'], limit: 5, offset: 0 });
    for (const q of [
      `attachment object_key = "${objectKey}"`,
      `attachment sha256 = "${stored.sha256}"`,
      'attachment sort object_key',
      `attachment ${uuid}`,
    ]) {
      const reply = await post('/api/run', { app: appId, q, limit: 5, offset: 0 });
      // Refused as a column that is not there, which may say its name; never a row's value.
      assert.ok(!JSON.stringify(reply.body.rows ?? []).includes(uuid), `${q}: ${JSON.stringify(reply.body)}`);
      assert.ok(reply.status !== 200 || reply.body.errors?.length || !reply.body.rows?.length, `${q}: ${JSON.stringify(reply.body)}`);
    }

    // An export: asked for by name, refused; whole, without them.
    await refused('/api/export', { q: 'attachment', format: 'json', columns: ['id', 'object_key'] });
    const exported = await fetch(`${post.base}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: appId, q: 'attachment', format: 'csv' }),
    });
    assert.equal(exported.status, 200);
    const csv = await exported.text();
    assert.match(csv, /file_name/);
    assert.ok(!/object_key|sha256/.test(csv) && !csv.includes(uuid), csv);

    // Writes: no insert or update sets them, so no row is pointed at another's object.
    const other = 'files/files/-/attachment/55555555-5555-4555-8555-555555555555';
    await refused('/api/update', { table: 'attachment', key: { id: 1 }, values: { object_key: other } });
    await refused('/api/update', { table: 'attachment', key: { id: 1 }, values: { sha256: 'x' } });
    await refused('/api/insert', { table: 'attachment', values: { issue_id: 1, file_name: 'b.txt', object_key: objectKey } });
    assert.equal(row(db).object_key, objectKey);
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n, 1);
    // The file's other columns are still the reader's to edit, its object and hash kept as they were.
    const renamed = await post('/api/update', { app: appId, table: 'attachment', key: { id: 1 }, values: { file_name: 'renamed.txt' } });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.ok(!leaks(renamed.body), JSON.stringify(renamed.body));
    assert.equal(row(db).object_key, objectKey);
    // The file itself is still the server's to read, and the row still the reader's to delete.
    assert.equal((await download(key(1))).status, 200);
    const removed = await post('/api/delete', { app: appId, table: 'attachment', key: { id: 1 }, confirm: true });
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n, 0);
  }, deletable());
});

test("the App API and its MCP tools refuse to expose or write a file's object or hash", () => {
  const column = (name: string, type = 'TEXT', primaryKey = false) => ({ name, type, nullable: !primaryKey, primaryKey });
  const schema: DatabaseSchema = {
    label: 'Files',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [],
    tables: [
      {
        id: 'attachment',
        name: 'attachment',
        schema: '',
        isView: false,
        columns: [column('id', 'INTEGER', true), column('file_name'), column('data', 'BLOB'), column('object_key'), column('sha256')],
      },
    ],
  };
  const app = (fields: string[], write = false) =>
    parseAppConfig(
      {
        id: 'files',
        name: 'Files',
        sources: { main: { connection: 'files', default: true } },
        resources: { attachment: { access: 'write', file: { content: 'data', name: 'file_name', object: 'object_key', hash: 'sha256' } } },
        auth: { roles: { reader: { read: true, write: true } } },
        views: { attachments: { kind: 'list', from: 'attachment' } },
        home: 'attachments',
        api: { version: 1, roles: ['reader'], resources: { attachment: { fields, ...(write ? { update: true } : {}) } } },
      },
      'api',
    );
  assert.doesNotThrow(() => checkApiReadCatalog(app(['id', 'file_name']).api!, app(['id', 'file_name']), schema));
  for (const field of ['object_key', 'sha256'])
    assert.throws(
      () => checkApiReadCatalog(app(['id', field]).api!, app(['id', field]), schema),
      /file's own (object|hash) column, which only the server reads/,
    );
  assert.ok(
    apiWriteProblems(app(['id', 'file_name', 'object_key'], true), schema).some((problem) =>
      /"object_key" is the file's own column/.test(problem),
    ),
  );
  assert.ok(!apiWriteProblems(app(['id', 'file_name'], true), schema).some((problem) => /file's own column/.test(problem)));
});

test("a tenant App is swept tenant by tenant, and one tenant's sweep cannot delete another's object", async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-tenant-sweep-'));
  try {
    const file = join(directory, 'files.db');
    const db = new DatabaseSync(file);
    db.exec(`CREATE TABLE issue (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, name TEXT NOT NULL);
      CREATE TABLE attachment (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, issue_id INTEGER NOT NULL REFERENCES issue(id),
        file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB, object_key TEXT, sha256 TEXT);
      INSERT INTO issue VALUES (1, 'acme', 'First');`);
    const parsed = parseAppConfig(definition('bucket'), 'tenant sweep');
    const app = { ...parsed, auth: { ...parsed.auth, rows: 'tenant' as const } } as typeof parsed;
    const rule = { resource: 'attachment', bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'files/' } };
    const old = new Date(Date.now() - 2 * 3600_000);
    const put = (key: string) => s3.objects.set(key, { bytes: Buffer.from(key), lastModified: old, type: '' });
    const acmeNamed = newObjectKey(rule, { app: appId, tenant: 'acme' });
    const acmeOrphan = newObjectKey(rule, { app: appId, tenant: 'acme' });
    const globexNamed = newObjectKey(rule, { app: appId, tenant: 'globex' });
    const globexOrphan = newObjectKey(rule, { app: appId, tenant: 'globex' });
    const globexLoose = newObjectKey(rule, { app: appId, tenant: 'globex' });
    for (const key of [acmeNamed, acmeOrphan, globexNamed, globexOrphan, globexLoose]) put(key);
    const insert = db.prepare("INSERT INTO attachment (tenant_id, issue_id, file_name, object_key) VALUES (?, 1, 'f', ?)");
    insert.run('acme', acmeNamed);
    insert.run('globex', globexNamed);
    // A row of acme's naming globex's orphan is acme's mistake: it keeps nothing of globex's, and lets acme's run delete nothing there.
    insert.run('acme', globexOrphan);
    db.close();

    const ownership = {
      ownership: { issue: { kind: 'tenant', column: 'tenant_id' }, attachment: { kind: 'tenant', column: 'tenant_id' } },
    };
    const [job] = tenantFilesSweep(app, ownership as never, { path: file });
    assert.equal(job.id, FILES_SWEEP_JOB);
    assert.equal(job.realm, 'tenant');
    assert.deepEqual(tenantFilesSweep({ ...app, resources: { issue: {} } } as typeof app, ownership as never, { path: file }), []);

    await job.run('acme');
    assert.ok(!s3.objects.has(acmeOrphan), "acme's orphan is swept");
    assert.ok(s3.objects.has(acmeNamed));
    assert.ok(
      s3.objects.has(globexNamed) && s3.objects.has(globexOrphan) && s3.objects.has(globexLoose),
      "nothing of globex's is touched by acme's run, not even an object no row names",
    );

    await job.run('globex');
    assert.ok(!s3.objects.has(globexOrphan) && !s3.objects.has(globexLoose), "globex's own run sweeps what no globex row names");
    assert.ok(s3.objects.has(globexNamed) && s3.objects.has(acmeNamed));
    assert.match(
      unsweptBuckets([app], false).join('\n'),
      /--policy <file>` daily, or serve it with jobs, which sweep it each day, tenant by tenant/,
    );
    assert.equal(unsweptBuckets([app], true).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    s3.objects.clear();
    s3.seen.length = 0;
  }
});

test('a server whose App keeps files in a bucket does not start without the credentials, and says which to set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-start-'));
  try {
    const appDir = join(directory, 'app');
    mkdirSync(appDir);
    writeFileSync(join(appDir, 'app.json'), JSON.stringify(definition('bucket')));
    const file = join(directory, 'files.db');
    const db = new DatabaseSync(file);
    db.exec(SQL);
    db.close();
    const env: NodeJS.ProcessEnv = { ...process.env, MISTRI_OPEN: '0' };
    for (const name of Object.values(S3_CREDENTIAL_VARIABLES)) delete env[name];
    const root = fileURLToPath(new URL('..', import.meta.url));
    const started = spawnSync(
      process.execPath,
      ['--import', import.meta.resolve('tsx'), join(root, 'packages/mistri/src/server/index.ts'), '--app', appDir, file, '--port', '0'],
      { cwd: directory, encoding: 'utf8', timeout: 30_000, env },
    );
    assert.equal(started.status, 1, started.stderr);
    assert.match(
      started.stderr,
      /bucket "tw-files", and this server has no credentials for it: set MISTRI_S3_ACCESS_KEY_ID and MISTRI_S3_SECRET_ACCESS_KEY/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the startup probe warns of a bucket that does not answer, and is quiet about one that does', async () => {
  const lines: string[] = [];
  const app = parseAppConfig(definition('bucket'), 'probe');
  await probeBuckets([app], (line) => lines.push(line));
  assert.equal(lines.length, 0, lines.join(' // '));
  assert.ok(s3.seen.some((request) => request.method === 'GET' && !request.key));
  s3.failing = true;
  try {
    await probeBuckets([app], (line) => lines.push(line));
  } finally {
    s3.failing = false;
    s3.seen.length = 0;
  }
  assert.equal(lines.length, 1);
  assert.match(
    lines[0],
    /^mistri: warning: the bucket "tw-files" did not answer .*files of attachment cannot be stored or read until it does\.$/,
  );
  assert.equal(bucketCredentialsProblem([app], {}), bucketCredentialsProblem([app], { MISTRI_S3_ACCESS_KEY_ID: 'x' }));
  assert.equal(bucketCredentialsProblem([app], { MISTRI_S3_ACCESS_KEY_ID: 'x', MISTRI_S3_SECRET_ACCESS_KEY: 'y' }), undefined);
  assert.equal(
    bucketCredentialsProblem([parseAppConfig(definition('database', {}), 'kept')], {}) !== undefined,
    true,
    'a bucket still named can hold objects rows name',
  );
});

test(
  'a served App with jobs sweeps its bucket itself, once a day at a minute its id picks; one without hears how to',
  { timeout: 300_000 },
  async (t) => {
    // The jitter: a daily cron whose minute differs between Apps.
    assert.match(filesSweepEvery('files'), /^\d{1,2} \d{1,2} \* \* \*$/);
    assert.notEqual(filesSweepEvery('files'), filesSweepEvery('files-2'));
    const plain = parseAppConfig(definition('bucket'), 'advisory');
    assert.match(unsweptBuckets([plain], false).join('\n'), /run `mistri migrate files sweep --app <dir>` daily, or serve it with jobs/);
    assert.deepEqual(unsweptBuckets([plain], true).length, 0);

    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-s3-sweep-job-'));
    let child: ChildProcess | undefined;
    t.after(async () => {
      if (child && child.exitCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGTERM');
        await closed;
      }
      rmSync(directory, { recursive: true, force: true });
      s3.objects.clear();
      s3.seen.length = 0;
    });
    const root = fileURLToPath(new URL('..', import.meta.url));
    const src = (path: string) => JSON.stringify(pathToFileURL(join(root, path)).href);
    const file = join(directory, 'files.db');
    const raw = new DatabaseSync(file);
    raw.exec(SQL);
    raw.close();
    migrateSqliteCommandJournal(file);
    const appDir = join(directory, 'app');
    mkdirSync(appDir);
    const { connection: _, ...app } = definition('bucket');
    writeFileSync(
      join(appDir, 'app.json'),
      JSON.stringify({
        ...app,
        sources: { main: { connection: owner, default: true } },
        auth: { providers: ['email'], store: join(directory, 'auth.db'), roles: { automation: { read: true, commands: ['noop'] } } },
      }),
    );
    writeFileSync(
      join(appDir, 'commands.mjs'),
      `import { defineCommand, defineCommands } from ${src('packages/mistri/src/server/commands.ts')};
export default defineCommands({ noop: defineCommand({ source: 'main', target: 'issue', targets: 'none', async handle() {} }) });
`,
    );
    // The App's one job, once a year: the sweep beside it is the server's.
    writeFileSync(
      join(appDir, 'jobs.mjs'),
      `import { defineJob, defineJobs } from ${src('packages/mistri/src/server/jobs.ts')};
export default defineJobs({ yearly: defineJob({ every: '0 0 1 1 *', runAs: 'clock', command: 'noop' }) },
  { principals: { clock: { roles: ['automation'] } }, store: { namespace: 'files' } });
`,
    );
    const commands = (await import(pathToFileURL(join(appDir, 'commands.mjs')).href)).default;
    const jobs = (await import(pathToFileURL(join(appDir, 'jobs.mjs')).href)).default;
    await provisionStores({ sqlite: file }, { app: { id: appId, commands }, jobs });
    /* The store has swept before, ten days ago: a store with a run of the job catches up its latest missed slot on
       start, where a fresh one would wait for the next (jobHost.ts). */
    const store = openSqliteJobStore(file, jobStorePolicy(capturedJobModule(jobs), appId));
    const before = Date.now() - 10 * 86_400_000;
    await store.enqueue(
      {
        job: FILES_SWEEP_JOB,
        version: 1,
        idempotencyKey: `every-${String(Math.floor(before / 60_000) * 60_000).padStart(16, '0')}`,
        input: { key: {}, input: {} },
        runAt: before,
        provenance: { appId, actorId: 'service:mistri', correlationId: 'earlier-sweep', causationId: 'earlier-sweep' },
      },
      before,
    );
    const [earlier] = await store.claim(before);
    await store.succeed(earlier.id, earlier.fence, before + 1);
    await store.close();
    const config = join(directory, 'mistri.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: owner, url: file, writable: true }] }));

    // An orphan past the grace, and an object a row names: a start runs the latest missed daily slot.
    const orphan = 'files/files/-/attachment/33333333-3333-4333-8333-333333333333';
    const kept = 'files/files/-/attachment/44444444-4444-4444-8444-444444444444';
    const old = new Date(Date.now() - 2 * 3600_000);
    s3.objects.set(orphan, { bytes: Buffer.from('gone'), lastModified: old, type: '' });
    s3.objects.set(kept, { bytes: Buffer.from('kept'), lastModified: old, type: '' });
    const named = new DatabaseSync(file);
    named.prepare("INSERT INTO attachment (issue_id, file_name, object_key, sha256, byte_size) VALUES (1, 'k.bin', ?, 'x', 4)").run(kept);
    named.close();

    // An App with sign-in keeps its port: ask the system for a free one.
    const probe = createServer();
    await new Promise<void>((done) => probe.listen(0, '127.0.0.1', done));
    const { port } = probe.address() as { port: number };
    await new Promise<void>((done) => probe.close(() => done()));
    let log = '';
    child = spawn(
      process.execPath,
      [
        '--import',
        import.meta.resolve('tsx'),
        join(root, 'packages/mistri/src/server/index.ts'),
        '--config',
        config,
        '--app',
        appDir,
        '--jobs',
        join(appDir, 'jobs.mjs'),
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
      ],
      {
        cwd: directory,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          MISTRI_OPEN: '0',
          XDG_CONFIG_HOME: join(directory, 'config'),
          BETTER_AUTH_SECRET: 'synthetic-sweep-secret-at-least-thirty-two-characters',
        },
      },
    );
    child.stdout!.on('data', (chunk) => (log += String(chunk)));
    child.stderr!.on('data', (chunk) => (log += String(chunk)));
    const deadline = Date.now() + 240_000;
    while (s3.objects.has(orphan) && child.exitCode === null && Date.now() < deadline) await new Promise((done) => setTimeout(done, 250));
    assert.ok(!s3.objects.has(orphan), log);
    assert.ok(s3.objects.has(kept), log);
    assert.match(log, new RegExp(`the jobs sweep files's buckets each day at ${filesSweepEvery('files')}`));
    assert.doesNotMatch(log, /nothing in this server sweeps it/);
    const check = new DatabaseSync(file, { readOnly: true });
    try {
      check.exec('PRAGMA busy_timeout = 5000');
      const swept = () => check.prepare(`SELECT state FROM "${JOB_TABLES.job}" WHERE job = ?`).all(FILES_SWEEP_JOB) as { state: string }[];
      while (swept().filter((row) => row.state === 'succeeded').length < 2 && Date.now() < deadline)
        await new Promise((done) => setTimeout(done, 250));
      assert.deepEqual(
        swept().map((row) => row.state),
        ['succeeded', 'succeeded'],
        log,
      );
    } finally {
      check.close();
    }
  },
);
