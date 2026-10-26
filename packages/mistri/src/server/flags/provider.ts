/** Capture before the provider awaits; a provider cannot mutate a request's
 * context. Failures become diagnostic defaults, never permission decisions. */
import {
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagContext,
  type FlagProvider,
  type FlagRequestInput,
  type FlagRequestSnapshot,
} from '../../shared/appFlags.js';
import { createFlagEvaluator } from './evaluation.js';

export function createStaticFlagProvider(catalog: FlagCatalog, snapshot: unknown): FlagProvider {
  const captured = snapshot === null ? null : normalizeFlagSnapshot(snapshot, normalizeFlagCatalog(catalog));
  return Object.freeze({ readSnapshot: () => captured });
}

export async function captureFlagRequest(input: FlagRequestInput): Promise<FlagRequestSnapshot> {
  const catalog = normalizeFlagCatalog(input.catalog),
    scope = normalizeFlagScope(input.scope);
  let context: FlagContext;
  try {
    context = normalizeFlagContext(input.context, catalog);
  } catch {
    return createFlagEvaluator({ catalog, scope, context: {}, snapshot: null, failure: 'invalid_context' });
  }
  try {
    const snapshot = await input.provider.readSnapshot(Object.freeze({ scope, context }));
    return createFlagEvaluator({ catalog, scope, context, snapshot });
  } catch {
    return createFlagEvaluator({ catalog, scope, context, snapshot: null, failure: 'provider_error' });
  }
}
