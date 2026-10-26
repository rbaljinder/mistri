import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { appThemeWarnings, parseThemes, themeBandWarnings } from '../packages/engine/src/shared/theme.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkThemeWithFixes } from '../packages/mistri/src/shared/themeFix.js';
import { THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';
import { recipeAttributes } from '../packages/engine/src/shared/themeRecipes.js';
import { patternStrength } from '../packages/engine/src/shared/themePartsCheck.js';
import { partAttribute, partTokens, THEME_PARTS } from '../packages/engine/src/shared/themeParts.js';
import { PART_SELECTORS, partsSheet } from '../packages/mistri/src/server/app/themePartSelectors.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';

/**
 * TH-3a: what a theme says beyond the recipe menu, each held to the contract the way a recipe is. A band under every
 * other row (TC2), a pattern behind the page and the menu drawn in the theme's own line color (TC2), a part's own
 * colors by role, corner, lift, face and case (TC7), and the icons' weight (TC16). A theme that says none of them
 * sets no attribute and fetches no sheet, so every built-in look and every theme before them draws as it did.
 */
const theme = (extra: Record<string, unknown>, extendsLook = 'lumen') =>
  compileAppTheme({ kind: 'theme', id: 'probe', label: 'Probe', extends: extendsLook, ...extra }, 'theme');
/** What `check` prints of a theme: each failure as the validation step reads it for its code. */
const checked = (compiled: ReturnType<typeof theme>) => checkThemeWithFixes(compiled).map((problem) => problem.message);
const refuse = (extra: Record<string, unknown>, pattern: RegExp) => assert.throws(() => theme(extra), pattern);

test('the built-in looks say none of it: no band, pattern, part or icon weight, no attribute and no sheet', () => {
  for (const look of THEME_PRESETS) {
    const { attributes, sheets } = recipeAttributes(look);
    for (const name of ['data-parts', 'data-surface-ground', 'data-surface-nav', 'data-icons'])
      assert.equal(attributes[name], undefined, `${look.id} ${name}`);
    assert.ok(!sheets.includes('parts') && !sheets.includes('surfaces'), look.id);
    assert.equal(look.light.band, undefined);
  }
});

test('banded rows: the recipe, the band color, and the band measured as a ground', () => {
  const banded = theme({ recipes: { table: 'banded' }, colors: { light: { band: '#e6f2e0' } } });
  assert.equal(banded.recipes?.table, 'banded');
  assert.equal(banded.light.band, '#e6f2e0');
  assert.ok(recipeAttributes(banded).sheets.includes('brand'), 'the band is drawn by the brand sheet');
  refuse({ colors: { light: { band: 'green' } } }, /theme\.colors\.light\.band must be a six-digit hex color/);
  // A band dark enough to lose the ink is a contrast finding, named as the band.
  const dim = theme({ recipes: { table: 'banded' }, colors: { light: { band: '#5a5a5a' } } });
  const warnings = appThemeWarnings([dim]);
  const band = warnings.find((line) => /\(light\): ink\/band /.test(line));
  assert.ok(band, warnings.join('\n'));
  const line = checked(dim).find((message) => message.includes('ink/band'));
  assert.match(line!, /probe\.colors\.light\.band: /, 'the fix is the band, where it is written');
  assert.equal(validationCode(line!), 'theme-contrast');
});

test('patterns: six kinds at three strengths, behind the page and the menu, checked at their darkest', () => {
  const patterned = theme({ surface: { ground: { kind: 'grid', strength: 2 }, nav: { kind: 'scanlines' } } });
  assert.deepEqual(patterned.surface, { ground: { kind: 'grid', strength: 2 }, nav: { kind: 'scanlines', strength: 1 } });
  const { attributes, sheets } = recipeAttributes(patterned);
  assert.equal(attributes['data-surface-ground'], 'grid 2');
  assert.equal(attributes['data-surface-nav'], 'scanlines 1');
  assert.ok(sheets.includes('surfaces'));
  for (const kind of ['paper', 'grain', 'grid', 'dots', 'lines', 'scanlines']) theme({ surface: { ground: { kind } } });
  refuse(
    { surface: { ground: { kind: 'photo' } } },
    /theme\.surface\.ground\.kind must be one of paper, grain, grid, dots, lines, scanlines/,
  );
  refuse({ surface: { ground: { kind: 'grid', strength: 4 } } }, /theme\.surface\.ground\.strength must be 1, 2 or 3/);
  refuse({ surface: { panel: { kind: 'grid' } } }, /theme\.surface has no "panel"\. It takes: ground, nav/);
  refuse({ surface: { ground: { kind: 'grid', image: './x.png' } } }, /theme\.surface\.ground has no "image"/);
  // The line under the words at full strength: a faint caption on a dark rule is a finding that names the pattern.
  const heavy = theme({ surface: { ground: { kind: 'lines', strength: 3 } }, colors: { light: { line: '#9a9a9a' } } });
  const finding = appThemeWarnings([heavy]).find((line) => /on the page's lines pattern/.test(line));
  assert.ok(finding, appThemeWarnings([heavy]).join('\n'));
  const line = checked(heavy).find((message) => message.includes("on the page's lines pattern"));
  assert.match(line!, /probe\.colors\.light\.line: /);
  assert.equal(validationCode(line!), 'theme-contrast');
});

test("a pattern is drawn at the strength check measures it at; paper's low end is a fifth of the line", () => {
  // The last rule of surfacesLook.css that names a kind and a strength is the one worn: check reads the same number.
  const sheet = readFileSync(new URL('../packages/kit/src/client/surfacesLook.css', import.meta.url), 'utf8');
  const worn = (place: 'ground' | 'nav', kind: string, strength: 1 | 2 | 3) => {
    let found = 1;
    for (const rule of sheet.matchAll(/:root\[data-surface-(ground|nav)(?:(~?=)'([^']+)')?\][^{]*\{\s*--pattern:\s*([^;]+);/g)) {
      const [, at, op, value, pattern] = rule;
      if (at !== place) continue;
      const applies = !op || (op === '=' ? value === `${kind} ${strength}` : `${kind} ${strength}`.split(' ').includes(value!));
      if (applies) found = /(\d+)%/.test(pattern!) ? Number(/(\d+)%/.exec(pattern!)![1]) / 100 : 1;
    }
    return found;
  };
  for (const kind of ['paper', 'grain', 'grid', 'dots', 'lines', 'scanlines'] as const)
    for (const strength of [1, 2, 3] as const)
      for (const place of ['ground', 'nav'] as const)
        assert.equal(worn(place, kind, strength), patternStrength({ kind, strength }), `${place} ${kind} ${strength}`);
  assert.equal(patternStrength({ kind: 'paper', strength: 1 }), 0.2);
});

test('parts: published names, role colors only, the menus the rest of the theme speaks', () => {
  assert.equal(THEME_PARTS.length, 35);
  assert.deepEqual(Object.keys(PART_SELECTORS).sort(), [...THEME_PARTS].sort());
  const styled = theme({
    parts: {
      'button.secondary': { ground: 'nav.ground', ink: 'nav.ink', radius: 'pill' },
      stat: { edge: 'accent', lift: 'low' },
      'section.title': { face: 'heading', weight: 600, case: 'small-caps' },
      'board.card': { ground: 'chart[2]', ink: 'ink' },
    },
  });
  assert.equal(
    partAttribute(styled.parts),
    'section.title:face section.title:weight section.title:case stat:edge stat:lift button.secondary:ground button.secondary:ink button.secondary:radius board.card:ground board.card:ink',
  );
  assert.equal(recipeAttributes(styled).attributes['data-parts'], partAttribute(styled.parts));
  assert.ok(recipeAttributes(styled).sheets.includes('parts'));
  const tokens = partTokens(styled.parts);
  assert.equal(tokens['--part-button-secondary-ground'], 'var(--nav-ground)');
  assert.equal(tokens['--part-board-card-ground'], 'var(--chart-3)');
  assert.equal(tokens['--part-button-secondary-radius'], 'var(--pill-radius, 999px)');
  assert.equal(tokens['--part-section-title-caps'], 'all-small-caps');
  refuse({ parts: { sidebar: { ground: 'surface' } } }, /theme\.parts has no "sidebar"\. The parts are: ground, bar,/);
  refuse(
    { parts: { stat: { ground: '#ffffff' } } },
    /theme\.parts\.stat\.ground must be a color role by its path, like nav\.ground or chart\[2\], never a hex/,
  );
  refuse(
    { parts: { stat: { padding: '4px' } } },
    /theme\.parts\.stat has no "padding"\. It takes: ground, ink, edge, radius, lift, face, weight, case\. A part's size, spacing, order and visibility are the App's/,
  );
  refuse({ parts: { stat: { radius: 'round' } } }, /radius must be one of control, field, pill, panel, square/);
  refuse({ parts: { stat: { weight: 800 } } }, /weight must be one of 400, 500, 600, 700/);
  refuse({ parts: { stat: { ink: 'chart[8]' } } }, /must be a color role/);
});

test('a part whose words fail on its ground is a theme-part finding (C13 and C1), naming both roles', () => {
  const clash = theme({
    parts: { 'button.secondary': { ground: 'nav.ground', ink: 'ink' } },
    colors: { light: { nav: { ground: '#1f2937' } } },
  });
  const finding = appThemeWarnings([clash]).find((line) => line.includes('parts.button.secondary'));
  assert.ok(finding, appThemeWarnings([clash]).join('\n'));
  assert.match(finding!, /\(light\): parts\.button\.secondary: ink on nav\.ground contrast is [\d.]+:1; normal text needs 4\.5:1\./);
  const line = checked(clash).find((message) => message.includes('parts.button.secondary'));
  assert.equal(validationCode(line!), 'theme-part', line);
  assert.equal(promiseOf('theme-part'), 'C13');
});

test('the icons take a Phosphor weight, never thin or duotone', () => {
  assert.equal(theme({ type: { icons: 'light' } }).icons, 'light');
  assert.equal(recipeAttributes(theme({ type: { icons: 'fill' } })).attributes['data-icons'], 'fill');
  refuse({ type: { icons: 'thin' } }, /theme\.type\.icons must be one of regular, light, bold, fill: thin draws a 1px stroke/);
  refuse({ type: { icons: 'duotone' } }, /theme\.type\.icons must be one of regular, light, bold, fill/);
});

test('a compiled theme keeps its parts, surface and icons through the branding reader', () => {
  const compiled = theme({
    surface: { ground: { kind: 'dots' } },
    parts: { stat: { edge: 'accent' } },
    type: { icons: 'bold' },
    recipes: { table: 'banded' },
  });
  const [read] = parseThemes([JSON.parse(JSON.stringify(compiled))], 'ui')!;
  assert.deepEqual(read!.surface, compiled.surface);
  assert.deepEqual(read!.parts, compiled.parts);
  assert.equal(read!.icons, 'bold');
  assert.throws(
    () => parseThemes([{ ...JSON.parse(JSON.stringify(compiled)), parts: { stat: { ground: '#fff' } } }], 'ui'),
    /ui\.themes\[0\]\.parts\.stat\.ground must be a color role/,
  );
});

test('partsLook.css is what the selectors generate', () => {
  assert.equal(
    readFileSync(new URL('../packages/kit/src/client/partsLook.css', import.meta.url), 'utf8'),
    partsSheet(),
    'run node --import tsx scripts/theme-parts-css.mjs',
  );
});

test('banded tables: an opaque status or tag ground is said, a translucent one and the default are not (theme-band, C13)', () => {
  const banded = (parts: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    theme({ recipes: { table: 'banded' }, colors: { light: { band: '#e6f2e0' } }, parts, ...extra });
  const warnings = themeBandWarnings([banded({ status: { ground: 'surface' }, tag: { ground: 'raised' } })]);
  assert.equal(warnings.length, 2, warnings.join('\n'));
  assert.match(warnings[0]!, /parts\.status\.ground surface is opaque \(light, dark\) on a banded table/);
  assert.equal(validationCode(warnings[0]!), 'theme-band');
  assert.equal(promiseOf('theme-band'), 'C13');
  // The default ground, and any part but the two chips, are the look's: nothing to say.
  assert.deepEqual(themeBandWarnings([banded({ status: { edge: 'line' }, stat: { ground: 'surface' } })]), []);
  // The same opaque ground on a table that is not banded lies on no band.
  assert.deepEqual(themeBandWarnings([theme({ parts: { status: { ground: 'surface' } } })]), []);
  // A translucent ground lets the band through (a compiled theme read back may hold one; a spec's hex is opaque).
  const veiled = structuredClone(banded({ status: { ground: 'accentSoft' } }));
  veiled.light.accentSoft = '#0a6b3d22';
  veiled.dark.accentSoft = '#0a6b3d22';
  assert.deepEqual(themeBandWarnings([veiled]), []);
});

test('the band stripes a list or grid (.table-wrap) and never the calendar, which is a table of weeks', () => {
  const css = readFileSync(new URL('../packages/kit/src/client/brandLook.css', import.meta.url), 'utf8');
  const rules = css.match(/[^{}]*data-look-table='banded'[^{}]*\{/g) ?? [];
  assert.ok(rules.length >= 2);
  for (const rule of rules) assert.match(rule, /\.table-wrap tbody tr/, rule);
  const calendar = readFileSync(new URL('../packages/mistri/src/client/components/CalendarList.tsx', import.meta.url), 'utf8');
  assert.ok(!/table-wrap/.test(calendar), 'the calendar must not draw itself in a .table-wrap');
  const grid = readFileSync(new URL('../packages/kit/src/client/components/Grid.tsx', import.meta.url), 'utf8');
  assert.match(grid, /className=\{`table-wrap/);
});

test('a full-screen dialog has no edge for dialog:edge to draw: the structure layer, which outranks the theme layer, zeroes it (a dark phone showed a light 1px line)', () => {
  const css = readFileSync(new URL('../packages/kit/src/client/structure.css', import.meta.url), 'utf8');
  assert.match(css, /\[role='dialog'\]\.modal-fullscreen \{[^}]*border: 0/);
  assert.match(css, /\.modal-fullscreen-mobile \{[^}]*border: 0/);
  assert.match(css, /^@layer structure/m);
});
