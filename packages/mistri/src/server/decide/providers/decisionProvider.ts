/**
 * What a decision asks a model, and what it answers: one small interface
 * every provider sits behind (Claude, Jev, the scripted double), so the
 * runtime never knows which one it reached.
 *
 * A call carries one or more asks — the decisions one trigger raises on one
 * record — and a provider that `batches` takes them in one request; one that
 * does not is asked once per ask, side by side. Each ask names its answer's
 * type the way the answer command's input field declares it (a choice's
 * options, a number's range, the keys a reference may name), so a provider can
 * constrain what it says; the runtime still reads every answer again with the
 * command field's own rules (decisionAnswer.ts) and treats anything outside
 * them as no answer at all.
 *
 * A provider says nothing about how it got there: no reasoning is asked for,
 * kept or shown. What is kept is the answer, its probability, the model and
 * version the provider reports, and what the call cost.
 */

/** The answer's type, from the answer command's input field. */
export type DecisionAnswerType =
  | Readonly<{ kind: 'choice'; options: readonly Readonly<{ value: string | number; label: string }>[] }>
  | Readonly<{ kind: 'number'; min?: number; max?: number; integer?: boolean; step?: number }>
  | Readonly<{ kind: 'bool' }>
  /** One key of these choices, read as the decision's principal (at most 200). */
  | Readonly<{ kind: 'reference'; choices: readonly Readonly<{ key: string | number; label: string }>[] }>
  /** Several keys of these choices, at most `max`; a probability for each. */
  | Readonly<{ kind: 'references'; choices: readonly Readonly<{ key: string | number; label: string }>[]; max: number }>;

export interface DecisionAsk {
  /** The decision's name: unique within a call. */
  readonly id: string;
  readonly question: string;
  /** The record's inputs as sent, by field name: plain JSON values, never a hidden or redacted column. */
  readonly inputs: Readonly<Record<string, unknown>>;
  readonly answer: DecisionAnswerType;
}

interface DecisionCall {
  /** The model the declaration names; absent, the provider's default. */
  readonly model?: string;
  readonly asks: readonly DecisionAsk[];
  readonly signal: AbortSignal;
}

/** One ask's answer as the provider said it: not yet read against the field. */
export interface DecisionReply {
  readonly id: string;
  readonly answer: unknown;
  /** One probability, or one per key for a list of references. */
  readonly probability: unknown;
}

export interface DecisionResult {
  readonly replies: readonly DecisionReply[];
  /** The model asked, and the version the provider reported answering with. */
  readonly model: string;
  readonly modelVersion: string;
  /** Tokens (Claude) or the provider's own units; and what they cost, in millionths of a dollar. */
  readonly units: number;
  readonly costMicros: number;
}

export type ProviderName = 'jev' | 'anthropic';
export const PROVIDER_NAMES: readonly ProviderName[] = Object.freeze(['jev', 'anthropic']);

export interface DecisionProvider {
  readonly name: ProviderName;
  /** Several asks in one request. */
  readonly batches: boolean;
  decide(call: DecisionCall): Promise<DecisionResult>;
  /** What one ask would cost at most, in millionths of a dollar: what an eval says before it spends anything. */
  estimateMicros?(ask: DecisionAsk, model?: string): number;
}

/**
 * Why a call came back without answers, as the runtime acts on it: `busy`
 * (429, 5xx, overloaded) is tried again until the decision is no longer fresh;
 * `timeout` is the deadline passing; `refused` is the provider declining the
 * request itself (a refusal stop, a 4xx); `key` is the operator's key turned
 * away. None of them carries the provider's own words, which may echo inputs.
 */
export type ProviderFailureKind = 'busy' | 'timeout' | 'refused' | 'key';
export class ProviderFailure extends Error {
  readonly kind: ProviderFailureKind;
  constructor(kind: ProviderFailureKind, message: string) {
    super(message);
    this.name = 'ProviderFailure';
    this.kind = kind;
  }
  get retryable(): boolean {
    return this.kind === 'busy' || this.kind === 'timeout';
  }
}

/** A failure said as a provider failure: an abort past the deadline is a timeout, anything else unknown is busy. */
export function asProviderFailure(error: unknown, deadline?: AbortSignal): ProviderFailure {
  if (error instanceof ProviderFailure) return error;
  if (deadline?.aborted) return new ProviderFailure('timeout', 'The model did not answer before the deadline.');
  return new ProviderFailure('busy', 'The model could not be reached.');
}

/** The status of a provider's HTTP answer, as a failure kind. */
export function failureOfStatus(status: number, provider: string): ProviderFailure {
  if (status === 401 || status === 403) return new ProviderFailure('key', `${provider} refused the operator's key.`);
  if (status === 408 || status === 429 || status === 529 || status >= 500)
    return new ProviderFailure('busy', `${provider} is busy (${status}).`);
  return new ProviderFailure('refused', `${provider} refused the request (${status}).`);
}

/** The asks' inputs, said as plain JSON in a fixed key order: what is digested and what is sent. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
}
