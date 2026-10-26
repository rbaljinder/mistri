/**
 * What a theme's failures are fixed with: for a color that fails a contrast
 * check, the nearest color of the same hue that passes every check it takes
 * part in (lighter or darker, its chroma kept where sRGB allows); for chart
 * series too alike for a color-blind reader, an order of the same series
 * whose every neighbor is apart, or where none is, one shade moved until
 * one is. Each is a value to write at a path of the
 * theme as its author wrote it (`colors.light.accent`,
 * `palettes[1].dark.chart`), proved by compiling the spec again with it and
 * checking the result: a suggestion that would break another check is not
 * made. `mistri check` prints them, and `check --fix` writes them into the
 * App's source (build/checkFix.ts fixThemes).
 *
 * Only an App's own theme compiled by compileAppTheme has its spec at hand
 * (themeSpec.ts themeSpecOf); any other theme is checked without fixes.
 */
import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { contrastRatio, themeFindings } from '@mistriwork/engine/shared/theme.js';
import { authoredRoles, chartsApart, checkTheme, linear, oklab, type ThemeProblem } from './themeCheck.js';
import { effectiveThemeDefinition, effectiveThemePalette, withInks, type AppAccent } from '@mistriwork/engine/shared/themePresets.js';
import { colorPath, compileAppTheme, themeExtends, themeSpecOf } from './themeSpec.js';

/** A value to write into the theme's spec, at a path from the object `defineTheme` takes. */
export interface ThemeFix {
  /** `colors.light.accent`, `palettes[1].dark.status.critical`, `colors.dark.chart`. */
  path: string;
  /** A hex color, or the chart's series in their new order. */
  value: string | readonly string[];
  /** The suggestion as check says it: `accent: '#a63c08' (5.40:1)`. */
  said: string;
}

/** A theme's failure, with where in its spec the color judged is said (`at`, as ThemeFix.path) and its fix when one passes. */
export type FixedThemeProblem = ThemeProblem & { at: string; fix?: ThemeFix };

/* ---------- color: hex to OKLCH and back, in sRGB's gamut ---------- */

const HEX = /^#[0-9a-f]{6}$/i;

function oklch(hex: string): [number, number, number] {
  const [l, a, b] = oklab(linear(hex));
  return [l, Math.hypot(a, b), Math.atan2(b, a)];
}

/** OKLCH to linear sRGB; out of gamut when a channel leaves 0..1. */
function toLinear(l: number, c: number, h: number): [number, number, number] {
  const a = c * Math.cos(h),
    b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (rgb: readonly number[]) => rgb.every((value) => value >= -1e-6 && value <= 1 + 1e-6);

/** The color at this lightness, hue kept, chroma cut until it is one a screen shows. */
function atLightness(l: number, c: number, h: number): string {
  let chroma = c;
  if (!inGamut(toLinear(l, chroma, h))) {
    let low = 0,
      high = c;
    for (let i = 0; i < 20; i++) {
      const mid = (low + high) / 2;
      if (inGamut(toLinear(l, mid, h))) low = mid;
      else high = mid;
    }
    chroma = low;
  }
  return `#${toLinear(l, chroma, h)
    .map((value) => {
      const clamped = Math.min(1, Math.max(0, value));
      const gamma = clamped <= 0.0031308 ? 12.92 * clamped : 1.055 * clamped ** (1 / 2.4) - 0.055;
      return Math.round(gamma * 255)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

/* ---------- the spec, varied at one path ---------- */

type Step = string | number;
function steps(path: string): Step[] {
  return [...path.matchAll(/([A-Za-z_$][\w$]*)|\[(\d+)\]/g)].map((match) => (match[2] !== undefined ? Number(match[2]) : match[1]!));
}

/** A copy of the spec with `value` at `path`, every container on the way made; `fill` gives a chart's missing series. */
function varied(spec: unknown, path: string, value: unknown, fill: (index: number) => string | null): unknown {
  const copy = structuredClone(spec) as Record<string, unknown>;
  const walk = steps(path);
  let at: Record<string | number, unknown> = copy;
  walk.forEach((step, index) => {
    const last = index === walk.length - 1;
    if (last) {
      if (Array.isArray(at) && typeof step === 'number') while (at.length < step) at.push(fill(at.length));
      at[step] = value;
      return;
    }
    const next = walk[index + 1];
    if (at[step] === undefined || at[step] === null) at[step] = typeof next === 'number' ? [] : {};
    at = at[step] as Record<string | number, unknown>;
  });
  return copy;
}

/** Where a color of this palette and mode is written in the spec. */
function specPath(theme: ThemeDefinition, paletteId: string, mode: 'light' | 'dark', role: keyof ThemePalette): string {
  const inside =
    paletteId === 'default' ? `colors.${mode}` : `palettes[${theme.palettes!.findIndex((item) => item.id === paletteId)}].${mode}`;
  return `${inside}.${colorPath(role)}`;
}

const CHART_ROLES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `chart${n}` as keyof ThemePalette);

/* The roles an App's own `ui.theme.accent` is worn over: a theme's value for them is not what the page shows. */
const ACCENT_ROLES = new Set<string>(['accent', 'onAccent', 'accentInk', 'focus', 'link', 'accentSoft', 'chart1']);

/**
 * Every failure of an App's theme (themeCheck.ts checkTheme), each with the
 * fix it takes where one of its hue passes (`fix`), and its message saying
 * the color it measured and the fix to write.
 */
export function checkThemeWithFixes(theme: ThemeDefinition, own: { accent?: AppAccent } = {}): FixedThemeProblem[] {
  const base = themeExtends(theme) ?? undefined;
  const problems = checkTheme(theme, { own, authored: authoredRoles(theme, base) });
  if (!problems.length) return [];
  const spec = themeSpecOf(theme);
  /* One trial: the spec with one value changed, compiled and checked whole. Undefined where it does not compile. */
  const trials = new Map<string, { compiled: ThemeDefinition; problems: ThemeProblem[] } | undefined>();
  const trial = (path: string, value: unknown, fill: (index: number) => string | null) => {
    if (!spec) return undefined;
    const key = JSON.stringify([path, value]);
    if (trials.has(key)) return trials.get(key);
    let made: { compiled: ThemeDefinition; problems: ThemeProblem[] } | undefined;
    try {
      const compiled = compileAppTheme(varied(spec.raw, path, value, fill), spec.where, spec.taken, spec.options);
      made = { compiled, problems: checkTheme(compiled, { own, authored: authoredRoles(compiled, base) }) };
    } catch {
      made = undefined;
    }
    trials.set(key, made);
    return made;
  };
  const worn = (paletteId: string, mode: 'light' | 'dark') =>
    withInks(effectiveThemePalette(effectiveThemeDefinition(theme, paletteId)[mode], mode === 'dark', own) as ThemePalette);
  const fixes = new Map<string, ThemeFix | null>();
  /* A palette says only the colors it changes: one it leaves to the theme's own is fixed there, once, for both. */
  const owner = (paletteId: string, mode: 'light' | 'dark', roles: readonly (keyof ThemePalette)[]) => {
    const variant = theme.palettes?.find((item) => item.id === paletteId);
    return variant && roles.some((role) => variant[mode][role] !== undefined) ? paletteId : 'default';
  };
  /* The palettes that wear what `at` says for these roles: it, and those that leave them to it. */
  const wearers = (at: string, mode: 'light' | 'dark', roles: readonly (keyof ThemePalette)[]) =>
    new Set(
      at !== 'default'
        ? [at]
        : ['default', ...(theme.palettes ?? []).filter((item) => owner(item.id, mode, roles) === 'default').map((item) => item.id)],
    );
  const pathOf = (problem: ThemeProblem) =>
    problem.check.includes(' beside ')
      ? specPath(theme, owner(problem.paletteId, problem.mode, CHART_ROLES), problem.mode, 'chart1').replace(/\[0\]$/, '')
      : specPath(theme, owner(problem.paletteId, problem.mode, [problem.role]), problem.mode, problem.role);
  const keyOf = (problem: ThemeProblem) => {
    const chart = problem.check.includes(' beside ');
    const roles = chart ? CHART_ROLES : [problem.role];
    return `${owner(problem.paletteId, problem.mode, roles)} ${problem.mode} ${chart ? 'chart' : problem.role}`;
  };

  for (const problem of problems) {
    const key = keyOf(problem);
    if (fixes.has(key)) continue;
    const chart = problem.check.includes(' beside ');
    const roles = chart ? CHART_ROLES : [problem.role];
    const at = owner(problem.paletteId, problem.mode, roles);
    const affected = wearers(at, problem.mode, roles);
    const palette = worn(problem.paletteId, problem.mode);
    const series = CHART_ROLES.map((role) => palette[role]).filter((value): value is string => Boolean(value && HEX.test(value)));
    const fill = (index: number) => (at === 'default' ? (series[index] ?? null) : null);
    const ours = (found: ThemeProblem) =>
      affected.has(found.paletteId) &&
      found.mode === problem.mode &&
      (chart ? found.check.includes(' beside ') : found.role === problem.role);
    const before = problems.filter(ours).length;
    if (chart) {
      const path = specPath(theme, at, problem.mode, 'chart1').replace(/\[0\]$/, '');
      /* Proved by compiling the spec with it and running the check itself over every palette and mode that wears it:
         a suggestion that still leaves a pair too close is not made. */
      const order = chartSuggestion(series, (candidate) => {
        const tried = trial(path, candidate, () => null);
        return Boolean(tried && !tried.problems.some(ours) && tried.problems.length <= problems.length - before);
      });
      fixes.set(key, order ? { path, value: order, said: `chart: [${order.map((hex) => `'${hex}'`).join(', ')}]` } : null);
      continue;
    }
    const current = problem.written ?? palette[problem.role];
    if (!current || !HEX.test(current) || (own.accent && ACCENT_ROLES.has(problem.role))) {
      fixes.set(key, null);
      continue;
    }
    const path = specPath(theme, at, problem.mode, problem.role);
    const passes = (hex: string) => {
      const tried = trial(path, hex, fill);
      return tried && !tried.problems.some(ours) && tried.problems.length <= problems.length - before ? tried : undefined;
    };
    const hex = nearestOfHue(current, passes);
    if (!hex) {
      fixes.set(key, null);
      continue;
    }
    /* The ratio the failed check reaches with the fix, for the sentence: measured on the compiled trial. */
    const tried = passes(hex)!;
    const reached = themeFindings([tried.compiled], own, true).find(
      (found) =>
        found.paletteId === problem.paletteId &&
        found.mode === problem.mode &&
        /* A colour measured as written is the role's own pair once the fix is worn as written. */
        found.check === problem.check.replace(' as written', ''),
    );
    fixes.set(key, {
      path,
      value: hex,
      said: `${colorPath(problem.role)}: '${hex}'${reached ? ` (${reached.ratio.toFixed(2)}:1)` : ''}`,
    });
  }

  return problems.map((problem) => {
    const chart = problem.check.includes(' beside ');
    const fix = fixes.get(keyOf(problem));
    const hex = problem.written ?? worn(problem.paletteId, problem.mode)[problem.role];
    const measured = chart || !hex ? '' : ` (${problem.token} is ${hex})`;
    /* A link, ring, menu mark or first series written the same as the accent is worn as the accent's ink: the author
       may mean that, so the sentence says so beside the colour that reads as written. */
    const written = problem.written
      ? ` Written the same as the accent, it is drawn in the accent's ink instead: leave it out to wear that, or write one that reads.`
      : '';
    const then = fix
      ? `${written} Try ${fix.said}.`
      : chart
        ? ' Neither another order of these series nor a lighter or darker shade of one keeps every neighbor apart: replace the one named with a color of another hue.'
        : own.accent && ACCENT_ROLES.has(problem.role)
          ? " The App's ui.theme.accent is worn over this color: fix that accent."
          : ' No color of its hue passes every check it is in: pick another hue.';
    const at = pathOf(problem);
    /* The color by where it is written (`cadence.colors.light.lineControl`), so the line names what to change,
       not only what was measured: a palette's own color and one it leaves to the theme read differently. */
    const said = problem.message.replace(`), ${problem.token}: `, `), ${theme.id}.${at}: `);
    return {
      ...problem,
      at,
      ...(fix ? { fix } : {}),
      reason: `${problem.reason}${measured}`,
      message: `${said.replace(/\.$/, '')}${measured}.${then}`,
    };
  });
}

/**
 * The nearest color of `hex`'s hue that `passes`, by lightness: each way in
 * coarse steps to the first that passes, then halved down to the edge between
 * failing and passing, and the nearer of the two ways. A color that passes is
 * assumed to stay passing further the same way, which holds for contrast
 * against fixed grounds; a trial proves the one returned whatever happens.
 */
function nearestOfHue(hex: string, passes: (hex: string) => unknown): string | undefined {
  const [l, c, h] = oklch(hex);
  const found: Array<{ hex: string; distance: number }> = [];
  for (const direction of [-1, 1]) {
    let failing = l;
    let passing: number | undefined;
    for (let step = 1; step <= 34; step++) {
      const at = Math.min(1, Math.max(0, l + direction * step * 0.03));
      if (passes(atLightness(at, c, h))) {
        passing = at;
        break;
      }
      failing = at;
      if (at === 0 || at === 1) break;
    }
    if (passing === undefined) continue;
    let edge: number = passing;
    for (let i = 0; i < 7; i++) {
      const mid: number = (failing + edge) / 2;
      if (passes(atLightness(mid, c, h))) edge = mid;
      else failing = mid;
    }
    found.push({ hex: atLightness(edge, c, h), distance: Math.abs(edge - l) });
  }
  return found.sort((a, b) => a.distance - b.distance)[0]?.hex;
}

/** The nearest color of `hex`'s hue that reads at `need` on `ground`: what grade's matrix says a theme's token should be. */
export function passingOnGround(hex: string, ground: string, need: number): string | undefined {
  return nearestOfHue(hex, (candidate) => contrastRatio(candidate, ground) >= need);
}

/**
 * The chart to suggest for series too alike, proved whole by `passes`: the same
 * series in another order where one passes, else, round by round, the series
 * too close to the most others (the later of equals: the first is often the
 * brand's) moved to the nearest lightness of its hue that stands apart from
 * every other, and an order of those tried again. Undefined when no round
 * passes: then check says so rather than suggest a chart that fails it again.
 */
function chartSuggestion(series: readonly string[], passes: (order: string[]) => boolean): string[] | undefined {
  let current = [...series];
  for (let round = 0; round < series.length; round++) {
    const order = chartOrder(current, series, passes);
    if (order) return order;
    const close = current.map((hex, index) => current.filter((other, at) => at !== index && !chartsApart(hex, other)).length);
    const most = Math.max(...close);
    if (most === 0) return undefined;
    const index = close.lastIndexOf(most);
    const others = current.filter((_, at) => at !== index);
    const shade = nearestOfHue(current[index]!, (candidate) => others.every((other) => chartsApart(candidate, other)));
    if (!shade) return undefined;
    current = current.with(index, shade);
  }
  return undefined;
}

/**
 * An order of `series` in which every neighbor stays apart for every reader
 * (themeCheck.ts chartsApart), as near the written one as can be: each place
 * tries the series in their written order first, and the chart as `written`
 * is not one to suggest. `passes` proves a whole order (a chart's first four
 * also meet 3:1 on the card). At most a few hundred orders are tried; past
 * that there is none worth suggesting.
 */
function chartOrder(series: readonly string[], written: readonly string[], passes: (order: string[]) => boolean): string[] | undefined {
  if (series.length < 2) return undefined;
  let tried = 0;
  const order: string[] = [];
  const used = new Set<number>();
  const place = (): string[] | undefined => {
    if (order.length === series.length) {
      if (order.every((hex, index) => hex === written[index]) || ++tried > 300) return undefined;
      return passes(order) ? [...order] : undefined;
    }
    for (let index = 0; index < series.length; index++) {
      if (used.has(index) || tried > 300) continue;
      const previous = order.at(-1);
      if (previous && !chartsApart(previous, series[index]!)) continue;
      used.add(index);
      order.push(series[index]!);
      const done = place();
      order.pop();
      used.delete(index);
      if (done) return done;
    }
    return undefined;
  };
  return place();
}

/** What the theme's spec says at a fix's path, as its author wrote it: undefined where it inherits it, or for a theme without its spec. */
export function writtenAt(theme: ThemeDefinition, path: string): unknown {
  let at: unknown = themeSpecOf(theme)?.raw;
  for (const step of steps(path)) {
    if (at === null || typeof at !== 'object') return undefined;
    at = (at as Record<string | number, unknown>)[step];
  }
  return at;
}
