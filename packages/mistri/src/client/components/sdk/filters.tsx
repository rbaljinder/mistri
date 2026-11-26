/**
 * `<ListFilters>` — mounts Mistri's real list filter machine (live facet counts, numeric min/max with minor-unit
 * money conversion, text search with make/model suggestions, sort menu, and URL query state) inside a custom
 * `definePage`, handing the compiled server query and sort to the page so the author renders their own cards/rows.
 */
import { useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { columnDisplay, columnLabel, state } from '@mistriwork/kit/client/core.js';
import { tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { andQuery } from '@mistriwork/engine/shared/query.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import { splitQuery } from '@mistriwork/kit/client/clauses.js';
import { withCondition } from '@mistriwork/kit/client/filterbar.js';
import { boxesFor, boxTail } from '@mistriwork/kit/client/components/FilterBoxes.js';
import { FilterRail, FilterSheet, type FacetUnit } from '@mistriwork/kit/client/components/FilterRail.js';
import { ListFilterBar } from '@mistriwork/kit/client/components/ListFilterBar.js';
import { SortMenu } from '@mistriwork/kit/client/components/SortMenu.js';
import { FilterPageContext } from '@mistriwork/kit/client/components/filterPageContext.js';
import { PHONE_QUERY, useMediaQuery } from '@mistriwork/kit/client/components/useMediaQuery.js';
import type { DisplayRule } from '@mistriwork/kit/client/components/valueModel.js';
import { UiPageContext } from './context.js';
import './filters.css';

interface ListFilterSort {
  label: string;
  sort: string;
}

interface ListFiltersRenderState {
  /** Full Mistri filter query (standing + active user filters) ready to pass to `useRows(from, { query, sort })`. */
  query: string;
  /** Active sort expression (e.g. `'price_cents asc'`) ready to pass to `useRows(from, { query, sort })`. */
  sort: string | undefined;
  /** The user's active filter/sort refinement without `standing`. */
  refinement: string;
  /** Reset all active filter facets and return to the default sort. */
  clear: () => void;
}

interface ListFiltersProps {
  /** Resource name (must be declared in `definePage({ reads: [...] })`). */
  from: string;
  /** Columns/paths offered as facets (live counts, min/max ranges, dates, text). */
  filters: readonly string[];
  /** Optional suggestion columns per text filter (e.g. `{ title: ['make', 'model'] }`). */
  suggest?: Readonly<Record<string, readonly string[]>>;
  /** Optional sort choices rendered as a Sort menu beside the filters. */
  sorts?: readonly ListFilterSort[];
  /** Default sort expression when the visitor has not picked one. */
  sort?: string;
  /** Standing condition always held underneath counts and returned in `query` (e.g. `'status = live'`). */
  standing?: string;
  /** Page URL param storing the active refinement (defaults to `'q'` when declared in `definePage({ params })`). */
  param?: string;
  /** `'rail'` draws a facet sidebar beside the results; `'bar'` draws the horizontal search + filter popovers bar. */
  layout?: 'bar' | 'rail';
  /** Search box label / placeholder text. */
  label?: string;
  className?: string;
  children: (state: ListFiltersRenderState) => ReactNode;
}

function splitRefinement(tableId: string, raw: string): { filter: string; sort: string | undefined } {
  const trimmed = raw.trim();
  if (!trimmed) return { filter: '', sort: undefined };
  const parts = splitQuery(`${tableId} ${trimmed}`) as { filter?: string; sort?: string };
  const filter = (parts.filter ?? '').trim();
  const sortClause = (parts.sort ?? '').trim();
  const sort = sortClause ? sortClause.replace(/^sort\s+/i, '').trim() : undefined;
  return { filter, sort };
}

export function ListFilters({
  from,
  filters,
  suggest,
  sorts,
  sort: defaultSort,
  standing = '',
  param = 'q',
  layout = 'rail',
  label,
  className,
  children,
}: ListFiltersProps) {
  const frame = useContext(UiPageContext);
  const canBindParam = Boolean(frame && param && frame.params.includes(param));
  const paramValue = canBindParam ? (frame!.get(param) ?? '') : '';
  const [localValue, setLocalValue] = useState('');
  const [typed, setTyped] = useState<string | undefined>(undefined);
  const [sheet, setSheet] = useState(false);
  const phone = useMediaQuery(PHONE_QUERY);

  const rawRefinement = canBindParam ? paramValue : localValue;
  const setRawRefinement = useCallback(
    (next: string) => {
      if (canBindParam) frame!.set(param, next === '' ? undefined : next);
      else setLocalValue(next);
    },
    [canBindParam, frame, param],
  );

  const table = state.schema ? (tableNamed(state.schema, from) as TableMeta | undefined) : undefined;
  const tableId = table?.id ?? from;

  const boxes = useMemo(() => {
    if (!table) return [];
    const labelOf = (name: string) => (columnLabel(table.id, name) as string | null) ?? humanName(name.split('.').pop() ?? name);
    const built = boxesFor(table, [...filters], labelOf);
    if (!suggest) return built;
    return built.map((box) => (Object.hasOwn(suggest, box.column) ? { ...box, suggest: suggest[box.column] } : box));
  }, [table, filters, suggest]);

  const unitOf = useCallback(
    (column: string): FacetUnit | undefined => {
      if (!table) return undefined;
      const rule = columnDisplay(table.id, column) as DisplayRule | null;
      if (!rule) return undefined;
      if (rule.format === 'money') return { currency: rule.currency };
      if (rule.unit) return { unit: rule.unit };
      return undefined;
    },
    [table],
  );

  const { filter: activeFilter, sort: activeSort } = useMemo(() => splitRefinement(tableId, rawRefinement ?? ''), [tableId, rawRefinement]);
  const fullQuery = useMemo(() => andQuery(standing, activeFilter) ?? '', [standing, activeFilter]);
  const effectiveSort = activeSort ?? defaultSort;

  const updateFilter = useCallback(
    (nextFilter: string) => {
      const cleaned = nextFilter.trim();
      const next = activeSort ? (cleaned ? `${cleaned} sort ${activeSort}` : `sort ${activeSort}`) : cleaned;
      setRawRefinement(next);
      setTyped(undefined);
    },
    [activeSort, setRawRefinement],
  );

  const updateSortFromQuery = useCallback(
    (full: string) => {
      const parts = splitQuery(full) as { filter?: string; sort?: string };
      const filter = (parts.filter ?? '').trim();
      const sortClause = (parts.sort ?? '').trim();
      const sort = sortClause ? sortClause.replace(/^sort\s+/i, '').trim() : undefined;
      const next = sort ? (filter ? `${filter} sort ${sort}` : `sort ${sort}`) : filter;
      setRawRefinement(next);
    },
    [setRawRefinement],
  );

  const clear = useCallback(() => {
    setRawRefinement('');
    setTyped(undefined);
  }, [setRawRefinement]);

  const searchBox = boxes.find((b) => b.kind === 'text');
  const onSearch = useCallback(() => {
    if (!searchBox || typed === undefined) return;
    const tail = boxTail(searchBox, { raw: typed }, activeFilter);
    updateFilter(withCondition(activeFilter, searchBox.column, tail));
  }, [searchBox, typed, activeFilter, updateFilter]);

  const sortQuery = activeSort
    ? `${tableId}${activeFilter ? ` ${activeFilter}` : ''} sort ${activeSort}`
    : `${tableId}${activeFilter ? ` ${activeFilter}` : ''}`;

  const renderState: ListFiltersRenderState = {
    query: fullQuery,
    sort: effectiveSort,
    refinement: activeFilter,
    clear,
  };

  if (!table) return <>{children(renderState)}</>;

  return (
    <FilterPageContext.Provider value={frame?.view}>
      <div className={`kit-list-filters is-${layout}${className ? ` ${className}` : ''}`}>
        {layout === 'bar' && (
          <div className="kit-list-filters-top">
            <ListFilterBar
              table={table}
              boxes={boxes}
              search={searchBox}
              refinement={activeFilter}
              tabQuery=""
              standing={standing}
              unitOf={unitOf}
              typed={typed}
              onType={setTyped}
              onSearch={onSearch}
              apply={(next) => updateFilter(next)}
              current={() => activeFilter}
              listLabel={label ?? table.name}
              phone={phone}
              onSheet={() => setSheet(true)}
            />
            {sorts && sorts.length > 0 && <SortMenu sorts={sorts} query={sortQuery} sort={defaultSort} onPick={updateSortFromQuery} />}
          </div>
        )}
        {layout === 'bar' && sheet && (
          <FilterSheet
            table={table}
            boxes={boxes.filter((box) => box !== searchBox)}
            refinement={activeFilter}
            standing={standing}
            unitOf={unitOf}
            onClose={() => setSheet(false)}
            onApply={(next) => {
              setSheet(false);
              updateFilter(next);
            }}
          />
        )}
        {layout === 'rail' && (
          <aside className="kit-list-filters-rail">
            <FilterRail table={table} boxes={boxes} refinement={activeFilter} standing={standing} unitOf={unitOf} onChange={updateFilter} />
          </aside>
        )}
        <div className="kit-list-filters-body">
          {layout === 'rail' && sorts && sorts.length > 0 && (
            <div className="kit-list-filters-sort-row">
              <SortMenu sorts={sorts} query={sortQuery} sort={defaultSort} onPick={updateSortFromQuery} />
            </div>
          )}
          {children(renderState)}
        </div>
      </div>
    </FilterPageContext.Provider>
  );
}
