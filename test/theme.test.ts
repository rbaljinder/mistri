import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { BORDER_MENU } from '../packages/engine/src/shared/themeTokens.js';
import {
  componentInks,
  contrastRatio,
  FONT_TOKENS,
  HEAT_TOP,
  heatTop,
  PALETTE_TOKENS,
  parseThemes,
  RADIUS_TOKENS,
  THEME_BASES,
  themeWarnings,
} from '../packages/engine/src/shared/theme.js';
import { defineTheme, type ThemeSpec } from '@mistriwork/mistri/app';
import type { ThemeDefinition } from '../packages/engine/schema/theme.js';
import { COLOR_ROLES } from '../packages/mistri/src/shared/themeBuild.js';
import { DENSITIES, ELEVATIONS, LIFTS, MOTIONS, RECIPE_MENU, RECIPE_PARTS } from '../packages/engine/src/shared/themeRecipes.js';
import { TYPE_BASES, TYPE_ROLES } from '../packages/engine/src/shared/themeType.js';
import { loadApp } from '../packages/mistri/src/server/app/apps.js';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  inheritThemePreset,
  THEME_PRESETS,
  themePreset,
} from '../packages/engine/src/shared/themePresets.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { checkThemeWithFixes } from '../packages/mistri/src/shared/themeFix.js';

/** The compiled form: what parseThemes, themeWarnings and the client registries read. */
const compiled = (theme: ThemeDefinition): ThemeDefinition => theme;

const sample = (): ThemeDefinition =>
  compiled({
    id: 'sample',
    label: 'Sample',
    base: 'mono',
    light: { surface: '#ffffff', ink: '#222222', accent: '#006b73' },
    dark: { surface: '#151515', ink: '#eeeeee', accent: '#87d8d3' },
    fonts: { heading: 'Georgia, serif', data: 'Arial, sans-serif' },
    radius: { field: '3px' },
  });

/** The same theme as an App writes it: through defineTheme, by purpose. */
const sampleSpec = () =>
  defineTheme({
    id: 'sample',
    label: 'Sample',
    extends: 'mono',
    colors: {
      light: { surface: '#ffffff', ink: '#222222', accent: '#006b73' },
      dark: { surface: '#151515', ink: '#eeeeee', accent: '#87d8d3' },
    },
    type: { font: { heading: 'Georgia, serif', data: 'Arial, sans-serif' } },
    shape: { radius: { field: '3px' } },
  });

test('theme modules are plain data; parser preserves supported values without mutating input', () => {
  const theme = sample();
  const before = JSON.stringify(theme);
  assert.deepEqual(parseThemes([theme], 'app'), [theme]);
  assert.equal(JSON.stringify(theme), before);
  const spec: ThemeSpec = {
    id: 'x',
    label: 'X',
    colors: {
      light: { ground: '#ffffff', surface: '#ffffff', ink: '#111111', accent: '#006b73' },
      dark: { ground: '#111111', surface: '#151515', ink: '#eeeeee', accent: '#87d8d3' },
    },
  };
  const marked = defineTheme(spec);
  assert.equal(marked.kind, 'theme');
  assert.equal(marked.id, 'x');
  assert.equal(Object.hasOwn(spec, 'kind'), false);
  assert.equal(parseThemes(undefined, 'app'), undefined);
});

test('theme registry refuses collisions, missing modes, unknown roles and unsafe CSS values', () => {
  const invalid = [
    { ...sample(), id: 'lumen' },
    { ...sample(), id: 'Invalid Id' },
    { ...sample(), dark: undefined },
    { ...sample(), light: { surface: '#fff' } },
    { ...sample(), base: 'sample' },
    { ...sample(), css: 'body {}' },
    { ...sample(), light: { ...sample().light, ground: 'url(https://example.com)' } },
    { ...sample(), light: { ...sample().light, typo: '#ffffff' } },
    { ...sample(), fonts: { data: 'Arial; color: red' } },
    { ...sample(), radius: { field: '99px' } },
  ];
  for (const theme of invalid) assert.throws(() => parseThemes([theme], 'app'), /app.themes\[0\]/);
  assert.throws(() => parseThemes([sample(), sample()], 'app'), /unique slug/);
  assert.throws(() => parseThemes(Array(21).fill(sample()), 'app'), /at most 20/);
});

/** Every App names its home; these are about themes, so each gets one list and names it. */
const HOME = { resources: { task: {} }, views: { tasks: { kind: 'list', from: 'task' } }, home: 'tasks' };

test('a theme may suggest where the menu goes, and ui.shell says it first', () => {
  const topped = { ...sampleSpec(), shell: { placement: 'top' } };
  const shell = (ui: Record<string, unknown>) =>
    parseAppConfig({ name: 'App', ...HOME, ui: { customThemes: [topped], theme: { preset: 'sample' }, ...ui } }, 'app').ui.shell;
  assert.equal(compileAppTheme(topped, 'theme').shell?.placement, 'top');
  assert.equal(shell({})?.placement, 'top');
  assert.equal(shell({ shell: { placement: 'side' } })?.placement, 'side');
  // A rail is the side menu folded: asking for one keeps the side.
  assert.equal(shell({ shell: { rail: true } })?.placement, undefined);
  // Worn only by the App whose theme it is.
  assert.equal(parseAppConfig({ name: 'App', ...HOME, ui: { customThemes: [topped] } }, 'app').ui.shell, undefined);
  assert.throws(
    () => compileAppTheme({ ...sampleSpec(), shell: { placement: 'left' } }, 'theme'),
    /theme\.shell\.placement must be "side" or "top"/,
  );
});

test('app defaults resolve built-in and registered presets and preserve legacy themes', () => {
  assert.equal(
    parseAppConfig({ name: 'App', ...HOME, ui: { customThemes: [sampleSpec()], theme: { preset: 'sample' } } }, 'app').ui.theme?.preset,
    'sample',
  );
  assert.equal(parseAppConfig({ name: 'App', ...HOME, ui: { theme: { preset: 'sage' } } }, 'app').ui.theme?.preset, 'sage');
  assert.throws(
    () => parseAppConfig({ name: 'App', ...HOME, ui: { theme: { preset: 'missing' } } }, 'app'),
    /not a built-in theme or one of ui.customThemes/,
  );
  assert.deepEqual(
    parseAppConfig({ name: 'App', ...HOME, ui: { theme: { accent: '#123456', radius: '8px', font: 'Arial' } } }, 'app').ui.theme,
    { accent: '#123456', radius: '8px', font: 'Arial' },
  );
});

test('palette variants inherit theme colors without changing structure or the original pair', () => {
  const authored: ThemeDefinition = {
    ...sample(),
    defaultPalette: 'mint',
    palettes: [{ id: 'mint', label: 'Mint', light: { accent: '#225544' }, dark: { accent: '#aaddcc' } }],
  };
  const before = JSON.stringify(authored);
  const theme = parseThemes([authored], 'app')![0]!;
  assert.deepEqual(theme, authored);
  assert.equal(effectiveThemeDefinition(theme).light.accent, '#225544');
  assert.equal(effectiveThemeDefinition(theme, 'mint').dark.accent, '#aaddcc');
  assert.equal(effectiveThemeDefinition(theme, 'default').light.accent, authored.light.accent);
  assert.equal(effectiveThemeDefinition(theme, 'removed').light.accent, '#225544');
  assert.equal(inheritThemePreset(theme).light.accent, authored.light.accent);
  assert.equal(effectiveThemeDefinition(theme).light.ink, authored.light.ink);
  assert.equal(effectiveThemeDefinition(theme).dark.navGround, themePreset('mono')!.dark.navGround);
  assert.deepEqual(effectiveThemeDefinition(theme).fonts, inheritThemePreset(theme).fonts);
  assert.equal(JSON.stringify(authored), before);
});

test('palette variants refuse ambiguous IDs, missing modes, unsafe values and invalid defaults', () => {
  const variant = { id: 'mint', label: 'Mint', light: {}, dark: {} };
  for (const palettes of [
    null,
    [variant, variant],
    Array(21).fill(variant),
    [{ ...variant, id: 'default' }],
    [{ ...variant, id: 'Bad' }],
    [{ ...variant, label: ' ' }],
    [{ ...variant, label: 'x'.repeat(61) }],
    [{ ...variant, dark: undefined }],
    [{ ...variant, light: [] }],
    [{ ...variant, fonts: {} }],
    [{ ...variant, light: { typo: '#ffffff' } }],
    [{ ...variant, dark: { accent: 'url(example)' } }],
    [{ ...variant, light: { accent: '#fff' } }],
  ])
    assert.throws(() => parseThemes([{ ...sample(), palettes }], 'app'), /palettes/);
  for (const defaultPalette of ['missing', '', 3, null]) {
    assert.throws(() => parseThemes([{ ...sample(), palettes: [variant], defaultPalette }], 'app'), /defaultPalette/);
  }
  assert.doesNotThrow(() => parseThemes([{ ...sample(), defaultPalette: 'default' }], 'app'));
});

test('App palette defaults are scoped to their named preset', () => {
  const customThemes = [{ ...sampleSpec(), palettes: [{ id: 'mint', label: 'Mint' }] }];
  const parse = (theme: unknown) => parseAppConfig({ name: 'App', ...HOME, ui: { customThemes, theme } }, 'app');
  assert.equal(parse({ preset: 'sample', palette: 'mint' }).ui.theme?.palette, 'mint');
  assert.equal(parse({ preset: 'mono', palette: 'default' }).ui.theme?.palette, 'default');
  // A built-in look's palettes are authorable: every built-in offers the same twelve.
  assert.equal(parse({ preset: 'lumen', palette: 'teal' }).ui.theme?.palette, 'teal');
  assert.equal(parse({ preset: 'sage', palette: 'teal' }).ui.theme?.palette, 'teal');
  assert.equal(parse({ preset: 'workshop', palette: 'cobalt' }).ui.theme?.palette, 'cobalt');
  for (const theme of [
    { palette: 'mint' },
    { palette: 'default' },
    { preset: 'mono', palette: 'mint' },
    { preset: 'sage', palette: 'sunset' },
    { preset: 'sample', palette: 'missing' },
    { preset: 'sample', palette: 'Bad' },
  ]) {
    assert.throws(() => parse(theme), /ui.theme.palette/);
  }
});

test('contrast diagnostics include every variant in both modes, not only the default', () => {
  const theme = { ...sample(), palettes: [{ id: 'bad', label: 'Bad', light: { ink: '#ffffff' }, dark: { ink: '#151515' } }] };
  const warnings = themeWarnings([theme]);
  assert.ok(warnings.some((warning) => /Sample \/ Bad.*light.*ink\/surface.*1.00:1/.test(warning)));
  assert.ok(warnings.some((warning) => /Sample \/ Bad.*dark.*ink\/surface.*1.00:1/.test(warning)));
});

test('opaque-color contrast checks report actionable mode-specific warnings', () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21);
  assert.equal(contrastRatio('#abcdef', '#abcdef'), 1);
  assert.deepEqual(themeWarnings([sample()]), []);
  const bad = sample();
  bad.dark.ink = bad.dark.surface;
  assert.match(themeWarnings([bad])[0]!, /Sample.*dark.*ink\/surface.*1.00:1/);
});

test('theme schema mirrors the public token, font, radius, and base keys', () => {
  const schema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/theme.schema.json', import.meta.url), 'utf8'));
  // The schema describes defineTheme's input, by purpose: every compiled role is one spec colour.
  const specColors = (defs: { properties: Record<string, { properties?: Record<string, unknown> }> }) =>
    Object.entries(defs.properties).flatMap(([key, value]) =>
      value.properties ? Object.keys(value.properties).map((leaf) => `${key}.${leaf}`) : key === 'chart' ? [] : [key],
    );
  const paths = new Set([...specColors(schema.$defs.colors), ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `chart[${n - 1}]`)]);
  assert.deepEqual([...paths].sort(), COLOR_ROLES.map(([path]) => path).sort());
  assert.deepEqual(Object.keys(schema.$defs.colorsOver.properties), Object.keys(schema.$defs.colors.properties));
  // Every compiled role is a spec color but the two widths, which the spec says once as shape.border.
  assert.deepEqual(
    Object.keys(PALETTE_TOKENS).filter((role) => !COLOR_ROLES.some(([, color]) => color === role)),
    ['rulesWeight', 'rulesControl'],
  );
  assert.deepEqual(Object.keys(schema.properties.shape.properties.border.properties), Object.keys(BORDER_MENU));
  for (const [key, menu] of Object.entries(BORDER_MENU))
    assert.deepEqual(schema.properties.shape.properties.border.properties[key].enum, menu);
  assert.deepEqual(Object.keys(schema.properties.type.properties.font.oneOf[1].properties), Object.keys(FONT_TOKENS));
  assert.deepEqual(Object.keys(schema.properties.shape.properties.radius.properties), Object.keys(RADIUS_TOKENS));
  assert.deepEqual(schema.properties.extends.anyOf[0].enum, [...THEME_BASES]);
  assert.deepEqual(Object.keys(schema.properties.recipes.properties), RECIPE_PARTS);
  for (const part of RECIPE_PARTS) assert.deepEqual(schema.properties.recipes.properties[part].enum, Object.keys(RECIPE_MENU[part]), part);
  assert.deepEqual([...schema.properties.shape.properties.elevation.oneOf[0].enum].sort(), Object.keys(ELEVATIONS).sort());
  for (const step of ['card', 'float'])
    assert.deepEqual(schema.properties.shape.properties.elevation.oneOf[1].properties[step].enum, Object.keys(LIFTS).slice(1), step);
  assert.deepEqual(schema.properties.type.properties.base.enum, [...TYPE_BASES]);
  for (const [role, rule] of Object.entries(TYPE_ROLES))
    assert.deepEqual(Object.keys(schema.properties.type.properties.roles.properties[role].properties), [...rule.takes], role);
  assert.deepEqual(schema.properties.density.enum, [...DENSITIES]);
  assert.deepEqual(schema.properties.motion.enum, Object.keys(MOTIONS));
  assert.deepEqual(schema.properties.kind, { const: 'theme' });
  assert.deepEqual(schema.properties.id.not.enum, ['default', ...THEME_BASES]);
});

test('new theme families validate through the public contract with legible palettes', () => {
  for (const preset of THEME_PRESETS) {
    assert.equal(parseAppConfig({ name: 'App', ...HOME, ui: { theme: { preset: preset.id } } }, 'app').ui.theme?.preset, preset.id);
    assert.throws(() => parseThemes([preset], 'app'), /not a built-in theme name/);
    const custom = { ...preset, id: `my-${preset.id}` };
    assert.deepEqual(parseThemes([custom], 'app'), [custom]);
    assert.deepEqual(themeWarnings([preset]), []);
    for (const variant of preset.palettes ?? []) {
      for (const mode of ['light', 'dark'] as const) {
        const palette = { ...preset[mode], ...variant[mode] };
        // The built file says a palette as what it changes; one that moves the accent says its ring with it.
        if (variant[mode]?.accent) assert.ok(variant[mode]?.focus, `${preset.id}/${variant.id} ${mode} names its own focus ring`);
        for (const ground of ['surface', 'ground', 'raised'] as const) {
          assert.ok(contrastRatio(palette.focus!, palette[ground]!) >= 3, `${preset.id}/${variant.id} ${mode} focus on ${ground}`);
        }
      }
    }
    for (const mode of ['light', 'dark'] as const) {
      const palette = preset[mode];
      for (const role of ['statusGood', 'statusWarning', 'statusCritical', 'statusInfo'] as const) {
        assert.ok(contrastRatio(palette[role]!, palette.surface) >= 4.5, `${preset.id} ${mode} ${role}`);
      }
      assert.ok(contrastRatio(palette.navAccent!, palette.navGround!) >= 4.5, `${preset.id} ${mode} navAccent`);
      // A field's edge reads at 3:1 on the field, the page and the subtle panel a field can sit on (WCAG 1.4.11).
      for (const ground of ['surface', 'ground', 'raised'] as const) {
        assert.ok(contrastRatio(palette.lineControl!, palette[ground]!) >= 3, `${preset.id} ${mode} borderControl on ${ground}`);
      }
      // The focus ring is its own softer tint of the hue, never the accent itself, and still reads at 3:1 (WCAG 1.4.11).
      // Where the accent is the ink (Mono), the ring is the ink: a grey ring vanished on its inverted current entry.
      assert.ok(
        palette.focus && (palette.focus !== palette.accent || palette.accent === palette.ink),
        `${preset.id} ${mode} names its own focus ring`,
      );
      for (const ground of ['surface', 'ground', 'raised'] as const) {
        assert.ok(contrastRatio(palette.focus!, palette[ground]!) >= 3, `${preset.id} ${mode} focus on ${ground}`);
      }
    }
  }
});

test('a control edge under 3:1 on its field or on the page is warned, inherited or authored', () => {
  // Mono's black control edge, inherited, on a page the author took dark.
  const shaded = compiled({ ...sample(), light: { ...sample().light, ground: '#4a4a4a' } });
  const inherited = themeWarnings([shaded]);
  assert.ok(
    inherited.some((warning) =>
      /"Sample" \(light\): lineControl\/ground contrast is 2\.37:1; a form control's edge needs 3:1\./.test(warning),
    ),
    inherited.join('\n'),
  );
  const faint = compiled({ ...sample(), dark: { ...sample().dark, lineControl: '#333333' } });
  // Its panel and Mono's darker page, inherited, are two grounds and two warnings.
  assert.deepEqual(themeWarnings([faint]), [
    'Theme "Sample" (dark): lineControl/surface contrast is 1.45:1; a form control\'s edge needs 3:1.',
    'Theme "Sample" (dark): lineControl/ground contrast is 1.66:1; a form control\'s edge needs 3:1.',
    // …and the raised panel and table head a field and a sort control stand on: a third ground, a third warning.
    "Theme \"Sample\" (dark): a control's edge on a raised panel or a table's head, lineControl/raised contrast is 1.43:1; a form control's edge needs 3:1.",
  ]);
});

test('a status color is checked on the page as well as on a panel', () => {
  // A red on Meridian's warmer paper: 4.83:1 on white panels, 4.43:1 on the page.
  const paper = compiled({ ...sample(), light: { ...sample().light, ground: '#f6f5f1', statusCritical: '#dc2626' } });
  const warnings = themeWarnings([paper]);
  assert.ok(
    warnings.some((warning) =>
      /"Sample" \(light\): status\.critical\/ground contrast is 4\.43:1; normal text needs 4\.5:1\./.test(warning),
    ),
    warnings.join('\n'),
  );
  assert.ok(!warnings.some((warning) => /negative\/surface/.test(warning)));
  // A page the colour of its panels is one ground, warned once; the raised panel a hovered row stands on is another.
  const flat = compiled({ ...sample(), light: { ...sample().light, ground: '#ffffff', statusWarning: '#e0a000' } });
  assert.deepEqual(
    themeWarnings([flat])
      .filter((warning) => /warning\//.test(warning))
      .map((warning) => /status\.warning\/(\w+)/.exec(warning)![1]),
    ['surface', 'raised'],
  );
});

test("the sample Apps' registered themes pass the startup check, control edges and status colors included", async () => {
  const { meridian } = await import('../test/fixtures/apps/crm/theme.js');
  const { showroom } = await import('../test/fixtures/apps/forecourt/theme.js');
  assert.deepEqual(themeWarnings([compileAppTheme(meridian, 'meridian'), compileAppTheme(showroom, 'showroom')]), []);
});

test('contrast warnings also check colors inherited from a new theme base', () => {
  // Sage's muted text on a surface of the same colour: inherited, and caught.
  const custom = {
    ...sample(),
    base: 'sage' as const,
    light: { surface: themePreset('sage')!.light.inkMuted!, ink: '#ffffff', accent: '#ffffff' },
  };
  assert.ok(themeWarnings([custom]).some((warning) => /inkMuted\/surface.*1.00:1/.test(warning)));
});

test('the four built-in looks read as a sans interface with AA accents, and every one is an inheritable base', () => {
  assert.deepEqual(
    THEME_PRESETS.map((preset) => preset.id),
    ['workshop', 'lumen', 'mono', 'sage', 'ledger'],
  );
  assert.deepEqual([...THEME_BASES], ['workshop', 'lumen', 'mono', 'sage', 'ledger']);
  assert.equal(parseAppConfig({ name: 'Unchanged default', ...HOME }, 'app').ui.theme, undefined);
  for (const preset of THEME_PRESETS) {
    // The interface and its data are one sans, except Ledger's, whose data is a monospace (its figures line up down a
    // page); a look may set its titles in a book face or a condensed cut of its own sans (Workshop's), and nothing else.
    const ui = preset.fonts?.ui ?? '';
    const heading = preset.fonts?.heading ?? '';
    assert.match(ui, /sans-serif$/, `${preset.id} interface face`);
    if (preset.id === 'ledger') assert.match(preset.fonts?.data ?? '', /^'IBM Plex Mono', .*monospace$/, 'ledger data face');
    else assert.equal(preset.fonts?.data, preset.fonts?.ui, `${preset.id} data face`);
    assert.ok(
      heading === ui || /(^|, )serif$/.test(heading) || (/Condensed/.test(heading) && heading.includes(ui.split(',')[0]!)),
      `${preset.id} heading face`,
    );
    for (const mode of ['light', 'dark'] as const) {
      // The accent as text: Workshop's accent is a fill only, and its words in the accent's place are the ink.
      const text = preset[mode].accentInk ?? preset[mode].accent;
      assert.ok(contrastRatio(text, preset[mode].ground!) >= 4.5, `${preset.id} ${mode} accent on background`);
    }
  }
  const sage = themePreset('sage')!;
  const authored = compiled({ ...sample(), id: 'my-workspace', base: 'sage', fonts: undefined, radius: undefined });
  const inherited = inheritThemePreset(parseThemes([authored], 'app')![0]!);
  assert.equal(inherited.fonts?.data, sage.fonts?.data);
  assert.equal(inherited.radius?.field, sage.radius?.field);
  assert.equal(inherited.dark.navGround, sage.dark.navGround);
  assert.equal(inherited.light.accent, authored.light.accent);
  assert.throws(
    () => parseThemes([{ ...sample(), base: 'studio' as never }], 'app'),
    /base must be one of workshop, lumen, mono, sage, ledger/,
  );
});

test('Compass loads its theme through a normal imported module', async () => {
  const loaded = await loadApp(new URL('../test/fixtures/apps/compass-theme', import.meta.url).pathname);
  assert.equal(loaded.app.ui.customThemes?.[0]?.id, 'harbor');
  assert.deepEqual(themeWarnings(loaded.app.ui.customThemes ?? []), []);
});

test('the grounds a real page draws are checked, not only the palette pairs', () => {
  // Faint text that passes on the panel and fails on the row/hover ground.
  const rows = compiled({ ...sample(), light: { ...sample().light, raised: '#e0e0e0', inkSubtle: '#6b6b6b' } });
  assert.ok(
    themeWarnings([rows]).some((warning) =>
      /"Sample" \(light\): inkSubtle\/raised contrast is [\d.]+:1; normal text needs 4\.5:1\./.test(warning),
    ),
  );
  // A warning colour that clears 4.5:1 alone and not as a chip: 78% into the ink, on its own 12% tint.
  const chip = compiled({ ...sample(), light: { ...sample().light, ink: '#ffffff', statusWarning: '#8a6d00' } });
  assert.ok(
    themeWarnings([chip]).some((warning) => /status\.warning tone chip/.test(warning)),
    themeWarnings([chip]).join('\n'),
  );
  // The danger colour on a tint of itself: Canvas's old red read 4.14:1 on its own banner.
  const banner = compiled({ ...sample(), light: { ...sample().light, statusCritical: '#dc2626' } });
  assert.ok(themeWarnings([banner]).some((warning) => /status\.critical\/danger banner contrast is 4\.14:1/.test(warning)));
  // The focus ring needs 3:1 on the page too, not only on the panel.
  const ring = compiled({ ...sample(), light: { ...sample().light, ground: '#0a5057', focus: '#0b5a61' } });
  assert.ok(themeWarnings([ring]).some((warning) => /focus\/ground contrast is [\d.]+:1; the focus ring needs 3:1\./.test(warning)));
});

test('every built-in look and every sample App theme passes the extended checks', async () => {
  const themes: ThemeDefinition[] = [...THEME_PRESETS];
  for (const app of [
    'test/fixtures/apps/crm',
    'test/fixtures/apps/keystone/marketplace',
    'test/fixtures/apps/payday',
    'test/fixtures/apps/forecourt',
  ]) {
    const module = (await import(`../${app}/theme.js`)) as Record<string, unknown>;
    for (const value of Object.values(module))
      if (value && typeof value === 'object' && 'kind' in value && value.kind === 'theme') themes.push(compileAppTheme(value, app));
  }
  assert.ok(themes.length > THEME_PRESETS.length);
  assert.deepEqual(themeWarnings(themes), []);
});

test("a matrix's heat stops where its ink would fade on the accent's tint (G186)", () => {
  const tint = (accent: string, surface: string, weight: number) => {
    const channel = (at: number) =>
      Math.round(parseInt(accent.slice(at, at + 2), 16) * weight + parseInt(surface.slice(at, at + 2), 16) * (1 - weight));
    return `#${[1, 3, 5].map((at) => channel(at).toString(16).padStart(2, '0')).join('')}`;
  };
  const tops: Record<string, number> = {};
  for (const preset of THEME_PRESETS)
    for (const mode of ['light', 'dark'] as const) {
      const palette = effectiveThemePalette(effectiveThemeDefinition(preset)[mode], mode === 'dark');
      const top = heatTop(palette);
      tops[`${preset.id} ${mode}`] = top;
      assert.ok(top <= HEAT_TOP && top >= 0.2, `${preset.id} ${mode}: ${top}`);
      // The heaviest cell's figure and its column's name are in the ink: 4.5:1 on the tint drawn.
      if (/^#[0-9a-f]{6}$/i.test(palette.accent!) && /^#[0-9a-f]{6}$/i.test(palette.surface!))
        assert.ok(contrastRatio(palette.ink!, tint(palette.accent!, palette.surface!, top)) >= 4.45, `${preset.id} ${mode}`);
    }
  // Lumen's blue keeps the whole scale; Mono's black, where the ink is the accent, stops short of it.
  assert.equal(tops['lumen light'], HEAT_TOP);
  assert.ok(tops['mono light']! < HEAT_TOP && tops['mono dark']! < HEAT_TOP);
  // An authored accent is measured as worn: a teal reads at the top, an accent the ink's own color does not.
  assert.equal(heatTop(effectiveThemePalette(themePreset('lumen')!.light, false, { accent: '#0f766e' })), HEAT_TOP);
  assert.ok(heatTop({ accent: '#1c1a17', surface: '#ffffff', ink: '#1c1a17' }) < HEAT_TOP);
  // The Workbench's own dark palette (@mistriwork/ui's tokens.css) says its heat top beside its colors; it is the measured one.
  const sheet = readFileSync('packages/ui/src/tokens.css', 'utf8');
  const dark = /:root\[data-theme="dark"\] \{(\s*--ground[^}]*)\}/.exec(sheet)![1]!;
  const token = (name: string) => new RegExp(`--${name}: ([^;]+);`).exec(dark)![1]!;
  assert.equal(
    token('heat-top'),
    `${Math.round(heatTop({ accent: token('accent'), surface: token('surface'), ink: token('ink') }) * 100)}%`,
  );
  assert.equal((sheet.match(/--heat-top: 46%;/g) ?? []).length, 2, 'the media query and the stamped dark mode say it alike');
  // A color the check cannot read keeps the top rather than guessing.
  assert.equal(heatTop({ accent: 'oklch(60% 0.1 200)', surface: '#ffffff', ink: '#111111' }), HEAT_TOP);
});

test("an authored accent takes the focus ring with it; a base look's tint of another hue is not inherited", () => {
  const sage = themePreset('sage')!;
  const own = { id: 'brand', label: 'Brand', base: 'sage' as const, light: { accent: '#7a1fa2' }, dark: { accent: '#e0b0ff' } };
  const worn = effectiveThemeDefinition(own as never);
  assert.equal(worn.light.focus, undefined);
  assert.equal(effectiveThemePalette(worn.light, false).focus, '#7a1fa2');
  assert.equal(effectiveThemePalette(sage.light, false).focus, sage.light.focus);
  assert.equal(effectiveThemePalette(sage.light, false, { accent: '#b00020' }).focus, '#b00020');
  const authored = { ...own, light: { accent: '#7a1fa2', focus: '#9a63b5' } };
  assert.equal(effectiveThemeDefinition(authored as never).light.focus, '#9a63b5');
});

test('a focus ring under 3:1 on its ground is warned', () => {
  const sage = themePreset('sage')!;
  const warnings = themeWarnings([{ ...sage, id: 'pale', base: 'sage', light: { ...sage.light, focus: '#f0f0f0' } } as never]);
  assert.ok(
    warnings.some((warning) => /focus\/surface/.test(warning)),
    warnings.join('\n'),
  );
});

/* T-2: a board card's category chip is its series mixed into the ink on a tint of it (TriageBoard.css), a pair no two
   tokens are: check measures it as drawn, and names the series a fix changes. */
test("a series too pale for a category chip or an avatar's initials is refused by the series", () => {
  const spec = (pale: string) =>
    compileAppTheme(
      {
        id: 'care',
        label: 'Care',
        colors: {
          light: {
            ground: '#f4f7fb',
            surface: '#ffffff',
            ink: '#14202e',
            accent: '#0f6f8f',
            chart: ['#0f6f8f', '#1b9c6b', '#7c5cd6', '#cc8318', pale],
          },
          dark: { ground: '#0d141c', surface: '#141d27', ink: '#e8eef5', accent: '#6cc4e0' },
        },
      },
      'care',
    );
  const problems = checkThemeWithFixes(spec('#fae3ec')).filter((problem) => problem.role === 'chart5');
  assert.deepEqual(
    problems.map((problem) => problem.check),
    ["chart5 as a board card's category chip", "chart5 as an avatar's initials"],
  );
  assert.match(
    problems[0]!.message,
    /care\.colors\.light\.chart\[4\]: chart\[4\] as a board card's category chip is 4\.19:1; it needs 4\.5:1 \(chart\[4\] is #fae3ec\)\. Try chart\[4\]: '#[0-9a-f]{6}'/,
  );
  assert.deepEqual(
    checkThemeWithFixes(spec(problems[0]!.fix!.value as string)).filter((problem) => problem.role === 'chart5'),
    [],
  );
  // The strip board says the category in words, not a chip: only the avatar is held to it there.
  const stripped = componentInks({ ...spec('#fae3ec').light, chart5: '#fae3ec' }, { board: 'strip' });
  assert.ok(!stripped.some((item) => item.what.includes('category chip')));
});

/* T-3: a link written as an amber accent read 2.0:1 and passed, because a link the same as the accent is drawn in the
   accent's ink. A colour written is worn as written or refused: it is measured as written, light and dark. */
test('a link, ring, menu mark or first series written as the accent is measured as written', () => {
  const theme = (light: Record<string, unknown>, dark: Record<string, unknown> = {}) =>
    compileAppTheme(
      {
        id: 'care',
        label: 'Care',
        colors: {
          light: { ground: '#f4f7fb', surface: '#ffffff', ink: '#14202e', accent: '#0f6f8f', ...light },
          dark: { ground: '#0d141c', surface: '#141d27', ink: '#e8eef5', accent: '#6cc4e0', ...dark },
        },
      },
      'care',
    );
  const written = (problems: ReturnType<typeof checkThemeWithFixes>) => problems.filter((problem) => problem.written);
  const amber = written(checkThemeWithFixes(theme({ accent: '#e9a13b', link: '#e9a13b', focus: '#e9a13b' })));
  assert.deepEqual([...new Set(amber.map((problem) => problem.token))], ['link', 'focus']);
  const surface = amber.find((problem) => problem.check === 'link as written on surface')!;
  assert.match(
    surface.message,
    /^Theme "Care" \(light\), care\.colors\.light\.link: link as written on surface is 2\.18:1; it needs 4\.5:1 \(link is #e9a13b\)\. Written the same as the accent, it is drawn in the accent's ink instead: leave it out to wear that, or write one that reads\. Try link: '#[0-9a-f]{6}' \(4\.\d\d:1\)\.$/,
  );
  // Dark mode is held to it too, and a fix that reads passes as written.
  assert.ok(written(checkThemeWithFixes(theme({}, { accent: '#1a3a5a', link: '#1a3a5a' }))).every((problem) => problem.mode === 'dark'));
  assert.deepEqual(written(checkThemeWithFixes(theme({ accent: '#e9a13b', link: surface.fix!.value as string }))), []);
  // An accent that reads as text, written again as the link, is the link the page draws: nothing to say.
  assert.deepEqual(written(checkThemeWithFixes(theme({ link: '#0f6f8f' }))), []);
});
