/** The small identity mark in the shell's home button, and the browser tab's.
 *
 * An App may choose one of the same curated Phosphor names it uses in its
 * navigation. One that names none is still the App, not tablewalk: its
 * initial in a square of the navigation's accent. mistri's own linked-node
 * mark is the database browser's, drawn when no App is named at all. The tab's
 * icon follows the mark, in the colour it is drawn in, so a reader with ten
 * tabs open finds the App by its own mark. Keeping the host span in place
 * means the home button and its layout remain stable while React replaces
 * the old linked-node mark.
 */
import { createElement, useLayoutEffect } from 'react';
import { Icon, registerIcons } from '@mistriwork/kit/client/components/Icon.js';
import { mount } from '@mistriwork/kit/client/components/mount.js';
import { isAppIcon, type AppIconName } from '@mistriwork/engine/shared/appIcons.js';
import { isBrandAddress } from '../shared/appBrandAddress.js';
import { appFileUnplaced, served } from '@mistriwork/kit/client/addressMount.js';
import './appBrand.css';
import { shellById, tabIcon } from '@mistriwork/kit/client/shellHost.js';

/** The first letter of an App's name, as its mark says it. */
export function brandInitial(name: string): string {
  return (Array.from(name.trim())[0] ?? '').toLocaleUpperCase();
}

/**
 * `icons` is the glyph a look before sign-in sends with its logo
 * (server/app/iconPayload.ts); an App's payload registers its own.
 */
export function applyBrandLogo(host: Element | null, logo?: unknown, app?: string, icons?: Parameters<typeof registerIcons>[0]): void {
  if (!(host instanceof HTMLElement)) return;
  registerIcons(icons);
  const image = tenantLogo(logo) ?? ownLogo(logo);
  const named = !image && isAppIcon(logo) ? logo : undefined;
  const initial = !image && !named && app ? brandInitial(app) || undefined : undefined;
  host.classList.toggle('brand-mark--image', Boolean(image));
  host.classList.toggle('brand-mark--logo', Boolean(named));
  host.classList.toggle('brand-mark--initial', Boolean(initial));
  host.setAttribute('aria-hidden', 'true');
  mount(host, createElement(BrandGlyph, { host, name: named, initial, image }));
}

/** The tenant's logo a public page's head carries (a mapped host's sign-in page, its forms), when it carries one. */
export function headBrandingMark(): { src: string; dark?: string } | undefined {
  try {
    const head = JSON.parse(shellById('mistri-branding')?.textContent || 'null') as {
      private?: boolean;
      value?: { mark?: { src?: unknown; dark?: unknown } };
    } | null;
    const mark = head && !head.private ? head.value?.mark : undefined;
    return typeof mark?.src === 'string' ? { src: mark.src, ...(typeof mark.dark === 'string' ? { dark: mark.dark } : {}) } : undefined;
  } catch {
    return undefined;
  }
}

/** A tenant's own logo (server tenantBranding.ts): only the App's own logo address, by content hash, is drawn. */
function tenantLogo(logo: unknown): LogoPicture | undefined {
  const { src, dark } = logo && typeof logo === 'object' ? (logo as { src?: unknown; dark?: unknown }) : {};
  const own = (address: unknown): address is string => typeof address === 'string' && /^\/api\/branding\/logo\/[0-9a-f]{64}$/.test(address);
  return own(src) ? { src: served(src), ...(own(dark) ? { dark: served(dark) } : {}) } : undefined;
}

/** A picture's addresses: the bar's, the one drawn by night, and the tab's. */
interface LogoPicture {
  src: string;
  dark?: string;
  mark?: string;
}

/**
 * A logo drawn as a picture: a tenant's own (one address), or the App's own `ui.logo: { src, dark, mark }`, each
 * only from the App's own logo addresses (server/app/appBrand.ts), so nothing the payload says reaches another site.
 */
function ownLogo(logo: unknown): LogoPicture | undefined {
  if (!logo || typeof logo !== 'object') return undefined;
  const { href, darkHref, markHref } = logo as { href?: unknown; darkHref?: unknown; markHref?: unknown };
  if (!isBrandAddress(href)) return undefined;
  /* An inside address, as a theme's faces are (visualTheme.ts): `/acme/_brand/…` is `/_brand/…` with the App at the
     root, and the Provider's endpoint's in an embed. Unplaced, so the picture's one address is the one its year-long
     cache keeps. */
  return {
    src: appFileUnplaced(href),
    ...(isBrandAddress(darkHref) ? { dark: appFileUnplaced(darkHref) } : {}),
    ...(isBrandAddress(markHref) ? { mark: appFileUnplaced(markHref) } : {}),
  };
}

/** An App's mark as a sheet's letterhead draws it (Document.tsx): its tenant's logo, its picture, its icon, or its initial. */
export function brandMark(logo: unknown, app: string): { image?: string; icon?: AppIconName; initial?: string } {
  /* Paper is white: the letterhead takes the light picture. */
  const image = tenantLogo(logo)?.src ?? ownLogo(logo)?.src;
  if (image) return { image };
  if (isAppIcon(logo)) return { icon: logo };
  return { initial: brandInitial(app) || undefined };
}

function BrandGlyph({ host, name, initial, image }: { host: HTMLElement; name?: AppIconName; initial?: string; image?: LogoPicture }) {
  const tab = image ? (image.mark ?? image.src) : undefined;
  useLayoutEffect(() => {
    setFavicon(host, name ? host.querySelector('svg') : null, initial, tab);
  }, [host, name, initial, tab]);
  /* A fixed box, the picture fitted inside it: a logo of any shape arrives without moving the bar. By night the dark
     picture stands in its place (appBrand.css), both in the page from the start so a switch of mode moves nothing. */
  if (image)
    return (
      <>
        <img className="brand-image" src={image.src} alt="" width={96} height={24} decoding="async" />
        {image.dark ? (
          <img className="brand-image brand-image--dark" src={image.dark} alt="" width={96} height={24} decoding="async" />
        ) : null}
      </>
    );
  if (name) return <Icon name={name} size="1em" weight="bold" className="brand-logo" />;
  return initial ? <span className="brand-initial">{initial}</span> : null;
}

/* The page's own icon, kept to put back when the database browser is shown again. */
let original: string | null | undefined;

function setFavicon(host: HTMLElement, svg: SVGSVGElement | null, initial?: string, image?: string): void {
  const link = tabIcon();
  if (!link) return;
  if (original === undefined) original = link.getAttribute('href');
  if (image) {
    link.setAttribute('href', image);
    return;
  }
  // Colours as the mark is drawn, resolved by the browser: a tab icon is an
  // image, and reads no custom property.
  const ink = getComputedStyle(host).color;
  let markup: string | undefined;
  if (svg) {
    const copy = svg.cloneNode(true) as SVGSVGElement;
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    copy.setAttribute('width', '32');
    copy.setAttribute('height', '32');
    copy.setAttribute('color', ink);
    markup = copy.outerHTML;
  } else if (initial) {
    const ground = getComputedStyle(host).backgroundColor;
    const letter = initial.replace(/[<>&'"]/g, '');
    markup =
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="${ground}"/>` +
      `<text x="16" y="22.5" text-anchor="middle" font-family="system-ui, sans-serif" font-weight="700" font-size="19" fill="${ink}">${letter}</text></svg>`;
  }
  if (markup) link.setAttribute('href', `data:image/svg+xml,${encodeURIComponent(markup)}`);
  else if (original !== undefined && original !== null) link.setAttribute('href', original);
}
