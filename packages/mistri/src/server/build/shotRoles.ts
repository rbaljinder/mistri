/**
 * The roles `mistri shot --as` and `grade` sign in as (shot.ts, shotTenant.ts): kept apart so the tenant half
 * reads them without loading the run.
 */

/** The roles a person signs in as: a service role (`service: true`) is one a job or a policy acts as (AG6). */
export function peopleRoles(roles: Readonly<Record<string, { service?: true }>> | undefined): string[] {
  return Object.entries(roles ?? {})
    .filter(([, grant]) => grant.service !== true)
    .map(([role]) => role);
}

/**
 * Why `--as <role>` cannot sign in, or nothing: a role the App does not declare, or a service role, each said with
 * the roles a person signs in as — the bootstrapped administrator among them where the App has one (a tenant App
 * has none of its own).
 */
export function asRoleRefusal(
  name: string,
  roles: Readonly<Record<string, { service?: true }>> | undefined,
  as: string,
  admin = true,
): string | undefined {
  const people = peopleRoles(roles).filter((role) => role !== 'admin' || !admin);
  const offered = [...(admin ? ['admin'] : []), ...people].join(', ');
  if (roles?.[as]?.service === true && Object.hasOwn(roles, as))
    return `--as "${as}" is a service role of "${name}", which a job or a policy acts as and no person signs in as: ${offered}.`;
  if ((admin && as === 'admin') || (roles !== undefined && Object.hasOwn(roles, as))) return undefined;
  return `--as "${as}" is not a role of "${name}": ${offered}.${admin ? '' : ' A tenant App has no admin of its own.'}`;
}

/**
 * The addresses a role reads, of those a run opens (grade --as all): a view it may open over a resource it reads, a
 * record of a resource it reads, and every page (a page says its own roles in its sections). Signed out, the address
 * a visitor lands on: an App with sign-in shows its card there, and everywhere else the same card again.
 */
export function shotsFor<S extends { view?: string; page?: string; table?: string }>(
  app: {
    resources?: Readonly<Record<string, { physical?: string }>>;
    views: Readonly<Record<string, { table?: string; roles?: readonly string[] }>>;
    auth?: { roles?: Readonly<Record<string, { read?: unknown }>> };
  },
  role: string,
  shots: readonly S[],
): S[] {
  if (role === 'signed-out') return shots.slice(0, 1);
  const read = app.auth?.roles?.[role]?.read;
  const resourceOf = (table: string) =>
    Object.entries(app.resources ?? {}).find(([name, def]) => (def.physical ?? name) === table)?.[0] ?? table;
  const reads = (table: string | undefined) => !table || read === true || (Array.isArray(read) && read.includes(resourceOf(table)));
  return shots.filter((shot) => {
    if (shot.page && !shot.table) return true;
    const view = shot.view ? app.views[shot.view] : undefined;
    if (view && view.roles?.length && !view.roles.includes(role)) return false;
    return reads(shot.table ?? view?.table);
  });
}
