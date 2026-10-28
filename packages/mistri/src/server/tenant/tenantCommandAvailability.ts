/**
 * A whole visibility batch inside the request's one read snapshot.
 *
 * A tenant request owns exactly one transaction — `attempted` in
 * tenantRequestRuntime.ts, and its twin in tenantPlatformCommands.ts — because
 * one request is one write. Availability asks about several commands at once,
 * and opening one per check refused every check after the first, so the batch
 * has always been one: over the union of the footprints its checks declared,
 * each check judged under its own command's authorized view
 * (runTenantCommandTransaction). The union widens nothing: each check still
 * reads through its own command's footprint, intersected with the same
 * mandatory tenant row scope a single check was.
 *
 * It is a read snapshot, not the writer's command transaction. Its answer is
 * advice — which verbs a record offers — and never authority: the command's
 * own transaction reads its target again, at the revision the form saw, in the
 * state its `when` requires, and asks the same availability hook before its
 * handler runs (businessCommandExecution.ts), so a stale "yes" becomes a
 * refusal there, never a write. As a command transaction the batch held the
 * one writer for about fifty statements — the store attested twice, the
 * catalog described, its fences — in front of whatever the member did next.
 * The snapshot has the fence every read has: the membership revalidated in it,
 * then the reads, all of one state; and the request's admission and final
 * fence are unchanged. Its records refuse every write.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import type { BusinessCommandAuthorization } from '../commands/businessCommandAuthorization.js';
import { collectCommandAvailability, readCommandAvailability } from '../commands/commandAvailability.js';
import type { CommandAvailabilityCheck, CommandAvailabilityResult } from '../commands/commandPayload.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import { runTenantCommandTransaction } from './tenantCommandTransaction.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { CommandFlags } from '../commands/commandFlags.js';

/** What the batch needs of either realm's request scope. */
interface AvailabilityScope {
  readonly principal: Parameters<typeof runTenantCommandTransaction>[1]['principal'];
  readonly grants: ResourceAccess;
  session(): Promise<void>;
  advisoryReads<T>(run: (records: WriteTransaction) => T | Promise<T>, read: readonly string[]): Promise<T>;
}

/* Local: every caller hands in a literal, so the name is never written elsewhere. */
interface TenantAvailabilityBatch {
  readonly checks: readonly CommandAvailabilityCheck[];
  readonly ownership: TenantOwnershipSnapshot;
  readonly scope: AvailabilityScope;
  /** Authorize one check, or refuse it: the refusal is this check's `false`. */
  authorize(command: string): BusinessCommandAuthorization;
  extractor(command: string): (result: unknown) => readonly CommandResultReference[];
  readonly signal: AbortSignal;
  readonly requestId?: string;
  readonly captureFlags?: () => Promise<CommandFlags>;
}

export async function collectTenantAvailability(batch: TenantAvailabilityBatch): Promise<CommandAvailabilityResult> {
  const { checks, ownership, scope, signal } = batch;
  const options = batch.requestId === undefined ? {} : { requestId: batch.requestId };
  const footprint = new Set<string>();
  // A check this member may not run contributes no footprint; the same refusal
  // answers it below, one check at a time rather than for the whole batch.
  for (const check of checks) {
    try {
      for (const table of batch.authorize(check.command).read) footprint.add(table);
    } catch {
      /* answered false below */
    }
  }
  const refuse = async (): Promise<readonly boolean[]> => {
    throw new AppAccessDenied();
  };
  if (!footprint.size) return collectCommandAvailability(checks, refuse, signal);
  const flags = await batch.captureFlags?.();
  return scope.advisoryReads(
    (records) =>
      collectCommandAvailability(
        checks,
        async (check) => {
          const authorization = batch.authorize(check.command);
          return runTenantCommandTransaction(ownership, scope, authorization, records, undefined, batch.extractor(check.command), (tx) =>
            readCommandAvailability({
              check,
              command: authorization.command,
              actor: authorization.actor,
              catalog: authorization.catalog,
              ...(authorization.people ? { people: authorization.people } : {}),
              machine: authorization.machine,
              reader: tx.records,
              signal,
              flags,
              ...options,
              assertTarget: (key) => tx.target(key),
            }),
          );
        },
        signal,
        // Each check reads through its own operations over the one snapshot, which sends a read as soon as it is
        // asked (tenantReadSource.ts readBatch): asked in turn, six action guards were six round trips per record page.
        { concurrent: true },
      ),
    [...footprint],
  );
}
