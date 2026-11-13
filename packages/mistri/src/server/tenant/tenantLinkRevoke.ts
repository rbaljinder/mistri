/**
 * "Revoke links" on a tenant App's record page: how many of the record's capability links still open, and revoking
 * them all. Each is a member's request in their own tenant, run as a command's transaction is (tenantCommands.ts):
 * the membership fenced from BEGIN to COMMIT, the record read through the member's own scope, and the tenant's own
 * journal, where a link of another tenant is not there to count or revoke. The member must be granted writes to the
 * resource; the revoke is noted in the record's history, where it keeps one, as that member
 * (http/recordLinkRoutes.ts serves an App without tenants).
 */
import { AppAccessDenied } from '../app/appAccess.js';
import { commandKeyText } from '../commands/commandPayload.js';
import { keyFilter } from '../commands/commandDb.js';
import { exactKey } from '../recordHistory.js';
import { revokedLinksAction } from '../http/recordLinkRoutes.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { TenantInvocationGuard } from './tenantInvocation.js';
import { captureTenantRequestRuntime, type TenantRequestRuntime } from './tenantRequestRuntime.js';

export interface RecordLinksRequest {
  readonly table: string;
  readonly key: Record<string, string | number>;
}

export function bindTenantLinkRevokes<Request>(input: TenantRequestRuntime<Request>, now: () => number) {
  const requests = captureTenantRequestRuntime(input);
  const { app, ownership } = requests;
  const run = <T>(
    request: Request,
    selectors: readonly string[],
    value: RecordLinksRequest,
    guard: TenantInvocationGuard | undefined,
    work: (
      at: Readonly<{ table: string; key: Record<string, string | number>; rowKey: string; now: number }>,
      records: WriteTransaction,
      journal: CommandJournal,
    ) => Promise<T>,
  ): Promise<T> =>
    requests.run(
      request,
      selectors,
      async (scope) => {
        const captured = captureTenantData(value);
        tenantRecord(captured, ['table', 'key']);
        tenantIdentifier(captured.table);
        tenantRecord(captured.key);
        const table = captured.table;
        const resource = Object.hasOwn(app.resources ?? {}, table) ? app.resources![table] : undefined;
        // Only the tenant's own rows hold links (tenantLinkModel.ts), and only where the resource declares some.
        if (!resource?.links || !Object.keys(resource.links).length || ownership.ownership[table]?.kind !== 'tenant')
          throw new AppAccessDenied();
        // The member's own grant: a revoke is a write to the record, as its Save is.
        if (!scope.grants.writable.has(table) || scope.grants.appendOnly?.has(table)) throw new AppAccessDenied();
        const key = exactKey(ownership.schema, table, captured.key);
        const at = Object.freeze({ table, key, rowKey: commandKeyText(key), now: now() });
        return scope.commandTransaction(
          async (records, journal) => {
            // The record as this member reads it: one they cannot see has no links for them.
            const found = await records.query({ table, columns: Object.keys(key), filter: keyFilter(key), limit: 2, offset: 0 });
            if (found.rows.length !== 1) throw new AppAccessDenied();
            return work(at, records, journal);
          },
          [table],
          [table],
        );
      },
      guard,
    );
  return Object.freeze({
    countLinks: (request: Request, selectors: readonly string[], value: RecordLinksRequest, guard?: TenantInvocationGuard) =>
      run(request, selectors, value, guard, async (at, _records, journal) =>
        typeof journal.countLinks === 'function' ? { live: await journal.countLinks(app.id, at.table, at.rowKey, at.now) } : denyTenant(),
      ),
    /* What the revoke returns is what it ended, counted in its own transaction, so the history and the reply say the
       same true number; a revoke of none changes nothing and notes nothing. */
    revokeLinks: (request: Request, selectors: readonly string[], value: RecordLinksRequest, guard?: TenantInvocationGuard) =>
      run(request, selectors, value, guard, async (at, records, journal) => {
        if (typeof journal.revokeLinks !== 'function') return denyTenant();
        const ended = await journal.revokeLinks(app.id, at.table, at.rowKey, undefined, at.now);
        if (ended) await records.noted?.({ table: at.table, key: at.key, action: revokedLinksAction(ended) });
        return { revoked: ended };
      }),
  });
}
