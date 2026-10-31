/**
 * An installable PWA for one App (`ui.pwa`, packages/mistri/src/server/app/appPwa.ts,
 * served by http/pwaRoutes.ts, named in the shell's head by engine clientHttp.ts):
 * the manifest from the App's name and look, the worker that answers a failed
 * navigation with an offline page and never caches App data, the painted
 * icons, the registration, and the route that serves them only to an App
 * that opted in. The explicit limit is stated in the code and the docs:
 * installable plus shell-offline, not offline data.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pwaIconPng,
  pwaManifest,
  pwaOfflinePage,
  pwaRegisterScript,
  pwaServiceWorker,
  pwaUrls,
} from '../packages/mistri/src/server/app/appPwa.js';
import { pwaRoute } from '../packages/mistri/src/server/http/pwaRoutes.js';
import { parseUi } from '../packages/mistri/src/shared/appUi.js';
import { previewKeysUsed } from '../packages/mistri/src/shared/preview.js';
import { withHead } from '../packages/engine/src/server/clientHttp.js';

const GROUNDS = { light: '#faf9f7', dark: '#171717' };
const MOUNT = { base: '', apps: {} };
const APP = { id: 'billing', name: 'Billing', ui: { pwa: true } } as never;

const pngSize = (png: Buffer): [number, number] => [png.readUInt32BE(16), png.readUInt32BE(20)];

describe('an App PWA', () => {
  test('its addresses name the App under the mount, and the manifest names the App and its look', () => {
    const urls = pwaUrls(MOUNT, 'billing');
    assert.equal(urls.manifest, '/billing/manifest.webmanifest');
    assert.equal(urls.serviceWorker, '/billing/sw.js');
    assert.equal(urls.register, '/billing/pwa/register.js');
    assert.equal(urls.icon192, '/billing/pwa/icon-192.png');
    assert.equal(urls.start, '/billing/');
    assert.equal(urls.scope, '/billing/');
    const under = pwaUrls({ base: '/tools', apps: { billing: 'billing' } }, 'billing');
    assert.equal(under.manifest, '/tools/billing/manifest.webmanifest');
    assert.equal(under.serviceWorker, '/tools/billing/sw.js');
    const manifest = JSON.parse(pwaManifest(APP, GROUNDS, urls)) as Record<string, unknown>;
    assert.equal(manifest.name, 'Billing');
    assert.equal(manifest.short_name, 'Billing');
    assert.equal(manifest.start_url, '/billing/');
    assert.equal(manifest.scope, '/billing/');
    assert.equal(manifest.display, 'standalone');
    assert.equal(manifest.background_color, '#faf9f7');
    assert.equal(manifest.theme_color, '#faf9f7');
    assert.deepEqual(manifest.icons, [
      { src: '/billing/pwa/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
      { src: '/billing/pwa/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    ]);
  });

  test('the worker answers a failed navigation with the offline page and caches no App data', () => {
    const urls = pwaUrls(MOUNT, 'billing');
    const worker = pwaServiceWorker(APP, GROUNDS, urls);
    assert.match(worker, /skipWaiting/);
    assert.match(worker, /clients\.claim/);
    assert.match(worker, /request\.mode === 'navigate'/);
    assert.match(worker, /new Response\(OFFLINE/);
    assert.match(worker, /request\.method !== 'GET'/);
    assert.match(worker, /api\\\//);
    assert.match(worker, /caches\.match/);
    // The offline page is in the worker, and it says the limit plainly.
    assert.match(worker, /needs a connection/);
    const page = pwaOfflinePage(APP, GROUNDS);
    assert.match(page, /Billing is offline/);
    assert.match(page, /needs a connection/);
    assert.match(page, /location\.reload/);
    assert.match(page, /#faf9f7/);
    assert.doesNotMatch(page, /\/api\//);
  });

  test('the registration runs on load and fails silently', () => {
    const script = pwaRegisterScript(pwaUrls(MOUNT, 'billing'));
    assert.match(script, /'serviceWorker' in navigator/);
    assert.match(script, /navigator\.serviceWorker\.register\("\/billing\/sw\.js"\)/);
    assert.match(script, /\.catch\(function \(\) \{\}\)/);
  });

  test('the painted icons are PNGs of the right size, deterministic, and theme-derived', () => {
    const small = pwaIconPng(192, GROUNDS);
    const large = pwaIconPng(512, GROUNDS);
    assert.deepEqual([...small.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    assert.deepEqual(pngSize(small), [192, 192]);
    assert.deepEqual(pngSize(large), [512, 512]);
    assert.deepEqual(pwaIconPng(192, GROUNDS), small, 'identical inputs paint identical bytes');
    assert.notDeepEqual(pwaIconPng(192, { light: '#ffffff', dark: '#000000' }), small);
    assert.throws(() => pwaIconPng(192, { light: 'white', dark: '#171717' }), /not an #rrggbb colour/);
  });

  test('the shell head carries the manifest and registration only for an opted-in App', () => {
    const page = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    const withPwa = withHead(page, { pwa: { manifest: '/billing/manifest.webmanifest', register: '/billing/pwa/register.js' } });
    assert.match(withPwa, /<link rel="manifest" href="\/billing\/manifest\.webmanifest">/);
    assert.match(withPwa, /<script src="\/billing\/pwa\/register\.js" defer><\/script>/);
    assert.equal(withHead(page, undefined), page);
  });

  test('the route serves an opted-in App and 404s anything else, never the shell', () => {
    const calls: Array<{ status: number; headers: Record<string, string>; body: Buffer }> = [];
    const ctxFor = (method: string, path: string) => {
      const res = {
        destroyed: false,
        writableEnded: false,
        writeHead(status: number, headers: Record<string, string>) {
          calls.push({ status, headers, body: Buffer.alloc(0) });
        },
        end(body?: Buffer | string) {
          calls[calls.length - 1]!.body = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
        },
      };
      return { req: { method }, res, mount: MOUNT, path };
    };
    const appOf = (id: string) => (id === 'billing' ? APP : id === 'plain' ? ({ id: 'plain', name: 'Plain', ui: {} } as never) : undefined);
    const run = (method: string, path: string) => {
      calls.length = 0;
      const ctx = ctxFor(method, path) as never;
      const answered = pwaRoute(ctx as never, path, appOf as never);
      return { answered, call: calls[0] };
    };
    const manifest = run('GET', '/billing/manifest.webmanifest');
    assert.equal(manifest.answered, true);
    assert.equal(manifest.call?.status, 200);
    assert.match(manifest.call?.headers['content-type'] ?? '', /application\/manifest\+json/);
    assert.equal((JSON.parse(manifest.call!.body.toString()) as { name: string }).name, 'Billing');
    const worker = run('GET', '/billing/sw.js');
    assert.equal(worker.call?.status, 200);
    assert.match(worker.call?.headers['content-type'] ?? '', /text\/javascript/);
    assert.match(worker.call!.body.toString(), /mistri-pwa-v1/);
    const icon = run('GET', '/billing/pwa/icon-192.png');
    assert.equal(icon.call?.status, 200);
    assert.equal(icon.call?.headers['content-type'], 'image/png');
    assert.deepEqual(pngSize(icon.call!.body), [192, 192]);
    const head = run('HEAD', '/billing/sw.js');
    assert.equal(head.call?.status, 200);
    assert.equal(head.call?.body.length, 0);
    assert.equal(run('GET', '/plain/manifest.webmanifest').call?.status, 404, 'an App that did not opt in gets no manifest');
    assert.equal(run('GET', '/ghost/sw.js').call?.status, 404);
    assert.equal(run('GET', '/billing/other.txt').answered, false, 'a path that is not a PWA file falls through');
    assert.equal(run('POST', '/billing/sw.js').answered, false);
  });

  test('ui.pwa parses as a boolean and lists as a Preview feature', () => {
    assert.deepEqual(parseUi({ pwa: true }, 'test'), { pwa: true });
    assert.deepEqual(parseUi({}, 'test'), {});
    assert.throws(() => parseUi({ pwa: 'yes' }, 'test'), /"ui\.pwa" is not true or false/);
    assert.deepEqual(previewKeysUsed({ ui: { pwa: true } }), ['ui.pwa']);
    assert.deepEqual(previewKeysUsed({ ui: {} }), []);
  });
});
