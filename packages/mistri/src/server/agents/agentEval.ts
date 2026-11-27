/**
 * Unified Agent Evaluation Framework (`defineAgentEval` + `runAgentEval`).
 *
 * Runs deterministic offline (scripted/cassette) or live evaluation suites against any
 * `defineAgent`, grading tool selection, authority refusals, Generative UI block kinds,
 * reasoning traces, token/step ceilings, and custom assertions.
 */
import type { AssistantModel } from '../assistant/assistantModel.js';
import type { AgentDefinition, AgentPrincipal, AgentToolContext } from './agentPrimitives.js';
import { runAgentTurn, type AgentTurnResult } from './agentRunner.js';

export interface AgentEvalExpectations {
  /** Substring or regex expected in the agent's final answer text. */
  readonly answerMatches?: string | RegExp;
  /** Tool names that must be called at least once during the turn. */
  readonly expectedTools?: readonly string[];
  /** Tool names that must NOT be called (or must fail if attempted). */
  readonly forbiddenTools?: readonly string[];
  /** Block kinds or custom block names expected to be emitted. */
  readonly expectedBlocks?: readonly string[];
  /** Require at least one non-empty reasoning trace. */
  readonly expectReasoning?: boolean;
  /** Require at least one tool step to fail (e.g. verifying authority refusal). */
  readonly expectRefusal?: boolean;
  /** Upper bound on total tokens consumed. */
  readonly maxTokens?: number;
  /** Upper bound on model steps taken. */
  readonly maxSteps?: number;
  /** Optional custom grader returning `true` or an error string describing the failure. */
  readonly grade?: (result: AgentTurnResult) => Promise<true | string> | true | string;
}

export interface AgentEvalCase {
  readonly name: string;
  readonly prompt: string;
  readonly principal?: AgentPrincipal;
  readonly expect: AgentEvalExpectations;
}

export interface AgentEvalSuite {
  readonly kind: 'agent-eval';
  readonly name: string;
  readonly agent: AgentDefinition;
  readonly defaultPrincipal: AgentPrincipal;
  readonly cases: readonly AgentEvalCase[];
}

export interface AgentEvalCaseResult {
  readonly name: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  readonly totalTokens: number;
  readonly modelSteps: number;
  readonly result: AgentTurnResult;
}

export interface AgentEvalReport {
  readonly suite: string;
  readonly agentId: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly passRate: number;
  readonly meanTokens: number;
  readonly meanSteps: number;
  readonly cases: readonly AgentEvalCaseResult[];
}

/** Declare a reusable evaluation suite for a Mistri agent. */
export function defineAgentEval(spec: Omit<AgentEvalSuite, 'kind'>): AgentEvalSuite {
  if (!spec.name?.trim()) throw new Error('defineAgentEval: suite name is required.');
  if (!spec.cases.length) throw new Error(`defineAgentEval("${spec.name}"): at least one eval case is required.`);
  return { kind: 'agent-eval', ...spec };
}

/** Execute every case in an `AgentEvalSuite` against a scripted, cassette, or live `AssistantModel`. */
export async function runAgentEval(
  suite: AgentEvalSuite,
  options: {
    model: AssistantModel | ((testCase: AgentEvalCase) => AssistantModel);
    query?: AgentToolContext['query'];
    readRecord?: AgentToolContext['readRecord'];
  },
): Promise<AgentEvalReport> {
  const results: AgentEvalCaseResult[] = [];

  for (const testCase of suite.cases) {
    const model = typeof options.model === 'function' ? options.model(testCase) : options.model;
    const principal = testCase.principal ?? suite.defaultPrincipal;
    const turn = await runAgentTurn(suite.agent, testCase.prompt, {
      model,
      principal,
      query: options.query,
      readRecord: options.readRecord,
    });

    const failures: string[] = [];
    const exp = testCase.expect;

    if (exp.answerMatches !== undefined) {
      const ok = typeof exp.answerMatches === 'string' ? turn.text.includes(exp.answerMatches) : exp.answerMatches.test(turn.text);
      if (!ok) failures.push(`Answer did not match ${String(exp.answerMatches)}.`);
    }
    const calledTools = new Set(turn.steps.map((s) => s.tool));
    const succeededTools = new Set(turn.steps.filter((s) => !s.failed).map((s) => s.tool));
    for (const tool of exp.expectedTools ?? []) {
      if (!calledTools.has(tool)) failures.push(`Expected tool "${tool}" to be called.`);
    }
    for (const tool of exp.forbiddenTools ?? []) {
      if (succeededTools.has(tool)) failures.push(`Forbidden tool "${tool}" succeeded.`);
    }
    const emittedBlocks = new Set(turn.blocks.map((b) => (b.kind === 'custom' ? b.name : b.kind)));
    for (const block of exp.expectedBlocks ?? []) {
      if (!emittedBlocks.has(block)) failures.push(`Expected block "${block}" to be emitted.`);
    }
    if (exp.expectReasoning && !turn.reasoning.some((r) => r.text.trim() || r.redacted)) {
      failures.push('Expected model reasoning trace, but none was recorded.');
    }
    if (exp.expectRefusal && !turn.steps.some((s) => s.failed)) {
      failures.push('Expected at least one refused/failed tool step, but all succeeded.');
    }
    if (exp.maxTokens !== undefined && turn.totalTokens > exp.maxTokens) {
      failures.push(`Used ${turn.totalTokens} tokens, exceeding maxTokens=${exp.maxTokens}.`);
    }
    if (exp.maxSteps !== undefined && turn.modelSteps > exp.maxSteps) {
      failures.push(`Took ${turn.modelSteps} model steps, exceeding maxSteps=${exp.maxSteps}.`);
    }
    if (exp.grade) {
      const graded = await exp.grade(turn);
      if (graded !== true) failures.push(graded);
    }

    results.push({
      name: testCase.name,
      passed: failures.length === 0,
      failures,
      totalTokens: turn.totalTokens,
      modelSteps: turn.modelSteps,
      result: turn,
    });
  }

  const passed = results.filter((r) => r.passed).length;
  const total = results.length;
  const meanTokens = total ? Math.round(results.reduce((sum, r) => sum + r.totalTokens, 0) / total) : 0;
  const meanSteps = total ? Number((results.reduce((sum, r) => sum + r.modelSteps, 0) / total).toFixed(2)) : 0;

  return {
    suite: suite.name,
    agentId: suite.agent.id,
    total,
    passed,
    failed: total - passed,
    passRate: total ? Number((passed / total).toFixed(4)) : 0,
    meanTokens,
    meanSteps,
    cases: results,
  };
}
