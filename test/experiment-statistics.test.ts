import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  computeExperimentStatistics,
  ExperimentStatisticsError,
  holmAdjustedPValues,
  newcombeDifferenceInterval,
  sampleRatioMismatch,
  wilson95Interval,
  type ExperimentStatisticsInput,
  type Interval,
} from '../packages/mistri/src/server/experiments/statistics.js';

function close(actual: number, expected: number, tolerance = 2e-12): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
}
function interval(actual: Interval | null, lower: number, upper: number): void {
  assert.ok(actual);
  close(actual.lower, lower);
  close(actual.upper, upper);
}
function fixture(overrides: Partial<ExperimentStatisticsInput> = {}): ExperimentStatisticsInput {
  return {
    epochId: 'scope/copy/v1',
    evidenceRevision: 1,
    control: 'control',
    startsAtMs: 1000,
    endsAtMs: 2000,
    conversionWindowMs: 100,
    deliveryGraceMs: 50,
    nowMs: 2150,
    completeness: { pending: 0, failed: 0, incomplete: 0 },
    guardrails: [],
    arms: [
      { id: 'control', weight: 50, exposed: 100, mature: 100, immature: 0, primary: 40, guardrails: [] },
      { id: 'treatment', weight: 50, exposed: 100, mature: 100, immature: 0, primary: 60, guardrails: [] },
    ],
    ...overrides,
  };
}

// Independent 60-decimal mpmath 1.4.1 reference calculations, not this module:
// z = sqrt(2)*erfinv(1-.05/family); Wilson score quadratic roots;
// Newcombe 1998 method 10 combines Wilson limits by root-sum-of-squares;
// SRM/score tails = gammainc(df/2, statistic/2, inf, regularized=True).
test('Wilson 95% independent fixtures: empty, all failures/successes, tiny and large cohorts', () => {
  assert.equal(wilson95Interval({ converted: 0, total: 0 }), null);
  for (const [converted, total, lower, upper] of [
    [0, 1, 0, 0.7934506856227627],
    [1, 1, 0.2065493143772374, 1],
    [1, 2, 0.09453120573423071, 0.9054687942657693],
    [0, 10, 0, 0.27753279986288926],
    [5, 10, 0.23659309051256397, 0.7634069094874361],
    [1, 10, 0.017876213095072903, 0.4041500267952385],
    [60, 100, 0.5020025867910618, 0.6905987135675411],
    [500000000, 1000000000, 0.4999690102484443, 0.5000309897515557],
  ])
    interval(wilson95Interval({ converted, total }), lower, upper);
});

test('Newcombe absolute treatment-minus-control reference fixtures and multiplicity', () => {
  for (const [x, n, y, m, family, lower, upper] of [
    [60, 100, 40, 100, 1, 0.061410729162439254, 0.32812592946077196],
    [60, 100, 40, 100, 3, 0.030850268073847796, 0.3538182885019879],
    [1, 10, 0, 10, 1, -0.18942835274958883, 0.4041500267952385],
    [0, 10, 0, 10, 1, -0.27753279986288926, 0.27753279986288926],
    [200, 1000, 100, 1000, 4, 0.0603815378211361, 0.13960736008431787],
    [900000000, 1000000000, 890000000, 1000000000, 1, 0.009973133493833016, 0.010026866542093709],
  ]) {
    interval(newcombeDifferenceInterval({ converted: x, total: n }, { converted: y, total: m }, family), lower, upper);
    interval(newcombeDifferenceInterval({ converted: y, total: m }, { converted: x, total: n }, family), -upper, -lower);
  }
  assert.equal(newcombeDifferenceInterval({ converted: 0, total: 0 }, { converted: 1, total: 1 }), null);
});

test('Pearson SRM uses declared percentages, independent upper-tail fixtures through df=15', () => {
  const fixtures = [
    { observed: [60, 40], weights: [50, 50], statistic: 4, p: 0.04550026389635842 },
    { observed: [600, 400], weights: [50, 50], statistic: 40, p: 2.539628589470865e-10 },
    { observed: [10, 20, 30], weights: [20, 30, 50], statistic: 0.5555555555555556, p: 0.7574651283969664 },
    { observed: [25, 25, 25, 25], weights: [10, 20, 30, 40], statistic: 30.208333333333332, p: 1.2475836952105901e-6 },
    {
      observed: [...Array<number>(15).fill(10), 30],
      weights: Array<number>(16).fill(6.25),
      statistic: 33.333333333333336,
      p: 0.004219953574199692,
    },
  ];
  for (const entry of fixtures) {
    const result = sampleRatioMismatch(entry.observed.map((exposed, i) => ({ exposed, weight: entry.weights[i] })));
    assert.equal(result.degreesOfFreedom, entry.observed.length - 1);
    close(result.statistic!, entry.statistic);
    close(result.pValue! / entry.p, 1, 1e-11);
    assert.equal(result.status, entry.p < 0.001 ? 'mismatch' : 'clear');
  }
  for (const [a, status] of [
    [552, 'clear'],
    [553, 'mismatch'],
  ] as const) {
    assert.equal(
      sampleRatioMismatch([
        { exposed: a, weight: 50 },
        { exposed: 1000 - a, weight: 50 },
      ]).status,
      status,
    );
  }
});

test('SRM insufficient expected counts never pass; zero allocation remains diagnostic', () => {
  const small = sampleRatioMismatch([
    { exposed: 9, weight: 50 },
    { exposed: 0, weight: 50 },
  ]);
  assert.equal(small.status, 'insufficient');
  assert.equal(small.pValue, null);
  assert.equal(small.statistic, null);
  assert.deepEqual(small.observed, [9, 0]);
  assert.deepEqual(small.expected, [4.5, 4.5]);
  assert.equal(
    sampleRatioMismatch([
      { exposed: 5, weight: 50 },
      { exposed: 5, weight: 50 },
    ]).status,
    'clear',
  );
  assert.equal(
    sampleRatioMismatch([
      { exposed: 0, weight: 50 },
      { exposed: 0, weight: 50 },
    ]).status,
    'insufficient',
  );
  assert.equal(
    sampleRatioMismatch([
      { exposed: 999, weight: 99.9 },
      { exposed: 1, weight: 0.1 },
    ]).status,
    'insufficient',
  );
  const zero = sampleRatioMismatch([
    { exposed: 10, weight: 50 },
    { exposed: 0, weight: 0 },
    { exposed: 10, weight: 50 },
  ]);
  assert.equal(zero.degreesOfFreedom, 1);
  assert.equal(zero.pValue, 1);
  assert.deepEqual(zero.expected, [10, 0, 10]);
  assert.equal(
    sampleRatioMismatch([
      { exposed: 100, weight: 100 },
      { exposed: 0, weight: 0 },
    ]).status,
    'insufficient',
  );
  assert.equal(
    sampleRatioMismatch([
      { exposed: 1000000000, weight: 50 },
      { exposed: 0, weight: 50 },
    ]).pValue,
    0,
  );
});

test('Holm hand-computed step-down fixtures preserve order, monotonicity and ties', () => {
  const adjusted = holmAdjustedPValues([0.04, 0.01, 0.03, 0.002]);
  [0.06, 0.03, 0.06, 0.008].forEach((value, i) => close(adjusted[i], value));
  assert.deepEqual(holmAdjustedPValues([1, 0, 0.5]), [1, 0, 1]);
  assert.deepEqual(holmAdjustedPValues([0.01, 0.01, 0.01]), [0.03, 0.03, 0.03]);
});

test('fixed horizon includes delivery grace; earlier inspection exposes no significance or p-values', () => {
  for (const nowMs of [1000, 2000, 2100, 2149]) {
    const result = computeExperimentStatistics(fixture({ nowMs }));
    assert.equal(result.status, 'descriptive');
    assert.equal(result.finalized, false);
    assert.ok(result.comparisons[0].adjustedInterval);
    assert.equal(result.comparisons[0].significance, 'descriptive');
    assert.equal(result.comparisons[0].pValue, null);
    assert.equal(result.comparisons[0].holmAdjustedPValue, null);
    assert.ok(result.blockers.includes('fixed-horizon'));
  }
  const final = computeExperimentStatistics(fixture());
  assert.equal(final.finalizesAtMs, 2150);
  assert.equal(final.status, 'final-evidence');
  assert.equal(final.comparisons[0].significance, 'positive');
  close(final.comparisons[0].pValue!, 0.004677734981047266);
  assert.equal(final.decisionAuthorization, 'not-evaluated');
  assert.equal(final.methods.sequential, false);
  assert.equal('winner' in final, false);
});

test('immature units remain outside estimates but inside SRM; delivery incompleteness blocks finalization', () => {
  const input = fixture();
  const result = computeExperimentStatistics(fixture({ arms: input.arms.map((arm) => ({ ...arm, exposed: 120, immature: 20 })) }));
  assert.equal(result.mature, 200);
  assert.equal(result.immature, 40);
  assert.equal(result.status, 'descriptive');
  assert.equal(result.arms[0].primary.rate, 0.4);
  assert.deepEqual(result.srm.observed, [120, 120]);
  assert.ok(result.blockers.includes('immature-cohorts'));
  for (const field of ['pending', 'failed', 'incomplete'] as const) {
    const incomplete = computeExperimentStatistics(fixture({ completeness: { pending: 0, failed: 0, incomplete: 0, [field]: 1 } }));
    assert.equal(incomplete.finalized, false);
    assert.ok(incomplete.blockers.includes('incomplete-delivery'));
    assert.equal(incomplete.comparisons[0].significance, 'descriptive');
  }
});

test('multiple arms lose nominal significance and retain missing comparisons in the family', () => {
  const input = fixture({
    arms: ['control', 'a', 'b', 'c'].map((id) => ({
      id,
      weight: 25,
      exposed: 100,
      mature: 100,
      immature: 0,
      primary: id === 'control' ? 40 : 55,
      guardrails: [],
    })),
  });
  assert.ok(newcombeDifferenceInterval({ converted: 55, total: 100 }, { converted: 40, total: 100 })!.lower > 0);
  const result = computeExperimentStatistics(input);
  assert.equal(result.methods.familySize, 3);
  assert.equal(result.methods.intervalAdjustment, 'Bonferroni');
  assert.equal(result.methods.pValueAdjustment, 'Holm');
  assert.ok(result.comparisons.every((item) => item.significance === 'not-established' && item.holmAdjustedPValue! > 0.05));
  assert.ok(result.comparisons.every((item) => item.adjustedInterval!.lower < 0));
  const missing = computeExperimentStatistics({
    ...input,
    arms: input.arms.map((arm) => (arm.id === 'a' ? { ...arm, primary: null } : arm)),
  });
  assert.equal(missing.methods.familySize, 3);
  assert.equal(missing.status, 'descriptive');
  assert.equal(missing.complete, false);
  assert.equal(missing.finalized, false);
  assert.ok(missing.blockers.includes('missing-metric-data'));
  assert.equal(missing.comparisons[0].significance, 'descriptive');
  assert.deepEqual(missing.comparisons[1].adjustedInterval, result.comparisons[1].adjustedInterval);
});

test('guardrail requires strict adjusted bounds, includes its multiplicity slot, never passes provisionally', () => {
  const base = fixture();
  const input = fixture({
    guardrails: [{ id: 'adverse', maxIncrease: 0.1 }],
    arms: base.arms.map((arm) => ({ ...arm, exposed: 1000, mature: 1000, guardrails: [arm.id === 'control' ? 10 : 200] })),
  });
  const result = computeExperimentStatistics(input);
  assert.equal(result.methods.familySize, 2);
  assert.equal(result.comparisons[1].guardrail, 'breached');
  assert.equal(result.status, 'final-blocked');
  const bounds = result.comparisons[1].adjustedInterval!;
  for (const [maxIncrease, expected] of [
    [bounds.upper + 0.001, 'safe'],
    [bounds.upper, 'inconclusive'],
    [bounds.lower, 'inconclusive'],
    [bounds.lower - 0.001, 'breached'],
  ] as const) {
    const final = computeExperimentStatistics({ ...input, guardrails: [{ id: 'adverse', maxIncrease }] });
    assert.equal(final.comparisons[1].guardrail, expected);
    const provisional = computeExperimentStatistics({ ...input, nowMs: 2149, guardrails: [{ id: 'adverse', maxIncrease }] });
    assert.equal(provisional.comparisons[1].guardrail, 'descriptive');
  }
  const missing = computeExperimentStatistics({ ...input, arms: input.arms.map((arm) => ({ ...arm, guardrails: [null] })) });
  assert.equal(missing.comparisons[1].guardrail, 'descriptive');
  assert.equal(missing.status, 'descriptive');
  assert.equal(missing.complete, false);
});

test('SRM and empty/zero-allocation control block decision evidence', () => {
  const input = fixture();
  const mismatch = computeExperimentStatistics({
    ...input,
    arms: input.arms.map((arm, i) => ({ ...arm, exposed: i ? 100 : 900, mature: i ? 100 : 900 })),
  });
  assert.equal(mismatch.status, 'final-blocked');
  assert.ok(mismatch.blockers.includes('srm-mismatch'));
  assert.equal(mismatch.comparisons[0].significance, 'descriptive');
  assert.equal(mismatch.comparisons[0].pValue, null);
  for (const exposed of [
    [900, 100],
    [4, 4],
  ]) {
    const blocked = computeExperimentStatistics({
      ...input,
      guardrails: [{ id: 'adverse', maxIncrease: 0.9 }],
      arms: input.arms.map((arm, i) => ({ ...arm, exposed: exposed[i], mature: exposed[i], primary: i ? exposed[i] : 0, guardrails: [0] })),
    });
    assert.notEqual(blocked.srm.status, 'clear');
    assert.ok(
      blocked.comparisons.every((item) => item.significance === 'descriptive' && item.pValue === null && item.holmAdjustedPValue === null),
    );
    assert.equal(blocked.comparisons[1].guardrail, 'descriptive');
  }
  const empty = computeExperimentStatistics({ ...input, arms: input.arms.map((arm) => ({ ...arm, exposed: 0, mature: 0, primary: 0 })) });
  assert.equal(empty.status, 'final-blocked');
  assert.equal(empty.arms[0].primary.rate, null);
  assert.ok(empty.blockers.includes('srm-insufficient'));
  assert.equal(empty.comparisons[0].significance, 'insufficient');
  const zeroControl = computeExperimentStatistics({
    ...input,
    arms: input.arms.map((arm, i) => ({ ...arm, weight: i ? 100 : 0, exposed: i ? 100 : 0, mature: i ? 100 : 0, primary: i ? 60 : 0 })),
  });
  assert.equal(zeroControl.status, 'final-blocked');
  assert.ok(zeroControl.blockers.includes('insufficient-metric-data'));
});

test('bounded maximum arm/guardrail family; input untouched and returned evidence detached/frozen', () => {
  const input = fixture({
    guardrails: Array.from({ length: 16 }, (_, i) => ({ id: `g${i}`, maxIncrease: 0.5 })),
    arms: Array.from({ length: 16 }, (_, i) => ({
      id: i ? `arm${i}` : 'control',
      weight: 6.25,
      exposed: 100,
      mature: 100,
      immature: 0,
      primary: 50,
      guardrails: Array<number>(16).fill(0),
    })),
  });
  const before = JSON.stringify(input),
    result = computeExperimentStatistics(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(result.methods.familySize, 255);
  assert.equal(result.comparisons.length, 255);
  assert.equal(result.srm.degreesOfFreedom, 15);
  assert.equal(result.status, 'final-evidence');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.arms[0].primary.interval95));
  assert.ok(Object.isFrozen(result.comparisons[0]));
  assert.ok(Object.isFrozen(result.srm.expected));
  assert.notEqual(result.guardrails, input.guardrails);
  assert.notEqual(result.completeness, input.completeness);
  const revision = computeExperimentStatistics({ ...input, evidenceRevision: 2 });
  assert.equal(result.evidenceRevision, 1);
  assert.equal(revision.evidenceRevision, 2);
});

test('invalid counts, nonfinite arithmetic, allocation and overflow fail closed', () => {
  for (const value of [-1, 0.5, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => wilson95Interval({ converted: value, total: 100 }), ExperimentStatisticsError);
    assert.throws(() => wilson95Interval({ converted: 0, total: value }), ExperimentStatisticsError);
  }
  assert.throws(() => wilson95Interval({ converted: 2, total: 1 }), ExperimentStatisticsError);
  for (const values of [[NaN], [Infinity], [-0.1], [1.1], [], Array<number>(256).fill(0.5)]) {
    assert.throws(() => holmAdjustedPValues(values), ExperimentStatisticsError);
  }
  for (const family of [0, -1, 1.5, NaN, Infinity, 256]) {
    assert.throws(
      () => newcombeDifferenceInterval({ converted: 0, total: 1 }, { converted: 0, total: 1 }, family),
      ExperimentStatisticsError,
    );
  }
  for (const arms of [
    [],
    [{ weight: 100, exposed: 10 }],
    Array(17).fill({ weight: 100 / 17, exposed: 10 }),
    [
      { weight: 49, exposed: 10 },
      { weight: 50, exposed: 10 },
    ],
    [
      { weight: NaN, exposed: 10 },
      { weight: 50, exposed: 10 },
    ],
    [
      { weight: 100, exposed: 10 },
      { weight: 0, exposed: 1 },
    ],
    [
      { weight: 50, exposed: Number.MAX_SAFE_INTEGER },
      { weight: 50, exposed: 1 },
    ],
  ]) {
    assert.throws(() => sampleRatioMismatch(arms), ExperimentStatisticsError);
  }
  const input = fixture();
  const invalid: unknown[] = [
    null,
    {},
    { ...input, control: 'absent' },
    { ...input, evidenceRevision: 0 },
    { ...input, endsAtMs: 1000 },
    { ...input, conversionWindowMs: 0 },
    { ...input, nowMs: NaN },
    { ...input, endsAtMs: Number.MAX_SAFE_INTEGER },
    { ...input, completeness: { pending: -1, failed: 0, incomplete: 0 } },
    { ...input, guardrails: Array(17).fill({ id: 'g', maxIncrease: 0.1 }) },
    ...[NaN, Infinity, -0.01, 1.01].map((maxIncrease) => ({ ...input, guardrails: [{ id: 'g', maxIncrease }] })),
    ...[{ id: 'control' }, { mature: 99 }, { primary: 101 }, { primary: undefined }, { immature: 0.5 }, { guardrails: [0] }].map(
      (change) => ({ ...input, arms: [input.arms[0], { ...input.arms[1], ...change }] }),
    ),
  ];
  for (const value of invalid)
    assert.throws(() => computeExperimentStatistics(value as ExperimentStatisticsInput), ExperimentStatisticsError);
});
