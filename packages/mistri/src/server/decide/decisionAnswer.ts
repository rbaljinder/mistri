/**
 * A provider's answer, read with the answer field's own rules before anything
 * is kept or shown: a choice is one of the options, a number lies in its range
 * (and is whole where the field says so), a yes or no is a boolean, a
 * reference is one of the keys offered, a list of references is distinct
 * offered keys, at most the field's `max`. The probability is a finite number
 * from 0 to 1 — for a list, one per key. Anything else is no answer
 * (`none`, reason `invalid`): a model is never trusted to have kept to the
 * schema it was given.
 *
 * A list's probability, for its thresholds, is its least certain key's: the
 * list is applied only when every key in it is as likely as `apply` asks.
 */
import type { DecisionAnswerType, DecisionReply } from './providers/decisionProvider.js';

type DecisionValue = string | number | boolean | readonly (string | number)[];
export interface ReadAnswer {
  readonly answer: DecisionValue;
  readonly probability: number;
  /** A list's probability per key, in its order. */
  readonly each?: readonly number[];
}

const probabilityOf = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
/* Keys are compared as text: a numeric key may come back as "12" or 12, and either names row 12. */
const sameKey = (a: unknown, b: unknown) => (typeof a === 'string' || typeof a === 'number') && String(a) === String(b);

/** The reply read against the answer's type, or undefined when it is not an answer of it. */
export function readAnswer(type: DecisionAnswerType, reply: Pick<DecisionReply, 'answer' | 'probability'>): ReadAnswer | undefined {
  const { answer } = reply;
  if (type.kind === 'references') {
    if (!Array.isArray(answer) || !Array.isArray(reply.probability) || answer.length !== reply.probability.length) return undefined;
    if (!answer.length || answer.length > type.max) return undefined;
    const keys: (string | number)[] = [];
    for (const given of answer) {
      const choice = type.choices.find((each) => sameKey(each.key, given));
      if (!choice || keys.some((key) => sameKey(key, choice.key))) return undefined;
      keys.push(choice.key);
    }
    const each = (reply.probability as unknown[]).map(probabilityOf);
    if (each.some((value) => value === undefined)) return undefined;
    return { answer: keys, probability: Math.min(...(each as number[])), each: each as number[] };
  }
  const probability = probabilityOf(reply.probability);
  if (probability === undefined) return undefined;
  switch (type.kind) {
    case 'choice': {
      const option = type.options.find((each) => each.value === answer || (typeof answer === 'string' && String(each.value) === answer));
      return option ? { answer: option.value, probability } : undefined;
    }
    case 'bool':
      return typeof answer === 'boolean' ? { answer, probability } : undefined;
    case 'number': {
      if (typeof answer !== 'number' || !Number.isFinite(answer)) return undefined;
      if (type.integer && !Number.isInteger(answer)) return undefined;
      if ((type.min !== undefined && answer < type.min) || (type.max !== undefined && answer > type.max)) return undefined;
      return { answer, probability };
    }
    case 'reference': {
      const choice = type.choices.find((each) => sameKey(each.key, answer));
      return choice ? { answer: choice.key, probability } : undefined;
    }
  }
}

/** A confidence in words, as the chip and the history say it; the percent is only in "Why this?". */
export function confidenceWord(probability: number): 'almost certain' | 'very likely' | 'likely' | 'possible' {
  if (probability >= 0.95) return 'almost certain';
  if (probability >= 0.85) return 'very likely';
  if (probability >= 0.7) return 'likely';
  return 'possible';
}
