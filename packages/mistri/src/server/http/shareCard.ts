/**
 * A public page's share card: the 1200×630 picture a link preview shows
 * (`og:image`, `twitter:image`), drawn by the server at `/api/og`.
 *
 * A record, a list or the landing named its first photo, or nothing, so a
 * link pasted into a chat was the App's name over an empty box. Now the head
 * (handler.ts socialHead) names a card drawn from the words it already chose
 * — the page's title, its summary, the site — in the App's own look: its
 * ground, ink and accent, its logo mark, set in Inter. A record with a photo
 * of its own keeps the photo; that is the better picture of it.
 *
 * Nothing here reads. The route asks the head again for the address it is
 * given, as the public principal whoever asks (publicHead.ts), and draws
 * what that answers: a field the public may not read, a record it may not
 * see, another tenant's address are not on a card because they are not in
 * that answer. So the card is a pure function of words the page already
 * gave away, and it is addressed by their hash (`v`): an answer for the
 * hash asked is the same bytes forever, cached for a year, and a page whose
 * words changed names a new one. The last drawn are kept in memory, a few
 * at a time are drawn at once, and past a short queue the route says busy.
 *
 * satori and resvg are optional, loaded by a name nothing follows, as sharp
 * is (imageVariants.ts): a deployment without them names no card, and the
 * page keeps its photo or has no picture. A page never waits on a drawing
 * and never fails for one.
 */
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import type { AppUi } from '../../shared/appModel.js';
import { APP_ICON_GLYPHS } from '@mistriwork/engine/shared/iconGlyphs.js';
import { serverPath, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  inheritThemePreset,
  themePreset,
} from '@mistriwork/engine/shared/themePresets.js';
import type { BrandingPresentation } from './recordBranding.js';

export const SHARE_CARD_PATH = '/api/og';

/** Everything a card is drawn from, and so everything its hash covers. */
export interface ShareCard {
  readonly site: string;
  readonly title: string;
  readonly summary?: string;
  readonly ground: string;
  readonly ink: string;
  readonly muted: string;
  readonly accent: string;
  /** The App's logo mark: path data on a 256-unit square. */
  readonly mark?: readonly string[];
}

/** Draws one card as a PNG (shareCardDraw.ts). */
export type CardDrawing = (card: ShareCard) => Promise<Uint8Array>;

/* Raised when what a card looks like changes, so every hash — and every cached copy — moves with it. */
const DRAWING_REVISION = 1;
const TITLE_MOST = 110;
const SUMMARY_MOST = 180;

/* A colour satori and resvg both read. A look may say `color-mix(…)`, which neither does: that role is Lumen's then. */
const PLAIN_COLOUR = /^(?:#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%\s/]+\))$/i;

const words = (text: string | undefined, most: number) => {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length <= most ? flat : `${flat.slice(0, most - 1).trimEnd()}…`;
};

/** The look a page is drawn in: the request's branding where it has one, else the App's own look, else Lumen. */
function palette(ui: AppUi, branding: BrandingPresentation | undefined): ThemePalette {
  if (branding) return inheritThemePreset(branding.value.theme as ThemeDefinition).light;
  const theme = (ui.theme ?? {}) as { preset?: string; palette?: string; accent?: string | { light: string; dark: string } };
  const worn = ui.customThemes?.find((item) => item.id === theme.preset) ?? themePreset(theme.preset) ?? themePreset('lumen')!;
  const effective = effectiveThemeDefinition(worn as ThemeDefinition, theme.palette);
  return effectiveThemePalette(effective.light, false, { ...(theme.accent ? { accent: theme.accent } : {}) });
}

/**
 * The card for a page's words in the App's look. Undefined when there is no
 * title to draw. A tenant's or a record's own logo is a picture this card
 * does not fetch, so a branded page draws no mark rather than the App's.
 */
export function shareCard(input: {
  site: string;
  title: string;
  summary?: string;
  ui: AppUi;
  branding?: BrandingPresentation;
}): ShareCard | undefined {
  const title = words(input.title, TITLE_MOST);
  if (!title) return undefined;
  const site = words(input.site, 80);
  const summary = words(input.summary, SUMMARY_MOST);
  const own = palette(input.ui, input.branding);
  const lumen = themePreset('lumen')!.light;
  const colour = (value: string | undefined, fallback: string) => (value && PLAIN_COLOUR.test(value.trim()) ? value.trim() : fallback);
  const logo = input.ui.logo;
  const branded = input.branding && (input.branding.value.mark || input.branding.value.images.logo);
  return {
    site,
    title,
    ...(summary && summary !== title ? { summary } : {}),
    ground: colour(own.ground ?? own.surface, lumen.ground!),
    ink: colour(own.ink, lumen.ink),
    muted: colour(own.inkMuted ?? own.ink, lumen.inkMuted!),
    accent: colour(own.accent, lumen.accent),
    ...(logo && isAppIcon(logo) && !branded ? { mark: APP_ICON_GLYPHS[logo][1] } : {}),
  };
}

/** The card's address: its hash, which is all a cache needs to know it. */
export function cardVersion(card: ShareCard): string {
  return createHash('sha256')
    .update(JSON.stringify([DRAWING_REVISION, card]))
    .digest('hex')
    .slice(0, 32);
}

/* ---------- the drawing, loaded once ---------- */

let loader: () => Promise<CardDrawing | undefined> = async () => (await import('./shareCardDraw.js')).loadCardDrawing();
let loading: Promise<CardDrawing | undefined> | undefined;
const drawing = () => (loading ??= loader().catch(() => undefined));

/** Whether this server draws cards: satori and resvg both load. Asked by the head; the first ask loads them. */
async function shareCardsDrawn(): Promise<boolean> {
  return (await drawing()) !== undefined;
}

/** Another drawing, or none (`async () => undefined`): for a test, which must say what it stands in for. */
export function drawShareCardsWith(load: () => Promise<CardDrawing | undefined>): void {
  loader = load;
  loading = undefined;
  kept.clear();
  keptBytes = 0;
}

/** A locale tag a card's address may carry: what canonicalLocale writes, and no longer than a tag gets. */
const CARD_LOCALE = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;

/**
 * The absolute address a page's head names for its card, or undefined where
 * this server draws none. `locale` is the language the page was said in, where
 * the App has several: the card is drawn in it from the address alone, since a
 * preview fetches the picture without the reader's Accept-Language.
 */
export async function shareCardImage(
  origin: string,
  mount: AddressMount,
  inside: string,
  card: ShareCard | undefined,
  locale?: string,
): Promise<string | undefined> {
  if (!card || !(await shareCardsDrawn())) return undefined;
  const query = new URLSearchParams({ path: inside, ...(locale && CARD_LOCALE.test(locale) ? { locale } : {}), v: cardVersion(card) });
  return `${origin}${serverPath(mount, SHARE_CARD_PATH)}?${query}`;
}

/**
 * What the route was asked: the page's inside address (`/{app}/…`, with its
 * query), the locale it was said in, and the hash the page named. Anything
 * else is no card.
 */
export function cardRequest(url: URL): { inside: URL; version?: string; locale?: string } | undefined {
  const params = [...url.searchParams.keys()];
  if (params.some((name) => name !== 'path' && name !== 'v' && name !== 'locale') || url.searchParams.getAll('path').length !== 1)
    return undefined;
  const path = url.searchParams.get('path')!;
  const version = url.searchParams.get('v') ?? undefined;
  if (url.searchParams.getAll('v').length > 1 || (version !== undefined && !/^[0-9a-f]{32}$/.test(version))) return undefined;
  const locale = url.searchParams.get('locale') ?? undefined;
  if (url.searchParams.getAll('locale').length > 1 || (locale !== undefined && !CARD_LOCALE.test(locale))) return undefined;
  if (path.length > 1024 || !path.startsWith('/') || path.startsWith('//') || path.includes('#') || path.startsWith('/api/'))
    return undefined;
  const inside = new URL(path, 'http://localhost');
  if (inside.origin !== 'http://localhost') return undefined;
  return { inside, ...(version ? { version } : {}), ...(locale ? { locale } : {}) };
}

/* ---------- kept and drawn ---------- */

/* The last drawn, least recently sent first out: a card is 20–60 kB, so this is a few megabytes at most. */
const KEPT_MOST = 256;
const KEPT_BYTES = 24 * 1024 * 1024;
const kept = new Map<string, Uint8Array>();
let keptBytes = 0;
const drawingNow = new Map<string, Promise<Uint8Array | undefined>>();
/* A drawing is 50–150 ms of one core: two at once, sixteen waiting, and a busy answer past that. */
const AT_ONCE = 2;
const WAITING_MOST = 16;
let running = 0;
const waiting: Array<() => void> = [];

function keep(version: string, png: Uint8Array): void {
  if (png.byteLength > KEPT_BYTES) return;
  kept.delete(version);
  kept.set(version, png);
  keptBytes += png.byteLength;
  for (const [key, value] of kept) {
    if (kept.size <= KEPT_MOST && keptBytes <= KEPT_BYTES) break;
    kept.delete(key);
    keptBytes -= value.byteLength;
  }
}

class Busy extends Error {}

async function drawn(card: ShareCard, version: string): Promise<Uint8Array | undefined> {
  const hit = kept.get(version);
  if (hit) {
    kept.delete(version);
    kept.set(version, hit);
    return hit;
  }
  const draw = await drawing();
  if (!draw) return undefined;
  const already = drawingNow.get(version);
  if (already) return already;
  if (running >= AT_ONCE && waiting.length >= WAITING_MOST) throw new Busy();
  const work = (async () => {
    /* Always a turn of the loop first, so the drawing is in drawingNow before anything below can finish. */
    await Promise.resolve();
    while (running >= AT_ONCE) await new Promise<void>((resolve) => waiting.push(resolve));
    running += 1;
    try {
      const png = await draw(card);
      keep(version, png);
      return png;
    } finally {
      running -= 1;
      drawingNow.delete(version);
      waiting.shift()?.();
    }
  })();
  drawingNow.set(version, work);
  return work;
}

function plain(res: ServerResponse, status: number, text: string, extra: Record<string, string> = {}): void {
  if (res.headersSent || res.destroyed) return;
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(`${text}\n`);
}

/**
 * Answer the route with `card`, the one the asked address has now, or 404
 * where it has none. The hash the page named is the long-lived answer; any
 * other (an older page's) is answered with today's card for five minutes.
 */
export async function sendShareCard(req: IncomingMessage, res: ServerResponse, card: ShareCard | undefined, asked?: string): Promise<void> {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    if (!res.headersSent) res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return;
  }
  if (!card) return plain(res, 404, 'No card here.');
  const version = cardVersion(card);
  let png: Uint8Array | undefined;
  try {
    png = await drawn(card, version);
  } catch (error) {
    if (error instanceof Busy) return plain(res, 503, 'Cards are being drawn; ask again shortly.', { 'retry-after': '5' });
    return plain(res, 500, 'The card could not be drawn.');
  }
  if (!png) return plain(res, 404, 'No card here.');
  if (res.headersSent || res.destroyed) return;
  const etag = `"${version}"`;
  const headers = {
    etag,
    'cache-control': asked === version ? 'public, max-age=31536000, immutable' : 'public, max-age=300',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'",
  };
  const match = String(req.headers['if-none-match'] ?? '')
    .split(',')
    .some((tag) => tag.trim().replace(/^W\//, '') === etag);
  if (match) {
    res.writeHead(304, headers).end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-type': 'image/png', 'content-length': String(png.byteLength) });
  res.end(req.method === 'HEAD' ? undefined : Buffer.from(png.buffer, png.byteOffset, png.byteLength));
}
