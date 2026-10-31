/**
 * One opted-in App's PWA files (`ui.pwa`, app/appPwa.ts), served at its own
 * inside addresses — the same pattern as its logo's pictures
 * (brandRoutes.ts): a route that answers only what the App declared, so
 * nothing else in its directory, and no other App's files, are served from
 * it.
 *
 *   /{app}/manifest.webmanifest   the manifest, from the App's name and look
 *   /{app}/sw.js                  the worker, with the App's offline page in it
 *   /{app}/pwa/register.js        the page's registration
 *   /{app}/pwa/icon-192.png       the painted 192 icon
 *   /{app}/pwa/icon-512.png       the painted 512 icon
 *
 * A matched address is always answered, never passed to the shell: an App
 * that did not opt in, or no such App, gets a 404, not a page of HTML with
 * a manifest's name. Nothing here is cached long: a theme change rewrites
 * the manifest, the worker and the icons under the same names, so each is
 * revalidated on every install and update check. The icons' bytes are
 * deterministic for one look, so the painter's own memory cache (appPwa.ts)
 * is the only reuse.
 *
 * Presentation, like a theme's faces: the manifest and the worker are
 * served to whoever can load the page, after the gate's Host check, and
 * carry no reader data — the App's name and its look's grounds only — so
 * they are the same for every reader.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { lookGroundsFor } from '@mistriwork/engine/server/clientSurface.js';
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';
import type { AppDef } from '../../shared/appModel.js';
import { pwaIconPng, pwaManifest, pwaRegisterScript, pwaServiceWorker, pwaUrls, type PwaGrounds, type PwaUrls } from '../app/appPwa.js';

const FILE = /^\/([^/]+)\/(manifest\.webmanifest|sw\.js|pwa\/(?:register\.js|icon-192\.png|icon-512\.png))$/;

/** The look an App's PWA files wear: its own, or the plain grounds when it names none. */
const groundsOf = (app: AppDef): PwaGrounds => {
  const grounds = lookGroundsFor(app.ui);
  return grounds ? { light: grounds.light, dark: grounds.dark } : { light: '#ffffff', dark: '#171717' };
};

/** Answers a request for one of an opted-in App's PWA files; false for a path that is not one. */
export function pwaRoute(
  ctx: { req: IncomingMessage; res: ServerResponse; mount: AddressMount },
  path: string,
  appOf: (appId: string) => AppDef | undefined,
): boolean {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
  const match = FILE.exec(path);
  if (!match) return false;
  let appId: string;
  try {
    appId = decodeURIComponent(match[1]!);
  } catch {
    return false;
  }
  const app = appOf(appId);
  if (!app || !app.ui?.pwa) {
    send(ctx.res, 404, { error: 'This App is not an installable PWA.' });
    return true;
  }
  const urls: PwaUrls = pwaUrls(ctx.mount, app.id);
  const grounds = groundsOf(app);
  const head = ctx.req.method === 'HEAD';
  try {
    switch (match[2]) {
      case 'manifest.webmanifest':
        return sendText(ctx, 'application/manifest+json; charset=utf-8', pwaManifest(app, grounds, urls), head);
      case 'sw.js':
        return sendText(ctx, 'text/javascript; charset=utf-8', pwaServiceWorker(app, grounds, urls), head);
      case 'pwa/register.js':
        return sendText(ctx, 'text/javascript; charset=utf-8', pwaRegisterScript(urls), head);
      case 'pwa/icon-192.png':
        return sendBytes(ctx, pwaIconPng(192, grounds), head);
      case 'pwa/icon-512.png':
        return sendBytes(ctx, pwaIconPng(512, grounds), head);
      default:
        return false;
    }
  } catch {
    send(ctx.res, 500, { error: 'The App PWA files could not be generated.' });
    return true;
  }
}

const NO_CACHE = 'no-cache';

/** A generated text file: revalidated every time, never a stale theme under a live name. */
function sendText(ctx: { req: IncomingMessage; res: ServerResponse }, type: string, body: string, head: boolean): boolean {
  ctx.res.writeHead(200, {
    'content-type': type,
    'content-length': Buffer.byteLength(body),
    'cache-control': NO_CACHE,
    'x-content-type-options': 'nosniff',
  });
  ctx.res.end(head ? undefined : body);
  return true;
}

function sendBytes(ctx: { req: IncomingMessage; res: ServerResponse }, body: Buffer, head: boolean): boolean {
  ctx.res.writeHead(200, {
    'content-type': 'image/png',
    'content-length': body.length,
    'cache-control': NO_CACHE,
    'x-content-type-options': 'nosniff',
  });
  ctx.res.end(head ? undefined : body);
  return true;
}
