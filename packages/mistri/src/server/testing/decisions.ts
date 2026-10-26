/**
 * `evaluateDecision`: a decision measured in an App's own tests, on records
 * written in the test and a scripted model (or any provider the test builds),
 * with the report `mistri decide eval` prints — so a change to a question, an
 * input or a threshold is judged before a model is ever paid to answer it.
 */
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { answerSpec } from '../decide/decisionChecks.js';
import { askEvaluation, scoreDecision, type DecisionEvaluation } from '../decide/decisionEval.js';
import { capturedDecision, type Decision } from '../decide/decisionModule.js';
import type { DecisionAnswerType, DecisionProvider, ProviderName } from '../decide/providers/decisionProvider.js';
import { scriptedDecisions, type DecisionScript } from '../decide/providers/scriptedDecisions.js';

export interface EvaluateDecisionOptions {
  /** The records asked about: each one's inputs as they would be sent, and the answer a person settled. */
  readonly records: readonly Readonly<{ inputs: Readonly<Record<string, unknown>>; truth: unknown }>[];
  /** Who answers: a script (as `startTestApp({ decisions })` takes one), or a provider the test builds. */
  readonly model: DecisionScript | DecisionProvider;
  /** The decision's name, as its defineDecisions key: the script's answers are read under it. Default: the script's only decision. */
  readonly name?: string;
  /** The App's commands (its defineCommands export): the answer's type is the answer command's field's. */
  readonly commands?: BusinessCommandRegistry;
  /** The answer's type, said outright, in place of `commands`; a reference's choices are given here. */
  readonly answer?: DecisionAnswerType;
  /** A reference answer's choices, read from the records' table where the App runs. */
  readonly choices?: readonly Readonly<{ key: string | number; label: string }>[];
  /** The provider asked; default the decision's first. */
  readonly provider?: ProviderName;
  /** The applied share's error a pin allows; default 2%. */
  readonly maxError?: number;
}

const isProvider = (value: unknown): value is DecisionProvider =>
  !!value && typeof value === 'object' && typeof (value as DecisionProvider).decide === 'function';

/** Ask about each record and score the answers against what was settled, under the decision's thresholds. */
export async function evaluateDecision(decision: Decision, options: EvaluateDecisionOptions): Promise<DecisionEvaluation> {
  const script = isProvider(options.model) ? undefined : options.model;
  const named = Object.keys(script?.decisions ?? {});
  const name = options.name ?? (named.length === 1 ? named[0] : 'decision');
  const captured = capturedDecision(decision, name);
  const providerName = options.provider ?? captured.providers[0];
  const provider = isProvider(options.model) ? options.model : scriptedDecisions(options.model, providerName);
  let answer = options.answer;
  if (!answer) {
    const command = options.commands?.[captured.answer.command.id];
    if (!command)
      throw new Error(`evaluateDecision: give the App's commands (with "${captured.answer.command.id}") or the answer's type as answer.`);
    const spec = answerSpec(command, captured.answer.field);
    if (typeof spec === 'string') throw new Error(`evaluateDecision: "${captured.answer.command.id}" ${spec}.`);
    if (spec.kind === 'reference' || spec.kind === 'references') {
      if (!options.choices) throw new Error(`evaluateDecision: a reference answer is chosen from choices: give them as choices.`);
      answer =
        spec.kind === 'reference'
          ? { kind: 'reference', choices: options.choices }
          : { kind: 'references', choices: options.choices, max: spec.max };
    } else answer = spec;
  }
  const asked = await askEvaluation(
    provider,
    captured,
    options.records.map((record) => ({ inputs: record.inputs, answer: answer!, truth: record.truth })),
  );
  return scoreDecision(captured, asked.examples, {
    provider: providerName,
    model: asked.model,
    modelVersion: asked.modelVersion,
    units: asked.units,
    costMicros: asked.costMicros,
    ...(options.maxError === undefined ? {} : { maxError: options.maxError }),
  });
}
