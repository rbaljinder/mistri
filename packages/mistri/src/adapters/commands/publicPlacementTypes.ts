/** Trusted source-owner contracts for placed public writes and original-owner recovery. */
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal } from './commandJournalTypes.js';

/** Trusted source-owner identity. The owner pins this identity to the physical
 * adapter; neither a request nor a command handler may choose it. */
export interface PublicPlacementOwner {
  readonly issuerId: string;
  readonly sourceIdentity: string;
  readonly appId: string;
  readonly form: string;
  readonly tenant: string;
  readonly commandId: string;
  readonly commandVersion: number;
}

export interface PublicPlacementAnchor {
  /** Exact physical catalog ID, translated by the enrolled source owner. */
  readonly table: string;
  readonly key: Readonly<Record<string, string | number>>;
  readonly expected: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PublicPlacementAdmission extends PublicPlacementOwner {
  /** Provenance only: never part of receipt uniqueness. */
  readonly epoch: string;
  readonly anchors: readonly PublicPlacementAnchor[];
}

/** Runtime composition only. A business handler receives its command facade,
 * never this journal, the writer, eligibility anchors or lock capability. */
export type PublicPlacementRun<T> = (records: WriteTransaction, journal: CommandJournal, catalog: DatabaseSchema) => Promise<T>;
