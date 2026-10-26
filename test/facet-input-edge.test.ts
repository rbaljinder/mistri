/**
 * A list rail's facet box is a control, and its edge has to say where it is
 * (WCAG 1.4.11, 3:1). Lumen dressed it as a raised fill behind the hairline
 * (`--line`), which read 1.11:1 against that fill in Depot's rail: the box was
 * a grey patch with no edge. The test reads the look's rule and measures its
 * edge in every built-in look that draws it, light and dark, against the
 * box's own fill and the ground the rail stands on.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import { contrastRatio } from '../packages/engine/src/shared/theme.js';

const css = readFileSync(new URL('../packages/kit/src/client/lumenLook.css', import.meta.url), 'utf8');
const RULE = /\[data-look-buttons='raised'\] \.facet :is\(input\[type='text'\][^{]*\)\s*\{([^}]*)\}/;
const rule = RULE.exec(css)?.[1] ?? '';
const role = (property: string, pattern: RegExp) => {
  const found = new RegExp(`${property}:[^;]*?var\\(--([a-z-]+)\\)`).exec(rule)?.[1];
  assert.ok(found && pattern.test(property), `the facet box declares its ${property} as a token`);
  return found.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
};

test("a rail facet's box keeps a 3:1 edge on its fill and on the ground, in every look that dresses it so", () => {
  assert.ok(rule, 'lumenLook.css dresses the facet box');
  const edge = role('border', /border/),
    fill = role('background', /background/);
  const looks = THEME_PRESETS.filter((look) => look.recipes?.buttons === 'raised');
  assert.ok(looks.length, 'a built-in look wears raised buttons');
  const failures: string[] = [];
  for (const look of looks)
    for (const mode of ['light', 'dark'] as const) {
      const palette = look[mode] as unknown as Record<string, string>;
      for (const [under, color] of [
        [fill, palette[fill]!],
        ['surface', palette.surface!],
        ['ground', palette.ground!],
      ] as const) {
        const ratio = contrastRatio(palette[edge]!, color);
        if (ratio < 3) failures.push(`${look.id} ${mode}: ${edge} on ${under} is ${ratio.toFixed(2)}:1`);
      }
    }
  assert.deepEqual(failures, []);
});
