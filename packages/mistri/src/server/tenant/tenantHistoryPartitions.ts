import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { snapshotScopedData } from '@mistriwork/engine/adapters/scoped/scopedReads.js';
import { clearJournal, forget, history, quarantineHistory, recordWrite, type JournalEntry } from '@mistriwork/engine/server/journal.js';
import type { HistoryDraft } from '@mistriwork/engine/server/recordHistoryOperations.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import { isPostgresTenantLocator, type TenantSourceIdentity } from './tenantSourceIdentity.js';

export class TenantHistoryBusy extends Error {
  readonly code = 'tenant_history_busy';
  constructor() {
    super('The tenant history is already in use.');
    this.name = 'TenantHistoryBusy';
  }
}
export interface TenantHistoryLease {
  /** Opaque private journal bucket, never a public connection or credential. */
  readonly id: string;
  history(): JournalEntry[];
  /** Public-facing opaque references never disclose the shared journal counter. */
  token(id: number): string;
  resolve(token: string): number | undefined;
  publish(entry: HistoryDraft): JournalEntry;
  quarantine(): void;
  beginUndo(id: number): void;
  finishUndo(id: number): void;
  failUndo(id: number, unknown: boolean): void;
  release(): void;
}
interface TenantHistoryPartitions {
  enter(principal: TenantMembershipEvidence): TenantHistoryLease;
  dispose(): void;
}
interface Bucket {
  id: string;
  busy: boolean;
  pending?: number;
  tokens: Map<number, string>;
  ids: Map<string, number>;
}

/** Private in-memory partition owner over the existing journal. Identity and
 * principal are captured host evidence, not admitted credentials. The service
 * must supply its paired source identity and freshly authorized principal.
 * Retirement stops new leases immediately; accepted leases can finish, and
 * their private buckets are cleared on release. No other journals are cleared. */
export function createTenantHistoryPartitions(input: TenantSourceIdentity, deploymentInput: string): TenantHistoryPartitions {
  const identity = captureTenantData(input),
    deployment = captureTenantData(deploymentInput);
  tenantRecord(identity, ['canonicalPath', 'appId', 'source', 'storeId']);
  tenantIdentifier(identity.canonicalPath, 32_768);
  if (!isAbsolute(identity.canonicalPath) && !isPostgresTenantLocator(identity.canonicalPath)) return denyTenant();
  tenantIdentifier(identity.appId);
  tenantIdentifier(identity.storeId);
  tenantIdentifier(deployment);
  tenantRecord(identity.source, ['id', 'connection']);
  tenantIdentifier(identity.source.id);
  tenantIdentifier(identity.source.connection, 1024);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(identity.source.id)) return denyTenant();
  const buckets = new Map<string, Bucket>();
  let disposed = false;
  const remove = (key: string, bucket: Bucket) => {
    clearJournal(bucket.id);
    bucket.tokens.clear();
    bucket.ids.clear();
    buckets.delete(key);
  };
  const trim = (bucket: Bucket) => {
    const retained = new Set(history(bucket.id, 50).map((entry) => entry.id));
    if (bucket.pending !== undefined) retained.add(bucket.pending);
    for (const [id, token] of bucket.tokens)
      if (!retained.has(id)) {
        bucket.tokens.delete(id);
        bucket.ids.delete(token);
      }
  };
  return Object.freeze({
    enter(input: TenantMembershipEvidence): TenantHistoryLease {
      if (disposed) return denyTenant();
      const principal = captureTenantData(input);
      tenantRecord(principal, [
        'appId',
        'accountId',
        'tenantId',
        'source',
        'deployment',
        'membershipId',
        'membershipVersion',
        'tenantVersion',
        'roles',
        'verifiedAt',
        'validUntil',
      ]);
      tenantRecord(principal.source, ['id', 'connection']);
      if (
        principal.appId !== identity.appId ||
        principal.source.id !== identity.source.id ||
        principal.source.connection !== identity.source.connection ||
        principal.deployment !== deployment
      )
        return denyTenant();
      parseTenantSelector([principal.tenantId]);
      tenantIdentifier(principal.accountId, 1024);
      tenantIdentifier(principal.membershipId, 1024);
      for (const revision of [principal.membershipVersion, principal.tenantVersion]) {
        if (typeof revision !== 'string' || revision.length > 128 || !/^[1-9][0-9]*$/.test(revision)) return denyTenant();
      }
      if (!Array.isArray(principal.roles) || principal.roles.length > 256 || new Set(principal.roles).size !== principal.roles.length)
        return denyTenant();
      for (const role of principal.roles) tenantIdentifier(role);
      if (
        !Number.isSafeInteger(principal.verifiedAt) ||
        principal.verifiedAt < 0 ||
        !Number.isSafeInteger(principal.validUntil) ||
        principal.validUntil <= principal.verifiedAt
      )
        return denyTenant();
      // JSON tuples are unambiguous even when opaque account/grant IDs contain
      // separators. Admission clocks renew a lease, not its history partition.
      const key = JSON.stringify([
        identity.canonicalPath,
        identity.storeId,
        identity.appId,
        identity.source.id,
        identity.source.connection,
        deployment,
        principal.tenantId,
        principal.accountId,
        principal.membershipId,
        principal.membershipVersion,
        principal.tenantVersion,
        [...principal.roles].sort(),
      ]);
      let bucket = buckets.get(key);
      if (bucket?.busy) throw new TenantHistoryBusy();
      if (!bucket) {
        if (buckets.size >= 1024) return denyTenant();
        bucket = { id: `tenant-history:${randomUUID()}`, busy: false, tokens: new Map(), ids: new Map() };
        buckets.set(key, bucket);
      }
      const owned = bucket;
      owned.busy = true;
      let released = false;
      const active = () => {
        if (released) denyTenant();
      };
      const canonical = (id: number): JournalEntry => {
        active();
        if (!Number.isSafeInteger(id) || id < 1) return denyTenant();
        const latest = history(owned.id, 50)[0];
        if (
          !latest ||
          latest.id !== id ||
          latest.connection !== owned.id ||
          latest.principal !== principal.accountId ||
          latest.app !== identity.appId
        )
          return denyTenant();
        return latest;
      };
      const quarantine = () => {
        // A retained released lease cannot change a later lease's history.
        if (released) return;
        quarantineHistory(owned.id);
      };
      const pending = (id: number) => {
        const entry = canonical(id);
        if (owned.pending !== id || entry.undoState !== 'pending') return denyTenant();
        return entry;
      };
      return Object.freeze({
        id: owned.id,
        history: () => {
          active();
          trim(owned);
          return captureTenantData(history(owned.id, 50));
        },
        token(id: number): string {
          active();
          trim(owned);
          if (
            !Number.isSafeInteger(id) ||
            id < 1 ||
            !history(owned.id, 50).some(
              (entry) =>
                entry.id === id && entry.connection === owned.id && entry.principal === principal.accountId && entry.app === identity.appId,
            )
          )
            return denyTenant();
          let token = owned.tokens.get(id);
          if (token === undefined) {
            token = randomUUID();
            owned.tokens.set(id, token);
            owned.ids.set(token, id);
          }
          return token;
        },
        resolve(token: string): number | undefined {
          active();
          trim(owned);
          // No coercion, global ID lookup or fallback to another partition.
          return typeof token === 'string' ? owned.ids.get(token) : undefined;
        },
        publish(input: HistoryDraft): JournalEntry {
          active();
          if (owned.pending !== undefined) throw new TenantHistoryBusy();
          // Keep the existing bounded journal snapshot contract and normal
          // mutable canonical shape; neither the caller nor result owns it.
          const draft = structuredClone(snapshotScopedData(captureTenantData(input)));
          tenantRecord(draft, ['kind', 'summary', 'by', 'principal', 'app', 'revertible', 'reason', 'undoState', 'blocksUndo', 'steps']);
          if (
            !['update', 'insert', 'delete', 'insert_graph', 'delete_graph', 'sql'].includes(draft.kind) ||
            typeof draft.summary !== 'string' ||
            typeof draft.revertible !== 'boolean' ||
            !Array.isArray(draft.steps) ||
            (draft.reason !== undefined && typeof draft.reason !== 'string') ||
            (draft.blocksUndo !== undefined && typeof draft.blocksUndo !== 'boolean') ||
            (draft.undoState !== undefined && draft.undoState !== 'unknown')
          )
            return denyTenant();
          for (const step of draft.steps) {
            tenantRecord(step, ['table', 'key', 'before', 'after', 'wholeRow', 'exactFields']);
            tenantIdentifier(step.table, 1024);
            for (const image of [step.key, step.before, step.after]) if (image !== undefined) tenantRecord(image);
            if (
              (step.wholeRow !== undefined && typeof step.wholeRow !== 'boolean') ||
              (step.exactFields !== undefined && typeof step.exactFields !== 'boolean')
            )
              return denyTenant();
          }
          const entry = recordWrite(owned.id, { ...draft, principal: principal.accountId, app: identity.appId, by: principal.accountId });
          trim(owned);
          return captureTenantData(entry);
        },
        quarantine,
        beginUndo(id: number): void {
          const entry = canonical(id);
          if (owned.pending !== undefined || entry.undoState || entry.blocksUndo || !entry.revertible) return denyTenant();
          entry.undoState = 'pending';
          owned.pending = id;
        },
        finishUndo(id: number): void {
          pending(id);
          // The caller owns commit classification. Never forget from inside
          // the writer callback or after an unknown acknowledgement.
          forget(owned.id, id);
          owned.pending = undefined;
          trim(owned);
        },
        failUndo(id: number, unknown: boolean): void {
          const entry = pending(id);
          if (typeof unknown !== 'boolean') return denyTenant();
          if (unknown) quarantine();
          else delete entry.undoState;
          owned.pending = undefined;
        },
        release(): void {
          if (released) return;
          // A dropped pending attempt has no known rollback acknowledgement.
          if (owned.pending !== undefined) {
            quarantine();
            owned.pending = undefined;
          }
          released = true;
          owned.busy = false;
          if (disposed) remove(key, owned);
        },
      });
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const [key, bucket] of buckets) if (!bucket.busy) remove(key, bucket);
    },
  });
}
