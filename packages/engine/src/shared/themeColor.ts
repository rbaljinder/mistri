/**
 * The colour arithmetic a theme is measured with: a bounded evaluator of the colours a palette is written in, mixing
 * and compositing as the page does, and WCAG contrast. Apart from theme.ts, which judges whole themes, because the
 * client draws with one result of it (heatTop, a matrix's strongest tint) on every first paint, and theme.ts with its
 * recipes, faces and checks is several kilobytes no first paint should carry.
 */
import type { ThemePalette } from '../../schema/theme.js';

export type Color = readonly [number, number, number, number];
/** A deliberately bounded color evaluator, not a CSS parser. Fractional sRGB
    channels stay unrounded through compositing and luminance calculation. */
export function diagnosticColor(value: string, depth = 0): Color | undefined {
  if (depth > 8) return undefined;
  value = value.trim().toLowerCase();
  if (value === 'transparent') return [0, 0, 0, 0];
  if (value === 'white') return [1, 1, 1, 1];
  if (value === 'black') return [0, 0, 0, 1];
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(value)) {
    const hex =
      value.length < 6
        ? value
            .slice(1)
            .split('')
            .map((char) => char + char)
            .join('')
        : value.slice(1);
    return [
      parseInt(hex.slice(0, 2), 16) / 255,
      parseInt(hex.slice(2, 4), 16) / 255,
      parseInt(hex.slice(4, 6), 16) / 255,
      hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
    ];
  }
  // The two expressions emitted by effectiveThemePalette. The inner legacy
  // color can be unknown; that remains unmeasured rather than guessed.
  const mix = /^color-mix\(in srgb, (.+) (62|14)%, (white|transparent)\)$/.exec(value);
  const color = mix && diagnosticColor(mix[1]!, depth + 1);
  return color ? mixColor(color, diagnosticColor(mix![3]!)!, Number(mix![2]) / 100) : undefined;
}

export function mixColor(a: Color, b: Color, weight: number): Color {
  const alpha = a[3] * weight + b[3] * (1 - weight);
  const channel = (index: 0 | 1 | 2) => (alpha ? (a[index] * a[3] * weight + b[index] * b[3] * (1 - weight)) / alpha : 0);
  return [channel(0), channel(1), channel(2), alpha];
}

export function over(color: Color, ground: Color): Color {
  const alpha = color[3] + ground[3] * (1 - color[3]);
  const channel = (index: 0 | 1 | 2) => (alpha ? (color[index] * color[3] + ground[index] * ground[3] * (1 - color[3])) / alpha : 0);
  return [channel(0), channel(1), channel(2), alpha];
}

export function measuredContrast(foreground: Color, background: Color): number | undefined {
  if (background[3] !== 1) return undefined; // No known opaque ground.
  const luminance = (color: Color) =>
    color
      .slice(0, 3)
      .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
      .reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index]!, 0);
  const a = luminance(over(foreground, background)),
    b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** A composited colour as the page paints it, `#rrggbb` (alpha dropped: a ground is opaque, an ink composited on one). */
export function colorHex(color: Color): string {
  return `#${color
    .slice(0, 3)
    .map((value) =>
      Math.round(Math.min(1, Math.max(0, value)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

/** The strongest a heat tint is drawn (a matrix's heaviest cell), as a share of the accent over the panel. */
export const HEAT_TOP = 0.62;
/** Below this a heat scale stops reading as one: the palette's heaviest cell is drawn here and `check` says why. */
const HEAT_FLOOR = 0.2;

/**
 * How strong a heat tint may be drawn under a palette: the strongest share of the accent over the panel, at most
 * HEAT_TOP, on which the ink still reads at 4.5:1. A matrix's cells say their figure (and, folded, their column) in
 * the ink on that tint, so the scale stops where the words would fade: 62% under Lumen's blue, about half under
 * Mono's black or a dark mode's light accent, where the ink sits near the accent. Unmeasurable colors keep HEAT_TOP.
 */
export function heatTop(palette: Pick<ThemePalette, 'accent' | 'surface' | 'ink'>): number {
  const accent = palette.accent && diagnosticColor(palette.accent),
    surface = palette.surface && diagnosticColor(palette.surface),
    ink = palette.ink && diagnosticColor(palette.ink);
  if (!accent || !surface || !ink) return HEAT_TOP;
  for (let step = Math.round(HEAT_TOP * 100); step > HEAT_FLOOR * 100; step--) {
    const ratio = measuredContrast(ink, over(mixColor(accent, [0, 0, 0, 0], step / 100), surface));
    if (ratio === undefined || ratio >= 4.5) return step / 100;
  }
  return HEAT_FLOOR;
}

/** What a command form's field edge at rest is drawn to: 3:1 with room to spare, short of a line that shouts. */
const FIELD_EDGE = 3.5;
/** Past this a control's edge is a line drawn to be seen (Mono's ink), not a field's quiet boundary. */
const FIELD_EDGE_CEILING = 4.5;

/**
 * A command form's field edge at rest (formDress.css, `--field-edge`): a clean outline at 3:1 on what the field
 * stands on (WCAG 1.4.11). Where the look's control edge (`lineControl`) already reads at up to 4.5:1 on its surface
 * and its page, it is that edge, so a form's field and a record's inline edit wear one line (Lumen, Sage). A stronger
 * one — Mono's ink, a theme's near-black — is mixed toward the surface to the lightest that still clears FIELD_EDGE on
 * both: a box of solid ink round every answer read as a form shouting. Undefined keeps the look's own edge (the sheet
 * falls back to `--line-control`), and so does a color this cannot measure.
 */
export function fieldEdge(palette: Pick<ThemePalette, 'lineControl' | 'surface' | 'ground'>): string | undefined {
  const edge = palette.lineControl && diagnosticColor(palette.lineControl),
    surface = palette.surface && diagnosticColor(palette.surface),
    ground = palette.ground ? diagnosticColor(palette.ground) : surface;
  if (!edge || !surface || !ground) return undefined;
  const least = (color: Color) => Math.min(measuredContrast(color, surface) ?? 0, measuredContrast(color, ground) ?? 0);
  if (least(edge) <= FIELD_EDGE_CEILING) return undefined;
  for (let step = 1; step < 100; step++) {
    const mixed = mixColor(edge, surface, step / 100);
    if (least(mixed) >= FIELD_EDGE) return colorHex(mixed);
  }
  return undefined;
}
