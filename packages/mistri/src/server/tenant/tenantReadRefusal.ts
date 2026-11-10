/**
 * What a tenant host answers a request that failed beneath it and was not the request's own fault (tenantHttp.ts): a
 * read the audit could not record, said in the words a single App says it in (readAudit.ts), or as the server busy,
 * with when to ask again (`retryAfter`), when the pool lent its row no writer; the database not answering, 503;
 * anything else decided nothing the person may know, a denial.
 */
import { TenantContextError, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import { readAuditRefusal, readNotRecorded } from '../readAudit.js';
import { InvalidRequest } from './tenantWire.js';
import { databaseUnanswered } from './tenantWriteFault.js';

export function tenantReadRefusal(error: unknown): { status: number; code: string; message: string; said: boolean; retryAfter?: number } {
  if (readNotRecorded(error)) {
    const { body, retryAfter } = readAuditRefusal(error);
    return { status: 503, code: body.code, message: body.error, said: true, ...(retryAfter === undefined ? {} : { retryAfter }) };
  }
  const unavailable = databaseUnanswered(error);
  const failure = unavailable ? new TenantUnavailableError() : new TenantContextError();
  const status = error instanceof InvalidRequest ? error.status : unavailable ? 503 : 403;
  return { status, code: failure.code, message: failure.message, said: !(error instanceof TenantContextError) };
}

/** The headers a refusal is sent with: Retry-After when the server was busy rather than refusing. */
export function readRefusalHeaders(refusal: { retryAfter?: number }): Record<string, string> {
  return refusal.retryAfter === undefined ? {} : { 'retry-after': String(refusal.retryAfter) };
}
