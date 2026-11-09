/**
 * `nav`: the menu that only arranges references to views, read once the views
 * are known (appViews.ts). Local references normalize to `{ view, label? }`,
 * checked static destinations to `{ label, to }`, and groups to
 * `{ group, label, children }`; a view appears in it at most once (once in each
 * workspace, where it has them), and a public view not at all.
 */
import { ASSISTANT_ROOM } from './appAddress.js';
import { isRoom, type DestinationKind } from './appDestinations.js';
import { parseAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import { parseRealm, type SeriesColor, type AppNavNode } from './appModel.js';

/** Local references normalize to `{ view, label? }`, checked static destinations
 * to `{ label, to }`, and groups to `{ group, label, children }`. */
export function parseNav<View extends { readonly key: string; readonly kind: string }>(
  raw: unknown,
  where: string,
  views: ReadonlyMap<string, View>,
  order: readonly string[],
  /* A parsed view's kind as a destination reads it (appDestinations.ts): the caller knows its own view shapes. */
  kindOf: (view: View) => DestinationKind | undefined,
  assistantPage = false,
  /* `auth.roles`' names, which a menu entry's `roles` must come from, as a home rule's do. */
  declaredRoles: readonly string[] = [],
): AppNavNode[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error(`${where}: "nav" must be an array.`);
  const groups = new Set<string>();
  /* Where each view stands: the workspaces it is in, '' for outside any. A view may stand in several workspaces (a page
     both teams use), never twice in one, and never in a workspace and outside it. */
  const placedIn = new Map<string, Set<string>>();
  let workspace = '';
  const place = (key: string): boolean => {
    const where = placedIn.get(key) ?? new Set<string>();
    if (where.has(workspace) || (where.size > 0 && (workspace === '' || where.has('')))) return false;
    where.add(workspace);
    placedIn.set(key, where);
    return true;
  };
  const visiting = new Set<object>();
  /* `roles` on an entry or a group says whom the menu offers it to, as a home rule's `roles` says whom it starts:
     arrangement only. A view's own `roles` and the grants still decide who may open it. */
  const rolesOf = (value: unknown, at: string): { roles?: string[] } => {
    if (value === undefined) return {};
    if (!Array.isArray(value) || !value.length || value.some((role) => typeof role !== 'string'))
      throw new Error(`${at} has "roles" that are not a non-empty list of role names.`);
    for (const role of value as string[])
      if (!declaredRoles.includes(role))
        throw new Error(
          `${at} names the role "${role}", which auth.roles does not declare. ${declaredRoles.length ? `It declares: ${declaredRoles.join(', ')}.` : 'The App declares no roles.'}`,
        );
    return { roles: [...(value as string[])] };
  };
  const leaf = (key: unknown, label: string | undefined, at: string, color?: SeriesColor, roles: { roles?: string[] } = {}): AppNavNode => {
    const view = typeof key === 'string' ? views.get(key) : undefined;
    if (!view && key === ASSISTANT_ROOM && assistantPage) {
      if (!place(ASSISTANT_ROOM)) throw new Error(`${at} names the assistant a second time; it appears in nav at most once.`);
      return {
        view: ASSISTANT_ROOM,
        ...(label === undefined ? {} : { label }),
        ...(color === undefined ? {} : { color }),
        ...roles,
      };
    }
    if (!view) {
      throw new Error(
        `${at} names the view "${String(key)}", which this App does not declare. It declares: ${order.join(', ') || 'no views'}. See \`mistri docs nav-and-shell\`.`,
      );
    }
    // Nav opens the rooms every destination opens (appDestinations.ts), and says in its own words why a public view is none.
    if (!isRoom(kindOf(view))) {
      throw new Error(
        `${at} names the ${view.kind === 'landing' ? 'landing' : 'public form'} view "${view.key}". Public views are not in nav, which is signed-in chrome: ` +
          "a landing is reached through home, a public form through its address and a landing's call to action.",
      );
    }
    if (!place(view.key))
      throw new Error(`${at} names the view "${view.key}" a second time; a view appears in nav at most once, or once in each workspace.`);
    return {
      view: view.key,
      ...(label === undefined ? {} : { label }),
      ...(color === undefined ? {} : { color }),
      ...roles,
    };
  };
  /* `depth` is the number of groups around these entries. */
  const walk = (entries: unknown[], parent: string, depth: number): AppNavNode[] =>
    entries.map((node, i) => {
      const at = `${parent}: nav entry ${i + 1}`;
      if (typeof node === 'string') return leaf(node, undefined, at);
      if (!isRecord(node)) throw new Error(`${at} is not a view id, a { label, to } or a navGroup.`);
      if (Object.hasOwn(node, 'children')) {
        if (visiting.has(node)) throw new Error(`${at} contains a navigation cycle.`);
        if (depth >= 8) throw new Error(`${at} exceeds the maximum navigation group depth of 8.`);
        allowKeys(
          node,
          ['id', 'label', 'icon', 'realm', 'roles', 'placement', 'inline', 'folded', 'workspace', 'children'],
          `${at} (a navigation group)`,
        );
        if (typeof node.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(node.id)) {
          throw new Error(`${at} needs a group "id" using lowercase letters, digits and hyphens.`);
        }
        if (groups.has(node.id)) throw new Error(`${at} repeats navigation group id "${node.id}".`);
        if (typeof node.label !== 'string' || !node.label.trim()) throw new Error(`${at} needs a non-empty group "label".`);
        if (!Array.isArray(node.children) || !node.children.length) throw new Error(`${at} needs a non-empty "children" array.`);
        if (node.placement !== undefined && node.placement !== 'footer')
          throw new Error(
            `${at} has a "placement" of ${JSON.stringify(node.placement)}: the one placement is "footer", the group held at the foot of the sidebar.`,
          );
        if (node.placement !== undefined && depth > 0)
          throw new Error(`${at} is a group inside a group with a "placement". Only a group of the top level goes to the foot.`);
        /* `inline` is the top bar's: the group's rooms stand in the bar as links of their own, so a portal's few
           places need no menu to open. The sidebar draws the group as ever. Only the top level is in the bar. */
        if (node.inline !== undefined && node.inline !== true)
          throw new Error(`${at} has an "inline" of ${JSON.stringify(node.inline)}: it is true, or left out.`);
        if (node.inline !== undefined && depth > 0)
          throw new Error(`${at} is a group inside a group with "inline". Only a group of the top level stands in the top bar.`);
        /* `folded` is where a section starts for someone who has never opened or closed it: a rarely used
           section stays one line until it is wanted. Their own choice, once made, is kept over it. */
        if (node.folded !== undefined && node.folded !== true)
          throw new Error(`${at} has a "folded" of ${JSON.stringify(node.folded)}: it is true, or left out.`);
        /* `workspace` makes a top-level group a product of its own: the header's switcher picks it, and the sidebar lists
           only its children. It is the whole menu's shape, so it is checked once the top level is read (below). */
        if (node.workspace !== undefined && node.workspace !== true)
          throw new Error(`${at} has a "workspace" of ${JSON.stringify(node.workspace)}: it is true, or left out.`);
        if (node.workspace !== undefined && depth > 0)
          throw new Error(`${at} is a group inside a group with "workspace". Only a group of the top level is a workspace.`);
        if (node.workspace !== undefined && node.inline !== undefined)
          throw new Error(
            `${at} (${node.id}) is a workspace with "inline". A workspace is picked in the header and its rooms listed in the sidebar; inline is the top bar's, and a workspace is no group of it.`,
          );
        if (node.workspace !== undefined && node.placement !== undefined)
          throw new Error(
            `${at} (${node.id}) is a workspace with a "placement". A footer group stays at the sidebar's foot in every workspace; it is not one of them.`,
          );
        const groupRoles = rolesOf(node.roles, `${at} (${node.id})`);
        groups.add(node.id);
        visiting.add(node);
        const outer = workspace;
        if (node.workspace !== undefined) workspace = node.id;
        const children = walk(node.children, `${at} (${node.id})`, depth + 1);
        workspace = outer;
        visiting.delete(node);
        return {
          group: node.id,
          label: node.label.trim(),
          ...(node.icon === undefined ? {} : { icon: parseIcon(node.icon, `${at} (${node.id})`) }),
          ...(node.realm === undefined ? {} : { realm: parseRealm(node.realm, `${at} (${node.id})`) }),
          ...groupRoles,
          ...(node.placement === undefined ? {} : { placement: 'footer' as const }),
          ...(node.inline === undefined ? {} : { inline: true as const }),
          ...(node.folded === undefined ? {} : { folded: true as const }),
          ...(node.workspace === undefined ? {} : { workspace: true as const }),
          children,
        };
      }
      if (Object.hasOwn(node, 'to')) {
        allowKeys(node, ['label', 'to', 'color', 'roles'], at);
        if (typeof node.label !== 'string' || !node.label.trim() || node.label.length > 120 || /[\p{Cc}\p{Cs}]/u.test(node.label)) {
          throw new Error(`${at}: { label, to } needs a non-blank label of at most 120 characters.`);
        }
        /* A colored dot in the icon's place: a project or a label told apart at a glance, in a theme's own series color. */
        if (
          node.color !== undefined &&
          (typeof node.color !== 'number' || !Number.isInteger(node.color) || node.color < 1 || node.color > 8)
        )
          throw new Error(`${at} has a "color" of ${JSON.stringify(node.color)}: one of the theme's eight chart colors, 1 to 8.`);
        const color = node.color as SeriesColor | undefined;
        const roles = rolesOf(node.roles, at);
        if (typeof node.to === 'string') return leaf(node.to, node.label.trim(), at, color, roles);
        return {
          label: node.label.trim(),
          to: parseAppTarget(node.to, `${at}.to`, false) as import('../../schema/app.js').StaticAppTarget,
          ...(color === undefined ? {} : { color }),
          ...roles,
        };
      }
      throw new Error(`${at} is not a view id, a { label, to } or a navGroup.`);
    });
  const nav = walk(raw, where, 0);
  /* Workspaces split the whole menu, or none of it: a room outside them would show in no workspace's sidebar, or in all.
     Only a footer group stands outside, held at the sidebar's foot whichever workspace is open. */
  if (nav.some((node) => 'group' in node && node.workspace)) {
    nav.forEach((node, i) => {
      if ('group' in node && (node.workspace || node.placement === 'footer')) return;
      const name = 'group' in node ? `the group "${node.group}"` : 'view' in node ? `the view "${node.view}"` : `the entry "${node.label}"`;
      throw new Error(
        `${where}: nav entry ${i + 1} is ${name}, outside every workspace. When one top-level group is a workspace, every one is, ` +
          `except a group with placement: 'footer'. Put it in a navGroup(…, { workspace: true }).`,
      );
    });
  }
  /* The assistant's page is always reachable: where nav does not place it, it closes the menu. */
  return assistantPage && !placedIn.has(ASSISTANT_ROOM) ? [...nav, { view: ASSISTANT_ROOM }] : nav;
}
