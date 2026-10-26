/**
 * A dark-by-default App: a theme says `scheme: 'dark'` (worn dark until the reader picks a mode) or `'dark-only'`
 * (one set of colors, judged as dark). Before, the only way to a dark App was dark colors in the light slot, which
 * the printed-paper check refused as a light palette whose accent vanishes on white paper.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeSpec } from '../packages/engine/schema/theme.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { themeModes } from '../packages/engine/src/shared/themePresets.js';
import { parseThemes } from '../packages/engine/src/shared/theme.js';

const NIGHT = { ground: '#101114', surface: '#17181c', ink: '#f2f2f2', accent: '#8fb4ff' };
const LIGHT = { ground: '#f6f5f2', surface: '#ffffff', ink: '#16120e', accent: '#1d4ed8' };
const compile = (raw: unknown) => compileAppTheme(raw, 'ui.customThemes[0]', new Set(), { faces: false });
const spec = (more: Record<string, unknown>) => ({ id: 'night', label: 'Night', ...more }) as unknown as ThemeSpec;

describe('a theme that is dark', () => {
  test('dark only: one set of colors, judged as dark and never as paper', () => {
    const theme = compile(spec({ scheme: 'dark-only', colors: { dark: NIGHT } }));
    assert.equal(theme.scheme, 'dark-only');
    assert.deepEqual(theme.light, theme.dark, 'the light slot is the dark colors');
    assert.deepEqual(themeModes(theme), ['dark']);
    assert.deepEqual(checkTheme(theme), []);
    /* The same colors as a light mode are what the paper check refuses: a dark "light" palette. */
    const dressed = checkTheme(compile(spec({ colors: { light: NIGHT, dark: NIGHT } })));
    assert.ok(
      dressed.some((problem) => problem.check === 'accentInk on printed paper'),
      JSON.stringify(dressed.map((p) => p.check)),
    );
  });

  test("dark only names no light: colors.light and a palette's light are refused", () => {
    assert.throws(
      () => compile(spec({ scheme: 'dark-only', colors: { light: LIGHT, dark: NIGHT } })),
      /dark-only theme has no light colors/,
    );
    assert.throws(
      () =>
        compile(
          spec({ scheme: 'dark-only', colors: { dark: NIGHT }, palettes: [{ id: 'dusk', label: 'Dusk', light: { accent: '#ffffff' } }] }),
        ),
      /palettes\[0\]\.light: a dark-only theme has no light colors/,
    );
    const dusk = compile(
      spec({ scheme: 'dark-only', colors: { dark: NIGHT }, palettes: [{ id: 'dusk', label: 'Dusk', dark: { accent: '#ffd479' } }] }),
    );
    assert.equal(dusk.palettes![0]!.light.accent, '#ffd479', "a palette's dark colors are worn in the light slot too");
  });

  test('dark by default keeps a light mode, which is still held to paper', () => {
    const theme = compile(spec({ scheme: 'dark', colors: { light: LIGHT, dark: NIGHT } }));
    assert.equal(theme.scheme, 'dark');
    assert.deepEqual(themeModes(theme), ['light', 'dark']);
    assert.deepEqual(checkTheme(theme), []);
    const night = compile(spec({ scheme: 'dark', colors: { light: NIGHT, dark: NIGHT } }));
    assert.ok(checkTheme(night).some((problem) => problem.check === 'accentInk on printed paper'));
  });

  test('a scheme is dark or dark-only; a theme that extends a look may say it too', () => {
    assert.throws(() => compile(spec({ scheme: 'light', colors: { light: LIGHT, dark: NIGHT } })), /scheme must be "dark" or "dark-only"/);
    const over = compile(spec({ extends: 'mono', scheme: 'dark-only', colors: { dark: { accent: '#8fb4ff' } } }));
    assert.deepEqual(over.light, over.dark);
    assert.equal(over.scheme, 'dark-only');
  });
});

describe('a tenant or host theme (parseThemes) says its scheme as an App theme does', () => {
  const stored = (more: Record<string, unknown>) => ({
    id: 'night',
    label: 'Night',
    base: 'mono',
    light: NIGHT,
    dark: NIGHT,
    ...more,
  });

  test('dark and dark-only are kept; anything else is refused with the App theme words', () => {
    assert.equal(parseThemes([stored({ scheme: 'dark' })], 'host')![0]!.scheme, 'dark');
    assert.equal(parseThemes([stored({ scheme: 'dark-only' })], 'host')![0]!.scheme, 'dark-only');
    assert.equal(parseThemes([stored({})], 'host')![0]!.scheme, undefined);
    assert.throws(() => parseThemes([stored({ scheme: 'light' })], 'host'), /scheme must be "dark" or "dark-only"/);
  });

  test('dark-only wears its dark in both slots and refuses a light of its own', () => {
    const { light, ...bare } = stored({ scheme: 'dark-only' });
    assert.deepEqual(parseThemes([bare], 'host')![0]!.light, parseThemes([bare], 'host')![0]!.dark);
    assert.ok(light);
    assert.throws(
      () => parseThemes([stored({ scheme: 'dark-only', light: { ...NIGHT, accent: '#1d4ed8' } })], 'host'),
      /dark-only theme has no light colors/,
    );
  });
});
