/**
 * Delegated administration: a tenant's own members administering it. Beside
 * the explicit operators a policy names by native account id, a policy may
 * name `delegates`: `{ role, operations, roles }` — an account holding an
 * active membership with `role` in a tenant may run `operations` there, and
 * only there, within the `roles` ceiling. Ignition's dealer admin is one.
 *
 * What makes it safe is what the owner reads, not what the caller says: the
 * delegate's own membership, from the tenant store, inside the very
 * transaction that makes the change (a PostgreSQL row lock held to COMMIT, or
 * SQLite's writer fence), so a delegate demoted or revoked concurrently waits
 * for it or refuses it. Only an ordinary `member` row in an active tenant
 * qualifies — never a support membership, a platform membership or a pending
 * invitation's reservation — and a delegate never changes its own membership.
 * These are the pure rules; each owner does the reading.
 */
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';

export interface DelegateRule<Operation extends string = string> {
  readonly role: string;
  readonly operations: readonly Operation[];
  readonly roles: readonly string[];
}
/** The delegate's own membership, as its owner read it in the transaction. */
export interface DelegateMembership {
  readonly membershipId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly status: string;
  readonly roles: readonly string[];
  readonly validUntil: number;
}

function list(value: unknown, minimum: number, maximum: number): asserts value is readonly unknown[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum || new Set(value).size !== value.length) denyTenant();
}

/** Detached rules. Each operation has at most one delegate rule, so a member
 * holding two delegate roles never unions their ceilings. */
export function captureDelegates<Operation extends string>(
  input: unknown,
  allowed: readonly Operation[],
  /** Operations that grant no roles: a rule naming only these may have an empty ceiling. */
  roleless: readonly string[] = [],
): readonly DelegateRule<Operation>[] {
  const value = captureTenantData(input);
  list(value, 1, 64);
  const seen = new Set<string>();
  for (const rule of value) {
    tenantRecord(rule, ['role', 'operations', 'roles']);
    if (['role', 'operations', 'roles'].some((field) => !Object.hasOwn(rule, field))) return denyTenant();
    tenantIdentifier(rule.role);
    list(rule.operations, 1, allowed.length);
    for (const operation of rule.operations) {
      if (!allowed.includes(operation as Operation) || seen.has(operation as string)) return denyTenant();
      seen.add(operation as string);
    }
    list(rule.roles, (rule.operations as readonly string[]).every((operation) => roleless.includes(operation)) ? 0 : 1, 256);
    for (const role of rule.roles) tenantIdentifier(role);
  }
  return value as unknown as readonly DelegateRule<Operation>[];
}

/** Every role a set of delegate rules names, as the delegate's role or in a ceiling. */
export const delegateRoles = (rules: readonly DelegateRule[] | undefined): readonly string[] => [
  ...new Set((rules ?? []).flatMap((rule) => [rule.role, ...rule.roles])),
];

/** The ceiling this member's roles earn for one operation, or null. */
export function delegateCeiling<Operation extends string>(
  rules: readonly DelegateRule<Operation>[] | undefined,
  memberRoles: readonly string[],
  operation: Operation,
): readonly string[] | null {
  return rules?.find((rule) => rule.operations.includes(operation) && memberRoles.includes(rule.role))?.roles ?? null;
}

/** One store row, as either owner's query returns it (`roles` still JSON text), or null. */
export function decodeDelegateMembership(input: unknown): DelegateMembership | null {
  if (input === undefined || input === null) return null;
  const row = captureTenantData(input);
  tenantRecord(row, ['membershipId', 'tenantId', 'accountId', 'status', 'roles', 'validUntil']);
  tenantIdentifier(row.membershipId, 1024);
  tenantIdentifier(row.tenantId, 128);
  tenantIdentifier(row.accountId, 1024);
  if (typeof row.status !== 'string' || typeof row.roles !== 'string' || typeof row.validUntil !== 'number') return denyTenant();
  const roles: unknown = JSON.parse(row.roles);
  list(roles, 0, 256);
  for (const role of roles) tenantIdentifier(role);
  return Object.freeze({ ...row, roles: Object.freeze([...(roles as string[])]) }) as unknown as DelegateMembership;
}
/** Every active tenant where the account holds an active, unexpired member
 * row, with its roles, in tenant order. More than 256 refuses. */
export function decodeDelegateTenants(input: unknown): readonly Readonly<{ tenantId: string; roles: readonly string[] }>[] {
  const rows = captureTenantData(input);
  if (!Array.isArray(rows) || rows.length > 256) return denyTenant();
  return Object.freeze(
    rows.map((row) => {
      tenantRecord(row, ['tenantId', 'roles']);
      tenantIdentifier(row.tenantId, 128);
      if (typeof row.roles !== 'string') return denyTenant();
      const roles: unknown = JSON.parse(row.roles);
      list(roles, 0, 256);
      for (const role of roles) tenantIdentifier(role);
      return Object.freeze({ tenantId: row.tenantId as string, roles: Object.freeze([...(roles as string[])]) });
    }),
  );
}

/** The member's own membership still earns delegation at `now`: its own
 * account, in this tenant, active and unexpired. The owner's query already
 * took only ordinary member rows of an active tenant. */
export function assertDelegateMembership(
  member: DelegateMembership | null,
  accountId: string,
  tenantId: string,
  now: number,
): DelegateMembership {
  if (
    !member ||
    member.accountId !== accountId ||
    member.tenantId !== tenantId ||
    member.status !== 'active' ||
    !Number.isSafeInteger(member.validUntil) ||
    member.validUntil <= now
  )
    return denyTenant();
  return member;
}
