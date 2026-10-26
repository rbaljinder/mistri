/**
 * The public landing over HTTP: the front page an App declares as its
 * landing view, served signed out to the page that draws it. The author's
 * content beside the App's id, name and theme, and the landing's view key
 * — which the client matches against the home it was served — and nothing
 * else: no schema, roles or navigation. This synchronous projection reads
 * no rows: its caller resolves any record branding under a public read owner
 * first. An unavailable owner supplies the static base for staff and visitors.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { send } from '@mistriwork/engine/server/http/reply.js';
import type { AppHost } from '../app/apps.js';
import type { AppDef } from '../../shared/app.js';
import type { Identity } from '@mistriwork/engine/server/http/context.js';
import { appLook } from '../../shared/appUi.js';
import { iconGlyphsIn } from '../app/iconPayload.js';
import { withRecordBranding, withBrandingLanding, type BrandingPresentation } from './recordBranding.js';

export const LANDING_PATH = '/api/landing';

/**
 * Answer `/api/landing`, or return false for any other path. Called before
 * the row-policy dispatch, because that dispatch resolves a principal — and
 * a signed-out visitor has none, while a page of text needs none.
 */
export function landingRoute({
  req,
  res,
  path,
  signedIn,
  identity,
  branding,
}: {
  req: IncomingMessage;
  res: ServerResponse;
  path: string;
  signedIn?: AppHost;
  identity: Identity;
  branding?: BrandingPresentation;
}): boolean {
  if (path !== LANDING_PATH) return false;
  /* The gate opens this path signed out only for an App with a landing;
     said again here so the route is safe on its own. */
  answerLanding(req, res, signedIn?.auth ? signedIn.app.app : undefined, Boolean(identity.id), branding);
  return true;
}

/**
 * The landing's one answer, for any host that serves an App: the ordinary
 * gate's route above, and a tenant App's dedicated host, which has no
 * AppHost. `privately` when the answer carries an account header.
 */
export function answerLanding(
  req: IncomingMessage,
  res: ServerResponse,
  app: AppDef | undefined,
  privately: boolean,
  branding?: BrandingPresentation,
): void {
  if (!app?.landing) {
    res.setHeader('cache-control', 'no-store');
    send(res, 404, { error: `No such endpoint: ${LANDING_PATH}` });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    res.setHeader('cache-control', 'no-store');
    send(res, 405, { error: 'The landing takes GET.' });
    return;
  }
  const content = withBrandingLanding(app.landing.content, branding);
  /* The landing wears the App's footer (`ui.footer`), so an App says its
     small print once and every room shows the same. */
  const landing = app.ui.footer ? { ...content, footer: app.ui.footer } : content;
  const look = appLook(withRecordBranding(app, branding));
  // The glyphs of every icon the page draws ride with the App's: its brand's, and the hero's badge and rows.
  const icons = iconGlyphsIn([look, landing]);
  const body = {
    app: icons ? { ...look, icons } : look,
    view: app.landing.view,
    landing,
  };
  /* Revalidated on every load rather than held for a max-age: the App
     reloads on save, and an author refreshing the page should see the edit
     now. The validator is the content itself, so a visit that changed
     nothing is a bodiless 304 and costs no more than the hash. Signed in, the
     answer carries the account header the gate set, so no shared cache may
     keep it. */
  const etag = `"${createHash('sha256').update(JSON.stringify(body)).digest('base64url').slice(0, 32)}"`;
  res.setHeader('cache-control', `${privately ? 'private' : 'public'}, no-cache`);
  res.setHeader('etag', etag);
  const tags = String(req.headers['if-none-match'] ?? '')
    .split(',')
    .map((tag) => tag.trim().replace(/^W\//, ''));
  if (tags.includes(etag)) {
    res.writeHead(304);
    res.end();
    return;
  }
  send(res, 200, body);
}
