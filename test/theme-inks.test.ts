/**
 * The accent is a fill, and the two inks it needs are not the accent: the words on it (`onAccent`) and the accent
 * drawn as text (`accentInk`). A bright brand orange is a good fill with near-black words and a poor text on white;
 * a theme names neither and the one that passes is taken.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ThemeSpec } from '../packages/engine/schema/theme.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { checkThemeWithFixes } from '../packages/mistri/src/shared/themeFix.js';
import { contrastRatio } from '../packages/engine/src/shared/theme.js';
import { effectiveThemeDefinition, effectiveThemePalette } from '../packages/engine/src/shared/themePresets.js';
import { inPackages } from './support/packages.js';

const ORANGE = '#ff8534';
const spec = (light: Record<string, unknown> = {}, dark: Record<string, unknown> = {}): ThemeSpec =>
  ({
    id: 'brand',
    label: 'Brand',
    colors: {
      light: { ground: '#f6f5f2', surface: '#ffffff', ink: '#16120e', accent: ORANGE, ...light },
      dark: { ground: '#111111', surface: '#1a1a1a', ink: '#f2f2f2', accent: ORANGE, ...dark },
    },
  }) as ThemeSpec;
const compile = (raw: ThemeSpec) => compileAppTheme(raw, 'ui.customThemes[0]', new Set(), { faces: false });
const worn = (raw: ThemeSpec, mode: 'light' | 'dark') => {
  const theme = compile(raw);
  return effectiveThemePalette(effectiveThemeDefinition(theme)[mode], mode === 'dark');
};

describe('a bright accent is a fill, with its own inks', () => {
  test('an orange with near-black ink is no failure: the words on it and its text are derived to read', () => {
    const light = worn(spec(), 'light');
    assert.equal(light.accent, ORANGE);
    assert.ok(contrastRatio(light.onAccent!, ORANGE) >= 4.5, `words on the fill: ${light.onAccent}`);
    for (const ground of ['#ffffff', '#f6f5f2'])
      assert.ok(contrastRatio(light.accentInk!, ground) >= 4.5, `the accent as text on ${ground}: ${light.accentInk}`);
    assert.equal(light.link, light.accentInk, 'a link the theme left to its accent follows the accent as text');
    assert.deepEqual(checkTheme(compile(spec())), []);
  });

  test('a theme whose accent already reads wears neither: its tokens are as they were', () => {
    const blue = worn(spec({ accent: '#1d4ed8' }), 'light');
    assert.equal(blue.onAccent, undefined);
    assert.equal(blue.accentInk, undefined);
    assert.equal(blue.link, '#1d4ed8');
  });

  test('a theme may name them, and they are held to the fill and the page they are drawn on', () => {
    const named = worn(spec({ onAccent: '#000000', accentInk: '#a33c00' }), 'light');
    assert.equal(named.onAccent, '#000000');
    assert.equal(named.accentInk, '#a33c00');
    assert.throws(() => compile(spec({ onAccent: 'black' })), /onAccent must be a six-digit hex color/);

    const problems = checkTheme(compile(spec({ onAccent: '#ffffff', accentInk: ORANGE }))).filter((problem) => problem.mode === 'light');
    const said = (token: string) => problems.filter((problem) => problem.token === token).map((problem) => problem.check);
    assert.deepEqual(said('onAccent'), ['onAccent on accent (the words on an accent fill)']);
    assert.equal(said('accentInk').length, 5, 'on the panel, the page and a raised panel, and on its own tint over the first two');
    assert.match(problems.find((problem) => problem.token === 'onAccent')!.message, /is 2\.\d\d:1; it needs 4\.5:1/);
  });

  test("the fix for a text accent that fails is the accent's ink, not a refusal of the accent", () => {
    const theme = compile(spec({ accentInk: ORANGE }));
    const fixes = checkThemeWithFixes(theme).filter((problem) => problem.role === 'accentInk');
    assert.ok(fixes.length > 0);
    for (const problem of fixes) {
      assert.equal(problem.at, 'colors.light.accentInk');
      assert.ok(problem.fix, problem.message);
      assert.match(problem.message, /Try accentInk: '#[0-9a-f]{6}'/);
    }
  });

  test("an App's own accent is worn with inks chosen for it, not the theme's", () => {
    const theme = compile(spec({ onAccent: '#ffffff', accentInk: '#ffffff' }));
    const palette = effectiveThemePalette(effectiveThemeDefinition(theme).light, false, { accent: ORANGE });
    assert.notEqual(palette.onAccent, '#ffffff');
    assert.ok(contrastRatio(palette.accentInk!, '#ffffff') >= 4.5);
  });
});

describe('the sheets draw each ink in its own token', () => {
  const sheets = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? sheets(join(dir, entry.name)) : entry.name.endsWith('.css') ? [join(dir, entry.name)] : [],
    );
  const css = [...inPackages('src/client'), 'packages/ui/src'].flatMap(sheets).map((file) => [file, readFileSync(file, 'utf8')] as const);

  test('words on an accent fill are --on-accent, never the page color, and the accent as text is --accent-ink', () => {
    for (const [file, text] of css)
      for (const [block] of text.matchAll(/\{[^{}]*\}/g)) {
        if (/background(-color)?:\s*var\(--accent\)(?!-)/.test(block))
          assert.doesNotMatch(block, /(?<![-\w])color:\s*var\(--(ground|surface)\)/, `${file}: ${block.replace(/\s+/g, ' ')}`);
        assert.doesNotMatch(block, /(?<![-\w])color:\s*var\(--accent\)(?![-\w])/, `${file}: ${block.replace(/\s+/g, ' ')}`);
      }
  });

  test('the root says both unsaid: the page color on the accent, the accent itself as text', () => {
    const style = readFileSync('packages/ui/src/tokens.css', 'utf8');
    assert.match(style, /--on-accent: var\(--ground\);/);
    assert.match(style, /--accent-ink: var\(--accent\);/);
  });
});
