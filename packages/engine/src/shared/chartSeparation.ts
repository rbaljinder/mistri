/**
 * Chart series apart for color-blind readers: the one measure `mistri check` holds an App's chart to
 * (themeCheck.ts) and the built-in looks order their series by under each palette (lookPalettes.ts).
 */
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

export function linear(hex: string): [number, number, number] {
  return [1, 3, 5].map((start) => {
    const value = parseInt(hex.slice(start, start + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
}
export function oklab([r, g, b]: readonly number[]): [number, number, number] {
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
