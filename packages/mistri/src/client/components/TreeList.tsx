/**
 * Records as the tree their parent column makes: each record with no parent
 * (or whose parent the list's question leaves out) a root, its children
 * folded under it. The list's own question is asked once for the whole tree
 * — a page of a tree would cut branches — up to LIMIT records, and the tree
 * says when there are more.
 *
 * The keyboard's tree pattern (APG): one Tab stop, the item last visited;
 * Up and Down move through what is open, Right opens a branch or steps into
 * it, Left folds it or steps out to the parent, Home and End go to the ends,
 * and Enter opens the record. A click on the caret folds; on the name, opens.
 * Nothing slides open (motion rule 8): a branch is there or it is not.
 */
import './TreeList.css';
import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, keyOf, openRecord, state } from '@mistriwork/kit/client/core.js';
import { ownedBy } from '@mistriwork/kit/client/requestIdentity.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { AppTreeList } from '@mistriwork/engine/shared/listPresentations.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { bulkKey } from '@mistriwork/kit/client/bulkActions.js';
import { formatNumber } from '@mistriwork/kit/client/locale.js';
import { namedCell } from '@mistriwork/kit/client/components/listColumn.js';
import { Value } from '@mistriwork/kit/client/components/Value.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import type { ModalRecord } from './RecordModal.js';
import type { TableEntry } from '@mistriwork/kit/client/components/TableView.js';
import { say as sayCopy } from '../copy/lists/components/TreeList.js';

/** A tree is read whole; past this it says so rather than silently dropping branches. */
const LIMIT = 2000;

interface TreeNode {
  id: string;
  key: Record<string, unknown>;
  title: string;
  row: Record<string, unknown>;
  children: TreeNode[];
  depth: number;
}

/**
 * The rows as a forest: a row hangs under the row its parent column names,
 * and is a root where that is empty, missing from the answer, or would close
 * a loop (a record that is its own ancestor is a data error, drawn rather
 * than hidden). Siblings read in title order.
 */
export function forestOf(
  rows: Array<Record<string, unknown>>,
  idOf: (row: Record<string, unknown>) => string | null,
  parentOf: (row: Record<string, unknown>) => string | null,
  titleOf: (row: Record<string, unknown>) => string,
  keyFor: (row: Record<string, unknown>) => Record<string, unknown> | null,
): TreeNode[] {
  const nodes = new Map<string, TreeNode>();
  const parents = new Map<string, string | null>();
  for (const row of rows) {
    const id = idOf(row);
    const key = keyFor(row);
    if (id === null || !key || nodes.has(id)) continue;
    nodes.set(id, { id, key, title: titleOf(row), row, children: [], depth: 0 });
    parents.set(id, parentOf(row));
  }
  const loops = (id: string) => {
    const seen = new Set([id]);
    for (let at = parents.get(id); at != null && nodes.has(at); at = parents.get(at)) {
      if (seen.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  const roots: TreeNode[] = [];
  for (const node of nodes.values()) {
    const parent = parents.get(node.id);
    const above = parent == null ? undefined : nodes.get(parent);
    if (above && above !== node && !loops(node.id)) above.children.push(node);
    else roots.push(node);
  }
  const order = (list: TreeNode[], depth: number) => {
    list.sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true }));
    for (const node of list) {
      node.depth = depth;
      order(node.children, depth + 1);
    }
  };
  order(roots, 1);
  return roots;
}

/** What is drawn, in order: every root, and every child of an open node. */
function shownOf(roots: TreeNode[], open: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (list: TreeNode[]) => {
    for (const node of list) {
      out.push(node);
      if (open.has(node.id)) walk(node.children);
    }
  };
  walk(roots);
  return out;
}

interface TreeListProps {
  table: TableMeta;
  spec: AppTreeList;
  entry: TableEntry;
  interactive?: boolean;
  label?: string;
  referenceLabels?: Record<string, string>;
}

export function TreeList({ table, spec, entry, interactive = true, label, referenceLabels }: TreeListProps) {
  const connection = state.activeConnection ?? null;
  const key = primaryKey(table);
  const columns = [...new Set([...key, ...listPresentationColumns(spec), ...Object.values(referenceLabels ?? {})])];
  const filter = splitQuery(entry.query).filter;
  const text = `${table.id}${filter ? ` ${filter}` : ''} show ${columns.join(', ')}`;
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'tree', text],
    queryFn: async () => {
      const data = (await api('/api/run', {
        q: text,
        limit: LIMIT,
        offset: 0,
        count: 'none',
        ...(connection ? ownedBy(connection) : {}),
      })) as {
        rows?: Array<Record<string, unknown>>;
        errors?: Array<{ message: string }>;
        more?: boolean;
      };
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return { rows: data.rows ?? [], more: Boolean(data.more) };
    },
  });
  /* The parent column names the record above by its key: a tree is over a single-column key. */
  const single = key.length === 1 ? key[0] : undefined;
  const roots = useMemo(
    () =>
      forestOf(
        answer.data?.rows ?? [],
        (row) => (single === undefined || row[single] == null ? null : String(row[single])),
        (row) => (row[spec.parent] == null || row[spec.parent] === '' ? null : String(row[spec.parent])),
        (row) => String(namedCell(table, spec.primary, row, referenceLabels).value ?? sayCopy('untitled')),
        (row) => keyOf(table, row) as Record<string, unknown> | null,
      ),
    [answer.data, single, spec, table, referenceLabels],
  );
  /* Every root opens on its first level, so the tree reads as more than a list of tops. */
  const [open, setOpen] = useState<ReadonlySet<string> | null>(null);
  const opened = open ?? new Set(roots.filter((root) => root.children.length).map((root) => root.id));
  const shown = shownOf(roots, opened);
  const [active, setActive] = useState<string>();
  const current = shown.find((node) => node.id === active) ?? shown[0];
  const items = useRef(new Map<string, HTMLLIElement>());
  const parentOf = useMemo(() => {
    const map = new Map<string, TreeNode>();
    const walk = (list: TreeNode[]) => list.forEach((node) => node.children.forEach((child) => (map.set(child.id, node), walk([child]))));
    walk(roots);
    return map;
  }, [roots]);

  const toggle = (node: TreeNode, to?: boolean) => {
    const next = new Set(opened);
    if (to ?? !next.has(node.id)) next.add(node.id);
    else next.delete(node.id);
    setOpen(next);
  };
  const go = (node: TreeNode | undefined) => {
    if (!node) return;
    setActive(node.id);
    items.current.get(node.id)?.focus();
  };
  const records: ModalRecord[] = shown.map((node) => ({ table: table.id, key: node.key, label: node.title }));
  const openIt = (node: TreeNode) => {
    if (interactive) void openRecord(table.id, node.key, node.title, 'push', { records });
  };
  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    if (!current) return;
    const at = shown.indexOf(current);
    const moves: Record<string, () => void> = {
      ArrowDown: () => go(shown[at + 1]),
      ArrowUp: () => go(shown[at - 1]),
      Home: () => go(shown[0]),
      End: () => go(shown[shown.length - 1]),
      ArrowRight: () => (current.children.length && !opened.has(current.id) ? toggle(current, true) : go(current.children[0])),
      ArrowLeft: () => (opened.has(current.id) ? toggle(current, false) : go(parentOf.get(current.id))),
      Enter: () => openIt(current),
    };
    const move = moves[event.key];
    if (!move) return;
    event.preventDefault();
    move();
  };

  if (answer.isError) return <p className="tree-note">{(answer.error as Error).message}</p>;
  if (!answer.data) return <div className="tree-list" aria-busy="true" />;
  if (!roots.length) return <p className="tree-note">{sayCopy('nothingHere')}</p>;
  return (
    <div className="tree-list">
      <ul role="tree" aria-label={label ?? table.name} className="tree-items" onKeyDown={onKey}>
        {shown.map((node) => {
          const branch = node.children.length > 0;
          const line = spec.lines?.[0];
          const said = line ? namedCell(table, line, node.row, referenceLabels) : undefined;
          return (
            <li
              key={node.id}
              ref={(element) => {
                if (element) items.current.set(node.id, element);
                else items.current.delete(node.id);
              }}
              role="treeitem"
              aria-level={node.depth}
              aria-expanded={branch ? opened.has(node.id) : undefined}
              aria-selected={node === current}
              tabIndex={node === current ? 0 : -1}
              className="tree-item"
              style={{ paddingInlineStart: `${(node.depth - 1) * 20 + 4}px` }}
              onFocus={() => setActive(node.id)}
              data-key={bulkKey(table, node.key)}
            >
              <span
                className={`tree-caret${branch ? '' : ' is-leaf'}`}
                aria-hidden="true"
                onClick={(event) => {
                  event.stopPropagation();
                  if (branch) toggle(node);
                }}
              >
                {branch && <Icon name={opened.has(node.id) ? 'caret-down' : 'caret-right'} size={12} />}
              </span>
              <span className="tree-title" onClick={() => openIt(node)}>
                {node.title}
              </span>
              {said && said.value !== null && said.value !== undefined && said.value !== '' && (
                <span className="tree-line">
                  <Value col={said.column} value={said.value} tableId={table.id} compact />
                </span>
              )}
              {branch && <span className="tree-count">{formatNumber(node.children.length)}</span>}
            </li>
          );
        })}
      </ul>
      {answer.data.more && <p className="tree-note">{sayCopy('firstOnly', { count: formatNumber(LIMIT) })}</p>}
    </div>
  );
}
