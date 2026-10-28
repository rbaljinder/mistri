/*
 * The page the server sends for an address names the part of the client that
 * address will draw (packages/engine/src/server/clientSurface.ts), and the entry decides the
 * same thing again from the same path (packages/mistri/src/client/publicRoutes.js). The two
 * readings must agree: where they part, the page preloads a chunk the entry
 * does not want, and the one it does want waits for the entry to run.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SURFACE_PAGES, surfaceFor, tenantPreloads } from '../packages/engine/src/server/clientSurface.js';
import { withHead } from '../packages/engine/src/server/clientHttp.js';
import { landingRoute, publicFormRoute } from '../packages/mistri/src/client/publicRoutes.js';

/** What the entry draws without the shell: a public form, the landing for anyone, the staff door. */
const clientReads = (path: string) =>
  publicFormRoute(path) || ['welcome', 'sign-in'].includes(landingRoute(path)?.kind ?? '') ? 'public' : 'shell';

test('the server and the entry read an address as the same surface', () => {
  for (const path of [
    '/',
    '/compass',
    '/compass/',
    '/compass/leads',
    '/compass/leads/@lead~127',
    '/compass/form/apply',
    '/compass/form/apply/',
    '/compass/form/Apply',
    '/compass/form/',
    '/compass/form/apply/status',
    '/compass/form/apply/claim/',
    '/compass/form/apply/other',
    '/compass/form/apply/status/x',
    '/compass/welcome',
    '/compass/welcome/',
    '/compass/sign-in',
    '/forecourt/vehicles?make=Toyota',
    '/demo/invoice%20total%20%3E%20500',
    '/a%20b/sign-in',
    '/x/form/a-b-c',
    '/x/y/welcome',
    '/@page~1/welcome',
    '/compass/sign-in/extra',
  ]) {
    const pathname = new URL(path, 'http://x').pathname;
    assert.equal(surfaceFor(pathname), clientReads(pathname), pathname);
  }
});

test('each surface has its own page, and the shell keeps index.html', () => {
  assert.equal(SURFACE_PAGES.shell, 'index.html');
  assert.notEqual(SURFACE_PAGES.public, SURFACE_PAGES.shell);
  assert.equal(new Set(Object.values(SURFACE_PAGES)).size, Object.keys(SURFACE_PAGES).length);
});

test("the database browser's page tells the entry to start its main, and no other page does", () => {
  const html =
    '<!doctype html><html><head><meta charset="utf-8"><title>tablewalk</title></head><body><script type="module" src="/assets/boot.js"></script></body></html>';
  const meta = '<meta name="mistri-shell" content="workbench">';
  const workbench = withHead(html, { workbench: true });
  assert.ok(workbench.includes(meta));
  /* Before the entry's script, which reads it as it starts. */
  assert.ok(workbench.indexOf(meta) < workbench.indexOf('<script'));
  assert.ok(!withHead(html, { mount: { base: '', json: '{}' }, path: '/compass' }).includes('mistri-shell'));
});

/* The shell imports the tenant's flows once who-am-I says the session is a tenant's (appChrome.js loadTenancy): on a
   tenant host the page asks for them beside the entry, so entering does not wait a round trip more for them. */
test("a tenant host's shell page preloads the tenant's flows, in the mode the loader asks them", () => {
  const files = [
    'assets/index-a1.js',
    'assets/tenant-B2c3.js',
    'assets/tenant-D4e5.css',
    'assets/tenantLive-F6.js',
    'assets/TenantAdministration-G7.js',
  ];
  assert.equal(
    tenantPreloads(files),
    '    <link rel="modulepreload" crossorigin href="/assets/tenant-B2c3.js">\n' +
      '    <link rel="preload" as="style" crossorigin href="/assets/tenant-D4e5.css">\n',
  );
  /* A dev server's page names no built files, and so preloads nothing. */
  assert.equal(tenantPreloads([]), '');
});
