/** Responsive multi-column record card grid with selection checkboxes, status badges, and bulk actions. */
'use client';

import { Icon } from '../Icon.js';
import { type KeyboardEvent, type MouseEvent, type ReactNode, type Ref, isValidElement, useMemo, useState } from 'react';
import { BulkActionBar, Button, IconButton } from '../primitives/actions.js';
import { type AvatarStatus, Badge, Person, StatusDot } from '../primitives/display.js';
import { EmptyState } from '../primitives/feedback.js';
import { DropdownMenu, type MenuEntry } from '../primitives/menus.js';
import { Checkbox } from '../primitives/selection.js';
import { cx, isEmptyStateSpec, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';

/** Supported desktop column count for `CardGridView`. */
export type CardGridColumns = 2 | 3 | 4;

/** Key/value metric cell displayed inside a `CardGridView` card. */
export interface CardGridMetric {
  label: string;
  value: ReactNode;
}

/** Tag badge descriptor displayed inside a `CardGridView` card. */
export type CardGridTag =
  | string
  | {
      label: string;
      tone?: Tone;
    };

/** Status indicator descriptor displayed in the top bar of a `CardGridView` card. */
export interface CardGridStatus {
  label: ReactNode;
  tone?: Tone;
  variant?: 'dot' | 'badge';
  pulse?: boolean;
}

/** Assignee identity summary displayed in the footer of a `CardGridView` card. */
export interface CardGridAssignee {
  name: string;
  role?: ReactNode;
  email?: string;
  src?: string;
  avatarUrl?: string;
  status?: AvatarStatus;
}

/** Overflow menu action descriptor for a single `CardGridView` card. */
export interface CardGridAction<T = unknown> {
  id?: string;
  label: ReactNode;
  icon?: ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: (item: CardGridItem<T>) => void;
}

/** Multi-select bulk action descriptor for `CardGridView`. */
export interface CardGridBulkAction<T = unknown> {
  id: string;
  label: ReactNode;
  icon?: ReactNode;
  danger?: boolean;
  onAction: (selectedIds: string[], selectedItems: Array<CardGridItem<T>>) => void;
}

/** Record card item rendered in `CardGridView`. */
export interface CardGridItem<T = unknown> {
  id: string;
  code?: string;
  title: ReactNode;
  subtitle?: ReactNode;
  description?: ReactNode;
  status?: CardGridStatus | ReactNode;
  metrics?: ReadonlyArray<CardGridMetric>;
  tags?: ReadonlyArray<CardGridTag>;
  assignee?: CardGridAssignee;
  meta?: ReactNode;
  actions?: ReadonlyArray<MenuEntry>;
  tone?: Tone;
  data?: T;
}

/** Props for the `CardGridView` component. */
export interface CardGridViewProps<T = unknown> {
  items: ReadonlyArray<CardGridItem<T>>;
  columns?: CardGridColumns;
  /* Selection & Bulk Actions */
  selectable?: boolean;
  selectedIds?: ReadonlyArray<string>;
  defaultSelectedIds?: ReadonlyArray<string>;
  onSelectedIdsChange?: (ids: string[]) => void;
  bulkActions?: ReadonlyArray<CardGridBulkAction<T>>;
  /* Card interactions & Overflow Menu */
  onCardClick?: (item: CardGridItem<T>) => void;
  cardActions?: (item: CardGridItem<T>) => ReadonlyArray<CardGridAction<T>>;
  renderCard?: (item: CardGridItem<T>, selected: boolean) => ReactNode;
  /* Chrome & Empty State */
  toolbar?: ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  className?: string;
  ref?: Ref<HTMLDivElement>;
}

function isStatusObject(val: unknown): val is CardGridStatus {
  if (!val || typeof val !== 'object' || isValidElement(val)) return false;
  return 'label' in val;
}

function renderCardStatus(status: CardGridStatus | ReactNode): ReactNode {
  if (status === undefined || status === null) return null;
  if (isStatusObject(status)) {
    const tone = status.tone ?? 'neutral';
    if (status.variant === 'badge') {
      return (
        <Badge tone={tone} pill>
          {status.label}
        </Badge>
      );
    }
    return (
      <StatusDot tone={tone} pulse={status.pulse}>
        {status.label}
      </StatusDot>
    );
  }
  return status;
}

/** Responsive multi-column record card grid with multi-selection, overflow menus, and bulk actions. */
export function CardGridView<T = unknown>(props: CardGridViewProps<T>) {
  const {
    items,
    columns = 3,
    selectable = false,
    selectedIds: controlledSelectedIds,
    defaultSelectedIds = [],
    onSelectedIdsChange,
    bulkActions = [],
    onCardClick,
    cardActions,
    renderCard,
    toolbar,
    empty,
    ariaLabel = 'Record cards',
    className,
    ref,
  } = props;
  const legacyProps = props as unknown as {
    emptyTitle?: ReactNode;
    emptyDescription?: ReactNode;
    emptyAction?: ReactNode;
  };
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>(() => [...defaultSelectedIds]);

  const selectedIds = useMemo(
    () => (controlledSelectedIds !== undefined ? [...controlledSelectedIds] : internalSelectedIds),
    [controlledSelectedIds, internalSelectedIds],
  );

  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);

  const updateSelection = (next: string[]) => {
    if (controlledSelectedIds === undefined) {
      setInternalSelectedIds(next);
    }
    onSelectedIdsChange?.(next);
  };

  const toggleItemSelection = (id: string, nextChecked: boolean) => {
    if (nextChecked) {
      if (!selectedSet.has(id)) {
        updateSelection([...selectedIds, id]);
      }
    } else {
      updateSelection(selectedIds.filter((existing) => existing !== id));
    }
  };

  const allSelected = items.length > 0 && items.every((item) => selectedSet.has(item.id));
  const someSelected = !allSelected && items.some((item) => selectedSet.has(item.id));

  const toggleSelectAll = (nextChecked: boolean) => {
    if (nextChecked) {
      const merged = new Set(selectedIds);
      for (const item of items) merged.add(item.id);
      updateSelection(Array.from(merged));
    } else {
      const visibleIds = new Set(items.map((item) => item.id));
      updateSelection(selectedIds.filter((id) => !visibleIds.has(id)));
    }
  };

  const selectedItems = useMemo(() => items.filter((item) => selectedSet.has(item.id)), [items, selectedSet]);

  const stopCardPropagation = (e: MouseEvent<HTMLElement>) => {
    e.stopPropagation();
  };

  const handleCardKeyDown = (e: KeyboardEvent<HTMLElement>, item: CardGridItem<T>) => {
    if (!onCardClick) return;
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onCardClick(item);
    }
  };

  const emptyContent =
    empty !== undefined ? (
      isEmptyStateSpec(empty) ? (
        <EmptyState icon={<Icon name="squares-four" size={22} />} title={empty.title} body={empty.body} action={empty.action} />
      ) : (
        empty
      )
    ) : (
      <EmptyState
        icon={<Icon name="squares-four" size={22} />}
        title={legacyProps.emptyTitle ?? 'No cards to display'}
        body={legacyProps.emptyDescription ?? 'Adjust your filters or add a new record to populate this collection.'}
        action={legacyProps.emptyAction}
      />
    );

  return (
    <div ref={ref} className={cx('nx-card-grid-view', className)}>
      {(toolbar !== undefined || selectable) && items.length > 0 && (
        <div className="nx-card-grid-header">
          {selectable ? (
            <div className="nx-card-grid-select-bar">
              <Checkbox
                size="sm"
                checked={allSelected}
                indeterminate={someSelected}
                onCheckedChange={(checked) => toggleSelectAll(Boolean(checked))}
                label={selectedIds.length > 0 ? `${selectedIds.length} of ${items.length} selected` : `Select all (${items.length})`}
              />
            </div>
          ) : (
            <span />
          )}
          {toolbar !== undefined && <div className="nx-card-grid-toolbar">{toolbar}</div>}
        </div>
      )}

      {selectable && selectedIds.length > 0 && bulkActions.length > 0 && (
        <BulkActionBar selectedCount={selectedIds.length} onClearSelection={() => updateSelection([])}>
          {bulkActions.map((action) => (
            <Button
              key={action.id}
              size="sm"
              variant={action.danger ? 'danger-soft' : 'secondary'}
              leadingIcon={action.icon}
              onClick={() => action.onAction(selectedIds, selectedItems)}
            >
              {action.label}
            </Button>
          ))}
        </BulkActionBar>
      )}

      {items.length === 0 ? (
        emptyContent
      ) : (
        <div role="list" aria-label={ariaLabel} data-columns={columns} className="nx-card-grid">
          {items.map((item) => {
            const isSelected = selectedSet.has(item.id);
            const isInteractive = Boolean(onCardClick);

            const resolvedMenuEntries: MenuEntry[] | undefined = resolveCardMenuEntries(item, cardActions);

            if (renderCard) {
              return (
                <div key={item.id} role="listitem" className="nx-card-grid-slot">
                  {renderCard(item, isSelected)}
                </div>
              );
            }

            return (
              <article
                key={item.id}
                role="listitem"
                tabIndex={isInteractive ? 0 : undefined}
                data-selected={isSelected ? '' : undefined}
                data-interactive={isInteractive ? '' : undefined}
                data-tone={toDataTone(item.tone)}
                onClick={isInteractive ? () => onCardClick?.(item) : undefined}
                onKeyDown={isInteractive ? (e) => handleCardKeyDown(e, item) : undefined}
                className="nx-card-grid-card nx-focusable"
              >
                {/* Top Row: Selection + Code + Status + Overflow Actions */}
                <div className="nx-card-grid-top">
                  <div className="nx-card-grid-top-start">
                    {selectable && (
                      <span className="nx-card-grid-check" onClick={stopCardPropagation}>
                        <Checkbox
                          size="sm"
                          checked={isSelected}
                          onCheckedChange={(checked) => toggleItemSelection(item.id, Boolean(checked))}
                          ariaLabel={typeof item.title === 'string' ? `Select ${item.title}` : `Select ${item.code ?? item.id}`}
                        />
                      </span>
                    )}
                    {item.code && <span className="nx-card-grid-code">{item.code}</span>}
                  </div>

                  <div className="nx-card-grid-top-end">
                    {item.status !== undefined && <div className="nx-card-grid-status">{renderCardStatus(item.status)}</div>}
                    {resolvedMenuEntries && resolvedMenuEntries.length > 0 && (
                      <div className="nx-card-grid-overflow" onClick={stopCardPropagation}>
                        <DropdownMenu
                          align="end"
                          items={resolvedMenuEntries}
                          trigger={
                            <IconButton
                              ariaLabel={typeof item.title === 'string' ? `Actions for ${item.title}` : 'Card actions'}
                              variant="ghost"
                              size="xs"
                              icon={<Icon name="dots-three" size={16} weight="bold" />}
                            />
                          }
                        />
                      </div>
                    )}
                  </div>
                </div>

                {/* Title, Subtitle & Optional Description */}
                <div className="nx-card-grid-heading">
                  <h3 className="nx-card-grid-title">{item.title}</h3>
                  {item.subtitle !== undefined && <p className="nx-card-grid-subtitle">{item.subtitle}</p>}
                  {item.description !== undefined && <p className="nx-card-grid-description">{item.description}</p>}
                </div>

                {/* Metrics Strip */}
                {item.metrics && item.metrics.length > 0 && (
                  <dl className="nx-card-grid-metrics">
                    {item.metrics.map((metric, idx) => (
                      <div key={`${metric.label}-${idx}`} className="nx-card-grid-metric">
                        <dt className="nx-card-grid-metric-label">{metric.label}</dt>
                        <dd className="nx-card-grid-metric-value">{metric.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}

                {/* Tags */}
                {item.tags && item.tags.length > 0 && (
                  <div className="nx-card-grid-tags">
                    {item.tags.map((tag, idx) => {
                      const tagObj = typeof tag === 'string' ? { label: tag, tone: 'neutral' as Tone } : tag;
                      return (
                        <Badge key={`${tagObj.label}-${idx}`} tone={tagObj.tone ?? 'neutral'}>
                          {tagObj.label}
                        </Badge>
                      );
                    })}
                  </div>
                )}

                {/* Footer: Assignee & Meta */}
                {(item.assignee !== undefined || item.meta !== undefined) && (
                  <div className="nx-card-grid-footer">
                    {item.assignee ? (
                      <Person
                        size="xs"
                        name={item.assignee.name}
                        role={item.assignee.role}
                        email={item.assignee.email}
                        src={item.assignee.src ?? item.assignee.avatarUrl}
                        status={item.assignee.status}
                      />
                    ) : (
                      <span />
                    )}
                    {item.meta !== undefined && <span className="nx-card-grid-meta">{item.meta}</span>}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}

function resolveCardMenuEntries<T>(
  item: CardGridItem<T>,
  cardActions?: (item: CardGridItem<T>) => ReadonlyArray<CardGridAction<T>>,
): MenuEntry[] | undefined {
  if (item.actions && item.actions.length > 0) {
    return [...item.actions];
  }
  if (!cardActions) return undefined;
  const derived = cardActions(item);
  if (derived.length === 0) return undefined;
  return derived.map((act, idx) => ({
    type: 'item' as const,
    id: act.id ?? `card-action-${idx}`,
    label: act.label,
    icon: act.icon,
    shortcut: act.shortcut,
    danger: act.danger,
    disabled: act.disabled,
    onSelect: () => act.onSelect(item),
  }));
}
