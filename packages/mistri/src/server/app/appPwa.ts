/**
 * An installable PWA for one App, off unless the App opts in (`ui.pwa`).
 *
 * What an opted-in App serves, all from its own origin, all generated per
 * App from its name and its look's grounds — nothing is written to disk
 * and nothing joins the first-paint bundle:
 *
 * - `/{app}/manifest.webmanifest`: the name, the start and scope, the
 *   look's light ground as `background_color` and `theme_color`, and two
 *   PNG icons (192 and 512, `any maskable`) painted from the look's grounds.
 * - `/{app}/sw.js`: a worker that caches the App shell's same-scope static
 *   files as they are fetched and answers a navigation with an offline page
 *   when the network fails. It never caches a navigation itself: a shell
 *   page carries its reader's first paint, and a cached one could show one
 *   reader's page to the next. It never touches `/api/`, so App data is
 *   never cached, and offline DATA is not this feature — see below.
 * - `/{app}/pwa/register.js`: the page's registration, run on load, silent
 *   when the browser has no worker support or registration fails.
 *
 * The explicit limit: installable plus shell-offline, not offline data.
 * With no connection, the App opens to its offline page; its lists, records
 * and writes need the network, as they always did, and no sync queue is
 * kept. The offline page says exactly that, so nobody mistakes an
 * installed icon for an offline App.
 *
 * The icons are painted, not the App's logo: a logo is a wide mark for a
 * bar, not a square for a home screen, and no square mark is declared. The
 * mark is geometric — the look's dark ground as a rounded square on its
 * light ground, with a light disc — so it is recognizably the App's look
 * without pretending to be its brand.
 */
import { deflateSync } from 'node:zlib';
import { outward, type AddressMount } from '@mistriwork/engine/shared/mount.js';

/** The App's look grounds, as `lookGroundsFor` answers them. */
export interface PwaGrounds {
  light: string;
  dark: string;
}

/** The PWA's addresses, as the browser shows them (mount base included). */
export interface PwaUrls {
  manifest: string;
  serviceWorker: string;
  register: string;
  icon192: string;
  icon512: string;
  /** Where the installed App opens, and the scope its worker owns: the App's home. */
  start: string;
  scope: string;
}

/** The PWA's addresses for one App under one mount. */
export function pwaUrls(mount: AddressMount, appId: string): PwaUrls {
  const base = `/${encodeURIComponent(appId)}`;
  const manifest = outward(mount, `${base}/manifest.webmanifest`);
  const serviceWorker = outward(mount, `${base}/sw.js`);
  return {
    manifest,
    serviceWorker,
    register: outward(mount, `${base}/pwa/register.js`),
    icon192: outward(mount, `${base}/pwa/icon-192.png`),
    icon512: outward(mount, `${base}/pwa/icon-512.png`),
    start: outward(mount, `${base}/`),
    scope: outward(mount, `${base}/`),
  };
}

/** The manifest, as JSON text: the App's name, its home, its look's light ground, its two icons. */
export function pwaManifest(app: { name: string }, grounds: PwaGrounds, urls: PwaUrls): string {
  return JSON.stringify(
    {
      name: app.name,
      short_name: app.name,
      start_url: urls.start,
      scope: urls.scope,
      display: 'standalone',
      background_color: grounds.light,
      theme_color: grounds.light,
      icons: [
        { src: urls.icon192, sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
        { src: urls.icon512, sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    null,
    2,
  );
}

const escapeHtml = (text: string): string =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/**
 * The page a failed navigation falls back to: the App's name in its look,
 * the plain fact that the App needs a connection, and a retry. No App data,
 * no links into rooms that need the network.
 */
export function pwaOfflinePage(app: { name: string }, grounds: PwaGrounds): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="${escapeHtml(grounds.light)}">
<title>${escapeHtml(app.name)} is offline</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:${escapeHtml(grounds.light)};color:${escapeHtml(grounds.dark)};font-family:system-ui,sans-serif}main{max-width:28rem;padding:2rem;text-align:center}h1{font-size:1.25rem;margin:0 0 0.5rem}p{margin:0 0 1.5rem;line-height:1.5}button{font:inherit;padding:0.5rem 1rem;border:1px solid ${escapeHtml(grounds.dark)};border-radius:0.5rem;background:${escapeHtml(grounds.dark)};color:${escapeHtml(grounds.light)};cursor:pointer}</style>
</head>
<body>
<main>
<h1>${escapeHtml(app.name)} is offline</h1>
<p>This App needs a connection: its lists, records and writes live on the server, and nothing is kept on this device. Reconnect, then try again.</p>
<button type="button" onclick="location.reload()">Try again</button>
</main>
</body>
</html>
`;
}

/**
 * The worker: same-origin GETs in its scope only, navigations network-first
 * with the offline page on failure, same-scope static files cache-first,
 * and nothing else — no `/api/`, no PWA file of its own, no POST. A new
 * worker takes over at once (`skipWaiting`, `clients.claim`), and an old
 * cache under another name is dropped on activation, so a theme change
 * (which rewrites this file) retires the old shell.
 */
export function pwaServiceWorker(app: { name: string }, grounds: PwaGrounds, urls: PwaUrls): string {
  const own = [urls.manifest, urls.serviceWorker, urls.register, urls.icon192, urls.icon512].map(
    (url) => new URL(url, 'http://pwa.invalid').pathname,
  );
  return `'use strict';
const CACHE = 'mistri-pwa-v1';
const OFFLINE = ${JSON.stringify(pwaOfflinePage(app, grounds))};
const OWN = ${JSON.stringify(own)};
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('mistri-pwa-')).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (!request.url.startsWith(self.registration.scope)) return;
  if (OWN.includes(url.pathname) || /(^|\\/)api\\//.test(url.pathname)) return;
  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(() => new Response(OFFLINE, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
    return;
  }
  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreSearch: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
`;
}

/** The registration: on load, silent when workers are unsupported or registration fails, so a failure never breaks the page. */
export function pwaRegisterScript(urls: PwaUrls): string {
  return `if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register(${JSON.stringify(urls.serviceWorker)}).catch(function () {});
  });
}
`;
}

/* ---------- the painted icon ---------- */

/** An `#rrggbb` colour as its channels; anything else is refused, never guessed. */
function rgb(hex: string): [number, number, number] {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex);
  if (!match) throw new Error(`A PWA colour "${hex}" is not an #rrggbb colour.`);
  const value = Number.parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

const crc32 = (bytes: Buffer): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

const chunk = (type: string, data: Buffer): Buffer => {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
};

/**
 * A square PNG icon: the light ground full-bleed (a maskable icon must
 * bleed), the dark ground as a centred rounded square inside the safe
 * zone, a light disc at its centre. Painted pixel by pixel, so no font and
 * no rasteriser is needed; identical inputs paint identical bytes, which
 * the route caches in memory.
 */
export function pwaIconPng(size: 192 | 512, grounds: PwaGrounds): Buffer {
  const key = `${size}|${grounds.light}|${grounds.dark}`;
  const kept = iconCache.get(key);
  if (kept) return kept;
  const [lr, lg, lb] = rgb(grounds.light);
  const [dr, dg, db] = rgb(grounds.dark);
  const pixels = Buffer.alloc(size * size * 4);
  const square = size * 0.64;
  const radius = size * 0.16;
  const disc = size * 0.15;
  const edge = (size - square) / 2;
  const inSquare = (x: number, y: number): boolean => {
    if (x < edge || x >= edge + square || y < edge || y >= edge + square) return false;
    const cx = Math.min(Math.max(x, edge + radius), edge + square - radius);
    const cy = Math.min(Math.max(y, edge + radius), edge + square - radius);
    return (x - cx) ** 2 + (y - cy) ** 2 <= radius * radius;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const at = (y * size + x) * 4;
      const dx = x + 0.5 - size / 2;
      const dy = y + 0.5 - size / 2;
      const [r, g, b] = dx * dx + dy * dy <= disc * disc || !inSquare(x, y) ? [lr, lg, lb] : [dr, dg, db];
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = b;
      pixels[at + 3] = 255;
    }
  }
  const rows = Buffer.alloc(size * (1 + size * 4));
  for (let y = 0; y < size; y++) pixels.copy(rows, y * (1 + size * 4) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  iconCache.set(key, png);
  return png;
}

const iconCache = new Map<string, Buffer>();
