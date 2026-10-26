import type { AppPayloadNavNode } from '@mistriwork/engine/shared/servedApp.js';
import type { BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';

export interface NavigationTargetNode {
  kind: 'target';
  label: string;
  /** The theme's series color (1–8) its dot is drawn in, in the icon's place. */
  color?: number;
  to: BoundAppTarget;
  href: string;
}
export type AvailableNavigationNode<T> =
  | { kind: 'destination'; entry: T }
  | NavigationTargetNode
  | {
      kind: 'group';
      id: string;
      label: string;
      icon?: string;
      placement?: 'footer';
      inline?: true;
      folded?: true;
      children: AvailableNavigationNode<T>[];
    };

export type NavigationNode<T> =
  | { kind: 'destination'; entry: T }
  | { kind: 'group'; id: string; label: string; icon?: string; children: NavigationNode<T>[] };

/**
 * The served nav, each reference resolved to what a menu draws for it. A
 * reference the resolver has nothing for is left out, and so is a group it
 * leaves empty: the menu never draws a heading over nothing.
 */
export function navigationTree<T>(
  nav: readonly AppPayloadNavNode[],
  entryOf: (view: string, label: string, color?: number) => T | undefined,
): NavigationNode<T>[];
export function navigationTree<T>(
  nav: readonly AppPayloadNavNode[],
  entryOf: (view: string, label: string, color?: number) => T | undefined,
  targetOf: (target: BoundAppTarget) => string | undefined,
): AvailableNavigationNode<T>[];
export function navigationTree<T>(
  nav: readonly AppPayloadNavNode[],
  entryOf: (view: string, label: string, color?: number) => T | undefined,
  targetOf?: (target: BoundAppTarget) => string | undefined,
): AvailableNavigationNode<T>[] {
  return nav.flatMap((node): AvailableNavigationNode<T>[] => {
    if ('to' in node) {
      const to = node.to as BoundAppTarget;
      const href = targetOf?.(to);
      return href ? [{ kind: 'target', label: node.label, to, href, ...(node.color ? { color: node.color } : {}) }] : [];
    }
    if (!('group' in node)) {
      const entry = entryOf(node.view, node.label, node.color);
      return entry === undefined ? [] : [{ kind: 'destination', entry }];
    }
    const children = navigationTree(node.children, entryOf, targetOf ?? (() => undefined));
    return children.length
      ? [
          {
            kind: 'group',
            id: node.group,
            label: node.label,
            ...(node.icon ? { icon: node.icon } : {}),
            ...(node.placement ? { placement: node.placement } : {}),
            ...(node.inline ? { inline: true as const } : {}),
            ...(node.folded ? { folded: true as const } : {}),
            children,
          },
        ]
      : [];
  });
}

export function navigationContains<T>(node: AvailableNavigationNode<T>, predicate: (entry: T) => boolean): boolean {
  return node.kind === 'destination'
    ? predicate(node.entry)
    : node.kind === 'group' && node.children.some((child) => navigationContains(child, predicate));
}

/** Every destination, depth first, with the labels of the groups around it, outermost first. */
export function navigationPaths<T>(
  nodes: readonly AvailableNavigationNode<T>[],
  groups: readonly string[] = [],
): Array<{ entry: T; groups: string[] }> {
  return nodes.flatMap((node) =>
    node.kind === 'destination'
      ? [{ entry: node.entry, groups: [...groups] }]
      : node.kind === 'group'
        ? navigationPaths(node.children, [...groups, node.label])
        : [],
  );
}

/**
 * Whether a group nests inside another. A menu of groups one level deep
 * folds into labelled sections, every destination one tap away; only a
 * deeper menu folds into levels a reader drills into.
 */
export function navigationNests<T>(nodes: readonly AvailableNavigationNode<T>[]): boolean {
  return nodes.some((node) => node.kind === 'group' && node.children.some((child) => child.kind === 'group'));
}
