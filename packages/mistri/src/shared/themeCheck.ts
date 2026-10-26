/**
 * The one validator a theme meets, wherever it comes from: `mistri check`
 * and `build` run it over an App's `defineTheme` themes, startup over its
 * accent on the looks it offers, and a tenant's branding save over the theme
 * that tenant would wear (tenantBranding.ts). It adds to the contrast checks
 * (theme.ts) the chart's color-blind separation, and says each failure by the
 * color's own name in the spec (`status.critical`, `chart[2]`).
 */
import type { ThemeDefinition, ThemePalette } from '@mistriwork/engine/schema/theme.js';
import { rolePairs, themeFindings, type ThemeFinding } from '@mistriwork/engine/shared/theme.js';
import {
  effectiveThemeDefinition,
  effectiveThemePalette,
  themeModes,
  withInks,
  type AppAccent,
} from '@mistriwork/engine/shared/themePresets.js';
import { COLOR_ROLES } from './themeBuild.js';
import { colorPath, themeSpecOf } from './themeSpec.js';

const ROLES = new Set<string>(COLOR_ROLES.map(([, role]) => role));

/* ---------- chart series apart for color-blind readers ---------- */

/** Machado, Oliveira and Fernandes (2009) at full severity, in linear sRGB: the
    two red-green deficiencies, about one man in twelve between them. Tritanopia
    is rare enough (about 1 in 10,000) that it is not held against a palette. */
const DEFICIENCIES = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
} as const;
/** Adjacent series, in OKLab ΔE ×100: at least 8 under each deficiency, and 10 to normal vision. */
const CHART_SEPARATION = { deficient: 8, normal: 10 } as const;

function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
function oklab([r, g, b]: readonly number[]): [number, number, number] {
  const l = Math.cbrt(0.4122214708 * r! + 0.5363325363 * g! + 0.0514459929 * b!),
    m = Math.cbrt(0.2119034982 * r! + 0.6806995451 * g! + 0.1073969566 * b!),
    s = Math.cbrt(0.0883024619 * r! + 0.2817188376 * g! + 0.6299787005 * b!);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function simulate(color: readonly number[], matrix: readonly (readonly number[])[]): number[] {
  return matrix.map((row) => Math.min(1, Math.max(0, row[0]! * color[0]! + row[1]! * color[1]! + row[2]! * color[2]!)));
}
/** OKLab distance ×100 between two hex colors, as seen with the deficiency named or with normal vision. */
function chartDistance(a: string, b: string, deficiency?: keyof typeof DEFICIENCIES): number {
  const see = (hex: string) => oklab(deficiency ? simulate(linear(hex), DEFICIENCIES[deficiency]) : linear(hex));
  const x = see(a),
    y = see(b);
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

export { oklab, linear };

/** The first reader two series are too alike for, how far apart they are to them and what they need; undefined when
    every reader tells them apart. The one measure: the check says it, and a suggested chart is proved by it. */
export function chartPairFailure(a: string, b: string): { vision: string; distance: number; needs: number } | undefined {
  const tests: Array<[string, number, number]> = [
    ['normal vision', chartDistance(a, b), CHART_SEPARATION.normal],
    ...(Object.keys(DEFICIENCIES) as (keyof typeof DEFICIENCIES)[]).map(
      (kind) => [kind, chartDistance(a, b, kind), CHART_SEPARATION.deficient] as [string, number, number],
    ),
  ];
  const failed = tests.find(([, distance, needs]) => distance < needs);
  return failed && { vision: failed[0], distance: failed[1], needs: failed[2] };
}

/** Whether two series stay apart for every reader the chart check holds a palette to. */
export function chartsApart(a: string, b: string): boolean {
  return !chartPairFailure(a, b);
}

const HEX = /^#[0-9a-f]{6}$/i;
const SERIES = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => `chart${n}` as keyof ThemePalette);

/** Each adjacent pair of series one of `authored` names (a built-in's own pairs are its own). */
function chartFindings(
  theme: ThemeDefinition,
  own: { accent?: AppAccent },
  authored: (paletteId: string, mode: 'light' | 'dark', role: keyof ThemePalette) => boolean,
): ThemeFinding[] {
  const findings: ThemeFinding[] = [];
  for (const paletteId of ['default', ...(theme.palettes ?? []).map((item) => item.id)])
    for (const mode of themeModes(theme)) {
      const palette = effectiveThemePalette(effectiveThemeDefinition(theme, paletteId)[mode], mode === 'dark', own);
      const name =
        paletteId === 'default' ? theme.label : `${theme.label} / ${theme.palettes!.find((item) => item.id === paletteId)!.label}`;
      for (let index = 0; index < SERIES.length - 1; index++) {
        const left = SERIES[index]!,
          right = SERIES[index + 1]!;
        const a = palette[left],
          b = palette[right];
        if (!a || !b || !HEX.test(a) || !HEX.test(b)) continue;
        if (!authored(paletteId, mode, left) && !authored(paletteId, mode, right)) continue;
        const token = authored(paletteId, mode, right) ? right : left;
        const failed = chartPairFailure(a, b);
        if (!failed) continue;
        const { vision, distance, needs } = failed;
        findings.push({
          themeId: theme.id,
          paletteId,
          mode,
          token,
          check: `${left} beside ${right} for ${vision}`,
          ratio: distance,
          needs,
          message: `Theme "${name}" (${mode}): ${colorPath(left)} and ${colorPath(right)} are ${distance.toFixed(1)} apart for ${vision}; adjacent chart series need ${needs}.`,
        });
      }
    }
  return findings;
}

/* ---------- the colours an author wrote, as written ---------- */

/** A colour measured as the author wrote it, and what the page wears in its place. */
type WrittenFinding = ThemeFinding & { written?: string; wornAs?: string };

/** The inks a page wears as the accent's text ink when they are written the same as the accent (themePresets.ts
    effectiveThemePalette): a link, the ring, the menu's current mark, the first series. */
const FOLLOWERS = ['link', 'focus', 'navAccent', 'chart1'] as const;

/**
 * An ink the author wrote that the page does not wear as written — a link, a ring, a menu mark or a first series
 * written the same as the accent is drawn in the accent's text ink instead — held to its role's pairs as written:
 * a value in the spec is one the reader sees or one check refuses, never one dropped in silence. A link written as an
 * amber accent read 2.0:1 and passed (T-3). Only a theme whose spec is at hand (compileAppTheme) is read; an App's
 * own `ui.theme.accent` replaces these on purpose and is checked as the accent.
 */
function writtenFindings(theme: ThemeDefinition, own: { accent?: AppAccent }): WrittenFinding[] {
  const raw = themeSpecOf(theme)?.raw as
    | { colors?: Record<string, unknown>; palettes?: ReadonlyArray<Record<string, unknown>> }
    | undefined;
  if (!raw || own.accent) return [];
  const findings: WrittenFinding[] = [];
  const darkOnly = theme.scheme === 'dark-only';
  for (const [index, paletteId] of ['default', ...(theme.palettes ?? []).map((item) => item.id)].entries())
    for (const mode of themeModes(theme)) {
      const source = (index === 0 ? raw.colors : raw.palettes?.[index - 1])?.[darkOnly ? 'dark' : mode] as
        | Record<string, unknown>
        | undefined;
      if (!source) continue;
      const worn = withInks(effectiveThemePalette(effectiveThemeDefinition(theme, paletteId)[mode], mode === 'dark', own) as ThemePalette);
      const name = index === 0 ? theme.label : `${theme.label} / ${theme.palettes![index - 1]!.label}`;
      for (const role of FOLLOWERS) {
        const path = colorPath(role);
        const group = /^(\w+)\.(\w+)$/.exec(path);
        const said =
          role === 'chart1'
            ? (source.chart as unknown[] | undefined)?.[0]
            : group
              ? (source[group[1]!] as Record<string, unknown> | undefined)?.[group[2]!]
              : source[role];
        if (typeof said !== 'string' || !HEX.test(said.trim()) || said.trim().toLowerCase() === worn[role]?.toLowerCase()) continue;
        const written = said.trim().toLowerCase();
        for (const pair of rolePairs(worn, role, written)) {
          if (pair.ratio >= pair.needs) continue;
          findings.push({
            themeId: theme.id,
            paletteId,
            mode,
            token: role,
            check: `${role} as written on ${pair.background}${pair.what ? ` (${pair.what})` : ''}`,
            ratio: pair.ratio,
            needs: pair.needs,
            written,
            wornAs: worn[role],
            message: `Theme "${name}" (${mode}): ${path} as written is ${written}, ${pair.ratio.toFixed(2)}:1 on ${colorPath(pair.background)}; it needs ${pair.needs}:1.`,
          });
        }
      }
    }
  return findings;
}

/* ---------- the validator ---------- */

export interface ThemeProblem {
  themeId: string;
  paletteId: string;
  mode: 'light' | 'dark';
  /** The color by its name in the spec: `accent`, `status.critical`, `chart[2]`, `nav.muted`. */
  token: string;
  /** The same color by its role (`accent`, `negative`, `chart3`, `navMuted`): what themeFix.ts varies. */
  role: keyof ThemePalette;
  /** What was measured, by roles: `accent/accentSoft over surface`, `chart2 beside chart3 for deuteranopia`. */
  check: string;
  ratio: number;
  needs: number;
  /** What failed, said by the check: "accent on surface 3.10:1, needs 4.5:1". */
  reason: string;
  /** The colour as the author wrote it, where the page wears another in its place (a link written as the accent). */
  written?: string;
  /** The whole sentence, naming theme, mode, token and reason. */
  message: string;
}

/**
 * Every failure of a theme: contrast of text and controls in light and dark
 * and every palette, and its chart's color-blind separation. `authored` says
 * which colors the author set, so a series kept from a built-in is not held
 * against the author; omitted, every color is the author's.
 */
export function checkTheme(
  theme: ThemeDefinition,
  options: {
    own?: { accent?: AppAccent };
    authored?: (paletteId: string, mode: 'light' | 'dark', role: keyof ThemePalette) => boolean;
  } = {},
): ThemeProblem[] {
  const own = options.own ?? {};
  const authored = options.authored ?? (() => true);
  const all: WrittenFinding[] = [...themeFindings([theme], own), ...chartFindings(theme, own, authored), ...writtenFindings(theme, own)];
  return all.map((finding) => {
    const name =
      finding.paletteId === 'default'
        ? theme.label
        : `${theme.label} / ${theme.palettes!.find((item) => item.id === finding.paletteId)!.label}`;
    const check = finding.check.replace(/\b[a-z][a-zA-Z0-9]*\b/g, (word) => (ROLES.has(word) ? colorPath(word) : word));
    const reason = check.includes(' for ')
      ? `${check} are ${finding.ratio.toFixed(1)} apart; adjacent series need ${finding.needs}`
      : `${check} is ${finding.ratio.toFixed(2)}:1; it needs ${finding.needs}:1`;
    return {
      themeId: finding.themeId,
      paletteId: finding.paletteId,
      mode: finding.mode,
      token: colorPath(finding.token),
      role: finding.token,
      check: finding.check,
      ratio: finding.ratio,
      needs: finding.needs,
      reason,
      ...(finding.written ? { written: finding.written } : {}),
      message: `Theme "${name}" (${finding.mode}), ${colorPath(finding.token)}: ${reason}.`,
    };
  });
}

/** The roles a compiled theme takes from its author rather than the built-in it extends. */
export function authoredRoles(theme: ThemeDefinition, base: ThemeDefinition | undefined) {
  return (paletteId: string, mode: 'light' | 'dark', role: keyof ThemePalette): boolean => {
    if (!base) return true;
    const ours = effectiveThemeDefinition(theme, paletteId)[mode][role];
    const theirs = effectiveThemeDefinition(base, base.palettes?.some((item) => item.id === paletteId) ? paletteId : 'default')[mode][role];
    return ours !== theirs;
  };
}
