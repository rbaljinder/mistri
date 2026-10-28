import { test } from 'node:test';
import assert from 'node:assert/strict';
import { THEME_PRESETS, effectiveThemePalette, themePreset } from '../packages/engine/src/shared/themePresets.js';
import { LOOKS } from '../packages/engine/src/shared/themeLooks.js';
import { PRESETS_FILE, changes, render } from '../scripts/theme-presets.mjs';
import { readFileSync } from 'node:fs';
import { authoredRoles, checkTheme } from '../packages/mistri/src/shared/themeCheck.js';
import { DEFAULT_RECIPES, recipeAttributes } from '../packages/engine/src/shared/themeRecipes.js';
import { compileAppTheme, compileTheme, rolesToColors, themeExtends } from '../packages/mistri/src/shared/themeSpec.js';
import { contrastRatio, parseThemes, themeShadowWarnings, themeShapeWarnings } from '../packages/engine/src/shared/theme.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';

/** What each built-in look wears, from its spec in themeLooks.ts: only the parts it differs from the plain structure in. */
const WORN: Record<string, Record<string, string>> = {
  workshop: {
    nav: 'slot',
    bar: 'ruled',
    tabs: 'rule',
    windows: 'segmented',
    stat: 'ruled',
    section: 'open',
    fields: 'open',
    status: 'dot',
    board: 'ruled',
    chart: 'plain',
    buttons: 'keyed',
    rules: 'ink',
    workflow: 'markers',
    banner: 'plain',
    steps: 'strip',
    lanes: 'tag',
  },
  lumen: {
    nav: 'pill',
    bar: 'airy',
    tabs: 'underline',
    windows: 'lifted',
    stat: 'divided',
    section: 'open',
    fields: 'rail',
    table: 'quiet',
    status: 'quiet',
    board: 'strip',
    chart: 'line',
    buttons: 'raised',
    rules: 'hairline',
    avatar: 'round',
    workflow: 'markers',
    banner: 'plain',
    steps: 'strip',
  },
  mono: { nav: 'inverted', bar: 'ruled', tabs: 'inverted', stat: 'framed', links: 'underline' },
  sage: {
    nav: 'quiet',
    bar: 'soft',
    tabs: 'chosen',
    windows: 'chosen',
    stat: 'panel',
    section: 'panel',
    fields: 'panel',
    table: 'hairline',
    status: 'pill',
    board: 'soft',
    chart: 'wash',
    rules: 'hairline',
    avatar: 'large',
    header: 'band',
  },
};
const SHAPE: Record<string, { elevation: string; title?: string }> = {
  workshop: { elevation: 'flat', title: '30px' },
  lumen: { elevation: 'raised', title: '28px' },
  mono: { elevation: 'flat', title: '30px' },
  sage: { elevation: 'soft' },
};

const spec = (extra: Record<string, unknown> = {}) => ({
  kind: 'theme',
  id: 'probe',
  label: 'Probe',
  colors: {
    light: { ground: '#fafafa', surface: '#ffffff', ink: '#1a1a1a', accent: '#1d4ed8' },
    dark: { ground: '#101010', surface: '#171717', ink: '#f2f2f2', accent: '#93c5fd' },
  },
  ...extra,
});

test('every built-in compiles from its spec with the recipes it wears', () => {
  assert.deepEqual(
    THEME_PRESETS.map((preset) => preset.id),
    Object.keys(WORN),
  );
  for (const preset of THEME_PRESETS) {
    assert.deepEqual(preset.recipes, { ...DEFAULT_RECIPES, ...WORN[preset.id] }, `${preset.id} recipes`);
    assert.equal(preset.elevation, SHAPE[preset.id]!.elevation, `${preset.id} elevation`);
    assert.equal(preset.type?.roles?.title?.size, SHAPE[preset.id]!.title, `${preset.id} title size`);
  }
  assert.equal(themePreset('sage')!.type?.roles?.title?.weight, 600);
  assert.deepEqual(themePreset('mono')!.type?.roles?.label, { face: 'code', case: 'upper' });
  assert.equal(themePreset('lumen')!.light.rulesWeight, '1px');
  assert.equal(themePreset('lumen')!.light.rulesSection, themePreset('lumen')!.light.line);
});

// The built-ins are built ahead of time and unchecked, so the browser carries neither builder nor validator
// at first paint; these are the checks.
test('the built-in looks the browser wears are what their specs build to', async () => {
  assert.equal(
    readFileSync(PRESETS_FILE, 'utf8'),
    await render(),
    `${PRESETS_FILE} is stale: run node --import tsx scripts/theme-presets.mjs`,
  );
});

// The built file writes a palette as what it changes from the look's own colors; the checked build says each whole.
test('every built-in passes the checks an App theme does, and checked is what the browser wears', () => {
  for (const look of LOOKS) {
    const checked = compileTheme(look, look.id, () => undefined);
    const packed = {
      ...checked,
      base: look.id,
      ...(checked.palettes
        ? {
            palettes: checked.palettes.map((variant) => ({
              ...variant,
              light: changes(variant.light, checked.light),
              dark: changes(variant.dark, checked.dark),
            })),
          }
        : {}),
    };
    assert.deepEqual(JSON.parse(JSON.stringify(packed)), themePreset(look.id), `${look.id} built unchecked differs from checked`);
  }
});

test("a compiled palette written back in the spec's words and compiled again is the same palette", () => {
  for (const preset of THEME_PRESETS)
    for (const mode of ['light', 'dark'] as const) {
      const again = compileAppTheme(
        {
          kind: 'theme',
          id: 'again',
          label: 'Again',
          colors: {
            [mode]: rolesToColors(preset[mode]),
            [mode === 'light' ? 'dark' : 'light']: rolesToColors(preset[mode === 'light' ? 'dark' : 'light']),
          },
          // The widths are shape, said once for both modes.
          shape: {
            border: {
              ...(preset[mode].rulesWeight ? { rule: preset[mode].rulesWeight } : {}),
              ...(preset[mode].rulesControl ? { control: preset[mode].rulesControl } : {}),
            },
          },
        },
        'again',
      );
      assert.deepEqual(again[mode], preset[mode], `${preset.id} ${mode}`);
    }
});

test('a theme the compiler refuses says where, and what the choices are', () => {
  const refuse = (raw: unknown, pattern: RegExp) => assert.throws(() => compileAppTheme(raw, 'ui.theme'), pattern);
  refuse(spec({ recipes: { sidebar: 'pill' } }), /ui\.theme\.recipes has no part "sidebar"\. The parts are: nav, bar/);
  refuse(
    spec({ recipes: { nav: 'sparkly' } }),
    /ui\.theme\.recipes\.nav is not on the menu: pick one of tint, inverted, wash, underline, pill, quiet/,
  );
  refuse(
    spec({ colors: { light: { ...spec().colors.light, status: { critical: 'red' } }, dark: spec().colors.dark } }),
    /ui\.theme\.colors\.light\.status\.critical must be a six-digit hex color/,
  );
  refuse(spec({ id: 'lumen' }), /ui\.theme\.id/);
  refuse(spec({ id: 'default' }), /ui\.theme\.id/);
  refuse(
    spec({ colors: { light: { ground: '#fafafa', surface: '#ffffff', accent: '#1d4ed8' }, dark: spec().colors.dark } }),
    /colors\.light\.ink is required/,
  );
  refuse(spec({ extends: 'nope' }), /ui\.theme\.extends must name a built-in look/);
  refuse(spec({ shape: { elevation: 'sky' } }), /shape\.elevation must be one of/);
  refuse(spec({ kind: 'preset' }), /kind must be "theme"/);
  refuse(spec({ palette: spec().colors }), /ui\.theme\.palette is now colors: \{ light, dark \}/);
});

test('a theme that extends a built-in changes only what it says, and derives what follows from it', () => {
  const lumen = themePreset('lumen')!;
  const worn = compileAppTheme(
    { kind: 'theme', id: 'plum', label: 'Plum', extends: 'lumen', colors: { light: { accent: '#7a1fa2' } } },
    'plum',
  );
  assert.equal(worn.light.accent, '#7a1fa2');
  assert.notEqual(worn.light.accentSoft, lumen.light.accentSoft);
  assert.match(worn.light.accentSoft!, /^#[0-9a-f]{6}$/);
  for (const role of ['ground', 'surface', 'raised', 'ink', 'line', 'navGround'] as const)
    assert.equal(worn.light[role], lumen.light[role], role);
  assert.deepEqual(worn.dark, lumen.dark);
  assert.deepEqual(worn.recipes, lumen.recipes);
  assert.equal(worn.base, 'lumen');
  assert.equal(themeExtends(worn), lumen);
});

test("a form's primary action is the look's choice, follows the theme's own ink or accent, and is the author's to name", () => {
  const lumen = themePreset('lumen')!;
  // Lumen's is its ink; Mono's and Sage's leave it to their accent.
  for (const mode of ['light', 'dark'] as const) assert.equal(lumen[mode].primary, lumen[mode].ink, mode);
  for (const id of ['mono', 'sage']) assert.equal(themePreset(id)!.light.primary, undefined, id);
  // An accent of the theme's own leaves Lumen's ink in place; an ink of its own is taken along, its words chosen again.
  const plum = compileAppTheme(
    { kind: 'theme', id: 'plum', label: 'Plum', extends: 'lumen', colors: { light: { accent: '#7a1fa2' } } },
    'plum',
  );
  assert.equal(plum.light.primary, lumen.light.ink);
  const slate = compileAppTheme(
    { kind: 'theme', id: 'slate', label: 'Slate', extends: 'lumen', colors: { light: { ink: '#1f2a44' } } },
    'slate',
  );
  assert.equal(slate.light.primary, '#1f2a44');
  assert.equal(slate.light.onPrimary, undefined);
  // Named, it is the theme's: here its accent, with the words on it derived to read at 4.5:1.
  const brand = compileAppTheme(
    {
      kind: 'theme',
      id: 'brand',
      label: 'Brand',
      extends: 'lumen',
      colors: { light: { primary: '#2d4fd6' }, dark: { primary: '#8aa1ff' } },
    },
    'brand',
  );
  assert.equal(brand.light.primary, '#2d4fd6');
  for (const mode of ['light', 'dark'] as const) {
    const worn = effectiveThemePalette(brand[mode], mode === 'dark');
    assert.ok(contrastRatio(worn.onPrimary!, worn.primary!) >= 4.5, `${mode}: ${worn.onPrimary} on ${worn.primary}`);
  }
  assert.throws(
    () =>
      compileAppTheme(
        { kind: 'theme', id: 'half', label: 'Half', extends: 'lumen', colors: { light: { onPrimary: '#ffffff' } } },
        'ui.theme',
      ),
    /ui\.theme\.colors\.light\.onPrimary is the words on ui\.theme\.colors\.light\.primary: name primary beside it\./,
  );
});

test('a theme that extends nothing derives every role from the four it names', () => {
  const theme = compileAppTheme(spec(), 'probe');
  assert.equal(themeExtends(theme), null);
  for (const mode of ['light', 'dark'] as const)
    for (const role of [
      'ground',
      'surface',
      'raised',
      'line',
      'lineStrong',
      'lineControl',
      'ink',
      'inkMuted',
      'inkSubtle',
      'accent',
      'accentSoft',
      'link',
      'focus',
      'statusGood',
      'statusWarning',
      'statusCritical',
      'statusInfo',
      'navGround',
      'navInk',
      'navMuted',
      'navLine',
      'navAccent',
      'chart1',
      'chart2',
      'chart3',
      'chart4',
      'chart5',
      'chart6',
      'chart7',
      'chart8',
    ] as const)
      assert.match(theme[mode][role] as string, /^#[0-9a-f]{6}$/, `${mode} ${role}`);
  assert.deepEqual(theme.recipes, DEFAULT_RECIPES);
  assert.equal(theme.light.chart1, '#1d4ed8');
});

test('contrast: a yellow accent drawn as text on white is named by its spec path', () => {
  const colors = (light: Record<string, unknown>) => ({
    light: { ...spec().colors.light, accent: '#ffcc00', ...light },
    dark: spec().colors.dark,
  });
  /* A yellow fill is fine: the text it is drawn as, and the words on it, are derived to read. */
  assert.equal(
    checkTheme(compileAppTheme(spec({ colors: colors({}) }), 'probe')).find(
      (problem) => problem.mode === 'light' && /accent|link/.test(problem.token),
    ),
    undefined,
  );
  const theme = compileAppTheme(spec({ colors: colors({ accentInk: '#ffcc00' }) }), 'probe');
  const problems = checkTheme(theme);
  const accent = problems.find((problem) => problem.token === 'accentInk' && problem.mode === 'light');
  assert.ok(accent, problems.map((problem) => problem.message).join('\n'));
  assert.match(accent.message, /accentInk/);
  assert.equal(accent.themeId, 'probe');
});

test('chart: adjacent series that a colour-blind reader cannot tell apart are named', () => {
  const light = { ...spec().colors.light, chart: [null, '#c2410c', '#3d5fa8', '#8a4c9e'] };
  const theme = compileAppTheme(spec({ extends: 'lumen', colors: { light, dark: spec().colors.dark } }), 'probe');
  const problems = checkTheme(theme, { authored: authoredRoles(theme, themeExtends(theme) ?? undefined) });
  const found = problems.filter((problem) => problem.token.startsWith('chart['));
  assert.ok(
    found.some((problem) => problem.token === 'chart[3]' && /protanopia/.test(problem.reason)),
    problems.map((p) => p.message).join('\n'),
  );
});

test("a built-in's own chart is not held against a theme that leaves it", () => {
  for (const preset of THEME_PRESETS) {
    const theme = compileAppTheme(
      { kind: 'theme', id: `on-${preset.id}`, label: 'On', extends: preset.id, colors: { light: { accent: '#7a1fa2' } } },
      'x',
    );
    const problems = checkTheme(theme, { authored: authoredRoles(theme, themeExtends(theme) ?? undefined) });
    assert.deepEqual(
      problems.filter((problem) => problem.token.startsWith('chart[') && problem.token !== 'chart[0]').map((problem) => problem.message),
      [],
      preset.id,
    );
  }
});

test("the sample Apps' themes have no problems", async () => {
  for (const app of [
    'test/fixtures/apps/commons',
    'test/fixtures/apps/crm',
    'test/fixtures/apps/keystone/marketplace',
    'test/fixtures/apps/payday',
    'test/fixtures/apps/forecourt',
  ]) {
    const module = (await import(`../${app}/theme.js`)) as Record<string, unknown>;
    for (const value of Object.values(module)) {
      if (!value || typeof value !== 'object' || !('kind' in value) || value.kind !== 'theme') continue;
      const theme = compileAppTheme(value, app);
      const problems = checkTheme(theme, { authored: authoredRoles(theme, themeExtends(theme) ?? undefined) });
      assert.deepEqual(
        problems.map((problem) => problem.message),
        [],
        `${app} ${theme.id}`,
      );
    }
  }
});

// The looks that left the built-ins live on as examples in the themes page; a
// reader copies them, so each must compile and pass the checks `mistri check` makes.
test('the themes page examples compile and have no problems', () => {
  const page = readFileSync('site/src/content/docs/docs/themes.md', 'utf8').split('## Three themes to start from')[1]!;
  const examples = [...page.matchAll(/export const (\w+) = defineTheme\((\{[\s\S]*?\n\})\);/g)];
  assert.ok(examples.length >= 3, 'the page shows at least three themes');
  for (const [, name, literal] of examples) {
    const spec = { ...(new Function(`return (${literal});`)() as object), kind: 'theme' };
    const theme = compileAppTheme(spec, `themes.md ${name}`);
    const problems = checkTheme(theme, { authored: authoredRoles(theme, themeExtends(theme) ?? undefined) });
    assert.deepEqual(
      problems.map((problem) => problem.message),
      [],
      name,
    );
  }
});

test('a color has one name: a palette name from before 0.9.2 is refused with the name that replaced it', () => {
  const spec = (light: Record<string, unknown>) => ({
    kind: 'theme',
    id: 'renamed',
    label: 'Renamed',
    extends: 'lumen',
    colors: { light },
  });
  assert.throws(
    () => compileAppTheme(spec({ background: '#ffffff' }), 'theme'),
    /theme\.colors\.light\.background is now theme\.colors\.light\.ground\./,
  );
  assert.throws(() => compileAppTheme(spec({ navSurface: '#000000' }), 'theme'), /navSurface is now theme\.colors\.light\.nav\.ground\./);
  assert.throws(() => compileAppTheme(spec({ negative: '#c81e1e' }), 'theme'), /negative is now theme\.colors\.light\.status\.critical\./);
  // The compiled palette, the sheets' custom properties and check's messages say the same name.
  const theme = compileAppTheme(spec({ nav: { ground: '#1d1f22', ink: '#1e1e1e' } }), 'theme');
  assert.equal(theme.light.navGround, '#1d1f22');
  assert.ok(checkTheme(theme).some((problem) => problem.token === 'nav.ink' && /nav\.ink on nav\.ground/.test(problem.reason)));
});

test("a section's capitals, a lane's value, a pill's corner and a control's edge are each one word of the spec", () => {
  const base = { kind: 'theme', id: 'stamped', label: 'Stamped', extends: 'lumen' };
  const theme = compileAppTheme(
    {
      ...base,
      type: { roles: { section: { case: 'upper', size: '12px' } } },
      recipes: { lanes: 'tag' },
      shape: { radius: { pill: '2px' }, border: { control: '2px' } },
    },
    'theme',
  );
  assert.deepEqual(theme.type?.roles?.section, { size: '12px', weight: 600, tracking: '-0.01em', case: 'upper' });
  assert.equal(theme.recipes?.lanes, 'tag');
  assert.equal(theme.radius?.pill, '2px');
  assert.equal(theme.light.rulesControl, '2px');
  assert.equal(theme.dark.rulesControl, '2px');
  const refuse = (raw: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => compileAppTheme({ ...base, ...raw }, 'theme'), pattern);
  refuse(
    { type: { roles: { section: { case: 'shouting' } } } },
    /theme\.type\.roles\.section\.case must be one of none, upper, small-caps/,
  );
  refuse({ recipes: { lanes: 'neon' } }, /theme\.recipes\.lanes is not on the menu: pick one of tint, tag, plain/);
  refuse({ shape: { radius: { pill: '13px' } } }, /pill/);
  refuse(
    { shape: { radius: '6px' } },
    /theme\.shape\.radius is \{ control, field, pill, panel \}.*Write \{ control: '6px', field: '6px' \}/,
  );
  refuse({ shape: { border: { control: '3px' } } }, /theme\.shape\.border\.control must be 0px, 1px or 2px/);
});

test('a corner may be round and a panel its own, and a rule, an edge, a panel and the focus ring each take a width', () => {
  const base = { kind: 'theme', id: 'pebble', label: 'Pebble', extends: 'lumen' };
  const theme = compileAppTheme(
    {
      ...base,
      shape: {
        radius: { control: 'round', field: '12px', pill: 'round', panel: '20px' },
        border: { rule: '2px', control: '2px', panel: '0px', focus: '3px' },
      },
    },
    'theme',
  );
  // `round` is a pill's corner, a length no box reaches: the sheets keep every other box at its own.
  assert.deepEqual(theme.radius, { control: '999px', field: '12px', pill: '999px', panel: '20px' });
  for (const mode of ['light', 'dark'] as const) {
    assert.equal(theme[mode].rulesWeight, '2px');
    assert.equal(theme[mode].rulesControl, '2px');
  }
  assert.deepEqual(theme.border, { panel: '0px', focus: '3px' });
  // What the compile writes, the runtime check reads back as it is.
  assert.deepEqual(parseThemes([theme], 'app')![0]!.radius, theme.radius);
  assert.deepEqual(parseThemes([theme], 'app')![0]!.border, theme.border);
  const refuse = (raw: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => compileAppTheme({ ...base, ...raw }, 'theme'), pattern);
  refuse({ shape: { radius: { control: '17px' } } }, /theme\.shape\.radius\.control must be a length from 0px to 16px, or 'round'/);
  refuse({ shape: { radius: { field: 'round' } } }, /theme\.shape\.radius\.field must be a length from 0px to 12px\./);
  refuse({ shape: { radius: { panel: '21px' } } }, /theme\.shape\.radius\.panel must be a length from 0px to 20px\./);
  refuse({ shape: { border: { focus: '1px' } } }, /theme\.shape\.border\.focus must be 2px or 3px/);
  refuse({ shape: { border: { panel: '3px' } } }, /theme\.shape\.border\.panel must be 0px, 1px or 2px/);
  refuse({ shape: { border: { rule: '4px' } } }, /theme\.shape\.border\.rule must be 1px, 2px or 3px/);
  // A width is shape, not a color: the old place is refused with the new one's name.
  refuse({ colors: { light: { rules: { weight: '2px' } } } }, /theme\.colors\.light\.rules\.weight is now shape\.border\.rule/);
  refuse({ colors: { dark: { rules: { control: '2px' } } } }, /theme\.colors\.dark\.rules\.control is now shape\.border\.control/);
  refuse(
    { palettes: [{ id: 'bold', label: 'Bold', light: { rules: { weight: '3px' } } }] },
    /theme\.palettes\[0\]\.light\.rules\.weight is now shape\.border\.rule/,
  );
  // The runtime check holds a compiled theme to the same menu.
  assert.throws(() => parseThemes([{ ...theme, radius: { control: '40px' } }], 'app'), /radius\.control/);
  assert.throws(() => parseThemes([{ ...theme, border: { focus: '5px' } }], 'app'), /border\.focus/);
});

test("a panel squarer than the controls it holds is said, a round control's pill excepted", () => {
  const theme = (radius: Record<string, string>) =>
    compileAppTheme({ kind: 'theme', id: 'nest', label: 'Nest', extends: 'lumen', shape: { radius } }, 'theme');
  assert.deepEqual(themeShapeWarnings([theme({ control: '8px', panel: '4px' })]), [
    'ui.customThemes[0] ("nest") shape.radius.panel 4px is squarer than shape.radius.control 8px: a panel holds controls, so give its corner at least theirs.',
  ]);
  // check says it as its own code, a warning: the theme still wears.
  assert.equal(validationCode(themeShapeWarnings([theme({ control: '8px', panel: '4px' })])[0]!), 'theme-radius');
  assert.deepEqual(themeShapeWarnings([theme({ control: '4px', panel: '12px' })]), []);
  assert.deepEqual(themeShapeWarnings([theme({ control: 'round', panel: '4px' })]), []);
  // A panel the theme does not say is its controls' larger step, never squarer.
  assert.deepEqual(themeShapeWarnings([theme({ control: '16px' })]), []);
});

test('a theme moves at a pace: house, brisk or still, worn as one attribute and kept by a theme that extends it', () => {
  const base = { kind: 'theme', id: 'pace', label: 'Pace', extends: 'mono' };
  const brisk = compileAppTheme({ ...base, motion: 'brisk' }, 'theme');
  assert.equal(brisk.motion, 'brisk');
  assert.equal(recipeAttributes(brisk).attributes['data-look-motion'], 'brisk');
  // Said by nobody, the platform's pace: the attribute is there, so a sheet never has to ask for its absence.
  assert.equal(recipeAttributes(compileAppTheme(base, 'theme')).attributes['data-look-motion'], 'house');
  for (const preset of THEME_PRESETS) assert.equal(recipeAttributes(preset).attributes['data-look-motion'], 'house', preset.id);
  assert.deepEqual(parseThemes([brisk], 'app')![0]!.motion, 'brisk');
  assert.throws(() => compileAppTheme({ ...base, motion: 'fast' }, 'theme'), /theme\.motion must be one of house, brisk, still/);
  assert.throws(() => parseThemes([{ ...brisk, motion: 'fast' }], 'app'), /motion/);
});

test('a theme stands things apart at a rhythm: tight, house or airy, worn as one attribute and kept by a theme that extends it', () => {
  const base = { kind: 'theme', id: 'rhythm', label: 'Rhythm', extends: 'sage' };
  const airy = compileAppTheme({ ...base, rhythm: 'airy' }, 'theme');
  assert.equal(airy.rhythm, 'airy');
  assert.equal(recipeAttributes(airy).attributes['data-look-rhythm'], 'airy');
  assert.equal(recipeAttributes(compileAppTheme(base, 'theme')).attributes['data-look-rhythm'], 'house');
  for (const preset of THEME_PRESETS) assert.equal(recipeAttributes(preset).attributes['data-look-rhythm'], 'house', preset.id);
  assert.deepEqual(parseThemes([airy], 'app')![0]!.rhythm, 'airy');
  assert.throws(() => compileAppTheme({ ...base, rhythm: 'loose' }, 'theme'), /theme\.rhythm must be one of house, tight, airy/);
  assert.throws(() => parseThemes([{ ...airy, rhythm: 'loose' }], 'app'), /rhythm/);
});

test('a shadow has a colour of its own and a lift a step for cards and one for what floats', () => {
  const base = { kind: 'theme', id: 'dusk', label: 'Dusk', extends: 'lumen' };
  const theme = compileAppTheme(
    { ...base, colors: { light: { shadow: '#1e293b' }, dark: { shadow: '#000000' } }, shape: { elevation: { float: 'mid' } } },
    'theme',
  );
  assert.equal(theme.light.shadow, '#1e293b');
  assert.equal(theme.dark.shadow, '#000000');
  // A step over the look's own drawing: Lumen's cards and popups' edges stay; only the float's fall is said.
  assert.equal(theme.elevation, 'raised');
  assert.deepEqual(theme.lifts, { float: 'mid' });
  const { attributes } = recipeAttributes(theme);
  assert.equal(attributes['data-look-elevation'], 'raised');
  assert.equal(attributes['data-look-float'], 'mid');
  assert.equal(attributes['data-look-card'], 'look');
  // Said by nobody, each lift is the look's own, and every built-in is as it was.
  for (const preset of THEME_PRESETS) {
    const worn = recipeAttributes(preset).attributes;
    assert.deepEqual([worn['data-look-card'], worn['data-look-float']], ['look', 'look'], preset.id);
    assert.equal(preset.lifts, undefined, preset.id);
  }
  // A shadow colour under the platform's hairline draws the platform's own popups in it: their low step.
  const plain = compileAppTheme({ ...spec(), colors: { ...spec().colors, light: { ...spec().colors.light, shadow: '#3b2f1e' } } }, 'theme');
  assert.equal(recipeAttributes(plain).attributes['data-look-float'], 'low');
  assert.equal(recipeAttributes(compileAppTheme(spec(), 'theme')).attributes['data-look-float'], 'look');
  // Both steps over a theme that extends nothing.
  assert.deepEqual(compileAppTheme(spec({ shape: { elevation: { card: 'low', float: 'high' } } }), 'theme').lifts, {
    card: 'low',
    float: 'high',
  });
  // The runtime check reads a compiled theme back as it is, and holds it to the menu.
  assert.deepEqual(parseThemes([theme], 'app')![0]!.lifts, theme.lifts);
  assert.equal(parseThemes([theme], 'app')![0]!.light.shadow, '#1e293b');
  assert.throws(() => parseThemes([{ ...theme, lifts: { card: 'huge' } }], 'app'), /lifts\.card/);
  const refuse = (raw: Record<string, unknown>, pattern: RegExp) =>
    assert.throws(() => compileAppTheme({ ...base, ...raw }, 'theme'), pattern);
  refuse({ shape: { elevation: { float: 'huge' } } }, /theme\.shape\.elevation\.float must be one of none, hairline, low, mid, high/);
  refuse({ shape: { elevation: { glow: 'low' } } }, /theme\.shape\.elevation has no "glow"/);
  refuse({ colors: { light: { shadow: 'black' } } }, /theme\.colors\.light\.shadow must be a six-digit hex color/);
});

test('a shadow lighter than its ground is said: a glow is not a lift (theme-shadow, C2)', () => {
  const theme = compileAppTheme(
    { kind: 'theme', id: 'glow', label: 'Glow', extends: 'mono', colors: { dark: { shadow: '#f0f0f0' }, light: { shadow: '#111111' } } },
    'theme',
  );
  const warnings = themeShadowWarnings([theme]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0]!, /^ui\.customThemes\[0\] \("glow"\) colors\.dark\.shadow #f0f0f0 is lighter than its ground #\w{6}/);
  assert.equal(validationCode(warnings[0]!), 'theme-shadow');
  assert.equal(promiseOf('theme-shadow'), 'C2');
  assert.deepEqual(themeShadowWarnings(THEME_PRESETS), []);
});

test('the theme words renamed before 1.0 are refused with the new ones: recipes.header, nav.onCurrent', () => {
  const refused = (extra: Record<string, unknown>, pattern: RegExp) => assert.throws(() => compileAppTheme(spec(extra), 'theme'), pattern);
  // "head" is a table's column heads (rules.head); the record's and list's top is the header.
  refused({ recipes: { head: 'band' } }, /theme\.recipes\.head is now theme\.recipes\.header/);
  assert.equal(compileAppTheme(spec({ recipes: { header: 'band' } }), 'theme').recipes?.header, 'band');
  assert.equal(recipeAttributes(compileAppTheme(spec({ recipes: { header: 'hero' } }), 'theme')).attributes['data-look-header'], 'hero');
  // Words on a fill are on<Fill>, as onAccent; <color>Ink is a color used as text, as accentInk.
  const colors = spec().colors;
  refused(
    { colors: { ...colors, light: { ...colors.light, nav: { current: '#e6f2f2', currentInk: '#004b52' } } } },
    /nav\.currentInk is now theme\.colors\.light\.nav\.onCurrent/,
  );
  const named = compileAppTheme(
    spec({ colors: { ...colors, light: { ...colors.light, nav: { current: '#e6f2f2', onCurrent: '#004b52' } } } }),
    'theme',
  );
  assert.equal(named.light.navOnCurrent, '#004b52');
  refused({ parts: { 'nav.current': { ink: 'nav.currentInk' } } }, /names nav\.currentInk, which is now nav\.onCurrent/);
  // A compiled theme stored before the break (a tenant's saved branding) is refused the same way.
  const stored = { id: 'old', label: 'Old', base: 'sage', light: { surface: '#ffffff', ink: '#111111', accent: '#1d4ed8' } };
  assert.throws(
    () => parseThemes([{ ...stored, dark: stored.light, recipes: { head: 'band' } }], 'branding'),
    /recipes\.head is now branding\.themes\[0\]\.recipes\.header/,
  );
  assert.throws(
    () => parseThemes([{ ...stored, dark: stored.light, light: { ...stored.light, navCurrentInk: '#000000' } }], 'branding'),
    /navCurrentInk is now branding\.themes\[0\]\.light\.navOnCurrent/,
  );
});

test('a theme that extends a look and names an accent but no chart wears the accent as its first series; its own chart wins; the look is untouched', () => {
  const plum = (colors: Record<string, unknown>) =>
    compileAppTheme({ kind: 'theme', id: 'plum', label: 'Plum', extends: 'mono', colors: { light: colors } } as never, 'probe');
  const mono = themePreset('mono')!;
  const worn = plum({ accent: '#7a1fa2' });
  assert.equal(worn.light.chart1, '#7a1fa2');
  assert.equal(worn.light.chart2, mono.light.chart2);
  assert.equal(plum({ accent: '#7a1fa2', chart: ['#0e8fb0'] }).light.chart1, '#0e8fb0');
  assert.equal(plum({ ink: '#101010' }).light.chart1, mono.light.chart1);
  assert.notEqual(mono.light.chart1, '#7a1fa2');
});
