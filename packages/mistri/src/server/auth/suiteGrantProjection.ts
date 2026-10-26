/** Project a verified suite subject into one App's authority, never the other
 * way around. The suite owns sign-in; an App still owns the roles it grants.
 * Storage and HTTP routing are separate owners, so this helper cannot make an
 * account, grant a role, or treat a shared email as authorization. */
import type { Identity } from './auth.js';

export type SuiteGrantLookup = (subjectId: string, appId: string) => Promise<readonly string[] | null>;

/** Array methods like some() skip holes; a missing slot must not turn a
 * malformed `['reader', <hole>]` grant into the valid subset `reader`. */
function plainRoles(value: readonly unknown[]): value is readonly string[] {
  for (let index = 0; index < value.length; index++) {
    const role = value[index];
    if (!Object.hasOwn(value, index) || typeof role !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(role)) return false;
  }
  return true;
}

/** One current grant read per request. A malformed grant is no grant; it must
 * never be narrowed to the safe-looking subset and accidentally admit access. */
export async function projectSuiteGrant(
  subject: Readonly<Identity>,
  appId: string,
  declaredRoles: readonly string[],
  lookup: SuiteGrantLookup,
): Promise<Identity | null> {
  if (
    !subject ||
    typeof subject.id !== 'string' ||
    !subject.id ||
    subject.id.length > 1024 ||
    /[\p{Cc}\p{Cs}]/u.test(subject.id) ||
    typeof subject.who !== 'string' ||
    !subject.who ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(appId) ||
    !Array.isArray(declaredRoles) ||
    declaredRoles.length > 256 ||
    !plainRoles(declaredRoles) ||
    new Set(declaredRoles).size !== declaredRoles.length
  )
    return null;

  const roles: unknown = await lookup(subject.id, appId);
  if (
    !Array.isArray(roles) ||
    !roles.length ||
    roles.length > declaredRoles.length ||
    !plainRoles(roles) ||
    roles.some((role) => !declaredRoles.includes(role)) ||
    new Set(roles).size !== roles.length
  )
    return null;
  // The native suite account's role, if any, is *never* an App grant. Copy
  // only display identity and the roles this exact App returned right now.
  return {
    id: subject.id,
    who: subject.who,
    ...(subject.name !== undefined ? { name: subject.name } : {}),
    ...(subject.emailVerified === true ? { emailVerified: true as const } : {}),
    role: roles.join(','),
  };
}
