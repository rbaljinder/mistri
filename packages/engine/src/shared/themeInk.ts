/**
 * The two inks an accent needs that are not the accent. A brand accent is
 * chosen as a fill (a button, a tab, a meter), and the words drawn on it and
 * the words drawn in it are two other colors: a bright orange wants near-black
 * words on it, and is 2.3:1 as text on a white page. A theme may say them
 * (`onAccent`, `accentInk`); where it says nothing and the accent as it stands
 * would fail, the one that passes is taken, so most themes never name either.
 * Both are answered only when they differ from what the sheets already do
 * (the page's color on the accent, the accent itself as text): an accent that
 * passes keeps every theme's tokens exactly as they were.
 */
import type { ThemePalette } from '../../schema/theme.js';

const HEX = /^#[0-9a-f]{6}$/i;
/** Text needs this much against what it is drawn on (WCAG 1.4.3). */
const TEXT = 4.5;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return r! * 0.2126 + g! * 0.7152 + b! * 0.0722;
}
function contrast(a: string, b: string): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function mix(a: string, b: string, weight: number): string {
  return `#${[1, 3, 5]
    .map((start) =>
      Math.round(parseInt(a.slice(start, start + 2), 16) * weight + parseInt(b.slice(start, start + 2), 16) * (1 - weight))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

type Colors = Pick<ThemePalette, 'accent' | 'ink' | 'surface'> & Partial<ThemePalette>;

/** The words on an accent fill when the page's color would not read on it: the ink if that does, else the better of white and black. Undefined where the default reads, or where a color is no hex to measure. */
export function deriveOnAccent(palette: Colors): string | undefined {
  const fill = palette.accent;
  const given = palette.ground ?? palette.surface;
  if (!HEX.test(fill) || !HEX.test(given) || contrast(given, fill) >= TEXT) return undefined;
  if (HEX.test(palette.ink) && contrast(palette.ink, fill) >= TEXT) return palette.ink.toLowerCase();
  return contrast('#ffffff', fill) >= contrast('#000000', fill) ? '#ffffff' : '#000000';
}

/** The accent as text and links when it would not read on the grounds a word stands on: the accent drawn toward the ink until it does, so the hue stays the brand's. Undefined where it reads already.
    `soft`: the accent's own 14% tint is a ground too (a selected item, where an App's accent draws accentSoft as that
    tint): on a ground darker than white, Workshop's paper, a blue that reads on the page fell to 4.4:1 on its tint. */
export function deriveAccentInk(palette: Colors, soft = false): string | undefined {
  const accent = palette.accent;
  if (!HEX.test(accent) || !HEX.test(palette.ink)) return undefined;
  const pages = [palette.surface, palette.ground, palette.raised].filter((color): color is string => Boolean(color && HEX.test(color)));
  if (!pages.length) return undefined;
  const grounds = soft ? [...pages, ...pages.map((page) => mix(accent, page, 0.14))] : pages;
  const reads = (color: string) => grounds.every((ground) => contrast(color, ground) >= TEXT);
  if (reads(accent)) return undefined;
  for (let step = 1; step <= 20; step++) {
    const color = mix(palette.ink, accent, step / 20);
    if (reads(color)) return color;
  }
  return palette.ink.toLowerCase();
}
