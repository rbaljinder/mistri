import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThemes, themeTypeWarnings } from '../packages/engine/src/shared/theme.js';
import { compileAppTheme } from '../packages/mistri/src/shared/themeSpec.js';
import { THEME_PRESETS, headingWeight, lookNavRole, themePreset } from '../packages/engine/src/shared/themePresets.js';
import { recipeAttributes, typeAttributes } from '../packages/engine/src/shared/themeRecipes.js';
import { typeTokens } from '../packages/engine/src/shared/themeType.js';
import { headingFace } from '../packages/engine/src/shared/themeFaces.js';
import { validationCode } from '../packages/mistri/src/server/build/checkProblems.js';
import { promiseOf } from '../packages/mistri/src/server/build/themeContract.js';

/**
 * TC3: a theme says how each kind of text is drawn — nine roles by what they are for, and a base size every size
 * grows with — where it had a title scale, a heading weight and three recipes (labels, headings, figures) that
 * each did a part of it. A role says only what differs from the look; one that says nothing turns no rule on, so a
 * theme without `type.roles` draws exactly as before.
 */
const theme = (type: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  compileAppTheme({ kind: 'theme', id: 'probe', label: 'Probe', extends: 'sage', type, ...extra }, 'theme');
const refuse = (type: Record<string, unknown>, pattern: RegExp) => assert.throws(() => theme(type), pattern);

test('the old type keys are refused, each naming where it went', () => {
  refuse({ scale: 'roomy' }, /theme\.type\.scale is now theme\.type\.roles\.title\.size: '22px', '26px', '28px' or '30px'/);
  refuse({ headingWeight: 700 }, /theme\.type\.headingWeight is now theme\.type\.roles\.title\.weight \(a list's heading takes it too/);
  assert.throws(
    () => theme({}, { recipes: { labels: 'mono-caps' } }),
    /theme\.recipes\.labels is now theme\.type\.roles\.label: \{ face: 'code', case: 'upper' \}/,
  );
  assert.throws(
    () => theme({}, { recipes: { headings: 'caps' } }),
    /theme\.recipes\.headings is now theme\.type\.roles\.section: \{ case: 'upper', size: '12px' \}/,
  );
  assert.throws(
    () => theme({}, { recipes: { figures: 'book' } }),
    /theme\.recipes\.figures is now theme\.type\.roles\.figure: .*features: \['lnum'\] \} for book/,
  );
  // A compiled theme stored before the break (a tenant's saved branding) is refused the same way.
  const colors = { surface: '#ffffff', ink: '#111111', accent: '#1d4ed8' };
  const stored = { id: 'old', label: 'Old', base: 'sage', light: colors, dark: colors };
  assert.throws(
    () => parseThemes([{ ...stored, scale: 'large' }], 'ui'),
    /ui\.themes\[0\]\.scale is now ui\.themes\[0\]\.type\.roles\.title\.size/,
  );
  assert.throws(
    () => parseThemes([{ ...stored, recipes: { figures: 'mono' } }], 'ui'),
    /ui\.themes\[0\]\.recipes\.figures is now ui\.themes\[0\]\.type\.roles\.figure/,
  );
});

test('each role takes only its properties, in its ranges', () => {
  refuse(
    { roles: { caption: {} } },
    /theme\.type\.roles has no "caption"\. The roles are: display, title, heading, section, body, label, data, figure, nav/,
  );
  // Body, label, data and nav text follow the base: a size of their own is refused, and says why.
  refuse(
    { roles: { body: { size: '15px' } } },
    /theme\.type\.roles\.body has no "size"\. It takes: leading, features\. Its size is the base/,
  );
  refuse({ roles: { nav: { size: '14px' } } }, /roles\.nav has no "size"/);
  refuse({ roles: { title: { size: '40px' } } }, /theme\.type\.roles\.title\.size must be a length from 20px to 36px/);
  refuse({ roles: { section: { size: '11px' } } }, /from 12px to 20px/);
  refuse({ roles: { figure: { size: '2rem' } } }, /from 18px to 40px/);
  refuse({ roles: { body: { leading: 1.2 } } }, /theme\.type\.roles\.body\.leading must be a number from 1\.35 to 1\.8/);
  refuse({ roles: { title: { tracking: '-0.05em' } } }, /tracking must be a length from -0\.03em to 0\.15em/);
  refuse({ roles: { nav: { weight: 700 } } }, /theme\.type\.roles\.nav\.weight must be one of 400, 500, 600/);
  refuse({ roles: { label: { weight: 800 } } }, /label\.weight must be one of 400, 500, 600, 700/);
  refuse({ roles: { label: { face: 'sans' } } }, /label\.face must be one of ui, heading, data, code/);
  refuse({ roles: { label: { case: 'italic' } } }, /label\.case must be one of none, upper, small-caps/);
  refuse(
    { roles: { data: { features: ['kern'] } } },
    /takes tnum, lnum, onum, zero, case, ss01 to ss20 and cv01 to cv99; "kern" is not one/,
  );
  refuse({ roles: { data: { features: ['tnum', 'tnum'] } } }, /features must be at most eight different features/);
  refuse({ base: '12px' }, /theme\.type\.base must be one of 13px, 14px, 15px, 16px/);
  refuse({ roles: { label: { face: 'code', italic: true } } }, /label has no "italic"/);
  // Renamed before 1.0: the monospace face is `code`, as a display rule and `fonts.code` say it.
  refuse({ roles: { label: { face: 'mono' } } }, /label\.face "mono" is now "code"/);
});

test('a role merges over the look’s, property by property', () => {
  const lumen = compileAppTheme(
    { kind: 'theme', id: 'tall', label: 'Tall', extends: 'lumen', type: { base: '15px', roles: { title: { size: '32px' } } } },
    'theme',
  );
  assert.deepEqual(lumen.type, {
    base: '15px',
    roles: {
      title: { size: '32px', weight: 600, tracking: '-0.02em' },
      heading: { size: '24px', tracking: '-0.018em' },
      section: { size: '16px', weight: 600, tracking: '-0.01em' },
    },
  });
  // The title's weight is every heading's, and the face a theme preloads is the one at that weight.
  assert.equal(headingWeight(theme({ roles: { title: { weight: 700 } } })), 700);
  assert.equal(headingWeight(themePreset('lumen')!), 600);
  const served = theme({ font: { heading: 'Workshop, serif' }, roles: { title: { weight: 600 } } }, {});
  assert.equal(
    headingFace({
      ...served,
      faces: [400, 600].map((w) => ({ family: 'Workshop', src: './w.woff2', weight: String(w), style: 'normal' as const, href: `w${w}` })),
    })?.weight,
    '600',
  );
});

test('a role is worn as tokens and one attribute naming what it says; a theme that says none sets none', () => {
  assert.deepEqual(typeTokens(undefined), {});
  assert.deepEqual(typeAttributes(undefined), {});
  const said = theme({
    base: '16px',
    roles: {
      title: { size: '30px', weight: 700, tracking: '-0.02em', case: 'small-caps' },
      label: { face: 'code', case: 'upper' },
      figure: { face: 'heading', weight: 600, features: ['lnum', 'ss01'] },
      data: { features: ['zero'] },
      nav: { face: 'heading' },
    },
  }).type;
  assert.deepEqual(typeTokens(said), {
    '--type-k': 'calc(16 / 13)',
    '--type-record-title': 'calc(30px * var(--type-k))',
    '--type-title-tracking': '-0.02em',
    // The theme's monospace: `fonts.code` when it names one, the platform's otherwise.
    '--type-label-font': 'var(--code)',
    // A figure's and a cell's figures stay tabular, whatever else they turn on.
    '--type-figure-font': 'var(--heading-font, var(--sans))',
    '--type-figure-weight': '600',
    '--type-figure-numeric': 'lining-nums tabular-nums',
    '--type-figure-features': '"ss01"',
    '--type-data-numeric': 'tabular-nums slashed-zero',
    '--type-nav-font': 'var(--heading-font, var(--sans))',
  });
  assert.deepEqual(typeAttributes(said), {
    // The title's weight is --heading-weight, which every heading reads: no rule of the role's draws it.
    'data-type-title': 'size tracking small-caps',
    'data-type-label': 'face upper',
    'data-type-data': 'numeric',
    'data-type-figure': 'face weight numeric features',
    'data-type-nav': 'face',
  });
  // The root carries them with the recipes; Sage's own title weight is no word.
  assert.equal(recipeAttributes(themePreset('sage')!).attributes['data-type-title'], undefined);
  assert.equal(recipeAttributes(themePreset('mono')!).attributes['data-type-label'], 'face upper');
  // A 13px base is the sheets' own: nothing to write.
  assert.equal(typeTokens({ base: '13px' })['--type-k'], undefined);
});

test('a weight past 700 in a face the theme does not ship is said (theme-type, C8)', () => {
  const heavy = theme({ font: { heading: 'Workshop, serif' }, roles: { title: { weight: 800 } } });
  const warnings = themeTypeWarnings([heavy]);
  assert.equal(warnings.length, 1);
  assert.match(
    warnings[0]!,
    /ui\.customThemes\[0\] \("probe"\) type\.roles\.title\.weight 800 is past 700 in a face the theme does not ship at that weight \(Workshop\)/,
  );
  assert.equal(validationCode(warnings[0]!), 'theme-type');
  assert.equal(promiseOf('theme-type'), 'C8');
  // Shipped at that weight, or a variable file whose range holds it, it is drawn as asked.
  const shipped = { ...heavy, faces: [{ family: 'Workshop', src: './w.woff2', weight: '100 900', style: 'normal' as const }] };
  assert.deepEqual(themeTypeWarnings([shipped]), []);
  assert.deepEqual(themeTypeWarnings(THEME_PRESETS), []);
});

test('the nav role reaches the menu wherever it is drawn: the bar’s entries and the side menu’s', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync(new URL('../packages/kit/src/client/themeFamilies.css', import.meta.url), 'utf8');
  for (const word of ['face', 'upper', 'small-caps', 'tracking', 'weight']) {
    assert.ok(new RegExp(`:root\\[data-type-nav~='${word}'\\] :is\\([^{]*\\.topbar \\.tn-item`).test(css), word);
    assert.ok(
      new RegExp(
        `:root\\[data-type-nav-side~='${word}'\\] :where\\(body\\.app-mode\\) \\.sidebar li:not\\(\\.nav-group\\) > :is\\(a, button\\)`,
      ).test(css),
      word,
    );
  }
});

test('a theme that sets the nav role dresses the side menu; a built-in look that sets it keeps the side menu as it was', () => {
  // Mono sets nav (mono capitals) itself: its bar wears it, its side menu has no attribute to answer.
  const mono = themePreset('mono')!;
  assert.ok(mono.type?.roles?.nav);
  const worn = recipeAttributes(mono, lookNavRole(mono)).attributes;
  assert.equal(worn['data-type-nav'], 'face upper');
  assert.equal(worn['data-type-nav-side'], undefined);
  // A theme extending it that restates the same role changes nothing down the side; one that sets its own does.
  const same = theme({ roles: { nav: { face: 'code', case: 'upper' } } }, { extends: 'mono' });
  assert.equal(recipeAttributes(same, lookNavRole(same)).attributes['data-type-nav-side'], undefined);
  const own = theme({ roles: { nav: { weight: 600, case: 'small-caps' } } }, { extends: 'mono' });
  assert.equal(recipeAttributes(own, lookNavRole(own)).attributes['data-type-nav-side'], 'weight small-caps');
  // A look without a nav role, extended by a theme that sets one.
  const sage = theme({ roles: { nav: { case: 'small-caps' } } });
  assert.equal(recipeAttributes(sage, lookNavRole(sage)).attributes['data-type-nav-side'], 'small-caps');
  // Every built-in look: no side attribute at all.
  for (const preset of THEME_PRESETS)
    assert.equal(recipeAttributes(preset, lookNavRole(preset)).attributes['data-type-nav-side'], undefined, preset.id);
});

test('the data role reaches every value, or only figures, keys and dates; a header’s facts are reached either way', async () => {
  refuse({ roles: { data: { reach: 'names' } } }, /theme\.type\.roles\.data\.reach must be values .* or figures/);
  refuse({ roles: { label: { reach: 'figures' } } }, /label has no "reach"/);
  const figures = theme({ font: { data: 'ui-monospace, monospace' }, roles: { data: { reach: 'figures' } } });
  assert.equal(figures.type?.roles?.data?.reach, 'figures');
  assert.equal(typeAttributes(figures.type)['data-type-data'], 'figures');
  // Omitted, or said as the default, it sets no word: every value is in the data face, as before.
  assert.equal(typeAttributes(theme({ roles: { data: { reach: 'values' } } }).type)['data-type-data'], undefined);
  const css = (await import('node:fs')).readFileSync('packages/kit/src/client/themeFamilies.css', 'utf8');
  assert.match(css, /\.app-mode \.page-head-facts :is\(\.num-value, \.date-value, \.id-value\) \{\s*font-family: var\(--mono\)/);
  assert.match(
    css,
    /html:root\[data-type-data~='figures'\] \.app-mode :is\(table, \.page-field > dd, \.ref-jump\) \{\s*font-family: var\(--sans\)/,
  );
  assert.match(
    css,
    /html:root\[data-type-data~='figures'\] \.app-mode :is\(td\.mono, \.num-value, \.date-value, \.id-value\) \{\s*font-family: var\(--mono\)/,
  );
});

test("a role's code face is the theme's own monospace: fonts.code reaches it, through the --code its stack sets", () => {
  const own = theme({ font: { code: "'Workshop Mono', monospace" }, roles: { label: { face: 'code' } } });
  assert.equal(own.fonts?.code, "'Workshop Mono', monospace");
  assert.equal(typeTokens(own.type)['--type-label-font'], 'var(--code)');
  // The Mono look's labels, nav and figures are the same face, so a theme extending it moves all three with one stack.
  const mono = themePreset('mono')!.type?.roles;
  assert.deepEqual([mono?.label?.face, mono?.nav?.face, mono?.figure?.face], ['code', 'code', 'code']);
});
