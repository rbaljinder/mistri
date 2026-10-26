/**
 * A job's command transaction as its service principal: no membership, so no
 * membership fence. It is fenced on the anchors its attempt read — the event's
 * tenant's row and `@platform` for a tenant command, `@platform` alone for a
 * platform command — at those versions, over its command's footprint within
 * that tenant and, in the platform realm, the platform's own rows. The scope
 * is recomposed from the evidence, whatever footprint is passed.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { runManagedCommandTransaction } from './tenantManagedTransaction.js';
import {
  captureServiceEvidence,
  composeServiceScope,
  serviceAnchor,
  serviceJournalOwner,
  type TenantServiceEvidence,
} from './tenantServiceModel.js';
import { assertSqliteIntakeAnchorSnapshot } from './tenantStore.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { assertPostgresIntakeAnchorFence } from './tenantStorePostgres.js';
import { withOwnProfile, type TenantWriteKind, type TenantWriteRun } from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantServiceWriteMethods = {
  /** A job's command transaction as its service principal: no membership,
   * fenced on the event's tenant (for a tenant command) and `@platform` at the
   * versions its attempt read, over the footprint's `true` tables within that
   * tenant and, in the platform realm, the platform's own rows. */
  serviceCommandTransaction<T>(
    evidence: TenantServiceEvidence,
    footprint: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
};

function serviceScope(owned: TenantOwnershipSnapshot, evidence: TenantServiceEvidence, footprint: RowScope): RowScope {
  const scope = composeServiceScope(owned, evidence, footprint);
  // A tenant's row names its profile by the owner column: the parent check sees that one row.
  return evidence.place === 'tenant' ? withOwnProfile(owned, scope, evidence.tenantId!) : scope;
}

export const serviceWriteKind = Object.freeze<TenantWriteKind<TenantServiceEvidence, TenantServiceWriteMethods>>({
  realm: 'service',
  methods: (enter) => ({
    serviceCommandTransaction<T>(
      evidence: TenantServiceEvidence,
      footprint: RowScope,
      run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
      active?: () => void,
    ): Promise<T> {
      return enter(true, evidence, footprint, run as TenantWriteRun<T>, active);
    },
  }),
  capture: (evidence, footprint, owned) => ({ evidence: captureServiceEvidence(evidence, owned), rows: captureTenantData(footprint) }),
  scope: (owned, evidence, footprint) => serviceScope(owned, evidence, footprint),
  /* A service has no row policy: its footprint within the tenant is its scope
     and its bound alike, so it deletes a row others reference once each
     referencing table is in its footprint and nothing references the row. */
  bound: (owned, evidence, footprint) => serviceScope(owned, evidence, footprint),
  // Inside BEGIN IMMEDIATE: the anchors still active at the versions the attempt read.
  sqliteFence: (db, evidence, { owner, live }) => assertSqliteIntakeAnchorSnapshot(db, owner, serviceAnchor(evidence), live),
  // The anchors FOR SHARE, held to COMMIT: a suspension waits for this attempt, or committed first and refuses it.
  postgresFenceHeld: true,
  postgresFence: (client, evidence, { owner, live }) => assertPostgresIntakeAnchorFence(client, owner, serviceAnchor(evidence), live),
  journalOwner: (owner, evidence) => serviceJournalOwner(owner, evidence),
  run: (owned, evidence, records, journal, _command, run) => runManagedCommandTransaction(owned, evidence, records, journal!, run),
});
