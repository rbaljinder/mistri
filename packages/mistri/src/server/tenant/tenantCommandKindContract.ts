/**
 * What a command transaction needs of its principal's kind. The authorized
 * facade, the operation queue, row visibility and audit stamping belong to
 * runTenantCommandTransaction (tenantCommandTransaction.ts); each kind, one
 * module per kind, says only where its principal writes, from the principal
 * alone: the tenant its keys must name, the columns it may write, whether it
 * reads each target's owner for the audit, whether it updates or removes existing rows,
 * and how its audit rows are committed.
 */
import type { CommandAudit } from '../../adapters/commands/commandJournalTypes.js';
import type { ResourceOwnership } from './tenantOwnership.js';

type Audit = CommandAudit | readonly CommandAudit[];
export interface TenantCommandPlace {
  /** The tenant a key's owner column must name; undefined when the principal
   * spans tenants or writes only the platform's rows. */
  readonly tenantId: string | undefined;
  /** Whether a command may write this column of a table under this ownership rule. */
  writes(rule: ResourceOwnership, column: string): boolean;
  /** Whether each target's owner is read from its row, for the audit rows. */
  readonly readsOwners: boolean;
  /** Whether it updates existing rows at all. */
  readonly updates: boolean;
  /** Whether it removes existing rows at all. */
  readonly removes: boolean;
  /** Whose a creating command's (`targets: 'none'`) audit row is, where the
   * kind reads owners: the one tenant it acts in. Absent, the platform's (''). */
  readonly creates?: string;
  /** The audit rows as the journal commits them. `stamped` gives each the
   * owner this transaction read from its target row, never the handler's word. */
  audit(audit: Audit, stamped: (audit: Audit) => Audit): Audit;
}
export interface TenantCommandKind<Principal> {
  /** The principal's `realm`; a tenant member's evidence carries none and reads as 'tenant'. */
  readonly realm: string;
  place(principal: Principal): TenantCommandPlace;
}
