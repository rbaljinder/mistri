/**
 * The built client, as the package serves it: the path in
 * packages/engine/src/server/clientHttp.ts that runs when the server was compiled rather
 * than run under tsx, and so the one no other suite reaches. A compressed
 * copy chosen by Accept-Encoding, content-named files kept for a year and
 * everything else revalidated by ETag, HEAD, the traversal guard and the
 * SPA fallback, the page's Content-Security-Policy — against a small directory shaped the way `vite build`
 * leaves dist/client, so what is asserted is the serving and not whichever
 * build last ran.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer, request, type IncomingHttpHeaders, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { builtClient, shellPolicy } from '../packages/engine/src/server/clientHttp.js';

const ENTRY = 'assets/index-AbC123_x.js';
const BOOT = '\n      window.booted = true;\n    ';
const HTML = `<!doctype html><title>tablewalk</title><script>${BOOT}</script><script type="module" src="/${ENTRY}"></script>\n${'<p>shell</p>\n'.repeat(200)}`;
/* The build's page for a public address (server/clientSurface.ts): the same shell, preloading another chunk. */
const PUBLIC_HTML = HTML.replace('</script>\n', '</script><link rel="modulepreload" href="/assets/public-AbC123_x.js">\n');
/* The database browser's page: the shell and its own main, never the App's chrome. */
const WORKBENCH_HTML = HTML.replace('</script>\n', '</script><link rel="modulepreload" href="/assets/workbench-AbC123_x.js">\n');
const JS = 'export const answer = 42;\n'.repeat(400);
const MAP = JSON.stringify({ version: 3, sources: ['../src/app.js'], sourcesContent: [JS], mappings: 'AAAA' });
/* Too small for a compressed copy to be smaller, so the build writes none. */
const CSS = 'body{color:red}';
/* A woff2's signature and some bytes: what is asserted is how it is served, not the face. */
const FONT = 'wOF2' + 'x'.repeat(60);
const SECRET = 'outside the client directory';

const root = mkdtempSync(join(tmpdir(), 'tablewalk-client-serving-'));
const dir = join(root, 'client');
let server: Server;
let port = 0;

function put(rel: string, text: string, compressed: boolean) {
  const file = join(dir, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
  if (!compressed) return;
  writeFileSync(`${file}.br`, brotliCompressSync(text));
  writeFileSync(`${file}.gz`, gzipSync(text));
}

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}
/* node:http rather than fetch: fetch normalizes a path's dot segments before
   sending, and decompresses the body it gets back. Both are under test. */
function ask(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

before(async () => {
  put('index.html', HTML, true);
  put('index.public.html', PUBLIC_HTML, true);
  put('index.workbench.html', WORKBENCH_HTML, true);
  put(ENTRY, JS, true);
  put(`${ENTRY}.map`, MAP, true);
  put('assets/tiny-Zz9_yY8w.css', CSS, false);
  put('assets/lumenLook-Lm1_x.css', CSS, false);
  put('assets/sageLook-Sg2_y.css', CSS, false);
  /* Lumen's face (lumenLook.css): a font is compressed already, so the build writes no copy beside it. */
  put('assets/inter-latin-In3_z.woff2', FONT, false);
  writeFileSync(join(root, 'secret.txt'), SECRET);
  const serve = builtClient(dir);
  /* A public page's head (http/publicHead.ts) as the handler passes one: here, for any /shop/ address, named after it. */
  const shellFor = (url = '') =>
    url.endsWith('?workbench')
      ? { title: 'tablewalk', workbench: true as const }
      : url.startsWith('/shop/')
        ? { title: `${decodeURIComponent(url.slice(6))} · Shop`, canonical: url }
        : url.startsWith('/lumen-app/')
          ? { title: 'Lumen App', looks: ['lumen'], faces: ['lumen'] }
          : url.startsWith('/borrowing-app/')
            ? { title: "A theme on Sage with one of Lumen's recipes", looks: ['sage', 'lumen'] }
            : undefined;
  server = createServer((req, res) => {
    serve(req, res, req.method === 'HEAD', shellFor(req.url)).catch((error) => res.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as { port: number }).port;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(root, { recursive: true, force: true });
});

test('brotli is preferred, then gzip, then the file as it is', async () => {
  const cases: Array<[accept: string | undefined, encoding: string | undefined]> = [
    ['gzip, deflate, br, zstd', 'br'],
    ['BR', 'br'],
    ['*', 'br'],
    ['gzip, deflate', 'gzip'],
    ['br;q=0, gzip;q=0.5', 'gzip'],
    ['*;q=0, gzip', 'gzip'],
    ['x-gzip', 'gzip'],
    ['br;q=0, gzip;q=0', undefined],
    ['*;q=0', undefined],
    ['identity', undefined],
    ['deflate', undefined],
    [undefined, undefined],
  ];
  for (const [accept, encoding] of cases) {
    const reply = await ask(`/${ENTRY}`, accept === undefined ? {} : { 'accept-encoding': accept });
    const said = `Accept-Encoding: ${accept ?? '(none)'}`;
    assert.equal(reply.status, 200, said);
    assert.equal(reply.headers['content-encoding'], encoding, said);
    assert.equal(reply.headers.vary, 'Accept-Encoding', said);
    assert.equal(reply.headers['content-type'], 'text/javascript; charset=utf-8', said);
    assert.equal(Number(reply.headers['content-length']), reply.body.length, said);
    const decoded = encoding === 'br' ? brotliDecompressSync(reply.body) : encoding === 'gzip' ? gunzipSync(reply.body) : reply.body;
    assert.equal(decoded.toString(), JS, said);
  }
});

test('a file with no smaller copy is sent as it is, and does not vary', async () => {
  const reply = await ask('/assets/tiny-Zz9_yY8w.css', { 'accept-encoding': 'br, gzip' });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-encoding'], undefined);
  assert.equal(reply.headers.vary, undefined);
  assert.equal(reply.headers['content-type'], 'text/css; charset=utf-8');
  assert.equal(reply.body.toString(), CSS);
});

test('content-named files are kept for a year; the page and the source maps are asked about', async () => {
  const hashed = ['/' + ENTRY, '/assets/tiny-Zz9_yY8w.css'];
  for (const path of hashed) {
    const reply = await ask(path, { 'accept-encoding': 'br' });
    assert.equal(reply.headers['cache-control'], 'public, max-age=31536000, immutable', path);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff', path);
  }
  for (const path of ['/', '/index.html', `/${ENTRY}.map`]) {
    const reply = await ask(path, { 'accept-encoding': 'br' });
    assert.equal(reply.headers['cache-control'], 'no-cache', path);
    assert.match(String(reply.headers.etag), /^"[\w-]+"$/, path);
    assert.equal(reply.headers['x-content-type-options'], 'nosniff', path);
  }
  const map = await ask(`/${ENTRY}.map`);
  assert.equal(map.headers['content-type'], 'application/json; charset=utf-8');
  assert.deepEqual(JSON.parse(map.body.toString()).sourcesContent, [JS]);
});

test('a matching ETag is a 304, and each encoding has its own', async () => {
  const br = await ask('/', { 'accept-encoding': 'br' });
  const gz = await ask('/', { 'accept-encoding': 'gzip' });
  const plain = await ask('/');
  const tags = [br, gz, plain].map((reply) => String(reply.headers.etag));
  assert.equal(new Set(tags).size, 3, 'a strong ETag names the bytes, and the three encodings are different bytes');
  for (const match of [tags[0], `W/${tags[0]}`, `"elsewhere", ${tags[0]}`, '*']) {
    const again = await ask('/', { 'accept-encoding': 'br', 'if-none-match': match });
    assert.equal(again.status, 304, match);
    assert.equal(again.body.length, 0, match);
    assert.equal(again.headers.etag, tags[0], match);
    assert.equal(again.headers['cache-control'], 'no-cache', match);
    assert.equal(again.headers.vary, 'Accept-Encoding', match);
  }
  const otherEncoding = await ask('/', { 'accept-encoding': 'gzip', 'if-none-match': tags[0] });
  assert.equal(otherEncoding.status, 200);
  assert.equal(otherEncoding.headers['content-encoding'], 'gzip');
  const stale = await ask('/', { 'accept-encoding': 'br', 'if-none-match': '"stale"' });
  assert.equal(stale.status, 200);
  assert.equal(brotliDecompressSync(stale.body).toString(), HTML);
  const hashed = await ask(`/${ENTRY}`, { 'accept-encoding': 'br' });
  assert.equal((await ask(`/${ENTRY}`, { 'accept-encoding': 'br', 'if-none-match': String(hashed.headers.etag) })).status, 304);
});

test('a page with its own head has its own strong ETag, and a revisit is a 304 until the head changes', async () => {
  const first = await ask('/shop/Blue%20car', { 'accept-encoding': 'br' });
  assert.equal(first.status, 200);
  assert.equal(first.headers['content-encoding'], 'br', 'compressed as the shared page is');
  assert.match(brotliDecompressSync(first.body).toString(), /<title>Blue car · Shop<\/title>/);
  const tag = String(first.headers.etag);
  assert.match(tag, /^"[\w-]{27}"$/, 'a strong ETag');
  assert.equal(tag, `"${createHash('sha256').update(first.body).digest('base64url').slice(0, 27)}"`, 'the hash of the bytes sent');
  assert.equal(first.headers['cache-control'], 'no-cache');
  const plain = await ask('/', { 'accept-encoding': 'br' });
  assert.notEqual(tag, plain.headers.etag, "never the shared shell's");
  const again = await ask('/shop/Blue%20car', { 'accept-encoding': 'br', 'if-none-match': tag });
  assert.equal(again.status, 304);
  assert.equal(again.body.length, 0);
  assert.equal(again.headers.etag, tag);
  assert.ok(again.headers['content-security-policy'], "a 304 carries the page's policy, as its 200 did");
  const other = await ask('/shop/Red%20van', { 'if-none-match': tag });
  assert.equal(other.status, 200, 'another head is other bytes');
  assert.notEqual(other.headers.etag, tag);
  assert.equal(other.headers['content-encoding'], undefined, 'as it is to a request that takes no coding');
  assert.match(other.body.toString(), /<title>Red van · Shop<\/title>/);
  const gzipped = await ask('/shop/Blue%20car', { 'accept-encoding': 'gzip' });
  assert.equal(gzipped.headers['content-encoding'], 'gzip');
  assert.equal(gunzipSync(gzipped.body).toString(), brotliDecompressSync(first.body).toString());
  assert.notEqual(gzipped.headers.etag, tag, 'each coding has its own tag');
  assert.equal(gzipped.headers.vary, 'Accept-Encoding');
  assert.ok(
    first.body.length < gunzipSync(gzipped.body).length / 3,
    `${first.body.length} bytes for a ${gunzipSync(gzipped.body).length}-byte page`,
  );
  const headOnly = await ask('/shop/Blue%20car', { 'accept-encoding': 'br' }, 'HEAD');
  assert.equal(headOnly.headers.etag, tag);
  assert.equal(headOnly.body.length, 0);
});

test('HEAD answers what GET would, without the body', async () => {
  for (const [path, accept] of [
    ['/', 'br'],
    [`/${ENTRY}`, 'gzip'],
    [`/${ENTRY}`, ''],
    ['/somedb/customer/~1', 'br'],
  ]) {
    const get = await ask(path, { 'accept-encoding': accept });
    const head = await ask(path, { 'accept-encoding': accept }, 'HEAD');
    assert.equal(head.status, 200, path);
    assert.equal(head.body.length, 0, path);
    for (const name of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'etag', 'vary']) {
      assert.equal(head.headers[name], get.headers[name], `${path} ${name}`);
    }
  }
});

test('no path leaves the client directory', async () => {
  for (const path of [
    '/../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/assets/../../secret.txt',
    '/..\\secret.txt',
    '/.%2e/secret.txt',
  ]) {
    const reply = await ask(path);
    assert.ok(reply.status === 200 || reply.status === 403, `${path}: ${reply.status}`);
    assert.ok(!reply.body.toString().includes(SECRET), `${path} read a file outside the client directory`);
  }
});

test('an unknown path is the page, as an SPA route', async () => {
  const page = await ask('/');
  for (const path of ['/somedb/customer/~1', '/compass/@lead~7', '/assets/gone-00000000.js', '/index.html.br', '/assets']) {
    const reply = await ask(path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8', path);
    assert.equal(reply.headers['cache-control'], 'no-cache', path);
    assert.equal(reply.headers.etag, page.headers.etag, path);
    assert.equal(reply.body.toString(), HTML, path);
  }
});

test("a public address is the page that preloads the public part; every other route the shell's", async () => {
  for (const path of ['/compass/form/apply', '/compass/welcome', '/compass/sign-in/']) {
    const reply = await ask(path);
    assert.equal(reply.status, 200, path);
    assert.equal(reply.body.toString(), PUBLIC_HTML, path);
    assert.equal(reply.headers['cache-control'], 'no-cache', path);
    assert.match(String(reply.headers['content-security-policy']), /script-src 'self' 'sha256-/, path);
  }
  for (const path of ['/compass', '/compass/leads', '/compass/form', '/compass/welcome/x'])
    assert.equal((await ask(path)).body.toString(), HTML, path);
});

test("the database browser's root is its own page, not the file index.html, which is an App's", async () => {
  for (const path of ['/?workbench', '/demo/customer?workbench']) {
    const body = (await ask(path)).body.toString();
    assert.match(body, /workbench-AbC123_x\.js/, path);
    assert.match(body, /<meta name="mistri-shell" content="workbench">/, path);
  }
  assert.equal((await ask('/')).body.toString(), HTML);
});

test('the directory is read once: a file that appears later is not served', async () => {
  put('assets/late-12345678.js', JS, false);
  const reply = await ask('/assets/late-12345678.js');
  assert.equal(reply.headers['content-type'], 'text/html; charset=utf-8');
});

test('the page carries its Content-Security-Policy, its inline script pinned by hash; files do not', async () => {
  const page = await ask('/', { 'accept-encoding': 'br' });
  const policy = String(page.headers['content-security-policy']);
  const pinned = `'sha256-${createHash('sha256').update(BOOT).digest('base64')}'`;
  assert.equal(policy, shellPolicy(HTML));
  assert.ok(policy.split('; ').includes(`script-src 'self' ${pinned}`), policy);
  for (const directive of [
    "connect-src 'self'",
    "object-src 'none'",
    "frame-src 'self' blob:",
    "base-uri 'none'",
    "frame-ancestors 'self'",
  ]) {
    assert.ok(policy.split('; ').includes(directive), directive);
  }
  // The script that loads from a file needs no hash; only the inline one is named.
  assert.equal(policy.match(/'sha256-/g)?.length, 1);
  assert.equal((await ask('/somedb/customer/~1')).headers['content-security-policy'], policy);
  assert.equal((await ask(`/${ENTRY}`)).headers['content-security-policy'], undefined);
  // Only the source client's hot reload makes a worker from a blob; the build is offered none.
  assert.ok(!policy.includes('worker-src'));
  assert.ok(shellPolicy(HTML, { fromSource: true }).split('; ').includes("worker-src 'self' blob:"));
});

test("the source client's hot-reload socket is named in connect-src from source, and never for the build", async () => {
  const { devSocket } = await import('../packages/engine/src/server/devclient.js');
  const socket = devSocket({ base: '/crm/', server: { port: 5173 } } as Parameters<typeof devSocket>[0]);
  // Vite's own fallback target (`__HMR_DIRECT_TARGET__`), in the page's protocol: the host, the port, the base.
  assert.equal(socket, 'ws://localhost:5173/crm/ wss://localhost:5173/crm/');
  assert.equal(
    devSocket({ base: '/', server: { port: 5173, host: '0.0.0.0', ws: { host: 'dev.test', port: 24678, protocol: 'wss' } } } as Parameters<
      typeof devSocket
    >[0]),
    'wss://dev.test:24678/',
  );
  const connect = (policy: string) => policy.split('; ').find((directive) => directive.startsWith('connect-src'));
  assert.equal(connect(shellPolicy(HTML, { fromSource: true, socket })), `connect-src 'self' ${socket}`);
  // The build never names one, whatever it is handed.
  assert.equal(connect(shellPolicy(HTML, { socket })), "connect-src 'self'");
  // An App's declared egress is added after it, as to 'self' alone.
  const { withEgress } = await import('../packages/engine/src/server/clientHttp.js');
  assert.equal(
    connect(
      withEgress(shellPolicy(HTML, { fromSource: true, socket }), { connect: ['https://api.test'], images: [], narrowImages: false }),
    ),
    `connect-src 'self' ${socket} https://api.test`,
  );
});

test('a page says where its Apps are mounted, and under a base path its own files are said under it', async () => {
  const { withHead } = await import('../packages/engine/src/server/clientHttp.js');
  const page =
    '<!doctype html><html><head><meta charset="utf-8" />\n' +
    '<script type="module" crossorigin src="/assets/index-A.js"></script><link rel="stylesheet" href="/assets/index-A.css">' +
    '<link rel="modulepreload" href="/assets/shell-A.js"></head><body><a href="#content">Skip</a><a href="/elsewhere">x</a></body></html>';
  const json = JSON.stringify({ base: '/tools', apps: { compass: '' } });
  const under = withHead(page, { mount: { base: '/tools', json } });
  assert.match(under, /<meta charset="utf-8" \/>\n {4}<meta name="mistri-mount" content="\{&quot;base&quot;:&quot;\/tools&quot;/);
  assert.match(under, /src="\/tools\/assets\/index-A\.js"/);
  assert.match(under, /href="\/tools\/assets\/index-A\.css"/);
  assert.match(under, /href="\/tools\/assets\/shell-A\.js"/);
  assert.match(under, /href="#content"/, 'a fragment is not a file');
  assert.match(under, /href="\/elsewhere"/, "only the page's own files move");
  // At the root, only the mount is said.
  const root = withHead(page, { mount: { base: '', json: JSON.stringify({ base: '', apps: { compass: '' } }) } });
  assert.match(root, /src="\/assets\/index-A\.js"/);
  assert.match(root, /<meta name="mistri-mount"/);
  assert.equal(withHead(page, undefined), page, "the standalone browser's page is the file");
});

test("a page says the density its App's look starts at, so boot zooms once", async () => {
  const { withHead } = await import('../packages/engine/src/server/clientHttp.js');
  const { lookDensityFor } = await import('../packages/engine/src/server/clientSurface.js');
  assert.equal(lookDensityFor({}), 'compact', 'Workshop, every App by default');
  assert.equal(lookDensityFor(undefined), undefined, 'the Workbench');
  const page = '<!doctype html><html><head><meta charset="utf-8" /></head><body></body></html>';
  assert.match(withHead(page, { density: 'compact' }), /<meta name="mistri-density" content="compact">\n {2}<\/head>/);
});

test("an App's page asks for its look's sheet beside the entry, and for no other look's", async () => {
  const page = (await ask('/lumen-app/tasks')).body.toString('utf8');
  const preload = page.indexOf('<link rel="preload" as="style" crossorigin href="/assets/lumenLook-Lm1_x.css">');
  assert.ok(preload > 0, page.slice(0, 400));
  // Ahead of the entry's own script, so the two are fetched together rather than one after the other.
  assert.ok(preload < page.indexOf(`src="/${ENTRY}"`));
  assert.doesNotMatch(page, /sageLook/);
  // And for the face the sheet declares, beside it: a font's preload is in CORS mode, as its fetch always is.
  const face = page.indexOf('<link rel="preload" as="font" type="font/woff2" crossorigin href="/assets/inter-latin-In3_z.woff2">');
  assert.ok(face > 0, page.slice(0, 600));
  assert.ok(face < page.indexOf(`src="/${ENTRY}"`));
  // A page whose App wears no look sheet (the Workbench's) names none.
  assert.doesNotMatch((await ask('/workbench')).body.toString('utf8'), /rel="preload" as="style"/);
  assert.doesNotMatch((await ask('/workbench')).body.toString('utf8'), /as="font"/);
  // A page that wears Lumen's sheet for a recipe, in a face of its own, asks for the sheet and not the face.
  const borrowing = (await ask('/borrowing-app/tasks')).body.toString('utf8');
  assert.match(borrowing, /lumenLook-Lm1_x\.css/);
  assert.doesNotMatch(borrowing, /as="font"/);
});

test("the face is asked for where the App's look is set in it, not wherever its sheet is worn", async () => {
  const { lookFacesFor, lookSheetsFor } = await import('../packages/engine/src/server/clientSurface.js');
  const { compileTheme } = await import('../packages/mistri/src/shared/themeSpec.js');
  const { themePreset } = await import('../packages/engine/src/shared/themePresets.js');
  assert.deepEqual(lookFacesFor({}), ['workshop'], 'an App that names no look wears Workshop, set in Barlow');
  assert.deepEqual(lookFacesFor({ theme: { preset: 'lumen' } }), ['lumen']);
  assert.deepEqual(lookFacesFor({ theme: { preset: 'sage' } }), []);
  assert.deepEqual(lookFacesFor({ theme: { preset: 'mono' } }), []);
  assert.deepEqual(lookFacesFor(undefined), [], 'the Workbench');
  const borrowing = compileTheme({ id: 'harbor', label: 'Harbor', extends: 'sage', recipes: { avatar: 'round' } }, 'harbor', themePreset);
  const harbor = { theme: { preset: 'harbor' }, customThemes: [borrowing] };
  assert.ok(lookSheetsFor(harbor).includes('lumen'), "Lumen's round avatars are in Lumen's sheet");
  assert.deepEqual(lookFacesFor(harbor), [], "but Harbor is set in Sage's face");
  const serif = compileTheme(
    { id: 'paper', label: 'Paper', extends: 'lumen', type: { font: { ui: 'Georgia, serif', heading: 'Georgia, serif' } } },
    'paper',
    themePreset,
  );
  assert.deepEqual(lookFacesFor({ theme: { preset: 'paper' }, customThemes: [serif] }), []);
});

test("Lumen's face is served as a font and kept for a year, under its own name", async () => {
  const reply = await ask('/assets/inter-latin-In3_z.woff2', { 'accept-encoding': 'br, gzip' });
  assert.equal(reply.status, 200);
  assert.equal(reply.headers['content-type'], 'font/woff2');
  assert.equal(reply.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(reply.headers['content-encoding'], undefined, 'a woff2 is compressed already');
  assert.equal(reply.body.toString(), FONT);
});
