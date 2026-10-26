/**
 * A chart's suggestion passes the check it answers. A field report: `check` said `chart[3]` and `chart[4]` were 6.6
 * apart where adjacent series need 8, and the field report said the chart it suggested in their place still kept a
 * pair too close. Each suggestion is the chart written into the theme's spec, compiled and checked again by the
 * check itself (themeCheck.ts chartPairFailure), on every palette and mode that wears it; where no order of the
 * series passes, a shade of one is moved along its hue, and where nothing passes, check says so.
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ThemeDefinition, ThemeSpec } from '../packages/engine/schema/theme.js';
import { compileAppTheme, themeExtends } from '../packages/mistri/src/shared/themeSpec.js';
import { authoredRoles, chartPairFailure, checkTheme, oklab, linear } from '../packages/mistri/src/shared/themeCheck.js';
import { checkThemeWithFixes, type FixedThemeProblem } from '../packages/mistri/src/shared/themeFix.js';
import { THEME_PRESETS, type AppAccent } from '../packages/engine/src/shared/themePresets.js';

const compile = (raw: unknown) => compileAppTheme(raw, 'ui.customThemes[0]', new Set(), { faces: false });
const LOOKS = [undefined, ...THEME_PRESETS.map((look) => look.id)];
/* Lumen's series with a green beside its orange that a protanope sees 6.6 apart: the report's pair, at its place. */
const REPORTED = ['#2557e0', '#9a6cf7', '#0e9a6c', '#d97706', '#008142', '#0e8fb0', '#a3510b', '#94a3b8'];
/* What a theme that extends nothing names; the rest is derived. */
const OWN = {
  light: { ground: '#f6f5f2', surface: '#ffffff', ink: '#16120e', accent: '#2d4fd6' },
  dark: { ground: '#121110', surface: '#161514', ink: '#eeece8', accent: '#8aa1ff' },
};

function at(raw: Record<string, any>, path: string, value: unknown) {
  const steps = [...path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
  let into = raw;
  steps.slice(0, -1).forEach((step, index) => (into = into[step] ??= typeof steps[index + 1] === 'number' ? [] : {}));
  into[steps.at(-1)!] = value;
}

/** Every chart suggestion, written into the spec alone as a person following it would, leaves the palettes and mode
    that showed the failure with no pair too close: by the check, run as `check` runs it. */
function followed(raw: Record<string, any>, theme: ThemeDefinition, problems: FixedThemeProblem[], own: { accent?: AppAccent }) {
  let suggested = 0;
  for (const problem of problems.filter((found) => found.fix && found.check.includes(' beside '))) {
    const written = structuredClone(raw);
    at(written, problem.fix!.path, problem.fix!.value);
    const again = compile(written);
    const left = checkTheme(again, { own, authored: authoredRoles(again, themeExtends(again) ?? undefined) }).filter(
      (found) =>
        found.check.includes(' beside ') &&
        problems.some((shown) => shown.at === problem.at && shown.paletteId === found.paletteId && shown.mode === found.mode),
    );
    assert.deepEqual(
      left.map((found) => found.message),
      [],
      `${theme.id}: ${problem.message}\nfollowed, it fails again`,
    );
    suggested++;
  }
  return suggested;
}

describe("a chart's suggestion passes the check it answers", () => {
  test('the shared measure says the reported pair as the check does', () => {
    const failed = chartPairFailure('#d97706', '#008142')!;
    assert.deepEqual([failed.vision, failed.distance.toFixed(1), failed.needs], ['protanopia', '6.6', 8]);
  });

  test("the report's chart, on every look and in light, dark and dark-only, with and without the App's accent", () => {
    let seen = 0;
    for (const look of LOOKS)
      for (const scheme of [undefined, 'dark', 'dark-only'] as const)
        for (const own of [{}, { accent: '#0f766e' }, { accent: { light: '#9d174d', dark: '#f9a8d4' } }] as { accent?: AppAccent }[]) {
          const mode = (name: 'light' | 'dark') => ({ ...(look ? {} : OWN[name]), chart: REPORTED });
          const raw = {
            id: 'report',
            label: 'Report',
            ...(look ? { extends: look } : {}),
            ...(scheme ? { scheme } : {}),
            colors: scheme === 'dark-only' ? { dark: mode('dark') } : { light: mode('light'), dark: mode('dark') },
          } as Record<string, any>;
          const theme = compile(raw as ThemeSpec);
          const problems = checkThemeWithFixes(theme, own);
          const reported = problems.filter((problem) =>
            /chart\[3\] beside chart\[4\] for protanopia are 6\.6 apart; adjacent series need 8\./.test(problem.message),
          );
          assert.ok(reported.length, `${look ?? 'none'} ${scheme ?? 'light'}: ${problems.map((problem) => problem.message).join('\n')}`);
          for (const problem of reported) assert.ok(problem.fix, problem.message);
          seen += followed(raw, theme, problems, own);
        }
    assert.ok(seen >= LOOKS.length * 3 * 3);
  });

  test('where no order passes, a shade of one series moves along its hue; where nothing passes, check says so', () => {
    /* Five near-identical blues in eight series: three others cannot part five, so no order keeps every neighbor
       apart and a reorder alone has nothing to suggest. */
    const ramp = ['#2557e0', '#2a5ce6', '#2052da', '#2b55e2', '#2858dd', '#d97706', '#0e9a6c', '#e0428a'];
    const raw = { id: 'ramp', label: 'Ramp', extends: 'lumen', colors: { light: { chart: ramp } } } as Record<string, any>;
    const theme = compile(raw as ThemeSpec);
    const problems = checkThemeWithFixes(theme);
    const chart = problems.filter((problem) => problem.check.includes(' beside '));
    assert.ok(chart.length);
    const fix = chart.find((problem) => problem.fix)?.fix;
    if (fix) {
      const value = fix.value as string[];
      assert.ok(
        value.some((hex) => !ramp.includes(hex)),
        'no order of the ramp passes, so the suggestion moves a shade',
      );
      /* Each moved shade keeps the ramp's hue family: within a few degrees of some step's. */
      const hue = (hex: string) => {
        const [, a, b] = oklab(linear(hex));
        return (Math.atan2(b, a) * 180) / Math.PI;
      };
      for (const hex of value.filter((hex) => !ramp.includes(hex)))
        assert.ok(
          ramp.some((step) => Math.abs(hue(step) - hue(hex)) < 6),
          `${hex} is of the ramp's hue`,
        );
      followed(raw, theme, problems, {});
    } else
      for (const problem of chart) assert.match(problem.message, /Neither another order of these series nor a lighter or darker shade/);
  });

  test('seeded palettes on every look, light and dark: a suggestion, once followed, finds no failing pair', () => {
    let seed = 20261016;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    const hex = () =>
      `#${[0, 0, 0]
        .map(() =>
          Math.floor(random() * 256)
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
    /* A palette with one series nudged toward its neighbor, as an author's near-duplicate is. */
    const palette = () => {
      const series = Array.from({ length: 5 + Math.floor(random() * 4) }, hex);
      const index = Math.floor(random() * (series.length - 1));
      series[index + 1] = `#${[1, 3, 5]
        .map((start) =>
          Math.max(0, Math.min(255, parseInt(series[index]!.slice(start, start + 2), 16) + Math.round((random() - 0.5) * 40)))
            .toString(16)
            .padStart(2, '0'),
        )
        .join('')}`;
      return series;
    };
    let suggested = 0;
    for (let round = 0; round < 8; round++)
      for (const look of LOOKS)
        for (const mode of ['light', 'dark'] as const) {
          const raw = {
            id: 'seeded',
            label: 'Seeded',
            ...(look ? { extends: look } : {}),
            colors: look ? { [mode]: { chart: palette() } } : { ...OWN, [mode]: { ...OWN[mode], chart: palette() } },
          } as Record<string, any>;
          const theme = compile(raw as ThemeSpec);
          suggested += followed(raw, theme, checkThemeWithFixes(theme), {});
        }
    assert.ok(suggested > 20, `${suggested} suggestions followed`);
  });
});
