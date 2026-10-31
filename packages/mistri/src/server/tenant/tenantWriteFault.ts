/**
 * A tenant write or command that failed because the database did not answer —
 * a connection cut, a backend terminated, a pool that could not lend one —
 * decided nothing about the person, and answering it as a refusal ("The
 * change is unavailable under the current permissions or record state", 403)
 * told them they could not edit a record they could. The tenant writer's
 * failure is value-free on purpose (tenantWriteKindContract.ts), so what
 * failed is read from the causes recorded beneath it, as the read path reads
 * a fault (evidence.ts databaseFault): positively, and a denial anywhere on
 * the way down stays a denial.
 */
import { POOL_BUSY_MESSAGE, PoolBusy } from '@mistriwork/engine/adapters/poolMetrics.js';
import { refusalCause } from '@mistriwork/engine/shared/refusal.js';
import { writeRefusalStatus } from '@mistriwork/engine/server/constraints.js';
import { TenantContextError, TenantUnavailableError } from '@mistriwork/engine/server/evidence.js';
import { appError } from '../app/appErrors.js';

/* The walk lives beside `databaseFault` (evidence.ts), since the read path's
   `denyTenantFor` reads a fault the same way. */
export { databaseUnanswered } from '@mistriwork/engine/server/evidence.js';

/* A pool that would not lend a writer in time, or a person's earlier saves still ahead of this one
   (tenantHistoryPartitions.ts): the server busy, under however many value-free failures it was recorded. */
function busyBeneath(error: unknown): boolean {
  let at: unknown = error;
  for (let depth = 0; at !== null && typeof at === 'object' && depth < 16; depth++) {
    if (at instanceof PoolBusy) return true;
    at = refusalCause(at) ?? (at instanceof Error ? at.cause : undefined);
  }
  return false;
}

/** What a write route answers when the database did not: nothing was applied, and asking again may work. A busy
 * server says so in the words and code a single-database App's write does (reply.ts sendBusy). */
export function unansweredWrite(
  path: string,
  error?: unknown,
): { status: 503; code: 'server_busy' | 'temporarily_unavailable'; body: Record<string, unknown> } {
  const busy = busyBeneath(error);
  const message = busy ? POOL_BUSY_MESSAGE : 'The change could not be made: the database did not answer. Nothing was changed; try again.';
  const code = busy ? 'server_busy' : 'temporarily_unavailable';
  return {
    status: 503,
    code,
    body: {
      error: message,
      ...(busy ? { code } : {}),
      errors: [{ code, message }],
      outcome: 'not_applied',
      ...(path === '/api/delete' ? { deleted: false } : path === '/api/revert' ? { reverted: false } : {}),
    },
  };
}

/**
 * A tenant write the database refused for good — a key already taken, a reference to nothing, a value its column
 * cannot hold — is the record's to fix: answered as a single-database App answers it (appErrors.ts), by the same
 * code, at the same status (constraints.ts writeRefusalStatus), never as the database not answering. Only in the
 * fixed sentence that names no column: the engine's own names are physical, the tenant's column among them, and its
 * detail carries values. A key is global while rows are a tenant's, so an id another tenant holds is refused exactly
 * as one this tenant holds, word for word: the reply is chosen by the SQLSTATE alone, and says nothing more of whose
 * row it met. Undefined for anything else, and for a denial on the way down, which stays a denial.
 */
export function refusedWrite(path: string, error: unknown): { status: 409 | 422; code: string; body: Record<string, unknown> } | undefined {
  let at: unknown = error;
  for (let depth = 0; at !== null && typeof at === 'object' && depth < 16; depth++) {
    const status = writeRefusalStatus(at);
    if (status) {
      // Its codes and nothing else: no column, constraint or detail reaches appError, so it says the fixed sentence.
      const { code, errcode, severity } = at as { code?: unknown; errcode?: unknown; severity?: unknown };
      const failure = appError({ code, errcode, severity }, 'write');
      return {
        status,
        code: failure.code,
        body: {
          error: failure.message,
          errors: [{ code: failure.code, message: failure.message }],
          outcome: 'rejected',
          ...(path === '/api/delete' ? { deleted: false } : path === '/api/revert' ? { reverted: false } : {}),
        },
      };
    }
    if (at instanceof TenantContextError && !(at instanceof TenantUnavailableError)) return undefined;
    at = refusalCause(at) ?? (at instanceof Error ? at.cause : undefined);
  }
  return undefined;
}
