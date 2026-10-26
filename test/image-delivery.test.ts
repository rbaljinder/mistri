/**
 * How a picture is delivered (http/appFileRead.ts, imageVariants.ts): who may
 * keep it and for how long, the format in the address, variants shared through
 * the App's bucket, the common widths made at upload, and the room a picture
 * takes before it arrives.
 *
 * The rule under test: a copy may be shared (`public`) only when its reader is
 * nobody in particular. A picture read by a person, or under a row policy,
 * is never sent with `public`, whatever the address says.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, test, type TestContext } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import { loadHttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import {
  imageFormat,
  imageHash,
  imageHashOfHex,
  imagePlaceholder,
  imageVariant,
  PREGENERATED_FORMATS,
  PREGENERATED_WIDTHS,
  pregenerateVariants,
  setImageCache,
  settlePregeneration,
  type SharedVariants,
} from '../packages/mistri/src/server/http/imageVariants.js';
import { fileValues } from '../packages/mistri/src/server/http/fileRows.js';
import { PublicRoom } from '../packages/mistri/src/client/ssr/PublicRoom.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { createHash } from 'node:crypto';
import { pictureDetails, pictureKey } from '../packages/mistri/src/server/http/publicPictures.js';
import { Bucket } from '../packages/mistri/src/server/files/bucket.js';
import { S3_CREDENTIAL_VARIABLES } from '../packages/mistri/src/server/files/fileStorage.js';
import { imageFallbackSet, imageSources, imageSrcSet } from '../packages/engine/src/shared/imageWidths.js';
import { FAKE_S3_CREDENTIALS, startFakeS3, type FakeS3 } from './support/fakeS3.js';

type Sharp = (
  input?: unknown,
  options?: unknown,
) => {
  png(): { toBuffer(): Promise<Buffer> };
  jpeg(): { toBuffer(): Promise<Buffer> };
  withMetadata(options: { orientation: number }): { jpeg(): { toBuffer(): Promise<Buffer> } };
  metadata(): Promise<{ width?: number; height?: number; format?: string }>;
};
const name = 'sharp';
const sharp = await import(name).then(
  (module: { default: Sharp }) => module.default,
  () => undefined,
);
const skip = !sharp && 'sharp is not installed';

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

const appId = 'delivery';
type Mode = 'policy' | 'open' | 'none';

/**
 * One App serving `photo` (private) and `public_photo`:
 *  - `none`: no sign-in at all, so every reader is nobody in particular;
 *  - `open`: signed-in, `public_photo` listed under `auth.public`, rows not policy;
 *  - `policy`: as `open`, but under a row policy, where a context exists for a visitor too.
 */
async function fixture(t: TestContext, mode: Mode, options: { bucket?: boolean; proxy?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-image-delivery-'));
  const cache = join(directory, 'cache');
  setImageCache(cache);
  const photo = await sharp!({ create: { width: 1000, height: 600, channels: 3, background: '#c33' } })
    .png()
    .toBuffer();
  const file = join(directory, 'pictures.db');
  const db = new DatabaseSync(file);
  for (const table of ['photo', 'public_photo']) {
    db.exec(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, owner TEXT, file_name TEXT, content_type TEXT, data BLOB, object_key TEXT)`);
    const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?, ?, ?, ?, NULL)`);
    insert.run(1, 'alpha', 'alpha.png', 'image/png', photo);
  }
  db.close();
  const registry = new Registry();
  registry.add({ id: 'pictures', name: 'Pictures', url: file, source: 'config', writable: false });
  await registry.open('pictures');
  const bucket = options.bucket
    ? { object: 'object_key', bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'pics/' } }
    : {};
  const resource = { file: { content: 'data', name: 'file_name', type: 'content_type', ...bucket } };
  const app = parseAppConfig(
    {
      id: appId,
      name: 'Delivery',
      sources: { pictures: { connection: 'pictures', default: true } },
      resources: mode === 'none' ? { public_photo: resource } : { photo: resource, public_photo: resource },
      ...(mode === 'none'
        ? {}
        : {
            auth: {
              rows: mode === 'policy' ? 'policy' : 'all',
              public: { read: ['public_photo'] },
              roles: { reader: { read: ['photo', 'public_photo'] } },
            },
          }),
      views: { photos: { kind: 'list', from: 'public_photo' } },
      home: 'photos',
    },
    'image delivery fixture',
  );
  const control = { identity: { id: 'alpha', who: 'alpha@example.test', role: 'reader' } as Identity | null };
  const host: AppHost = {
    app: { path: join(directory, 'app.ts'), app, pages: [], sources: {} },
    pages: [],
    ...(mode === 'none'
      ? {}
      : {
          auth: {
            spec: app.auth!,
            store: join(directory, 'auth.db'),
            close: async () => {},
            session: async () => control.identity,
            handler: async (_req, res) => {
              res.writeHead(204).end();
            },
          },
        }),
  };
  let policy: Awaited<ReturnType<typeof loadHttpAppPolicy>> | undefined;
  if (mode === 'policy') {
    const policyFile = join(directory, 'policy.mjs');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(
      policyFile,
      `export default { appId: '${appId}', resolveRows: () => ({ photo: { groups: [[{ column: 'owner', op: '=', value: 'alpha' }]] }, public_photo: true }) };`,
    );
    policy = await loadHttpAppPolicy({ app, registry, file: policyFile, verifySession: async () => control.identity });
  }
  const bound = { host: '127.0.0.1', port: 0, ...(options.proxy ? { identityHeader: 'x-forwarded-user' } : {}) };
  const server = createApp({ registry, bound, apps: [host], ...(policy ? { policy } : {}), pages: [] });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await policy?.retire();
    await registry.closeAll();
    rmSync(directory, { recursive: true, force: true });
    s3.objects.clear();
    s3.seen.length = 0;
  });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const read = (table: string, extra: Record<string, string> = {}, headers: Record<string, string> = {}) =>
    fetch(
      `http://${bound.host}:${bound.port}/api/file?${new URLSearchParams({ app: appId, table, key: JSON.stringify({ id: 1 }), inline: '1', ...extra })}`,
      { headers, signal: AbortSignal.timeout(10_000) },
    );
  const kept = (dir = cache) => (existsSync(dir) ? readdirSync(dir).filter((entry) => !entry.startsWith('.')) : []);
  return { control, read, kept, photo, cache, directory };
}

const PUBLIC_DAY = 'public, max-age=86400, stale-while-revalidate=604800';
const FOREVER = 'public, max-age=31536000, immutable';
const PRIVATE = 'private, no-cache';

test('the header matrix: only a picture read by nobody in particular is ever public', { skip }, async (t) => {
  // Each cell: [mode, reader, table, extra query] → the Cache-Control it must get.
  type Reader = 'signed-in' | 'signed-out';
  const cells: Array<[Mode, Reader, string, 'plain' | 'hashed', string]> = [
    ['none', 'signed-out', 'public_photo', 'plain', PUBLIC_DAY],
    ['none', 'signed-out', 'public_photo', 'hashed', FOREVER],
    ['open', 'signed-out', 'public_photo', 'plain', PUBLIC_DAY],
    ['open', 'signed-out', 'public_photo', 'hashed', FOREVER],
    // A signed-in person viewing a public page's picture: personal, so never shared.
    ['open', 'signed-in', 'public_photo', 'plain', PRIVATE],
    ['open', 'signed-in', 'public_photo', 'hashed', PRIVATE],
    // Their own private picture, hashed or not.
    ['open', 'signed-in', 'photo', 'plain', PRIVATE],
    ['open', 'signed-in', 'photo', 'hashed', PRIVATE],
    // A row-policy App builds a context for a visitor too, and a policy may answer by the request: never shared.
    ['policy', 'signed-out', 'public_photo', 'plain', PRIVATE],
    ['policy', 'signed-in', 'public_photo', 'hashed', PRIVATE],
    ['policy', 'signed-in', 'photo', 'plain', PRIVATE],
  ];
  const servers = new Map<Mode, Awaited<ReturnType<typeof fixture>>>();
  for (const mode of ['none', 'open', 'policy'] as const) servers.set(mode, await fixture(t, mode));
  for (const [mode, reader, table, kind, expected] of cells) {
    const served = servers.get(mode)!;
    served.control.identity = reader === 'signed-in' ? { id: 'alpha', who: 'alpha@example.test', role: 'reader' } : null;
    const hash = imageHash(served.photo);
    const reply = await served.read(table, { w: '320', f: 'webp', ...(kind === 'hashed' ? { h: hash } : {}) });
    const label = `${mode} / ${reader} / ${table} / ${kind}`;
    assert.equal(reply.status, 200, label);
    assert.equal(reply.headers.get('cache-control'), expected, label);
    const personal = expected === PRIVATE;
    assert.equal(
      /\bCookie\b/.test(reply.headers.get('vary') ?? ''),
      personal && mode !== 'none',
      `${label}: Vary ${reply.headers.get('vary')}`,
    );
    if (personal) assert.doesNotMatch(reply.headers.get('cache-control')!, /public/, label);
    // A wrong hash is never immutable.
    if (kind === 'hashed') {
      const wrong = await served.read(table, { w: '320', f: 'webp', h: 'A'.repeat(32) });
      assert.doesNotMatch(wrong.headers.get('cache-control') ?? '', /immutable/, `${label}: wrong hash`);
    }
    // Neither does a plain picture (no width) nor the 304 for it.
    const whole = await served.read(table);
    assert.equal(whole.headers.get('cache-control'), expected === FOREVER ? PUBLIC_DAY : expected, `${label}: whole`);
    const again = await served.read(table, { w: '320', f: 'webp' }, { 'if-none-match': reply.headers.get('etag')! });
    assert.equal(again.status, 304, label);
    assert.doesNotMatch(again.headers.get('cache-control') ?? '', personal ? /public/ : /^$/, `${label}: 304`);
  }
});

test("behind a sign-in proxy every picture is the person's: private, never public (A1)", { skip }, async (t) => {
  const served = await fixture(t, 'none', { proxy: true });
  for (const extra of [{} as Record<string, string>, { w: '320', f: 'webp' }, { w: '320', f: 'webp', h: imageHash(served.photo) }]) {
    const reply = await served.read('public_photo', extra, { 'x-forwarded-user': 'bob@example.test' });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), PRIVATE, JSON.stringify(extra));
    assert.match(reply.headers.get('vary') ?? '', /\bCookie\b/);
  }
});

test("a width with no format is answered by Accept and so is never shared; the page's <img> names its format (A2)", { skip }, async (t) => {
  const served = await fixture(t, 'none');
  const bare = await served.read('public_photo', { w: '320' }, { accept: 'image/avif,image/webp,*/*' });
  assert.equal(bare.status, 200);
  assert.doesNotMatch(bare.headers.get('cache-control') ?? '', /public/);
  assert.match(bare.headers.get('vary') ?? '', /Accept/);
  // The <img> fallback: the original's own kind (this one is a PNG), in the address, so it is shared.
  const fallback = await served.read('public_photo', { w: '320', f: 'fallback' }, { accept: 'image/avif,*/*' });
  assert.equal(fallback.headers.get('content-type'), 'image/png');
  assert.equal(fallback.headers.get('cache-control'), PUBLIC_DAY);
  assert.doesNotMatch(fallback.headers.get('vary') ?? '', /Accept/);
  assert.match(imageFallbackSet('/api/file?table=photo&key=1&inline=1&w=320', 320, 320)!, /&w=320&f=fallback 320w$/);
});

test('a picture the reader may not see is never sent, shared or not, whatever the address says', { skip }, async (t) => {
  const served = await fixture(t, 'open');
  served.control.identity = null;
  const reply = await served.read('photo', { w: '320', f: 'webp', h: imageHash(served.photo) });
  assert.notEqual(reply.status, 200);
  assert.doesNotMatch(reply.headers.get('cache-control') ?? '', /public/);
  assert.doesNotMatch(reply.headers.get('content-type') ?? '', /^image\//);
});

test('the format is in the address: &f= decides it whatever Accept says, and only a bare &w= varies by Accept', { skip }, async (t) => {
  const served = await fixture(t, 'none');
  const accept = { accept: 'image/avif,image/webp,*/*' };
  const types: Record<string, string> = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg', png: 'image/png' };
  const tags = new Set<string>();
  for (const [format, type] of Object.entries(types)) {
    const reply = await served.read('public_photo', { w: '320', f: format }, accept);
    assert.equal(reply.headers.get('content-type'), type, format);
    const decoded = await sharp!(Buffer.from(await reply.arrayBuffer())).metadata();
    assert.equal(decoded.format, format === 'jpeg' ? 'jpeg' : format === 'avif' ? 'heif' : format, format);
    assert.equal(decoded.width, 320);
    assert.equal(reply.headers.get('vary'), null, `${format}: nothing to vary by`);
    tags.add(reply.headers.get('etag')!);
  }
  assert.equal(tags.size, 4, 'a tag per format');
  // The bare width keeps the negotiated answer, and says it varies.
  const bare = await served.read('public_photo', { w: '320' }, { accept: 'image/webp' });
  assert.equal(bare.headers.get('content-type'), 'image/webp');
  assert.equal(bare.headers.get('vary'), 'Accept');
  // Nothing else is a format.
  for (const bad of ['gif', 'AVIF', 'avif,webp', '']) {
    const refused = await served.read('public_photo', { w: '320', f: bad });
    assert.equal(refused.status, 400, `f=${bad}`);
    assert.match(await refused.text(), /f must be one of avif, webp, jpeg, png/);
  }
  assert.equal(imageFormat(null), undefined);
  assert.equal(imageFormat('webp'), 'image/webp');
  assert.equal(imageFormat('toString'), 'refused');
});

test('a page offers each format through <picture> and the srcset names it in the address', () => {
  const src = '/api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&variant=thumb&h=abc';
  const avif = imageSrcSet(src, 320, 480, 'avif');
  assert.equal(
    avif,
    '/api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&h=abc&w=320&f=avif 320w, /api/file?table=photo&key=%7B%22id%22%3A1%7D&inline=1&h=abc&w=480&f=avif 480w',
  );
  assert.deepEqual(
    imageSources(src, 320, 320).map((source) => source.type),
    ['image/avif', 'image/webp'],
  );
  // The <img> fallback names its format too: no address is answered by Accept.
  assert.match(imageFallbackSet(src, 320, 320)!, /&f=fallback/);
  assert.deepEqual(imageSources('https://cdn.example.test/car.jpg'), []);
  const html = renderToStaticMarkup(
    createElement(PublicRoom, {
      room: {
        kind: 'list',
        title: 'Cars',
        items: [{ href: '/c/1', title: 'One', facts: [], image: { src, alt: 'One' } }],
      },
    }),
  );
  assert.match(html, /<picture><source type="image\/avif" srcSet="[^"]*&amp;f=avif 320w/);
  assert.match(html, /<source type="image\/webp"/);
  assert.match(html, /<img src="[^"]*" srcSet="[^"]*320w/);
});

test('variants are kept in the bucket the App names, so a second instance starts warm', { skip }, async (t) => {
  const first = await fixture(t, 'none', { bucket: true });
  const reply = await first.read('public_photo', { w: '640', f: 'webp' });
  assert.equal(reply.status, 200);
  const bytes = Buffer.from(await reply.arrayBuffer());
  const hash = imageHash(first.photo);
  const key = `pics/_variants/delivery/${hash}-640.webp`;
  assert.ok(s3.objects.has(key), `shared copy at ${key}; has ${[...s3.objects.keys()].join(', ')}`);
  assert.deepEqual(s3.objects.get(key)!.bytes, bytes);
  // Outside every App's folder, so the files sweep (which lists <prefix><app>/) never sees it.
  assert.ok(!key.startsWith('pics/delivery/'));
  // A second instance: an empty disk, the same bucket. It reads the shared copy and makes nothing.
  const other = join(first.directory, 'other-instance');
  setImageCache(other);
  s3.seen.length = 0;
  const again = await first.read('public_photo', { w: '640', f: 'webp' });
  assert.deepEqual(Buffer.from(await again.arrayBuffer()), bytes);
  assert.ok(
    s3.seen.some((entry) => entry.method === 'GET' && entry.key.endsWith(`${hash}-640.webp`)),
    'read from the bucket',
  );
  assert.ok(!s3.seen.some((entry) => entry.method === 'PUT' && entry.key.includes('_variants')), 'and not written again');
  assert.deepEqual(first.kept(other), [`${hash}-640.webp`], 'the near copy is warmed');
  // The bucket failing only costs the sharing: the picture is made and sent.
  setImageCache(join(first.directory, 'third'));
  s3.failing = true;
  const degraded = await first.read('public_photo', { w: '320', f: 'avif' });
  s3.failing = false;
  assert.equal(degraded.status, 200);
  assert.equal(degraded.headers.get('content-type'), 'image/avif');
});

test('a public picture is made at its common widths in avif and webp when it is stored, with its placeholder', { skip }, async (t) => {
  const served = await fixture(t, 'none', { bucket: true });
  const shared: SharedVariants = {
    bucket: new Bucket({ name: s3.bucket, endpoint: s3.endpoint, pathStyle: true }, FAKE_S3_CREDENTIALS),
    prefix: 'pics/',
    app: 'delivery',
  };
  const rule = {
    content: 'data',
    name: 'file_name',
    type: 'content_type',
    object: 'object_key',
    table: 'public_photo',
    resource: 'public_photo',
    app: 'delivery',
    maxBytes: 10_000_000,
    bucket: { name: s3.bucket, endpoint: s3.endpoint, pathStyle: true, prefix: 'pics/' },
  };
  // A private resource makes nothing ahead.
  const privately = fileValues({ ...rule, public: false }, { name: 'a.png', type: 'image/png', bytes: served.photo }, {});
  assert.ok('values' in privately);
  await settlePregeneration();
  assert.equal(served.kept().length, 0);
  // A public one does, off the request: the call returns before the work is done.
  const publicly = fileValues({ ...rule, public: true }, { name: 'a.png', type: 'image/png', bytes: served.photo }, {});
  assert.ok('values' in publicly);
  // Nothing starts with the values: the caller runs `stored` once the row has committed (A3).
  await settlePregeneration();
  assert.equal(served.kept().length, 0, 'not before the commit');
  assert.equal(typeof publicly.stored, 'function');
  assert.equal(typeof (privately as { stored?: unknown }).stored, 'undefined');
  publicly.stored!();
  await settlePregeneration();
  const hash = imageHash(served.photo);
  const expected = PREGENERATED_FORMATS.length * PREGENERATED_WIDTHS.length;
  assert.equal(expected, 10);
  const local = served.kept();
  assert.equal(local.length, expected, local.join(', '));
  for (const width of PREGENERATED_WIDTHS)
    for (const extension of ['avif', 'webp']) assert.ok(local.includes(`${hash}-${width}.${extension}`), `${width} ${extension}`);
  assert.equal([...s3.objects.keys()].filter((key) => key.endsWith('.avif') || key.endsWith('.webp')).length, expected, 'and shared');
  assert.ok(s3.objects.has(`pics/_variants/delivery/${hash}.json`), 'the placeholder is shared too');
  // The first visitor meets a finished one: nothing is made for the request.
  const before = s3.seen.filter((entry) => entry.method === 'PUT').length;
  const reply = await served.read('public_photo', { w: '640', f: 'avif' });
  assert.equal(reply.status, 200);
  assert.equal(served.kept().length, expected);
  assert.equal(s3.seen.filter((entry) => entry.method === 'PUT').length, before);
  // Not a picture, a GIF, and a width nobody asked for make nothing.
  pregenerateVariants(Buffer.from('plain text, not a picture'), shared);
  await settlePregeneration();
  assert.equal(served.kept().length, expected);
});

test(
  'pre-generation is bounded and yields to a visitor: extra work is dropped, and a request is made before it (A3)',
  { skip },
  async (t) => {
    const served = await fixture(t, 'none');
    const tiny = async (shade: number) =>
      sharp!({ create: { width: 64, height: 64, channels: 3, background: { r: shade, g: 20, b: 20 } } })
        .png()
        .toBuffer();
    // More pictures than the queue holds: the surplus is dropped, never kept waiting with its bytes.
    for (let shade = 0; shade < 40; shade++) pregenerateVariants(await tiny(shade * 5));
    await settlePregeneration();
    const made = new Set(served.kept().map((name) => name.split('-')[0]));
    assert.ok(made.size > 0 && made.size <= 16, `${made.size} pictures made`);
    // A visitor's picture is made while the upload's copies are still waiting.
    const upload = await tiny(251);
    pregenerateVariants(upload);
    let settled = false;
    const finished = settlePregeneration().then(() => (settled = true));
    const reply = await served.read('public_photo', { w: '160', f: 'jpeg' });
    assert.equal(reply.status, 200);
    assert.equal(settled, false, 'the visitor did not wait for the pre-made copies');
    await finished;
  },
);

test('a picture comes with its true size and an average colour, so it takes its room before it arrives', { skip }, async (t) => {
  const served = await fixture(t, 'none');
  const room = await imagePlaceholder(served.photo);
  assert.deepEqual({ width: room?.width, height: room?.height }, { width: 1000, height: 600 });
  // #c33 is (204, 51, 51); the dominant colour is quantized, so close, not equal.
  const channel = (at: number) => parseInt(room!.color.slice(at, at + 2), 16);
  assert.match(room!.color, /^#[0-9a-f]{6}$/);
  assert.ok(Math.abs(channel(1) - 204) < 24 && Math.abs(channel(3) - 51) < 24 && Math.abs(channel(5) - 51) < 24, room!.color);
  // A phone's photo on its side (EXIF turn 6) is drawn upright: the room is the turned one.
  const sideways = await sharp!({ create: { width: 800, height: 400, channels: 3, background: '#39c' } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const upright = await imagePlaceholder(sideways);
  assert.deepEqual({ width: upright?.width, height: upright?.height }, { width: 400, height: 800 });
  assert.equal(await imagePlaceholder(Buffer.from('not a picture')), undefined);
  // The same, on request, under the same grants and the same keeping rules as the picture.
  const reply = await served.read('public_photo', { meta: '1' });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers.get('cache-control'), PUBLIC_DAY);
  const body = (await reply.json()) as { width: number; height: number; color: string; hash: string };
  assert.deepEqual(
    { width: body.width, height: body.height, color: body.color, hash: body.hash },
    { ...room, hash: imageHash(served.photo) },
  );
  // The server's drawing holds the room: the proportions as attributes, the colour behind the picture.
  const html = renderToStaticMarkup(
    createElement(PublicRoom, {
      room: {
        kind: 'record',
        title: 'One',
        facts: [],
        images: [{ src: '/api/file?table=photo&key=1&inline=1&variant=thumb', alt: 'One', width: 1000, height: 600, color: room!.color }],
      },
    }),
  );
  assert.match(html, /<img [^>]*width="1000" height="600"/);
  assert.match(html, new RegExp(`style="background-color:${room!.color}"`));
  // A picture the reader may not see has no placeholder to read.
  const closed = await fixture(t, 'open');
  closed.control.identity = null;
  assert.notEqual((await closed.read('photo', { meta: '1' })).status, 200);
});

test('the hash an address names is the original bytes', () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const hex = '9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a';
  assert.equal(imageHashOfHex(hex), imageHash(bytes));
  assert.equal(imageHashOfHex('nope'), undefined);
  assert.equal(imageHashOfHex(undefined), undefined);
});

test('a GIF is sent as it is at every width and format', { skip }, async () => {
  const gif = Buffer.from('R0lGODlhAQABAAAAACw=', 'base64');
  const made = await imageVariant(gif, 'image/gif', 320, 'image/avif', { format: 'image/webp' });
  assert.equal(made.type, 'image/gif');
  assert.deepEqual(Buffer.from(made.bytes), gif);
});

test("a public page learns a picture's hash and room from its thumbnail alone, never the picture", { skip }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-picture-details-'));
  const file = join(directory, 'p.db');
  const full = await sharp!({ create: { width: 1000, height: 600, channels: 3, background: '#3a6' } })
    .png()
    .toBuffer();
  const thumb = await sharp!({ create: { width: 320, height: 192, channels: 3, background: '#3a6' } })
    .png()
    .toBuffer();
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE pic (id INTEGER PRIMARY KEY, file_name TEXT, data BLOB, thumb BLOB, sha TEXT)');
  const hex = createHash('sha256').update(full).digest('hex');
  db.prepare('INSERT INTO pic VALUES (1, ?, ?, ?, ?)').run('a.png', full, thumb, hex);
  db.prepare('INSERT INTO pic VALUES (2, ?, ?, NULL, NULL)').run('b.png', full);
  db.close();
  const adapter = new SqliteAdapter(file, 'p');
  t.after(async () => {
    await adapter.close?.();
    rmSync(directory, { recursive: true, force: true });
  });
  const schema = await adapter.introspect();
  const table = schema.tables.find((candidate) => candidate.name === 'pic')!;
  const rule = { content: 'data', name: 'file_name', thumbnail: 'thumb', hash: 'sha', table: table.id, resource: 'pic', maxBytes: 1 };
  const rows = [{ id: 1 }, { id: 2 }];
  const queried: string[][] = [];
  const spy = { query: (request: Parameters<typeof adapter.query>[0]) => (queried.push([...request.columns!]), adapter.query(request)) };
  const found = await pictureDetails(spy, table, rule, rows);
  const first = found.get(pictureKey(table, rows[0]));
  assert.equal(first?.hash, imageHash(full), 'the address may name the original');
  assert.deepEqual({ width: first?.room?.width, height: first?.room?.height }, { width: 320, height: 192 });
  assert.deepEqual(found.get(pictureKey(table, rows[1])), {}, 'a row with no thumbnail has nothing to say');
  assert.ok(
    queried.every((columns) => !columns.includes('data')),
    `the picture itself is never read: ${JSON.stringify(queried)}`,
  );
  // A resource that keeps no thumbnail is not read at all.
  queried.length = 0;
  assert.equal((await pictureDetails(spy, table, { ...rule, thumbnail: undefined }, rows)).size, 0);
  assert.equal(queried.length, 0);
  // A visitor whose `auth.public.fields` leave the thumbnail out is told nothing from it, and nothing is read for it (A5).
  queried.length = 0;
  const withoutThumbnail = {
    readable: new Set([table.id]),
    fields: new Map([[table.id, { read: new Set(['file_name']), write: new Set<string>() }]]),
  };
  assert.equal((await pictureDetails(spy, table, rule, rows, withoutThumbnail)).size, 0);
  assert.equal(queried.length, 0);
  // One who may read it gets the room, and the hash too: the hash column is internal and follows the resource.
  queried.length = 0;
  const withThumbnail = {
    readable: new Set([table.id]),
    fields: new Map([[table.id, { read: new Set(['file_name', 'thumb']), write: new Set<string>() }]]),
  };
  const allowed = await pictureDetails(spy, table, rule, rows, withThumbnail);
  assert.equal(allowed.get(pictureKey(table, rows[0]))?.hash, imageHash(full));
  // A resource the grant does not list reads as nothing at all.
  assert.equal((await pictureDetails(spy, table, rule, rows, { readable: new Set(), fields: undefined })).size, 0);
});
