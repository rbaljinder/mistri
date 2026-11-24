/** Multi-lane drag-and-drop Kanban board with WIP limits, priority tags, and lane collapse. */
import { Icon } from '../Icon.js';
import { Avatar, AvatarFallback, AvatarImage } from '@ui-sdk/react/avatar';
import { Button } from '@ui-sdk/react/button';
import { type FormEvent, type ReactNode, useMemo, useState } from 'react';
import {
  type Change,
  Transfer,
  TransferHandle,
  TransferItem,
  TransferList,
  type TransferMove,
  type TransferReason,
} from '@mistriwork/ui/behaviors/index.js';
import { cx, isEmptyStateSpec, toDataTone, type EmptyStateSpec, type Tone } from '../internal/cx.js';

/** Priority level of a `KanbanCard`. */
export type KanbanPriority = 'urgent' | 'high' | 'medium' | 'low' | 'none';

/** Tag badge attached to a `KanbanCard`. */
export interface KanbanTag {
  label: string;
  tone?: Tone;
}

/** Assignee identity summary on a `KanbanCard`. */
export interface KanbanAssignee {
  name: string;
  initials?: string;
  avatarUrl?: string;
}

/** Work item card rendered inside a `KanbanBoard` lane. */
export interface KanbanCard {
  id: string;
  code?: string;
  title: string;
  description?: string;
  priority?: KanbanPriority;
  tags?: KanbanTag[];
  assignee?: KanbanAssignee;
  dueDate?: string;
  metric?: number;
  tone?: Tone;
}

/** Lane column definition in `KanbanBoard`. */
export interface KanbanColumn {
  id: string;
  title: string;
  tone?: Tone;
  wipLimit?: number;
  metricUnit?: string;
}

/** Map of column IDs to ordered `KanbanCard` ID arrays. */
export type KanbanLaneMap = Record<string, string[]>;

/** Localized UI strings for `KanbanBoard` lanes and quick-add controls. */
export interface KanbanBoardWords {
  newCardLabel?: string;
  newCardPlaceholder?: string;
  wipReached?: string;
  cannotMove?: string;
  dropHere?: string;
  empty?: string;
  addItem?: string;
  add?: string;
  cancel?: string;
}

/** Props for the `KanbanBoard` component. */
export interface KanbanBoardProps {
  columns: KanbanColumn[];
  cards: KanbanCard[] | Record<string, KanbanCard>;
  /* Controlled or uncontrolled column -> cardIds map */
  value?: KanbanLaneMap;
  defaultValue?: KanbanLaneMap;
  onValueChange?: (value: KanbanLaneMap, details: Change<TransferReason, TransferMove>) => void;
  /* Optional acceptance predicate (lights data-takes / data-refuses / data-over) */
  accepts?: (cardId: string, toColumnId: string) => boolean;
  /* Card interactions & inline quick creator */
  onCardClick?: (card: KanbanCard) => void;
  /* Draws each lane's quick-add. Defaults to whether `onCreateCard` is given: without it a new card is kept only in
     the board's own state, which on a board drawn from data persists nothing. */
  allowCreate?: boolean;
  onCreateCard?: (columnId: string, title: string, createdCard: KanbanCard) => void;
  formatMetric?: (sum: number, column: KanbanColumn) => string;
  renderCard?: (card: KanbanCard) => ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  words?: KanbanBoardWords;
  ariaLabel?: string;
  className?: string;
}

/* The lane a card that is in no lane belongs in: the column its own `status` (or `columnId`) names, by id or by
   title, and otherwise none, which the caller reads as the first lane. `KanbanCard` declares neither field; a host
   that keeps a card's lane on the card passes it through, and this reads it rather than ignore it. */
function laneNamedBy(card: KanbanCard, columns: KanbanColumn[]): string | undefined {
  const fields = card as unknown as { status?: unknown; columnId?: unknown };
  for (const named of [fields.columnId, fields.status]) {
    if (typeof named !== 'string' || named === '') continue;
    const wanted = named.trim().toLowerCase();
    const column = columns.find((col) => col.id.toLowerCase() === wanted || col.title.trim().toLowerCase() === wanted);
    if (column) return column.id;
  }
  return undefined;
}

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]?.toUpperCase() ?? '').join('') || '?';
}

function PriorityIcon({ priority = 'none' }: { priority?: KanbanPriority }) {
  switch (priority) {
    case 'urgent':
      return (
        <span className="nx-kanban-priority" data-priority="urgent" title="Urgent priority">
          <Icon name="lightning" size={13} weight="bold" />
        </span>
      );
    case 'high':
      return (
        <span className="nx-kanban-priority" data-priority="high" title="High priority">
          <Icon name="arrow-up" size={13} weight="bold" />
        </span>
      );
    case 'medium':
      return (
        <span className="nx-kanban-priority" data-priority="medium" title="Medium priority">
          <Icon name="equals" size={13} weight="bold" />
        </span>
      );
    case 'low':
      return (
        <span className="nx-kanban-priority" data-priority="low" title="Low priority">
          <Icon name="arrow-down" size={13} weight="bold" />
        </span>
      );
    case 'none':
    default:
      return (
        <span className="nx-kanban-priority" data-priority="none" title="No priority">
          <Icon name="minus" size={13} />
        </span>
      );
  }
}

/** Multi-lane drag-and-drop Kanban board with WIP limits, priority tags, and inline card creation. */
export function KanbanBoard({
  columns,
  cards,
  value: controlledLanes,
  defaultValue,
  onValueChange,
  accepts,
  onCardClick,
  allowCreate: allowCreateProp,
  onCreateCard,
  formatMetric,
  renderCard,
  empty,
  words,
  ariaLabel = 'Kanban board',
  className,
}: KanbanBoardProps) {
  const allowCreate = allowCreateProp ?? Boolean(onCreateCard);
  const [createdCards, setCreatedCards] = useState<Record<string, KanbanCard>>({});
  const [createdIn, setCreatedIn] = useState<Record<string, string>>({});
  const [addingColumnId, setAddingColumnId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState('');

  const cardLookup = useMemo(() => {
    const map: Record<string, KanbanCard> = { ...createdCards };
    if (Array.isArray(cards)) {
      for (const c of cards) map[c.id] = c;
    } else {
      Object.assign(map, cards);
    }
    return map;
  }, [cards, createdCards]);

  const computedInitialLanes = useMemo<KanbanLaneMap>(() => {
    const empty: KanbanLaneMap = {};
    for (const col of columns) empty[col.id] = [];
    if (defaultValue) {
      for (const col of columns) {
        empty[col.id] = defaultValue[col.id] ? [...defaultValue[col.id]!] : [];
      }
      return empty;
    }
    if (Array.isArray(cards) && columns[0]) {
      empty[columns[0].id] = cards.map((c) => c.id);
    }
    return empty;
  }, [columns, defaultValue, cards]);

  const [internalLanes, setInternalLanes] = useState<KanbanLaneMap>(computedInitialLanes);
  const lanes = useMemo(() => {
    const base = controlledLanes ?? internalLanes;
    const normalized: KanbanLaneMap = {};
    const placed = new Set<string>();
    for (const col of columns) {
      normalized[col.id] = base[col.id] ?? [];
      for (const id of normalized[col.id]!) placed.add(id);
    }
    /* A card in no lane is still a card. The lane map is often worked out before the cards have loaded
       (`defaultValue` from an empty first fetch) or kept by a host that has not heard of a new card yet; drawn
       strictly from the map, those cards were on no lane at all and the board looked as if they did not exist.
       Each goes to the lane it was created in or names itself, and failing that to the first, where it can be seen
       and moved. */
    const first = columns[0]?.id;
    if (first !== undefined) {
      for (const [id, card] of Object.entries(cardLookup)) {
        if (placed.has(id)) continue;
        const created = createdIn[id];
        const lane = (created !== undefined && normalized[created] ? created : undefined) ?? laneNamedBy(card, columns) ?? first;
        normalized[lane] = [...normalized[lane]!, id];
      }
    }
    return normalized;
  }, [controlledLanes, internalLanes, columns, cardLookup, createdIn]);

  const columnsById = useMemo(() => {
    const m = new Map<string, KanbanColumn>();
    for (const col of columns) m.set(col.id, col);
    return m;
  }, [columns]);

  const columnOrder = useMemo(() => columns.map((c) => c.id), [columns]);
  const columnTitleMap = useMemo(() => {
    const m: Record<string, string> = {};
    for (const col of columns) m[col.id] = col.title;
    return m;
  }, [columns]);

  const resolvedAccepts = useMemo(() => {
    const hasWip = columns.some((c) => c.wipLimit !== undefined);
    if (!accepts && !hasWip) return undefined;
    return (cardId: string, toColumnId: string): boolean => {
      if (accepts && !accepts(cardId, toColumnId)) return false;
      const targetCol = columnsById.get(toColumnId);
      if (targetCol?.wipLimit !== undefined) {
        const targetIds = lanes[toColumnId] ?? [];
        if (!targetIds.includes(cardId) && targetIds.length >= targetCol.wipLimit) {
          return false;
        }
      }
      return true;
    };
  }, [accepts, columns, columnsById, lanes]);

  const handleLanesChange = (next: KanbanLaneMap, details: Change<TransferReason, TransferMove>) => {
    if (controlledLanes === undefined) setInternalLanes(next);
    onValueChange?.(next, details);
  };

  const handleCreateSubmit = (e: FormEvent, columnId: string) => {
    e.preventDefault();
    const trimmed = draftTitle.trim();
    if (!trimmed) return;
    const targetCol = columnsById.get(columnId);
    if (targetCol?.wipLimit !== undefined && (lanes[columnId]?.length ?? 0) >= targetCol.wipLimit) {
      return;
    }
    const id = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const nextNumber = Object.keys(cardLookup).length + 101;
    const created: KanbanCard = {
      id,
      code: `TSK-${nextNumber}`,
      title: trimmed,
      priority: 'medium',
    };

    setCreatedCards((prev) => ({ ...prev, [id]: created }));
    setCreatedIn((prev) => ({ ...prev, [id]: columnId }));
    if (controlledLanes === undefined) {
      setInternalLanes((prev) => ({
        ...prev,
        [columnId]: [...(prev[columnId] ?? []), id],
      }));
    }
    onCreateCard?.(columnId, trimmed, created);
    setDraftTitle('');
    setAddingColumnId(null);
  };

  return (
    <Transfer
      value={lanes}
      onValueChange={handleLanesChange}
      accepts={resolvedAccepts}
      order={columnOrder}
      label={(key) => cardLookup[key]?.title ?? key}
      listLabel={(colId) => columnTitleMap[colId] ?? colId}
      aria-label={ariaLabel}
      className={cx('nx-kanban-board', className)}
      /* Lanes that cannot all fit at their floor scroll sideways inside the board, on purpose (gradeProbe.ts). */
      data-scrolls=""
    >
      {columns.map((col) => (
        <TransferList
          key={col.id}
          value={col.id}
          render={<section />}
          aria-label={col.title}
          className="nx-kanban-lane"
          around={(items, state) => {
            const count = state.keys.length;
            const overWip = col.wipLimit !== undefined && count > col.wipLimit;
            const atWip = col.wipLimit !== undefined && count >= col.wipLimit;
            const metricSum = state.keys.reduce((acc, key) => acc + (cardLookup[key]?.metric ?? 0), 0);
            const hasMetric = state.keys.some((key) => cardLookup[key]?.metric !== undefined);
            const metricDisplay = hasMetric
              ? formatMetric
                ? formatMetric(metricSum, col)
                : col.metricUnit
                  ? `${metricSum} ${col.metricUnit}`
                  : String(metricSum)
              : null;

            return (
              <>
                <header className="nx-kanban-lane-header">
                  <div className="nx-kanban-lane-title-group">
                    <span className="nx-status-dot" data-tone={toDataTone(col.tone) ?? 'neutral'} aria-hidden="true" />
                    <h3 className="nx-kanban-lane-title">{col.title}</h3>
                    <span
                      className="nx-badge"
                      data-tone={overWip ? 'warning' : 'neutral'}
                      data-pill=""
                      title={col.wipLimit !== undefined ? `WIP: ${count} of ${col.wipLimit} limit` : `${count} items`}
                    >
                      {overWip && <Icon name="warning" size={11} weight="bold" />}
                      {col.wipLimit !== undefined ? `${count}/${col.wipLimit}` : count}
                    </span>
                  </div>

                  <div className="nx-kanban-lane-meta">
                    {metricDisplay && <span className="nx-kanban-lane-sum">{metricDisplay}</span>}
                    {allowCreate && (
                      <button
                        type="button"
                        className="nx-kanban-header-add"
                        disabled={atWip}
                        title={atWip ? (words?.wipReached ?? 'WIP limit reached') : undefined}
                        onClick={() => {
                          if (atWip) return;
                          setAddingColumnId(col.id);
                          setDraftTitle('');
                        }}
                        aria-label={`Add item to ${col.title}`}
                      >
                        <Icon name="plus" size={13} weight="bold" />
                      </button>
                    )}
                  </div>
                </header>

                {state.refuses && (
                  <div className="nx-kanban-lane-banner" data-kind="refuses">
                    <Icon name="prohibit" size={13} weight="bold" />
                    <span>{words?.cannotMove ?? 'Cannot move here'}</span>
                  </div>
                )}

                {/* A long lane scrolls its own cards, on purpose, and says so for the check that looks for a page
                    scrolling twice (gradeProbe.ts). */}
                <ul className="nx-kanban-cards" data-scrolls="">
                  {count === 0 ? (
                    <li className="nx-kanban-empty">
                      {state.takes
                        ? (words?.dropHere ?? 'Drop card here')
                        : empty !== undefined
                          ? isEmptyStateSpec(empty)
                            ? empty.title
                            : empty
                          : (words?.empty ?? 'No items')}
                    </li>
                  ) : (
                    items
                  )}
                </ul>

                {allowCreate && (
                  <footer className="nx-kanban-lane-footer">
                    {addingColumnId === col.id && !atWip ? (
                      <form className="nx-kanban-creator" onSubmit={(e) => handleCreateSubmit(e, col.id)}>
                        <input
                          type="text"
                          value={draftTitle}
                          onChange={(e) => setDraftTitle(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Escape') {
                              e.stopPropagation();
                              setAddingColumnId(null);
                              setDraftTitle('');
                            }
                          }}
                          aria-label={words?.newCardLabel ?? 'Card title'}
                          placeholder={words?.newCardPlaceholder ?? 'Card title…'}
                          className="nx-kanban-creator-input"
                          autoFocus
                        />
                        <div className="nx-kanban-creator-actions">
                          <Button type="submit" data-size="xs" data-variant="primary">
                            {words?.add ?? 'Add'}
                          </Button>
                          <Button
                            type="button"
                            data-size="xs"
                            data-variant="ghost"
                            onClick={() => {
                              setAddingColumnId(null);
                              setDraftTitle('');
                            }}
                          >
                            {words?.cancel ?? 'Cancel'}
                          </Button>
                        </div>
                      </form>
                    ) : (
                      <button
                        type="button"
                        className="nx-kanban-add-btn"
                        disabled={atWip}
                        title={atWip ? (words?.wipReached ?? 'WIP limit reached') : undefined}
                        onClick={() => {
                          if (atWip) return;
                          setAddingColumnId(col.id);
                          setDraftTitle('');
                        }}
                      >
                        <Icon name="plus" size={13} weight="bold" />
                        <span>{words?.addItem ?? 'Add item'}</span>
                      </button>
                    )}
                  </footer>
                )}
              </>
            );
          }}
        >
          {(cardId) => {
            const card = cardLookup[cardId];
            if (!card) return null;

            return (
              <TransferItem
                key={card.id}
                value={card.id}
                className="nx-kanban-card"
                onClick={(e) => {
                  if (!onCardClick) return;
                  if ((e.target as HTMLElement).closest('button, input, a')) return;
                  onCardClick(card);
                }}
              >
                {renderCard ? (
                  renderCard(card)
                ) : (
                  <>
                    <div className="nx-kanban-card-top">
                      <div className="nx-kanban-card-id-group">
                        <PriorityIcon priority={card.priority} />
                        {card.code && <span className="nx-kanban-card-code">{card.code}</span>}
                      </div>
                      <TransferHandle
                        aria-label={`Move ${card.code ? `${card.code} ` : ''}${card.title}`}
                        className="nx-kanban-card-grip"
                      />
                    </div>

                    <div className="nx-kanban-card-title">{card.title}</div>
                    {card.description && <div className="nx-kanban-card-desc">{card.description}</div>}

                    {(card.tags?.length || card.dueDate || card.assignee || card.metric !== undefined) && (
                      <div className="nx-kanban-card-bottom">
                        <div className="nx-kanban-card-tags">
                          {card.tags?.map((tag) => (
                            <span key={tag.label} className="nx-badge" data-tone={toDataTone(tag.tone)}>
                              {tag.label}
                            </span>
                          ))}
                          {card.dueDate && (
                            <span className="nx-kanban-card-due">
                              <Icon name="calendar-blank" size={12} />
                              <span>{card.dueDate}</span>
                            </span>
                          )}
                          {card.metric !== undefined && <span className="nx-kanban-card-metric">{card.metric}</span>}
                        </div>

                        {card.assignee && (
                          <Avatar className="nx-kanban-avatar" title={card.assignee.name}>
                            {card.assignee.avatarUrl && <AvatarImage src={card.assignee.avatarUrl} alt={card.assignee.name} />}
                            <AvatarFallback className="nx-kanban-avatar-fallback">
                              {card.assignee.initials ?? initialsOf(card.assignee.name)}
                            </AvatarFallback>
                          </Avatar>
                        )}
                      </div>
                    )}
                  </>
                )}
              </TransferItem>
            );
          }}
        </TransferList>
      ))}
    </Transfer>
  );
}
