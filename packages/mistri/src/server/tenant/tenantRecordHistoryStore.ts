/**
 * Record history on a tenant App: which of its tables keep one, bound to the
 * deployment's own private writer, and the key a record's history is kept
 * and read under.
 *
 * The capture is the ordinary one (adapters/history/recordHistory.ts),
 * beneath the tenant writer's scoped transactions, so a member's Save, a
 * command in either realm, a public intake's step, a support operator's write
 * and an Undo all record alike, in the same transaction as the change. What
 * is the tenant's here is the key: a tenant-owned record's history is kept
 * under its key *and its owner*, read off the row inside the write, so the
 * store itself says whose each entry is. A reader asks for a record's history
 * only after reading the record in their own context, and under the owner
 * that context is: a member's own tenant, never an id a request names; the
 * platform realm's, the owner the row it just read says. The same key in
 * another tenant, or reused there after a delete, is another record's
 * history, found under another owner.
 *
 * A dashboard's activity feed reads the same store across resources. In a
 * tenant's context the store is asked for that tenant's rows alone, by the
 * owner each stored key names, and each record a row names is read in the
 * context and matched under this same key (recordActivity.ts, tenantHttp.ts).
 */
import { RecordHistoryUnavailable, type RecordHistoryBinding } from '../../adapters/history/recordHistory.js';
import { bindRecordHistory } from '../stores/writeCaptures.js';
import { storesOf } from '../stores/appStores.js';
import type { AppDef } from '../../shared/app.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { historyRules, withBookkeeping } from '../recordHistory.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';

/** The App's history tables, by the physical id the writer is asked them by, each tenant-owned one with its owner column. */
export function tenantHistoryBinding(app: AppDef, pages: readonly PageDef[], ownership: TenantOwnershipSnapshot): RecordHistoryBinding {
  const binding = new Map<string, { redact: 'values' | ReadonlySet<string>; owner?: string }>();
  for (const [resource, rule] of historyRules(app, pages)) {
    const physical = ownership.resources[resource],
      owned = ownership.ownership[resource];
    // A resource of a platform-only source keeps no history here: this writer never writes it.
    if (physical === undefined || owned === undefined) continue;
    if (owned.kind === 'global') continue;
    binding.set(physical, {
      ...withBookkeeping(rule, findTable(ownership.schema, resource)),
      ...(owned.kind === 'tenant' ? { owner: owned.column } : {}),
    });
  }
  return binding;
}

interface HistoryStoreAdapter {
  recordHistoryReady(): Promise<boolean>;
}

/**
 * Attest the store on the deployment's writer and bind the App's tables to
 * it, once, before the writer is published. A database without the store
 * refuses startup, naming the call that provisions it.
 */
export async function bindTenantRecordHistoryStore(
  /* The deployment's writer: a dialect adapter, whose App stores answer (stores/appStores.ts), or a store that answers itself. */
  adapter: object,
  binding: RecordHistoryBinding,
  dialect: 'sqlite' | 'postgres',
): Promise<void> {
  if (!binding.size) return;
  if (!(await (storesOf(adapter) as HistoryStoreAdapter).recordHistoryReady())) {
    const call = `provisionStores({ ${dialect === 'sqlite' ? 'sqlite: path' : 'postgres: url'} }, { only: ['record-history'] })`;
    throw new RecordHistoryUnavailable(
      `A page of this tenant App shows a record history, and its database holds no record history store. ` +
        `It is provisioned once, never on startup: run ${call} from @mistriwork/mistri/maintenance against the App's own database, then start again.`,
    );
  }
  bindRecordHistory(adapter, binding);
}

/**
 * The key a record's history is read under, for a reader in `tenantId`'s
 * context (a member's, or a support operator's inside it), or the platform
 * realm's when `tenantId` is undefined. `read` is what the visibility read
 * must also return: the owner column, where only the row can say whose it is.
 */
export function tenantHistoryStoreKey(ownership: TenantOwnershipSnapshot, tenantId: string | undefined) {
  return Object.freeze({
    read: (table: string): string[] => {
      const rule = ownership.ownership[table];
      return rule?.kind === 'tenant' && tenantId === undefined ? [rule.column] : [];
    },
    key: (
      table: string,
      key: Readonly<Record<string, string | number>>,
      row: Readonly<Record<string, unknown>>,
    ): Record<string, unknown> => {
      const rule = ownership.ownership[table];
      if (rule?.kind !== 'tenant') return { ...key };
      const owner = tenantId ?? row[rule.column];
      if (typeof owner !== 'string' || !owner) return denyTenant();
      return { ...key, [rule.column]: owner };
    },
  });
}
