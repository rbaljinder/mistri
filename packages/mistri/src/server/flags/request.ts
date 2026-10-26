/** A request sees one atomic pair of control scopes. Evaluation is presentation
 * and command-gating data; the caller still owns current access authorization. */
import {
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagScope,
  normalizeFlagSnapshot,
  type FlagCatalog,
  type FlagContext,
  type FlagDiagnostic,
  type FlagEvaluation,
  type FlagOverrideSnapshot,
  type FlagScope,
} from '../../shared/appFlags.js';
import { createFlagEvaluator } from './evaluation.js';
import { flagStoreRecord, type FlagStore } from './store.js';

interface ComposedInput {
  readonly catalog: FlagCatalog;
  readonly scope: FlagScope;
  readonly context: FlagContext;
  readonly snapshots: unknown;
  readonly failure?: 'provider_error' | 'invalid_context';
}

export function createComposedFlagEvaluator(input: ComposedInput) {
  const catalog = normalizeFlagCatalog(input.catalog),
    scope = normalizeFlagScope(input.scope);
  let context: FlagContext | undefined,
    global: FlagOverrideSnapshot | undefined,
    tenant: FlagOverrideSnapshot | null = null;
  let diagnostic: FlagDiagnostic | undefined = input.failure;
  try {
    context = normalizeFlagContext(input.context, catalog);
    if (context.tenantId !== undefined && context.tenantId !== scope.tenantId) throw new Error('Invalid evaluation tenant.');
    context = normalizeFlagContext({ ...context, ...(scope.tenantId !== null ? { tenantId: scope.tenantId } : {}) }, catalog);
  } catch {
    diagnostic = 'invalid_context';
  }
  if (!diagnostic) {
    try {
      const pair = flagStoreRecord(input.snapshots, ['global', 'tenant']);
      global = normalizeFlagSnapshot(pair.global, catalog);
      tenant = pair.tenant === null ? null : normalizeFlagSnapshot(pair.tenant, catalog);
      if (
        global.appId !== scope.appId ||
        global.environment !== scope.environment ||
        global.tenantId !== null ||
        (scope.tenantId === null && tenant !== null) ||
        (scope.tenantId !== null &&
          (!tenant || tenant.appId !== scope.appId || tenant.environment !== scope.environment || tenant.tenantId !== scope.tenantId))
      ) {
        diagnostic = 'scope_mismatch';
      }
    } catch {
      diagnostic = 'invalid_snapshot';
    }
  }
  if (diagnostic) {
    global = undefined;
    tenant = null;
  }
  const version = Object.freeze({ global: global?.revision ?? null, tenant: tenant?.revision ?? null });
  const globalEvaluator =
    global && createFlagEvaluator({ catalog, scope: { ...scope, tenantId: null }, context: context!, snapshot: global });
  const tenantEvaluator = tenant && createFlagEvaluator({ catalog, scope, context: context!, snapshot: tenant });
  return Object.freeze({
    scope,
    version,
    evaluate(flagId: string): FlagEvaluation {
      const declared = Object.hasOwn(catalog.flags, flagId) ? catalog.flags[flagId] : undefined;
      if (!declared) throw new Error('Undeclared flag.');
      if (diagnostic || !globalEvaluator)
        return Object.freeze({
          value: declared.default,
          reason: 'default',
          revision: null,
          diagnostics: Object.freeze(diagnostic ? [diagnostic] : []),
        });
      const base = globalEvaluator.evaluate(flagId);
      if (base.reason === 'disabled') return base;
      if (declared.tenantManaged && tenantEvaluator) {
        const local = tenantEvaluator.evaluate(flagId);
        if (local.reason !== 'default') return local;
        if (local.diagnostics.length)
          return Object.freeze({ ...base, diagnostics: Object.freeze([...new Set([...base.diagnostics, ...local.diagnostics])]) });
      }
      return base;
    },
  });
}

/** Captures owner inputs and the atomic-read capability before the first await.
 * A store without pair reads fails to defaults, never a potentially torn pair. */
export async function captureComposedFlagRequest(input: {
  readonly catalog: FlagCatalog;
  readonly scope: FlagScope;
  readonly context: FlagContext;
  readonly store: FlagStore;
}) {
  const catalog = normalizeFlagCatalog(input.catalog),
    scope = normalizeFlagScope(input.scope);
  let context: FlagContext;
  try {
    context = normalizeFlagContext(input.context, catalog);
    if (context.tenantId !== undefined && context.tenantId !== scope.tenantId) throw new Error('Invalid evaluation tenant.');
  } catch {
    return createComposedFlagEvaluator({ catalog, scope, context: {}, snapshots: null, failure: 'invalid_context' });
  }
  const read = input.store.readRequestScopes?.bind(input.store);
  try {
    if (!read) throw new Error('Atomic flag reads are unavailable.');
    const snapshots = await read(scope, catalog);
    return createComposedFlagEvaluator({ catalog, scope, context, snapshots });
  } catch {
    return createComposedFlagEvaluator({ catalog, scope, context, snapshots: null, failure: 'provider_error' });
  }
}
