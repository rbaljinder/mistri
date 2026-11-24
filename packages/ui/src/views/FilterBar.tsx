/** Search box, multi-select facet pills, active filter chips, and view-preset toolbar for list and board screens. */
import { Icon } from '../Icon.js';
import { Button } from '@ui-sdk/react/button';
import { Popover, PopoverContent, PopoverTrigger } from '@ui-sdk/react/popover';
import { type ReactNode, type Ref, useMemo, useState } from 'react';
import { cx, isEmptyStateSpec, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';

/** Selectable option entry inside a `FilterFacet`. */
export interface FilterFacetOption {
  value: string;
  label: string;
  count?: number;
  icon?: ReactNode;
  tone?: Tone;
}

/** Facet dimension definition in `FilterBar`. */
export interface FilterFacet {
  id: string;
  label: string;
  icon?: ReactNode;
  options: FilterFacetOption[];
}

/** Map of facet IDs to selected option value arrays in `FilterBar`. */
export type FilterValues = Record<string, string[]>;

/** Localized UI strings for `FilterBar` controls and popovers. */
export interface FilterBarWords {
  regionLabel?: string;
  clearSearch?: string;
  addFilterButton?: string;
  addFilterPlaceholder?: string;
  availableFacets?: string;
  backToFacets?: string;
  clearFilterQuery?: string;
  noMatchingOptions?: string;
  noMatchingFilters?: string;
  clearFacet?: string;
}

/** Props for the `FilterBar` view. */
export interface FilterBarProps {
  facets?: FilterFacet[];
  /* Controlled or uncontrolled facet values (facetId -> selected option values) */
  value?: FilterValues;
  defaultValue?: FilterValues;
  onValueChange?: (filters: FilterValues) => void;
  filters?: FilterValues;
  defaultFilters?: FilterValues;
  onFiltersChange?: (filters: FilterValues) => void;
  /* Controlled or uncontrolled search query */
  search?: string;
  defaultSearch?: string;
  onSearchChange?: (search: string) => void;
  searchPlaceholder?: string;
  showSearch?: boolean;
  /* Right-side slots */
  viewSwitcher?: ReactNode;
  actions?: ReactNode;
  onReset?: () => void;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  words?: FilterBarWords;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function FacetOptionList({
  facet,
  selected,
  onToggle,
  onClearFacet,
  onBack,
  empty,
  words,
}: {
  facet: FilterFacet;
  selected: string[];
  onToggle: (value: string) => void;
  onClearFacet: () => void;
  onBack?: () => void;
  empty?: EmptyStateSpec | ReactNode;
  words?: FilterBarWords;
}) {
  const [query, setQuery] = useState('');
  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const filteredOptions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return facet.options;
    return facet.options.filter((opt) => opt.label.toLowerCase().includes(q) || opt.value.toLowerCase().includes(q));
  }, [facet.options, query]);

  return (
    <div className="nx-filter-picker">
      <div className="nx-filter-picker-head">
        {onBack && (
          <button type="button" className="nx-filter-picker-back" onClick={onBack} aria-label={words?.backToFacets ?? 'Back to facets'}>
            <Icon name="arrow-left" size={13} weight="bold" />
          </button>
        )}
        <Icon name="magnifying-glass" size={13} className="nx-filter-picker-search-icon" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${facet.label.toLowerCase()}…`}
          className="nx-filter-picker-input"
          autoFocus
        />
        {query && (
          <button
            type="button"
            className="nx-filter-picker-clear"
            onClick={() => setQuery('')}
            aria-label={words?.clearFilterQuery ?? 'Clear filter query'}
          >
            <Icon name="x" size={12} />
          </button>
        )}
      </div>

      <div className="nx-filter-picker-list" role="listbox" aria-multiselectable="true" aria-label={facet.label}>
        {filteredOptions.length === 0 ? (
          <div className="nx-filter-picker-empty">
            {empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : (words?.noMatchingOptions ?? 'No matching options')}
          </div>
        ) : (
          filteredOptions.map((opt) => {
            const isChecked = selectedSet.has(opt.value);
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isChecked}
                className="nx-filter-picker-option"
                data-checked={isChecked ? '' : undefined}
                onClick={() => onToggle(opt.value)}
              >
                <span className="nx-filter-check-box" data-checked={isChecked ? '' : undefined}>
                  {isChecked && <Icon name="check" size={11} weight="bold" />}
                </span>
                {opt.tone && <span className="nx-status-dot" data-tone={toDataTone(opt.tone)} aria-hidden="true" />}
                {opt.icon && <span className="nx-filter-opt-icon">{opt.icon}</span>}
                <span className="nx-filter-opt-label">{opt.label}</span>
                {opt.count !== undefined && <span className="nx-filter-opt-count">{opt.count}</span>}
              </button>
            );
          })
        )}
      </div>

      {selected.length > 0 && (
        <div className="nx-filter-picker-foot">
          <span className="nx-filter-picker-summary">{selected.length} selected</span>
          <button type="button" className="nx-filter-picker-reset" onClick={onClearFacet}>
            {words?.clearFacet ?? 'Clear'}
          </button>
        </div>
      )}
    </div>
  );
}

/** Search box, multi-select facet pills, active filter chips, and view-switcher toolbar for list and board screens. */
export function FilterBar({
  facets = [],
  value,
  defaultValue,
  onValueChange,
  filters: controlledFiltersProp,
  defaultFilters = {},
  onFiltersChange,
  search: controlledSearch,
  defaultSearch = '',
  onSearchChange,
  searchPlaceholder = 'Filter or search…',
  showSearch = true,
  viewSwitcher,
  actions,
  onReset,
  empty,
  ariaLabel,
  words,
  className,
  ref,
}: FilterBarProps) {
  const controlledFilters = value ?? controlledFiltersProp;
  const [internalFilters, setInternalFilters] = useState<FilterValues>(defaultValue ?? defaultFilters);
  const [internalSearch, setInternalSearch] = useState<string>(defaultSearch);
  const [addOpen, setAddOpen] = useState(false);
  const [activeFacetId, setActiveFacetId] = useState<string | null>(null);
  const [facetQuery, setFacetQuery] = useState('');

  const filters = controlledFilters !== undefined ? controlledFilters : internalFilters;
  const search = controlledSearch !== undefined ? controlledSearch : internalSearch;

  const updateFilters = (next: FilterValues) => {
    const cleaned: FilterValues = {};
    for (const [key, vals] of Object.entries(next)) {
      if (vals && vals.length > 0) cleaned[key] = vals;
    }
    if (controlledFilters === undefined) setInternalFilters(cleaned);
    onValueChange?.(cleaned);
    onFiltersChange?.(cleaned);
  };

  const updateSearch = (next: string) => {
    if (controlledSearch === undefined) setInternalSearch(next);
    onSearchChange?.(next);
  };

  const toggleOption = (facetId: string, optionValue: string) => {
    const current = filters[facetId] ?? [];
    const exists = current.includes(optionValue);
    const nextVals = exists ? current.filter((v) => v !== optionValue) : [...current, optionValue];
    updateFilters({ ...filters, [facetId]: nextVals });
  };

  const removeFacet = (facetId: string) => {
    const next = { ...filters };
    delete next[facetId];
    updateFilters(next);
  };

  const handleResetAll = () => {
    updateFilters({});
    updateSearch('');
    onReset?.();
  };

  const activeEntries = useMemo(
    () => facets.map((facet) => ({ facet, values: filters[facet.id] ?? [] })).filter((entry) => entry.values.length > 0),
    [facets, filters],
  );

  const hasActiveState = activeEntries.length > 0 || search.trim().length > 0;

  const filteredFacets = useMemo(() => {
    const q = facetQuery.trim().toLowerCase();
    if (!q) return facets;
    return facets.filter((f) => f.label.toLowerCase().includes(q));
  }, [facets, facetQuery]);

  const selectedAddFacet = useMemo(() => facets.find((f) => f.id === activeFacetId) ?? null, [facets, activeFacetId]);

  return (
    <div ref={ref} className={cx('nx-filter-bar', className)} role="region" aria-label={ariaLabel ?? words?.regionLabel ?? 'Filters'}>
      <div className="nx-filter-bar-left">
        {showSearch && (
          <div className="nx-filter-search">
            <Icon name="magnifying-glass" size={14} className="nx-filter-search-icon" />
            <input
              type="search"
              value={search}
              onChange={(e) => updateSearch(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="nx-filter-search-input"
            />
            {search.length > 0 && (
              <button
                type="button"
                className="nx-filter-search-clear"
                onClick={() => updateSearch('')}
                aria-label={words?.clearSearch ?? 'Clear search'}
              >
                <Icon name="x" size={12} weight="bold" />
              </button>
            )}
          </div>
        )}

        {/* Active Facet Chips */}
        {activeEntries.map(({ facet, values }) => {
          const optionLabels = values.map((val) => facet.options.find((o) => o.value === val)?.label ?? val);
          const operatorText = values.length > 1 ? 'is any of' : 'is';
          const valueSummary = optionLabels.length <= 2 ? optionLabels.join(', ') : `${optionLabels[0]}, +${optionLabels.length - 1} more`;

          return (
            <div key={facet.id} className="nx-filter-chip" role="group" aria-label={`${facet.label} filter`}>
              <span className="nx-filter-chip-key">
                {facet.icon && <span className="nx-filter-chip-icon">{facet.icon}</span>}
                <span>{facet.label}</span>
              </span>
              <span className="nx-filter-chip-op">{operatorText}</span>

              <Popover>
                <PopoverTrigger className="nx-filter-chip-val" aria-label={`Edit ${facet.label} filter values`}>
                  {valueSummary}
                </PopoverTrigger>
                <PopoverContent align="start" sideOffset={6} className="nx-filter-popover">
                  <FacetOptionList
                    facet={facet}
                    selected={values}
                    onToggle={(val) => toggleOption(facet.id, val)}
                    onClearFacet={() => removeFacet(facet.id)}
                    empty={empty}
                    words={words}
                  />
                </PopoverContent>
              </Popover>

              <button
                type="button"
                className="nx-filter-chip-remove"
                onClick={() => removeFacet(facet.id)}
                aria-label={`Remove ${facet.label} filter`}
              >
                <Icon name="x" size={11} weight="bold" />
              </button>
            </div>
          );
        })}

        {/* + Filter Popover Button */}
        {facets.length > 0 && (
          <Popover
            open={addOpen}
            onOpenChange={(nextOpen) => {
              setAddOpen(nextOpen);
              if (!nextOpen) {
                setActiveFacetId(null);
                setFacetQuery('');
              }
            }}
          >
            <PopoverTrigger className="nx-filter-add-btn">
              <Icon name="plus" size={13} weight="bold" />
              <span>{words?.addFilterButton ?? 'Filter'}</span>
            </PopoverTrigger>
            <PopoverContent align="start" sideOffset={6} className="nx-filter-popover">
              {selectedAddFacet ? (
                <FacetOptionList
                  facet={selectedAddFacet}
                  selected={filters[selectedAddFacet.id] ?? []}
                  onToggle={(val) => toggleOption(selectedAddFacet.id, val)}
                  onClearFacet={() => removeFacet(selectedAddFacet.id)}
                  onBack={() => setActiveFacetId(null)}
                  empty={empty}
                  words={words}
                />
              ) : (
                <div className="nx-filter-picker">
                  <div className="nx-filter-picker-head">
                    <Icon name="funnel-simple" size={13} className="nx-filter-picker-search-icon" />
                    <input
                      type="text"
                      value={facetQuery}
                      onChange={(e) => setFacetQuery(e.target.value)}
                      placeholder={words?.addFilterPlaceholder ?? 'Add filter…'}
                      className="nx-filter-picker-input"
                      autoFocus
                    />
                  </div>
                  <div className="nx-filter-picker-list" role="listbox" aria-label={words?.availableFacets ?? 'Available filter facets'}>
                    {filteredFacets.length === 0 ? (
                      <div className="nx-filter-picker-empty">
                        {empty !== undefined
                          ? isEmptyStateSpec(empty)
                            ? empty.title
                            : empty
                          : (words?.noMatchingFilters ?? 'No matching filters')}
                      </div>
                    ) : (
                      filteredFacets.map((facet) => {
                        const activeCount = filters[facet.id]?.length ?? 0;
                        return (
                          <button
                            key={facet.id}
                            type="button"
                            role="option"
                            aria-selected={activeCount > 0}
                            className="nx-filter-picker-option"
                            onClick={() => setActiveFacetId(facet.id)}
                          >
                            {facet.icon && <span className="nx-filter-opt-icon">{facet.icon}</span>}
                            <span className="nx-filter-opt-label">{facet.label}</span>
                            {activeCount > 0 ? (
                              <span className="nx-badge" data-tone="accent" data-pill="">
                                {activeCount}
                              </span>
                            ) : (
                              <span className="nx-filter-opt-count">{facet.options.length}</span>
                            )}
                          </button>
                        );
                      })
                    )}
                  </div>
                </div>
              )}
            </PopoverContent>
          </Popover>
        )}

        {hasActiveState && (
          <Button data-variant="ghost" data-size="sm" onClick={handleResetAll} className="nx-filter-reset-btn">
            Reset
          </Button>
        )}
      </div>

      {(viewSwitcher || actions) && (
        <div className="nx-filter-bar-right">
          {viewSwitcher}
          {actions}
        </div>
      )}
    </div>
  );
}
