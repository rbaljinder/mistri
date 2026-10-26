/**
 * The authoring chip (`.app-issues`) wears the warning color on a tint of
 * itself. Lumen's warning on that tint read 4.41:1 in the top bar, under the
 * 4.5:1 its 12px text needs, so the chip's ink leans toward the look's ink.
 * The test reads the rule from the stylesheet and measures it in every
 * built-in look, light and dark, on each ground the bar can stand on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import { contrastRatio } from '../packages/engine/src/shared/theme.js';

const css = readFileSync(new URL('../packages/kit/src/client/features.css', import.meta.url), 'utf8');
const rule = /\n\.app-issues \{([^}]*)\}/.exec(css)?.[1] ?? '';

const rgb = (hex: string) => [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16));
const hex = (channels: number[]) => '#' + channels.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
/** color-mix(in srgb, a p%, b): `b` is the palette role named, or the ground under a transparent mix. */
function mix(a: string, share: number, b: string) {
  const [x, y] = [rgb(a), rgb(b)];
  return hex(x.map((value, i) => value * share + y[i]! * (1 - share)));
}
const VAR = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());

/** A declaration's color, resolved against a palette and the ground under the chip. */
function resolve(value: string, palette: Record<string, string>, ground: string): string {
  const plain = /^var\(--([a-z-]+)\)$/.exec(value.trim());
  if (plain) return palette[VAR(plain[1]!)]!;
  const mixed = /^color-mix\(in srgb, var\(--([a-z-]+)\) (\d+)%, (?:var\(--([a-z-]+)\)|transparent)\)$/.exec(value.trim());
  assert.ok(mixed, `an .app-issues color the test can read: ${value}`);
  const other = mixed[3] ? palette[VAR(mixed[3])]! : ground;
  return mix(palette[VAR(mixed[1]!)]!, Number(mixed[2]) / 100, other);
}
const declared = (property: string) => {
  const found = new RegExp(`(?:^|[;\\s])${property}:\\s*([^;]+);`).exec(rule)?.[1];
  assert.ok(found, `.app-issues declares ${property}`);
  return found;
};

test('the authoring chip reads 4.5:1 in every built-in look, light and dark, on every ground the bar stands on', () => {
  const failures: string[] = [];
  for (const look of THEME_PRESETS)
    for (const mode of ['light', 'dark'] as const) {
      const palette = look[mode] as unknown as Record<string, string>;
      for (const groundRole of ['ground', 'surface', 'navGround', 'raised']) {
        const ground = palette[groundRole]!;
        const background = resolve(declared('background'), palette, ground);
        const ink = resolve(declared('color'), palette, ground);
        const ratio = contrastRatio(ink, background);
        if (ratio < 4.5) failures.push(`${look.id} ${mode} on ${groundRole}: ${ratio.toFixed(2)}:1`);
      }
    }
  assert.deepEqual(failures, []);
});
