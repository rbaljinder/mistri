/**
 * `roles` on a view or a page: the roles that may open it. Access to rows is
 * decided per table, so a service desk's employee who reads their own
 * tickets "could read" the agents' queues over the same table, and found
 * them in the menu with nothing in them. A view that names its roles is
 * opened only by a principal holding one of them; table grants still apply,
 * so `roles` only ever narrows.
 *
 * Judged on the server, where a principal's App is projected: a view this
 * principal may not open is taken out before anything is served or read,
 * so its address, the menu, ⌘K and search all lose it the way they lose a
 * view that does not exist — and nobody learns it is there.
 */
import { resolveTheme } from '@mistriwork/engine/shared/themeResolve.js';
import { type AppAuth, type AppDef, type AppNavNode } from './appModel.js';
import { isRecord } from '@mistriwork/engine/shared/model.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { ASSISTANT_ROOM } from './appAddress.js';

/** What `roles` says, checked: a non-empty list of the App's declared role names. */
export function parseOpenRoles(raw: unknown, at: string, auth: Pick<AppAuth, 'roles'> | undefined, key = 'roles'): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.some((role) => typeof role !== 'string'))
    throw new Error(`${at} has "${key}" that are not a list of role names.`);
  /* An empty list would open to nobody, which is a view nothing can reach: say so rather than serve it to no one. */
  if (!raw.length)
    throw new Error(
      `${at} has an empty "${key}", so ${key === 'roles' ? 'nobody could open it. Name the roles that may' : "it is no role's. Name the roles"}, or remove "${key}".`,
    );
  const declared = Object.keys(auth?.roles ?? {});
  for (const role of raw as string[]) {
    if (!declared.includes(role)) {
      throw new Error(
        `${at} has "${key}" naming "${role}", which auth.roles does not declare. ${declared.length ? `It declares: ${declared.join(', ')}.` : 'The App declares no roles.'}`,
      );
    }
  }
  return [...new Set(raw as string[])];
}

/**
 * The roles a principal holds, with every role each one `extends` (a chain is followed; a loop ends where it began).
 * `extends` says a role holds the grants of another, so a view that names the other is the role's to open too. Only
 * upward: the role extended does not hold what extends it.
 */
export function heldRoles(auth: Pick<AppAuth, 'roles'> | undefined, roles: readonly string[]): string[] {
  const held = [...roles];
  for (const role of held) {
    const parent = Object.hasOwn(auth?.roles ?? {}, role) ? auth!.roles![role]!.extends : undefined;
    if (parent !== undefined && !held.includes(parent)) held.push(parent);
  }
  return held;
}

/**
 * Whether a principal holding `roles` may open something that names its roles; one that names none is everyone's.
 * A role opens what names a role it extends (heldRoles); `auth` is the App's, undefined where it declares none.
 */
export function opensTo(
  target: { roles?: readonly string[] } | undefined,
  roles: readonly string[],
  auth: Pick<AppAuth, 'roles'> | undefined,
): boolean {
  if (!target?.roles) return true;
  const held = heldRoles(auth, roles);
  return target.roles.some((role) => held.includes(role));
}

const projections = new WeakMap<object, Map<string, unknown>>();

/**
 * Whether a principal holding `roles` is drawn the top bar, where the App
 * says `ui.shell.placement: { top: [...] }`: when every role it holds is
 * listed. A person who also holds an unlisted role — an employee who is an
 * agent too — works in the sidebar, since that role's rooms are the ones a
 * slim bar was not chosen for. Holding none (signed out) is the sidebar's.
 */
export function topBarFor(placement: { top: readonly string[] }, roles: readonly string[]): boolean {
  return roles.length > 0 && roles.every((role) => placement.top.includes(role));
}

/**
 * The App as a principal holding `roles` may open it: without the views
 * that name other roles, and without nav's references to them; and with
 * its shell's placement said for them, where it depends on the role.
 * Memoized per definition and role set, so the payload caches keyed on the
 * definition (apps.ts appPayload) keep one entry per principal shape, not
 * per request.
 */
export function appForRoles<A extends Pick<AppDef, 'views' | 'nav'> & { ui?: AppDef['ui']; auth?: Pick<AppAuth, 'roles'> }>(
  app: A,
  roles: readonly string[],
): A {
  const placement = app.ui?.shell?.placement;
  const byRole = typeof placement === 'object' ? placement : undefined;
  const themed = app.ui?.theme?.for?.roles;
  if (!byRole && !themed && !Object.values(app.views).some((view) => isRecord(view) && 'roles' in view)) return app;
  const key = [...new Set(roles)].sort().join(',');
  const held = projections.get(app) ?? new Map<string, unknown>();
  projections.set(app, held);
  const hit = held.get(key) as A | undefined;
  if (hit) return hit;
  const views = Object.fromEntries(Object.entries(app.views).filter(([, view]) => opensTo(view, roles, app.auth)));
  const prune = (nodes: readonly AppNavNode[]): AppNavNode[] =>
    nodes.flatMap((node): AppNavNode[] => {
      /* The assistant's page is no view: whether this person is offered it is the payload's to say (appProjection.ts). */
      if ('view' in node) return Object.hasOwn(views, node.view) || node.view === ASSISTANT_ROOM ? [node] : [];
      if (!('group' in node)) return [node];
      const children = prune(node.children);
      return children.length ? [{ ...node, children }] : [];
    });
  /* The theme this principal wears where the App maps one of its roles (themeResolve.ts): told as the preset, so the
     browser ranks it as it ranks the App's, under the reader's own pick. A palette is its own preset's and goes with
     it; the App's accent, corner and face stay. */
  const roleTheme = themed && resolveTheme({ roles, for: { roles: themed }, offered: () => true });
  const theme =
    roleTheme?.source === 'role' && roleTheme.id !== app.ui!.theme!.preset
      ? (({ palette: _palette, ...rest }) => ({ ...rest, preset: roleTheme.id }))(app.ui!.theme!)
      : undefined;
  const ui =
    byRole || theme
      ? {
          ui: {
            ...app.ui,
            ...(byRole ? { shell: { ...app.ui!.shell, placement: topBarFor(byRole, roles) ? 'top' : 'side' } } : {}),
            ...(theme ? { theme } : {}),
          },
        }
      : {};
  const projected = { ...app, views, nav: prune(app.nav), ...ui } as A;
  held.set(key, projected);
  return projected;
}

/** The pages a principal holding `roles` may open. */
export function pagesForRoles<P extends Pick<PageDef, 'roles'>>(
  pages: readonly P[],
  roles: readonly string[],
  auth: Pick<AppAuth, 'roles'> | undefined,
): P[] {
  return pages.filter((page) => opensTo(page, roles, auth));
}

/** A principal's roles from the verified session's role text, as the rest of the server reads it. */
export const sessionRoles = (role: unknown): string[] =>
  typeof role === 'string'
    ? role
        .split(',')
        .map((each) => each.trim())
        .filter(Boolean)
    : [];
