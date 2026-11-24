/**
 * Searchable single- and multi-record entity picker combining UI SDK's combobox
 * with debounced async option loading and monogram avatars.
 */
'use client';

import * as React from 'react';
import { useAsyncOptions } from '@ui-sdk/react/async-options';
import {
  Combobox as SdkCombobox,
  ComboboxChip,
  ComboboxChipRemove,
  ComboboxChips,
  ComboboxClear,
  ComboboxContent,
  ComboboxCreate,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxGroupLabel,
  ComboboxInput,
  ComboboxItem,
  ComboboxItemIndicator,
  ComboboxList,
  ComboboxSeparator,
  ComboboxStatus,
  ComboboxTrigger,
  ComboboxValue,
  type ListData,
} from '@ui-sdk/react/combobox';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type ControlSize, type EmptyStateSpec, type Tone } from '../internal/cx.js';
import { Avatar, Badge } from './display.js';
import { FieldControlBridge, wrapWithField, type FieldFrameProps } from './fieldShell.js';
import { HighlightMatch } from './systemPrimitives.js';

function renderEmptyNode(empty: EmptyStateSpec | React.ReactNode): React.ReactNode {
  if (isEmptyStateSpec(empty)) {
    return (
      <div className="nx-empty-inline">
        <div className="nx-empty-inline-title">{empty.title}</div>
        {empty.body !== undefined && <div className="nx-empty-inline-body">{empty.body}</div>}
        {empty.action !== undefined && <div className="nx-empty-inline-action">{empty.action}</div>}
      </div>
    );
  }
  return empty;
}

/* ============================================================================
 * EntityPicker (@ui-sdk/react/combobox + useAsyncOptions)
 * ========================================================================== */

/** Async request context passed to `EntityPicker`'s `loadEntities` callback. */
export interface EntityLoadContext {
  signal: AbortSignal;
  page: number;
}

/** Selectable record entry for `EntityPicker`. */
export interface EntityOption<TData = unknown> {
  /** Unique entity identifier. */
  id: string;
  /** Monospace operational code (e.g. `'NX-412'`, `'CUS-109'`). */
  code?: string;
  /** Primary display name. */
  label: string;
  /** Secondary metadata line (e.g. `'Enterprise · San Francisco, CA'`). */
  subtitle?: string;
  /** Avatar image URL. Falls back to monogram derived from `avatarName ?? label`. */
  avatarSrc?: string;
  /** Explicit seed name for monogram fallback. */
  avatarName?: string;
  /** Custom icon rendered instead of monogram Avatar when provided. */
  icon?: React.ReactNode;
  /** Status or category pill rendered on the right of the option row. */
  badge?: React.ReactNode;
  badgeTone?: Tone;
  /** Optional group section heading. */
  group?: string;
  /** Additional search terms matched during static filtering. */
  keywords?: ReadonlyArray<string>;
  disabled?: boolean;
  /** Arbitrary attached domain payload. */
  data?: TData;
}

interface EntityPickerSharedProps<TData = unknown> extends FieldFrameProps {
  id?: string;
  ariaLabel?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  /** Static entity list (used when `loadEntities` is not provided). */
  entities?: ReadonlyArray<EntityOption<TData>>;
  /**
   * Async loader receiving `(query, { signal, page })` with automatic debouncing and race cancellation.
   */
  loadEntities?: (
    query: string,
    context: EntityLoadContext,
  ) => Promise<EntityOption<TData>[] | { items: EntityOption<TData>[]; hasMore?: boolean }>;
  /**
   * The records already chosen, for a value the picker has not loaded: with `loadEntities` a saved id is otherwise all
   * the box has to show until a search happens to return it.
   */
  selectedEntities?: ReadonlyArray<EntityOption<TData>>;
  /** Debounce delay in milliseconds for `loadEntities`. Defaults to `200`. */
  debounceMs?: number;
  /** Trigger `loadEntities('')` immediately on mount. Defaults to `false` (loads on open/type). */
  loadOnMount?: boolean;
  /** Optional handler enabling inline `+ Create "{query}"` action when no exact match exists. */
  onCreateNew?: (query: string) => unknown;
  createNewLabel?: (query: string) => React.ReactNode;
  placeholder?: string;
  empty?: EmptyStateSpec | React.ReactNode;
  loadingMessage?: React.ReactNode;
  clearable?: boolean;
  size?: ControlSize;
  disabled?: boolean;
  readOnly?: boolean;
  invalid?: boolean;
  name?: string;
  words?: {
    clearAll?: string;
    clearEntity?: string;
    toggleEntities?: string;
    removeChip?: (label: string) => string;
    addMore?: string;
    loadingStatus?: string;
    availableStatus?: (count: number) => string;
  };
  className?: string;
  contentClassName?: string;
  fieldClassName?: string;
  ref?: React.Ref<HTMLInputElement>;
}

/** Single-record selection props for `EntityPicker`. */
export interface EntityPickerSingleProps<TData = unknown> extends EntityPickerSharedProps<TData> {
  multiple?: false;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (id: string | null, entity: EntityOption<TData> | null) => void;
}

/** Multi-record selection props for `EntityPicker`. */
export interface EntityPickerMultiProps<TData = unknown> extends EntityPickerSharedProps<TData> {
  multiple: true;
  value?: ReadonlyArray<string>;
  defaultValue?: ReadonlyArray<string>;
  onValueChange?: (ids: string[], entities: EntityOption<TData>[]) => void;
}

/** Props for the `EntityPicker` searchable record selector. */
export type EntityPickerProps<TData = unknown> = EntityPickerSingleProps<TData> | EntityPickerMultiProps<TData>;

function groupEntities<TData>(
  items: ReadonlyArray<EntityOption<TData>>,
): Array<{ group: string | undefined; entries: EntityOption<TData>[] }> {
  const groups: Array<{ group: string | undefined; entries: EntityOption<TData>[] }> = [];
  const map = new Map<string | undefined, EntityOption<TData>[]>();
  for (const item of items) {
    let bucket = map.get(item.group);
    if (!bucket) {
      bucket = [];
      map.set(item.group, bucket);
      groups.push({ group: item.group, entries: bucket });
    }
    bucket.push(item);
  }
  return groups;
}

/** Searchable single- or multi-record entity picker with monogram avatars, codes, badges, and async loading. */
export function EntityPicker<TData = unknown>(props: EntityPickerProps<TData>): React.JSX.Element {
  const {
    id: explicitId,
    ariaLabel,
    'aria-labelledby': explicitAriaLabelledBy,
    'aria-describedby': explicitAriaDescribedBy,
    entities,
    loadEntities,
    selectedEntities,
    debounceMs = 200,
    loadOnMount = false,
    onCreateNew,
    createNewLabel,
    placeholder = 'Search records by name or code…',
    empty,
    loadingMessage = 'Searching records…',
    clearable = true,
    size = 'md',
    disabled = false,
    readOnly = false,
    invalid,
    name,
    words,
    label,
    hint,
    description,
    error,
    problem,
    optional,
    required,
    labelTrailing,
    className,
    contentClassName,
    fieldClassName,
    ref,
  } = props;

  const explicitAriaLabel = ariaLabel ?? (props as unknown as { 'aria-label'?: string })['aria-label'];
  const legacyEmpty = (props as unknown as { emptyMessage?: React.ReactNode }).emptyMessage;
  const resolvedEmpty = empty ?? legacyEmpty ?? 'No matching records found';
  const resolvedError = problem ?? error;

  const isAsync = Boolean(loadEntities);
  const isMultiple = props.multiple === true;
  const isInvalid = invalid ?? Boolean(resolvedError);
  const canModify = !disabled && !readOnly;

  const noopLoader = React.useCallback(async () => [] as EntityOption<TData>[], []);

  const asyncOptions = useAsyncOptions<EntityOption<TData>>(
    (loadEntities as unknown as Parameters<typeof useAsyncOptions<EntityOption<TData>>>[0]) ?? noopLoader,
    {
      debounce: debounceMs,
      immediate: isAsync && loadOnMount,
    },
  );

  const [queryText, setQueryText] = React.useState('');
  const [internalSingle, setInternalSingle] = React.useState<string | null>(() => (!isMultiple ? (props.defaultValue ?? null) : null));
  const [internalMulti, setInternalMulti] = React.useState<string[]>(() => (isMultiple ? [...(props.defaultValue ?? [])] : []));

  const activeSingleId = !isMultiple ? (props.value !== undefined ? props.value : internalSingle) : null;

  const activeMultiIds = React.useMemo<string[]>(
    () => (isMultiple ? (props.value !== undefined ? [...props.value] : internalMulti) : []),
    [isMultiple, props.value, internalMulti],
  );

  const sourceEntities = React.useMemo<ReadonlyArray<EntityOption<TData>>>(
    () => (isAsync ? asyncOptions.items : (entities ?? [])),
    [isAsync, asyncOptions.items, entities],
  );

  /* Every record seen so far, so a chosen one keeps its name after a search stops returning it. What earlier renders
     saw is remembered after commit, never while rendering: a render that is thrown away must leave nothing behind.
     The chosen records are compared by what they say, so a list written inline does not make a new map every render. */
  const rememberedRef = React.useRef<ReadonlyMap<string, EntityOption<TData>>>(new Map());
  const selectedSignature = (selectedEntities ?? []).map((ent) => `${ent.id}\u0000${ent.code ?? ''}\u0000${ent.label}`).join('\u0001');
  const known = React.useMemo<ReadonlyMap<string, EntityOption<TData>>>(() => {
    const map = new Map(rememberedRef.current);
    for (const ent of selectedEntities ?? []) map.set(ent.id, ent);
    for (const ent of entities ?? []) map.set(ent.id, ent);
    for (const ent of sourceEntities) map.set(ent.id, ent);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceEntities, entities, selectedSignature]);
  React.useEffect(() => {
    rememberedRef.current = known;
  }, [known]);

  const listData = React.useMemo<ListData<string>>(
    () =>
      sourceEntities.map((ent) => ({
        value: ent.id,
        label: ent.label,
        keywords: [...(ent.code ? [ent.code] : []), ...(ent.subtitle ? [ent.subtitle] : []), ...(ent.keywords ?? [])],
        disabled: ent.disabled,
      })),
    [sourceEntities],
  );

  const groupedEntities = React.useMemo(() => groupEntities(sourceEntities), [sourceEntities]);

  const itemToLabel = React.useCallback(
    (id: string): string => {
      const cached = known.get(id);
      if (!cached) return id;
      return cached.code ? `${cached.code} · ${cached.label}` : cached.label;
    },
    [known],
  );

  const handleQueryChange = React.useCallback(
    (nextQuery: string) => {
      setQueryText(nextQuery);
      if (isAsync) {
        asyncOptions.setQuery(nextQuery);
      }
    },
    [isAsync, asyncOptions],
  );

  const handleOpenChange = React.useCallback(
    (nextOpen: boolean) => {
      if (nextOpen && isAsync && asyncOptions.items.length === 0 && asyncOptions.status === 'idle') {
        asyncOptions.reload();
      }
    },
    [isAsync, asyncOptions],
  );

  const renderEntityRow = (ent: EntityOption<TData>): React.ReactNode => {
    const searchHighlight = !isMultiple && activeSingleId === ent.id && queryText === itemToLabel(ent.id) ? '' : queryText;

    return (
      <ComboboxItem<string>
        key={ent.id}
        value={ent.id}
        label={ent.code ? `${ent.code} · ${ent.label}` : ent.label}
        keywords={[...(ent.code ? [ent.code] : []), ...(ent.subtitle ? [ent.subtitle] : []), ...(ent.keywords ?? [])]}
        disabled={ent.disabled}
        className="nx-combobox-item nx-entity-option"
      >
        <span className="nx-entity-avatar-slot" aria-hidden="true">
          {ent.icon !== undefined ? (
            <span className="nx-entity-custom-icon">{ent.icon}</span>
          ) : (
            <Avatar size="xs" src={ent.avatarSrc} name={ent.avatarName ?? ent.label} />
          )}
        </span>

        <div className="nx-entity-copy">
          <div className="nx-entity-primary-line">
            {ent.code ? (
              <span className="nx-entity-code">
                <HighlightMatch text={ent.code} query={searchHighlight} />
              </span>
            ) : null}
            <HighlightMatch text={ent.label} query={searchHighlight} className="nx-entity-label" />
          </div>
          {ent.subtitle ? <HighlightMatch text={ent.subtitle} query={searchHighlight} className="nx-entity-subtitle" /> : null}
        </div>

        {ent.badge !== undefined ? (
          <Badge tone={ent.badgeTone ?? 'neutral'} pill className="nx-entity-badge">
            {ent.badge}
          </Badge>
        ) : null}

        <ComboboxItemIndicator className="nx-item-indicator">
          <Icon name="check" size={13} weight="bold" />
        </ComboboxItemIndicator>
      </ComboboxItem>
    );
  };

  const selectedSingleEntity = activeSingleId ? (known.get(activeSingleId) ?? null) : null;

  const popupBody = (
    <ComboboxContent sideOffset={6} className={cx('nx-combobox-content nx-entity-picker-content', contentClassName)}>
      <ComboboxList className="nx-popup-list nx-entity-picker-list">
        {groupedEntities.map((sec, idx) =>
          sec.group ? (
            <React.Fragment key={sec.group}>
              {idx > 0 ? <ComboboxSeparator className="nx-popup-separator" /> : null}
              <ComboboxGroup className="nx-popup-group">
                <ComboboxGroupLabel className="nx-popup-group-label">{sec.group}</ComboboxGroupLabel>
                {sec.entries.map((ent) => renderEntityRow(ent))}
              </ComboboxGroup>
            </React.Fragment>
          ) : (
            <React.Fragment key={`ungrouped-${idx}`}>
              {idx > 0 ? <ComboboxSeparator className="nx-popup-separator" /> : null}
              {sec.entries.map((ent) => renderEntityRow(ent))}
            </React.Fragment>
          ),
        )}

        {onCreateNew ? (
          <ComboboxCreate minLength={1} onCreate={(q) => onCreateNew(q)} className="nx-combobox-item nx-entity-create">
            {(state) => (
              <span className="nx-entity-create-inner">
                <Icon name="plus" size={14} weight="bold" />
                <span>{createNewLabel ? createNewLabel(state.query) : `Create "${state.query}"`}</span>
              </span>
            )}
          </ComboboxCreate>
        ) : null}
      </ComboboxList>

      <ComboboxEmpty className="nx-popup-empty nx-entity-empty">
        {(emptyState) =>
          emptyState.loading ? (
            <span className="nx-entity-loading-row">
              <span className="nx-spinner" aria-hidden="true" />
              <span>{loadingMessage}</span>
            </span>
          ) : (
            renderEmptyNode(resolvedEmpty)
          )
        }
      </ComboboxEmpty>

      <ComboboxStatus className="nx-sr-only">
        {(st) =>
          st.loading
            ? (words?.loadingStatus ?? 'Loading entities')
            : (words?.availableStatus?.(st.count) ?? `${st.count} ${st.count === 1 ? 'entity' : 'entities'} available`)
        }
      </ComboboxStatus>
    </ComboboxContent>
  );

  const comboboxTree = (
    <FieldControlBridge
      id={explicitId}
      ariaLabel={explicitAriaLabel ?? (typeof label === 'string' ? label : placeholder)}
      ariaLabelledBy={explicitAriaLabelledBy}
      ariaDescribedBy={explicitAriaDescribedBy}
      invalid={isInvalid}
    >
      {(fieldAttrs) =>
        isMultiple ? (
          <SdkCombobox<string, true>
            multiple
            items={listData}
            value={activeMultiIds}
            onValueChange={(nextIds) => {
              if (props.value === undefined) {
                setInternalMulti(nextIds);
              }
              const resolved = nextIds.map((id) => known.get(id)).filter((e): e is EntityOption<TData> => e !== undefined);
              props.onValueChange?.(nextIds, resolved);
            }}
            itemToLabel={itemToLabel}
            filter={isAsync ? false : 'contains'}
            status={isAsync ? asyncOptions.status : 'idle'}
            onQueryChange={handleQueryChange}
            onOpenChange={handleOpenChange}
            onLoadMore={isAsync && asyncOptions.hasMore ? asyncOptions.loadMore : undefined}
            autoHighlight="always"
            disabled={disabled}
            readOnly={readOnly}
            required={required}
            name={name}
          >
            <ComboboxChips
              data-size={size}
              data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
              data-disabled={disabled ? '' : undefined}
              className={cx('nx-combobox-chips nx-entity-chips', className)}
            >
              <ComboboxValue>
                {(state) =>
                  Array.isArray(state.value)
                    ? (state.value as string[]).map((id, idx) => {
                        const ent = known.get(id);
                        const fallbackLabel = state.labels[idx] ?? id;
                        const chipLabel = ent ? ent.label : fallbackLabel;
                        return (
                          <ComboboxChip<string> key={id} value={id} className="nx-combobox-chip nx-entity-chip">
                            {ent ? (
                              <Avatar size="xs" src={ent.avatarSrc} name={ent.avatarName ?? ent.label} className="nx-entity-chip-avatar" />
                            ) : null}
                            {ent?.code ? <span className="nx-entity-chip-code">{ent.code}</span> : null}
                            <span className="nx-combobox-chip-label">{chipLabel}</span>
                            {canModify ? (
                              <ComboboxChipRemove
                                aria-label={words?.removeChip ? words.removeChip(chipLabel) : `Remove ${chipLabel}`}
                                className="nx-combobox-chip-remove"
                              >
                                <Icon name="x" size={11} weight="bold" />
                              </ComboboxChipRemove>
                            ) : null}
                          </ComboboxChip>
                        );
                      })
                    : null
                }
              </ComboboxValue>
              <ComboboxInput
                ref={ref}
                id={fieldAttrs.id}
                placeholder={activeMultiIds.length === 0 ? placeholder : (words?.addMore ?? 'Add…')}
                aria-label={fieldAttrs['aria-label']}
                aria-labelledby={fieldAttrs['aria-labelledby']}
                aria-describedby={fieldAttrs['aria-describedby']}
                aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                className="nx-combobox-chips-input"
              />
              <div className="nx-combobox-actions">
                {isAsync && asyncOptions.status === 'loading' ? (
                  <span className="nx-spinner nx-entity-inline-spinner" aria-hidden="true" />
                ) : null}
                {clearable && canModify ? (
                  <ComboboxClear aria-label={words?.clearAll ?? 'Clear all'} className="nx-input-clear">
                    <Icon name="x" size={13} weight="bold" />
                  </ComboboxClear>
                ) : null}
                <ComboboxTrigger aria-label={words?.toggleEntities ?? 'Toggle entities'} className="nx-combobox-trigger">
                  <Icon name="caret-down" size={14} />
                </ComboboxTrigger>
              </div>
            </ComboboxChips>
            {popupBody}
          </SdkCombobox>
        ) : (
          <SdkCombobox<string, false>
            items={listData}
            value={activeSingleId}
            onValueChange={(nextId) => {
              if (props.value === undefined) {
                setInternalSingle(nextId);
              }
              const resolved = nextId ? (known.get(nextId) ?? null) : null;
              props.onValueChange?.(nextId, resolved);
            }}
            itemToLabel={itemToLabel}
            filter={isAsync ? false : 'contains'}
            status={isAsync ? asyncOptions.status : 'idle'}
            onQueryChange={handleQueryChange}
            onOpenChange={handleOpenChange}
            onLoadMore={isAsync && asyncOptions.hasMore ? asyncOptions.loadMore : undefined}
            autoHighlight="always"
            disabled={disabled}
            readOnly={readOnly}
            required={required}
            name={name}
          >
            <div
              data-slot="input-group"
              data-size={size}
              data-invalid={fieldAttrs['aria-invalid'] ? '' : undefined}
              data-disabled={disabled ? '' : undefined}
              className={cx('nx-input-group nx-combobox-control nx-entity-picker-control', className)}
            >
              {selectedSingleEntity ? (
                <span className="nx-entity-leading-avatar" aria-hidden="true">
                  {selectedSingleEntity.icon !== undefined ? (
                    <span className="nx-entity-custom-icon">{selectedSingleEntity.icon}</span>
                  ) : (
                    <Avatar
                      size="xs"
                      src={selectedSingleEntity.avatarSrc}
                      name={selectedSingleEntity.avatarName ?? selectedSingleEntity.label}
                    />
                  )}
                </span>
              ) : (
                <span className="nx-input-icon" data-side="start" aria-hidden="true">
                  <Icon name="magnifying-glass" size={14} />
                </span>
              )}
              <ComboboxInput
                ref={ref}
                id={fieldAttrs.id}
                placeholder={placeholder}
                aria-label={fieldAttrs['aria-label']}
                aria-labelledby={fieldAttrs['aria-labelledby']}
                aria-describedby={fieldAttrs['aria-describedby']}
                aria-invalid={fieldAttrs['aria-invalid'] || undefined}
                className="nx-combobox-input nx-entity-picker-input"
              />
              {isAsync && asyncOptions.status === 'loading' ? (
                <span className="nx-spinner nx-entity-inline-spinner" aria-hidden="true" />
              ) : null}
              {clearable && canModify ? (
                <ComboboxClear aria-label={words?.clearEntity ?? 'Clear entity'} className="nx-input-clear">
                  <Icon name="x" size={13} weight="bold" />
                </ComboboxClear>
              ) : null}
              <ComboboxTrigger aria-label={words?.toggleEntities ?? 'Toggle entities'} className="nx-combobox-trigger">
                <Icon name="caret-down" size={14} />
              </ComboboxTrigger>
            </div>
            {popupBody}
          </SdkCombobox>
        )
      }
    </FieldControlBridge>
  );

  return wrapWithField(comboboxTree, {
    label,
    hint,
    description,
    error: resolvedError,
    optional,
    required,
    labelTrailing,
    name,
    disabled,
    invalid: isInvalid,
    fieldClassName,
  });
}
