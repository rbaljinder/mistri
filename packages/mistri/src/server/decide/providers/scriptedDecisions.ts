/**
 * The test double: a provider whose answers are written as data, so every
 * node, component and browser test — and `evaluateDecision` in an App's own
 * tests — runs offline and the same every run. It mirrors the assistant's
 * scripted model (assistantScripted.ts).
 *
 * A script names, per decision, the answers it gives in order of preference:
 * the first whose `when` matches the record's inputs (each a pattern over the
 * input's value as text) is said. An entry may instead fail the call the way a
 * provider does (`fail: 'busy' | 'timeout' | 'refused' | 'key'`), or answer
 * late (`delayMs`), so the runtime's retries, deadline and circuit are tested
 * without a network. The same script answers for every provider the
 * declaration names, unless `providers` restricts it to some.
 */
import { ProviderFailure, type DecisionProvider, type ProviderFailureKind, type ProviderName } from './decisionProvider.js';

interface ScriptedAnswer {
  /** Input name to a pattern its value, as text, must match (case-insensitive). */
  readonly when?: Readonly<Record<string, string>>;
  readonly answer?: unknown;
  readonly probability?: unknown;
  readonly fail?: ProviderFailureKind;
  /** Answer after this long: past a decision's deadline, it times out. */
  readonly delayMs?: number;
}
export interface DecisionScript {
  readonly decisions: Readonly<Record<string, readonly ScriptedAnswer[]>>;
  /** The model and version said; default `scripted` and `scripted-1`. */
  readonly model?: string;
  readonly modelVersion?: string;
  /** The providers this script answers as; default both. */
  readonly providers?: readonly ProviderName[];
  /** What each ask costs, in millionths of a dollar; default 100. */
  readonly costMicros?: number;
}

const matches = (when: ScriptedAnswer['when'], inputs: Readonly<Record<string, unknown>>) =>
  Object.entries(when ?? {}).every(([name, pattern]) => {
    const value = inputs[name];
    return new RegExp(pattern, 'i').test(
      value === null || value === undefined ? '' : typeof value === 'string' ? value : JSON.stringify(value),
    );
  });

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new ProviderFailure('timeout', 'The model did not answer before the deadline.'));
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new ProviderFailure('timeout', 'The model did not answer before the deadline.'));
      },
      { once: true },
    );
  });

export function scriptedDecisions(script: DecisionScript, name: ProviderName): DecisionProvider {
  const cost = script.costMicros ?? 100;
  return {
    name,
    batches: true,
    estimateMicros: () => cost,
    async decide(call) {
      const replies = [];
      for (const ask of call.asks) {
        const entry = (script.decisions[ask.id] ?? []).find((each) => matches(each.when, ask.inputs));
        if (entry?.delayMs) await pause(entry.delayMs, call.signal);
        if (entry?.fail) throw new ProviderFailure(entry.fail, `The scripted ${name} failed: ${entry.fail}.`);
        replies.push({ id: ask.id, answer: entry?.answer, probability: entry?.probability });
      }
      const model = call.model ?? script.model ?? 'scripted';
      return {
        replies,
        model,
        modelVersion: script.modelVersion ?? `${model}-1`,
        units: call.asks.length,
        costMicros: cost * call.asks.length,
      };
    },
  };
}
