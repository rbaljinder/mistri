/**
 * A support operator's audited writer ("enter as dealer"): the dealer's own
 * rows, with one audit entry appended for every row inserted, updated or
 * removed — in the business write's own transaction, on the same handle and
 * the same fence. Either the change and its record both land, or neither does.
 *
 * The fence is the support row itself, re-observed on the writer with its
 * parent platform membership, `@platform` and the dealer
 * (tenantSupportMembership*.ts), in the lock order every support operation
 * takes. A session whose parent was revoked, whose dealer went inactive or
 * whose own row moved cannot write.
 *
 * What an entry keeps: the resource, the operation, the row's key, and the
 * values — except the columns `resources.<r>.audit` marks, which are kept as a
 * keyed hash. An update records the before and after of the columns it
 * touched; a delete keeps its whole before image under the same rule. An entry
 * too large for the store is refused, and so is the write: a support change is
 * never applied with a truncated record of it.
 *
 * This kind grants nothing on its own. A support lease is still refused by
 * every request family (tenantContexts.ts), so the only caller that can reach
 * these methods is a holder of issued support evidence — the tests, until the
 * request path opens.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  DeleteRequest,
  InsertRequest,
  TransactionOperations,
  UpdateRequest,
  WriteTransaction,
} from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { PgQuery } from '@mistriwork/engine/adapters/postgresPool.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData, denyTenant } from '@mistriwork/engine/server/evidence.js';
import { runManagedCommandTransaction, runManagedTransaction } from './tenantManagedTransaction.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { composeTenantReadScope } from './tenantReadScope.js';
import { createSqliteSupportAudit } from './tenantSupportAudit.js';
import { createPostgresSupportAudit } from './tenantSupportAuditPostgres.js';
import { keyId, supportRedacted, type SupportAuditKey, type SupportEntry } from './tenantSupportAuditContract.js';
import type { SupportMembershipEvidence } from './tenantSupportLease.js';
import { observePostgresSupportMembership } from './tenantSupportMembershipPostgres.js';
import { observeSqliteSupportMembership } from './tenantSupportMembershipSqlite.js';
import { assertSupportEvidenceObserved } from './tenantSupportMembership.js';
import {
  withOwnProfile,
  type TenantWriteAudit,
  type TenantWriteFence,
  type TenantWriteKind,
  type TenantWriteOperation,
  type TenantWriteSink,
} from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantSupportWriteMethods = {
  /** Save, New and Delete inside a dealer, each one recorded. `operation` is
   * the host's own word for which of its operations ran — Undo passes 'undo' —
   * and decides the entry's kind, never what it says the database did. */
  supportTransaction<T>(
    evidence: SupportMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction) => T | Promise<T>,
    assertActive?: () => void,
    operation?: TenantWriteOperation,
  ): Promise<T>;
  /** A command inside a dealer: its row changes are recorded the same way. */
  supportCommandTransaction<T>(
    evidence: SupportMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
    operation?: TenantWriteOperation,
  ): Promise<T>;
};

/** What a sink was opened with, held beside it rather than passed through the
 * generic contract: the audit key, the App's redaction rule, the session the
 * entries belong to, and the source's own clock. Keyed by the sink object, so
 * a fabricated sink carries no rule and records nothing. */
interface SinkRule {
  readonly key: SupportAuditKey;
  readonly redact: Readonly<Record<string, 'values' | readonly string[]>>;
  readonly evidence: SupportMembershipEvidence;
  now(): number;
}
const rules = new WeakMap<TenantWriteSink, SinkRule>();

const member = (evidence: SupportMembershipEvidence) => ({
  appId: evidence.appId,
  accountId: evidence.accountId,
  tenantId: evidence.tenantId,
  source: evidence.source,
  deployment: evidence.deployment,
  membershipId: evidence.membershipId,
  membershipVersion: evidence.membershipVersion,
  tenantVersion: evidence.tenantVersion,
  roles: [...evidence.roles],
  verifiedAt: evidence.verifiedAt,
  validUntil: evidence.validUntil,
});

/* The observation-versus-evidence comparison lives in tenantSupportMembership.ts
   (assertSupportEvidenceObserved): the read source fences the same way, and two
   copies of this rule could drift into letting a session act on versions it was
   never admitted for. */

const sinkFor = (append: (sessionId: string, entry: SupportEntry) => Promise<unknown>, rule: SinkRule): TenantWriteSink => {
  const sink: TenantWriteSink = Object.freeze({
    append: async (entry: SupportEntry) => {
      await append(rule.evidence.supportId, entry);
    },
  });
  rules.set(sink, rule);
  return sink;
};

/** The records facade the handler actually writes through: every row operation
 * is performed and then recorded, before the next one runs. An update's and a
 * delete's before image is read on this same transaction, through the same
 * scoped facade, so it is the row the change is about to touch and nothing
 * wider. */
function audited(records: WriteTransaction, sink: TenantWriteSink, requestId: string, did: 'write' | 'undo'): WriteTransaction {
  const rule = rules.get(sink) ?? denyTenant();
  const { key, redact, evidence } = rule;
  const versions = {
    tenantVersion: evidence.tenantVersion,
    supportMembershipVersion: evidence.membershipVersion,
    parentMembershipVersion: evidence.parentVersion,
    platformVersion: evidence.platformVersion,
  };
  const shown = (resource: string, values: Readonly<Record<string, unknown>>): Record<string, unknown> => {
    const marked = redact[resource];
    const out: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(values)) {
      out[column] =
        marked !== undefined && (marked === 'values' || marked.includes(column)) ? supportRedacted(key, resource, column, value) : value;
    }
    return out;
  };
  const record = async (
    resource: string,
    operation: 'insert' | 'update' | 'delete',
    rowKey: Record<string, unknown>,
    detail: Record<string, unknown>,
  ) => {
    /* Two facts, kept apart: `kind` is what the person did (a write, or an
       Undo of one) and `operation` is what the database did to the row. A
       reader of the dealer's log wants both, and the store already holds the
       first in its own column, so neither needs a new field. */
    const entry: SupportEntry = {
      kind: did,
      at: new Date(rule.now()).toISOString(),
      requestId,
      actorId: evidence.accountId,
      ...versions,
      resource,
      operation,
      keyJson: JSON.stringify(rowKey),
      detailJson: JSON.stringify(detail),
      commandReceiptId: null,
    };
    await sink.append(entry);
  };
  /** The stored row a key names, on this transaction. */
  const stored = async (table: string, rowKey: Readonly<Record<string, unknown>>) => {
    const groups = [Object.entries(rowKey).map(([column, value]) => ({ column, op: '=' as const, value: value as string | number }))];
    const found = await records.query({ table, filter: { groups }, limit: 1, offset: 0 });
    return found.rows[0] as Record<string, unknown> | undefined;
  };
  return Object.freeze<WriteTransaction>({
    query: (request) => records.query(request),
    count: (table, filter) => records.count(table, filter),
    insert: async (request: InsertRequest) => {
      const result = await records.insert(request);
      await record(request.table, 'insert', result.key as Record<string, unknown>, {
        after: shown(request.table, (result.row ?? request.values) as Record<string, unknown>),
      });
      return result;
    },
    update: async (request: UpdateRequest) => {
      const before = await stored(request.table, request.key);
      const result = await records.update(request);
      // Only the columns this change touched, on both sides: the entry says
      // what the operator changed, not the whole row they happened to open.
      const touched = Object.keys(request.values);
      const previous = Object.fromEntries(touched.map((column) => [column, before?.[column] ?? null]));
      await record(request.table, 'update', request.key as Record<string, unknown>, {
        before: shown(request.table, previous),
        after: shown(request.table, request.values),
      });
      return result;
    },
    remove: async (request: DeleteRequest) => {
      const before = await stored(request.table, request.key);
      const result = await records.remove(request);
      // A delete keeps its whole before image: after this commit the row is
      // the only place it existed, and the log is what is left of it.
      await record(request.table, 'delete', request.key as Record<string, unknown>, {
        before: before === undefined ? null : shown(request.table, before),
      });
      return result;
    },
  });
}

export const supportWriteKind = Object.freeze<TenantWriteKind<SupportMembershipEvidence, TenantSupportWriteMethods>>({
  realm: 'support',
  methods: (enter) => ({
    supportTransaction: (evidence, rows, run, active, operation) => enter(false, evidence, rows, run, active, operation),
    supportCommandTransaction: (evidence, rows, run, active, operation) =>
      enter(true, evidence, rows, (records, journal) => run(records, journal!), active, operation),
  }),
  capture: (evidence, rows) => captureTenantData({ evidence, rows }),
  /* A support lease reads and writes what its dealer's role does: the tenant
     composer's own rules, on the one role the session holds. */
  scope: (owned, evidence, rows, allTrue) =>
    withOwnProfile(owned, composeTenantReadScope(owned, member(evidence), rows, allTrue), evidence.tenantId),
  sqliteFence: (db, evidence, { owner, live }: TenantWriteFence) => {
    const at = live();
    assertSupportEvidenceObserved(
      observeSqliteSupportMembership(db, owner, {
        supportId: evidence.supportId,
        accountId: evidence.accountId,
        tenantId: evidence.tenantId,
        at,
      }),
      evidence,
      at,
    );
  },
  postgresFence: async (client, evidence, { owner, live }: TenantWriteFence) => {
    const at = live();
    assertSupportEvidenceObserved(
      await observePostgresSupportMembership(client, owner, {
        supportId: evidence.supportId,
        accountId: evidence.accountId,
        tenantId: evidence.tenantId,
        at,
      }),
      evidence,
      at,
    );
  },
  sqliteSink: (
    db: DatabaseSync,
    evidence,
    { owner, live }: TenantWriteFence,
    operations: TransactionOperations,
    audit: TenantWriteAudit,
  ) => {
    keyId(audit.key);
    const store = createSqliteSupportAudit(db, operations, owner, audit.key, () => {
      live();
    });
    return sinkFor((sessionId, entry) => store.append(sessionId, entry), { key: audit.key, redact: audit.redact, evidence, now: live });
  },
  postgresSink: (
    client: PgQuery,
    evidence,
    { owner, live }: TenantWriteFence,
    operations: TransactionOperations,
    audit: TenantWriteAudit,
  ) => {
    keyId(audit.key);
    const store = createPostgresSupportAudit(client, operations, owner, audit.key, () => {
      live();
    });
    return sinkFor((sessionId, entry) => store.append(sessionId, entry), { key: audit.key, redact: audit.redact, evidence, now: live });
  },
  journalOwner: (owner, evidence) => ({
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    tenantId: evidence.tenantId,
    actorId: evidence.accountId,
    membershipId: evidence.membershipId,
    membershipVersion: evidence.membershipVersion,
    tenantVersion: evidence.tenantVersion,
    roles: evidence.roles,
    deployment: evidence.deployment,
  }),
  run: (owned: TenantOwnershipSnapshot, evidence, records, journal, command, run, sink, operation) => {
    // No sink means the source was opened without the audit key, so there is
    // no way to record this change: refuse rather than apply it unrecorded.
    if (!sink || !rules.has(sink)) return denyTenant();
    const watched = audited(records, sink, randomUUID(), operation === 'undo' ? 'undo' : 'write');
    return command
      ? runManagedCommandTransaction(owned, evidence, watched, journal!, (records, receipts) => run(records, receipts))
      : runManagedTransaction(owned, evidence, watched, (records) => run(records));
  },
});
