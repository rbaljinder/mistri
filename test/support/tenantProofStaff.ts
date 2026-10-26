import type { BusinessCommandContext } from '../../packages/mistri/src/server/commands/businessCommands.js';
import { refuse } from '../../packages/mistri/src/server/commands/businessCommandExecution.js';

export const proofKey = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 1024 &&
  value.trim() === value &&
  [...value].every((char) => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127);

/** Shared fixture business rule, not platform identity: copy private native
 * account bindings and resolve current staff through the admitted scoped writer. */
export function captureProofStaffAccounts(input: Readonly<Record<string, readonly string[]>>) {
  const bindings = new Map<string, readonly string[]>(
    Object.entries(input).map(([account, ids]) => {
      if (!proofKey(account) || !Array.isArray(ids) || !ids.length || ids.some((id) => !proofKey(id)) || new Set(ids).size !== ids.length) {
        throw new Error('Invalid private staff binding');
      }
      return [account, [...ids]];
    }),
  );
  return Object.freeze({
    has: (account: string) => bindings.has(account),
    async manager(context: BusinessCommandContext, location: string): Promise<string> {
      const ids = bindings.get(context.actor.id) ?? refuse('forbidden');
      const rows = await context.db.review_staff.where({ id: [...ids], location_id: location }).limit(2);
      const manager = rows.length === 1 ? rows[0] : undefined;
      if (!manager || manager.role !== 'manager' || manager.active !== 1 || !proofKey(manager.id)) refuse('forbidden');
      return manager.id;
    },
  });
}
