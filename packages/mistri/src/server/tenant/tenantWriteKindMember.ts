/**
 * A tenant member's writer transactions, ordinary and command. The fence is
 * the member's own membership and its tenant's row; the scope is its tenant's
 * rows, plus its own profile row for parent checks.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { runTenantManagedCommandTransaction, runTenantManagedTransaction } from './tenantManagedTransaction.js';
import type { TenantMembershipEvidence } from './tenantMembership.js';
import { composeTenantReadScope } from './tenantReadScope.js';
import { assertSqliteTenantMembershipSnapshot } from './tenantStore.js';
import { assertPostgresTenantMembershipFence, postgresTenantMembershipFenceAhead } from './tenantStorePostgres.js';
import { withOwnProfile, type TenantWriteKind, type TenantWriteOperation } from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantMemberWriteMethods = {
  /** `operation` is the host's own word for which of its operations ran. A
   * member's writes are not recorded, so this kind carries it and ignores it;
   * it exists here because one signature serves every kind. */
  transaction<T>(
    evidence: TenantMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction) => T | Promise<T>,
    assertActive?: () => void,
    operation?: TenantWriteOperation,
  ): Promise<T>;
  /** Private runtime journal only; no request/command/result authorization. */
  commandTransaction<T>(
    evidence: TenantMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
    operation?: TenantWriteOperation,
    /** The command's footprint, which bounds what it may insert unread or delete (scopedTransaction.ts ScopeBound). */
    footprint?: readonly string[],
  ): Promise<T>;
};

export const memberWriteKind = Object.freeze<TenantWriteKind<TenantMembershipEvidence, TenantMemberWriteMethods>>({
  realm: 'tenant',
  methods: (enter) => ({
    transaction: (evidence, rows, run, active, operation) => enter(false, evidence, rows, run, active, operation),
    commandTransaction: (evidence, rows, run, active, operation, footprint) =>
      enter(true, evidence, rows, (records, journal) => run(records, journal!), active, operation, footprint),
  }),
  capture: (evidence, rows) => captureTenantData({ evidence, rows }),
  scope: (owned, evidence, rows, allTrue) =>
    withOwnProfile(owned, composeTenantReadScope(owned, evidence, rows, allTrue), evidence.tenantId),
  /* The member's tenant within the command's footprint, the row policy left
     out: what the command itself may reach. Without a footprint, none. */
  bound: (owned, evidence, _rows, footprint, allTrue) =>
    footprint === undefined
      ? undefined
      : withOwnProfile(
          owned,
          composeTenantReadScope(
            owned,
            evidence,
            Object.fromEntries(Object.keys(owned.ownership).map((table) => [table, footprint.includes(table)])),
            allTrue,
          ),
          evidence.tenantId,
        ),
  sqliteFence: (db, evidence, { owner, live }) => assertSqliteTenantMembershipSnapshot(db, owner, evidence, live),
  postgresFenceHeld: true,
  postgresFence: (client, evidence, { owner, live }) => assertPostgresTenantMembershipFence(client, owner, evidence, live),
  postgresFenceAhead: (owner, evidence) => postgresTenantMembershipFenceAhead(owner, evidence),
  journalOwner: (owner, member) => ({
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    tenantId: member.tenantId,
    actorId: member.accountId,
    membershipId: member.membershipId,
    membershipVersion: member.membershipVersion,
    tenantVersion: member.tenantVersion,
    roles: member.roles,
    deployment: member.deployment,
  }),
  run: (owned, evidence, records, journal, command, run) =>
    command
      ? runTenantManagedCommandTransaction(owned, evidence, records, journal!, (records, journal) => run(records, journal))
      : runTenantManagedTransaction(owned, evidence, records, run),
});
