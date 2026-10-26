/** Private per-App experiment resources supplied by the suite lifetime owner.
 * Request owners supply verified context; none of these ports enters a DTO. */
import type { AssignmentReceiptProvider } from './assignmentReceipt.js';
import type { ExperimentStore } from './contracts.js';
import type { createExperimentRuntime } from './runtime.js';
import type { ExperimentVisitorIdentityOwner } from './visitorIdentity.js';

export interface ExperimentRequestPort {
  readonly runtime: ReturnType<typeof createExperimentRuntime>;
  readonly receipts: AssignmentReceiptProvider;
  readonly visitors?: ExperimentVisitorIdentityOwner;
  readonly store: ExperimentStore;
}
