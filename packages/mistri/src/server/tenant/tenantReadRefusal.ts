/**
 * What a tenant host answers a request that failed beneath it and was not the request's own fault (tenantHttp.ts): a
 * read the audit could not record, said in the words a single App says it in (readAudit.ts); the database not
 * answering, 503; anything else decided nothing the person may know, a denial.
 */
import { TenantContextError, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import { READ_NOT_RECORDED, readNotRecorded } from '../readAudit.js';
import { InvalidRequest } from './tenantWire.js';
import { databaseUnanswered } from './tenantWriteFault.js';

export function tenantReadRefusal(error: unknown): { status: number; code: string; message: string; said: boolean } {
  if (readNotRecorded(error)) return { status: 503, code: READ_NOT_RECORDED.code, message: READ_NOT_RECORDED.error, said: true };
  const unavailable = databaseUnanswered(error);
  const failure = unavailable ? new TenantUnavailableError() : new TenantContextError();
  const status = error instanceof InvalidRequest ? error.status : unavailable ? 503 : 403;
  return { status, code: failure.code, message: failure.message, said: !(error instanceof TenantContextError) };
}
