/**
 * A theme's own stylesheet (`stylesheet: './theme.css'`, docs/theming.md), read by an allowlist and written back out
 * scoped to the theme. Nothing the reader does not know is passed through: the file is tokenized here, each rule's
 * selector and each declaration is matched against the short grammar below, and the sheet that is served is
 * re-serialized from what matched, so a comment, an escape or a stray brace cannot smuggle a second rule past it.
 * No CSS library: the grammar is small because the allowlist is, and a native parser would be a binary in every
 * `npx tablewalk` (the maintainer's call, 0.9.4).
 *
 * What it admits (contract 1): rules on published parts, `[data-part="stat"]`, with `:hover`, `:focus-visible`,
 * `[aria-current]`, `[aria-selected="true"]` or `[aria-expanded="true"]`, under an optional `[data-mode="dark"]`; and
 * declarations that dress a box without moving it — colors as roles, role gradients and pictures beside the sheet,
 * edges of at most 3px, the theme's corners, lifts and faces, letter case and spacing, underlines and figure forms.
 * What it refuses, with the line and why: everything else, at-rules and `!important` first.
 *
 * Which elements a part names is the platform's (themePartSelectors.ts): `[data-part="stat"]` is written out as the
 * selectors the stat is drawn with, so the hook stays where the stat is when its markup changes. The whole is wrapped
 * in `@layer theme` (over the look, under the structure) and every rule is prefixed by the theme's root, so it draws
 * only while the theme is worn.
 */
import { PALETTE_TOKENS } from '@mistriwork/engine/shared/themeTokens.js';
import { THEME_PARTS } from '@mistriwork/engine/shared/themeParts.js';

/** The most a theme's sheet may weigh, in bytes (C11). */
export const STYLESHEET_MAX = 8 * 1024;

interface StylesheetProblem {
  /** 1-based line of the file. */
  line: number;
  /** The selector or declaration, as written (shortened). */
  text: string;
  why: string;
}

interface ReadStylesheet {
  /** The scoped sheet, ready to serve; empty when nothing was admitted. */
  css: string;
  problems: StylesheetProblem[];
  /** The pictures it names, as written (`./paper.png`), for the caller to read and serve. */
  files: string[];
}

export interface ReadOptions {
  /** The theme's id: every rule is scoped to `:root[data-visual-theme="<id>"]`. */
  themeId: string;
  /** The selectors a published part is drawn with (themePartSelectors.ts). */
  selectorFor: (part: string) => string;
  /** Where a picture beside the sheet is served; undefined when there is no such file. Omitted, every url is kept as written (for a check that only reads). */
  url?: (file: string) => string | undefined;
}

const PARTS: ReadonlySet<string> = new Set(THEME_PARTS);

/* ---------- tokens ---------- */

interface Rule {
  selector: string;
  selectorLine: number;
  body: { text: string; line: number }[];
}

/**
 * The file as rules, or the problem that stopped the reading. Comments are whitespace; a backslash anywhere is
 * refused (an escape is how a selector or a value hides what it says); a string may not cross a line.
 */
function rulesOf(source: string, problems: StylesheetProblem[]): Rule[] {
  const rules: Rule[] = [];
  let line = 1;
  let index = 0;
  let text = '';
  let textLine = 1;
  let inBlock = false;
  let depth = 0;
  let current: Rule | undefined;
  const stop = (why: string, at = line) => {
    problems.push({ line: at, text: excerpt(text || source.slice(index, index + 40)), why });
    return [] as Rule[];
  };
  const flushDeclaration = () => {
    if (current && text.trim()) current.body.push({ text: text.trim(), line: textLine });
    text = '';
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === '\\') return stop('escapes are not read: write the character itself.');
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return stop('a comment is never closed.');
      for (const c of source.slice(index, end + 2)) if (c === '\n') line++;
      index = end + 2;
      text += ' ';
      continue;
    }
    if (char === '"' || char === "'") {
      const end = source.indexOf(char, index + 1);
      const newline = source.indexOf('\n', index + 1);
      if (source.slice(index, end).includes('\\')) return stop('escapes are not read: write the character itself.');
      if (end < 0 || (newline >= 0 && newline < end)) return stop('a string is never closed on its line.');
      if (!text.trim()) textLine = line;
      text += source.slice(index, end + 1);
      index = end + 1;
      continue;
    }
    if (char === '\n') line++;
    if (char === '@' && !inBlock) return stop('at-rules are not read: no @media, @import, @font-face, @layer or @keyframes.');
    if (char === '(') depth++;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0 && char === '{') {
      if (inBlock) return stop('rules do not nest.');
      if (!text.trim()) return stop('a block with no selector.');
      current = { selector: text.trim(), selectorLine: textLine, body: [] };
      text = '';
      inBlock = true;
      index++;
      continue;
    }
    if (depth === 0 && char === '}') {
      if (!inBlock) return stop('a closing brace with no rule.');
      flushDeclaration();
      rules.push(current!);
      current = undefined;
      inBlock = false;
      index++;
      continue;
    }
    if (depth === 0 && char === ';' && inBlock) {
      flushDeclaration();
      index++;
      continue;
    }
    if (!text.trim() && char.trim()) textLine = line;
    text += char;
    index++;
  }
  if (inBlock) return stop('a rule is never closed.', current!.selectorLine);
  if (text.trim()) return stop('text after the last rule.', textLine);
  return rules;
}

const excerpt = (text: string) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
};

/** `text` split at `separator` where it is not inside parentheses. */
function splitTop(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim());
}
/** `text` split on whitespace outside parentheses. */
const words = (text: string) =>
  splitTop(text.replace(/\s+/g, ' '), ' ')
    .filter(Boolean)
    .map((word) => word.trim());

/* ---------- selectors ---------- */

const ATTRIBUTE = /^\[([a-z-]+)(?:=(?:"([^"]*)"|'([^']*)'|([a-z0-9.-]+)))?\]/;
const STATES: Record<string, (value: string | undefined) => string | undefined> = {
  'aria-current': (value) =>
    value === undefined ? '[aria-current]' : value === 'page' || value === 'true' ? `[aria-current="${value}"]` : undefined,
  'aria-selected': (value) => (value === 'true' ? '[aria-selected="true"]' : undefined),
  'aria-expanded': (value) => (value === 'true' ? '[aria-expanded="true"]' : undefined),
};

/** One selector of a list, read: whether it is dark mode's, and the part's selector with its states. */
function selectorOf(raw: string, selectorFor: ReadOptions['selectorFor']): { dark: boolean; selector: string } | string {
  let rest = raw.trim().replace(/\s+/g, ' ');
  let dark = false;
  const mode = /^\[data-mode=(?:"dark"|'dark'|dark)\] /.exec(rest);
  if (mode) {
    dark = true;
    rest = rest.slice(mode[0].length);
  }
  const part = ATTRIBUTE.exec(rest);
  if (!part || part[1] !== 'data-part')
    return 'a selector names one published part, [data-part="stat"], optionally under [data-mode="dark"]: no tags, classes, ids, :has() or *.';
  const name = part[2] ?? part[3] ?? part[4] ?? '';
  if (!PARTS.has(name)) return `"${name}" is not a published part.`;
  rest = rest.slice(part[0].length);
  let states = '';
  while (rest) {
    if (rest.startsWith(':hover')) {
      states += ':hover';
      rest = rest.slice(6);
      continue;
    }
    if (rest.startsWith(':focus-visible')) {
      states += ':focus-visible';
      rest = rest.slice(14);
      continue;
    }
    const attribute = ATTRIBUTE.exec(rest);
    const state = attribute && STATES[attribute[1]!]?.(attribute[2] ?? attribute[3] ?? attribute[4]);
    if (!attribute || !state)
      return `"${excerpt(rest)}" is not read: a part takes :hover, :focus-visible, [aria-current], [aria-selected="true"] and [aria-expanded="true"].`;
    states += state;
    rest = rest.slice(attribute[0].length);
  }
  return { dark, selector: `:is(${selectorFor(name)})${states}` };
}

/* ---------- values ---------- */

/** The roles a color may be: each palette color's custom property, never a width. */
const ROLE_TOKENS: ReadonlySet<string> = new Set(
  Object.entries(PALETTE_TOKENS)
    .filter(([role]) => role !== 'rulesWeight' && role !== 'rulesControl')
    .map(([, token]) => token)
    .concat('--band'),
);
const RADIUS_VALUES = new Set([
  '0',
  'var(--radius)',
  'var(--control-radius)',
  'var(--field-radius)',
  'var(--pill-radius)',
  'var(--radius-lg)',
  'var(--radius-pop)',
  'var(--radius-panel)',
  'var(--radius-dialog)',
]);
const SHADOW_VALUES = new Set([
  'none',
  'var(--shadow-card)',
  'var(--shadow-pop)',
  'var(--shadow-panel)',
  'var(--shadow-modal)',
  'var(--shadow-control)',
]);
const FACE_VALUES = new Set(['var(--sans)', 'var(--mono)', 'var(--heading-font)', 'var(--heading-font, var(--sans))']);
const LENGTH = /^-?(?:\d+|\d*\.\d+)(?:px|%|em)?$/;
const EDGE_WIDTH = /^(?:0|0?\.5px|[123]px)$/;
const EDGE_STYLES = new Set(['none', 'solid', 'dashed', 'dotted', 'double']);

function isColor(value: string, depth = 0): boolean {
  if (value === 'transparent' || value === 'currentcolor') return true;
  const role = /^var\((--[a-z0-9-]+)\)$/.exec(value);
  if (role) return ROLE_TOKENS.has(role[1]!);
  const mix = /^color-mix\((.*)\)$/.exec(value);
  if (!mix || depth > 1) return false;
  const [space, a, b, ...more] = splitTop(mix[1]!, ',');
  if (more.length || !a || !b || !/^in (?:srgb|srgb-linear|oklab|oklch)$/.test(space ?? '')) return false;
  return [a, b].every((stop) => {
    const [color, percent, ...extra] = words(stop);
    return !extra.length && isColor(color ?? '', depth + 1) && (percent === undefined || /^(?:\d{1,2}|100)(?:\.\d+)?%$/.test(percent));
  });
}

const DIRECTION_WORDS = new Set([
  'to',
  'top',
  'bottom',
  'left',
  'right',
  'center',
  'at',
  'circle',
  'ellipse',
  'closest-side',
  'closest-corner',
  'farthest-side',
  'farthest-corner',
]);
function isGradient(value: string): boolean {
  const match = /^(?:repeating-)?(linear|radial)-gradient\((.*)\)$/.exec(value);
  if (!match) return false;
  const [first, ...rest] = splitTop(match[2]!, ',');
  const stops = rest;
  const firstWords = words(first ?? '');
  const isStop = (stop: string) => {
    const [color, ...positions] = words(stop);
    return isColor(color ?? '') && positions.length <= 2 && positions.every((position) => LENGTH.test(position));
  };
  if (!isStop(first ?? '')) {
    const direction = firstWords.every((word) => DIRECTION_WORDS.has(word) || /^-?\d+(?:\.\d+)?deg$/.test(word) || LENGTH.test(word));
    if (!direction) return false;
  } else stops.unshift(first!);
  return stops.length >= 2 && stops.length <= 8 && stops.every(isStop);
}

const URL = /^url\((?:"([^"]*)"|'([^']*)'|([^\s"'()]*))\)$/;
const PICTURE = /^\.\/(?:[\w-]+\/)*[\w-]+\.(?:png|jpe?g|webp|gif|svg|avif)$/;

interface ValueContext {
  files: string[];
  url: ReadOptions['url'];
}

/** A picture beside the sheet as the url it is served at, or why not. */
function pictureOf(value: string, context: ValueContext): string | { why: string } | undefined {
  const match = URL.exec(value);
  if (!match) return undefined;
  const file = match[1] ?? match[2] ?? match[3] ?? '';
  if (!PICTURE.test(file)) return { why: `url(${file}) must name a picture beside the sheet, like url(./paper.png).` };
  if (!context.files.includes(file)) context.files.push(file);
  const href = context.url ? context.url(file) : file;
  if (href === undefined) return { why: `${file} is not there beside the sheet.` };
  return `url("${href}")`;
}

function backgroundImage(value: string, context: ValueContext): string | { why: string } {
  if (value === 'none') return value;
  const layers = splitTop(value, ',');
  if (layers.length > 4) return { why: 'at most four layers.' };
  const out: string[] = [];
  for (const layer of layers) {
    if (isGradient(layer)) {
      out.push(layer);
      continue;
    }
    const picture = pictureOf(layer, context);
    if (typeof picture === 'string') out.push(picture);
    else return picture ?? { why: 'a layer is a gradient of roles (linear-gradient(var(--surface), var(--raised))) or url(./file).' };
  }
  return out.join(', ');
}

function edge(value: string): boolean {
  const parts = words(value);
  if (!parts.length || parts.length > 3) return false;
  let width = 0,
    style = 0,
    color = 0;
  for (const part of parts) {
    if (EDGE_WIDTH.test(part)) width++;
    else if (EDGE_STYLES.has(part)) style++;
    else if (isColor(part)) color++;
    else return false;
  }
  return width <= 1 && style <= 1 && color <= 1;
}

const WHY = {
  color: 'a color is a role, var(--accent), transparent, currentcolor or a color-mix() of those: never a hex or a name.',
  edge: 'an edge is a width of at most 3px, a style and a role color.',
  radius:
    "a corner is one of the theme's: var(--radius), var(--control-radius), var(--field-radius), var(--pill-radius), var(--radius-lg) or 0.",
  shadow: "a lift is none or one of the look's: var(--shadow-card), var(--shadow-pop), var(--shadow-panel), var(--shadow-modal).",
  face: "a face is one of the theme's stacks: var(--sans), var(--heading-font) or var(--mono).",
};

type Check = (value: string, context: ValueContext) => string | { why: string };
const accept =
  (test: (value: string) => boolean, why: string): Check =>
  (value) =>
    test(value) ? value : { why };
const oneOf = (...values: string[]) => accept((value) => values.includes(value), `it takes ${values.join(', ')}.`);
const color = accept(isColor, WHY.color);
const edgeCheck = accept(edge, WHY.edge);

/** Each property the sheet may say, and what it may say. */
const PROPERTIES: Record<string, Check> = {
  color,
  'background-color': color,
  'border-color': accept((value) => words(value).length <= 4 && words(value).every((part) => isColor(part)), WHY.color),
  'border-top-color': color,
  'border-right-color': color,
  'border-bottom-color': color,
  'border-left-color': color,
  'text-decoration-color': color,
  'background-image': backgroundImage,
  background: (value, context) => (isColor(value) ? value : backgroundImage(value, context)),
  'background-size': accept(
    (value) =>
      value === 'cover' ||
      value === 'contain' ||
      splitTop(value, ',').every((layer) => words(layer).length <= 2 && words(layer).every((part) => part === 'auto' || LENGTH.test(part))),
    'a size is auto, cover, contain or lengths.',
  ),
  'background-position': accept(
    (value) =>
      splitTop(value, ',').every(
        (layer) =>
          words(layer).length <= 2 &&
          words(layer).every((part) => ['top', 'bottom', 'left', 'right', 'center'].includes(part) || LENGTH.test(part)),
      ),
    'a position is top, bottom, left, right, center or lengths.',
  ),
  'background-repeat': accept(
    (value) =>
      splitTop(value, ',').every((layer) =>
        /^(?:repeat|no-repeat|repeat-x|repeat-y|round|space)(?: (?:repeat|no-repeat|round|space))?$/.test(layer),
      ),
    'it takes repeat, no-repeat, repeat-x, repeat-y, round or space.',
  ),
  border: edgeCheck,
  'border-top': edgeCheck,
  'border-right': edgeCheck,
  'border-bottom': edgeCheck,
  'border-left': edgeCheck,
  'border-width': accept(
    (value) => words(value).length <= 4 && words(value).every((part) => EDGE_WIDTH.test(part)),
    'an edge is at most 3px.',
  ),
  'border-style': accept(
    (value) => words(value).length <= 4 && words(value).every((part) => EDGE_STYLES.has(part)),
    'it takes none, solid, dashed, dotted or double.',
  ),
  'border-radius': accept((value) => words(value).length <= 4 && words(value).every((part) => RADIUS_VALUES.has(part)), WHY.radius),
  'box-shadow': accept((value) => SHADOW_VALUES.has(value), WHY.shadow),
  'font-family': accept((value) => FACE_VALUES.has(value), WHY.face),
  'text-transform': oneOf('none', 'uppercase', 'lowercase', 'capitalize'),
  'letter-spacing': accept((value) => {
    if (value === 'normal' || value === 'var(--track-caps)' || value === 'var(--track-title)') return true;
    const em = /^(-?(?:0|0?\.\d{1,3}))em$/.exec(value);
    return Boolean(em) && Number(em![1]) >= -0.03 && Number(em![1]) <= 0.15;
  }, 'a spacing is normal, var(--track-caps), var(--track-title), or -0.03em to 0.15em.'),
  'text-decoration-line': accept(
    (value) => value === 'none' || words(value).every((part) => ['underline', 'overline', 'line-through'].includes(part)),
    'it takes none, underline, overline or line-through.',
  ),
  'text-decoration-style': oneOf('solid', 'double', 'dotted', 'dashed', 'wavy'),
  'text-decoration-thickness': accept(
    (value) => /^(?:auto|from-font|[12]px|0?\.\d{1,2}em)$/.test(value),
    'it takes auto, from-font, 1px, 2px or a fraction of an em.',
  ),
  'font-variant-caps': oneOf('normal', 'small-caps', 'all-small-caps'),
  'font-variant-numeric': accept(
    (value) =>
      value === 'normal' ||
      words(value).every((part) =>
        ['lining-nums', 'oldstyle-nums', 'tabular-nums', 'proportional-nums', 'slashed-zero', 'diagonal-fractions', 'ordinal'].includes(
          part,
        ),
      ),
    'it takes normal, lining-nums, oldstyle-nums, tabular-nums, proportional-nums, slashed-zero, diagonal-fractions or ordinal.',
  ),
  'font-variant-ligatures': oneOf('normal', 'none', 'common-ligatures', 'no-common-ligatures'),
};

/** Why a property the grammar does not take is refused, for the few an author is likeliest to reach for. */
function refusedProperty(property: string): string {
  if (/^(display|visibility|opacity|order|position|z-index|float|clear|content)$/.test(property))
    return `${property} would change what the App shows: a theme dresses parts, it does not move, hide or add them (C13).`;
  if (/^(width|height|min-|max-|margin|padding|gap|inset|top|right|bottom|left|grid|flex|align|justify|place)/.test(property))
    return `${property} would move a box: sizes and spacing are density's and the structure's (C5).`;
  if (/^(font-size|line-height|font-weight)$/.test(property))
    return `${property} is type.roles' (type.base and each role's size, leading and weight).`;
  if (/^(transform|transition|animation)/.test(property)) return `${property} would move or animate: motion is the theme's pace (motion).`;
  /* A glow is the one light a theme cannot draw: a lift is a shadow in the theme's `shadow` ink, which C2 refuses
     lighter than the ground, and these would draw the bloom round it. */
  if (/^(text-shadow|filter|backdrop-filter)$/.test(property))
    return `${property} would draw a glow: a theme lifts a part with box-shadow and one of the look's lifts, in its shadow color, never lighter than the ground (C2).`;
  if (property.startsWith('outline'))
    return "the focus ring is the platform's (colors.focus and shape.border.focus), so it always shows (C3).";
  return `${property} is not a property a theme's sheet takes.`;
}

/* ---------- the reader ---------- */

/** A theme's stylesheet read against the allowlist and scoped to the theme: the sheet to serve, and every refusal. */
export function readThemeStylesheet(source: string, options: ReadOptions): ReadStylesheet {
  const problems: StylesheetProblem[] = [];
  const files: string[] = [];
  if (Buffer.byteLength(source) > STYLESHEET_MAX)
    problems.push({
      line: 1,
      text: `${Buffer.byteLength(source)} bytes`,
      why: `a theme's sheet is at most ${STYLESHEET_MAX / 1024} KB (C11).`,
    });
  const context: ValueContext = { files, url: options.url };
  const root = `:root[data-visual-theme="${options.themeId}"]`;
  const light: string[] = [];
  const dark: string[] = [];
  for (const rule of rulesOf(source, problems)) {
    const selectors: { dark: boolean; selector: string }[] = [];
    for (const raw of splitTop(rule.selector, ',')) {
      const read = selectorOf(raw, options.selectorFor);
      if (typeof read === 'string') problems.push({ line: rule.selectorLine, text: excerpt(raw), why: read });
      else selectors.push(read);
    }
    const declarations: string[] = [];
    for (const { text, line } of rule.body) {
      const colon = text.indexOf(':');
      const property = (colon < 0 ? text : text.slice(0, colon)).trim().toLowerCase();
      const raw = colon < 0 ? '' : text.slice(colon + 1).trim();
      if (colon < 0 || !/^[a-z-]+$/.test(property) || !raw) {
        problems.push({ line, text: excerpt(text), why: 'a declaration is a property, a colon and a value.' });
        continue;
      }
      if (/!\s*important/i.test(raw)) {
        problems.push({ line, text: excerpt(text), why: '!important is not read: the theme layer already sits over the look.' });
        continue;
      }
      const check = PROPERTIES[property];
      if (!check) {
        problems.push({ line, text: excerpt(text), why: refusedProperty(property) });
        continue;
      }
      /* Lower-cased but for a picture's path; whitespace made one space, and none just inside a parenthesis. */
      const value = raw
        .replace(/\s+/g, ' ')
        .replace(/\(\s+/g, '(')
        .replace(/\s+\)/g, ')')
        .replace(/\s*,\s*/g, ', ')
        .replace(/url\([^)]*\)|[^u]+|u/g, (piece) => (piece.startsWith('url(') ? piece : piece.toLowerCase()));
      const read = check(value, context);
      if (typeof read !== 'string') problems.push({ line, text: excerpt(text), why: read.why });
      else declarations.push(`${property}: ${read}`);
    }
    if (!selectors.length || !declarations.length) continue;
    const body = `{ ${declarations.join('; ')}; }`;
    const lightOnes = selectors.filter((one) => !one.dark).map((one) => `${root} ${one.selector}`);
    const darkOnes = selectors.filter((one) => one.dark).map((one) => one.selector);
    if (lightOnes.length) light.push(`${lightOnes.join(', ')} ${body}`);
    if (darkOnes.length) dark.push(`${darkOnes.map((one) => `${root}[data-theme="dark"] ${one}`).join(', ')} ${body}`);
    if (darkOnes.length)
      dark.push(
        `@media (prefers-color-scheme: dark) { ${darkOnes.map((one) => `${root}:not([data-theme="light"]) ${one}`).join(', ')} ${body} }`,
      );
  }
  if (problems.length || (!light.length && !dark.length)) return { css: '', problems, files };
  return { css: `@layer theme {\n${[...light, ...dark].join('\n')}\n}\n`, problems, files };
}
