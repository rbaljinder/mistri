/**
 * An App's own logo pictures (`ui.logo: { src, dark, mark }`, app/appBrand.ts) and its themes' scoped stylesheets
 * with the pictures they name, served at `/{app}/_brand/<name>-<hash>.<ext>` from the bytes the load admitted.
 *
 * Presentation, like a theme's faces (fontRoutes.ts): the sign-in screen and a public page wear the App's logo before
 * anyone has signed in, so a picture is served to whoever can load the page, after the gate's Host check, and may sit
 * in a shared cache for a year, its name being its content's. It goes with the walls a tenant's logo has
 * (brandImage.ts): its sniffed type, `nosniff`, and a policy that runs nothing. Only a name the App's logo declared
 * answers: nothing else in its directory does.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { STYLESHEET_TYPE, type AppBrand } from '../app/appBrand.js';
import { imageHeaders } from '../app/brandImage.js';
import { BRAND_SEGMENT } from '../../shared/appBrandAddress.js';

const FILE = new RegExp(`^/([^/]+)/${BRAND_SEGMENT}/([a-z0-9][a-z0-9-]*\\.(?:png|jpg|webp|gif|svg|css))$`);

/** Answers a request for one of an App's logo pictures, by its inside address; false for a path that is not one. */
export function brandRoute(
  ctx: { req: IncomingMessage; res: ServerResponse },
  path: string,
  brandOf: (appId: string) => AppBrand | undefined,
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
  const brand = brandOf(appId);
  if (!brand || !Object.hasOwn(brand.files, match[2]!)) {
    send(ctx.res, 404, { error: 'No such logo file.' });
    return true;
  }
  const body = brand.files[match[2]!]!;
  const type = brand.types[match[2]!]!;
  /* A theme's stylesheet is the scoped sheet the load wrote from its allowlist (themeStylesheet.ts): a stylesheet's
     type, and the same walls and year-long cache a picture has. */
  ctx.res.writeHead(
    200,
    type === STYLESHEET_TYPE
      ? { ...imageHeaders(type, body.length), 'content-security-policy': "default-src 'none'" }
      : imageHeaders(type, body.length),
  );
  ctx.res.end(ctx.req.method === 'HEAD' ? undefined : body);
  return true;
}
