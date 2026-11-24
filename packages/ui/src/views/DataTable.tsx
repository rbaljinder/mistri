/** Sortable, resizable, selectable data table with density modes, pinned columns, row menus, and narrow-screen card layout. */
import { Icon } from '../Icon.js';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { type CSSProperties, Fragment, type ReactNode, type Ref, useEffect, useMemo, useRef, useState } from 'react';
import {
  Editable,
  EditableInput,
  EditableValue,
  Sortable,
  SortableHandle,
  SortableItem,
  Widths,
  WidthsColumn,
  WidthsHandle,
} from '@mistriwork/ui/behaviors/index.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';
import { compareCells, sameRows } from './tableRules.js';

/** Sort direction for a `DataTable` column. */
export type SortDirection = 'asc' | 'desc';

/** Active column sort state in `DataTable`. */
export interface DataTableSort {
  columnId: string;
  direction: SortDirection;
}

/** Column definition for `DataTable`. */
export interface DataTableColumn<T> {
  id: string;
  header: ReactNode;
  headerLabel?: string;
  accessor?: keyof T | ((row: T) => unknown);
  cell?: (row: T, rowIndex: number) => ReactNode;
  align?: 'left' | 'center' | 'right';
  width?: number;
  sortable?: boolean;
  /** What the column sorts by, where it is not the cell's own value. Dates sort by time and numbers by size without one. */
  sortValue?: (row: T) => string | number;
  editable?: boolean;
  editText?: (row: T) => string;
  hideable?: boolean;
  defaultHidden?: boolean;
  mono?: boolean;
}

/** Per-row overflow menu action descriptor in `DataTable`. */
export interface DataTableRowAction<T> {
  id: string;
  label: string;
  icon?: ReactNode;
  shortcut?: string;
  destructive?: boolean;
  disabled?: boolean;
  onSelect: (row: T) => void;
}

/** Multi-row bulk action descriptor in `DataTable`. */
export interface DataTableBulkAction<T> {
  id: string;
  label: string;
  icon?: ReactNode;
  destructive?: boolean;
  /**
   * `selectedIds` is the selection, whole. `selectedRows` is the row for each of those ids the table has been shown,
   * in the same order: every one of them when the table holds all the data, and under server paging (`totalCount`)
   * the rows of the pages the person selected on, as they were when last displayed. An id the host selected itself
   * (`selectedIds`, `defaultSelectedIds`) on a page never displayed has no row, so act on the ids where the two
   * can differ.
   */
  onAction: (selectedIds: string[], selectedRows: T[]) => void;
}

/** Props for the `DataTable` view. */
export interface DataTableProps<T> {
  data: T[];
  columns: DataTableColumn<T>[];
  /**
   * A row's identity, which selection and inline edits are kept by. Without it a row's own `id` is used, and a row
   * with neither is known only by its position: its selection and edits cannot follow it through a filter, a sort
   * upstream or a refetch, so they are cleared whenever `data` changes. Pass this for a selection that lasts.
   */
  getRowId?: (row: T, index: number) => string;
  /** The rows are being fetched: placeholder rows stand in for an empty table, and the table says it is busy. */
  loading?: boolean;
  /* Sorting */
  sort?: DataTableSort | null;
  defaultSort?: DataTableSort | null;
  onSortChange?: (sort: DataTableSort | null) => void;
  manualSort?: boolean;
  /* Selection & Bulk Actions */
  selectable?: boolean;
  selectedIds?: string[];
  defaultSelectedIds?: string[];
  onSelectedIdsChange?: (ids: string[]) => void;
  bulkActions?: DataTableBulkAction<T>[];
  /* Column Resizing, Ordering & Visibility */
  columnConfigurable?: boolean;
  columnWidths?: Record<string, number>;
  defaultColumnWidths?: Record<string, number>;
  onColumnWidthsChange?: (widths: Record<string, number>) => void;
  columnOrder?: string[];
  defaultColumnOrder?: string[];
  onColumnOrderChange?: (order: string[]) => void;
  hiddenColumnIds?: string[];
  defaultHiddenColumnIds?: string[];
  onHiddenColumnIdsChange?: (hiddenIds: string[]) => void;
  /* Inline Cell Editing */
  onCellEdit?: (rowId: string, columnId: string, nextValue: string, row: T) => boolean | void;
  /* Grouping */
  groupBy?: keyof T | ((row: T) => string);
  renderGroupHeader?: (groupKey: string, count: number) => ReactNode;
  /* Row interaction & Actions */
  onRowClick?: (row: T) => void;
  rowActions?: (row: T) => DataTableRowAction<T>[];
  /* Chrome, Empty State & Pagination */
  toolbar?: ReactNode;
  stickyHeader?: boolean;
  maxHeight?: number | string;
  empty?: EmptyStateSpec | ReactNode;
  paginated?: boolean;
  pageSize?: number;
  page?: number;
  defaultPage?: number;
  onPageChange?: (page: number) => void;
  totalCount?: number;
  /** Responsive behavior on narrow viewports (<= 640px): stacked labeled cards by default, or horizontal scroll. */
  mobileLayout?: 'cards' | 'scroll';
  ariaLabel?: string;
  words?: DataTableWords;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

/** Localized UI strings for `DataTable` controls and menus. */
export interface DataTableWords {
  selectAllVisible?: string;
  rowActions?: string;
  actionsHeader?: string;
  sortAscending?: string;
  sortDescending?: string;
  clearSort?: string;
  hideColumn?: string;
  columnsButton?: string;
  displayColumns?: string;
  dragToReorder?: string;
  columnOrder?: string;
  bulkActionsRegion?: string;
  selectedSuffix?: string;
  clearSelection?: string;
  previousPage?: string;
  nextPage?: string;
  prevButton?: string;
  nextButton?: string;
}

const CELL_SEP = '\u001f';

function readColumnRawValue<T>(row: T, col: DataTableColumn<T>): unknown {
  if (typeof col.accessor === 'function') return col.accessor(row);
  if (col.accessor !== undefined) return row[col.accessor];
  return (row as Record<string, unknown>)[col.id];
}

function columnLabelOf<T>(col: DataTableColumn<T>): string {
  if (col.headerLabel) return col.headerLabel;
  if (typeof col.header === 'string' || typeof col.header === 'number') return String(col.header);
  return col.id;
}

/** Sortable, resizable, selectable data table with inline editing, grouping, bulk actions, and responsive card layout. */
export function DataTable<T>(props: DataTableProps<T>) {
  const {
    data,
    columns,
    getRowId,
    loading = false,
    sort: controlledSort,
    defaultSort = null,
    onSortChange,
    manualSort = false,
    selectable = false,
    selectedIds: controlledSelected,
    defaultSelectedIds = [],
    onSelectedIdsChange,
    bulkActions = [],
    columnConfigurable = true,
    columnWidths: controlledWidths,
    defaultColumnWidths,
    onColumnWidthsChange,
    columnOrder: controlledOrder,
    defaultColumnOrder,
    onColumnOrderChange,
    hiddenColumnIds: controlledHidden,
    defaultHiddenColumnIds,
    onHiddenColumnIdsChange,
    onCellEdit,
    groupBy,
    renderGroupHeader,
    onRowClick,
    rowActions,
    toolbar,
    stickyHeader = true,
    maxHeight,
    empty,
    paginated = false,
    pageSize = 15,
    page: controlledPage,
    defaultPage = 1,
    onPageChange,
    totalCount,
    mobileLayout = 'cards',
    ariaLabel = 'Data table',
    words,
    className,
    ref,
  } = props;
  const legacyEmpty = props as unknown as {
    emptyTitle?: ReactNode;
    emptyDescription?: ReactNode;
    emptyAction?: ReactNode;
  };
  /* --- Initial Defaults --- */
  const initialWidths = useMemo(() => {
    if (defaultColumnWidths) return defaultColumnWidths;
    const map: Record<string, number> = {};
    for (const col of columns) {
      if (col.width !== undefined) map[col.id] = col.width;
    }
    return map;
  }, [columns, defaultColumnWidths]);

  const initialOrder = useMemo(() => defaultColumnOrder ?? columns.map((c) => c.id), [columns, defaultColumnOrder]);

  const initialHidden = useMemo(
    () => defaultHiddenColumnIds ?? columns.filter((c) => c.defaultHidden).map((c) => c.id),
    [columns, defaultHiddenColumnIds],
  );

  /* --- State --- */
  const [internalSort, setInternalSort] = useState<DataTableSort | null>(defaultSort);
  const [internalSelected, setInternalSelected] = useState<string[]>(defaultSelectedIds);
  const [internalWidths, setInternalWidths] = useState<Record<string, number>>(initialWidths);
  const [internalOrder, setInternalOrder] = useState<string[]>(initialOrder);
  const [internalHidden, setInternalHidden] = useState<string[]>(initialHidden);
  const [internalPage, setInternalPage] = useState<number>(defaultPage);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [localEdits, setLocalEdits] = useState<Record<string, string>>({});

  const sort = controlledSort !== undefined ? controlledSort : internalSort;
  const selectedIds = controlledSelected !== undefined ? controlledSelected : internalSelected;
  const colWidths = controlledWidths !== undefined ? controlledWidths : internalWidths;
  const colOrder = controlledOrder !== undefined ? controlledOrder : internalOrder;
  const hiddenIds = controlledHidden !== undefined ? controlledHidden : internalHidden;
  const currentPage = controlledPage !== undefined ? controlledPage : internalPage;

  const setSort = (next: DataTableSort | null) => {
    if (controlledSort === undefined) setInternalSort(next);
    onSortChange?.(next);
  };

  const setSelectedIds = (next: string[]) => {
    if (controlledSelected === undefined) setInternalSelected(next);
    onSelectedIdsChange?.(next);
  };

  const setWidths = (next: Record<string, number>) => {
    if (controlledWidths === undefined) setInternalWidths(next);
    onColumnWidthsChange?.(next);
  };

  const setOrder = (next: string[]) => {
    if (controlledOrder === undefined) setInternalOrder(next);
    onColumnOrderChange?.(next);
  };

  const setHidden = (next: string[]) => {
    if (controlledHidden === undefined) setInternalHidden(next);
    onHiddenColumnIdsChange?.(next);
  };

  const setPage = (next: number) => {
    if (controlledPage === undefined) setInternalPage(next);
    onPageChange?.(next);
  };

  /* --- Ordered & Visible Columns --- */
  const columnsById = useMemo(() => {
    const map = new Map<string, DataTableColumn<T>>();
    for (const col of columns) map.set(col.id, col);
    return map;
  }, [columns]);

  const normalizedOrder = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const id of colOrder) {
      if (columnsById.has(id) && !seen.has(id)) {
        seen.add(id);
        list.push(id);
      }
    }
    for (const col of columns) {
      if (!seen.has(col.id)) {
        seen.add(col.id);
        list.push(col.id);
      }
    }
    return list;
  }, [colOrder, columns, columnsById]);

  const hiddenSet = useMemo(() => new Set(hiddenIds), [hiddenIds]);

  const visibleColumns = useMemo(
    () =>
      normalizedOrder
        .filter((id) => !hiddenSet.has(id))
        .map((id) => columnsById.get(id)!)
        .filter(Boolean),
    [normalizedOrder, hiddenSet, columnsById],
  );

  const resolveRowId = (row: T, index: number): string => {
    if (getRowId) return getRowId(row, index);
    const candidate = (row as Record<string, unknown> | null | undefined)?.id;
    return candidate !== undefined && candidate !== null ? String(candidate) : String(index);
  };

  /* Some row is known only by where it stands (no `getRowId`, no `id` of its own). */
  const idsArePositional = useMemo(
    () => !getRowId && data.some((row) => (row as Record<string, unknown> | null | undefined)?.id == null),
    [getRowId, data],
  );

  /* --- Sorted & Paginated Rows --- */
  const sortedRows = useMemo(() => {
    const indexed = data.map((row, index) => ({ row, id: resolveRowId(row, index), index }));
    if (!sort || manualSort) return indexed;
    const col = columnsById.get(sort.columnId);
    if (!col) return indexed;

    const dir = sort.direction === 'asc' ? 1 : -1;
    return [...indexed].sort((a, b) => {
      const editA = localEdits[`${a.id}${CELL_SEP}${col.id}`];
      const editB = localEdits[`${b.id}${CELL_SEP}${col.id}`];
      const valA = editA !== undefined ? editA : col.sortValue ? col.sortValue(a.row) : readColumnRawValue(a.row, col);
      const valB = editB !== undefined ? editB : col.sortValue ? col.sortValue(b.row) : readColumnRawValue(b.row, col);
      return compareCells(valA, valB, dir);
    });
  }, [data, sort, manualSort, columnsById, localEdits]);

  const totalItems = totalCount ?? sortedRows.length;
  const totalPages = Math.max(1, Math.ceil(totalItems / Math.max(1, pageSize)));
  const clampedPage = Math.min(Math.max(1, currentPage), totalPages);

  const visibleRows = useMemo(() => {
    if (!paginated || totalCount !== undefined) return sortedRows;
    const start = (clampedPage - 1) * pageSize;
    return sortedRows.slice(start, start + pageSize);
  }, [sortedRows, paginated, totalCount, clampedPage, pageSize]);

  /* --- Grouping --- */
  const groupedSections = useMemo(() => {
    if (!groupBy) return null;
    const buckets = new Map<string, typeof visibleRows>();
    for (const entry of visibleRows) {
      const rawKey = typeof groupBy === 'function' ? groupBy(entry.row) : String(entry.row[groupBy] ?? 'Other');
      const list = buckets.get(rawKey) ?? [];
      list.push(entry);
      buckets.set(rawKey, list);
    }
    return [...buckets.entries()].map(([groupKey, entries]) => ({ groupKey, entries }));
  }, [visibleRows, groupBy]);

  /* --- Selection --- */
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const allVisibleIds = useMemo(() => visibleRows.map((r) => r.id), [visibleRows]);
  const selectedVisibleCount = useMemo(() => allVisibleIds.filter((id) => selectedSet.has(id)).length, [allVisibleIds, selectedSet]);

  const headerCheckState: boolean | 'indeterminate' =
    allVisibleIds.length > 0 && selectedVisibleCount === allVisibleIds.length ? true : selectedVisibleCount > 0 ? 'indeterminate' : false;

  const toggleAllVisible = () => {
    if (headerCheckState === true) {
      const visibleSet = new Set(allVisibleIds);
      setSelectedIds(selectedIds.filter((id) => !visibleSet.has(id)));
    } else {
      const merged = new Set([...selectedIds, ...allVisibleIds]);
      setSelectedIds([...merged]);
    }
  };

  const toggleOneRow = (rowId: string) => {
    if (selectedSet.has(rowId)) {
      setSelectedIds(selectedIds.filter((id) => id !== rowId));
    } else {
      setSelectedIds([...selectedIds, rowId]);
    }
  };

  /* The rows a bulk action is handed, one for each selected id the table has ever been shown. Under server paging
     the selection outlives the page it was made on while `data` holds only the current one, so reading the rows
     off `data` alone gave an action forty ids and the fifteen rows of whichever page happened to be open. A selected
     row is remembered when its page is left; positional ids are not, since they name a different row on every page. */
  const shownRows = useRef(new Map<string, T>());
  const selectedRowObjects = useMemo(() => {
    const current = new Map(sortedRows.map((r) => [r.id, r.row]));
    const kept = new Map<string, T>();
    for (const id of selectedIds) {
      const row = current.get(id) ?? (idsArePositional ? undefined : shownRows.current.get(id));
      if (row !== undefined) kept.set(id, row);
    }
    shownRows.current = kept;
    return [...kept.values()];
  }, [sortedRows, selectedIds, idsArePositional]);

  /* --- Inline Editing --- */
  const hasEditableColumns = useMemo(() => columns.some((c) => c.editable), [columns]);

  const rowMap = useMemo(() => {
    const m = new Map<string, T>();
    for (const entry of sortedRows) m.set(entry.id, entry.row);
    return m;
  }, [sortedRows]);

  /* What the host's own data says a cell holds, or undefined where the row or the column is gone. */
  const upstreamCellText = (cellKey: string): string | undefined => {
    const sepAt = cellKey.indexOf(CELL_SEP);
    if (sepAt < 0) return undefined;
    const rowId = cellKey.slice(0, sepAt);
    const colId = cellKey.slice(sepAt + 1);
    const row = rowMap.get(rowId);
    const col = columnsById.get(colId);
    if (!row || !col) return undefined;
    if (col.editText) return col.editText(row);
    const raw = readColumnRawValue(row, col);
    return raw === undefined || raw === null ? '' : String(raw);
  };

  const getCellText = (cellKey: string): string => {
    if (localEdits[cellKey] !== undefined) return localEdits[cellKey]!;
    return upstreamCellText(cellKey) ?? '';
  };

  /* Rows known only by position cannot keep what was said of them once the rows change: after a filter, "row 2" is
     another record, and it was drawn ticked and showing the edit typed into the record that used to stand there.
     So when such data changes, the selection and the edits go. Rows are compared by what they hold, since a host
     that builds its array inline hands over new objects on every render. */
  const lastData = useRef(data);
  useEffect(() => {
    const before = lastData.current;
    lastData.current = data;
    if (!idsArePositional || sameRows(before, data)) return;
    if (selectedIds.length > 0) setSelectedIds([]);
    setLocalEdits((prev) => (Object.keys(prev).length === 0 ? prev : {}));
    // Only a change of the rows is the occasion; the selection is read as it stands then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, idsArePositional]);

  /* An edit is held here only until the host's data says the same thing, or until its row is gone. Held for good, it
     shadowed every later value of that cell: a correction made upstream, a refetch, another person's change. */
  useEffect(() => {
    setLocalEdits((prev) => {
      const keys = Object.keys(prev);
      const stale = keys.filter((key) => {
        const upstream = upstreamCellText(key);
        return upstream === undefined || upstream === prev[key];
      });
      if (stale.length === 0) return prev;
      const next = { ...prev };
      for (const key of stale) delete next[key];
      return next;
    });
    // `upstreamCellText` reads `rowMap` and `columnsById`, which are what this follows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowMap, columnsById, localEdits]);

  const commitCellEdit = (cellKey: string, nextValue: string): boolean => {
    const sepAt = cellKey.indexOf(CELL_SEP);
    if (sepAt < 0) return false;
    const rowId = cellKey.slice(0, sepAt);
    const colId = cellKey.slice(sepAt + 1);
    const row = rowMap.get(rowId);
    if (!row) return false;
    const accepted = onCellEdit?.(rowId, colId, nextValue, row);
    if (accepted === false) return false;
    setLocalEdits((prev) => ({ ...prev, [cellKey]: nextValue }));
    return true;
  };

  const cycleColumnSort = (colId: string) => {
    if (!sort || sort.columnId !== colId) {
      setSort({ columnId: colId, direction: 'asc' });
    } else if (sort.direction === 'asc') {
      setSort({ columnId: colId, direction: 'desc' });
    } else {
      setSort(null);
    }
  };

  const toggleGroupCollapse = (groupKey: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupKey)) next.delete(groupKey);
      else next.add(groupKey);
      return next;
    });
  };

  const toggleColumnVisibility = (colId: string) => {
    if (hiddenSet.has(colId)) {
      setHidden(hiddenIds.filter((id) => id !== colId));
    } else if (visibleColumns.length > 1) {
      setHidden([...hiddenIds, colId]);
    }
  };

  const totalColSpan = visibleColumns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  const cellWidthStyle = (width: number | undefined): CSSProperties | undefined =>
    width === undefined ? undefined : ({ '--table-col-w': `${width}px` } as CSSProperties);

  const renderDataRow = (entry: { row: T; id: string; index: number }, sizedWidths: Record<string, number>, editingKey: string | null) => {
    const { row, id: rowId, index } = entry;
    const isSelected = selectedSet.has(rowId);
    const actionsForRow = rowActions?.(row) ?? [];

    return (
      <tr
        key={rowId}
        className="nx-table-row"
        data-selected={isSelected ? '' : undefined}
        data-clickable={onRowClick ? '' : undefined}
        tabIndex={onRowClick ? 0 : undefined}
        onClick={(e) => {
          if (!onRowClick) return;
          const target = e.target as HTMLElement;
          if (target.closest('button, input, a, [data-slot="checkbox"], [data-slot="menu-trigger"], [data-slot="editable-input"]')) {
            return;
          }
          onRowClick(row);
        }}
        onKeyDown={(e) => {
          if (!onRowClick || e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onRowClick(row);
          }
        }}
      >
        {selectable && (
          <td className="nx-table-cell nx-table-cell-check" onClick={(e) => e.stopPropagation()}>
            <Checkbox
              checked={isSelected}
              onCheckedChange={() => toggleOneRow(rowId)}
              aria-label={`Select row ${rowId}`}
              className="nx-table-checkbox"
            >
              <CheckboxIndicator className="nx-table-checkbox-ind">
                <Icon name="check" size={11} weight="bold" />
              </CheckboxIndicator>
            </Checkbox>
          </td>
        )}

        {visibleColumns.map((col, colIdx) => {
          const cellKey = `${rowId}${CELL_SEP}${col.id}`;
          const editedText = localEdits[cellKey];
          const displayContent =
            editedText !== undefined ? editedText : col.cell ? col.cell(row, index) : String(readColumnRawValue(row, col) ?? '—');

          return (
            <td
              key={col.id}
              className={cx('nx-table-cell', col.mono && 'nx-table-cell-mono')}
              data-align={col.align ?? 'left'}
              data-label={columnLabelOf(col)}
              data-primary={colIdx === 0 ? '' : undefined}
              data-has-width={sizedWidths[col.id] !== undefined ? '' : undefined}
              style={cellWidthStyle(sizedWidths[col.id])}
            >
              {col.editable ? (
                <EditableValue value={cellKey} tabIndex={0} className="nx-table-editable">
                  {editingKey === cellKey ? (
                    <EditableInput aria-label={`Edit ${columnLabelOf(col)}`} onClick={(e) => e.stopPropagation()} />
                  ) : (
                    <span className="nx-table-cell-truncate">{displayContent}</span>
                  )}
                </EditableValue>
              ) : (
                <div className="nx-table-cell-inner">{displayContent}</div>
              )}
            </td>
          );
        })}

        {rowActions && (
          <td className="nx-table-cell nx-table-cell-actions" onClick={(e) => e.stopPropagation()}>
            {actionsForRow.length > 0 && (
              <Menu>
                <MenuTrigger className="nx-table-row-menu-btn" aria-label={words?.rowActions ?? 'Row actions'}>
                  <Icon name="dots-three" size={16} weight="bold" />
                </MenuTrigger>
                <MenuContent align="end" sideOffset={4} className="nx-table-menu">
                  {actionsForRow.map((act, aIdx) => (
                    <Fragment key={act.id}>
                      {act.destructive && aIdx > 0 && <MenuSeparator className="nx-menu-sep" />}
                      <MenuItem
                        value={act.id}
                        destructive={act.destructive}
                        disabled={act.disabled}
                        shortcut={act.shortcut}
                        onSelect={() => act.onSelect(row)}
                        className="nx-table-menu-item"
                      >
                        {act.icon && <span className="nx-table-menu-icon">{act.icon}</span>}
                        <span>{act.label}</span>
                      </MenuItem>
                    </Fragment>
                  ))}
                </MenuContent>
              </Menu>
            )}
          </td>
        )}
      </tr>
    );
  };

  const renderTableContents = (editingKey: string | null) => (
    <Widths value={colWidths} onValueChange={setWidths} min={72} max={640}>
      {(sizedWidths) => (
        /* The one place the table scrolls, sideways past the columns that fit and down past its height, and it says
           so for the check that looks for a page scrolling twice (gradeProbe.ts). */
        <div
          className="nx-table-scroll"
          data-scrolls=""
          data-sticky={stickyHeader ? '' : undefined}
          style={maxHeight !== undefined ? { maxHeight } : undefined}
        >
          <table className="nx-table" aria-label={ariaLabel} aria-busy={loading ? true : undefined}>
            <thead className="nx-table-head">
              <tr>
                {selectable && (
                  <th scope="col" className="nx-table-th nx-table-th-check">
                    <Checkbox
                      checked={headerCheckState}
                      onCheckedChange={toggleAllVisible}
                      aria-label={words?.selectAllVisible ?? 'Select all visible rows'}
                      className="nx-table-checkbox"
                    >
                      <CheckboxIndicator className="nx-table-checkbox-ind">
                        {headerCheckState === 'indeterminate' ? (
                          <Icon name="minus" size={11} weight="bold" />
                        ) : (
                          <Icon name="check" size={11} weight="bold" />
                        )}
                      </CheckboxIndicator>
                    </Checkbox>
                  </th>
                )}

                {visibleColumns.map((col) => {
                  const isSorted = sort?.columnId === col.id ? sort.direction : null;
                  const canHide = col.hideable !== false && visibleColumns.length > 1;
                  const labelText = columnLabelOf(col);

                  return (
                    <WidthsColumn
                      key={col.id}
                      value={col.id}
                      label={labelText}
                      scope="col"
                      aria-sort={isSorted === 'asc' ? 'ascending' : isSorted === 'desc' ? 'descending' : col.sortable ? 'none' : undefined}
                      className="nx-table-th"
                      data-align={col.align ?? 'left'}
                    >
                      <div className="nx-table-th-content" data-align={col.align ?? 'left'}>
                        {col.sortable ? (
                          <button
                            type="button"
                            className="nx-table-sort-btn"
                            data-sorted={isSorted ?? undefined}
                            onClick={() => cycleColumnSort(col.id)}
                          >
                            <span>{col.header}</span>
                            <span className="nx-table-sort-icon" aria-hidden="true">
                              {isSorted === 'asc' ? (
                                <Icon name="arrow-up" size={12} weight="bold" />
                              ) : isSorted === 'desc' ? (
                                <Icon name="arrow-down" size={12} weight="bold" />
                              ) : (
                                <Icon name="arrows-down-up" size={12} />
                              )}
                            </span>
                          </button>
                        ) : (
                          <span className="nx-table-th-label">{col.header}</span>
                        )}

                        {(col.sortable || canHide) && (
                          <Menu>
                            <MenuTrigger className="nx-table-th-menu-btn" aria-label={`${labelText} column options`}>
                              <Icon name="caret-down" size={11} weight="bold" />
                            </MenuTrigger>
                            <MenuContent align="start" sideOffset={4} className="nx-table-menu">
                              {col.sortable && (
                                <>
                                  <MenuItem
                                    value="asc"
                                    onSelect={() => setSort({ columnId: col.id, direction: 'asc' })}
                                    className="nx-table-menu-item"
                                  >
                                    <Icon name="arrow-up" size={13} />
                                    <span>{words?.sortAscending ?? 'Sort ascending'}</span>
                                  </MenuItem>
                                  <MenuItem
                                    value="desc"
                                    onSelect={() => setSort({ columnId: col.id, direction: 'desc' })}
                                    className="nx-table-menu-item"
                                  >
                                    <Icon name="arrow-down" size={13} />
                                    <span>{words?.sortDescending ?? 'Sort descending'}</span>
                                  </MenuItem>
                                  {isSorted && (
                                    <MenuItem value="clear-sort" onSelect={() => setSort(null)} className="nx-table-menu-item">
                                      <Icon name="x" size={13} />
                                      <span>{words?.clearSort ?? 'Clear sort'}</span>
                                    </MenuItem>
                                  )}
                                </>
                              )}
                              {col.sortable && canHide && <MenuSeparator className="nx-menu-sep" />}
                              {canHide && (
                                <MenuItem value="hide" onSelect={() => toggleColumnVisibility(col.id)} className="nx-table-menu-item">
                                  <Icon name="eye-slash" size={13} />
                                  <span>{words?.hideColumn ?? 'Hide column'}</span>
                                </MenuItem>
                              )}
                            </MenuContent>
                          </Menu>
                        )}
                      </div>
                      <WidthsHandle />
                    </WidthsColumn>
                  );
                })}

                {rowActions && (
                  <th scope="col" className="nx-table-th nx-table-th-actions" aria-label={words?.actionsHeader ?? 'Actions'} />
                )}
              </tr>
            </thead>

            <tbody className="nx-table-body">
              {visibleRows.length === 0 && loading ? (
                /* Rows on their way are not "No matching records": placeholders hold the table's shape until they
                   arrive, and are not read out (the table itself is marked busy). */
                Array.from({ length: Math.min(5, Math.max(1, pageSize)) }, (_, at) => (
                  <tr key={`loading-${at}`} className="nx-table-row" data-loading="" aria-hidden="true">
                    {selectable && <td className="nx-table-cell nx-table-cell-check" />}
                    {visibleColumns.map((col, colIdx) => (
                      <td
                        key={col.id}
                        className="nx-table-cell"
                        data-align={col.align ?? 'left'}
                        data-primary={colIdx === 0 ? '' : undefined}
                      >
                        <span className="nx-skeleton" style={{ height: '0.75rem', width: `${55 + ((at + colIdx) % 3) * 15}%` }} />
                      </td>
                    ))}
                    {rowActions && <td className="nx-table-cell nx-table-cell-actions" />}
                  </tr>
                ))
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={totalColSpan} className="nx-table-empty-cell">
                    {empty !== undefined && !isEmptyStateSpec(empty) ? (
                      <div className="nx-table-empty">{empty}</div>
                    ) : (
                      <div className="nx-table-empty">
                        <span className="nx-table-empty-icon" aria-hidden="true">
                          <Icon name="table" size={22} />
                        </span>
                        <div className="nx-table-empty-title">
                          {isEmptyStateSpec(empty) ? empty.title : (legacyEmpty.emptyTitle ?? 'No matching records')}
                        </div>
                        {(
                          isEmptyStateSpec(empty)
                            ? empty.body
                            : (legacyEmpty.emptyDescription ??
                              (empty === undefined ? 'Try adjusting your filters or create a new item to get started.' : undefined))
                        ) ? (
                          <div className="nx-table-empty-desc">
                            {isEmptyStateSpec(empty)
                              ? empty.body
                              : (legacyEmpty.emptyDescription ?? 'Try adjusting your filters or create a new item to get started.')}
                          </div>
                        ) : null}
                        {(isEmptyStateSpec(empty) ? empty.action : legacyEmpty.emptyAction) ? (
                          <div className="nx-table-empty-action">{isEmptyStateSpec(empty) ? empty.action : legacyEmpty.emptyAction}</div>
                        ) : null}
                      </div>
                    )}
                  </td>
                </tr>
              ) : groupedSections ? (
                groupedSections.map(({ groupKey, entries }) => {
                  const isCollapsed = collapsedGroups.has(groupKey);
                  return (
                    <Fragment key={groupKey}>
                      <tr className="nx-table-group-row">
                        <td colSpan={totalColSpan} className="nx-table-group-cell">
                          <button
                            type="button"
                            className="nx-table-group-btn"
                            aria-expanded={!isCollapsed}
                            onClick={() => toggleGroupCollapse(groupKey)}
                          >
                            <Icon
                              name="caret-right"
                              size={12}
                              weight="bold"
                              className="nx-table-group-caret"
                              data-open={!isCollapsed ? '' : undefined}
                            />
                            {renderGroupHeader ? (
                              renderGroupHeader(groupKey, entries.length)
                            ) : (
                              <>
                                <span className="nx-table-group-title">{groupKey}</span>
                                <span className="nx-badge" data-pill="">
                                  {entries.length}
                                </span>
                              </>
                            )}
                          </button>
                        </td>
                      </tr>
                      {!isCollapsed && entries.map((entry) => renderDataRow(entry, sizedWidths, editingKey))}
                    </Fragment>
                  );
                })
              ) : (
                visibleRows.map((entry) => renderDataRow(entry, sizedWidths, editingKey))
              )}
            </tbody>
          </table>
        </div>
      )}
    </Widths>
  );

  const rangeStart = totalItems === 0 ? 0 : (clampedPage - 1) * pageSize + 1;
  const rangeEnd = Math.min(totalItems, clampedPage * pageSize);

  return (
    <div ref={ref} className={cx('nx-data-table-wrap', className)}>
      {(toolbar || columnConfigurable) && (
        <div className="nx-table-toolbar">
          <div className="nx-table-toolbar-left">{toolbar}</div>
          {columnConfigurable && (
            <div className="nx-table-toolbar-right">
              <Popover>
                <PopoverTrigger className="nx-table-columns-btn">
                  <Icon name="columns" size={14} />
                  <span>{words?.columnsButton ?? 'Columns'}</span>
                </PopoverTrigger>
                <PopoverContent align="end" sideOffset={6} className="nx-table-columns-popover">
                  <div className="nx-table-columns-header">
                    <span>{words?.displayColumns ?? 'Display columns'}</span>
                    <span className="nx-table-columns-hint">{words?.dragToReorder ?? 'Drag to reorder'}</span>
                  </div>
                  <Sortable
                    by="handle"
                    value={normalizedOrder}
                    onValueChange={setOrder}
                    aria-label={words?.columnOrder ?? 'Column order'}
                    className="nx-table-columns-list"
                  >
                    {(colId) => {
                      const col = columnsById.get(colId);
                      if (!col) return null;
                      const label = columnLabelOf(col);
                      const isVisible = !hiddenSet.has(colId);
                      const disableToggle = col.hideable === false || (isVisible && visibleColumns.length <= 1);
                      return (
                        <SortableItem key={colId} value={colId} className="nx-table-columns-item">
                          <SortableHandle aria-label={`Reorder ${label}`} />
                          <Checkbox
                            checked={isVisible}
                            disabled={disableToggle}
                            onCheckedChange={() => toggleColumnVisibility(colId)}
                            aria-label={`Show ${label}`}
                            className="nx-table-checkbox"
                          >
                            <CheckboxIndicator className="nx-table-checkbox-ind">
                              <Icon name="check" size={11} weight="bold" />
                            </CheckboxIndicator>
                          </Checkbox>
                          <span className="nx-table-columns-label">{label}</span>
                        </SortableItem>
                      );
                    }}
                  </Sortable>
                </PopoverContent>
              </Popover>
            </div>
          )}
        </div>
      )}

      <div className="nx-data-table-surface" data-mobile-layout={mobileLayout}>
        {hasEditableColumns ? (
          <Editable text={getCellText} onCommit={commitCellEdit}>
            {(editingKey) => renderTableContents(editingKey)}
          </Editable>
        ) : (
          renderTableContents(null)
        )}

        {/* Floating Bulk Selection Bar */}
        {selectable && selectedIds.length > 0 && (
          <div className="nx-table-bulk-bar" role="region" aria-label={words?.bulkActionsRegion ?? 'Bulk selection actions'}>
            <span className="nx-table-bulk-count">
              <span className="nx-badge" data-tone="accent" data-pill="">
                {selectedIds.length}
              </span>
              <span>{words?.selectedSuffix ?? 'selected'}</span>
            </span>

            {bulkActions.length > 0 && (
              <div className="nx-table-bulk-actions">
                {bulkActions.map((act) => (
                  <Button
                    key={act.id}
                    data-size="xs"
                    data-variant={act.destructive ? 'danger-soft' : 'outline'}
                    onClick={() => act.onAction(selectedIds, selectedRowObjects)}
                  >
                    {act.icon}
                    <span>{act.label}</span>
                  </Button>
                ))}
              </div>
            )}

            <button
              type="button"
              className="nx-table-bulk-clear"
              onClick={() => setSelectedIds([])}
              aria-label={words?.clearSelection ?? 'Clear selection'}
            >
              <Icon name="x" size={12} weight="bold" />
            </button>
          </div>
        )}

        {/* Pagination Footer */}
        {paginated && (
          <div className="nx-table-footer">
            <span className="nx-table-footer-meta">
              Showing <strong>{rangeStart}</strong>–<strong>{rangeEnd}</strong> of <strong>{totalItems}</strong>
            </span>
            <div className="nx-table-pagination">
              <Button
                data-size="xs"
                data-variant="outline"
                disabled={clampedPage <= 1}
                onClick={() => setPage(clampedPage - 1)}
                aria-label={words?.previousPage ?? 'Previous page'}
              >
                <Icon name="caret-left" size={12} weight="bold" />
                <span>{words?.prevButton ?? 'Prev'}</span>
              </Button>
              <span className="nx-table-page-indicator">
                Page {clampedPage} of {totalPages}
              </span>
              <Button
                data-size="xs"
                data-variant="outline"
                disabled={clampedPage >= totalPages}
                onClick={() => setPage(clampedPage + 1)}
                aria-label={words?.nextPage ?? 'Next page'}
              >
                <span>{words?.nextButton ?? 'Next'}</span>
                <Icon name="caret-right" size={12} weight="bold" />
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
