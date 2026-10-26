/**
 * The platform realm's transactions: fenced on the platform membership and the
 * `@platform` row, over the platform scope. A command's, and an ordinary one —
 * a staff member's Save, New or Delete on the platform's own rows,
 * which its managed transaction holds to those rows alone. Its evidence
 * arrives only through its own methods.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { runManagedCommandTransaction, runManagedTransaction } from './tenantManagedTransaction.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';
import { composePlatformReadScope } from './tenantReadScope.js';
import { assertSqlitePlatformMembershipSnapshot } from './tenantStore.js';
import { assertPostgresPlatformMembershipFence } from './tenantStorePostgres.js';
import type { TenantWriteKind } from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantPlatformWriteMethods = {
  /** The platform realm's command transaction: fenced on the platform
   * membership and the `@platform` row, over the platform scope. */
  platformCommandTransaction<T>(
    evidence: PlatformMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
  /** The platform realm's ordinary transaction, for its generic edit: no
   * journal, and only the platform's own rows (tenantManagedKindPlatform.ts). */
  platformTransaction<T>(
    evidence: PlatformMembershipEvidence,
    rows: RowScope,
    run: (records: WriteTransaction) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
};

export const platformWriteKind = Object.freeze<TenantWriteKind<PlatformMembershipEvidence, TenantPlatformWriteMethods>>({
  realm: 'platform',
  methods: (enter) => ({
    platformCommandTransaction: (evidence, rows, run, active) =>
      enter(true, evidence, rows, (records, journal) => run(records, journal!), active),
    platformTransaction: (evidence, rows, run, active) => enter(false, evidence, rows, (records) => run(records), active),
  }),
  capture: (evidence, rows) => captureTenantData({ evidence, rows }),
  scope: (owned, evidence, rows) => composePlatformReadScope(owned, evidence, rows),
  sqliteFence: (db, evidence, { owner, live }) => assertSqlitePlatformMembershipSnapshot(db, owner, evidence, live),
  postgresFenceHeld: true,
  postgresFence: (client, evidence, { owner, live }) => assertPostgresPlatformMembershipFence(client, owner, evidence, live),
  journalOwner: (owner, platformMember) => ({
    realm: 'platform' as const,
    appId: owner.appId,
    storeId: owner.storeId,
    sourceId: owner.source.id,
    actorId: platformMember.accountId,
    membershipId: platformMember.membershipId,
    membershipVersion: platformMember.membershipVersion,
    platformVersion: platformMember.platformVersion,
    roles: platformMember.roles,
    deployment: platformMember.deployment,
  }),
  run: (owned, evidence, records, journal, command, run) =>
    command
      ? runManagedCommandTransaction(owned, evidence, records, journal!, (records, journal) => run(records, journal))
      : runManagedTransaction(owned, evidence, records, run),
});
