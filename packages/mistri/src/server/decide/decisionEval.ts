/**
 * How well a provider answers a decision, measured on records whose answer a
 * person already settled (design §6): what `mistri decide eval` reports and
 * pins on, and what `evaluateDecision` returns to an App's own tests.
 *
 * A stated probability is only worth applying on if it is honest, so the
 * report is about calibration as much as accuracy: a reliability table (the
 * probabilities said, bucketed, beside how often they were right), the
 * expected calibration error and the Brier score, and what the declared
 * thresholds would have done with these very answers — the share applied and
 * how often it was wrong, the share offered and how often it was right, and
 * the share left. A pin is earned only by the applied share's error.
 *
 * Nothing here reaches a database or keeps a value: the caller reads the
 * records, and only the answers and their probabilities are scored.
 */
import { readAnswer, type ReadAnswer } from './decisionAnswer.js';
import { sameAnswer } from './decideReads.js';
import {
  asProviderFailure,
  type DecisionAnswerType,
  type DecisionProvider,
  type ProviderFailure,
  type ProviderName,
} from './providers/decisionProvider.js';

/** The applied share's error a pin allows when the eval is not told otherwise (design §6: 2%). */
const DEFAULT_MAX_ERROR = 0.02;

/** One record asked about: what was said of it, and what a person settled. */
interface ScoredExample {
  readonly truth: unknown;
  /** The reply read against the field's type; absent when it was no answer of it. */
  readonly answer?: ReadAnswer;
}

export interface ReliabilityBucket {
  readonly from: number;
  readonly to: number;
  readonly n: number;
  readonly meanProbability: number;
  /** The share of the bucket that was right. */
  readonly correct: number;
  /** correct − meanProbability: below zero, the provider was surer than it was right. */
  readonly gap: number;
}

export interface DecisionEvaluation {
  readonly decision: string;
  readonly provider: ProviderName;
  readonly model: string;
  readonly modelVersion: string;
  readonly n: number;
  /** Replies that were an answer of the field's type. */
  readonly answered: number;
  readonly invalid: number;
  /** Right answers over every record asked. */
  readonly accuracy: number;
  /** Mean (p − right)² over the answered: 0 is perfect, 0.25 is a coin. */
  readonly brier: number;
  /** Expected calibration error over the buckets, weighted by their size. */
  readonly ece: number;
  readonly reliability: readonly ReliabilityBucket[];
  /** The commonest wrong answers: what was settled, what was said, how often. */
  readonly confusion: readonly Readonly<{ truth: string; answer: string; n: number }>[];
  readonly thresholds: Readonly<{
    apply?: number;
    suggest: number;
    applied: Readonly<{ n: number; share: number; errorRate: number }>;
    suggested: Readonly<{ n: number; share: number; accuracy: number }>;
    left: Readonly<{ n: number; share: number }>;
  }>;
  readonly maxError: number;
  /** Whether `--pin` would write: an apply threshold, something applied, and its error within `maxError`. */
  readonly pinnable: boolean;
  /** Why not, when it is not. */
  readonly why?: string;
  readonly units: number;
  readonly costMicros: number;
}

const EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1];
const round = (value: number, places = 4) => Math.round(value * 10 ** places) / 10 ** places;
const ratio = (part: number, whole: number) => (whole ? part / whole : 0);
const said = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value ?? null));

/** Score answers against what people settled, under a decision's thresholds. */
export function scoreDecision(
  decision: Readonly<{ name: string; apply?: number; suggest: number }>,
  examples: readonly ScoredExample[],
  meta: Readonly<{ provider: ProviderName; model: string; modelVersion: string; units: number; costMicros: number; maxError?: number }>,
): DecisionEvaluation {
  const n = examples.length;
  const answered = examples.filter((each) => each.answer);
  const right = (each: ScoredExample) => !!each.answer && sameAnswer(each.answer.answer, each.truth);
  const reliability: ReliabilityBucket[] = [];
  let ece = 0;
  for (let index = 0; index < EDGES.length - 1; index++) {
    const from = EDGES[index],
      to = EDGES[index + 1];
    const last = index === EDGES.length - 2;
    const inside = answered.filter(
      (each) => each.answer!.probability >= from && (last ? each.answer!.probability <= to : each.answer!.probability < to),
    );
    if (!inside.length) continue;
    const mean = inside.reduce((sum, each) => sum + each.answer!.probability, 0) / inside.length;
    const correct = ratio(inside.filter(right).length, inside.length);
    ece += (inside.length / answered.length) * Math.abs(correct - mean);
    reliability.push({ from, to, n: inside.length, meanProbability: round(mean), correct: round(correct), gap: round(correct - mean) });
  }
  const brier = answered.length
    ? answered.reduce((sum, each) => sum + (each.answer!.probability - (right(each) ? 1 : 0)) ** 2, 0) / answered.length
    : 0;
  const wrong = new Map<string, { truth: string; answer: string; n: number }>();
  for (const each of answered)
    if (!right(each)) {
      const pair = { truth: said(each.truth), answer: said(each.answer!.answer) };
      const key = JSON.stringify(pair);
      wrong.set(key, { ...pair, n: (wrong.get(key)?.n ?? 0) + 1 });
    }
  const applied = decision.apply === undefined ? [] : answered.filter((each) => each.answer!.probability >= decision.apply!);
  const suggested = answered.filter(
    (each) => each.answer!.probability >= decision.suggest && (decision.apply === undefined || each.answer!.probability < decision.apply),
  );
  const maxError = meta.maxError ?? DEFAULT_MAX_ERROR;
  const errorRate = ratio(applied.filter((each) => !right(each)).length, applied.length);
  const why =
    decision.apply === undefined
      ? 'the decision declares no apply threshold: it only suggests, and a pin would change nothing'
      : !applied.length
        ? `no answer reached apply (${decision.apply}): there is nothing to pin on`
        : errorRate > maxError
          ? `the applied share was wrong ${(errorRate * 100).toFixed(1)}% of the time, above the ${(maxError * 100).toFixed(1)}% allowed`
          : undefined;
  return {
    decision: decision.name,
    provider: meta.provider,
    model: meta.model,
    modelVersion: meta.modelVersion,
    n,
    answered: answered.length,
    invalid: n - answered.length,
    accuracy: round(ratio(examples.filter(right).length, n)),
    brier: round(brier),
    ece: round(ece),
    reliability,
    confusion: [...wrong.values()].sort((a, b) => b.n - a.n || a.truth.localeCompare(b.truth)).slice(0, 10),
    thresholds: {
      ...(decision.apply === undefined ? {} : { apply: decision.apply }),
      suggest: decision.suggest,
      applied: { n: applied.length, share: round(ratio(applied.length, n)), errorRate: round(errorRate) },
      suggested: {
        n: suggested.length,
        share: round(ratio(suggested.length, n)),
        accuracy: round(ratio(suggested.filter(right).length, suggested.length)),
      },
      left: { n: n - applied.length - suggested.length, share: round(ratio(n - applied.length - suggested.length, n)) },
    },
    maxError,
    pinnable: why === undefined,
    ...(why === undefined ? {} : { why }),
    units: meta.units,
    costMicros: meta.costMicros,
  };
}

/** One record to ask about: its inputs as they would be sent, its answer's type, and what a person settled. */
interface EvaluationItem {
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly answer: DecisionAnswerType;
  readonly truth: unknown;
}

/**
 * Ask a provider about every item and read each reply: one record an ask,
 * as the runtime asks about one record (an ask's id is its decision's name,
 * unique within a call), a few calls side by side. Stops asking once
 * `budgetMicros` is spent; a failed call leaves its record unanswered (scored
 * as no answer), except a refused key, which ends the run.
 */
export async function askEvaluation(
  provider: DecisionProvider,
  decision: Readonly<{ name: string; question: string; model?: string; deadlineMs: number }>,
  items: readonly EvaluationItem[],
  options: Readonly<{ budgetMicros?: number; concurrency?: number; signal?: AbortSignal }> = {},
): Promise<{ examples: ScoredExample[]; model: string; modelVersion: string; units: number; costMicros: number; stopped?: string }> {
  const examples: ScoredExample[] = Array.from({ length: items.length });
  let model = decision.model ?? '',
    modelVersion = '',
    units = 0,
    costMicros = 0,
    stopped: string | undefined,
    keyRefused: ProviderFailure | undefined,
    next = 0;
  const one = async (item: EvaluationItem): Promise<ScoredExample> => {
    const deadline = AbortSignal.timeout(decision.deadlineMs);
    try {
      const result = await provider.decide({
        ...(decision.model ? { model: decision.model } : {}),
        asks: [{ id: decision.name, question: decision.question, inputs: item.inputs, answer: item.answer }],
        signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline,
      });
      model = result.model;
      modelVersion = result.modelVersion;
      units += result.units;
      costMicros += result.costMicros;
      const reply = result.replies.find((each) => each.id === decision.name);
      const answer = reply ? readAnswer(item.answer, reply) : undefined;
      return { truth: item.truth, ...(answer ? { answer } : {}) };
    } catch (error) {
      const failure = asProviderFailure(error, deadline);
      if (failure.kind === 'key') keyRefused ??= failure;
      return { truth: item.truth };
    }
  };
  const worker = async () => {
    for (;;) {
      if (keyRefused || stopped) return;
      if (options.budgetMicros !== undefined && costMicros >= options.budgetMicros) {
        stopped = 'the spending limit was reached';
        return;
      }
      const index = next++;
      if (index >= items.length) return;
      examples[index] = await one(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 4, 8)) }, worker));
  if (keyRefused) throw keyRefused;
  const asked = examples.filter(Boolean);
  return { examples: asked, model, modelVersion, units, costMicros, ...(stopped ? { stopped } : {}) };
}

/** A conservative price for asking about these items, in millionths of a dollar. */
export function estimateMicros(
  provider: DecisionProvider,
  decision: Readonly<{ question: string; model?: string }>,
  items: readonly EvaluationItem[],
): number {
  return items.reduce(
    (sum, item) =>
      sum +
      (provider.estimateMicros?.(
        { id: 'estimate', question: decision.question, inputs: item.inputs, answer: item.answer },
        decision.model,
      ) ?? FALLBACK_MICROS),
    0,
  );
}
/** What one ask is taken to cost when its provider says no price: a tenth of a cent. */
const FALLBACK_MICROS = 1_000;

const percent = (value: number) => `${(value * 100).toFixed(1)}%`;
const dollars = (micros: number) => `$${(micros / 1e6).toFixed(micros < 10_000 ? 4 : 2)}`;

/** The report as a person reads it: the headline, the reliability table, the thresholds, and the pin's verdict. */
export function evaluationText(evaluation: DecisionEvaluation): string {
  const { thresholds: t } = evaluation;
  const lines = [
    `${evaluation.decision}: ${evaluation.n} records asked of ${evaluation.provider} (${evaluation.modelVersion || evaluation.model || 'no answer'})`,
    `accuracy ${percent(evaluation.accuracy)}, Brier ${evaluation.brier.toFixed(3)}, ECE ${evaluation.ece.toFixed(3)}, ${evaluation.invalid} not an answer`,
    '',
    'bucket       n    mean p   correct   gap',
    ...evaluation.reliability.map(
      (bucket) =>
        `${bucket.from.toFixed(2)}-${bucket.to.toFixed(2)}  ${String(bucket.n).padStart(5)}   ${bucket.meanProbability.toFixed(2)}     ${bucket.correct.toFixed(2)}     ${bucket.gap >= 0 ? '+' : ''}${bucket.gap.toFixed(2)}`,
    ),
    '',
    t.apply === undefined
      ? `applied: none (no apply threshold)`
      : `applied (p ≥ ${t.apply}): ${percent(t.applied.share)} of records, wrong ${percent(t.applied.errorRate)} of the time`,
    `suggested (p ≥ ${t.suggest}${t.apply === undefined ? '' : `, < ${t.apply}`}): ${percent(t.suggested.share)}, right ${percent(t.suggested.accuracy)}`,
    `left: ${percent(t.left.share)}`,
  ];
  if (evaluation.confusion.length)
    lines.push(
      '',
      'most common misses (settled → said):',
      ...evaluation.confusion.map((each) => `  ${each.truth} → ${each.answer}: ${each.n}`),
    );
  lines.push(
    '',
    `spent ${dollars(evaluation.costMicros)} (${evaluation.units} units)`,
    evaluation.pinnable
      ? `pinnable: --pin would trust ${evaluation.provider} ${evaluation.modelVersion} to apply.`
      : `not pinnable: ${evaluation.why}.`,
  );
  return lines.join('\n');
}
