/**
 * The tenants an operator rule (`administration.operators`,
 * `invitations.operators`) reaches: `'all'`, as a support grant says it, or a
 * list of ids. `'all'` is a rule that names no ceiling on tenants, so a
 * platform that adds a tenant a day does not edit its policy a day.
 */
export type OperatorTenants = 'all' | readonly string[];

/** What the policy parse says when `tenants` is neither. */
export const OPERATOR_TENANTS_WORDS = 'tenants is "all" or a list of 1 to 256 tenant ids.';

export const operatorReaches = (tenants: OperatorTenants, tenantId: string): boolean => tenants === 'all' || tenants.includes(tenantId);

/** Whether two rules could both match one tenant. */
export const operatorsOverlap = (left: OperatorTenants, right: OperatorTenants): boolean =>
  left === 'all' || right === 'all' || left.some((tenantId) => right.includes(tenantId));

/** The ids a rule names, none where it says `'all'` (every tenant is read from the store). */
export const operatorIds = (tenants: OperatorTenants): readonly string[] => (tenants === 'all' ? [] : tenants);
