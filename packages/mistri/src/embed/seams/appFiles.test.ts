import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ThemeDefinition } from '../../../../engine/schema/theme.js';
import { themePreset } from '../../../../engine/src/shared/themePresets.js';
import { bind, unbind } from '../binding.js';
import { memoryNavigator } from '../navigator.js';

/* The client's modules as the embed build has them: its address seam swapped for the embed's twin, as
   config/vite.embed.config.ts swaps it. Everything else is the served client's own code. */
vi.mock('../../../../kit/src/client/addressMount.js', async () => await import('./addressMount.js'));
const { configureVisualThemes } = await import('../../../../kit/src/client/visualTheme.js');
const { brandMark } = await import('../../client/appBrand.js');

/* The sheet is linked, never fetched: what is asserted is its address. */
type Loading = { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean };
const settings = (window as unknown as { happyDOM: { settings: Loading } }).happyDOM.settings;
const loading = { ...settings };

/**
 * An App's own files that a theme names — its faces (`/{app}/_fonts/`), its stylesheet and logo pictures
 * (`/{app}/_brand/`) — are fetched from the Provider's endpoint in an embed, as its component chunks are
 * (addressMount appFile). Drawn as links (`shown`), they were the host's address: `/staff/_fonts/…`, a page of the
 * host's site, never the font.
 */
describe('an embedded App’s theme files', () => {
  beforeEach(() => {
    settings.disableCSSFileLoading = settings.handleDisabledFileLoadingAsSuccess = true;
    const root = document.createElement('div');
    root.className = 'tw-root';
    const body = document.createElement('div');
    body.className = 'tw-body';
    const portals = document.createElement('div');
    body.append(portals);
    root.append(body);
    document.body.append(root);
    bind({
      root,
      body,
      portals,
      navigator: memoryNavigator('/staff/classes'),
      address: { base: '/staff', apps: { ladle: '' } },
      endpoint: '/api/tw',
      authorization: () => undefined,
      title: () => {},
    });
  });
  afterEach(() => {
    configureVisualThemes();
    unbind();
    document.body.innerHTML = '';
    document.head.innerHTML = '';
    settings.disableCSSFileLoading = loading.disableCSSFileLoading;
    settings.handleDisabledFileLoadingAsSuccess = loading.handleDisabledFileLoadingAsSuccess;
  });

  it('come from the endpoint, not the host’s address', () => {
    const theme: ThemeDefinition = {
      ...themePreset('lumen')!,
      id: 'school',
      label: 'School',
      fonts: { ui: '"Fraunces", serif', heading: '"Fraunces", serif' },
      faces: [
        {
          family: 'Fraunces',
          src: './fonts/fraunces.woff2',
          weight: '400 700',
          style: 'normal',
          href: '/ladle/_fonts/fraunces-0a1b2c3d.woff2',
        },
      ],
      stylesheet: { src: './theme.css', href: '/ladle/_brand/theme-0a1b2c3d.css' },
    };
    configureVisualThemes([theme], 'school', true, undefined, 'ladle');
    const faces = document.getElementById('mistri-theme-faces')?.textContent ?? '';
    expect(faces).toContain('url("/api/tw/_fonts/fraunces-0a1b2c3d.woff2")');
    expect(faces).not.toContain('/staff/');
    expect(document.querySelector<HTMLLinkElement>('link[data-theme-sheet]')?.getAttribute('href')).toBe(
      '/api/tw/_brand/theme-0a1b2c3d.css',
    );
    expect(brandMark({ href: '/ladle/_brand/logo-0a1b2c3d.png' }, 'ladle').image).toBe('/api/tw/_brand/logo-0a1b2c3d.png');
  });
});
