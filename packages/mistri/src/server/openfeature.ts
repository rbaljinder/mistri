/**
 * An OpenFeature server provider over mistri's flags, with no dependency:
 * the object satisfies the SDK's `Provider` interface structurally.
 *
 * It answers from the decision the running command attempt already holds, so
 * a flag read through OpenFeature is the same value, with the same exposure
 * for an experiment, as `ctx.flags.get`. The caller's EvaluationContext never
 * targets: who the request is for was verified before the handler ran, and a
 * context an authored function builds is not that. Outside a command attempt
 * there is nothing to answer from, and the default comes back as an error.
 * @preview
 */
import { activeCommandFlag } from './commands/commandFlags.js';

type Reason = 'DISABLED' | 'TARGETING_MATCH' | 'SPLIT' | 'DEFAULT' | 'ERROR';
type ErrorCode = 'INVALID_CONTEXT' | 'FLAG_NOT_FOUND' | 'TYPE_MISMATCH' | 'GENERAL';
interface OpenFeatureResolution<T> {
  readonly value: T;
  readonly reason: Reason;
  readonly variant?: string;
  readonly errorCode?: ErrorCode;
  readonly errorMessage?: string;
}
interface OpenFeatureProvider {
  readonly metadata: { readonly name: 'mistri' };
  readonly runsOn: 'server';
  /** The evaluation context and logger the SDK passes are accepted and not used. */
  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context?: unknown,
    logger?: unknown,
  ): Promise<OpenFeatureResolution<boolean>>;
  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context?: unknown,
    logger?: unknown,
  ): Promise<OpenFeatureResolution<string>>;
  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context?: unknown,
    logger?: unknown,
  ): Promise<OpenFeatureResolution<number>>;
  resolveObjectEvaluation<T extends object>(
    flagKey: string,
    defaultValue: T,
    context?: unknown,
    logger?: unknown,
  ): Promise<OpenFeatureResolution<T>>;
}

const REASONS = {
  disabled: 'DISABLED',
  target: 'TARGETING_MATCH',
  rollout: 'SPLIT',
  experiment: 'SPLIT',
  default: 'DEFAULT',
  override: 'DEFAULT',
} as const;

function resolve<T>(type: 'boolean' | 'string' | 'number' | 'object', flagKey: string, defaultValue: T): OpenFeatureResolution<T> {
  const fail = (errorCode: ErrorCode, errorMessage: string): OpenFeatureResolution<T> => ({
    value: defaultValue,
    reason: 'ERROR',
    errorCode,
    errorMessage,
  });
  let flag: ReturnType<typeof activeCommandFlag>;
  try {
    flag = activeCommandFlag(flagKey);
  } catch {
    return fail('GENERAL', 'The flag decision is no longer current.');
  }
  if (flag.status === 'none')
    return fail('INVALID_CONTEXT', 'No command attempt is running, so there is no verified request to evaluate for.');
  if (flag.status === 'unknown') return fail('FLAG_NOT_FOUND', `This App declares no flag "${flagKey}".`);
  if (flag.type !== type) return fail('TYPE_MISMATCH', `Flag "${flagKey}" is ${flag.type === 'object' ? 'an object' : `a ${flag.type}`}.`);
  return { value: flag.value as T, reason: REASONS[flag.reason] };
}

/** An OpenFeature provider that serves the App's flags. */
export function createOpenFeatureProvider(): OpenFeatureProvider {
  return Object.freeze({
    metadata: Object.freeze({ name: 'mistri' as const }),
    runsOn: 'server' as const,
    resolveBooleanEvaluation: async (key: string, fallback: boolean) => resolve('boolean', key, fallback),
    resolveStringEvaluation: async (key: string, fallback: string) => resolve('string', key, fallback),
    resolveNumberEvaluation: async (key: string, fallback: number) => resolve('number', key, fallback),
    resolveObjectEvaluation: async <T extends object>(key: string, fallback: T) => resolve('object', key, fallback),
  });
}
