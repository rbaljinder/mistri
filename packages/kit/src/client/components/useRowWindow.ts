/**
 * Windowed drawing for the lists that are not the grid: cards, a queue and a
 * checklist draw every row they are handed, and a page of a thousand cards is
 * a thousand pictures, facts and buttons laid out before the first paint.
 *
 * Only the *drawing* is windowed. The rows handed in are still the whole page
 * — the pager, the record trail, export and a queue's selection all count
 * them as before — and at or under the threshold nothing changes at all, so
 * an ordinary page draws exactly what it drew. Above it, the rows around the
 * viewport are drawn between two spacers that hold the rest of the page's
 * height, measured on the zoom-aware ruler (core.js) because the density
 * zoom puts spacer heights and scroll offsets in layout pixels.
 *
 * A list laid out in columns (cards) is windowed by line: `columns` says how
 * many items stand side by side, and a line is drawn or not as a whole, so
 * the grid never shifts a card into another column as it scrolls.
 */
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { viewportBox, viewportSize } from '../core.js';

/**
 * Past a hundred rows a page is windowed; at or under it nothing is. Lower
 * than the grid's 300 (Grid.tsx) on purpose: a card or a queue row is a
 * dozen grid cells' worth of layout, and the App's largest page size is 250,
 * which the grid's threshold would never reach. Every smaller page size (10
 * to 100) still draws exactly what it drew.
 */
export const WINDOW_THRESHOLD = 100;
const OVERSCAN = 6;

export interface RowWindow<E extends HTMLElement> {
  /** The list's element: what is measured, and where the scroller is looked for. */
  ref: (element: E | null) => void;
  windowed: boolean;
  /** The item indexes to draw, in order: every one when not windowed. */
  indices: number[];
  /** Spacer heights before and after the drawn items, in layout pixels; 0 draws no spacer. */
  before: number;
  after: number;
  /** A drawn item's ref, beside `data-index={lineOf(index)}`: how a row's real height is learned. */
  measure: (element: Element | null) => void;
  lineOf: (index: number) => number;
  /** Bring an item into the window, so a keyboard move to a row not yet drawn has a row to land on. */
  scrollTo: (index: number) => void;
}

export function useRowWindow<E extends HTMLElement>(
  count: number,
  options: {
    /** How many items stand side by side in the list, read from its element. */
    columns?: (list: E) => number;
    /** A first guess at one line's height, corrected by measurement. */
    estimate?: number;
  } = {},
): RowWindow<E> {
  const windowed = count > WINDOW_THRESHOLD;
  const [list, setList] = useState<E | null>(null);
  /* The element is kept aside and only becomes state once the page is long
     enough to window: an ordinary list must not pay a second render for it. */
  const element = useRef<E | null>(null);
  const windowedNow = useRef(windowed);
  windowedNow.current = windowed;
  const ref = useCallback((node: E | null) => {
    element.current = node;
    if (windowedNow.current) setList(node);
  }, []);
  useLayoutEffect(() => {
    if (windowed) setList(element.current);
  }, [windowed]);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [columns, setColumns] = useState(1);
  const [margin, setMargin] = useState(0);
  const [gap, setGap] = useState(0);
  const columnsOf = useRef(options.columns);
  columnsOf.current = options.columns;
  useLayoutEffect(() => {
    if (!windowed || !list) return;
    setScroller((list.closest('.content') as HTMLElement | null) ?? (document.scrollingElement as HTMLElement | null));
  }, [windowed, list]);
  const lines = windowed ? Math.ceil(count / columns) : 0;
  const virtualizer = useVirtualizer({
    count: lines,
    getScrollElement: () => scroller,
    estimateSize: () => options.estimate ?? 72,
    overscan: OVERSCAN,
    scrollMargin: margin,
    gap,
    enabled: windowed && Boolean(scroller),
    // Drawn from the first paint, before the scroller is found and measured: a window's worth, not nothing.
    initialRect: { width: 0, height: windowed ? viewportSize().height : 0 },
    // Measured in layout pixels: the default reads screen pixels, which the density zoom scales.
    measureElement: (element) => viewportBox(element).height,
  });
  /* Where the list starts inside what scrolls, how many items share a line
     and the gap between lines, read after each paint: all three move with the
     room's width and the header above the list, none of them per scroll. */
  useLayoutEffect(() => {
    if (!windowed || !list || !scroller) return;
    const style = getComputedStyle(list);
    const across = Math.max(1, columnsOf.current?.(list) ?? 1);
    if (across !== columns) setColumns(across);
    const rowGap = Number.parseFloat(style.rowGap) || 0;
    if (rowGap !== gap) setGap(rowGap);
    const top =
      scroller === document.scrollingElement
        ? viewportBox(list).top + scroller.scrollTop
        : viewportBox(list).top - viewportBox(scroller).top + scroller.scrollTop;
    if (Math.abs(top - margin) >= 1) setMargin(top);
  });

  const lineOf = (index: number) => Math.floor(index / columns);
  if (!windowed) {
    return {
      ref,
      windowed,
      indices: Array.from({ length: count }, (_, i) => i),
      before: 0,
      after: 0,
      measure: () => {},
      lineOf,
      scrollTo: () => {},
    };
  }
  let items: Array<{ index: number; start: number; end: number }> = virtualizer.getVirtualItems();
  /* A scroller that measures no height (not laid out yet, or no layout at
     all) would draw nothing: the first screenful stands in until it does. */
  if (!items.length && lines) {
    const size = options.estimate ?? 72;
    items = Array.from({ length: Math.min(lines, Math.ceil(viewportSize().height / size) + OVERSCAN) }, (_, index) => ({
      index,
      start: margin + index * (size + gap),
      end: margin + index * (size + gap) + size,
    }));
  }
  const total = virtualizer.getTotalSize() || lines * ((options.estimate ?? 72) + gap) - gap;
  const indices: number[] = [];
  for (const item of items) {
    for (let i = item.index * columns; i < Math.min(count, (item.index + 1) * columns); i++) indices.push(i);
  }
  /* A spacer is an item of the list too, so the list's own gap stands beside
     it once more than the lines it replaces: taken off its height. */
  const before = items.length ? Math.max(0, items[0].start - margin - gap) : 0;
  const after = items.length ? Math.max(0, total - (items[items.length - 1].end - margin) - gap) : 0;
  return {
    ref,
    windowed,
    indices,
    before,
    after,
    measure: virtualizer.measureElement,
    lineOf,
    scrollTo: (index) => virtualizer.scrollToIndex(lineOf(index), { align: 'auto' }),
  };
}

/**
 * The list element's ref, for both the window and another owner of the same
 * element (a hand order's zone). Stable across renders: a fresh callback each
 * paint would hand the window null and the element again every time.
 */
export function useListRef<E extends HTMLElement>(win: RowWindow<E>, other?: (element: E | null) => void): (element: E | null) => void {
  const also = useRef(other);
  also.current = other;
  const own = win.ref;
  return useCallback(
    (element: E | null) => {
      also.current?.(element);
      own(element);
    },
    [own],
  );
}
