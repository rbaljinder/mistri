import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import type { RowWindow } from '@mistriwork/kit/client/components/useRowWindow.js';
import { say } from '../copy/lists/components/CollectionSelection.js';

export interface CollectionSelectionItem {
  /** An opaque, stable application key. It is never coerced to a number. */
  key: string;
  label: ReactNode;
  disabled?: boolean;
}

type SelectionChangeReason = 'replace' | 'toggle' | 'range' | 'select-all' | 'clear';

interface SelectionChange {
  reason: SelectionChangeReason;
  anchorKey: string | null;
}

interface CollectionSelectionProps {
  items: readonly CollectionSelectionItem[];
  /** Exact application keys. The host owns persistence and authorization. */
  selectedKeys?: readonly string[];
  /** When omitted, focus is managed internally; when supplied, it is controlled. */
  focusedKey?: string | null;
  ariaLabel?: string;
  emptyMessage?: ReactNode;
  onSelectionChange?: (keys: string[], change: SelectionChange) => void;
  onFocusChange?: (key: string | null) => void;
  /** Called for Escape-clears, in addition to onSelectionChange. */
  onClearSelection?: () => void;
  /** Asked first about a key on an item; a key it takes (preventDefault) is the host's, not the list's — Alt+↑/↓ that reorders. */
  onItemKey?: (event: KeyboardEvent<HTMLDivElement>, item: CollectionSelectionItem) => void;
  renderItem?: (item: CollectionSelectionItem, state: { selected: boolean; focused: boolean }) => ReactNode;
  /**
   * A long collection's window (useRowWindow.ts): only the items around the
   * viewport are drawn. Selection, ranges and select-all still read every
   * item; a keyboard move to one not drawn scrolls it in and focuses it once
   * it is there.
   */
  window?: RowWindow<HTMLDivElement>;
}

/**
 * A keyboard-first, presentation-only collection selection surface.
 *
 * Drawn as an ARIA grid of one column, each item a selectable row
 * (`aria-selected`, `aria-multiselectable` on the grid) whose one cell holds
 * what the host draws. Not a listbox: an option's content is presentational,
 * so a button inside one — a queue's Open — was a control a screen reader
 * could not reach and axe named (nested-interactive). A grid cell may hold a
 * control, and a row is announced with its selection state all the same.
 *
 * Selection is deliberately a set of opaque keys supplied by the host. This
 * block does not fetch, persist, authorize, dispatch commands, or interpret a
 * missing key as "all records". Shift extends from the last anchor, Meta/Ctrl
 * toggles, Escape clears, and arrows/Home/End move the focused row.
 */
export function CollectionSelection({
  items,
  selectedKeys = [],
  focusedKey,
  ariaLabel = say('collection'),
  emptyMessage = say('noItems'),
  onSelectionChange,
  onFocusChange,
  onClearSelection,
  onItemKey,
  renderItem,
  window: win,
}: CollectionSelectionProps) {
  const [uncontrolledFocus, setUncontrolledFocus] = useState<string | null>(null);
  const anchorRef = useRef<string | null>(null);
  const itemRefs = useRef(new Map<string, HTMLDivElement>());
  const currentFocus = focusedKey === undefined ? uncontrolledFocus : focusedKey;
  const selectable = items.filter((item) => !item.disabled);
  const selected = new Set(selectedKeys);

  /* A focus asked for an item the window has not drawn yet: taken as soon as it is. */
  const pendingFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = pendingFocus.current ? itemRefs.current.get(pendingFocus.current) : undefined;
    if (element) {
      pendingFocus.current = null;
      element.focus();
    }
  });

  const focusItem = (item: CollectionSelectionItem | undefined) => {
    if (!item) return;
    if (focusedKey === undefined) setUncontrolledFocus(item.key);
    onFocusChange?.(item.key);
    const element = itemRefs.current.get(item.key);
    if (element) {
      element.focus();
      return;
    }
    pendingFocus.current = item.key;
    win?.scrollTo(items.findIndex((candidate) => candidate.key === item.key));
  };

  const emitSelection = (keys: string[], reason: SelectionChangeReason, anchorKey: string | null) => {
    onSelectionChange?.(keys, { reason, anchorKey });
  };

  const rangeKeys = (fromKey: string, toKey: string) => {
    const from = selectable.findIndex((item) => item.key === fromKey);
    const to = selectable.findIndex((item) => item.key === toKey);
    if (from < 0 || to < 0) return [];
    const start = Math.min(from, to);
    const end = Math.max(from, to);
    return selectable.slice(start, end + 1).map((item) => item.key);
  };

  const selectItem = (item: CollectionSelectionItem, range: boolean, toggle: boolean) => {
    if (item.disabled) return;
    if (range) {
      const anchor = anchorRef.current ?? currentFocus ?? item.key;
      const keys = rangeKeys(anchor, item.key);
      if (keys.length) emitSelection(keys, 'range', anchor);
      return;
    }
    if (toggle) {
      const keys = selected.has(item.key) ? selectedKeys.filter((key) => key !== item.key) : [...selectedKeys, item.key];
      anchorRef.current = item.key;
      emitSelection(keys, 'toggle', item.key);
      return;
    }
    anchorRef.current = item.key;
    emitSelection([item.key], 'replace', item.key);
  };

  const onItemKeyDown = (event: KeyboardEvent<HTMLDivElement>, item: CollectionSelectionItem) => {
    onItemKey?.(event, item);
    if (event.defaultPrevented) return;
    const toggle = event.metaKey || event.ctrlKey;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const offset = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
      const edge = event.key === 'Home' ? 'first' : event.key === 'End' ? 'last' : undefined;
      const index = selectable.findIndex((candidate) => candidate.key === item.key);
      const target = edge === 'first' ? selectable[0] : edge === 'last' ? selectable.at(-1) : selectable[index + offset];
      if (target) {
        focusItem(target);
        if (event.shiftKey) selectItem(target, true, false);
      }
      return;
    }
    if (event.key === ' ' || event.key === 'Enter') {
      event.preventDefault();
      selectItem(item, event.shiftKey, toggle);
      return;
    }
    if (event.key.toLowerCase() === 'a' && toggle) {
      event.preventDefault();
      anchorRef.current = item.key;
      emitSelection(
        selectable.map((candidate) => candidate.key),
        'select-all',
        item.key,
      );
      return;
    }
    if (event.key === 'Escape') {
      if (selectedKeys.length === 0) return;
      event.preventDefault();
      anchorRef.current = null;
      emitSelection([], 'clear', null);
      onClearSelection?.();
    }
  };

  const drawn = win ? win.indices.map((index) => items[index]).filter(Boolean) : items;
  /* The one tab stop is the focused item's; when a window has not drawn it,
     the first drawn item takes it, so Tab still lands in the list. */
  const tabStop = win
    ? drawn.some((item) => item.key === currentFocus)
      ? currentFocus
      : (drawn.find((item) => !item.disabled)?.key ?? null)
    : undefined;
  /* The empty word is said beside the grid, not in it: a grid holds rows. */
  if (items.length === 0)
    return (
      <div className="collection-selection">
        <div className="collection-selection-empty" role="status">
          {emptyMessage}
        </div>
      </div>
    );
  return (
    <div
      className="collection-selection"
      role="grid"
      aria-label={ariaLabel}
      aria-multiselectable="true"
      {...(win ? { 'aria-rowcount': items.length, ref: win.ref } : {})}
    >
      {win && win.before > 0 && <div className="collection-selection-spacer" aria-hidden="true" style={{ height: `${win.before}px` }} />}
      {drawn.map((item) => {
        const isSelected = selected.has(item.key);
        const isFocused = currentFocus === item.key;
        const index = win ? items.indexOf(item) : -1;
        return (
          <div
            key={item.key}
            ref={(element) => {
              if (element) itemRefs.current.set(item.key, element);
              else itemRefs.current.delete(item.key);
              if (win) win.measure(element);
            }}
            // Drawn in part, the rows still say where each stands in the whole.
            {...(win ? { 'data-index': win.lineOf(index), 'aria-rowindex': index + 1 } : {})}
            className={`collection-selection-item${isSelected ? ' is-selected' : ''}${isFocused ? ' is-focused' : ''}`}
            role="row"
            aria-selected={isSelected}
            aria-disabled={item.disabled || undefined}
            tabIndex={(win ? tabStop === item.key : isFocused || (currentFocus === null && selectable[0]?.key === item.key)) ? 0 : -1}
            onFocus={() => {
              if (focusedKey === undefined) setUncontrolledFocus(item.key);
              onFocusChange?.(item.key);
            }}
            onClick={(event) => selectItem(item, event.shiftKey, event.metaKey || event.ctrlKey)}
            onKeyDown={(event) => onItemKeyDown(event, item)}
          >
            <div className="collection-selection-cell" role="gridcell">
              {renderItem ? renderItem(item, { selected: isSelected, focused: isFocused }) : item.label}
            </div>
          </div>
        );
      })}
      {win && win.after > 0 && <div className="collection-selection-spacer" aria-hidden="true" style={{ height: `${win.after}px` }} />}
    </div>
  );
}
