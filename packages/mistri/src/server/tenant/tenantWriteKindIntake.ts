/**
 * Public intake's command transaction: no membership, so no membership fence.
 * It is fenced on the anchor the reader resolved (a tenant's row, or
 * `@platform`) at its version, over that place's scope within the footprint's
 * `true` tables, inserts only. The scope is recomposed from the evidence,
 * whatever footprint is passed. When what resolution read has moved since, the
 * refusal is TenantIntakeMoved and the runtime resolves once more.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import {
  assertIntakeHeld,
  captureIntakeEvidence,
  composeIntakeScope,
  intakeAddressQuery,
  intakeJournalOwner,
  intakePlace,
  type TenantIntakeEvidence,
} from './tenantIntakeModel.js';
import { runManagedCommandTransaction } from './tenantManagedTransaction.js';
import { assertSqliteIntakeAnchorSnapshot } from './tenantStore.js';
import { assertPostgresIntakeAnchorFence } from './tenantStorePostgres.js';
import { TenantIntakeMoved, withOwnProfile, type TenantWriteKind, type TenantWriteRun } from './tenantWriteKindContract.js';

// A structural alias, not an interface: the published declarations expand it
// into TenantWriteSource without this module exporting another name.
type TenantIntakeWriteMethods = {
  /** Public intake's command transaction: no membership, fenced on the anchor
   * the reader resolved (a tenant's row or `@platform`) at its version, over
   * that place's scope within the footprint's `true` tables, inserts only. */
  intakeCommandTransaction<T>(
    evidence: TenantIntakeEvidence,
    footprint: RowScope,
    run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
    assertActive?: () => void,
  ): Promise<T>;
};

export const intakeWriteKind = Object.freeze<TenantWriteKind<TenantIntakeEvidence, TenantIntakeWriteMethods>>({
  realm: 'intake',
  methods: (enter) => ({
    intakeCommandTransaction<T>(
      evidence: TenantIntakeEvidence,
      footprint: RowScope,
      run: (records: WriteTransaction, journal: CommandJournal) => T | Promise<T>,
      active?: () => void,
    ): Promise<T> {
      return enter(true, evidence, footprint, run as TenantWriteRun<T>, active);
    },
  }),
  capture: (evidence, footprint, owned) => ({ evidence: captureIntakeEvidence(evidence, owned), rows: captureTenantData(footprint) }),
  scope: (owned, member, footprint) => {
    const scope = composeIntakeScope(owned, member, footprint);
    // A tenant's new row names its profile by the owner column: the parent check sees that one row.
    return intakePlace(member) === 'tenant' ? withOwnProfile(owned, scope, member.tenantId) : scope;
  },
  // What resolution read, again before the handler starts: the anchors at
  // their versions, and the address still the tenant's.
  sqliteFence: (db, member, { owner, owned, live }) => {
    assertSqliteIntakeAnchorSnapshot(db, owner, member, live);
    if (intakePlace(member) === 'tenant')
      assertIntakeHeld(member, db.prepare(intakeAddressQuery(owned, member.column)).all(member.address));
  },
  // The anchor FOR SHARE, held to COMMIT, active at the same version: the
  // membership fence's first lock, in its order, with no membership row.
  postgresFenceHeld: true,
  postgresFence: async (client, member, { owner, owned, live }) => {
    await assertPostgresIntakeAnchorFence(client, owner, member, live);
    // The tenant's profile row FOR SHARE, to COMMIT: a rotation of its
    // address waits for this submission, or committed first and is seen.
    if (intakePlace(member) === 'tenant')
      assertIntakeHeld(member, (await client.query(`${intakeAddressQuery(owned, member.column)} FOR SHARE`, [member.address])).rows);
  },
  journalOwner: (owner, member) => intakeJournalOwner(owner, member),
  run: (owned, member, records, journal, _command, run) => runManagedCommandTransaction(owned, member, records, journal!, run),
  moved: () => new TenantIntakeMoved(),
});
