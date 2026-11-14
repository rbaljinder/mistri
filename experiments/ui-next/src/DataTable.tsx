import { ArrowDown, ArrowUp, DotsThree } from '@phosphor-icons/react';
import { Button } from '@ui-sdk/react/button';
import { Checkbox, CheckboxIndicator } from '@ui-sdk/react/checkbox';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@ui-sdk/react/menu';
import { createVirtualizer } from '@ui-sdk/core';
import {
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { zoomOf } from './behaviors/dress';
import { Editable, EditableInput, EditableValue } from './behaviors/Editable';
import { Widths, WidthsColumn, WidthsHandle } from './behaviors/Widths';
import { Skeleton } from './Skeleton';
import { words } from './words';

export type Column<T> = {
  id: string;
  header: string;
  cell: (row: T) => ReactNode;
  /* What the column sorts by. A column without one is not sortable. */
  sort?: (row: T) => string | number;
  align?: 'start' | 'end';
  /* The row's name: set in the ink at a heavier weight, and the link that opens the row. */
  primary?: boolean;
  /* The column's cells can be changed where they stand (with the table's `onCellEdit`): a cell's value as the
     text it is kept as, and what is wrong with a text, if anything. */
  edit?: { text: (row: T) => string; check?: (text: string, row: T) => string | undefined; inputMode?: 'text' | 'decimal' | 'numeric' };
  /* What the column comes to over every row, drawn or not: said in a row that stands at the table's foot. */
  total?: (rows: T[]) => ReactNode;
};

export type Sort = { column: string; descending: boolean };

export type RowAction = { value: string; label: string; separated?: boolean };

export type DataTableProps<T> = {
  label: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowName: (row: T) => string;
  /* The row shown elsewhere on the page (a panel beside the list), by its key. */
  current?: string;
  sort?: Sort | null;
  onSortChange?: (sort: Sort) => void;
  selected?: ReadonlySet<string>;
  onSelectedChange?: (selected: Set<string>) => void;
  hrefOf?: (row: T) => string;
  onOpen?: (row: T) => void;
  rowActions?: RowAction[];
  onRowAction?: (action: string, row: T) => void;
  empty?: ReactNode;
  /* The widths the reader has given columns, by column id, for a caller that keeps them; left out, the table
     keeps them itself. A column is sized by the bar at its edge, or with Alt and the arrows from its header. */
  widths?: Record<string, number>;
  onWidthsChange?: (widths: Record<string, number>) => void;
  /* Whether columns can be sized at all. On unless a page says otherwise. */
  sizable?: boolean;
  /* The rows are still being read: the head stands and this many rows wait in their place. */
  loading?: boolean;
  loadingRows?: number;
  /* Asked to keep a cell a reader changed. What it throws is said in the cell, which keeps what was typed. */
  onCellEdit?: (row: T, column: string, text: string) => void | Promise<void>;
  /* How tall the table may be, as CSS (`32rem`, `70dvh`). With it the table scrolls in its own box under a head
     that stays, and only the rows in view are drawn, so ten thousand rows cost what thirty do. */
  height?: string;
  /* The row's name (and its checkbox) stay at the leading edge while the rest scrolls sideways. */
  pinFirst?: boolean;
};

/* What a row is taken to be tall before it is measured, in pixels. */
const ROW = 40;

/* A cell's name among the cells being edited: its row and its column. */
const SEP = '\u001f';

/* Puts the keyboard on a row: on its name where that is a link, so Enter opens it as a link does, else on the row. */
export const focusRow = (row: Element | null | undefined): void => {
  if (row instanceof HTMLElement) (row.querySelector<HTMLElement>('td[data-primary] a') ?? row).focus();
};

/* How wide a waiting cell's bar is, so a waiting table is ragged like a real one and not a block of stripes. */
const WAITING = ['62%', '78%', '45%', '70%', '54%', '66%', '40%'];

const INTERACTIVE = 'a, button, input, [role="checkbox"], [role="menu"], [role="menuitem"]';

export function DataTable<T>({
  label,
  columns,
  rows,
  rowKey,
  rowName,
  current,
  sort,
  onSortChange,
  selected,
  onSelectedChange,
  hrefOf,
  onOpen,
  rowActions,
  onRowAction,
  empty,
  widths,
  onWidthsChange,
  sizable = true,
  loading,
  loadingRows = 8,
  onCellEdit,
  height,
  pinFirst,
}: DataTableProps<T>) {
  const lastToggled = useRef<string | null>(null);
  /* Only the rows in view are drawn when the table has a height of its own. The row the keyboard is on is kept
     drawn wherever the table is scrolled to, so scrolling it out of view does not drop the keyboard to the page;
     what the browser's find in page looks for is each row's name, drawn or not. */
  const scroller = useRef<HTMLDivElement | null>(null);
  const all = useRef(rows);
  all.current = rows;
  const held = useRef<number[]>([]);
  const arrive = useRef<string | null>(null);
  const windowed = useMemo(
    () =>
      createVirtualizer({
        count: () => all.current.length,
        estimate: () => ROW,
        key: (index) => {
          const row = all.current[index];
          return row === undefined ? String(index) : rowKey(row);
        },
        overscan: 6,
        keep: () => held.current,
        findable: (index) => {
          const row = all.current[index];
          return row === undefined ? '' : rowName(row);
        },
      }),
    // The table's rows are read through `all`, so one virtualizer serves it for its life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );
  const virtual = height !== undefined && !loading;

  /* A table lays its columns out from the rows it is showing, so a sort, a page or a tab that brings other rows
     nudges every column a few pixels sideways, and the eye that was on a column loses it. So the table lays its
     own columns out: each remembers the widest its own words have been, and the columns share the table's
     width in those proportions whatever rows are on the page. A column may grow once, when a longer value is
     first met, and never comes back; a column the reader has sized is theirs. Where the words need more than
     the box has, the table is as wide as they need and scrolls sideways, as it did before. */
  const [natural, setNatural] = useState<Record<string, number>>({});
  const [box, setBox] = useState(0);
  const shape = columns.map((column) => column.id).join('\u001f');
  const lastShape = useRef(shape);
  useLayoutEffect(() => {
    const table = scroller.current?.querySelector('table');
    if (!table || loading) return;
    const fresh = lastShape.current !== shape;
    lastShape.current = shape;
    const next: Record<string, number> = fresh ? {} : { ...natural };
    let grew = fresh && Object.keys(natural).length > 0;
    const zoom = zoomOf(table);
    const wide = (el: Element | null | undefined): number => (el ? el.getBoundingClientRect().width / zoom : 0);
    for (const column of columns) {
      const cells = table.querySelectorAll<HTMLElement>(`[data-col="${CSS.escape(column.id)}"]`);
      const first = cells[0];
      if (!first) continue;
      const style = getComputedStyle(first);
      const pad = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
      let need = 0;
      for (const cell of cells) need = Math.max(need, wide(cell.querySelector('[data-cell-words]')));
      // Nothing measures where nothing is laid out (a test, a hidden tab): the table is left to itself.
      if (need <= 0) continue;
      const asked = Math.ceil(need + pad) + 1;
      if (asked > (next[column.id] ?? 0)) {
        next[column.id] = asked;
        grew = true;
      }
    }
    // The two columns that hold a box and a button are as wide as the table first made them.
    for (const [name, cell] of [
      ['~select', table.querySelector('thead th[data-cell="select"]')],
      ['~actions', table.querySelector('thead th[data-cell="actions"]')],
    ] as const) {
      if (cell && next[name] === undefined && wide(cell) > 0) {
        next[name] = Math.ceil(wide(cell));
        grew = true;
      }
    }
    if (grew) setNatural(next);
  });
  useEffect(() => {
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const read = () => setBox(el.clientWidth);
    read();
    const watch = new ResizeObserver(read);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  /* The columns' widths, once every one is known: the sized ones as the reader set them, the rest sharing what
     is left in the proportions of their words, and never less than their words need. */
  const layout = (set: Record<string, number>): { table: number; of: Record<string, number> } | undefined => {
    if (box <= 0 || loading || !columns.every((column) => set[column.id] !== undefined || natural[column.id] !== undefined))
      return undefined;
    const narrow = (selectable ? (natural['~select'] ?? 0) : 0) + (rowActions ? (natural['~actions'] ?? 0) : 0);
    const sized = columns.reduce((sum, column) => sum + (set[column.id] ?? 0), 0);
    const words = columns.reduce((sum, column) => sum + (set[column.id] === undefined ? (natural[column.id] ?? 0) : 0), 0);
    const share = words > 0 ? Math.max(1, (box - narrow - sized) / words) : 1;
    const of: Record<string, number> = {};
    for (const column of columns) of[column.id] = set[column.id] ?? Math.round((natural[column.id] ?? 0) * share * 100) / 100;
    return { table: Math.max(box, narrow + sized + words * share), of };
  };
  useEffect(() => (virtual && scroller.current ? windowed.connect(scroller.current, { findable: true }) : undefined), [virtual, windowed]);
  useEffect(() => {
    if (virtual) windowed.refresh();
  }, [rows, virtual, windowed]);
  const inView = useSyncExternalStore(windowed.subscribe, windowed.items, windowed.items);
  // Until the box is measured (and where nothing measures), the first rows stand in.
  const slice = virtual ? (inView.length > 0 ? inView.map((item) => item.index) : rows.slice(0, 30).map((_, index) => index)) : undefined;
  const before = virtual && inView[0] ? inView[0].start : 0;
  const lastInView = inView[inView.length - 1];
  const after = virtual && lastInView ? Math.max(windowed.size() - lastInView.start - lastInView.size, 0) : 0;
  useEffect(() => {
    const key = arrive.current;
    if (key === null) return;
    const row = scroller.current?.querySelector<HTMLElement>(`tbody tr[data-key="${CSS.escape(key)}"]`);
    if (!row) return;
    arrive.current = null;
    focusRow(row);
  });
  /* Cells on their way to being kept, cells whose save was refused (with what was typed), and the one whose box
     holds a text that fails its check. */
  const [pending, setPending] = useState<Record<string, string>>({});
  const [failed, setFailed] = useState<Record<string, { text: string; why: string }>>({});
  const [wrong, setWrong] = useState<{ id: string; why: string } | null>(null);
  const cellOf = (id: string) => {
    const [key = '', columnId = ''] = id.split(SEP);
    return { row: rows.find((each) => rowKey(each) === key), column: columns.find((each) => each.id === columnId) };
  };
  const without = <V,>(map: Record<string, V>, id: string): Record<string, V> => {
    const { [id]: _gone, ...rest } = map;
    return rest;
  };
  const keep = async (id: string, row: T, columnId: string, text: string) => {
    setPending((now) => ({ ...now, [id]: text }));
    setFailed((now) => without(now, id));
    try {
      await onCellEdit?.(row, columnId, text);
    } catch (error) {
      const why = error instanceof Error && error.message ? error.message : words.notSaved;
      setFailed((now) => ({ ...now, [id]: { text, why } }));
    } finally {
      setPending((now) => without(now, id));
    }
  };
  const selectable = selected !== undefined && onSelectedChange !== undefined;
  const keys = rows.map(rowKey);
  const chosen = keys.filter((key) => selected?.has(key)).length;
  const span = columns.length + (selectable ? 1 : 0) + (rowActions ? 1 : 0);

  /* With Shift held, every row between this one and the last one toggled goes the same way: the way a reader
     picks a run of rows in any list they have used. */
  const toggle = (key: string, on: boolean, event?: Event) => {
    const next = new Set(selected);
    const from = lastToggled.current === null ? -1 : keys.indexOf(lastToggled.current);
    const to = keys.indexOf(key);
    const run =
      event && 'shiftKey' in event && event.shiftKey && from >= 0 ? keys.slice(Math.min(from, to), Math.max(from, to) + 1) : [key];
    for (const each of run) {
      if (on) next.add(each);
      else next.delete(each);
    }
    lastToggled.current = key;
    onSelectedChange?.(next);
  };

  const toggleAll = (on: boolean) => {
    const next = new Set(selected);
    for (const key of keys) {
      if (on) next.add(key);
      else next.delete(key);
    }
    onSelectedChange?.(next);
  };

  /* The whole row opens, but only a press that lands on no control of its own: the link in the name is the
     real one, for a keyboard and a new tab. */
  const openFromRow = (event: MouseEvent, row: T) => {
    if (!onOpen || (event.target as Element).closest(INTERACTIVE)) return;
    // A press on a cell that can be changed starts on the cell, not on the row.
    if ((event.target as Element).closest('[data-slot="editable-value"]')) return;
    if (window.getSelection()?.toString()) return;
    onOpen(row);
  };

  /* Up and Down walk the rows from a row or its name. A checkbox and a menu keep their own keys, and a row with
     no link of its own opens on Enter. */
  const walk = (event: KeyboardEvent<HTMLTableSectionElement>, shown: T[]) => {
    const target = event.target as HTMLElement;
    const row = target.closest('tr');
    if (!row || !(target === row || target.closest('td[data-primary]'))) return;
    if (virtual && ['ArrowDown', 'ArrowUp', 'Home', 'End', 'PageDown', 'PageUp'].includes(event.key)) {
      if ((event.key === 'Home' || event.key === 'End') && !event.ctrlKey && !event.metaKey && target !== row) return;
      const at = shown.findIndex((each) => rowKey(each) === row.dataset.key);
      const page = Math.max(Math.floor((scroller.current?.clientHeight ?? 400) / ROW) - 2, 1);
      const to =
        { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: shown.length - 1, PageDown: at + page, PageUp: at - page }[event.key] ?? at;
      const next = shown[Math.min(Math.max(to, 0), shown.length - 1)];
      if (at < 0 || !next) return;
      event.preventDefault();
      // The row is drawn before the keyboard goes to it: it may be a thousand rows away.
      held.current = [shown.indexOf(next)];
      windowed.scrollToIndex(held.current[0] ?? 0, { align: 'auto' });
      const there = scroller.current?.querySelector<HTMLElement>(`tbody tr[data-key="${CSS.escape(rowKey(next))}"]`);
      if (there) focusRow(there);
      else {
        arrive.current = rowKey(next);
        windowed.refresh();
      }
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const next = event.key === 'ArrowDown' ? row.nextElementSibling : row.previousElementSibling;
      if (!next || next.hasAttribute('data-empty')) return;
      event.preventDefault();
      focusRow(next);
    } else if (event.key === 'F2') {
      // From the row, F2 starts on its first cell that can be changed; Tab goes on from there.
      const first = row.querySelector<HTMLElement>('[data-slot="editable-value"]:not([data-locked])');
      if (first) {
        event.preventDefault();
        first.click();
      }
    } else if (event.key === 'Enter' && target === row && onOpen) {
      const found = shown.find((each) => rowKey(each) === row.dataset.key);
      if (found) onOpen(found);
    }
  };

  return (
    <div
      data-slot="data-table-scroll"
      ref={scroller}
      data-virtual={height === undefined ? undefined : ''}
      data-pin={pinFirst ? '' : undefined}
      style={height === undefined ? undefined : { maxHeight: height }}
      onFocus={(event) => {
        const key = (event.target as HTMLElement).closest<HTMLElement>('tbody tr[data-key]')?.dataset.key;
        const at = key === undefined ? -1 : rows.findIndex((row) => rowKey(row) === key);
        held.current = at < 0 ? [] : [at];
      }}
    >
      <Editable
        text={(id) => {
          const { row, column } = cellOf(id);
          return failed[id]?.text ?? (row && column?.edit ? column.edit.text(row) : '');
        }}
        locked={(id) => pending[id] !== undefined}
        onCancel={(id) => {
          setWrong(null);
          setFailed((now) => without(now, id));
        }}
        onCommit={(id, typed) => {
          const { row, column } = cellOf(id);
          if (!row || !column?.edit) return true;
          const text = typed.trim();
          const why = column.edit.check?.(text, row);
          if (why) {
            setWrong({ id, why });
            return false;
          }
          setWrong(null);
          if (text === column.edit.text(row)) setFailed((now) => without(now, id));
          else void keep(id, row, column.id, text);
          return true;
        }}
      >
        {(editing) => (
          <Widths value={widths} onValueChange={onWidthsChange}>
            {(set) => (
              <table
                data-slot="data-table"
                aria-label={label}
                aria-busy={loading || undefined}
                aria-rowcount={virtual ? rows.length + 1 : undefined}
                data-laid={layout(set) ? '' : undefined}
                style={layout(set) ? { tableLayout: 'fixed', width: layout(set)?.table } : undefined}
              >
                <colgroup>
                  {selectable && <col style={natural['~select'] ? { width: natural['~select'] } : undefined} />}
                  {columns.map((column) => (
                    <col key={column.id} style={layout(set) ? { width: layout(set)?.of[column.id] } : undefined} />
                  ))}
                  {rowActions && <col style={natural['~actions'] ? { width: natural['~actions'] } : undefined} />}
                </colgroup>
                <thead>
                  <tr>
                    {selectable && (
                      <th data-cell="select">
                        <Checkbox
                          aria-label={words.selectAll}
                          checked={chosen === 0 ? false : chosen === keys.length ? true : 'indeterminate'}
                          onCheckedChange={(next) => toggleAll(next === true)}
                        >
                          <CheckboxIndicator />
                        </Checkbox>
                      </th>
                    )}
                    {columns.map((column) => {
                      const sorted = sort?.column === column.id;
                      return (
                        <WidthsColumn
                          key={column.id}
                          value={column.id}
                          label={column.header}
                          data-align={column.align}
                          data-col={column.id}
                          data-primary={column.primary ? '' : undefined}
                          aria-sort={sorted ? (sort.descending ? 'descending' : 'ascending') : undefined}
                        >
                          {column.sort && onSortChange ? (
                            <Button
                              data-variant="bare"
                              data-cell-words=""
                              data-sorted={sorted ? '' : undefined}
                              onClick={() => onSortChange({ column: column.id, descending: sorted ? !sort.descending : false })}
                            >
                              {column.header}
                              {sorted && sort.descending ? <ArrowDown aria-hidden="true" /> : <ArrowUp aria-hidden="true" />}
                            </Button>
                          ) : (
                            <span data-cell-words="">{column.header}</span>
                          )}
                          {sizable && <WidthsHandle />}
                        </WidthsColumn>
                      );
                    })}
                    {rowActions && (
                      <th data-cell="actions">
                        <span data-slot="visually-hidden">{words.actions}</span>
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody onKeyDown={(event) => walk(event, rows)}>
                  {loading &&
                    Array.from({ length: loadingRows }, (_, at) => (
                      // eslint-disable-next-line react/no-array-index-key
                      <tr key={at} data-waiting="">
                        {selectable && <td data-cell="select" />}
                        {columns.map((column, index) => (
                          <td key={column.id} data-align={column.align}>
                            <Skeleton width={WAITING[(at + index * 3) % WAITING.length]} />
                          </td>
                        ))}
                        {rowActions && <td data-cell="actions" />}
                      </tr>
                    ))}
                  {before > 0 && (
                    <tr data-spacer="" aria-hidden="true">
                      <td colSpan={span} style={{ height: before }} />
                    </tr>
                  )}
                  {!loading &&
                    (slice
                      ? slice.flatMap((index) => (rows[index] === undefined ? [] : [{ row: rows[index] as T, index }]))
                      : rows.map((row, index) => ({ row, index }))
                    ).map(({ row, index }) => {
                      const key = rowKey(row);
                      const name = rowName(row);
                      const isSelected = selected?.has(key) ?? false;
                      return (
                        <tr
                          key={key}
                          data-key={key}
                          aria-rowindex={virtual ? index + 2 : undefined}
                          ref={virtual ? (el) => windowed.measure(index, el) : undefined}
                          tabIndex={-1}
                          data-selected={isSelected ? '' : undefined}
                          data-current={key === current ? '' : undefined}
                          data-opens={onOpen ? '' : undefined}
                          onClick={(event) => openFromRow(event, row)}
                        >
                          {selectable && (
                            <td data-cell="select">
                              <Checkbox
                                aria-label={words.select(name)}
                                checked={isSelected}
                                onCheckedChange={(next, details) => toggle(key, next === true, details?.event)}
                              >
                                <CheckboxIndicator />
                              </Checkbox>
                            </td>
                          )}
                          {columns.map((column) => (
                            <td
                              key={column.id}
                              data-align={column.align}
                              data-col={column.id}
                              data-primary={column.primary ? '' : undefined}
                              data-sized={set[column.id] === undefined ? undefined : ''}
                              style={set[column.id] === undefined ? undefined : { maxWidth: set[column.id] }}
                            >
                              {column.primary && onOpen ? (
                                <a
                                  data-cell-words=""
                                  href={hrefOf?.(row) ?? '#'}
                                  onClick={(event) => {
                                    if (event.metaKey || event.ctrlKey || event.shiftKey) return;
                                    event.preventDefault();
                                    onOpen(row);
                                  }}
                                >
                                  {column.cell(row)}
                                </a>
                              ) : column.edit && onCellEdit ? (
                                ((id: string) => (
                                  <EditableValue
                                    value={id}
                                    press
                                    title={editing === id ? undefined : words.editCell}
                                    data-pending={pending[id] === undefined ? undefined : ''}
                                    data-failed={failed[id] && editing !== id ? '' : undefined}
                                  >
                                    {/* What the cell shows stays under its box while it is edited, unseen, so the
                                        cell, its column and its row keep the size they had. */}
                                    <span data-slot="editable-shown" data-cell-words="" data-under={editing === id ? '' : undefined}>
                                      {pending[id] ?? failed[id]?.text ?? column.cell(row)}
                                    </span>
                                    {editing === id && (
                                      <EditableInput
                                        aria-label={`${column.header}, ${name}`}
                                        aria-invalid={wrong?.id === id ? true : undefined}
                                        inputMode={column.edit?.inputMode}
                                      />
                                    )}
                                    {wrong?.id === id && editing === id && (
                                      <span data-slot="editable-problem" role="alert">
                                        {wrong.why}
                                      </span>
                                    )}
                                    {failed[id] && editing !== id && <span data-slot="editable-problem">{failed[id].why}</span>}
                                  </EditableValue>
                                ))(`${key}${SEP}${column.id}`)
                              ) : (
                                <span data-cell-words="">{column.cell(row)}</span>
                              )}
                            </td>
                          ))}
                          {rowActions && (
                            <td data-cell="actions">
                              <Menu onAction={(value) => onRowAction?.(String(value), row)}>
                                <MenuTrigger aria-label={words.actionsFor(name)} data-variant="quiet">
                                  <DotsThree aria-hidden="true" weight="bold" />
                                </MenuTrigger>
                                <MenuContent align="end">
                                  {rowActions.map((action) => (
                                    <div key={action.value} style={{ display: 'contents' }}>
                                      {action.separated && <MenuSeparator />}
                                      <MenuItem value={action.value}>{action.label}</MenuItem>
                                    </div>
                                  ))}
                                </MenuContent>
                              </Menu>
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  {after > 0 && (
                    <tr data-spacer="" aria-hidden="true">
                      <td colSpan={span} style={{ height: after }} />
                    </tr>
                  )}
                  {!loading && rows.length === 0 && (
                    <tr data-empty="">
                      <td colSpan={span}>{empty ?? words.nothingHere}</td>
                    </tr>
                  )}
                </tbody>
                {!loading && rows.length > 0 && columns.some((column) => column.total) && (
                  <tfoot>
                    <tr>
                      {selectable && <td data-cell="select" />}
                      {columns.map((column, at) => (
                        <td key={column.id} data-align={column.align} data-primary={column.primary ? '' : undefined}>
                          {column.total ? column.total(rows) : at === 0 ? words.total : null}
                        </td>
                      ))}
                      {rowActions && <td data-cell="actions" />}
                    </tr>
                  </tfoot>
                )}
              </table>
            )}
          </Widths>
        )}
      </Editable>
    </div>
  );
}

export function sortRows<T>(rows: T[], columns: Column<T>[], sort: Sort | null | undefined): T[] {
  const by = sort && columns.find((column) => column.id === sort.column)?.sort;
  if (!sort || !by) return rows;
  const sign = sort.descending ? -1 : 1;
  return [...rows].sort((a, b) => {
    const x = by(a);
    const y = by(b);
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;
    return String(x).localeCompare(String(y), undefined, { numeric: true }) * sign;
  });
}
