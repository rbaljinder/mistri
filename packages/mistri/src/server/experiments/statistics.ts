/** Pure AN2 evidence over already deduplicated, epoch-scoped binary unit counts.
 * The ingestion owner must establish first exposure, attribution, maturity and
 * delivery completeness. This module neither verifies those facts nor grants
 * `decide` authority. Milliseconds are explicit; no wall clock is read here.
 */
export const EXPERIMENT_STATISTICS_LIMITS = Object.freeze({ arms: 16, guardrails: 16 });
const ALPHA = 0.05;
const SRM_ALPHA = 0.001;

interface BinaryCounts {
  readonly converted: number;
  readonly total: number;
}
export interface Interval {
  readonly lower: number;
  readonly upper: number;
}
export interface ExperimentStatisticsInput {
  readonly epochId: string;
  readonly evidenceRevision: number;
  readonly control: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly conversionWindowMs: number;
  readonly deliveryGraceMs: number;
  readonly nowMs: number;
  /** Explicit ingestion accounting, not inferred from elapsed time. */
  readonly completeness: { readonly pending: number; readonly failed: number; readonly incomplete: number };
  readonly guardrails: readonly { readonly id: string; readonly maxIncrease: number }[];
  readonly arms: readonly {
    readonly id: string;
    /** Frozen declared percentages, covering every arm and summing exactly to 100. */
    readonly weight: number;
    readonly exposed: number;
    readonly mature: number;
    readonly immature: number;
    /** Only mature units; null means missing metric data, never zero conversions. */
    readonly primary: number | null;
    readonly guardrails: readonly (number | null)[];
  }[];
}

export class ExperimentStatisticsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExperimentStatisticsError';
  }
}
function requireValid(condition: boolean, message: string): asserts condition {
  if (!condition) throw new ExperimentStatisticsError(message);
}
function count(value: number): void {
  requireValid(Number.isSafeInteger(value) && value >= 0, 'Counts/times must be nonnegative safe integers.');
}
function sum(values: readonly number[]): number {
  let result = 0;
  for (const value of values) {
    count(value);
    result += value;
    count(result);
  }
  return result;
}
function binary(value: BinaryCounts): void {
  requireValid(value !== null && typeof value === 'object', 'Expected binary counts.');
  count(value.total);
  count(value.converted);
  requireValid(value.converted <= value.total, 'Conversions exceed mature units.');
}
function probability(value: number): number {
  requireValid(Number.isFinite(value), 'Nonfinite numerical result.');
  return Math.max(0, Math.min(1, value));
}

/** Regularized upper incomplete gamma Q(df/2, x/2). Degrees of freedom are
 * bounded integers (1..15). Series / Lentz continued fraction, at most 256
 * iterations, fail closed on nonconvergence. Direct upper tail avoids 1-CDF
 * cancellation in significant tails. No external numerical dependency.
 */
function chiSquareTail(statistic: number, df: number): number {
  requireValid(
    Number.isFinite(statistic) && statistic >= 0 && Number.isInteger(df) && df >= 1 && df <= 15,
    'Invalid chi-square parameters.',
  );
  if (statistic === 0) return 1;
  const a = df / 2,
    x = statistic / 2;
  let logGamma = df % 2 ? Math.log(Math.PI) / 2 : 0;
  for (let v = df % 2 ? 0.5 : 1; v < a; v++) logGamma += Math.log(v);
  const scale = Math.exp(a * Math.log(x) - x - logGamma);
  if (x < a + 1) {
    let term = 1 / a,
      series = term;
    for (let i = 1; i <= 256; i++) {
      term *= x / (a + i);
      series += term;
      if (Math.abs(term) <= Math.abs(series) * 1e-14) return probability(1 - scale * series);
    }
  } else {
    const tiny = 1e-300;
    let b = x + 1 - a,
      c = 1 / tiny,
      d = 1 / b,
      h = d;
    for (let i = 1; i <= 256; i++) {
      const an = -i * (i - a);
      b += 2;
      d = an * d + b;
      if (Math.abs(d) < tiny) d = tiny;
      c = b + an / c;
      if (Math.abs(c) < tiny) c = tiny;
      d = 1 / d;
      const delta = d * c;
      h *= delta;
      if (Math.abs(delta - 1) <= 1e-14) return probability(scale * h);
    }
  }
  throw new ExperimentStatisticsError('Chi-square tail did not converge.');
}
function criticalValue(familySize: number): number {
  // A two-sided normal tail equals the chi-square(1) survival at z².
  let low = 0,
    high = 12;
  for (let i = 0; i < 60; i++) {
    const middle = (low + high) / 2;
    if (chiSquareTail(middle * middle, 1) > ALPHA / familySize) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}
function wilson(counts: BinaryCounts, z: number): Interval | null {
  if (counts.total === 0) return null;
  const n = counts.total,
    p = counts.converted / n,
    z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denominator;
  const radius = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
  return Object.freeze({
    lower: counts.converted === 0 ? 0 : probability(center - radius),
    upper: counts.converted === n ? 1 : probability(center + radius),
  });
}
export function wilson95Interval(counts: BinaryCounts): Interval | null {
  binary(counts);
  return wilson(counts, criticalValue(1));
}
function newcombe(treatment: BinaryCounts, control: BinaryCounts, z: number): Interval | null {
  const t = wilson(treatment, z),
    c = wilson(control, z);
  if (!t || !c) return null;
  const pt = treatment.converted / treatment.total,
    pc = control.converted / control.total,
    difference = pt - pc;
  return Object.freeze({
    lower: Math.max(-1, difference - Math.hypot(pt - t.lower, c.upper - pc)),
    upper: Math.min(1, difference + Math.hypot(t.upper - pt, pc - c.lower)),
  });
}
/** Newcombe (1998), method 10, no continuity correction. */
export function newcombeDifferenceInterval(treatment: BinaryCounts, control: BinaryCounts, familySize = 1): Interval | null {
  binary(treatment);
  binary(control);
  requireValid(Number.isInteger(familySize) && familySize >= 1 && familySize <= 255, 'Invalid comparison family size.');
  return newcombe(treatment, control, criticalValue(familySize));
}
/** Supplemental Holm step-down adjustment. Intervals use Bonferroni, not Holm. */
export function holmAdjustedPValues(values: readonly number[]): readonly number[] {
  requireValid(Array.isArray(values) && values.length >= 1 && values.length <= 255, 'Invalid p-value family.');
  for (const value of values) requireValid(Number.isFinite(value) && value >= 0 && value <= 1, 'Invalid p-value.');
  const order = values.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = Array<number>(values.length).fill(1);
  let previous = 0;
  order.forEach(({ p, index }, rank) => {
    previous = Math.max(previous, Math.min(1, (values.length - rank) * p));
    adjusted[index] = previous;
  });
  return Object.freeze(adjusted);
}
interface SampleRatioResult {
  readonly status: 'clear' | 'mismatch' | 'insufficient';
  readonly observed: readonly number[];
  readonly expected: readonly number[];
  readonly degreesOfFreedom: number;
  readonly statistic: number | null;
  readonly pValue: number | null;
}
export function sampleRatioMismatch(arms: readonly { readonly weight: number; readonly exposed: number }[]): SampleRatioResult {
  requireValid(Array.isArray(arms) && arms.length >= 2 && arms.length <= 16, 'Expected 2..16 arms.');
  let weightTotal = 0;
  for (const arm of arms) {
    requireValid(arm !== null && typeof arm === 'object', 'Invalid arm.');
    count(arm.exposed);
    requireValid(Number.isFinite(arm.weight) && arm.weight >= 0 && arm.weight <= 100, 'Invalid allocation weight.');
    weightTotal += arm.weight;
  }
  requireValid(weightTotal === 100, 'Declared allocation must sum exactly to 100.');
  const total = sum(arms.map((arm) => arm.exposed));
  const expected = Object.freeze(arms.map((arm) => total * (arm.weight / 100)));
  const observed = Object.freeze(arms.map((arm) => arm.exposed));
  const degreesOfFreedom = arms.filter((arm) => arm.weight > 0).length - 1;
  const base = { observed, expected, degreesOfFreedom };
  // Observations in an impossible arm are invalid evidence, not a chi-square result.
  requireValid(!arms.some((arm) => arm.weight === 0 && arm.exposed > 0), 'Exposure in a zero-allocation arm.');
  if (degreesOfFreedom < 1 || expected.some((n, i) => arms[i].weight > 0 && n < 5)) {
    return Object.freeze({ ...base, status: 'insufficient', statistic: null, pValue: null });
  }
  let statistic = 0;
  arms.forEach((arm, i) => {
    if (arm.weight > 0) statistic += (arm.exposed - expected[i]) ** 2 / expected[i];
  });
  const pValue = chiSquareTail(statistic, degreesOfFreedom);
  return Object.freeze({ ...base, status: pValue < SRM_ALPHA ? 'mismatch' : 'clear', statistic, pValue });
}
function scoreP(treatment: BinaryCounts, control: BinaryCounts): number | null {
  if (!treatment.total || !control.total) return null;
  const n = sum([treatment.total, control.total]);
  const p = sum([treatment.converted, control.converted]) / n;
  if (p === 0 || p === 1) return 1;
  const difference = treatment.converted / treatment.total - control.converted / control.total;
  return chiSquareTail(difference ** 2 / (p * (1 - p) * (1 / treatment.total + 1 / control.total)), 1);
}
interface MetricEvidence {
  readonly converted: number | null;
  readonly total: number;
  readonly rate: number | null;
  readonly interval95: Interval | null;
}
interface ComparisonEvidence {
  readonly arm: string;
  readonly metric: string;
  readonly difference: number | null;
  readonly adjustedInterval: Interval | null;
  /** Null before finalization: repeated inspection is not a sequential test. */
  readonly pValue: number | null;
  readonly holmAdjustedPValue: number | null;
  readonly significance: 'descriptive' | 'insufficient' | 'positive' | 'negative' | 'not-established';
  readonly guardrail: 'descriptive' | 'safe' | 'breached' | 'inconclusive' | null;
}

/** One conservative family includes every positive-allocation treatment versus
 * control, across primary AND all declared guardrails. Missing outcomes retain
 * their family slot (p=1 for Holm); they cannot shrink the multiplicity penalty.
 * No sample-size/power threshold was approved: availability is n>0 per metric,
 * with the separate SRM expected-count floor. No automatic winner is selected.
 */
export function computeExperimentStatistics(input: ExperimentStatisticsInput) {
  requireValid(input !== null && typeof input === 'object', 'Expected evidence input.');
  requireValid(typeof input.epochId === 'string' && input.epochId.length > 0 && input.epochId.length <= 512, 'Invalid epoch identity.');
  count(input.evidenceRevision);
  requireValid(input.evidenceRevision > 0, 'Evidence revision must be positive.');
  for (const time of [input.startsAtMs, input.endsAtMs, input.nowMs, input.conversionWindowMs, input.deliveryGraceMs]) count(time);
  requireValid(input.startsAtMs < input.endsAtMs && input.conversionWindowMs > 0, 'Invalid fixed horizon.');
  const finalizesAtMs = sum([input.endsAtMs, input.conversionWindowMs, input.deliveryGraceMs]);
  requireValid(input.completeness !== null && typeof input.completeness === 'object', 'Missing completeness accounting.');
  const outstanding = sum([input.completeness.pending, input.completeness.failed, input.completeness.incomplete]);
  requireValid(Array.isArray(input.guardrails) && input.guardrails.length <= 16, 'Too many guardrails.');
  const metricIds = new Set(['primary']);
  for (const metric of input.guardrails) {
    requireValid(
      metric !== null &&
        typeof metric === 'object' &&
        typeof metric.id === 'string' &&
        metric.id.length > 0 &&
        metric.id.length <= 128 &&
        !metricIds.has(metric.id),
      'Invalid/duplicate metric ID.',
    );
    metricIds.add(metric.id);
    requireValid(Number.isFinite(metric.maxIncrease) && metric.maxIncrease >= 0 && metric.maxIncrease <= 1, 'Invalid guardrail increase.');
  }
  const srm = sampleRatioMismatch(input.arms);
  const ids = new Set<string>();
  for (const arm of input.arms) {
    requireValid(typeof arm.id === 'string' && arm.id.length > 0 && arm.id.length <= 128 && !ids.has(arm.id), 'Invalid/duplicate arm ID.');
    ids.add(arm.id);
    requireValid(sum([arm.mature, arm.immature]) === arm.exposed, 'Cohorts must partition unique exposures.');
    requireValid(Array.isArray(arm.guardrails) && arm.guardrails.length === input.guardrails.length, 'Missing guardrail slots.');
    for (const converted of [arm.primary, ...arm.guardrails]) if (converted !== null) binary({ converted, total: arm.mature });
  }
  const control = input.arms.find((arm) => arm.id === input.control);
  requireValid(control !== undefined, 'Declared control is absent.');
  const treatments = input.arms.filter((arm) => arm.id !== input.control && arm.weight > 0);
  const familySize = treatments.length * (1 + input.guardrails.length);
  const z95 = criticalValue(1),
    adjustedZ = criticalValue(Math.max(1, familySize));
  const describe = (converted: number | null, total: number): MetricEvidence =>
    Object.freeze({
      converted,
      total,
      rate: converted !== null && total > 0 ? converted / total : null,
      interval95: converted === null ? null : wilson({ converted, total }, z95),
    });
  const arms = Object.freeze(
    input.arms.map((arm) =>
      Object.freeze({
        id: arm.id,
        weight: arm.weight,
        exposed: arm.exposed,
        mature: arm.mature,
        immature: arm.immature,
        primary: describe(arm.primary, arm.mature),
        guardrails: Object.freeze(arm.guardrails.map((converted) => describe(converted, arm.mature))),
      }),
    ),
  );
  const mature = sum(input.arms.map((arm) => arm.mature)),
    immature = sum(input.arms.map((arm) => arm.immature));
  const metricsComplete = input.arms.every(
    (arm) => arm.weight === 0 || (arm.primary !== null && arm.guardrails.every((value) => value !== null)),
  );
  const complete = outstanding === 0 && immature === 0 && metricsComplete;
  const finalized = input.nowMs >= finalizesAtMs && complete;
  const inferential = finalized && srm.status === 'clear';
  const raw = treatments.flatMap((arm) =>
    [arm.primary, ...arm.guardrails].map((converted, index) => {
      const baseline = [control.primary, ...control.guardrails][index];
      const treatmentCounts = converted === null ? null : { converted, total: arm.mature };
      const controlCounts = baseline === null ? null : { converted: baseline, total: control.mature };
      const available = treatmentCounts !== null && controlCounts !== null && arm.mature > 0 && control.mature > 0;
      return {
        arm: arm.id,
        metric: index === 0 ? 'primary' : input.guardrails[index - 1].id,
        threshold: index === 0 ? null : input.guardrails[index - 1].maxIncrease,
        difference: available ? converted! / arm.mature - baseline! / control.mature : null,
        adjustedInterval: available ? newcombe(treatmentCounts, controlCounts, adjustedZ) : null,
        p: available ? scoreP(treatmentCounts, controlCounts) : null,
      };
    }),
  );
  const adjusted = raw.length ? holmAdjustedPValues(raw.map((item) => item.p ?? 1)) : [];
  const comparisons: readonly ComparisonEvidence[] = Object.freeze(
    raw.map((item, index) => {
      const interval = item.adjustedInterval;
      return Object.freeze({
        arm: item.arm,
        metric: item.metric,
        difference: item.difference,
        adjustedInterval: interval,
        pValue: inferential ? item.p : null,
        holmAdjustedPValue: inferential && item.p !== null ? adjusted[index] : null,
        significance: !finalized
          ? 'descriptive'
          : !interval
            ? 'insufficient'
            : !inferential
              ? 'descriptive'
              : interval.lower > 0 && adjusted[index] <= ALPHA
                ? 'positive'
                : interval.upper < 0 && adjusted[index] <= ALPHA
                  ? 'negative'
                  : 'not-established',
        guardrail:
          item.threshold === null
            ? null
            : !inferential
              ? 'descriptive'
              : !interval
                ? 'inconclusive'
                : interval.upper < item.threshold
                  ? 'safe'
                  : interval.lower > item.threshold
                    ? 'breached'
                    : 'inconclusive',
      });
    }),
  );
  const blockers: string[] = [];
  if (input.nowMs < finalizesAtMs) blockers.push('fixed-horizon');
  if (immature > 0) blockers.push('immature-cohorts');
  if (outstanding > 0) blockers.push('incomplete-delivery');
  if (!metricsComplete) blockers.push('missing-metric-data');
  if (srm.status !== 'clear') blockers.push(`srm-${srm.status}`);
  if (!familySize || control.weight === 0 || raw.some((item) => item.adjustedInterval === null)) blockers.push('insufficient-metric-data');
  if (comparisons.some((item) => item.guardrail !== null && item.guardrail !== 'safe')) blockers.push('guardrails-not-satisfied');
  return Object.freeze({
    epochId: input.epochId,
    evidenceRevision: input.evidenceRevision,
    control: input.control,
    horizon: Object.freeze({
      startsAtMs: input.startsAtMs,
      endsAtMs: input.endsAtMs,
      conversionWindowMs: input.conversionWindowMs,
      deliveryGraceMs: input.deliveryGraceMs,
      nowMs: input.nowMs,
    }),
    guardrails: Object.freeze(input.guardrails.map((metric) => Object.freeze({ id: metric.id, maxIncrease: metric.maxIncrease }))),
    finalizesAtMs,
    mature,
    immature,
    complete,
    finalized,
    status: !finalized ? ('descriptive' as const) : blockers.length ? ('final-blocked' as const) : ('final-evidence' as const),
    decisionAuthorization: 'not-evaluated' as const,
    blockers: Object.freeze(blockers),
    completeness: Object.freeze({
      pending: input.completeness.pending,
      failed: input.completeness.failed,
      incomplete: input.completeness.incomplete,
    }),
    methods: Object.freeze({
      rate: 'Wilson 95%',
      difference: 'Newcombe method 10 (no continuity correction)',
      intervalAdjustment: 'Bonferroni',
      pValue: 'two-sided pooled two-proportion score',
      pValueAdjustment: 'Holm',
      family: 'all positive-allocation treatment-control comparisons across primary and all guardrails',
      familySize,
      familyAlpha: ALPHA,
      comparisonConfidence: 1 - ALPHA / Math.max(1, familySize),
      srm: 'Pearson chi-square; expected counts >= 5',
      srmAlpha: SRM_ALPHA,
      sequential: false,
    }),
    arms,
    comparisons,
    srm,
  });
}
