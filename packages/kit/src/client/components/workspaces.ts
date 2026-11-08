/**
 * Workspaces: top-level groups that say `workspace: true`, each a product of its own in one App (a service desk and a
 * CRM). The header's switcher picks one and the sidebar lists only its entries, so a reader sees one product's menu at a
 * time rather than every product's at once. Pure, over the menu as the nav tree draws it: which workspace is current is
 * the walk's to say (sidebarModel.ts), and a workspace with nothing this reader may open is already gone from the tree.
 */
import { navigationPaths, type AvailableNavigationNode } from './navigationTree.js';

export interface Workspace<T> {
  id: string;
  label: string;
  icon?: string;
  children: AvailableNavigationNode<T>[];
}

export interface WorkspaceMenu<T> {
  /** In the order the App declares them. */
  spaces: Workspace<T>[];
  /** What stands outside every workspace and so shows in each: the footer group, and the assistant's room where nav does not place it. */
  outside: AvailableNavigationNode<T>[];
}

/** The menu's workspaces, or null when the App declares none (every menu before this one). */
export function workspacesOf<T>(menu: readonly AvailableNavigationNode<T>[]): WorkspaceMenu<T> | null {
  const spaces = menu.flatMap((node): Workspace<T>[] =>
    node.kind === 'group' && node.workspace
      ? [{ id: node.id, label: node.label, ...(node.icon ? { icon: node.icon } : {}), children: node.children }]
      : [],
  );
  if (!spaces.length) return null;
  return { spaces, outside: menu.filter((node) => !(node.kind === 'group' && node.workspace)) };
}

/**
 * The menu one workspace shows: its entries as if they were the whole nav, then what stands outside. A footer group is
 * told from the rest by its placement where the sidebar draws them (sidebarModel.ts), so order here does not matter.
 */
export function inWorkspace<T>(menu: WorkspaceMenu<T>, id: string): AvailableNavigationNode<T>[] {
  const space = menu.spaces.find((candidate) => candidate.id === id) ?? menu.spaces[0];
  return [...space.children, ...menu.outside];
}

/** The workspaces whose subtree holds a room, by its view id: more than one where a page is both teams'. */
export function workspacesHolding<T extends { id: string }>(menu: WorkspaceMenu<T>, room: string): string[] {
  return menu.spaces.filter((space) => navigationPaths(space.children).some(({ entry }) => entry.id === room)).map((space) => space.id);
}
