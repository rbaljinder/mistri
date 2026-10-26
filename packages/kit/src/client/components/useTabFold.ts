/**
 * A strip of tabs that fits its row: the tabs that do not fit go under a More menu at its end, never past the edge
 * for the reader to scroll to (design.md, "Nothing scrolls sideways"). A tenant App's strips ran 648px in a 627px room at a
 * desk, and past a phone's on its cases, alerts and approvals, and a strip that scrolls hides that there is more.
 *
 * Every tab stays drawn, so each can be measured as it is (its count arriving, the look's font loading): one that is
 * folded wears `data-folded`, which the stylesheet takes out of the row (absolute, hidden) without changing its width.
 * The tab chosen is never folded: it keeps its place in order, and the ones before it give way. The fold is decided
 * in a layout effect, before the first paint, and again before the paint after any size changes, so a tab is never
 * seen in one place and then another.
 */
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import { viewportBox } from '../core.js';

/**
 * Which items are shown: as many as fit in order, with room left for More where any do not, and the chosen one always
 * among them (the last that fit give way to it). `widths` are each item's own, `gap` the space between two.
 */
export function foldTabs(widths: readonly number[], room: number, more: number, gap: number, active: number): number[] {
  const all = widths.map((_, i) => i);
  const span = (items: readonly number[]) => items.reduce((sum, i) => sum + widths[i], 0) + gap * Math.max(0, items.length - 1);
  if (span(all) <= room) return all;
  /* More stands after the shown ones, a gap before it. */
  const budget = room - more - gap;
  const shown: number[] = [];
  for (const i of all) {
    if (span([...shown, i]) > budget) break;
    shown.push(i);
  }
  if (active >= 0 && active < widths.length && !shown.includes(active)) {
    while (shown.length && span([...shown, active]) > budget) shown.pop();
    shown.push(active);
  }
  return shown;
}

/* A tab's width is fractional (its words), and a strip's room is whole pixels: what a sum of fractions may lose. */
const SLACK = 0.5;

/**
 * The fold of one strip. Its tabs wear `data-fold="<index>"` (a wrapper, where a tab has a button beside it), in a row
 * whose gap is the strip's, and its More wears `data-fold-more`; `active` is the chosen tab's index, `count` how many.
 * Returns the ref for the strip and the indices folded under More.
 */
export function useTabFold(count: number, active: number): { strip: RefObject<HTMLDivElement | null>; folded: ReadonlySet<number> } {
  const strip = useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = useState<ReadonlySet<number>>(NONE);
  const latest = useRef({ active, folded });
  latest.current = { active, folded };

  useLayoutEffect(() => {
    const box = strip.current;
    if (!box) return;
    let frame = 0;
    /* `effect` is the layout effect, `observer` a ResizeObserver's callback, `frame` the next frame's start. */
    const measure = (from: 'effect' | 'observer' | 'frame') => {
      const items = [...box.querySelectorAll<HTMLElement>('[data-fold]')];
      const more = box.querySelector<HTMLElement>('[data-fold-more]');
      const style = getComputedStyle(box);
      /* Layout pixels throughout (the ruler's boxes, clientWidth, the computed gap), so the density zoom cancels out.
         Widths as drawn, fractions and all: offsetWidth rounds each tab, which overstated a row of six by 3px and moved
         the filters beside it. */
      const gap = parseFloat(style.columnGap || '0') || 0;
      const widths: number[] = [];
      for (const item of items) widths[Number(item.dataset.fold)] = viewportBox(item).width;
      for (let i = 0; i < widths.length; i++) widths[i] ??= 0;
      const natural = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1);
      const room = box.clientWidth - parseFloat(style.paddingLeft || '0') - parseFloat(style.paddingRight || '0');
      if (room <= 0) return;
      const shown = new Set(foldTabs(widths, room + SLACK, more ? viewportBox(more).width : 0, gap, latest.current.active));
      const next = new Set(widths.map((_, i) => i).filter((i) => !shown.has(i)));
      /* For a row that sizes the strip by its content (a list's controls): with nothing folded the strip is its tabs'
         width on its own; with some folded it goes on asking for every tab's, so it gives way only where the row
         cannot hold them, and takes the tabs back when the row can. Moving from one to the other leaves the strip
         the size it is, both being its tabs' width at that moment. */
      const edges = box.offsetWidth - box.clientWidth + parseFloat(style.paddingLeft || '0') + parseFloat(style.paddingRight || '0');
      const basis = next.size ? `${Math.round((natural + edges) * 100) / 100}px` : '';
      const asked = box.style.getPropertyValue('--tabs-natural');
      if (asked !== basis) {
        /* A new width while folded resizes the strip itself, which a ResizeObserver's callback may not do to an
           element it has just been told about (the browser reports a loop, and drops what the page's other observers
           were owed). The next frame asks for it, before that frame paints, and folds to the size it gives. */
        if (from === 'observer' && asked && basis) {
          cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => measure('frame'));
          return;
        }
        if (basis) box.style.setProperty('--tabs-natural', basis);
        else box.style.removeProperty('--tabs-natural');
      }
      const before = latest.current.folded;
      if (next.size === before.size && [...next].every((i) => before.has(i))) return;
      const value = next.size ? next : NONE;
      /* After a resize, before that frame paints: the strip is never drawn overrunning, or folded for a size gone.
         A fold takes tabs out of the row without resizing the strip, so it is safe inside the observer's callback. */
      if (from === 'effect') setFolded(value);
      else flushSync(() => setFolded(value));
    };
    measure('effect');
    if (typeof ResizeObserver === 'undefined') return;
    const watch = new ResizeObserver(() => measure('observer'));
    watch.observe(box);
    for (const item of box.querySelectorAll<HTMLElement>('[data-fold], [data-fold-more]')) watch.observe(item);
    return () => {
      cancelAnimationFrame(frame);
      watch.disconnect();
    };
  }, [count, active]);

  return { strip, folded };
}

const NONE: ReadonlySet<number> = new Set();
