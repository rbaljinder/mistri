/**
 * What each tenant is called, as the server said it beside the id: the
 * tenant's profile record's name (packages/mistri/src/server/tenant/tenantNames.ts). Words for
 * a person only — every choice, link and request still names the id, so a
 * name that is missing or stale never changes what is opened.
 *
 * Discovery says the names of the account's own tenants and replaces them;
 * support status says the names of the tenants a grant may enter, which join
 * them. A tenant with no name is said by its id.
 */
import { humanName } from '@mistriwork/engine/shared/model.js';
import { roleLabel } from '@mistriwork/kit/client/roleLabels.js';

const names = new Map<string, string>();
/* The account's tenants that are sandboxes, as discovery said:
   each is marked so wherever its name is said, so a copy is never read as
   the live tenant. */
const sandboxes = new Set<string>();

/** A name as the server sends one: short words, with no control characters. */
export const isTenantName = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 200 && value.trim() === value && !/\p{Cc}/u.test(value);

/** The account's own tenants' names, from discovery: the previous account's go with them. */
export function replaceTenantNames(found: Iterable<readonly [string, string]>, sandboxed: Iterable<string> = []): void {
  names.clear();
  sandboxes.clear();
  for (const [id, name] of found) names.set(id, name);
  for (const id of sandboxed) sandboxes.add(id);
}

/** The account's sandboxes, by id, for a component to mark. */
export function tenantSandboxes(): ReadonlySet<string> {
  return new Set(sandboxes);
}

/** More names, from a support status's choices. */
export function addTenantNames(found: Iterable<readonly [string, string]>): void {
  for (const [id, name] of found) names.set(id, name);
}

/** The names known now, for a component to say its tenants by. */
export function tenantNames(): Readonly<Record<string, string>> {
  return Object.freeze(Object.fromEntries(names));
}

/** What a role is called where a person reads it: the App's label for it
 * (`auth.roles.<id>.label`), else its id made words (`branch_viewer` →
 * "Branch viewer"). Every choice and request still names the id. */
export const roleName = (role: string): string => roleLabel(role) ?? humanName(role);
