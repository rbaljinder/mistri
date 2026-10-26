import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { appFileRules, parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { sniffImage } from '../packages/mistri/src/server/http/imageSniff.js';

/* An issue tracker whose attachments are rows: the bytes in a BLOB, the name,
   type and size beside them, each file bound to its issue. */
const appId = 'files';
const owner = 'files-db';
const APP = {
  id: appId,
  name: 'Files',
  connection: owner,
  resources: {
    issue: { access: 'write' },
    attachment: { access: 'write', file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', maxBytes: 1024 } },
    note: { access: 'write' },
  },
  views: { issues: { kind: 'list', from: 'issue', label: 'Issues' } },
  home: 'issues',
  nav: ['issues'],
};
const SQL = `CREATE TABLE issue (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE attachment (id INTEGER PRIMARY KEY, issue_id INTEGER NOT NULL REFERENCES issue(id), file_name TEXT NOT NULL,
    content_type TEXT, byte_size INTEGER, data BLOB NOT NULL, label TEXT, thumb BLOB);
  CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);
  INSERT INTO issue VALUES (1, 'First');`;

async function fixture(
  run: (f: {
    upload: (body: object) => Promise<{ status: number; body: any }>;
    download: (query: string, headers?: Record<string, string>) => Promise<Response>;
    db: DatabaseSync;
  }) => Promise<void>,
  app: object = APP,
) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-files-http-'));
  const file = join(directory, 'files.db');
  const db = new DatabaseSync(file);
  db.exec(SQL);
  const registry = new Registry();
  registry.add({ id: owner, name: 'Files', url: file, source: 'config', writable: true });
  const definition = parseAppConfig(app, 'files fixture');
  const pages = parsePagesConfig({ pages: [] }, 'files pages');
  const host: AppHost = { app: { path: 'files-fixture.ts', app: definition, pages, sources: {} }, pages };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const base = `http://${bound.host}:${bound.port}`;
  try {
    await run({
      db,
      upload: async (body) => {
        const response = await fetch(`${base}/api/file/upload`, {
          method: 'POST',
          signal: AbortSignal.timeout(5000),
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ app: appId, ...body }),
        });
        return { status: response.status, body: await response.json() };
      },
      download: (query, headers = {}) => fetch(`${base}/api/file?app=${appId}&${query}`, { headers, signal: AbortSignal.timeout(5000) }),
    });
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
    registry.closeAll?.();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
}

const bytes = Buffer.from([0, 1, 2, 250, 255, ...Buffer.from(' hello')]);
const key = (id: number) => `table=attachment&key=${encodeURIComponent(JSON.stringify({ id }))}`;
const count = (db: DatabaseSync) => Number((db.prepare('SELECT COUNT(*) AS n FROM attachment').get() as { n: number }).n);

test('a file uploads as one ordinary insert and comes back as the same bytes, always as a download', async () => {
  await fixture(async ({ upload, download, db }) => {
    const sent = await upload({
      table: 'attachment',
      values: { issue_id: 1 },
      file: { name: 'notes "v2" ✓.txt', type: 'text/plain', data: bytes.toString('base64') },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    const stored = db
      .prepare('SELECT issue_id, file_name, content_type, byte_size, typeof(data) AS kind, hex(data) AS hex FROM attachment')
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...stored },
      {
        issue_id: 1,
        file_name: 'notes "v2" ✓.txt',
        content_type: 'text/plain',
        byte_size: bytes.byteLength,
        kind: 'blob',
        hex: bytes.toString('hex').toUpperCase(),
      },
    );

    const got = await download(key(1));
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    // Never the uploader's claim: a download is bytes, whatever it said it was.
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.match(got.headers.get('content-security-policy') ?? '', /^sandbox/);
    assert.equal(
      got.headers.get('content-disposition'),
      `attachment; filename="notes _v2_ _.txt"; filename*=UTF-8''notes%20%22v2%22%20%E2%9C%93.txt`,
    );
    // Loaded by a page as code, it is refused before anything is read.
    for (const dest of ['script', 'style']) {
      const asCode = await download(key(1), { 'sec-fetch-dest': dest });
      assert.equal(asCode.status, 403, dest);
      await asCode.arrayBuffer();
    }
  });
});

test('an upload past the cap, into a resource that holds no files, or naming the file columns writes nothing', async () => {
  await fixture(async ({ upload, db }) => {
    const over = await upload({
      table: 'attachment',
      values: { issue_id: 1 },
      file: { name: 'big.bin', data: Buffer.alloc(1025).toString('base64') },
    });
    assert.equal(over.status, 413);
    assert.match(over.body.error, /"big\.bin" is .* this App takes files up to/);
    assert.equal((await upload({ table: 'note', values: {}, file: { name: 'a.txt', data: 'aGk=' } })).status, 404);
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1, file_name: 'forged' }, file: { name: 'a.txt', data: 'aGk=' } })).status,
      400,
    );
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.txt', data: 'not base64!' } })).status,
      400,
    );
    assert.equal((await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: '   ', data: 'aGk=' } })).status, 400);
    assert.equal(count(db), 0);
  });
});

test('a type that is not a plain media type is kept as octet-stream, and the server says only that', async () => {
  await fixture(async ({ upload, download }) => {
    assert.equal(
      (
        await upload({
          table: 'attachment',
          values: { issue_id: 1 },
          file: { name: 'page.html', type: 'text/html; charset=utf-8', data: 'PGI+aGk8L2I+' },
        })
      ).status,
      200,
    );
    const got = await download(key(1));
    assert.equal(got.headers.get('content-type'), 'application/octet-stream');
    assert.match(got.headers.get('content-disposition') ?? '', /^attachment;/);
  });
});

test('a download is the ordinary read: a key that names no record, or a resource without files, gets nothing', async () => {
  await fixture(async ({ upload, download }) => {
    await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.txt', data: 'aGk=' } });
    assert.equal((await download(key(99))).status, 404);
    assert.equal((await download('table=attachment&key=oops')).status, 400);
    assert.equal((await download(`table=attachment&key=${encodeURIComponent(JSON.stringify({ id: 1, extra: 2 }))}`)).status, 400);
    assert.equal((await download(`table=note&key=${encodeURIComponent(JSON.stringify({ id: 1 }))}`)).status, 404);
  });
});

test('an App whose writes go through the access facade (a machine here) takes uploads the same way', async () => {
  const guarded = {
    ...APP,
    resources: {
      ...APP.resources,
      issue: { access: 'write', machine: { column: 'name', states: { First: { on: { rename: 'Renamed' } }, Renamed: { final: true } } } },
    },
  };
  await fixture(async ({ upload, download, db }) => {
    const sent = await upload({
      table: 'attachment',
      values: { issue_id: 1 },
      file: { name: 'a.bin', type: 'application/octet-stream', data: bytes.toString('base64') },
    });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(count(db), 1);
    assert.deepEqual(Buffer.from(await (await download(key(1))).arrayBuffer()), bytes);
  }, guarded);
});

test('a file block is checked where it is written and against the catalog', async (t) => {
  const resource = (file: unknown) => ({ ...APP, resources: { ...APP.resources, attachment: { access: 'write', file } } });
  assert.throws(() => parseAppConfig(resource({ content: 'data' }), 'x'), /"file" "name" must name a column/);
  assert.throws(
    () => parseAppConfig(resource({ content: 'data', name: 'file_name', maxBytes: 0 }), 'x'),
    /"maxBytes" must be a whole number/,
  );
  assert.throws(
    () => parseAppConfig(resource({ content: 'data', name: 'file_name', maxBytes: 26 * 1024 * 1024 }), 'x'),
    /"maxBytes" must be a whole number/,
  );
  assert.throws(() => parseAppConfig(resource({ content: 'data', name: 'data' }), 'x'), /names one column for two things/);
  assert.throws(() => parseAppConfig(resource({ content: 'data', name: 'file_name', path: 'x' }), 'x'), /path/);

  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-files-schema-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new DatabaseSync(join(directory, 's.db'));
  db.exec(SQL);
  db.close();
  const adapter = new SqliteAdapter(join(directory, 's.db'), 's');
  t.after(() => adapter.close());
  const schema = await adapter.introspect();
  const rules = (file: unknown, extra: object = {}) => appFileRules(parseAppConfig({ ...resource(file), ...extra }, 'x'), schema);
  assert.deepEqual(rules({ content: 'data', name: 'file_name' }).problems, []);
  assert.equal(rules({ content: 'data', name: 'file_name' }).rules.get('attachment')?.maxBytes, 10 * 1024 * 1024);
  assert.match(rules({ content: 'label', name: 'file_name' }).problems[0], /file content "label" is TEXT; the bytes need a binary column/);
  assert.match(rules({ content: 'data', name: 'title' }).problems[0], /file name "title" is not a column of attachment/);
  assert.deepEqual(rules({ content: 'data', name: 'file_name', thumbnail: 'thumb' }).problems, []);
  assert.match(
    rules({ content: 'data', name: 'file_name', thumbnail: 'label' }).problems[0],
    /file thumbnail "label" is TEXT; a picture needs a binary column/,
  );
  assert.match(
    rules({ content: 'data', name: 'file_name', thumbnail: 'small' }).problems[0],
    /file thumbnail "small" is not a column of attachment/,
  );
  assert.throws(
    () => parseAppConfig(resource({ content: 'data', name: 'file_name', thumbnail: 'data' }), 'x'),
    /names one column for two things/,
  );
});

test('variant=thumb sends the smaller copy a card draws, the file where there is none, and a kept photo is a 304', async () => {
  const withThumbnail = {
    ...APP,
    resources: {
      ...APP.resources,
      attachment: {
        access: 'write',
        file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size', thumbnail: 'thumb', maxBytes: 1024 },
      },
    },
  };
  const SMALL = Buffer.concat([PNG.subarray(0, 8), Buffer.from('small')]);
  await fixture(async ({ upload, download, db }) => {
    for (const id of [1, 2])
      assert.equal(
        (await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: `${id}.png`, data: PNG.toString('base64') } })).status,
        200,
      );
    // The copy is the writer's to make; an upload may not name one.
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1, thumb: 'x' }, file: { name: 'a.png', data: PNG.toString('base64') } }))
        .status,
      400,
    );
    db.prepare('UPDATE attachment SET thumb = ? WHERE id = 1').run(SMALL);
    const thumb = await download(`${key(1)}&inline=1&variant=thumb`);
    assert.deepEqual(Buffer.from(await thumb.arrayBuffer()), SMALL);
    /* An App without sign-in has no one in particular reading: its pictures may be shared (image-delivery.test.ts). */
    assert.equal(thumb.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');
    assert.deepEqual(Buffer.from(await (await download(`${key(1)}&inline=1`)).arrayBuffer()), PNG, 'the file itself, unasked');
    assert.deepEqual(Buffer.from(await (await download(`${key(2)}&inline=1&variant=thumb`)).arrayBuffer()), PNG, 'a row without a copy');
    const etag = thumb.headers.get('etag')!;
    assert.match(etag, /^"[\w-]{27}"$/);
    const again = await fetch(thumb.url, { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    assert.equal(await again.text(), '');
    db.prepare('UPDATE attachment SET thumb = ? WHERE id = 1').run(PNG);
    assert.equal((await fetch(thumb.url, { headers: { 'if-none-match': etag } })).status, 200, 'a changed photo is sent again');
  }, withThumbnail);
  // A resource that declares no copy answers the variant with the file.
  await fixture(async ({ upload, download, db }) => {
    assert.equal(
      (await upload({ table: 'attachment', values: { issue_id: 1 }, file: { name: 'a.png', data: PNG.toString('base64') } })).status,
      200,
    );
    db.prepare('UPDATE attachment SET thumb = ? WHERE id = 1').run(Buffer.from('ignored'));
    assert.deepEqual(Buffer.from(await (await download(`${key(1)}&inline=1&variant=thumb`)).arrayBuffer()), PNG);
  });
});

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('IHDR and the rest')]);

test('inline=1 draws a raster image in place, by what its bytes are; anything else, and anything not asked, stays a download', async () => {
  await fixture(async ({ upload, download }) => {
    // A real PNG, claimed as text: the bytes decide, never the claim.
    assert.equal(
      (
        await upload({
          table: 'attachment',
          values: { issue_id: 1 },
          file: { name: 'front.png', type: 'text/plain', data: PNG.toString('base64') },
        })
      ).status,
      200,
    );
    // An SVG is a document that can carry script: never inline.
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    assert.equal(
      (
        await upload({
          table: 'attachment',
          values: { issue_id: 1 },
          file: { name: 'logo.svg', type: 'image/svg+xml', data: svg.toString('base64') },
        })
      ).status,
      200,
    );
    // Text that claims to be a PNG is still text.
    assert.equal(
      (
        await upload({
          table: 'attachment',
          values: { issue_id: 1 },
          file: { name: 'fake.png', type: 'image/png', data: Buffer.from('not a png').toString('base64') },
        })
      ).status,
      200,
    );

    const inline = await download(`${key(1)}&inline=1`);
    assert.equal(inline.status, 200);
    assert.deepEqual(Buffer.from(await inline.arrayBuffer()), PNG);
    assert.equal(inline.headers.get('content-type'), 'image/png');
    assert.match(inline.headers.get('content-disposition') ?? '', /^inline; filename="front\.png"/);
    assert.equal(inline.headers.get('x-content-type-options'), 'nosniff');
    assert.match(inline.headers.get('content-security-policy') ?? '', /^sandbox/);
    assert.equal(inline.headers.get('cache-control'), 'public, max-age=86400, stale-while-revalidate=604800');

    // The same photo, not asked for inline, is the download it always was.
    const plain = await download(key(1));
    assert.equal(plain.headers.get('content-type'), 'application/octet-stream');
    assert.match(plain.headers.get('content-disposition') ?? '', /^attachment;/);
    assert.equal(plain.headers.get('cache-control'), 'private, no-store');

    for (const id of [2, 3]) {
      const refused = await download(`${key(id)}&inline=1`);
      assert.equal(refused.status, 200);
      assert.match(refused.headers.get('content-disposition') ?? '', /^attachment;/, `file ${id} stays a download`);
      assert.equal(refused.headers.get('cache-control'), 'private, no-store');
      assert.match(refused.headers.get('content-security-policy') ?? '', /^sandbox/);
    }
    // An SVG is a document, not a raster: bytes, never its claimed type.
    assert.equal((await download(`${key(2)}&inline=1`)).headers.get('content-type'), 'application/octet-stream');
    // Only `1` asks: another value is the download.
    assert.match((await download(`${key(1)}&inline=true`)).headers.get('content-disposition') ?? '', /^attachment;/);
  });
});

test('the sniffer names PNG, JPEG, GIF, WebP and AVIF by their first bytes, and nothing else', () => {
  const bytes = (...parts: Array<number[] | string | Uint8Array>) =>
    Buffer.concat(parts.map((part) => (typeof part === 'string' ? Buffer.from(part, 'latin1') : Buffer.from(part))));
  const ftyp = (major: string, ...compatible: string[]) => {
    const body = bytes('ftyp', major, [0, 0, 0, 0], ...compatible);
    return bytes([0, 0, 0, body.length + 4], body, 'mdat');
  };
  assert.equal(sniffImage(PNG), 'image/png');
  assert.equal(sniffImage(bytes([0xff, 0xd8, 0xff, 0xe0], 'JFIF')), 'image/jpeg');
  assert.equal(sniffImage(bytes('GIF89a', [1, 0])), 'image/gif');
  assert.equal(sniffImage(bytes('GIF87a')), 'image/gif');
  assert.equal(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image/webp');
  assert.equal(sniffImage(ftyp('avif', 'mif1', 'miaf')), 'image/avif');
  assert.equal(sniffImage(ftyp('mif1', 'avif')), 'image/avif');
  assert.equal(sniffImage(ftyp('avis')), 'image/avif');
  // Close relatives and look-alikes are not images this route draws.
  assert.equal(sniffImage(ftyp('heic', 'mif1')), undefined);
  assert.equal(sniffImage(bytes('RIFF', [0, 0, 0, 0], 'WAVE')), undefined);
  assert.equal(sniffImage(bytes('<svg xmlns="http://www.w3.org/2000/svg"/>')), undefined);
  assert.equal(sniffImage(bytes('<!doctype html><img src=x>')), undefined);
  assert.equal(sniffImage(bytes([0x89, 0x50, 0x4e])), undefined);
  assert.equal(sniffImage(new Uint8Array()), undefined);
});
