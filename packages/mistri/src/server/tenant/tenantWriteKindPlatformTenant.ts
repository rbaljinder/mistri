/**
 * A platform command's transaction in one named tenant: fenced on that
 * tenant's row and `@platform` at the versions the runtime read, and on the
 * platform membership, over the platform scope with every tenant table
 * narrowed to that tenant (tenantPlatformTenant.ts). Its receipt is the
 * platform realm's, under the member who ran it; its audit rows name the
 * tenant. Its evidence arrives only through its own method.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { runManagedCommandTransaction } from './tenantManagedTransaction.js';
import {
  capturePlatformTenantEvidence,
  composePlatformTenantScope,
  platformOf,
  platformTenantAnchor,
  type PlatformTenantEvidence,
} from './tenantPlatformTenant.js';
import { assertSqliteIntakeAnchorSnapshot, assertSqlitePlatformMembershipSnapshot } from './tenantStore.js';
import { assertPostgresIntakeAnchorFence, assertPostgresPlatformMembershipFence } from './tenantStorePostgres.js';
import type { TenantWriteKind } from './tenantWriteKindContract.js';
import { platformWriteKind } from './tenantWriteKindPlatform.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantPlatformTenantWriteMethods = {
  /** A platform command's transaction in the one tenant its request named:
   * fenced on that tenant, `@platform` and the platform membership, over the
   * platform scope with every tenant table narrowed to that tenant. */
  platformTenantCommandTransaction<T>(
    evidence: PlatformTenantEvidence,
    rows: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
};

export const platformTenantWriteKind = Object.freeze<TenantWriteKind<PlatformTenantEvidence, TenantPlatformTenantWriteMethods>>({
  realm: 'platform-tenant',
  methods: (enter) => ({
    platformTenantCommandTransaction: (evidence, rows, run, active) =>
      enter(true, evidence, rows, (records, journal) => run(records, journal!), active),
  }),
  capture: (evidence, rows) => ({ evidence: capturePlatformTenantEvidence(evidence), rows: captureTenantData(rows) }),
  scope: (owned, evidence, rows) => composePlatformTenantScope(owned, evidence, rows),
  /* Its scope is its bound: nothing is outside the principal's rows to insert
     into, and a row others reference is removed only where every referencing
     table is in the scope and, counted across all of its rows, holds none. */
  bound: (owned, evidence, rows) => composePlatformTenantScope(owned, evidence, rows),
  /* The tenant's row first, then `@platform`, then the membership: the member
     fence's order, so a suspension of either waits for this attempt or refuses it. */
  sqliteFence: (db, evidence, { owner, live }) => {
    assertSqliteIntakeAnchorSnapshot(db, owner, platformTenantAnchor(evidence), live);
    assertSqlitePlatformMembershipSnapshot(db, owner, platformOf(evidence), live);
  },
  postgresFenceHeld: true,
  postgresFence: async (client, evidence, { owner, live }) => {
    await assertPostgresIntakeAnchorFence(client, owner, platformTenantAnchor(evidence), live);
    await assertPostgresPlatformMembershipFence(client, owner, platformOf(evidence), live);
  },
  // The platform realm's receipt, under the member who ran it: the tenant is on each audit row.
  journalOwner: (owner, evidence) => platformWriteKind.journalOwner(owner, platformOf(evidence)),
  run: (owned, evidence, records, journal, _command, run) =>
    runManagedCommandTransaction(owned, evidence, records, journal!, (records, journal) => run(records, journal)),
});
