/**
 * Where an App's own logo pictures are served (server/app/appBrand.ts): `/{app}/_brand/<name>-<hash>.<ext>`, beside
 * its theme's faces at `/{app}/_fonts/`. The client draws a logo only from an address of this shape, so nothing the
 * payload carries can point the bar at another site.
 */
export const BRAND_SEGMENT = '_brand';

const ADDRESS = new RegExp(`^/[^/?#]+/${BRAND_SEGMENT}/[a-z0-9][a-z0-9-]*\\.(?:png|jpg|webp|gif|svg)$`);

/** Whether `href` is one of an App's own logo addresses. */
export function isBrandAddress(href: unknown): href is string {
  return typeof href === 'string' && ADDRESS.test(href);
}
