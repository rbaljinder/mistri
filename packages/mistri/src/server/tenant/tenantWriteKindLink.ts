/**
 * A capability link's command transaction in a tenant App: no membership, so no membership fence. It is fenced on
 * the anchors its request read — the link's tenant's row and `@platform` — at those versions, and then on the link
 * row itself, still live, over its one record within that tenant. The scope is recomposed from the evidence,
 * whatever footprint is passed: a footprint can narrow it, never widen it.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { runManagedCommandTransaction } from './tenantManagedTransaction.js';
import {
  assertPostgresLinkHeld,
  assertSqliteLinkLive,
  captureLinkEvidence,
  composeLinkScope,
  linkAnchor,
  linkJournalOwner,
  type TenantLinkEvidence,
} from './tenantLinkModel.js';
import { assertSqliteIntakeAnchorSnapshot } from './tenantStore.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { assertPostgresIntakeAnchorFence } from './tenantStorePostgres.js';
import { TenantLinkMoved, withOwnProfile, type TenantWriteKind, type TenantWriteRun } from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantLinkWriteMethods = {
  /** A link's transaction: fenced on its tenant and `@platform` at the versions its request read and on the link
   * row, live, over the footprint's `true` tables narrowed to the link's one record of that tenant. */
  linkCommandTransaction<T>(
    evidence: TenantLinkEvidence,
    footprint: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
};

function linkScope(owned: TenantOwnershipSnapshot, evidence: TenantLinkEvidence, footprint: RowScope): RowScope {
  // A tenant's row names its profile by the owner column: the parent check sees that one row.
  return withOwnProfile(owned, composeLinkScope(owned, evidence, footprint), evidence.tenantId);
}

export const linkWriteKind = Object.freeze<TenantWriteKind<TenantLinkEvidence, TenantLinkWriteMethods>>({
  realm: 'link',
  methods: (enter) => ({
    linkCommandTransaction<T>(
      evidence: TenantLinkEvidence,
      footprint: RowScope,
      run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
      active?: () => void,
    ): Promise<T> {
      return enter(true, evidence, footprint, run as TenantWriteRun<T>, active);
    },
  }),
  capture: (evidence, footprint, owned) => ({ evidence: captureLinkEvidence(evidence, owned), rows: captureTenantData(footprint) }),
  scope: (owned, evidence, footprint) => linkScope(owned, evidence, footprint),
  /* A link has no row policy: its record within the tenant is its scope and its bound alike, so it deletes its row
     once nothing else references it — the declared command decides whether it may. */
  bound: (owned, evidence, footprint) => linkScope(owned, evidence, footprint),
  // Inside BEGIN IMMEDIATE: the anchors still active at the versions the request read, then the link still live.
  sqliteFence: (db, evidence, { owner, live }) => {
    assertSqliteIntakeAnchorSnapshot(db, owner, linkAnchor(evidence), live);
    assertSqliteLinkLive(db, owner, evidence, live());
  },
  /* Before COMMIT the anchors again, but not the link: its own delete, or the door's revoke of a row gone, revokes it
     in this transaction, and no other writer has run since the first pass found it live. */
  sqliteFenceAfter: (db, evidence, { owner, live }) => assertSqliteIntakeAnchorSnapshot(db, owner, linkAnchor(evidence), live),
  /* The anchors and then the link row FOR SHARE, held to COMMIT, in that order always: a suspension or a revoke
     waits for this attempt, or committed first and refuses it. */
  postgresFenceHeld: true,
  postgresFence: async (client, evidence, { owner, live }) => {
    await assertPostgresIntakeAnchorFence(client, owner, linkAnchor(evidence), live);
    await assertPostgresLinkHeld(client, owner, evidence, live());
  },
  // A fence that fails before the handler starts is a link that moved since its request read it, not a store that cannot answer.
  moved: () => new TenantLinkMoved(),
  journalOwner: (owner, evidence) => linkJournalOwner(owner, evidence),
  run: (owned, evidence, records, journal, _command, run) => runManagedCommandTransaction(owned, evidence, records, journal!, run),
});
