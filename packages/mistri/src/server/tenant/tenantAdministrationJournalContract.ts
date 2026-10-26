/** Engine-neutral journal namespace and strict operation dispatch, never admission. */
import { validateInvitationJournalPair, validateLinkedInvitationRevocation } from './tenantInvitationChange.js';
import { validateSupportJournalPair } from './tenantSupportChange.js';
import { MAINTENANCE_OPERATIONS, validateMaintenanceJournalPair } from './tenantMaintenanceChange.js';
import type {
  AdministrationReceiptScope,
  StoredAdministrationReceipt,
  AdministrationAudit,
} from './tenantAdministrationJournalValidation.js';
export {
  binding,
  scopeFields,
  receiptFields,
  scopeValues,
  validateReceipt,
  validateAudit,
  type AdministrationReceiptScope,
  type StoredAdministrationReceipt,
  type AdministrationAudit,
} from './tenantAdministrationJournalValidation.js';

export interface TenantAdministrationJournal {
  read(scope: AdministrationReceiptScope): Promise<StoredAdministrationReceipt | null>;
  commit(receipt: StoredAdministrationReceipt, audit: AdministrationAudit): Promise<void>;
}
export const ADMINISTRATION_JOURNAL_PREFIX = '__mistri_admin_';
const prefix = ADMINISTRATION_JOURNAL_PREFIX;
/* One row per operation: its receipt and its audit together (they were a 1:1 pair of tables). */
export const ADMINISTRATION_JOURNAL_TABLES = Object.freeze({
  meta: `${prefix}meta`,
  receipt: `${prefix}receipt`,
});
export function validatePair(receipt: StoredAdministrationReceipt, audit: AdministrationAudit): void {
  // Preserve v1 storage and older operation validators. New invitation names
  // require exact linked transitions and actor/policy attribution, not just JSON.
  if (['issueInvitation', 'revokeInvitation', 'reissueInvitation', 'acceptInvitation', 'claimInvitation'].includes(receipt.operation)) {
    validateInvitationJournalPair(receipt, audit);
  }
  if (receipt.operation === 'openSupport' || receipt.operation === 'exitSupport') validateSupportJournalPair(receipt, audit);
  if (receipt.operation === 'revokeMembership') validateLinkedInvitationRevocation(receipt, audit);
  if ((MAINTENANCE_OPERATIONS as readonly string[]).includes(receipt.operation)) validateMaintenanceJournalPair(receipt, audit);
}
