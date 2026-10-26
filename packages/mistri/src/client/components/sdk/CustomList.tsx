/**
 * A list view's rows drawn by the App's own component (`customList`). The
 * list around them stays the platform's: its question — the standing query,
 * the tab, the filters, the sort — its paging (the pager under it), and its
 * selection and bulk actions (the bar over it), so a custom list reads,
 * pages, selects and acts exactly as a grid of the same view would. The
 * component is handed one page of rows, each with its keys and exactly the
 * presentation's `show`, and draws them.
 *
 * Opening a row goes through the walk with the list it is a page of, so a
 * record opened here steps to its neighbours as one opened from the grid
 * does (recordTrail.ts). Loaded on demand the first time a list holds one.
 */
import { useMemo } from 'react';
import type { AppAction } from '../../../shared/app.js';
import type { CustomListPresentation } from '@mistriwork/engine/shared/appComponents.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { keyOf, openRecord } from '@mistriwork/kit/client/core.js';
import { bulkKey } from '@mistriwork/kit/client/bulkActions.js';
import type { TrailList } from '@mistriwork/kit/client/recordTrail.js';
import type { BulkRecord, useBulkSelection } from '@mistriwork/kit/client/components/useBulkSelection.js';
import { CustomBody } from './CustomSection.js';
import type { OpenMode, UiRow } from './context.js';
import { pageBridge } from '@mistriwork/kit/client/uiBridge.js';
import { say } from '../../copy/components/components/sdk/CustomList.js';

/* A list without bulk actions (a page's embed) selects nothing. */
const NO_SELECTION: typeof useBulkSelection = () => ({
  offered: false,
  selection: [],
  change: () => {},
  clear: () => {},
  byId: new Map(),
  bar: <></>,
  dialogs: <></>,
});

export function CustomList({
  table,
  rows,
  spec,
  actions = [],
  interactive = true,
  label,
  list,
  total,
  page,
  useSelection = NO_SELECTION,
}: {
  table: TableMeta;
  rows: Array<Record<string, unknown>>;
  spec: CustomListPresentation;
  actions?: AppAction[];
  interactive?: boolean;
  label?: string;
  list?: TrailList;
  total?: number;
  page: { index: number; size: number };
  /** The list's selection and bulk actions (useBulkSelection), handed in by the list: the page's lists import each other in a circle this chunk stays out of. */
  useSelection?: typeof useBulkSelection;
}) {
  /* The rows the component may name back: each by its key, as the selection and the trail know it. */
  const keyed: BulkRecord[] = useMemo(
    () =>
      rows.flatMap((row) => {
        const key = keyOf(table, row) as Record<string, unknown> | null;
        return key ? [{ id: bulkKey(table, key), key, label: String(row[spec.show[0]] ?? say('common.untitled')), row }] : [];
      }),
    [rows, table, spec.show],
  );
  const byRow = new Map(keyed.map((record) => [record.row, record]));
  const { selection, change, clear, bar, dialogs, offered } = useSelection({ table, keyed, actions, interactive });
  const recordOf = (row: UiRow) =>
    byRow.get(row as Record<string, unknown>) ??
    keyed.find((record) => primaryKey(table).every((column) => String(record.row[column]) === String(row[column])));
  const open = (row: UiRow, how: { mode?: OpenMode } = {}) => {
    const record = recordOf(row);
    if (!record) return;
    const name = String(row[spec.show[0]] ?? '');
    if ((how.mode === 'drawer' || how.mode === 'modal') && pageBridge.openPeek)
      pageBridge.openPeek(table.id, { ...record.key }, name, how.mode);
    else
      void openRecord(table.id, record.key, name, 'push', { records: keyed.map(({ key, label: title }) => ({ key, label: title })), list });
  };
  const chosen = new Set(selection);
  const given = {
    rows,
    ...(typeof total === 'number' ? { total } : {}),
    page: { ...page, more: typeof total === 'number' ? (page.index + 1) * page.size < total : rows.length >= page.size },
    open,
    /* Present only when the reader can act on a group: the platform's bar over the list does the acting. */
    ...(offered && interactive
      ? {
          selection: {
            count: chosen.size,
            has: (row: UiRow) => {
              const record = recordOf(row);
              return Boolean(record && chosen.has(record.id));
            },
            toggle: (row: UiRow) => {
              const record = recordOf(row);
              if (!record) return;
              change(chosen.has(record.id) ? selection.filter((id) => id !== record.id) : [...selection, record.id]);
            },
            clear,
          },
        }
      : {}),
    props: spec.props ?? {},
    list: { resource: table.id, label: label ?? table.name, show: spec.show },
  };
  return (
    <>
      {offered && interactive && bar}
      <CustomBody id={spec.component.id} className="custom-list" given={given as never} />
      {dialogs}
    </>
  );
}
