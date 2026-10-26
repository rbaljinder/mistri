/**
 * An App theme's font files (`type.faces`, app/appFonts.ts), served at
 * `/{app}/_fonts/<name>-<hash>.woff2` from the bytes the load read.
 *
 * Presentation, like the client's own files: the sign-in screen and a public
 * page wear the App's look before anyone has signed in, so a face is served
 * to whoever can load the page, after the gate's Host check, and may sit in a
 * shared cache. Its name is its content's, so it is kept for a year; a
 * changed face is a new name, which the App payload points at. Only a name
 * the App's themes declared answers: nothing else in its directory does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '@mistriwork/engine/server/http/reply.js';
import type { AppFonts } from '../app/appFonts.js';
import { FONTS_SEGMENT } from '@mistriwork/engine/shared/themeFaces.js';

const FILE = new RegExp(`^/([^/]+)/${FONTS_SEGMENT}/([a-z0-9][a-z0-9-]*\\.(woff2|woff))$`);
const TYPES = { woff2: 'font/woff2', woff: 'font/woff' } as const;

/**
 * Answers a request for one of an App's faces, by its inside address; false
 * for a path that is not one. `fontsOf` finds the App's fonts by its id.
 */
export function fontRoute(
  ctx: { req: IncomingMessage; res: ServerResponse },
  path: string,
  fontsOf: (appId: string) => AppFonts | undefined,
): boolean {
  if (ctx.req.method !== 'GET' && ctx.req.method !== 'HEAD') return false;
  const match = FILE.exec(path);
  if (!match) return false;
  let appId: string;
  try {
    appId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const bytes = fontsOf(appId)?.files;
  if (!bytes || !Object.hasOwn(bytes, match[2])) {
    send(ctx.res, 404, { error: 'No such font file.' });
    return true;
  }
  const body = bytes[match[2]];
  ctx.res.writeHead(200, {
    'content-type': TYPES[match[3] as keyof typeof TYPES],
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-length': body.length,
  });
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
  return true;
}
