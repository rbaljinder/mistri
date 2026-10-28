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
/* The walk lives beside `databaseFault` (evidence.ts), since the read path's
   `denyTenantFor` reads a fault the same way. */
export { databaseUnanswered } from '@mistriwork/engine/server/evidence.js';

/** What a write route answers when the database did not: nothing was applied, and asking again may work. */
export function unansweredWrite(path: string): { status: 503; body: Record<string, unknown> } {
  const message = 'The change could not be made: the database did not answer. Nothing was changed; try again.';
  return {
    status: 503,
    body: {
      error: message,
      errors: [{ code: 'temporarily_unavailable', message }],
      outcome: 'not_applied',
      ...(path === '/api/delete' ? { deleted: false } : path === '/api/revert' ? { reverted: false } : {}),
    },
  };
}
