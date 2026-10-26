/**
 * WCAG 2.2 AA over the colours the design system actually pairs (docs/design.md, Access: text 4.5:1, a field's
 * edge and the focus ring 3:1), for every built-in look in every palette, light and dark, and for the database
 * browser's own look (@mistriwork/ui's tokens.css). Pure computation over the tokens — no browser. It is written apart
 * from the validator `mistri check` runs (shared/theme.ts) so a regression in either shows here; it also measures
 * the grounds that validator leaves out: text on the accent's soft tint, and the placeholder on a field.
 * Disabled text is exempt (1.4.3).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { effectiveThemeDefinition, effectiveThemePalette, THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import type { ThemePalette } from '../packages/engine/schema/theme.js';

type Rgba = [number, number, number, number];

function parse(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim())?.[1];
  assert.ok(hex, `not a hex colour: ${value}`);
  const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex;
  const at = (i: number) => parseInt(full.slice(i, i + 2), 16) / 255;
  return [at(0), at(2), at(4), full.length === 8 ? at(6) : 1];
}
const over = (top: Rgba, ground: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + ground[i]! * (1 - top[3])).concat(1) as Rgba;
function luminance([r, g, b]: Rgba): number {
  const lin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function ratio(foreground: string, background: string, under?: string): number {
  const ground = under ? over(parse(background), parse(under)) : parse(background);
  const a = luminance(over(parse(foreground), ground)),
    b = luminance(ground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** [foreground, background, needed, the ground the background's tint sits on]. */
type Pair = [string, string, number, string?];
const TEXT = ['ink', 'inkMuted', 'inkSubtle', 'link', 'accentInk', 'statusGood', 'statusWarning', 'statusCritical', 'statusInfo'];
const GROUNDS = ['ground', 'surface', 'raised'];

function pairs(): Pair[] {
  return [
    ...TEXT.flatMap((text) => GROUNDS.map((ground): Pair => [text, ground, 4.5])),
    // Selected rows, current tabs and quiet chips draw text on the accent's tint over a panel.
    ...['ink', 'inkMuted', 'link', 'accentInk'].flatMap((text) =>
      ['surface', 'ground'].map((ground): Pair => [text, 'accentSoft', 4.5, ground]),
    ),
    ['onAccent', 'accent', 4.5],
    ['navInk', 'navGround', 4.5],
    ['navMuted', 'navGround', 4.5],
    ['navAccent', 'navGround', 4.5],
    ...GROUNDS.map((ground): Pair => ['lineControl', ground, 3]),
    ...GROUNDS.map((ground): Pair => ['focus', ground, 3]),
  ];
}

function measure(palette: Record<string, string | undefined>, where: string, list: Pair[]): string[] {
  const failures: string[] = [];
  for (const [foreground, background, needs, under] of list) {
    const a = palette[foreground],
      b = palette[background];
    if (!a || !b || (under && !palette[under])) continue;
    const got = ratio(a, b, under && palette[under]);
    if (got < needs)
      failures.push(
        `${where}: ${foreground} ${a} on ${background}${under ? ` over ${under}` : ''} ${b} is ${got.toFixed(2)}:1, needs ${needs}:1`,
      );
  }
  return failures;
}

test('every built-in look, palette and mode meets AA on the pairs the design system draws', () => {
  const failures: string[] = [];
  let measured = 0;
  for (const look of THEME_PRESETS)
    for (const id of ['default', ...(look.palettes ?? []).map((p) => p.id)]) {
      const definition = effectiveThemeDefinition(look, id);
      for (const mode of ['light', 'dark'] as const) {
        const palette = effectiveThemePalette(definition[mode] as ThemePalette, mode === 'dark') as unknown as Record<string, string>;
        // accentInk is the accent itself where a look names none (shared/themeInk.ts).
        const resolved = { ...palette, accentInk: palette.accentInk ?? palette.accent };
        failures.push(...measure(resolved, `${look.id}/${id}/${mode}`, pairs()));
        measured++;
      }
    }
  assert.ok(measured >= 6, 'looks were measured');
  assert.deepEqual(failures, []);
});

/** The custom properties a rule declares, with var(--x) references to its own or the base rule's resolved. */
function declared(css: string, selector: string): Record<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.ok(start >= 0, `${selector} rule`);
  const body = css.slice(start + selector.length + 2, css.indexOf('\n}', start)).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(--[\w-]+):\s*([^;]+);/g)) out[match[1]!] = match[2]!.trim();
  return out;
}

test("the database browser's own look meets AA, light and dark", () => {
  const css = readFileSync(new URL('../packages/ui/src/tokens.css', import.meta.url), 'utf8');
  const light = declared(css, ':root'),
    dark = { ...light, ...declared(css, ':root[data-theme="dark"]') };
  const failures: string[] = [];
  for (const [mode, vars] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    const get = (name: string, seen = 0): string => {
      const value = vars[name] ?? '';
      const ref = /^var\((--[\w-]+)\)$/.exec(value);
      return ref && seen < 5 ? get(ref[1]!, seen + 1) : value;
    };
    const palette: Record<string, string> = {};
    const names: Record<string, string> = {
      ground: '--ground',
      surface: '--surface',
      raised: '--raised',
      ink: '--ink',
      inkMuted: '--ink-muted',
      inkSubtle: '--ink-subtle',
      link: '--link',
      accent: '--accent',
      accentInk: '--accent-ink',
      onAccent: '--on-accent',
      accentSoft: '--accent-soft',
      lineControl: '--line-control',
      focus: '--focus',
      statusGood: '--status-good',
      statusWarning: '--status-warning',
      statusCritical: '--status-critical',
      statusInfo: '--status-info',
    };
    for (const [role, name] of Object.entries(names)) palette[role] = get(name);
    failures.push(...measure(palette, `browser/${mode}`, pairs()));
  }
  assert.deepEqual(failures, []);
});
