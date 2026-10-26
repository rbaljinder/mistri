/**
 * The public landing, as the vanilla client reaches it: which addresses
 * draw it, the one read, and the crossing into React. Unlike a public form,
 * `/{app}` is also the App itself, so boot asks who-am-I first there and
 * draws the landing only for someone signed out; `/{app}/welcome` draws it
 * for anyone, so staff can see what an applicant sees.
 */
import { createElement } from 'react';
import { applyBrandLogo, headBrandingMark } from './appBrand.js';
import { $ } from '@mistriwork/kit/client/core.js';
import { isMounted, mount } from '@mistriwork/kit/client/components/mount.js';
import { takeServerDrawing } from './serverDrawing.js';
import { LandingSurface } from '@mistriwork/kit/client/components/LandingSurface.js';
/* The hero's own rules: the public page's stylesheet, never the signed-in shell's (landingHero.css says why). */
import './landingHero.css';
import { served } from '@mistriwork/kit/client/addressMount.js';
import { firstPaintRead } from '@mistriwork/kit/client/firstPaint.js';
import { setTabTitle, shellBody, shellQuery } from '@mistriwork/kit/client/shellHost.js';
import { fetchServer } from '@mistriwork/kit/client/transport.js';

/**
 * Fetch the landing. Anything but a landing — a 404 from an App without
 * one, a 401, a dropped connection — is `undefined`, and the caller carries
 * on as it would have without it: to sign-in, or to the App.
 * The answer carries the landing's view key, which a served home is matched against.
 * @returns {Promise<{ app: { id: string; name: string; logo?: import('@mistriwork/engine/shared/appIcons.js').AppIconName; icons?: Record<string, import('@mistriwork/engine/shared/iconGlyphs.js').IconGlyph>; theme?: import('../shared/app.js').AppTheme; customThemes?: import('@mistriwork/engine/shared/theme.js').ThemeDefinition[] }; view: string; landing: import('../shared/app.js').AppLanding } | undefined>}
 */
export async function loadLanding() {
  /** @type {any} */
  const carried = firstPaintRead('GET', '/api/landing')?.body;
  if (carried?.landing && typeof carried.view === 'string' && typeof carried.app?.id === 'string') return carried;
  try {
    const res = await fetchServer('/api/landing', { credentials: 'same-origin', signal: AbortSignal.timeout(15_000) });
    if (!res.ok) return undefined;
    const data = await res.json();
    if (!data || typeof data !== 'object' || !data.landing || typeof data.view !== 'string' || !data.app || typeof data.app.id !== 'string')
      return undefined;
    return data;
  } catch {
    return undefined;
  }
}

/**
 * Draw the landing into the content pane, in the App's name. The shell
 * chrome is hidden by class; the brand shows the App, not the tool.
 * @param {{ id: string; name: string; logo?: import('@mistriwork/engine/shared/appIcons.js').AppIconName; icons?: Record<string, import('@mistriwork/engine/shared/iconGlyphs.js').IconGlyph> }} app
 * @param {import('../shared/app.js').AppLanding} landing
 */
export function showLanding(app, landing) {
  shellBody().classList.add('app-mode', 'landing-mode');
  const brand = shellQuery('.brand-name');
  if (brand) brand.textContent = app.name;
  applyBrandLogo(
    shellQuery('.brand-mark'),
    /** @type {any} */ (app).theme?.branding?.mark ?? headBrandingMark() ?? app.logo,
    app.name,
    app.icons,
  );
  setTabTitle(landing.label ?? app.name);
  const home = $('home-button');
  if (home instanceof HTMLButtonElement) {
    home.disabled = true;
    home.removeAttribute('title');
  }
  const host = $('content');
  /* The server drew this landing (server/publicRender.ts): take its markup over where it stands. */
  const drawn = takeServerDrawing(host, 'landing');
  if (!drawn && !isMounted(host)) host.replaceChildren();
  mount(host, createElement(LandingSurface, { landing, app }), drawn);
}
