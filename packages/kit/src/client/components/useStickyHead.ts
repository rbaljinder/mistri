/**
 * A table's head that stays in view while the page scrolls past its rows.
 *
 * `position: sticky` sticks to the nearest scroller, and a grid's wrap is one
 * (it scrolls sideways), so the head stuck to a box that never scrolls up and
 * went off the top with the page. Where the table fits its width the wrap has
 * nothing to scroll, so it is marked `data-fits` and stops being a scroller
 * (style.css); the head then sticks to the page's scroller, under its sticky
 * trail (`--head-top`, the trail's height). `data-stuck` says the head is
 * stuck, for its soft ground. A table wider than its wrap keeps the sideways
 * scroll and its head scrolls with the page, as before.
 *
 * Panes draw no scroll bar (docs/design.md), so a table that does overflow says so itself: `data-more` names
 * the sides with columns past them ("start", "end", "start end") and style.css fades those edges.
 */
import { useEffect, type RefObject } from 'react';

export function useStickyHead(wrapRef: RefObject<HTMLElement | null>, repaintKey: unknown): void {
  useEffect(() => {
    const wrap = wrapRef.current;
    const table = wrap?.querySelector(':scope > table');
    const scroller = wrap?.closest<HTMLElement>('.content');
    if (!wrap || !table || !scroller) return;
    const trail = [...scroller.querySelectorAll<HTMLElement>('.crumbs')].find((el) => getComputedStyle(el).position === 'sticky');
    const head = table.querySelector('thead');
    const fit = () => {
      /* The table's own width against the wrap's, which holds whichever way the wrap overflows. */
      const fits = table.scrollWidth <= wrap.clientWidth + 1;
      wrap.toggleAttribute('data-fits', fits);
      wrap.style.setProperty('--head-top', `${trail?.offsetHeight ?? 0}px`);
      more();
      stuck();
    };
    const more = () => {
      const past = wrap.scrollWidth - wrap.clientWidth - wrap.scrollLeft;
      const sides = [wrap.scrollLeft > 1 ? 'start' : '', past > 1 ? 'end' : ''].filter(Boolean).join(' ');
      if (sides) wrap.dataset.more = sides;
      else delete wrap.dataset.more;
    };
    const stuck = () => {
      if (!head || !wrap.hasAttribute('data-fits')) return wrap.removeAttribute('data-stuck');
      /* All in the window's pixels: under the density zoom an offsetHeight is the layout's, a rect the window's. */
      const top = trail ? trail.getBoundingClientRect().bottom : scroller.getBoundingClientRect().top;
      const box = table.getBoundingClientRect();
      wrap.toggleAttribute('data-stuck', box.top < top - 0.5 && box.bottom > top + head.getBoundingClientRect().height);
    };
    const size = new ResizeObserver(fit);
    size.observe(wrap);
    size.observe(table);
    if (trail) size.observe(trail);
    scroller.addEventListener('scroll', stuck, { passive: true });
    wrap.addEventListener('scroll', more, { passive: true });
    fit();
    return () => {
      size.disconnect();
      wrap.removeEventListener('scroll', more);
      delete wrap.dataset.more;
      scroller.removeEventListener('scroll', stuck);
    };
  }, [wrapRef, repaintKey]);
}
