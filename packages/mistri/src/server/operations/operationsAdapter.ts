import {
  buildReadiness,
  buildSupportBundle,
  type CapacitySnapshot,
  type OperationsScope,
  type ReadinessCheckInput,
  type ReadinessSnapshot,
  type SupportBundle,
} from './operations.js';
import type { RequestMetricsSnapshot } from '@mistriwork/engine/server/operations/requestMetrics.js';

/** An operation the future local status surface may expose. */
type OperationsAction = 'readiness' | 'support';

/** Caller identity is supplied by the transport/auth owner and is never emitted. */
export interface OperationsCaller {
  readonly kind: OperationsScope;
  readonly id: string;
  /** The server-configured named source whose diagnostics are being read. */
  readonly sourceId: string;
}

interface OperationsAuthorizationRequest {
  readonly audience: 'mistri.operations';
  readonly action: OperationsAction;
  readonly scope: OperationsScope;
  readonly caller: OperationsCaller;
}

/**
 * The authorizer owns creation of this value. The adapter verifies every field
 * again because a transport must not be able to change scope or action after
 * authorization. It is deliberately not a bearer token or a persisted object.
 */
export interface OperationsGrant {
  readonly audience: 'mistri.operations';
  readonly action: OperationsAction;
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readonly expiresAt: number;
}

export interface OperationsCollectedState {
  readonly checks: readonly ReadinessCheckInput[];
  readonly metrics?: RequestMetricsSnapshot;
  readonly capacity?: CapacitySnapshot;
}

interface OperationsAdapterContext {
  readonly audience: 'mistri.operations';
  readonly action: OperationsAction;
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readonly caller: OperationsCaller;
  readonly grant: OperationsGrant;
}

type OperationsAuthorizer = (request: OperationsAuthorizationRequest) => OperationsGrant | null | Promise<OperationsGrant | null>;

type OperationsCollector = (context: OperationsAdapterContext) => OperationsCollectedState | Promise<OperationsCollectedState>;

export interface OperationsAdapterResult<Value> {
  readonly value: Value;
  readonly action: OperationsAction;
  readonly scope: OperationsScope;
  readonly sourceId: string;
  /** A transport adapter must preserve this policy; diagnostics are private. */
  readonly cacheControl: 'no-store';
}

export interface OperationsAdapter {
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readiness(caller: OperationsCaller): Promise<OperationsAdapterResult<ReadinessSnapshot>>;
  support(caller: OperationsCaller): Promise<OperationsAdapterResult<SupportBundle>>;
}

type OperationsAdapterErrorCode = 'invalid_caller' | 'not_authorized' | 'grant_invalid' | 'grant_expired' | 'collection_failed';

export class OperationsAdapterError extends Error {
  override name = 'OperationsAdapterError';
  readonly code: OperationsAdapterErrorCode;

  constructor(code: OperationsAdapterErrorCode) {
    super(`Operations request ${code.replaceAll('_', ' ')}.`);
    this.code = code;
  }
}

function validScope(value: unknown): value is OperationsScope {
  return value === 'standalone' || value === 'app';
}

function validSourceId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value);
}

function assertCaller(scope: OperationsScope, sourceId: string, caller: OperationsCaller): OperationsCaller {
  if (
    !caller ||
    typeof caller !== 'object' ||
    caller.kind !== scope ||
    typeof caller.id !== 'string' ||
    caller.id.length === 0 ||
    caller.id.length > 128 ||
    caller.sourceId !== sourceId
  ) {
    throw new OperationsAdapterError('invalid_caller');
  }
  return Object.freeze({ kind: caller.kind, id: caller.id, sourceId });
}

function assertGrant(
  grant: OperationsGrant | null,
  scope: OperationsScope,
  sourceId: string,
  action: OperationsAction,
  now: number,
): OperationsGrant {
  if (
    !grant ||
    typeof grant !== 'object' ||
    grant.audience !== 'mistri.operations' ||
    grant.scope !== scope ||
    grant.action !== action ||
    grant.sourceId !== sourceId ||
    !Number.isSafeInteger(grant.expiresAt)
  ) {
    throw new OperationsAdapterError('grant_invalid');
  }
  if (grant.expiresAt <= now) throw new OperationsAdapterError('grant_expired');
  return Object.freeze({
    audience: grant.audience,
    scope: grant.scope,
    sourceId,
    action: grant.action,
    expiresAt: grant.expiresAt,
  });
}

function timestamp(now: number): string {
  if (!Number.isSafeInteger(now) || now < 0) throw new OperationsAdapterError('collection_failed');
  try {
    return new Date(now).toISOString();
  } catch {
    throw new OperationsAdapterError('collection_failed');
  }
}

/**
 * Create a protected, transport-independent local operations boundary.
 * Authentication and operator policy stay with the caller-provided authorizer;
 * this adapter only binds them to one fixed scope and one requested action.
 */
export function createOperationsAdapter(options: {
  readonly scope: OperationsScope;
  readonly sourceId: string;
  readonly authorize: OperationsAuthorizer;
  readonly collect: OperationsCollector;
  readonly now?: () => number;
}): OperationsAdapter {
  if (
    !validScope(options.scope) ||
    typeof options.authorize !== 'function' ||
    !validSourceId(options.sourceId) ||
    typeof options.collect !== 'function'
  ) {
    throw new OperationsAdapterError('grant_invalid');
  }
  const clock = options.now ?? Date.now;
  const scope = options.scope;
  const sourceId = options.sourceId;

  const run = async <Value>(
    action: OperationsAction,
    incoming: OperationsCaller,
    build: (state: OperationsCollectedState, generatedAt: string) => Value,
  ): Promise<OperationsAdapterResult<Value>> => {
    const caller = assertCaller(scope, sourceId, incoming);
    const requested = Object.freeze({
      audience: 'mistri.operations' as const,
      action,
      scope,
      sourceId,
      caller,
    });
    let granted: OperationsGrant | null;
    try {
      granted = await options.authorize(requested);
    } catch {
      throw new OperationsAdapterError('not_authorized');
    }
    const grant = assertGrant(granted, scope, sourceId, action, clock());
    let state: OperationsCollectedState;
    try {
      state = await options.collect(Object.freeze({ ...requested, grant }));
    } catch {
      throw new OperationsAdapterError('collection_failed');
    }
    // A slow collector must not turn an expired operator grant into a result.
    assertGrant(grant, scope, sourceId, action, clock());
    const generatedAt = timestamp(clock());
    let value: Value;
    try {
      value = build(state, generatedAt);
    } catch {
      throw new OperationsAdapterError('collection_failed');
    }
    return Object.freeze({ value, action, scope, sourceId, cacheControl: 'no-store' as const });
  };

  return Object.freeze({
    scope,
    sourceId,
    readiness: (caller: OperationsCaller) =>
      run('readiness', caller, (state, generatedAt) => buildReadiness(scope, state.checks, generatedAt)),
    support: (caller: OperationsCaller) =>
      run('support', caller, (state, generatedAt) =>
        buildSupportBundle({
          scope,
          checks: state.checks,
          metrics: state.metrics,
          capacity: state.capacity,
          generatedAt,
        }),
      ),
  });
}
