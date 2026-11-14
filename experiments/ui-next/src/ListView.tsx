import { CaretDown, Check, MagnifyingGlass, Plus, X } from '@phosphor-icons/react';
import { Button } from '@ui-sdk/react/button';
import { Input, InputClear, InputGroup } from '@ui-sdk/react/input';
import { Menu, MenuCheckboxItem, MenuContent, MenuItemIndicator, MenuTrigger } from '@ui-sdk/react/menu';
import { Tabs, TabsIndicator, TabsList, TabsTab } from '@ui-sdk/react/tabs';
import { useShortcut } from '@ui-sdk/react/shortcuts';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { type ChosenColumns, ColumnChooser } from './ColumnChooser';
import { type Column, DataTable, focusRow, type RowAction, type Sort, sortRows } from './DataTable';
import type { ListState } from './listState';
import { SearchWords } from './Mark';
import { Pager } from './Pager';
import { Skeleton } from './Skeleton';
import { words } from './words';

export type ListTab<T> = { value: string; label: string; match?: (row: T) => boolean };

export type ListFilter<T> = { id: string; label: string; value: (row: T) => string };

export type BulkAction = { value: string; label: string };

export type ListViewProps<T> = {
  title: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowName: (row: T) => string;
  /* What the search box reads of a row. */
  searchText: (row: T) => string;
  tabs?: ListTab<T>[];
  filters?: ListFilter<T>[];
  defaultSort?: Sort;
  pageSize?: number;
  actions?: ReactNode;
  hrefOf?: (row: T) => string;
  onOpen?: (row: T) => void;
  rowActions?: RowAction[];
  onRowAction?: (action: string, row: T) => void;
  bulkActions?: BulkAction[];
  onBulkAction?: (action: string, keys: string[]) => void;
  /* The list's name is the page's heading unless the page it stands on already has one. */
  heading?: 'h1' | 'h2';
  /* What the list amounts to, said between its name and its rows: a strip of figures. */
  summary?: ReactNode;
  /* The row a panel beside the list is showing, by its key: it stays marked while the panel is open. */
  current?: string;
  /* Hears the rows as they stand after the tab, the search, the filters and the sort, so a panel can step through
     them in the order the reader sees. */
  onShownChange?: (rows: T[]) => void;
  /* Where the reader stood the last time they were here (listState.ts), and a hearing of every change to it. A
     caller that keeps it in the address gives a list that Back, a reload and a pasted link all restore. */
  initialState?: Partial<ListState>;
  onStateChange?: (state: ListState) => void;
  /* The rows are still being read: the list stands in its own shape and waits. */
  loading?: boolean;
  /* How tall the table may be, as CSS. With it the list is not paged: every row that matches is in one table
     that scrolls in its own box and draws only what is in view, for a list of thousands. */
  height?: string;
  /* The row's name stays at the leading edge while the rest scrolls sideways. */
  pinFirst?: boolean;
  /* Asked to keep a cell a reader changed, for columns that say they can be (`edit`). */
  onCellEdit?: (row: T, column: string, text: string) => void | Promise<void>;
  /* Lets the reader choose which columns show and in what order, from the list's bar. On unless a page says
     otherwise; a list of two or three columns has nothing to choose. */
  chooseColumns?: boolean;
  /* The list's keys: / to search, J and K (or the arrows, from a row) through the rows, X to select the row the
     keyboard is on. With a panel open beside the list, J and K step the panel. On unless a page says otherwise. */
  keyboard?: boolean;
};

/* A key meant for the list is not one typed into a dialog over it, a menu or a box with a list of its own. */
const free = (): boolean =>
  !document.querySelector('[aria-modal="true"]') && !document.activeElement?.closest('[role="menu"], [role="listbox"], [role="combobox"]');

function FilterChip<T>({
  filter,
  rows,
  chosen,
  onChange,
}: {
  filter: ListFilter<T>;
  rows: T[];
  chosen: string[];
  onChange: (next: string[]) => void;
}) {
  const options = useMemo(() => [...new Set(rows.map(filter.value))].sort(), [rows, filter]);
  const active = chosen.length > 0;
  return (
    <Menu
      onCheckedChange={(checked, details) => {
        const value = String(details.value);
        onChange(checked ? [...chosen, value] : chosen.filter((item) => item !== value));
      }}
    >
      <MenuTrigger data-kind="filter-chip" data-active={active ? '' : undefined}>
        {!active && <Plus aria-hidden="true" />}
        {filter.label}
        {active && <span data-slot="filter-chip-value">{chosen.length === 1 ? chosen[0] : words.chosenCount(chosen.length)}</span>}
        {active && <CaretDown aria-hidden="true" />}
      </MenuTrigger>
      <MenuContent align="start">
        {options.map((option) => (
          <MenuCheckboxItem key={option} value={option} checked={chosen.includes(option)}>
            <MenuItemIndicator keepMounted>
              <Check aria-hidden="true" weight="bold" />
            </MenuItemIndicator>
            {option}
          </MenuCheckboxItem>
        ))}
      </MenuContent>
    </Menu>
  );
}

export function ListView<T>({
  title,
  columns,
  rows,
  rowKey,
  rowName,
  searchText,
  tabs,
  filters = [],
  defaultSort,
  pageSize = 15,
  actions,
  hrefOf,
  onOpen,
  rowActions,
  onRowAction,
  bulkActions,
  onBulkAction,
  heading: Heading = 'h1',
  summary,
  current: marked,
  onShownChange,
  initialState,
  onStateChange,
  loading,
  onCellEdit,
  height,
  pinFirst,
  chooseColumns = true,
  keyboard = true,
}: ListViewProps<T>) {
  const [tab, setTab] = useState(() => tabs?.find((item) => item.value === initialState?.tab)?.value ?? tabs?.[0]?.value ?? null);
  const [search, setSearch] = useState(initialState?.search ?? '');
  const [chosen, setChosen] = useState<Record<string, string[]>>(initialState?.filters ?? {});
  const [sort, setSort] = useState<Sort | null>(initialState?.sort ?? defaultSort ?? null);
  const [page, setPage] = useState(initialState?.page ?? 1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /* The columns as the reader has them: every id in their order, and the ones put away. Started from what the
     caller remembers (the ids shown, in order), with the rest put away after them. */
  const given = columns.map((column) => column.id).join('\n');
  const [arranged, setArranged] = useState<ChosenColumns>(() => {
    const ids = columns.map((column) => column.id);
    const kept = initialState?.columns?.filter((id) => ids.includes(id));
    if (!kept?.length) return { order: ids, hidden: [] };
    const rest = ids.filter((id) => !kept.includes(id));
    return { order: [...kept, ...rest], hidden: rest };
  });
  const drawn = useMemo(() => {
    const byId = new Map(columns.map((column) => [column.id, column]));
    const known = arranged.order.filter((id) => byId.has(id));
    const order = [...known, ...columns.map((column) => column.id).filter((id) => !known.includes(id))];
    return order.filter((id) => !arranged.hidden.includes(id)).map((id) => byId.get(id)!);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [given, arranged, columns]);
  const rearranged = arranged.hidden.length > 0 || arranged.order.join('\n') !== given;
  const section = useRef<HTMLElement>(null);
  /* Which end of the next page the keyboard lands on, after J or K walked off this one. */
  const landing = useRef<'first' | 'last' | null>(null);

  const refined = useMemo(() => {
    const words = search.trim().toLowerCase();
    return rows.filter(
      (row) =>
        (!words || searchText(row).toLowerCase().includes(words)) &&
        filters.every((filter) => {
          const wanted = chosen[filter.id];
          return !wanted?.length || wanted.includes(filter.value(row));
        }),
    );
  }, [rows, search, chosen, filters, searchText]);

  const inTab = useMemo(() => {
    const match = tabs?.find((item) => item.value === tab)?.match;
    return sortRows(match ? refined.filter(match) : refined, columns, sort);
  }, [refined, tabs, tab, columns, sort]);

  /* Told only when the rows or their order change, not on every draw: a caller's columns and filters are new
     arrays each time, and a caller that keeps what it hears would otherwise draw this again without end. */
  const order = inTab.map(rowKey).join('\n');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => onShownChange?.(inTab), [order]);

  const pageCount = Math.max(1, Math.ceil(inTab.length / pageSize));
  /* While the rows are being read there is no telling how many pages they make, so the page asked for stands. */
  const current = loading ? page : Math.min(page, pageCount);
  const first = (current - 1) * pageSize;
  const shown = height === undefined ? inTab.slice(first, first + pageSize) : inTab;
  const refining = search.trim() !== '' || Object.values(chosen).some((values) => values.length > 0);

  const clear = () => {
    setSearch('');
    setChosen({});
    setPage(1);
  };

  /* Told after the first draw only: the state a caller handed in is not news to it. */
  const told = useRef(false);
  const filtersSaid = JSON.stringify(chosen);
  useEffect(() => {
    if (told.current)
      onStateChange?.({
        tab,
        search,
        filters: chosen,
        sort,
        page: current,
        columns: rearranged ? drawn.map((column) => column.id) : null,
      });
    told.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, search, filtersSaid, sort?.column, sort?.descending, current, rearranged, drawn]);

  const rowsDrawn = (): Element[] => [...(section.current?.querySelectorAll('tbody tr[data-key]') ?? [])];

  /* J and K. With a panel showing a row, they step it through the rows as the reader sees them, turning the page
     under it; with none, they walk the keyboard down the rows and off the end of a page onto the next. */
  const step = (by: 1 | -1) => {
    if (marked !== undefined && onOpen) {
      const at = inTab.findIndex((row) => rowKey(row) === marked);
      const next = inTab[at + by];
      if (at < 0 || !next) return;
      setPage(Math.floor((at + by) / pageSize) + 1);
      onOpen(next);
      return;
    }
    const drawn = rowsDrawn();
    const here = drawn.findIndex((row) => row.contains(document.activeElement));
    if (height !== undefined && here >= 0) {
      // Not every row is drawn: the table knows the one after this, and draws it before going to it.
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: by > 0 ? 'ArrowDown' : 'ArrowUp', bubbles: true, cancelable: true }),
      );
      return;
    }
    const to = here < 0 ? (by > 0 ? 0 : drawn.length - 1) : here + by;
    if (to >= drawn.length && current < pageCount) {
      landing.current = 'first';
      setPage(current + 1);
    } else if (to < 0 && current > 1) {
      landing.current = 'last';
      setPage(current - 1);
    } else focusRow(drawn[Math.min(Math.max(to, 0), drawn.length - 1)]);
  };
  useEffect(() => {
    if (!landing.current) return;
    const drawn = rowsDrawn();
    focusRow(landing.current === 'first' ? drawn[0] : drawn[drawn.length - 1]);
    landing.current = null;
  }, [current]);

  /* The row a panel shows is kept in view: the list turns to its page when it is opened from elsewhere (a link, a
     row of another page), and scrolls to it as the panel steps. */
  useEffect(() => {
    if (marked === undefined || loading) return;
    const at = inTab.findIndex((row) => rowKey(row) === marked);
    if (at >= 0) setPage(Math.floor(at / pageSize) + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [marked, loading]);
  useEffect(() => {
    if (marked !== undefined) section.current?.querySelector('tr[data-current]')?.scrollIntoView({ block: 'nearest' });
  }, [marked, current]);

  const on = keyboard && !loading;
  useShortcut(on ? '/' : null, () => section.current?.querySelector<HTMLElement>('[data-kind="search"] input')?.focus(), {
    when: free,
    description: words.search(title),
  });
  useShortcut(on ? 'j' : null, () => step(1), { when: free, description: words.nextRow });
  useShortcut(on ? 'k' : null, () => step(-1), { when: free, description: words.previousRow });
  useShortcut(
    on && bulkActions ? 'x' : null,
    () => {
      const key = rowsDrawn()
        .find((row) => row.contains(document.activeElement))
        ?.getAttribute('data-key');
      if (!key) return;
      const next = new Set(selected);
      if (!next.delete(key)) next.add(key);
      setSelected(next);
    },
    { when: free, description: words.selectRow },
  );

  return (
    <section ref={section} data-slot="list-view" aria-label={title}>
      <header data-slot="list-head">
        <Heading>
          {title} {!loading && <span data-slot="list-count">{rows.length.toLocaleString()}</span>}
        </Heading>
        {actions && <div data-slot="list-actions">{actions}</div>}
      </header>

      {summary}

      {tabs && (
        <Tabs
          value={tab}
          onValueChange={(next) => {
            setTab(next === null ? null : String(next));
            setPage(1);
          }}
        >
          <TabsList aria-label={words.views(title)}>
            {tabs.map((item) => (
              <TabsTab key={item.value} value={item.value}>
                {item.label}
                {!loading && (
                  <span data-slot="tab-count">{(item.match ? refined.filter(item.match).length : refined.length).toLocaleString()}</span>
                )}
              </TabsTab>
            ))}
            <TabsIndicator />
          </TabsList>
        </Tabs>
      )}

      <div data-slot="list-bar">
        <InputGroup data-kind="search">
          <MagnifyingGlass aria-hidden="true" />
          <Input
            type="search"
            aria-label={words.search(title)}
            aria-keyshortcuts={keyboard ? '/' : undefined}
            placeholder={words.searchPlaceholder}
            value={search}
            onValueChange={(value) => {
              setSearch(String(value));
              setPage(1);
            }}
          />
          <InputClear aria-label={words.clearSearch}>
            <X aria-hidden="true" />
          </InputClear>
          {keyboard && search === '' && (
            <kbd data-slot="kbd" aria-hidden="true">
              /
            </kbd>
          )}
        </InputGroup>
        {filters.map((filter) => (
          <FilterChip
            key={filter.id}
            filter={filter}
            rows={rows}
            chosen={chosen[filter.id] ?? []}
            onChange={(next) => {
              setChosen({ ...chosen, [filter.id]: next });
              setPage(1);
            }}
          />
        ))}
        {refining && (
          <Button data-variant="quiet" data-size="sm" onClick={clear}>
            {words.clear}
          </Button>
        )}
        {chooseColumns && columns.length > 3 && (
          <span data-slot="list-bar-end">
            <ColumnChooser
              columns={columns}
              value={arranged}
              onValueChange={setArranged}
              changed={rearranged}
              onReset={() => setArranged({ order: columns.map((column) => column.id), hidden: [] })}
            />
          </span>
        )}
      </div>

      <SearchWords.Provider value={search}>
        <DataTable
          loading={loading}
          loadingRows={Math.min(pageSize, 8)}
          label={title}
          columns={drawn}
          rows={shown}
          rowKey={rowKey}
          rowName={rowName}
          current={marked}
          sort={sort}
          onSortChange={setSort}
          selected={bulkActions ? selected : undefined}
          onSelectedChange={bulkActions ? setSelected : undefined}
          hrefOf={hrefOf}
          onOpen={onOpen}
          rowActions={rowActions}
          onRowAction={onRowAction}
          onCellEdit={onCellEdit}
          height={height}
          pinFirst={pinFirst}
          empty={
            <div data-slot="list-empty">
              <strong>{words.nothingMatches}</strong>
              <span>{words.nothingFits(title)}</span>
              {refining && <Button onClick={clear}>{words.clearAll}</Button>}
            </div>
          }
        />
      </SearchWords.Provider>

      <footer data-slot="list-foot">
        <span>
          {loading ? (
            <Skeleton width="6rem" />
          ) : inTab.length === 0 ? (
            words.noRows
          ) : height === undefined ? (
            words.range(first + 1, first + shown.length, inTab.length)
          ) : (
            words.rowsInAll(inTab.length)
          )}
        </span>
        {/* The keys, said where a reader with a keyboard looks once and a phone never shows them. */}
        {keyboard && !loading && inTab.length > 0 && (
          <span data-slot="list-keys" aria-hidden="true">
            <kbd data-slot="kbd">/</kbd> {words.keySearch}
            <kbd data-slot="kbd">J</kbd>
            <kbd data-slot="kbd">K</kbd> {marked !== undefined ? words.keyStep : words.keyMove}
            {bulkActions && (
              <>
                <kbd data-slot="kbd">X</kbd> {words.keySelect}
              </>
            )}
          </span>
        )}
        {!loading && height === undefined && pageCount > 1 && <Pager pageCount={pageCount} page={current} onPageChange={setPage} />}
      </footer>

      {/* What a selection can do rides over the list's foot, so choosing rows never moves them. */}
      {bulkActions && selected.size > 0 && (
        <div data-slot="bulk-bar" role="toolbar" aria-label={words.selectedRows}>
          <span data-slot="bulk-count">{words.selected(selected.size)}</span>
          {bulkActions.map((action) => (
            <Button
              key={action.value}
              data-variant="on-ink"
              data-size="sm"
              onClick={() => {
                onBulkAction?.(action.value, [...selected]);
                setSelected(new Set());
              }}
            >
              {action.label}
            </Button>
          ))}
          <Button data-variant="on-ink" data-size="sm" aria-label={words.clearSelection} onClick={() => setSelected(new Set())}>
            <X aria-hidden="true" />
          </Button>
        </div>
      )}
    </section>
  );
}
