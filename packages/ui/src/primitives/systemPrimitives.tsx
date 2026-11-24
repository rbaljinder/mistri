/** Text match and fuzzy highlighting, undo/redo state history hook, and history toolbar. */
'use client';

import * as React from 'react';
import { useShortcut, useShortcutHint } from '@ui-sdk/react/shortcuts';
import { fuzzyScore, matchRanges, matchSegments, type MatchSegment } from '@ui-sdk/react/text-match';
import { Icon } from '../Icon.js';
import { cx, isEmptyStateSpec, type EmptyStateSpec } from '../internal/cx.js';

/* ============================================================================
 * 1. HighlightMatch (Text Match & Fuzzy Highlighting)
 * ========================================================================== */

/** Matching strategy for `HighlightMatch`. */
export type HighlightMatchMode = 'contains' | 'startsWith' | 'fuzzy';

/** Props for the `HighlightMatch` component. */
export interface HighlightMatchProps extends Omit<React.ComponentProps<'span'>, 'children' | 'onChange' | 'aria-label' | 'inlist'> {
  /** Source text to render and highlight. */
  text: string;
  /** Search query whose matched characters or ranges will be highlighted. */
  query?: string;
  /** Matching strategy (`'contains'`, `'startsWith'`, or `'fuzzy'`). Defaults to `'fuzzy'`. */
  mode?: HighlightMatchMode;
  /** Optional minimum fuzzy match score (`0..1`) required before highlighting. */
  minScore?: number;
  /** Custom class applied to each `<mark>` element. */
  markClassName?: string;
  ariaLabel?: string;
}

/** Inline text highlighter that wraps matched query segments in `<mark>` elements. */
export function HighlightMatch({
  text,
  query,
  mode = 'fuzzy',
  minScore = 0,
  markClassName,
  ariaLabel,
  className,
  ...rest
}: HighlightMatchProps): React.JSX.Element {
  const legacyAriaLabel = (rest as Record<string, unknown>)['aria-label'] as string | undefined;
  const resolvedAriaLabel = ariaLabel ?? legacyAriaLabel;
  const segments = React.useMemo<MatchSegment[] | null>(() => {
    const trimmed = query?.trim() ?? '';
    if (!trimmed || !text) return null;
    if (minScore > 0 && fuzzyScore(text, trimmed) < minScore) {
      return null;
    }
    const ranges = matchRanges(text, trimmed, mode);
    if (ranges.length === 0) return null;
    return matchSegments(text, ranges);
  }, [text, query, mode, minScore]);

  if (!segments) {
    return (
      <span aria-label={resolvedAriaLabel} className={className} {...rest}>
        {text}
      </span>
    );
  }

  return (
    <span aria-label={resolvedAriaLabel} className={className} {...rest}>
      {segments.map((segment, index) =>
        segment.match ? (
          <mark key={index} className={cx('nx-highlight-match', markClassName)}>
            {segment.text}
          </mark>
        ) : (
          <React.Fragment key={index}>{segment.text}</React.Fragment>
        ),
      )}
    </span>
  );
}

/* ============================================================================
 * 2. useHistoryState & UndoRedoBar (@ui-sdk/react/history)
 * ========================================================================== */

/** Recorded timeline entry in a `useHistoryState` controller. */
export interface HistoryStepItem<T = unknown> {
  id: string;
  description: string;
  source: string;
  timestamp: number;
  snapshot?: T;
  sdkEntry?: unknown;
}

/** Staged control mutation passed to `HistoryStateController.stage`. */
export interface StagedHistoryChange {
  target: string | Element;
  key?: string;
  value?: unknown;
  source?: string;
  description?: string;
}

/** Configuration options for `useHistoryState`. */
export interface UseHistoryStateOptions<T = unknown> {
  /** Maximum number of state snapshots to retain. Defaults to `100`. */
  limit?: number;
  /** Coalesce rapid state updates with identical descriptions within this window (ms). Defaults to `350`. */
  coalesceMs?: number;
  /**
   * When `true` (or automatically when `initialValue` is omitted), observes live control changes
   * inside `scopeRef` (or `within`).
   */
  observeControls?: boolean;
  /** Optional custom UI agent instance used for live control observation and staging. */
  agent?: unknown;
  /** Optional explicit container element or getter for control observation. */
  within?: Element | null | (() => Element | null | undefined);
  /** Observed control state keys. Defaults to `['value', 'checked', 'pressed']`. */
  keys?: string[];
  /** Whether continuous drags/typing on one control are coalesced. Defaults to `true`. */
  coalesce?: boolean;
  /** Formatter for state snapshot action descriptions when none is explicitly passed to `set()`. */
  describeSnapshot?: (next: T, previous: T) => string;
}

/** State and timeline controller returned by `useHistoryState`. */
export interface HistoryStateController<T = unknown> {
  /** Current state value. */
  value: T;
  /** Alias for `value`. */
  state: T;
  /** Record a new state snapshot with an optional human-readable action description. */
  set: (next: T | ((prev: T) => T), description?: string) => void;
  /** Step backward one entry. */
  undo: () => Promise<void>;
  /** Step forward one entry. */
  redo: () => Promise<void>;
  /** Jump to a specific step position (`0..totalSteps`). */
  seek: (step: number) => Promise<void>;
  /** Stage programmatic or AI-driven control updates and receive `{ applied, revert }`. */
  stage: (changes: ReadonlyArray<StagedHistoryChange>) => { applied: number; revert: () => Promise<void> };
  /** Revert all applied control changes from a specific source (e.g. `'agent'`). */
  undoSource: (source: string) => Promise<void>;
  /** Clear recorded history entries while keeping the current value/DOM state intact. */
  clear: () => void;
  /** Reset back to `nextInitial` (or the original `initialValue`) and clear history. */
  reset: (nextInitial?: T) => void;
  /** Whether there is at least one applied step to undo. */
  canUndo: boolean;
  /** Whether there is at least one undone step to redo. */
  canRedo: boolean;
  /** 0-based count of applied steps (`0` = initial state, `totalSteps` = latest). */
  step: number;
  /** Total recorded steps available across the undo/redo timeline. */
  totalSteps: number;
  /** Ordered list of recorded steps (oldest first). */
  entries: ReadonlyArray<HistoryStepItem<T>>;
  /** Human-readable description of the most recently applied action, or `null` at step `0`. */
  latestAction: string | null;
  /** Attach to a container `<div ref={history.scopeRef}>` to scope live control observation. */
  scopeRef: React.RefObject<HTMLDivElement | null>;
}

/** Props for the `UndoRedoBar` component. */
export interface UndoRedoBarProps extends Omit<React.ComponentProps<'div'>, 'onChange' | 'aria-label' | 'inlist'> {
  /** Bind directly to a `useHistoryState` controller. */
  history?: Pick<
    HistoryStateController<unknown>,
    'canUndo' | 'canRedo' | 'undo' | 'redo' | 'step' | 'totalSteps' | 'latestAction' | 'clear'
  >;
  canUndo?: boolean;
  canRedo?: boolean;
  onUndo?: () => void | Promise<void>;
  onRedo?: () => void | Promise<void>;
  onClear?: () => void;
  step?: number;
  totalSteps?: number;
  latestAction?: React.ReactNode;
  empty?: EmptyStateSpec | React.ReactNode;
  ariaLabel?: string;
  /** Render as a floating elevated pill bar. Defaults to `false` (inline pill bar). */
  floating?: boolean;
  /** Register `Mod+Z` and `Mod+Shift+Z` shortcuts while mounted. Defaults to `true`. */
  bindShortcuts?: boolean;
  /** Show formatted shortcut badges inside Undo/Redo buttons. Defaults to `true`. */
  showShortcuts?: boolean;
  /** Show a button to clear recorded history when non-empty. Defaults to `false`. */
  showClear?: boolean;
  words?: {
    regionLabel?: string;
    undo?: string;
    redo?: string;
    clearHistory?: string;
  };
}

/** Undo/redo toolbar displaying step progress, latest action description, and shortcut hints. */
export function UndoRedoBar({
  history,
  canUndo: canUndoProp,
  canRedo: canRedoProp,
  onUndo,
  onRedo,
  onClear,
  step: stepProp,
  totalSteps: totalStepsProp,
  latestAction: latestActionProp,
  empty,
  ariaLabel,
  floating = false,
  bindShortcuts = true,
  showShortcuts = true,
  showClear = false,
  words,
  className,
  ...rest
}: UndoRedoBarProps): React.JSX.Element {
  const legacyRest = rest as Record<string, unknown>;
  const legacyEmptyLabel = legacyRest.emptyLabel as React.ReactNode | undefined;
  const legacyAriaLabel = legacyRest['aria-label'] as string | undefined;
  const forwardedRest = { ...rest };
  delete (forwardedRest as Record<string, unknown>).emptyLabel;

  const emptyNode = empty !== undefined ? (isEmptyStateSpec(empty) ? empty.title : empty) : (legacyEmptyLabel ?? 'No changes recorded');

  const canUndo = canUndoProp ?? history?.canUndo ?? false;
  const canRedo = canRedoProp ?? history?.canRedo ?? false;
  const step = stepProp ?? history?.step ?? 0;
  const totalSteps = totalStepsProp ?? history?.totalSteps ?? 0;
  const latestAction = latestActionProp !== undefined ? latestActionProp : (history?.latestAction ?? null);
  const undoLabel = words?.undo ?? 'Undo';
  const redoLabel = words?.redo ?? 'Redo';
  const clearHistoryLabel = words?.clearHistory ?? 'Clear history';

  const handleUndo = React.useCallback(() => {
    if (!canUndo) return;
    if (onUndo) {
      void onUndo();
    } else if (history) {
      void history.undo();
    }
  }, [canUndo, onUndo, history]);

  const handleRedo = React.useCallback(() => {
    if (!canRedo) return;
    if (onRedo) {
      void onRedo();
    } else if (history) {
      void history.redo();
    }
  }, [canRedo, onRedo, history]);

  const handleClear = React.useCallback(() => {
    if (onClear) {
      onClear();
    } else if (history) {
      history.clear();
    }
  }, [onClear, history]);

  useShortcut(
    bindShortcuts ? 'mod+z' : null,
    () => {
      handleUndo();
    },
    { when: () => canUndo, description: 'Undo last change' },
  );

  useShortcut(
    bindShortcuts ? 'mod+shift+z' : null,
    () => {
      handleRedo();
    },
    { when: () => canRedo, description: 'Redo change' },
  );

  const undoHint = useShortcutHint('mod+z');
  const redoHint = useShortcutHint('mod+shift+z');

  return (
    <div
      role="region"
      aria-label={ariaLabel ?? legacyAriaLabel ?? words?.regionLabel ?? 'History controls'}
      data-slot="undo-redo-bar"
      data-floating={floating ? '' : undefined}
      className={cx('nx-undo-redo-bar', className)}
      {...forwardedRest}
    >
      <div className="nx-undo-redo-actions">
        <button
          type="button"
          onClick={handleUndo}
          disabled={!canUndo}
          aria-keyshortcuts={undoHint.ariaKeyshortcuts}
          title={`${undoLabel} (${undoHint.text})`}
          className="nx-undo-redo-btn nx-focusable"
        >
          <Icon name="arrow-counter-clockwise" size={14} weight="bold" />
          <span>{undoLabel}</span>
          {showShortcuts ? <kbd className="nx-kbd">{undoHint.text}</kbd> : null}
        </button>

        <button
          type="button"
          onClick={handleRedo}
          disabled={!canRedo}
          aria-keyshortcuts={redoHint.ariaKeyshortcuts}
          title={`${redoLabel} (${redoHint.text})`}
          className="nx-undo-redo-btn nx-focusable"
        >
          <Icon name="arrow-clockwise" size={14} weight="bold" />
          <span>{redoLabel}</span>
          {showShortcuts ? <kbd className="nx-kbd">{redoHint.text}</kbd> : null}
        </button>
      </div>

      <span className="nx-undo-redo-divider" aria-hidden="true" />

      <div className="nx-undo-redo-meta" aria-live="polite">
        <span className="nx-undo-redo-step" data-active={totalSteps > 0 ? '' : undefined}>
          {step} / {totalSteps}
        </span>
        <span className="nx-undo-redo-description" data-empty={latestAction === null ? '' : undefined}>
          {latestAction ?? emptyNode}
        </span>
      </div>

      {showClear && totalSteps > 0 ? (
        <button
          type="button"
          onClick={handleClear}
          aria-label={clearHistoryLabel}
          title={clearHistoryLabel}
          className="nx-undo-redo-clear nx-focusable"
        >
          <Icon name="trash" size={13} />
        </button>
      ) : null}
    </div>
  );
}
