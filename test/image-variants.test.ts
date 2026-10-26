/**
 * A picture at the width a page draws it (`/api/file?…&w=`): only the
 * widths the srcset is written from, in the format the browser takes, kept
 * on disk within a bound, and never anything the same read without `w`
 * would not have answered — a private picture stays private at every width,
 * and a copy on disk is never what decides who sees it.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import {
  imageVariant,
  imageWidth,
  negotiateFormat,
  resetImageCache,
  setImageCache,
} from '../packages/mistri/src/server/http/imageVariants.js';
import { IMAGE_WIDTHS, imageSrcSet } from '../packages/engine/src/shared/imageWidths.js';

type Sharp = (input?: unknown) => {
  png(): { toBuffer(): Promise<Buffer> };
  metadata(): Promise<{ width?: number; format?: string }>;
};
const name = 'sharp';
const sharp = await import(name).then(
  (module: { default: Sharp }) => module.default,
  () => undefined,
);

const appId = 'pictures';
const account = (id: string): Identity => ({
  id,
  who: `${id}@example.test`,
  role: 'reader',
});

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-image-variants-'));
  const cache = join(directory, 'cache');
  setImageCache(cache);
  const photo = await sharp!({
    create: { width: 1000, height: 600, channels: 3, background: '#c33' },
  })
    .png()
    .toBuffer();
  const file = join(directory, 'pictures.db');
  const db = new DatabaseSync(file);
  for (const table of ['photo', 'public_photo']) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, owner TEXT, file_name TEXT, content_type TEXT, data BLOB)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?)`);
    insert.run(1, 'alpha', 'alpha.png', 'image/png', photo);
    insert.run(2, 'beta', 'beta.png', 'image/png', photo);
  }
  db.close();
  const registry = new Registry();
  registry.add({
    id: 'pictures',
    name: 'Pictures',
    url: file,
    source: 'config',
    writable: false,
  });
  await registry.open('pictures');
  const resource = {
    file: { content: 'data', name: 'file_name', type: 'content_type' },
  };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Pictures',
      sources: { pictures: { connection: 'pictures', default: true } },
      resources: { photo: resource, public_photo: resource },
      auth: {
        rows: 'policy',
        public: { read: ['public_photo'] },
        roles: { reader: { read: ['photo', 'public_photo'] } },
      },
      views: { photos: { kind: 'list', from: 'photo' } },
      home: 'photos',
    },
    'image variants fixture',
  );
  const control = { identity: account('alpha') as Identity | null };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: join(directory, 'auth.db'),
      close: async () => {},
      session: async () => control.identity,
      handler: async (_req, res) => {
        res.writeHead(204).end();
      },
    },
  };
  const policyFile = join(directory, 'policy.mjs');
  // A reader sees their own photos; everyone sees the public ones.
  writeFileSync(
    policyFile,
    `export default { appId: '${appId}', resolveRows: () => ({ photo: { groups: [[{ column: 'owner', op: '=', value: 'alpha' }]] }, public_photo: true }) };`,
  );
  const policy = await loadHttpAppPolicy({
    app,
    registry,
    file: policyFile,
    verifySession: async () => control.identity,
  });
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({
    registry,
    bound,
    apps: [host],
    policy,
    pages: [],
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const read = (table: string, id: number, w: string | undefined, headers: Record<string, string> = {}) =>
    fetch(
      `http://${bound.host}:${bound.port}/api/file?${new URLSearchParams({
        app: appId,
        table,
        key: JSON.stringify({ id }),
        inline: '1',
        ...(w === undefined ? {} : { w }),
      })}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  const kept = () => readdirSync(cache).filter((file) => !file.startsWith('.'));
  return { control, read, kept, photo, cache };
}

test('only the widths a srcset is written from are made; any other is refused before a read', () => {
  assert.equal(imageWidth(null), undefined);
  for (const width of IMAGE_WIDTHS) assert.equal(imageWidth(String(width)), width);
  for (const raw of ['333', '0', '5000', '-320', '320px', '3.2e2', '']) assert.equal(imageWidth(raw), 'refused', raw);
  assert.equal(negotiateFormat('image/avif,image/webp,*/*', 'image/jpeg'), 'image/avif');
  assert.equal(negotiateFormat('image/webp,*/*;q=0.8', 'image/png'), 'image/webp');
  assert.equal(negotiateFormat('*/*', 'image/png'), 'image/png');
  assert.equal(negotiateFormat(undefined, 'image/jpeg'), 'image/jpeg');
  // A srcset only for the file route's inline pictures, asked at full quality rather than as the thumbnail.
  const src = '/api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&variant=thumb';
  assert.equal(
    imageSrcSet(src, 320, 640),
    '/api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&w=320 320w, /api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&w=480 480w, /api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&w=640 640w',
  );
  assert.equal(imageSrcSet('https://cdn.example.test/car.jpg'), undefined);
  assert.equal(imageSrcSet('/api/file?table=photo&key=1'), undefined);
});

test(
  'a width is made in the format the browser takes, kept, and revalidated by its tag',
  { skip: !sharp && 'sharp is not installed' },
  async (t) => {
    const { read, kept, photo } = await fixture(t);
    const avif = await read('photo', 1, '320', {
      accept: 'image/avif,image/webp,*/*',
    });
    assert.equal(avif.status, 200);
    assert.equal(avif.headers.get('content-type'), 'image/avif');
    assert.equal(avif.headers.get('vary'), 'Cookie, Accept');
    assert.equal(avif.headers.get('cache-control'), 'private, no-cache');
    const avifBytes = Buffer.from(await avif.arrayBuffer());
    assert.ok(avifBytes.length < photo.length);
    const webp = await read('photo', 1, '320', { accept: 'image/webp,*/*' });
    assert.equal(webp.headers.get('content-type'), 'image/webp');
    const meta = await sharp!(Buffer.from(await webp.arrayBuffer())).metadata();
    assert.equal(meta.format, 'webp');
    assert.equal(meta.width, 320);
    const plain = await read('photo', 1, '320');
    assert.equal(plain.headers.get('content-type'), 'image/png');
    assert.equal((await sharp!(Buffer.from(await plain.arrayBuffer())).metadata()).width, 320);
    // Never larger than the original: 1920 of a 1000-pixel photo is the photo's own width.
    const wide = await read('photo', 1, '1920', { accept: 'image/webp' });
    assert.equal((await sharp!(Buffer.from(await wide.arrayBuffer())).metadata()).width, 1000);
    assert.equal(kept().length, 4, 'one copy per width and format');
    // Asked again: the same copy, the same tag, and a 304 for the tag.
    const again = await read('photo', 1, '320', { accept: 'image/avif' });
    assert.deepEqual(Buffer.from(await again.arrayBuffer()), avifBytes);
    assert.equal(again.headers.get('etag'), avif.headers.get('etag'));
    assert.notEqual(avif.headers.get('etag'), webp.headers.get('etag'));
    assert.equal(
      (
        await read('photo', 1, '320', {
          accept: 'image/avif',
          'if-none-match': avif.headers.get('etag')!,
        })
      ).status,
      304,
    );
    assert.equal(kept().length, 4);
    // Any other width is refused, and nothing is made for it.
    const refused = await read('photo', 1, '333');
    assert.equal(refused.status, 400);
    assert.match(await refused.text(), /w must be one of 160, 320/);
    assert.equal(kept().length, 4);
  },
);

test('a private picture is private at every width, whatever is kept on disk', { skip: !sharp && 'sharp is not installed' }, async (t) => {
  const { control, read, kept } = await fixture(t);
  // The owner's read makes and keeps the copy.
  assert.equal((await read('photo', 1, '640', { accept: 'image/webp' })).status, 200);
  assert.equal(kept().length, 1);
  // Somebody else's row, and a signed-out visitor, are refused before the copy is looked at.
  const other = await read('photo', 2, '640', { accept: 'image/webp' });
  assert.equal(other.status, 404);
  control.identity = null;
  const visitor = await read('photo', 1, '640', { accept: 'image/webp' });
  assert.notEqual(visitor.status, 200);
  assert.doesNotMatch(visitor.headers.get('content-type') ?? '', /^image\//);
  // A public picture is resized for a visitor too.
  const open = await read('public_photo', 1, '640', { accept: 'image/webp' });
  assert.equal(open.status, 200);
  assert.equal(open.headers.get('content-type'), 'image/webp');
  assert.equal(open.headers.get('vary'), 'Cookie, Accept');
});

test(
  'the kept copies stay within their bound, the least recently sent going first',
  { skip: !sharp && 'sharp is not installed' },
  async (t) => {
    const { read, cache } = await fixture(t);
    const sizes: number[] = [];
    for (const width of ['160', '320', '480']) {
      const answer = await read('photo', 1, width, { accept: 'image/webp' });
      sizes.push((await answer.arrayBuffer()).byteLength);
    }
    // A fresh store with room for the last two: making the third lets the first go.
    const small = join(cache, '..', 'small');
    setImageCache(small, Math.ceil((sizes[1] + sizes[2]) / 0.9) + 1);
    for (const width of ['160', '320', '480']) assert.equal((await read('photo', 1, width, { accept: 'image/webp' })).status, 200);
    const left = readdirSync(small).filter((file) => !file.startsWith('.'));
    assert.equal(left.length, 2, `kept ${left.join(', ')}`);
    assert.ok(left.some((file) => file.endsWith('-480.webp')));
    assert.ok(!left.some((file) => file.endsWith('-160.webp')));
  },
);

test('with no cache folder named, copies are kept in a private folder this process makes, never a shared name in the temp directory', async () => {
  const outer = mkdtempSync(join(tmpdir(), 'tablewalk-image-private-'));
  const before = {
    tmp: process.env.TMPDIR,
    cache: process.env.MISTRI_IMAGE_CACHE,
  };
  try {
    process.env.TMPDIR = outer;
    delete process.env.MISTRI_IMAGE_CACHE;
    // Another local user got there first: a world-writable folder under the old, predictable name, with a picture planted for a public photo.
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const hash = createHash('sha256').update(bytes).digest('base64url').slice(0, 32);
    const shared = join(outer, 'tablewalk-image-cache');
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    writeFileSync(join(shared, `${hash}-320.jpg`), 'PLANTED');
    resetImageCache();
    const answer = await imageVariant(bytes, 'image/jpeg', 320, undefined);
    assert.notEqual(Buffer.from(answer.bytes).toString(), 'PLANTED', 'a planted copy is not sent');
    const made = readdirSync(outer).filter((name) => name.startsWith('tablewalk-image-cache-'));
    assert.equal(made.length, 1, 'the process made a folder of its own');
    assert.equal(statSync(join(outer, made[0])).mode & 0o077, 0, 'readable and writable by its owner alone');
  } finally {
    if (before.tmp === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = before.tmp;
    if (before.cache !== undefined) process.env.MISTRI_IMAGE_CACHE = before.cache;
    resetImageCache();
    rmSync(outer, { recursive: true, force: true });
  }
});
