import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appThemeWarnings, themeWarnings } from '../packages/engine/src/shared/theme.js';
import { effectiveThemeDefinition, effectiveThemePalette, THEME_PRESETS } from '../packages/engine/src/shared/themePresets.js';

test('effective palette preserves legacy CSS expressions and override precedence without mutation', () => {
  const base = THEME_PRESETS.find((theme) => theme.id === 'mono')!;
  const before = JSON.stringify(base);
  const themed = { ...base, palettes: [{ id: 'mint', label: 'Mint', light: { accent: '#123456' }, dark: {} }], defaultPalette: 'mint' };
  const palette = effectiveThemeDefinition(themed).light;
  assert.equal(effectiveThemePalette(palette, false).accent, '#123456');
  assert.equal(effectiveThemePalette(palette, false, { accent: 'var(--brand)' }).link, 'var(--brand)');
  // An authored accent is the charts' first series too, and nothing else of the palette's.
  assert.equal(effectiveThemePalette(palette, false, { accent: '#2258cf' }).chart1, '#2258cf');
  assert.equal(effectiveThemePalette(palette, false).chart1, palette.chart1);
  assert.equal(effectiveThemePalette(palette, true, { accent: '#ffffff' }).accent, 'color-mix(in srgb, #ffffff 62%, white)');
  assert.equal(effectiveThemePalette(palette, true, { accent: '#ffffff' }).accentSoft, 'color-mix(in srgb, #ffffff 14%, transparent)');
  // An accent for each ground is worn as written on each, never mixed, and the tint follows the one worn.
  const pair = { accent: { light: '#123456', dark: '#abcdef' } };
  assert.equal(effectiveThemePalette(palette, false, pair).accent, '#123456');
  assert.equal(effectiveThemePalette(palette, true, pair).accent, '#abcdef');
  assert.equal(effectiveThemePalette(palette, true, pair).accentSoft, 'color-mix(in srgb, #abcdef 14%, transparent)');
  assert.equal(JSON.stringify(base), before);
});

test('effective contrast diagnoses navigation, page text and hovered-row text in each palette', () => {
  const base = THEME_PRESETS.find((theme) => theme.id === 'mono')!;
  const theme = {
    ...base,
    id: 'hostile',
    label: 'Hostile',
    palettes: [
      {
        id: 'bad',
        label: 'Bad',
        light: {
          navAccent: base.light.navGround!,
          ground: base.light.ink,
          raised: base.light.ink,
        },
        dark: {},
      },
    ],
  };
  const warnings = themeWarnings([theme]);
  for (const pair of ['nav.accent/nav.ground', 'ink/ground', 'ink/raised']) {
    assert.ok(
      warnings.some((warning) => warning.includes('Hostile / Bad') && warning.includes(`${pair} contrast is 1.00:1`)),
      pair,
    );
  }
});

test('App overrides are checked on built-ins and unsupported CSS is explicitly unmeasured', () => {
  assert.deepEqual(appThemeWarnings([]), []);
  /* A white accent is a fill: the words on it, its links, the ring and the first series are the inks chosen to read. */
  assert.deepEqual(appThemeWarnings([], { accent: '#ffffff' }), []);
  const unsupported = appThemeWarnings([], { accent: 'var(--brand)' });
  assert.ok(unsupported.some((warning) => warning.includes('contrast was not checked')));
  assert.ok(unsupported.every((warning) => !warning.includes('NaN')));
});

test('selected-control contrast composites transparent tints on the actual opaque ground', () => {
  const base = THEME_PRESETS.find((theme) => theme.id === 'mono')!;
  const theme = {
    ...base,
    label: 'Transparent',
    light: { ...base.light, surface: '#ffffff', ground: '#ffffff', accentInk: '#ffffff', accentSoft: '#ffffff' },
  };
  const warnings = themeWarnings([theme]);
  assert.ok(warnings.some((warning) => /Transparent.*light.*accentInk\/accentSoft over surface contrast is 1.00:1/.test(warning)));
});

test('navigation overlay checks can expose a failure hidden by the base surface pair', () => {
  // Mono's own colors only: its palettes say a menu accent of their own, measured on their own.
  const base = { ...THEME_PRESETS.find((theme) => theme.id === 'mono')!, palettes: undefined };
  const theme = { ...base, label: 'Overlay', light: { ...base.light, navGround: '#000000', navInk: '#ffffff', navAccent: '#757575' } };
  const warnings = themeWarnings([theme]);
  assert.ok(!warnings.some((warning) => /Overlay.*light.*nav\.accent\/nav\.ground/.test(warning)));
  assert.ok(warnings.some((warning) => /Overlay.*light.*nav\.accent\/navigation hover/.test(warning)));
});

test('navigation diagnostics match fractional navigation-ink mixes rather than fixed white overlays', () => {
  const base = THEME_PRESETS.find((theme) => theme.id === 'mono')!;
  const theme = { ...base, label: 'Ink mix', light: { ...base.light, navGround: '#ffffff', navInk: '#777777', navAccent: '#777777' } };
  const warnings = themeWarnings([theme]);
  const luminance = (channel: number) => ((channel / 255 + 0.055) / 1.055) ** 2.4;
  for (const [label, weight] of [
    ['nav.accent/navigation hover', 0.05],
    ['nav.ink/navigation expanded', 0.07],
  ] as const) {
    const ground = 119 * weight + 255 * (1 - weight);
    const expected = ((luminance(ground) + 0.05) / (luminance(119) + 0.05)).toFixed(2);
    assert.ok(
      warnings.some(
        (warning) => warning.includes('Ink mix') && warning.includes('(light)') && warning.includes(`${label} contrast is ${expected}:1`),
      ),
      `${label}: ${expected}`,
    );
  }
});

test('legacy diagnostics distinguish known invalid values from unmeasured supported CSS', () => {
  const warnings = appThemeWarnings([], { accent: 'url(https://example.invalid/image)', radius: '-1px' });
  assert.ok(warnings.some((warning) => warning.includes('CSS image URL is not a color')));
  assert.ok(warnings.some((warning) => warning.includes('negative radius')));
  assert.ok(
    appThemeWarnings([], { accent: { light: 'var(--tint)', dark: '#ffffff' } }).some((warning) =>
      warning.includes('accent.light: contrast was not checked'),
    ),
  );
  for (const radius of ['0', '10px', '100000px', '1rem']) {
    assert.deepEqual(appThemeWarnings([], { radius }), []);
  }
});

test('legacy radius diagnostics preserve literal shorthands and distinguish unmeasured expressions', () => {
  for (const radius of [
    '-0px',
    '+2px',
    '.5rem',
    '1e2px',
    '10px 20%',
    '1rem / 50%',
    '1px 2px 3px 4px / 5% 6% 7% 8%',
    '2dvw',
    '2cqi',
    'initial',
    'inherit',
    'unset',
    'revert',
    'revert-layer',
  ]) {
    assert.deepEqual(appThemeWarnings([], { radius }), [], radius);
  }
  for (const radius of ['potato', 'auto', '-1px', '2', '1px -2%']) {
    const warnings = appThemeWarnings([], { radius });
    assert.equal(warnings.length, 1, radius);
    assert.ok(warnings[0]!.includes('not a CSS radius') || warnings[0]!.includes('not valid CSS'), radius);
  }
  for (const radius of ['var(--radius)', 'calc(1rem + 2px)', 'min(1vw, 2px)', '1futureunit', '1px / / 2px']) {
    const warnings = appThemeWarnings([], { radius });
    assert.equal(warnings.length, 1, radius);
    assert.ok(warnings[0]!.includes('validity was not checked'), radius);
  }
});

test("the search is a field on the surface in the page's ink, so nav.muted is read there only under the dark bar", () => {
  for (const family of ['lumen', 'mono', 'sage', undefined] as const) {
    const base = THEME_PRESETS.find((theme) => theme.id === (family ?? 'mono'))!;
    const theme = {
      ...base,
      base: family,
      label: 'Surface search',
      light: { ...base.light, navGround: '#000000', navInk: '#ffffff', navMuted: '#ffffff', navAccent: '#ffffff', surface: '#ffffff' },
    };
    // The field's words are the page's muted ink (themeFamilies.css), so nav.muted is not read on the surface.
    assert.ok(!themeWarnings([theme]).some((warning) => /Surface search.*light.*navigation search/.test(warning)), String(family));
    const dark = { ...theme, recipes: { ...theme.recipes, bar: 'dark' as const }, light: { ...theme.light, navMuted: '#111111' } };
    assert.ok(
      themeWarnings([dark]).some((warning) => /Surface search.*light.*nav\.muted\/navigation search contrast/.test(warning)),
      String(family),
    );
    // The dark bar's keys (New, the customer chooser) are its ink on the same tint (G174): read as a pair of their own.
    const dim = { ...dark, light: { ...dark.light, navMuted: '#ffffff', navInk: '#333333' } };
    assert.ok(
      themeWarnings([dim]).some((warning) => /Surface search.*light.*nav\.ink\/navigation bar button contrast/.test(warning)),
      String(family),
    );
  }
});

test("the words on an accent fill are the theme's own or derived, and checked on the fill whatever the tabs draw", () => {
  for (const [family, tabs] of [['lumen'], ['mono'], ['sage'], ['lumen', 'pill']] as const) {
    const base = THEME_PRESETS.find((theme) => theme.id === family)!;
    const palette = {
      surface: '#ffffff',
      ground: '#eeeeee',
      ink: '#000000',
      link: '#000000',
      accent: '#757575',
      focus: '#757575',
      accentSoft: '#ffffff',
      statusGood: '#000000',
      statusWarning: '#000000',
      statusCritical: '#000000',
      statusInfo: '#000000',
      lineControl: '#000000',
    };
    // A look's named palettes recolour the accent over these grounds; the check here is the base's own tabs.
    const theme = {
      ...base,
      ...(tabs ? { recipes: { ...base.recipes, tabs } } : {}),
      palettes: undefined,
      label: 'Filled tabs',
      light: { ...base.light, ...palette },
      dark: { ...base.dark, ...palette },
    };
    for (const mode of ['light', 'dark'] as const) {
      /* The page's color on this accent reads 3.6:1, so the words on the fill are derived, and nothing is said. */
      const warnings = themeWarnings([theme]).filter((warning) => warning.includes(`(${mode})`));
      assert.ok(!warnings.some((warning) => warning.includes('onAccent')), `${family} ${mode}`);
      assert.ok(!warnings.some((warning) => warning.includes('accentInk/surface')), `${family} ${mode}`);
      /* A theme that names the page's color for them says it on every look, filled tabs or not. */
      const named = { ...theme, [mode]: { ...theme[mode], onAccent: '#eeeeee' } };
      assert.ok(
        themeWarnings([named]).some((warning) => warning.includes(`(${mode})`) && warning.includes('onAccent/accent contrast is 3.')),
        `${family} ${mode}`,
      );
    }
  }
});

test("a dark bar's search text is checked on its actual eight-percent navigation overlay", () => {
  {
    const base = THEME_PRESETS.find((theme) => theme.id === 'lumen')!;
    const theme = {
      ...base,
      recipes: { ...base.recipes, bar: 'dark' as const },
      label: 'Search overlay',
      light: { ...base.light, navGround: '#000000', navInk: '#ffffff', navMuted: '#757575' },
    };
    const warnings = themeWarnings([theme]);
    assert.ok(!warnings.some((warning) => /Search overlay.*light.*nav\.muted\/nav\.ground/.test(warning)));
    assert.ok(warnings.some((warning) => /Search overlay.*light.*nav\.muted\/navigation search/.test(warning)));
  }
});
