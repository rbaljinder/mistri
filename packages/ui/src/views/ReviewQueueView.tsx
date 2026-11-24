/** Split-pane approval triage queue pairing a filterable request list with field-by-field before/after diffs. */
'use client';

import { Icon } from '../Icon.js';
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Change, Turns, TurnsName, TurnsSkip, type TurnsReason } from '@mistriwork/ui/behaviors/index.js';
import { Button } from '../primitives/actions.js';
import { type AvatarStatus, Badge, Kbd, Person, StatusDot } from '../primitives/display.js';
import { EmptyState } from '../primitives/feedback.js';
import { TextArea } from '../TextArea.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec, type Tone } from '../internal/cx.js';

/** Triage decision outcome recorded in `ReviewQueueView`. */
export type ReviewQueueDecision = 'approved' | 'changes-requested';

/** Requester identity summary for a `ReviewQueueItem`. */
export interface ReviewQueueRequester {
  name: string;
  role?: ReactNode;
  email?: string;
  src?: string;
  status?: AvatarStatus;
}

/** Field-by-field before/after diff entry on a `ReviewQueueItem`. */
export interface ReviewQueueDiff {
  field: string;
  before?: ReactNode;
  after: ReactNode;
  changeType?: 'modified' | 'added' | 'removed';
}

/** Key/value context metadata entry on a `ReviewQueueItem`. */
export interface ReviewQueueMetaItem {
  label: ReactNode;
  value: ReactNode;
}

/** Queued approval or triage item rendered in `ReviewQueueView`. */
export interface ReviewQueueItem<T = unknown> {
  id: string;
  code?: string;
  title: string;
  category?: string;
  priority?: 'urgent' | 'high' | 'medium' | 'low';
  tone?: Tone;
  submittedAt?: string;
  requester: ReviewQueueRequester;
  summary: ReactNode;
  diffs?: ReviewQueueDiff[];
  metadata?: ReviewQueueMetaItem[];
  data?: T;
}

/** Recorded triage decision entry emitted by `ReviewQueueView`. */
export interface ReviewQueueDecisionRecord<T = unknown> {
  id: string;
  item: ReviewQueueItem<T>;
  decision: ReviewQueueDecision;
  note: string;
  decidedAt: string;
}

/** Props for the `ReviewQueueView` component. */
export interface ReviewQueueViewProps<T = unknown> {
  items: Array<ReviewQueueItem<T>>;
  /* Controlled or uncontrolled handled item IDs */
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (handledIds: string[], details?: Change<TurnsReason>) => void;
  /* Triage callbacks */
  onApprove?: (item: ReviewQueueItem<T>, note: string) => void;
  onRequestChanges?: (item: ReviewQueueItem<T>, note: string) => void;
  onDecision?: (record: ReviewQueueDecisionRecord<T>) => void;
  onReset?: () => void;
  /* Customization */
  title?: ReactNode;
  allowNotes?: boolean;
  notePlaceholder?: string;
  enableShortcuts?: boolean;
  approveLabel?: ReactNode;
  requestChangesLabel?: ReactNode;
  skipLabel?: ReactNode;
  resetLabel?: ReactNode;
  empty?: EmptyStateSpec | ReactNode;
  ariaLabel?: string;
  locale?: string;
  words?: ReviewQueueWords;
  renderItemDetail?: (item: ReviewQueueItem<T>) => ReactNode;
  /* Whether the view draws its own border, radius and shadow. `false` inside a Card or Panel, which already draws
     them: a card in a card is one box too many. */
  framed?: boolean;
  className?: string;
}

/** Localized UI strings for `ReviewQueueView` landmarks and progress indicators. */
export interface ReviewQueueWords {
  shortcutsLabel?: string;
  progressLabel?: string;
  overviewLabel?: string;
}

function priorityTone(priority?: ReviewQueueItem['priority']): Tone {
  switch (priority) {
    case 'urgent':
      return 'critical';
    case 'high':
      return 'warning';
    case 'medium':
      return 'info';
    case 'low':
    default:
      return 'neutral';
  }
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Split-pane approval triage queue pairing a filterable request list with field-by-field before/after diffs. */
export function ReviewQueueView<T = unknown>({
  items,
  value: controlledHandled,
  defaultValue = [],
  onValueChange,
  onApprove,
  onRequestChanges,
  onDecision,
  onReset,
  title = 'Approval and triage queue',
  allowNotes = true,
  notePlaceholder = 'Add an optional reviewer note or reason for the requester…',
  enableShortcuts = true,
  approveLabel = 'Approve',
  requestChangesLabel = 'Request changes',
  skipLabel = 'Skip',
  resetLabel = 'Reset queue',
  empty,
  ariaLabel,
  locale,
  words,
  renderItemDetail,
  framed = true,
  className,
}: ReviewQueueViewProps<T>) {
  const shellRef = useRef<HTMLDivElement>(null);

  const canonicalIds = useMemo(() => items.map((i) => i.id), [items]);
  const [orderedKeys, setOrderedKeys] = useState<string[]>(canonicalIds);

  useEffect(() => {
    setOrderedKeys((prev) => {
      const nextSet = new Set(canonicalIds);
      const kept = prev.filter((k) => nextSet.has(k));
      const keptSet = new Set(kept);
      const added = canonicalIds.filter((k) => !keptSet.has(k));
      return [...kept, ...added];
    });
  }, [canonicalIds]);

  const [internalHandled, setInternalHandled] = useState<string[]>(defaultValue);
  const handledIds = controlledHandled !== undefined ? controlledHandled : internalHandled;

  const [decisions, setDecisions] = useState<Record<string, ReviewQueueDecisionRecord<T>>>({});
  const [notesById, setNotesById] = useState<Record<string, string>>({});

  const itemMap = useMemo(() => {
    const map = new Map<string, ReviewQueueItem<T>>();
    for (const item of items) {
      map.set(item.id, item);
    }
    return map;
  }, [items]);

  const focusTurnsName = useCallback(() => {
    if (typeof requestAnimationFrame === 'undefined') return;
    requestAnimationFrame(() => {
      const nameEl = shellRef.current?.querySelector<HTMLElement>('[data-slot="turns-name"]');
      nameEl?.focus();
    });
  }, []);

  const commitHandled = useCallback(
    (next: string[], details?: Change<TurnsReason>) => {
      if (controlledHandled === undefined) {
        setInternalHandled(next);
      }
      onValueChange?.(next, details);
    },
    [controlledHandled, onValueChange],
  );

  const recordDecision = useCallback(
    (itemId: string, decision: ReviewQueueDecision) => {
      const item = itemMap.get(itemId);
      if (!item || handledIds.includes(itemId)) return;

      const resolvedTag =
        locale?.trim() || (typeof document !== 'undefined' ? document.documentElement?.lang?.trim() || undefined : undefined);
      const note = (notesById[itemId] ?? '').trim();
      const record: ReviewQueueDecisionRecord<T> = {
        id: itemId,
        item,
        decision,
        note,
        decidedAt: new Date().toLocaleTimeString(resolvedTag, {
          hour: '2-digit',
          minute: '2-digit',
        }),
      };

      setDecisions((prev) => ({ ...prev, [itemId]: record }));
      if (decision === 'approved') {
        onApprove?.(item, note);
      } else {
        onRequestChanges?.(item, note);
      }
      onDecision?.(record);

      const nextHandled = [...handledIds, itemId];
      commitHandled(nextHandled);
      focusTurnsName();
    },
    [commitHandled, focusTurnsName, handledIds, itemMap, locale, notesById, onApprove, onDecision, onRequestChanges],
  );

  const jumpToPendingItem = useCallback(
    (targetId: string, currentAt: number) => {
      const handledSet = new Set(handledIds);
      if (handledSet.has(targetId)) return;

      const unhandledCanonical = canonicalIds.filter((id) => !handledSet.has(id));
      const len = unhandledCanonical.length;
      if (len < 2) return;

      const targetIdx = unhandledCanonical.indexOf(targetId);
      if (targetIdx === -1) return;

      const safeAt = Math.min(currentAt, len - 1);
      const shift = (targetIdx - safeAt + len) % len;
      const rotatedUnhandled = unhandledCanonical.map((_, k) => unhandledCanonical[(k + shift) % len]!);
      const alreadyDone = canonicalIds.filter((id) => handledSet.has(id));
      setOrderedKeys([...rotatedUnhandled, ...alreadyDone]);
      focusTurnsName();
    },
    [canonicalIds, focusTurnsName, handledIds],
  );

  const handleResetQueue = useCallback(() => {
    setDecisions({});
    setNotesById({});
    setOrderedKeys(canonicalIds);
    commitHandled([]);
    onReset?.();
    focusTurnsName();
  }, [canonicalIds, commitHandled, focusTurnsName, onReset]);

  if (items.length === 0) {
    const legacyWords = words as (ReviewQueueWords & { emptyTitle?: string; emptyDescription?: string }) | undefined;
    return (
      <div aria-label={ariaLabel} className={cx('nx-review-queue-shell', className)}>
        {empty !== undefined && !isEmptyStateSpec(empty) ? (
          empty
        ) : (
          <EmptyState
            icon={<Icon name="tray" size={22} />}
            title={isEmptyStateSpec(empty) ? empty.title : (legacyWords?.emptyTitle ?? 'Review queue is empty')}
            description={
              isEmptyStateSpec(empty)
                ? empty.body
                : (legacyWords?.emptyDescription ??
                  (empty === undefined ? 'New approval requests and flagged records will appear here automatically.' : undefined))
            }
            action={isEmptyStateSpec(empty) ? empty.action : undefined}
          />
        )}
      </div>
    );
  }

  return (
    <div
      ref={shellRef}
      aria-label={ariaLabel}
      className={cx('nx-review-queue-shell', className)}
      data-framed={framed ? undefined : 'false'}
    >
      <Turns
        keys={orderedKeys}
        value={handledIds}
        onValueChange={(next, details) => commitHandled(next, details)}
        className="nx-review-queue"
      >
        {({ current, at, handled, left, total }) => {
          const activeItem = current ? (itemMap.get(current) ?? null) : null;
          const reviewedCount = handled.length;
          const remainingCount = left.length;
          const progressPct = total > 0 ? Math.min(100, Math.round((reviewedCount / total) * 100)) : 100;
          const reviewingPosition = Math.min(total, reviewedCount + 1);

          const approvedCount = Object.values(decisions).filter((d) => d.decision === 'approved').length;
          const changesRequestedCount = Object.values(decisions).filter((d) => d.decision === 'changes-requested').length;

          const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
            if (!enableShortcuts || !activeItem) return;
            if (e.metaKey || e.ctrlKey || e.altKey) return;
            if (isEditableElement(e.target)) return;

            const key = e.key.toLowerCase();
            if (key === 'a') {
              e.preventDefault();
              recordDecision(activeItem.id, 'approved');
            } else if (key === 'r') {
              e.preventDefault();
              recordDecision(activeItem.id, 'changes-requested');
            } else if (key === 's') {
              if (left.length >= 2) {
                e.preventDefault();
                const skipBtn = shellRef.current?.querySelector<HTMLButtonElement>('[data-slot="turns-skip"]');
                skipBtn?.click();
              }
            }
          };

          const activeNote = activeItem ? (notesById[activeItem.id] ?? '') : '';

          return (
            <div className="nx-review-queue-inner" onKeyDown={handleKeyDown}>
              {/* Top Progress & Shortcut Legend Header */}
              <header className="nx-review-header">
                <div className="nx-review-header-top">
                  <div className="nx-review-header-status">
                    <span className="nx-review-header-title">{title}</span>
                    <span className="nx-review-header-sep" aria-hidden="true">
                      ·
                    </span>
                    <span className="nx-review-counter">
                      {activeItem ? `Reviewing ${reviewingPosition} of ${total}` : `${total} of ${total} reviewed`}
                    </span>
                    <Badge tone={remainingCount === 0 ? 'good' : 'accent'} pill>
                      {remainingCount === 0 ? 'Queue zero' : `${remainingCount} remaining`}
                    </Badge>
                  </div>

                  {enableShortcuts && (
                    <div className="nx-review-shortcuts" aria-label={words?.shortcutsLabel ?? 'Keyboard shortcuts'}>
                      <span className="nx-review-shortcut-item">
                        <Kbd>A</Kbd>
                        <span>Approve</span>
                      </span>
                      <span className="nx-review-shortcut-dot" aria-hidden="true">
                        ·
                      </span>
                      <span className="nx-review-shortcut-item">
                        <Kbd>R</Kbd>
                        <span>Request changes</span>
                      </span>
                      <span className="nx-review-shortcut-dot" aria-hidden="true">
                        ·
                      </span>
                      <span className="nx-review-shortcut-item">
                        <Kbd>S</Kbd>
                        <span>Skip</span>
                      </span>
                    </div>
                  )}
                </div>

                <div
                  className="nx-review-progress-track"
                  role="progressbar"
                  aria-valuemin={0}
                  aria-valuemax={total}
                  aria-valuenow={reviewedCount}
                  aria-label={words?.progressLabel ?? 'Queue review progress'}
                >
                  <div className="nx-review-progress-fill" style={{ width: `${progressPct}%` }} />
                </div>
              </header>

              {/* Split Layout: Left Queue Overview + Right Active Card / Queue Zero */}
              <div className="nx-review-split">
                <aside className="nx-review-sidebar" aria-label={words?.overviewLabel ?? 'Queue overview'}>
                  <div className="nx-review-sidebar-head">
                    <span className="nx-review-sidebar-label">Queue items</span>
                    <span className="nx-review-sidebar-tally">
                      {reviewedCount}/{total} done
                    </span>
                  </div>

                  <ol className="nx-review-queue-list">
                    {items.map((qItem, idx) => {
                      const isCurrent = activeItem?.id === qItem.id;
                      const isHandled = handled.includes(qItem.id);
                      const decision = decisions[qItem.id]?.decision;

                      return (
                        <li key={qItem.id} className="nx-review-queue-li">
                          <button
                            type="button"
                            disabled={isHandled}
                            data-current={isCurrent ? '' : undefined}
                            data-handled={isHandled ? '' : undefined}
                            data-decision={decision}
                            onClick={() => jumpToPendingItem(qItem.id, at)}
                            className="nx-review-queue-row nx-focusable"
                          >
                            <span className="nx-review-queue-icon" aria-hidden="true">
                              {decision === 'approved' ? (
                                <Icon name="check-circle" size={15} weight="bold" className="nx-review-icon-approved" />
                              ) : decision === 'changes-requested' ? (
                                <Icon name="warning" size={15} weight="bold" className="nx-review-icon-changes" />
                              ) : isHandled ? (
                                <Icon name="check-circle" size={15} weight="bold" className="nx-review-icon-approved" />
                              ) : isCurrent ? (
                                <span className="nx-review-active-dot" />
                              ) : (
                                <span className="nx-review-index-num">{idx + 1}</span>
                              )}
                            </span>

                            <span className="nx-review-queue-copy">
                              <span className="nx-review-queue-top">
                                {qItem.code && <span className="nx-review-queue-code">{qItem.code}</span>}
                                <span className="nx-review-queue-title">{qItem.title}</span>
                              </span>
                              <span className="nx-review-queue-sub">
                                {qItem.requester.name}
                                {qItem.category ? ` · ${qItem.category}` : ''}
                              </span>
                            </span>

                            {decision === 'approved' && <Badge tone="good">Approved</Badge>}
                            {decision === 'changes-requested' && <Badge tone="warning">Changes</Badge>}
                            {!isHandled && isCurrent && <Badge tone="accent">Active</Badge>}
                          </button>
                        </li>
                      );
                    })}
                  </ol>
                </aside>

                <main className="nx-review-stage">
                  {activeItem ? (
                    <article className="nx-review-card">
                      {/* Card Header */}
                      <div className="nx-review-card-head">
                        <div className="nx-review-card-badges">
                          {activeItem.code && <span className="nx-review-item-code">{activeItem.code}</span>}
                          {activeItem.category && <Badge tone={activeItem.tone ?? 'neutral'}>{activeItem.category}</Badge>}
                          {activeItem.priority && (
                            <StatusDot tone={priorityTone(activeItem.priority)}>
                              {activeItem.priority.charAt(0).toUpperCase() + activeItem.priority.slice(1)} priority
                            </StatusDot>
                          )}
                          {activeItem.submittedAt && (
                            <span className="nx-review-timestamp">
                              <Icon name="clock" size={12.5} />
                              <span>{activeItem.submittedAt}</span>
                            </span>
                          )}
                        </div>

                        <TurnsName tabIndex={0} className="nx-review-item-title nx-focusable">
                          {activeItem.title}
                        </TurnsName>

                        <div className="nx-review-requester-bar">
                          <Person
                            size="sm"
                            name={activeItem.requester.name}
                            role={activeItem.requester.role}
                            email={activeItem.requester.email}
                            src={activeItem.requester.src}
                            status={activeItem.requester.status}
                          />
                        </div>
                      </div>

                      {/* Card Body */}
                      <div className="nx-review-card-body">
                        <div className="nx-review-summary">{activeItem.summary}</div>

                        {/* Proposed Field Diffs */}
                        {activeItem.diffs && activeItem.diffs.length > 0 && (
                          <section className="nx-review-section">
                            <div className="nx-review-section-title">
                              <Icon name="git-diff" size={14} />
                              <span>Proposed field changes</span>
                              <Badge tone="neutral" pill>
                                {activeItem.diffs.length}
                              </Badge>
                            </div>

                            <div className="nx-review-diff-table-wrap">
                              <table className="nx-review-diff-table">
                                <thead>
                                  <tr>
                                    <th>Field</th>
                                    <th>Current</th>
                                    <th aria-hidden="true" />
                                    <th>Proposed</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {activeItem.diffs.map((diff, dIdx) => (
                                    <tr key={`${diff.field}-${dIdx}`}>
                                      <td className="nx-review-diff-field">{diff.field}</td>
                                      <td>
                                        {diff.before !== undefined && diff.before !== null ? (
                                          <span className="nx-review-diff-before">{diff.before}</span>
                                        ) : (
                                          <span className="nx-review-diff-empty">—</span>
                                        )}
                                      </td>
                                      <td className="nx-review-diff-arrow" aria-hidden="true">
                                        <Icon name="arrow-right" size={12} />
                                      </td>
                                      <td>
                                        <span className="nx-review-diff-after" data-change={diff.changeType ?? 'modified'}>
                                          {diff.after}
                                        </span>
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </section>
                        )}

                        {/* Metadata Grid */}
                        {activeItem.metadata && activeItem.metadata.length > 0 && (
                          <section className="nx-review-section">
                            <div className="nx-review-section-title">
                              <span>Context and metadata</span>
                            </div>
                            <dl className="nx-review-meta-grid">
                              {activeItem.metadata.map((meta, mIdx) => (
                                <div key={mIdx} className="nx-review-meta-cell">
                                  <dt className="nx-review-meta-label">{meta.label}</dt>
                                  <dd className="nx-review-meta-value">{meta.value}</dd>
                                </div>
                              ))}
                            </dl>
                          </section>
                        )}

                        {renderItemDetail && renderItemDetail(activeItem)}

                        {/* Optional Reviewer Note */}
                        {allowNotes && (
                          <div className="nx-review-note-box">
                            <TextArea
                              label="Reviewer note"
                              optional="Optional"
                              rows={2}
                              value={activeNote}
                              onValueChange={(next) =>
                                setNotesById((prev) => ({
                                  ...prev,
                                  [activeItem.id]: next,
                                }))
                              }
                              placeholder={notePlaceholder}
                            />
                          </div>
                        )}
                      </div>

                      {/* Card Decision Footer */}
                      <footer className="nx-review-card-footer">
                        <div className="nx-review-footer-primary">
                          <Button
                            variant="primary"
                            leadingIcon={<Icon name="check" size={14} weight="bold" />}
                            shortcut={enableShortcuts ? 'A' : undefined}
                            onClick={() => recordDecision(activeItem.id, 'approved')}
                          >
                            {approveLabel}
                          </Button>
                          <Button
                            variant="danger-soft"
                            leadingIcon={<Icon name="arrow-counter-clockwise" size={14} weight="bold" />}
                            shortcut={enableShortcuts ? 'R' : undefined}
                            onClick={() => recordDecision(activeItem.id, 'changes-requested')}
                          >
                            {requestChangesLabel}
                          </Button>
                        </div>

                        <TurnsSkip data-variant="ghost" data-size="md" className="nx-button nx-review-skip-btn nx-focusable">
                          <span className="nx-btn-icon" data-side="start" aria-hidden="true">
                            <Icon name="skip-forward" size={14} weight="bold" />
                          </span>
                          <span className="nx-btn-label">{skipLabel}</span>
                          {enableShortcuts && <kbd className="nx-kbd">S</kbd>}
                        </TurnsSkip>
                      </footer>
                    </article>
                  ) : (
                    /* Queue Zero Celebration & Summary State */
                    <div className="nx-review-zero">
                      <div className="nx-review-zero-emblem" aria-hidden="true">
                        <Icon name="sparkle" size={24} weight="bold" />
                      </div>

                      <TurnsName tabIndex={0} className="nx-review-zero-title nx-focusable">
                        Queue zero: all items reviewed
                      </TurnsName>

                      <p className="nx-review-zero-desc">
                        Every queued item has been triaged and recorded. You completed all {total} {total === 1 ? 'decision' : 'decisions'}{' '}
                        in this review session.
                      </p>

                      <div className="nx-review-zero-stats">
                        <Badge tone="good" pill>
                          {approvedCount > 0 || changesRequestedCount > 0 ? `${approvedCount} approved` : `${total} handled`}
                        </Badge>
                        {(approvedCount > 0 || changesRequestedCount > 0) && (
                          <Badge tone="warning" pill>
                            {changesRequestedCount} changes requested
                          </Badge>
                        )}
                      </div>

                      {Object.keys(decisions).length > 0 && (
                        <ul className="nx-review-zero-log">
                          {items
                            .filter((it) => decisions[it.id])
                            .map((it) => {
                              const rec = decisions[it.id]!;
                              return (
                                <li key={it.id} className="nx-review-zero-log-row">
                                  <div className="nx-review-zero-log-main">
                                    {it.code && <span className="nx-review-queue-code">{it.code}</span>}
                                    <span className="nx-review-zero-log-title">{it.title}</span>
                                    {rec.note && <span className="nx-review-zero-log-note">“{rec.note}”</span>}
                                  </div>
                                  <div className="nx-review-zero-log-meta">
                                    <Badge tone={rec.decision === 'approved' ? 'good' : 'warning'}>
                                      {rec.decision === 'approved' ? 'Approved' : 'Changes requested'}
                                    </Badge>
                                    <span className="nx-review-zero-time">{rec.decidedAt}</span>
                                  </div>
                                </li>
                              );
                            })}
                        </ul>
                      )}

                      <div className="nx-review-zero-actions">
                        <Button
                          variant="secondary"
                          leadingIcon={<Icon name="arrow-counter-clockwise" size={14} weight="bold" />}
                          onClick={handleResetQueue}
                        >
                          {resetLabel}
                        </Button>
                      </div>
                    </div>
                  )}
                </main>
              </div>
            </div>
          );
        }}
      </Turns>
    </div>
  );
}
