/**
 * A command form's field edge at rest (formDress.css, `--field-edge`, docs/design.md "A command form is quiet until
 * touched"): a clean outline at 3:1 on what the field stands on, in every built-in look, palette and mode. Where the
 * look's control edge reads quietly it is that edge, the one a record's inline edit draws; a heavier one (Mono's ink)
 * is lightened to about 3.5:1, never under 3.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveThemeDefinition, THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import { diagnosticColor, fieldEdge, measuredContrast } from '../packages/engine/src/shared/themeColor.js';

const contrast = (a: string, b: string) => measuredContrast(diagnosticColor(a)!, diagnosticColor(b)!)!;

test('every built-in look, palette and mode draws a form field edge at 3:1 on its surface and page, and none shouts', () => {
  for (const preset of THEME_PRESETS) {
    for (const palette of [{ id: 'default' }, ...(preset.palettes ?? [])]) {
      const definition = effectiveThemeDefinition(preset, palette.id);
      for (const mode of ['light', 'dark'] as const) {
        const colors = definition[mode];
        const edge = fieldEdge(colors) ?? colors.lineControl!;
        const where = `${preset.id}/${palette.id} ${mode}`;
        const ratios = [colors.surface, colors.ground ?? colors.surface].map((ground) => contrast(edge, ground));
        for (const ratio of ratios) assert.ok(ratio >= 3, `${where}: the field edge ${edge} is ${ratio.toFixed(2)}:1`);
        // Measured where it reads least: a page a shade darker than the panel may set it a little apart (Sage's night).
        assert.ok(
          Math.min(...ratios) <= 4.5,
          `${where}: the field edge ${edge} is ${Math.min(...ratios).toFixed(2)}:1, a line that shouts`,
        );
      }
    }
  }
});

test("Lumen's and Sage's form field is the inline edit's edge; Mono's is lightened from its ink to about 3.5:1", () => {
  const look = (id: string) =>
    effectiveThemeDefinition(
      THEME_PRESETS.find((preset) => preset.id === id)!,
      'default',
    );
  for (const id of ['lumen', 'sage'])
    for (const mode of ['light', 'dark'] as const) assert.equal(fieldEdge(look(id)[mode]), undefined, `${id} ${mode}`);
  for (const mode of ['light', 'dark'] as const) {
    const mono = look('mono')[mode];
    const edge = fieldEdge(mono);
    assert.ok(edge && edge !== mono.lineControl, `mono ${mode} keeps its ink edge`);
    const ratio = contrast(edge, mono.surface);
    assert.ok(ratio >= 3.5 && ratio < 3.8, `mono ${mode}: ${ratio.toFixed(2)}:1`);
  }
});

test("a theme's near-black control edge is lightened on its own page, and a color it cannot measure keeps the look's", () => {
  // A Mono-based theme with a green-black control edge on a warm white page (the solar demo's).
  const edge = fieldEdge({ lineControl: '#5a6966', surface: '#ffffff', ground: '#fbfaf6' })!;
  assert.ok(contrast(edge, '#fbfaf6') >= 3.5 && contrast(edge, '#ffffff') < 4);
  assert.equal(fieldEdge({ lineControl: 'oklch(50% 0.1 200)', surface: '#ffffff' }), undefined);
});
