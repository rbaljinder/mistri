/**
 * `POST /api/tenant/support/{open,exit,status}`: the support owner's three
 * operations over the tenant data server, which has already checked the
 * host, origin, App and ownership headers. Each is the native login's own:
 * the request names no tenant, tab or lease, and the owner re-reads the
 * login itself. A successful open, or a status asked to resume, also opens a
 * support lease on a new tab, which grants no business access yet.
 */
import type { IncomingMessage } from 'node:http';
import type { TenantContextReply } from '../../shared/tenantContext.js';
import { SUPPORT_REFUSAL_CODES, type SupportExitIntent, type SupportOpenIntent } from '../../shared/tenantSupport.js';
import { tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { namedTenants, type TenantNames } from './tenantNames.js';
import { TenantSupportFailure, type SupportStatusRequest, type TenantSupport } from './tenantSupportOperations.js';

interface SupportHttpReply {
  readonly status: number;
  readonly body: unknown;
  readonly context?: TenantContextReply;
}
interface Leases {
  openSupport(request: IncomingMessage, target: { tenantId: string; supportId: string }): Promise<TenantContextReply>;
}

export async function dispatchTenantSupportHttp(
  request: IncomingMessage,
  operation: 'open' | 'exit' | 'status',
  input: Record<string, unknown>,
  account: string,
  services: { readonly support: TenantSupport; readonly contexts: Leases; readonly names?: TenantNames },
): Promise<SupportHttpReply> {
  const { support, contexts } = services;
  try {
    if (operation === 'status') {
      tenantRecord(input, ['attempt', 'resume']);
      if (Object.hasOwn(input, 'resume') && input.resume !== true) throw new TenantSupportFailure(SUPPORT_REFUSAL_CODES.refused, 'unknown');
      const status = await support.status(request, {
        expectedAccount: account,
        ...(Object.hasOwn(input, 'attempt') ? { attempt: input.attempt as SupportStatusRequest['attempt'] } : {}),
      });
      // Resuming is a new lease on the same, still-live session of this login.
      const context =
        input.resume === true && status.session?.state === 'active'
          ? await contexts.openSupport(request, { tenantId: status.session.tenantId, supportId: status.session.supportId })
          : undefined;
      const choices = await namedTenants(status.choices, services.names);
      return { status: 200, body: { ...status, choices, ...(context ? { context } : {}) }, ...(context ? { context } : {}) };
    }
    tenantRecord(input, ['idempotencyKey', 'intent']);
    if (!Object.hasOwn(input, 'idempotencyKey') || !Object.hasOwn(input, 'intent'))
      throw new TenantSupportFailure(SUPPORT_REFUSAL_CODES.refused, 'not_applied');
    const attempt = { expectedAccount: account, idempotencyKey: input.idempotencyKey as string };
    if (operation === 'exit') {
      const outcome = await support.exit(request, { ...attempt, intent: input.intent as SupportExitIntent });
      return { status: 200, body: outcome };
    }
    const outcome = await support.open(request, { ...attempt, intent: input.intent as SupportOpenIntent });
    let context: TenantContextReply | undefined;
    if (outcome.receipt.session.state === 'active') {
      try {
        context = await contexts.openSupport(request, {
          tenantId: outcome.receipt.session.tenantId,
          supportId: outcome.receipt.session.supportId,
        });
      } catch {
        /* The session is committed; status resumes it on a lease. */
      }
    }
    return { status: 200, body: { ...outcome, ...(context ? { context } : {}) }, ...(context ? { context } : {}) };
  } catch (error) {
    const failure = error instanceof TenantSupportFailure ? error : undefined;
    // A status is never a mutation: its failure leaves the attempt's outcome unknown.
    const outcome = operation === 'status' ? 'unknown' : (failure?.outcome ?? 'not_applied');
    return {
      status: operation !== 'status' && outcome === 'unknown' ? 503 : 403,
      body: {
        error: failure?.message ?? 'The support session could not be confirmed.',
        code: failure?.code ?? SUPPORT_REFUSAL_CODES.refused,
        outcome,
      },
    };
  }
}
