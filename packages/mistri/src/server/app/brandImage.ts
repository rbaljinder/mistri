/**
 * A logo, admitted — a tenant's upload, or an App's own `ui.logo` picture (appBrand.ts): a raster image the bytes say is one (PNG, JPEG,
 * WebP, GIF), or an SVG rebuilt from an allowlist. Nothing the upload calls
 * itself is believed — not its name, not its declared type: the first bytes
 * decide, and an SVG is parsed and written again element by element, so what is
 * served is only what this file understood. It is served from the App's own
 * origin with its sniffed type, `nosniff` and a policy that runs nothing, and is
 * drawn through `<img>`, where an SVG's scripts never run anyway: three walls,
 * any one of which holds.
 */
import { createHash } from 'node:crypto';

/** A logo is a mark, not a photograph: 256 KiB holds a crisp 2x raster; an SVG mark is a few KiB. */
const LOGO_MOST = { raster: 256 * 1024, svg: 64 * 1024 } as const;

type LogoType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/svg+xml';

export interface AdmittedLogo {
  readonly type: LogoType;
  readonly bytes: Buffer;
  /** sha256 of the served bytes, hex: the logo's address, so a new logo is a new URL and an old one may be cached forever. */
  readonly hash: string;
}

/** Why a logo was refused, in the sentence the Branding block shows. */
export class LogoRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LogoRefused';
  }
}

function sniff(bytes: Buffer): Exclude<LogoType, 'image/svg+xml'> | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return undefined;
}

/** The logo as it will be served, or a refusal that says why. */
export function admitLogo(bytes: Buffer): AdmittedLogo {
  if (!bytes.length) throw new LogoRefused('This file is empty.');
  const raster = sniff(bytes);
  if (raster) {
    if (bytes.length > LOGO_MOST.raster)
      throw new LogoRefused('This logo is larger than 256 KB. Export it smaller (a 512-pixel-wide PNG is plenty).');
    return { type: raster, bytes, hash: digest(bytes) };
  }
  if (bytes.length > LOGO_MOST.svg)
    throw new LogoRefused('This logo is not a PNG, JPEG, WebP or GIF, and is too large to be an SVG mark (64 KB).');
  const text = bytes.toString('utf8');
  if (!/<svg[\s>]/i.test(text)) throw new LogoRefused('This file is not a PNG, JPEG, WebP, GIF or SVG image.');
  const clean = Buffer.from(sanitizeSvg(text), 'utf8');
  return { type: 'image/svg+xml', bytes: clean, hash: digest(clean) };
}

/** How a logo is served: its sniffed type, kept a year by its content's name, sniffed by nothing, running nothing. */
export function imageHeaders(type: string, length: number): Record<string, string> {
  return {
    'content-type': type,
    'content-length': String(length),
    'cache-control': 'public, max-age=31536000, immutable',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    'content-disposition': 'inline',
  };
}

const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/* ---------- SVG: parsed, then written again from an allowlist ---------- */

/** Shapes, groups, gradients and clips: what a logo is drawn with. No script,
    no foreignObject, no image, no use, no animation, no style element, no link. */
const ELEMENTS = new Set([
  'svg',
  'g',
  'path',
  'rect',
  'circle',
  'ellipse',
  'line',
  'polyline',
  'polygon',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'title',
  'desc',
]);
/** Geometry and paint. No event handler, no href of any kind, no style attribute (it can carry url() and expressions). */
const ATTRIBUTES = new Set([
  'xmlns',
  'version',
  'viewbox',
  'preserveaspectratio',
  'width',
  'height',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'fx',
  'fy',
  'd',
  'points',
  'transform',
  'fill',
  'fill-opacity',
  'fill-rule',
  'stroke',
  'stroke-width',
  'stroke-opacity',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-miterlimit',
  'stroke-dasharray',
  'opacity',
  'clip-path',
  'clip-rule',
  'clippathunits',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'spreadmethod',
  'id',
  'role',
  'aria-label',
]);
/** Paint and clip values may point only inside the file (`url(#id)`), never out of it. */
const REFERENCING = new Set(['fill', 'stroke', 'clip-path']);
const SAFE_VALUE = /^[\w\s#%(),.:;+/-]*$/;

interface Tag {
  kind: 'open' | 'close' | 'self';
  name: string;
  attributes: Array<[string, string]>;
}

/**
 * The SVG written again from what it parsed to: allowed elements with allowed
 * attributes, text only inside title and desc, everything else dropped with
 * its children. A document this parser cannot follow is refused, not guessed at.
 */
export function sanitizeSvg(source: string): string {
  // Declarations and comments are dropped; a DOCTYPE or an entity is how XML reaches outside itself, so it is refused.
  if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(source))
    throw new LogoRefused('This SVG declares a document type or entities, which a logo does not need.');
  const text = source.replace(/<\?xml[^>]*\?>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  if (/<\?|<!--/.test(text)) throw new LogoRefused('This SVG could not be read as a logo.');
  const out: string[] = [];
  const stack: Array<{ name: string; kept: boolean }> = [];
  let dropping = 0;
  let sawRoot = false;
  const TAG = /<\s*(\/?)\s*([A-Za-z][\w:.-]*)((?:\s+[A-Za-z_:][\w:.-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)\s*>/y;
  let index = 0;
  while (index < text.length) {
    const lt = text.indexOf('<', index);
    const chunk = text.slice(index, lt === -1 ? text.length : lt);
    if (chunk.trim()) {
      const parent = stack.at(-1);
      if (!dropping && parent?.kept && (parent.name === 'title' || parent.name === 'desc')) out.push(escapeText(decode(chunk)));
    }
    if (lt === -1) break;
    TAG.lastIndex = lt;
    const match = TAG.exec(text);
    if (!match) throw new LogoRefused('This SVG could not be read as a logo.');
    index = TAG.lastIndex;
    const tag = parseTag(match);
    if (tag.kind === 'close') {
      const open = stack.pop();
      if (!open || open.name !== tag.name) throw new LogoRefused('This SVG could not be read as a logo.');
      if (!open.kept) dropping--;
      else if (!dropping) out.push(`</${CAMEL[open.name] ?? open.name}>`);
      continue;
    }
    if (!sawRoot) {
      if (tag.name !== 'svg') throw new LogoRefused('This file is not an SVG image.');
      sawRoot = true;
    }
    const kept = !dropping && ELEMENTS.has(tag.name);
    if (kept) out.push(writeTag(tag));
    if (tag.kind === 'open') {
      stack.push({ name: tag.name, kept });
      if (!kept) dropping++;
    }
  }
  if (stack.length || !sawRoot) throw new LogoRefused('This SVG could not be read as a logo.');
  return out.join('');
}

function parseTag(match: RegExpExecArray): Tag {
  const name = match[2]!.toLowerCase();
  const attributes: Array<[string, string]> = [];
  const ATTRIBUTE = /([A-Za-z_:][\w:.-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/g;
  for (const attribute of match[3]!.matchAll(ATTRIBUTE))
    attributes.push([attribute[1]!.toLowerCase(), decode(attribute[2] ?? attribute[3] ?? '')]);
  return { kind: match[1] ? 'close' : match[4] ? 'self' : 'open', name, attributes };
}

const CAMEL: Record<string, string> = {
  viewbox: 'viewBox',
  preserveaspectratio: 'preserveAspectRatio',
  lineargradient: 'linearGradient',
  radialgradient: 'radialGradient',
  clippath: 'clipPath',
  clippathunits: 'clipPathUnits',
  gradientunits: 'gradientUnits',
  gradienttransform: 'gradientTransform',
  spreadmethod: 'spreadMethod',
};

function writeTag(tag: Tag): string {
  const kept: string[] = [];
  for (const [name, value] of tag.attributes) {
    if (!ATTRIBUTES.has(name)) continue;
    if (name === 'xmlns') {
      if (value === 'http://www.w3.org/2000/svg') kept.push(`xmlns="${value}"`);
      continue;
    }
    if (!SAFE_VALUE.test(value)) continue;
    const url = /url\s*\(/i.test(value);
    if (url && !(REFERENCING.has(name) && /^url\(#[\w-]+\)$/.test(value.trim()))) continue;
    if (/javascript|data:|expression/i.test(value)) continue;
    kept.push(`${CAMEL[name] ?? name}="${escapeAttribute(value)}"`);
  }
  if (tag.name === 'svg' && !kept.some((attribute) => attribute.startsWith('xmlns='))) kept.unshift('xmlns="http://www.w3.org/2000/svg"');
  const name = CAMEL[tag.name] ?? tag.name;
  return `<${name}${kept.length ? ' ' + kept.join(' ') : ''}${tag.kind === 'self' ? '/' : ''}>`;
}

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === 'amp') return '&';
    if (lower === 'lt') return '<';
    if (lower === 'gt') return '>';
    if (lower === 'quot') return '"';
    if (lower === 'apos') return "'";
    const code = lower.startsWith('#x') ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 31 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}
const escapeAttribute = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const escapeText = (value: string) => value.replace(/[&<>]/g, (c) => `&#${c.charCodeAt(0)};`);
