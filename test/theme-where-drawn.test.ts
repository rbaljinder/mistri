/**
 * TC13: a theme's colours are measured where they are drawn, not only on the
 * panel they were picked on. A theme check passed and its pages then failed:
 * a control's edge that read 3:1 on the panel and the page stood at 2.94:1 on
 * a table's head (the raised ground), and the pill menu's current entry wore
 * the menu's accent on the page's tint. Each failure names the colour where
 * the theme writes it (`cadence.colors.light.lineControl`), the ratio, the
 * ground it was drawn on, and a value that passes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkThemeWithFixes } from '../packages/mistri/src/shared/themeFix.js';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import { checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { recipeAttributes } from '../packages/engine/src/shared/themeRecipes.js';

/* Lilac-grey, white cards, one dusty plum: its control edge clears the white card and the page, not the raised head. */
const cadence = (light: Record<string, unknown> = {}) =>
  compileAppTheme(
    {
      kind: 'theme',
      id: 'cadence',
      label: 'Cadence',
      extends: 'lumen',
      colors: {
        light: { ground: '#ffffff', surface: '#ffffff', raised: '#ece9f1', lineControl: '#928c99', accent: '#7a4471', ...light },
      },
    },
    'cadence',
  );

test('a control edge that passes on the panel and the page is refused on the raised head it is drawn on, with its path and a passing value', () => {
  const problems = checkThemeWithFixes(cadence());
  const edge = problems.find((problem) => problem.role === 'lineControl');
  assert.ok(edge, problems.map((problem) => problem.message).join('\n'));
  assert.equal(edge.at, 'colors.light.lineControl');
  assert.match(edge.message, /^Theme "Cadence" \(light\), cadence\.colors\.light\.lineControl: /);
  // The ground it was drawn on, said by name and by what stands there, and the measure.
  assert.match(edge.message, /lineControl on raised \(a control's edge on a raised panel or a table's head\) is 2\.\d\d:1; it needs 3:1/);
  assert.match(edge.message, /\(lineControl is #928c99\)\. Try lineControl: '#[0-9a-f]{6}' \(3\.\d\d:1\)\.$/);
  // The value check --fix would write passes where the old one failed, and everywhere else it is drawn.
  const fixed = cadence({ lineControl: edge.fix!.value });
  assert.deepEqual(
    checkTheme(fixed).filter((problem) => problem.role === 'lineControl'),
    [],
  );
});

test('every ink is measured on the page too, and the meaning colours on a raised row', () => {
  const page = compileAppTheme(
    {
      kind: 'theme',
      id: 'quiet',
      label: 'Quiet',
      extends: 'lumen',
      colors: { light: { ground: '#e9e6e1', inkSubtle: '#7a756e', status: { good: '#1a8a46' } } },
    },
    'quiet',
  );
  const checks = checkTheme(page).map((problem) => problem.check);
  assert.ok(checks.includes('inkSubtle on ground (a faint caption on the page)'), checks.join('\n'));
  assert.ok(
    checks.some((check) => check.startsWith('statusGood on raised')),
    checks.join('\n'),
  );
});

test("the pill menu's current entry is measured on the tint it is drawn on, over the menu's ground", () => {
  const menu = compileAppTheme(
    {
      kind: 'theme',
      id: 'console',
      label: 'Console',
      extends: 'lumen',
      recipes: { nav: 'pill' },
      colors: { light: { nav: { ground: '#1d2226', ink: '#e6edf0', muted: '#a9b4ba', line: '#2b3236', accent: '#5fd4c4' } } },
    },
    'console',
  );
  const current = checkThemeWithFixes(menu).find((problem) => problem.check.startsWith('navAccent/accentSoft over navGround'));
  assert.ok(current, 'the menu accent on the pale page tint laid over a dark menu is refused');
  assert.match(current.message, /console\.colors\.light\.nav\.accent: /);
  assert.ok(current.ratio < 4.5);
});

test('the built-in looks pass the measures where drawn, in every palette and both modes', () => {
  for (const look of THEME_PRESETS) {
    const contrast = checkTheme(look).filter((problem) => !problem.check.includes(' beside '));
    assert.deepEqual(
      contrast.map((problem) => problem.message),
      [],
      look.id,
    );
  }
});

/* A theme's own series are held apart (8 for a red-green reader, 10 to normal vision) and a series a
   theme keeps from its look is not: so a look's series are measured here as if a theme had written
   them, which is how Sage's were found side by side at 2.2 apart for protanopia. */
test("each built-in look's chart series stand apart beside each other, light and dark", () => {
  for (const look of THEME_PRESETS) {
    const chart = (mode: 'light' | 'dark') => [1, 2, 3, 4, 5, 6, 7, 8].map((n) => look[mode][`chart${n}` as 'chart1']!);
    const authored = compileAppTheme(
      {
        kind: 'theme',
        id: 'series',
        label: look.label,
        extends: look.id,
        colors: { light: { chart: chart('light') }, dark: { chart: chart('dark') } },
      },
      'series',
    );
    assert.deepEqual(
      checkTheme(authored).map((problem) => problem.message),
      [],
      look.id,
    );
  }
});

/* The theme docs/theming.md shows a reader passes the check it describes: Harbor's dark mode kept Lumen's first series,
   a blue drawn at 2.78:1 on Harbor's own dark panel. */
test('the theme docs/theming.md shows passes mistri check', () => {
  const doc = readFileSync(new URL('../docs/theming.md', import.meta.url), 'utf8');
  const source = /export const harbor = defineTheme\((\{[\s\S]*?\n\})\);/.exec(doc)?.[1];
  assert.ok(source, 'docs/theming.md defines Harbor');
  const harbor = compileAppTheme({ kind: 'theme', ...(new Function(`return (${source});`)() as object) } as never, 'harbor');
  assert.deepEqual(
    checkTheme(harbor).map((problem) => problem.message),
    [],
  );
});

test("the logo's picture is chosen by the bar it is drawn on: a dark bar by day wears the night picture", () => {
  const inverted = cadence({ nav: { ground: '#1f1a24', ink: '#f4f1f7', muted: '#c9c1d6', accent: '#e9c6e2' } });
  assert.equal(recipeAttributes(inverted).attributes['data-bar-ground'], 'light:dark');
  // A soft bar is drawn on the page's surface, whatever the menu's ground.
  const soft = compileAppTheme(
    { kind: 'theme', id: 'soft', label: 'Soft', extends: 'sage', colors: { light: { nav: { ground: '#1f1a24', ink: '#f4f1f7' } } } },
    'soft',
  );
  assert.equal(recipeAttributes(soft).attributes['data-bar-ground'], undefined);
  // Every built-in's bar is its mode's but Ledger's, which is the book's dark cover by day: no word, and the reader's
  // mode picks the picture as before.
  for (const look of THEME_PRESETS)
    assert.equal(recipeAttributes(look).attributes['data-bar-ground'], look.id === 'ledger' ? 'light:dark' : undefined, look.id);
  const css = readFileSync(new URL('../packages/mistri/src/client/appBrand.css', import.meta.url), 'utf8');
  assert.match(
    css,
    /\[data-bar-ground~='light:dark'\] \.brand-mark\.brand-mark--image \.brand-image\.brand-image--dark \{ display: block; \}/,
  );
});
