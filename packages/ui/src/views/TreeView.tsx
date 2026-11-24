/** Expandable hierarchical tree view with search filtering, checkable nodes, and inline actions. */
import { Icon } from '../Icon.js';
import { Tree, TreeGroup, TreeItem, TreeItemCheckbox, type TreeItemData, TreeItemIndicator, TreeItemLabel } from '@ui-sdk/react/tree';
import { type ReactNode, type Ref, useMemo, useState } from 'react';
import { cx, isEmptyStateSpec, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { EmptyState } from '../primitives/feedback.js';

/** Cascading check propagation mode for `TreeView`. */
export type TreeCheckStrategy = 'leaf' | 'trunk' | 'branch' | 'independent';

/** Hierarchical tree node item rendered in `TreeView`. */
export interface TreeNode {
  id: string;
  label: string;
  icon?: ReactNode;
  badge?: string | number;
  tone?: Tone;
  disabled?: boolean;
  href?: string;
  children?: ReadonlyArray<TreeNode>;
  data?: unknown;
}

/** Props for the `TreeView` component. */
export interface TreeViewProps {
  nodes: ReadonlyArray<TreeNode>;
  /* Search */
  searchable?: boolean;
  search?: string;
  defaultSearch?: string;
  onSearchChange?: (query: string) => void;
  searchPlaceholder?: string;
  /* Selection */
  selectedId?: string | null;
  defaultSelectedId?: string | null;
  onSelectNode?: (node: TreeNode | null, id: string | null) => void;
  /* Expansion */
  expandedIds?: ReadonlyArray<string>;
  defaultExpandedIds?: ReadonlyArray<string>;
  onExpandedIdsChange?: (expandedIds: string[]) => void;
  expandOnPress?: boolean;
  /* Checkable Multi-Selection */
  checkable?: boolean;
  checkStrategy?: TreeCheckStrategy;
  checkedIds?: ReadonlyArray<string>;
  defaultCheckedIds?: ReadonlyArray<string>;
  onCheckedIdsChange?: (checkedIds: string[]) => void;
  /* Visuals & Chrome */
  defaultIcons?: boolean;
  headerActions?: ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function toSdkTreeData(nodes: readonly TreeNode[]): TreeItemData[] {
  return nodes.map((node) => ({
    value: node.id,
    label: node.label,
    disabled: node.disabled,
    href: node.href,
    children: node.children ? toSdkTreeData(node.children) : undefined,
  }));
}

function indexTreeNodes(nodes: readonly TreeNode[], map = new Map<string, TreeNode>()): Map<string, TreeNode> {
  for (const node of nodes) {
    map.set(node.id, node);
    if (node.children) indexTreeNodes(node.children, map);
  }
  return map;
}

function collectBranchIds(nodes: readonly TreeNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.children && node.children.length > 0) {
      acc.push(node.id);
      collectBranchIds(node.children, acc);
    }
  }
  return acc;
}

function filterTreeNodes(nodes: readonly TreeNode[], lowerQuery: string, matchedBranchIds: Set<string>): TreeNode[] {
  const result: TreeNode[] = [];
  for (const node of nodes) {
    const selfMatch = node.label.toLowerCase().includes(lowerQuery);
    const filteredChildren = node.children ? filterTreeNodes(node.children, lowerQuery, matchedBranchIds) : undefined;

    if (selfMatch || (filteredChildren && filteredChildren.length > 0)) {
      if (filteredChildren && filteredChildren.length > 0) {
        matchedBranchIds.add(node.id);
      }
      result.push({
        ...node,
        children: selfMatch && node.children && (!filteredChildren || filteredChildren.length === 0) ? node.children : filteredChildren,
      });
    }
  }
  return result;
}

function highlightMatch(label: string, query: string): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) return label;
  const idx = label.toLowerCase().indexOf(trimmed.toLowerCase());
  if (idx < 0) return label;
  return (
    <>
      {label.slice(0, idx)}
      <mark className="nx-tree-match">{label.slice(idx, idx + trimmed.length)}</mark>
      {label.slice(idx + trimmed.length)}
    </>
  );
}

/** Expandable hierarchical tree view with live search filtering, single selection, and checkable multi-selection. */
export function TreeView(props: TreeViewProps) {
  const {
    nodes,
    searchable = true,
    search: controlledSearch,
    defaultSearch = '',
    onSearchChange,
    searchPlaceholder = 'Filter tree…',
    selectedId: controlledSelected,
    defaultSelectedId = null,
    onSelectNode,
    expandedIds: controlledExpanded,
    defaultExpandedIds,
    onExpandedIdsChange,
    expandOnPress = true,
    checkable = false,
    checkStrategy = 'leaf',
    checkedIds: controlledChecked,
    defaultCheckedIds = [],
    onCheckedIdsChange,
    defaultIcons = true,
    headerActions,
    empty,
    ariaLabel = 'Hierarchy tree',
    className,
    ref,
  } = props;
  const legacyEmptyMessage = (props as unknown as { emptyMessage?: ReactNode }).emptyMessage;
  const emptyNode =
    empty !== undefined ? (
      isEmptyStateSpec(empty) ? (
        <EmptyState title={empty.title} body={empty.body} action={empty.action} compact />
      ) : (
        empty
      )
    ) : (
      (legacyEmptyMessage ?? 'No matching items')
    );

  const initialExpanded = useMemo(
    () => (defaultExpandedIds ? [...defaultExpandedIds] : nodes.filter((n) => n.children?.length).map((n) => n.id)),
    [defaultExpandedIds, nodes],
  );

  const [internalSearch, setInternalSearch] = useState<string>(defaultSearch);
  const [internalSelected, setInternalSelected] = useState<string | null>(defaultSelectedId);
  const [internalExpanded, setInternalExpanded] = useState<string[]>(initialExpanded);
  const [internalChecked, setInternalChecked] = useState<string[]>(() => [...defaultCheckedIds]);

  const query = controlledSearch !== undefined ? controlledSearch : internalSearch;
  const selectedId = controlledSelected !== undefined ? controlledSelected : internalSelected;
  const expandedIds = useMemo(
    () => (controlledExpanded !== undefined ? [...controlledExpanded] : internalExpanded),
    [controlledExpanded, internalExpanded],
  );
  const checkedIds = useMemo(
    () => (controlledChecked !== undefined ? [...controlledChecked] : internalChecked),
    [controlledChecked, internalChecked],
  );

  const nodeMap = useMemo(() => indexTreeNodes(nodes), [nodes]);

  const { visibleNodes, autoExpandedIds } = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) {
      return { visibleNodes: nodes, autoExpandedIds: null as string[] | null };
    }
    const branchMatches = new Set<string>();
    const filtered = filterTreeNodes(nodes, q, branchMatches);
    return {
      visibleNodes: filtered,
      autoExpandedIds: [...new Set([...expandedIds, ...branchMatches, ...collectBranchIds(filtered)])],
    };
  }, [nodes, query, expandedIds]);

  const effectiveExpanded = autoExpandedIds ?? expandedIds;
  const sdkItems = useMemo(() => toSdkTreeData(visibleNodes), [visibleNodes]);

  const updateSearch = (next: string) => {
    if (controlledSearch === undefined) setInternalSearch(next);
    onSearchChange?.(next);
  };

  const handleSelectChange = (nextVal: string | null) => {
    if (controlledSelected === undefined) setInternalSelected(nextVal);
    onSelectNode?.(nextVal ? (nodeMap.get(nextVal) ?? null) : null, nextVal);
  };

  const handleExpandedChange = (nextExpanded: string[]) => {
    if (controlledExpanded === undefined) setInternalExpanded(nextExpanded);
    onExpandedIdsChange?.(nextExpanded);
  };

  const handleCheckedChange = (nextChecked: string[]) => {
    if (controlledChecked === undefined) setInternalChecked(nextChecked);
    onCheckedIdsChange?.(nextChecked);
  };

  const renderNodes = (list: readonly TreeNode[]): ReactNode =>
    list.map((node) => {
      const hasChildren = Boolean(node.children && node.children.length > 0);
      const iconElement =
        node.icon !== undefined ? (
          node.icon
        ) : defaultIcons ? (
          hasChildren ? (
            <Icon name="folder" size={15} weight="bold" />
          ) : (
            <Icon name="file-text" size={14} />
          )
        ) : null;

      return (
        <TreeItem key={node.id} value={node.id} branch={hasChildren} disabled={node.disabled} label={node.label} className="nx-tree-item">
          <TreeItemLabel render={node.href ? <a href={node.href} /> : undefined} className="nx-tree-row">
            {hasChildren ? (
              <TreeItemIndicator className="nx-tree-chevron">
                <Icon name="caret-right" size={11} weight="bold" />
              </TreeItemIndicator>
            ) : (
              <span className="nx-tree-leaf-pad" aria-hidden="true" />
            )}

            {checkable && (
              <TreeItemCheckbox className="nx-tree-checkbox">
                {(state) =>
                  state.checked === 'indeterminate' ? (
                    <Icon name="minus" size={10} weight="bold" />
                  ) : state.checked ? (
                    <Icon name="check" size={10} weight="bold" />
                  ) : null
                }
              </TreeItemCheckbox>
            )}

            {iconElement && <span className="nx-tree-node-icon">{iconElement}</span>}

            <span className="nx-tree-node-text">{highlightMatch(node.label, query)}</span>

            {node.badge !== undefined && (
              <span className="nx-badge nx-tree-node-badge" data-tone={toDataTone(node.tone)} data-pill="">
                {node.badge}
              </span>
            )}
          </TreeItemLabel>

          {hasChildren && node.children && <TreeGroup className="nx-tree-group">{renderNodes(node.children)}</TreeGroup>}
        </TreeItem>
      );
    });

  return (
    <div ref={ref} className={cx('nx-tree-view', className)}>
      {(searchable || headerActions) && (
        <div className="nx-tree-header">
          {searchable && (
            <div className="nx-tree-search">
              <Icon name="magnifying-glass" size={13} className="nx-tree-search-icon" />
              <input
                type="search"
                value={query}
                onChange={(e) => updateSearch(e.target.value)}
                placeholder={searchPlaceholder}
                aria-label={searchPlaceholder}
                className="nx-tree-search-input"
              />
              {query.length > 0 && (
                <button type="button" className="nx-tree-search-clear" onClick={() => updateSearch('')} aria-label="Clear tree search">
                  <Icon name="x" size={11} weight="bold" />
                </button>
              )}
            </div>
          )}
          {headerActions && <div className="nx-tree-header-actions">{headerActions}</div>}
        </div>
      )}

      {visibleNodes.length === 0 ? (
        <div className="nx-tree-empty">{emptyNode}</div>
      ) : (
        <Tree
          mode="single"
          items={sdkItems}
          value={selectedId}
          onValueChange={handleSelectChange}
          expanded={effectiveExpanded}
          onExpandedChange={handleExpandedChange}
          expandOnPress={expandOnPress}
          checkable={checkable}
          checkStrategy={checkStrategy}
          checked={checkedIds}
          onCheckedChange={handleCheckedChange}
          aria-label={ariaLabel}
          className="nx-tree-root"
        >
          {renderNodes(visibleNodes)}
        </Tree>
      )}
    </div>
  );
}
