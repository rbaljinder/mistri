import { buildReadiness, buildSupportBundle, type OperationsScope, type ReadinessSnapshot, type SupportBundle } from './operations.js';
import {
  OperationsAdapterError,
  type OperationsAdapter,
  type OperationsAdapterResult,
  type OperationsCaller,
} from './operationsAdapter.js';

/** The only operations that a headless reader may request. */
export type HeadlessOperationsAction = 'readiness' | 'support';

interface HeadlessOperationsReadRequest {
  readonly action: HeadlessOperationsAction;
  readonly caller: OperationsCaller;
}

type HeadlessOperationsFailureCode = 'invalid_request' | 'not_authorized' | 'unavailable';

interface HeadlessOperationsReadFailure {
  readonly ok: false;
  readonly cacheControl: 'no-store';
  readonly error: HeadlessOperationsFailureCode;
}

interface HeadlessOperationsReadinessSuccess {
  readonly ok: true;
  readonly action: 'readiness';
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readonly cacheControl: 'no-store';
  readonly value: ReadinessSnapshot;
}

interface HeadlessOperationsSupportSuccess {
  readonly ok: true;
  readonly action: 'support';
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readonly cacheControl: 'no-store';
  readonly value: SupportBundle;
}

export type HeadlessOperationsReadResult =
  | HeadlessOperationsReadinessSuccess
  | HeadlessOperationsSupportSuccess
  | HeadlessOperationsReadFailure;

interface HeadlessOperationsReader {
  readonly scope: OperationsScope;
  readonly sourceId: string;
  read(request: unknown): Promise<HeadlessOperationsReadResult>;
}

export class HeadlessOperationsInputError extends Error {
  override name = 'HeadlessOperationsInputError';
}

function validScope(value: unknown): value is OperationsScope {
  return value === 'standalone' || value === 'app';
}

function validAction(value: unknown): value is HeadlessOperationsAction {
  return value === 'readiness' || value === 'support';
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function validSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function parseRequest(value: unknown, scope: OperationsScope, sourceId: string): HeadlessOperationsReadRequest | null {
  try {
    if (
      !record(value) ||
      !exactKeys(value, ['action', 'caller']) ||
      !validAction(value.action) ||
      !record(value.caller) ||
      !exactKeys(value.caller, ['kind', 'id', 'sourceId']) ||
      value.caller.kind !== scope ||
      typeof value.caller.id !== 'string' ||
      value.caller.id.length === 0 ||
      value.caller.id.length > 128 ||
      !validSourceId(value.caller.sourceId) ||
      value.caller.sourceId !== sourceId
    )
      return null;
    return Object.freeze({
      action: value.action,
      caller: Object.freeze({ kind: scope, id: value.caller.id, sourceId: value.caller.sourceId }),
    });
  } catch {
    return null;
  }
}

function failure(error: HeadlessOperationsFailureCode): HeadlessOperationsReadFailure {
  return Object.freeze({ ok: false, cacheControl: 'no-store', error });
}

function safeError(error: unknown): HeadlessOperationsFailureCode {
  if (!(error instanceof OperationsAdapterError)) return 'unavailable';
  return error.code === 'invalid_caller' ||
    error.code === 'not_authorized' ||
    error.code === 'grant_invalid' ||
    error.code === 'grant_expired'
    ? 'not_authorized'
    : 'unavailable';
}

function sanitizeReadiness(scope: OperationsScope, value: unknown): ReadinessSnapshot {
  if (
    !record(value) ||
    value.event !== 'mistri.readiness' ||
    value.version !== 1 ||
    value.scope !== scope ||
    typeof value.generatedAt !== 'string' ||
    !Array.isArray(value.checks)
  )
    throw new HeadlessOperationsInputError('Invalid readiness result.');
  return buildReadiness(scope, value.checks as never, value.generatedAt);
}

function sanitizeSupport(scope: OperationsScope, value: unknown): SupportBundle {
  if (
    !record(value) ||
    value.event !== 'mistri.support' ||
    value.version !== 1 ||
    value.scope !== scope ||
    typeof value.generatedAt !== 'string' ||
    !record(value.readiness) ||
    !Array.isArray(value.readiness.checks)
  ) {
    throw new HeadlessOperationsInputError('Invalid support result.');
  }
  return buildSupportBundle({
    scope,
    checks: value.readiness.checks as never,
    metrics: value.metrics as never,
    capacity: value.capacity as never,
    generatedAt: value.generatedAt,
  });
}

function sanitizeSuccess(
  scope: OperationsScope,
  sourceId: string,
  action: HeadlessOperationsAction,
  result: OperationsAdapterResult<unknown>,
): HeadlessOperationsReadinessSuccess | HeadlessOperationsSupportSuccess {
  if (!result || result.action !== action || result.scope !== scope || result.sourceId !== sourceId || result.cacheControl !== 'no-store') {
    throw new HeadlessOperationsInputError('Invalid operations result.');
  }
  if (action === 'readiness') {
    return Object.freeze({
      ok: true,
      action,
      scope,
      sourceId: result.sourceId,
      cacheControl: 'no-store',
      value: sanitizeReadiness(scope, result.value),
    });
  }
  return Object.freeze({
    ok: true,
    action,
    scope,
    sourceId: result.sourceId,
    cacheControl: 'no-store',
    value: sanitizeSupport(scope, result.value),
  });
}

/**
 * Bind a headless read contract to an already protected operations adapter.
 * This function never authenticates callers and never creates authority: the
 * supplied adapter remains responsible for authorization and collection.
 * Invalid input, authorization failure and malformed collector output all
 * become bounded failure values rather than escaping transport-specific data.
 */
export function createHeadlessOperationsReader(adapter: OperationsAdapter): HeadlessOperationsReader {
  if (
    !record(adapter) ||
    !validScope(adapter.scope) ||
    typeof adapter.sourceId !== 'string' ||
    typeof adapter.readiness !== 'function' ||
    typeof adapter.support !== 'function'
  ) {
    throw new HeadlessOperationsInputError('Invalid operations adapter.');
  }
  const scope = adapter.scope;
  return Object.freeze({
    scope,
    sourceId: adapter.sourceId,
    read: async (input: unknown): Promise<HeadlessOperationsReadResult> => {
      const request = parseRequest(input, scope, adapter.sourceId);
      if (!request) return failure('invalid_request');
      try {
        const result = request.action === 'readiness' ? await adapter.readiness(request.caller) : await adapter.support(request.caller);
        return sanitizeSuccess(scope, adapter.sourceId, request.action, result as OperationsAdapterResult<unknown>);
      } catch (error) {
        return failure(error instanceof HeadlessOperationsInputError ? 'unavailable' : safeError(error));
      }
    },
  });
}
