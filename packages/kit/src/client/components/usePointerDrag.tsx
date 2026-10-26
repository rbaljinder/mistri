/**
 * Dragging with a pointer: the gesture (pointerDrag.ts) wired to the page.
 * One implementation for everything the client lets a reader drag — a
 * board's card to a lane or a place, a calendar's record to a day, a list's
 * row to its place (useListOrder) — each host saying only where a drop lands
 * and what it does there.
 *
 * A host spreads `source(item, enabled)` on what may be dragged, and marks
 * where it may land with `data-drop-zone` (a lane, a day, a list) and the
 * items there with `data-drop-item` (or a selector of its own). While a drag
 * runs the item's copy follows the pointer, the item stays where it was,
 * faded, and `over` is told what is under the pointer at every move — to
 * mark where the drop would land — and `drop` where it was let go. Near the
 * edge of anything that scrolls (a board's lanes, the page) the view scrolls
 * with it; a strip that snaps (a phone's lanes) stops snapping while a drag
 * runs, and steps a lane at a time. Escape, a pointer the browser takes back
 * (pointercancel) or the host going away puts the item back: nothing is
 * dropped, and `end` clears what `over` marked.
 *
 * Where a host keeps an order (`gap`), `over` answers with the slot the drop
 * would take, and the run opens there: the items after it slide aside by the
 * carried item's size, by transform alone, so the place is seen rather than
 * read off a rule the copy would cover. On the drop the host draws the move at
 * once (flushSync), and the copy settles into where the item now stands
 * (`locate`), or back where it came from; then it goes. Reduced motion opens
 * the gap and lands the copy without the slide.
 *
 * Pointer Events rather than the browser's drag and drop, which a finger
 * cannot start on most phones and which draws its own picture of the item.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import {
  TOUCH_HOLD_MS,
  beginGesture,
  edgeSpeed,
  endGesture,
  holdGesture,
  moveGesture,
  slideOffsets,
  type Gesture,
  type GestureEffect,
} from './pointerDrag.js';
import { addHostListener, portalRoot, removeHostListener, shellRoot } from '../shellHost.js';

/** What is under the pointer: the zone it would land in, the item there, and which half of it. */
export interface DropPoint {
  zone: HTMLElement;
  /** The item under the pointer — or, over a zone's gap, the first item below it — absent past the zone's last. */
  item?: HTMLElement;
  /** In the item's upper half; true where it has no height to halve. */
  upper: boolean;
  /** In the item's left half, for items that stand beside each other. */
  left: boolean;
}

/** Where a drop would land, for the gap: a zone, and the item it would stand before (null: after the zone's last). */
export interface DropSlot {
  zone: HTMLElement;
  before: HTMLElement | null;
}

interface PointerDragOptions<T> {
  /** The pointer moved over `at` (null: nowhere a drop could land). With `gap`, the slot it would take there, if any. */
  over: (item: T, at: DropPoint | null) => DropSlot | null | void;
  /** The item was let go over `at`. A host with `locate` draws the move before it returns (flushSync). */
  drop: (item: T, at: DropPoint | null) => void;
  /** The drag is over, dropped or put back: clear what `over` marked. */
  end?: (item: T) => void;
  /** What an item is, inside a zone; `[data-drop-item]` unless the host's rows already say it. */
  items?: string;
  /** Open a gap where `over` says the drop would land, the run's items sliding aside: items one under another only. */
  gap?: boolean;
  /** Where the item stands once the drop is drawn, for the copy to settle into; absent, the copy goes where it is. */
  locate?: (item: T) => HTMLElement | null;
}

/* One drag at a time on the page, whichever host started it. */
let active: { cancel: () => void } | null = null;
/* A finger that lifted an item carries it; the page must not scroll under it.
   Stopping that takes a touchmove listener that is not passive, and one that
   is there before the touch starts: Safari does not ask a listener added
   mid-gesture. So one listener, while any host is on the page, that says no
   only while a finger is dragging. */
let fingerDragging = false;
let hosts = 0;
const holdStill = (event: TouchEvent) => {
  if (fingerDragging && event.cancelable) event.preventDefault();
};
/* How far each item stands aside of its place while a gap is open, in layout pixels; and the zoom they are read at. */
const shifts = new WeakMap<HTMLElement, number>();
let scaleNow = 1;
const IGNORED = '[data-drag-ignore], input, textarea, select, [contenteditable="true"]';
/* Dropped on the copy, marks and ids would be found twice. */
const COPIED_AWAY = ['id', 'data-drop-zone', 'data-drop-item', 'data-drop', 'data-lifted', 'data-draggable', 'data-row-key', 'data-card'];

/* The root's density zoom: the copy is placed in layout pixels, and the
   pointer and every box are measured in screen pixels (core.js's
   viewportScale is the same reading; read here once per drag so the engine
   stands alone in the component tests that stand core.js in). */
const zoom = () => Number(getComputedStyle(shellRoot()).zoom) || 1;
const still = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/* The house's press duration and curve (docs/design.md, motion rule 10): a theme's pace reaches them, and a still
   pace makes them nothing. Written on the element, not in a stylesheet: the engine is reached from modules the
   Node suites import, where a CSS import cannot load, and the app stylesheet has no room to spare. */
const SLIDE = 'var(--t-press, 140ms) var(--ease-out, ease-out)';
const pressMs = () => {
  const said = getComputedStyle(shellRoot()).getPropertyValue('--t-press').trim();
  const ms = said.endsWith('ms') ? parseFloat(said) : said.endsWith('s') ? parseFloat(said) * 1000 : 140;
  return Number.isFinite(ms) ? Math.min(ms, 150) : 140;
};

/**
 * The copy that follows the pointer: the item itself, under shallow copies
 * of its ancestors that draw nothing of their own (`display: contents`) but
 * keep every selector and custom property that dresses it where it sits. A
 * table row keeps its table, and its cells their widths.
 */
function copyOf(element: HTMLElement, scale: number): HTMLElement {
  const box = element.getBoundingClientRect(); // screen-px: divided by the zoom into the layout pixels the copy is sized in
  const ghost = document.createElement('div');
  ghost.className = 'drag-ghost';
  ghost.setAttribute('aria-hidden', 'true');
  ghost.setAttribute('inert', '');
  ghost.style.width = `${box.width / scale}px`;
  ghost.style.height = `${box.height / scale}px`;
  const copy = element.cloneNode(true) as HTMLElement;
  copy.setAttribute('data-ghost', '');
  copy.style.removeProperty('scale');
  copy.style.removeProperty('transition');
  if (element instanceof HTMLTableRowElement) {
    [...element.cells].forEach((cell, i) => {
      const twin = copy.children[i] as HTMLElement | undefined;
      if (twin) twin.style.width = `${cell.getBoundingClientRect().width / scale}px`; // screen-px: into layout pixels, as above
    });
  }
  let inner: HTMLElement = copy;
  for (let node = element.parentElement; node && node !== document.body && node !== shellRoot(); node = node.parentElement) {
    const shell = shellOf(node);
    if (node.tagName === 'TABLE') Object.assign(shell.style, { width: '100%', height: '100%', tableLayout: 'fixed', margin: '0' });
    else if (!/^(TBODY|THEAD|TFOOT)$/.test(node.tagName)) shell.style.display = 'contents';
    shell.appendChild(inner);
    inner = shell;
  }
  for (const node of [inner, ...inner.querySelectorAll('*')]) for (const name of COPIED_AWAY) node.removeAttribute(name);
  ghost.appendChild(inner);
  portalRoot().appendChild(ghost);
  return ghost;
}

/* A slide down the run (up where negative), as the `translate` property spells it. */
const along = (by: number) => `0 ${by}` + 'px';

/* One ancestor's shell, without its children. A details is copied as a div
   wearing its attributes: a details with no summary draws one of its own,
   `display: contents` or not, and a board row's copy carried a "Details"
   line above the card. */
function shellOf(node: HTMLElement): HTMLElement {
  if (node.tagName !== 'DETAILS') return node.cloneNode(false) as HTMLElement;
  const shell = document.createElement('div');
  for (const { name, value } of node.attributes) shell.setAttribute(name, value);
  return shell;
}

/* What can scroll under a drag: the item's own scrolling ancestors, then the page. */
function scrollersOf(element: HTMLElement): HTMLElement[] {
  const found: HTMLElement[] = [];
  for (let node = element.parentElement; node && node !== document.body && node !== shellRoot(); node = node.parentElement) {
    const style = getComputedStyle(node);
    if (/(auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) found.push(node);
  }
  return found;
}

/* A snapping strip's stops, in its own scroll pixels: where each child that snaps would bring the strip to rest. */
function stopsOf(node: HTMLElement, scale: number): number[] {
  const box = node.getBoundingClientRect(); // screen-px: each stop is turned into the strip's scroll pixels by the zoom
  const pad = parseFloat(getComputedStyle(node).scrollPaddingLeft) || 0;
  const stops = [...node.querySelectorAll<HTMLElement>(':scope > *, :scope > * > *')]
    .filter(
      (child) =>
        child.offsetWidth > 0 &&
        getComputedStyle(child)
          .scrollSnapAlign.split(' ')
          .some((part) => part !== 'none'),
    )
    .map((child) => Math.round((child.getBoundingClientRect().left - box.left) / scale + node.scrollLeft - pad));
  return [...new Set(stops)].sort((a, b) => a - b);
}

/* What a run's item takes up along it: its height and the gap after it, in layout pixels. */
function sizeOf(item: HTMLElement): number {
  const parent = item.parentElement;
  const gap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
  return item.offsetHeight + gap;
}

export function usePointerDrag<T>(options: PointerDragOptions<T>) {
  const latest = useRef(options);
  latest.current = options;
  const [dragging, setDragging] = useState<T | null>(null);
  const own = useRef<{ cancel: () => void } | null>(null);
  useEffect(() => {
    if (hosts++ === 0) addHostListener(window, 'touchmove', holdStill, { passive: false });
    return () => {
      own.current?.cancel();
      if (--hosts === 0) removeHostListener(window, 'touchmove', holdStill);
    };
  }, []);

  const selector = () => latest.current.items ?? '[data-drop-item]';
  /* The copy follows the pointer and owns its cursor, so the page under it is asked past it. */
  const under = (x: number, y: number): Element | null => {
    const all = typeof document.elementsFromPoint === 'function' ? document.elementsFromPoint(x, y) : [];
    const found = all.find((node) => !node.closest('.drag-ghost'));
    return found ?? (all.length ? null : document.elementFromPoint(x, y));
  };
  /* Where an item is laid out, whatever its slide has reached: where it is seen, less the slide as drawn this frame
     (a running transition's computed value). Less the slide's end value it was wrong mid-transition, and the gap ran
     ahead of the pointer. */
  const laidTop = (item: HTMLElement, seen: number) => {
    if (!shifts.get(item)) return seen;
    const drawn = parseFloat((getComputedStyle(item).translate || '').split(' ')[1] ?? '0') || 0;
    return seen - drawn * scaleNow; // screen-px: the slide is in layout pixels
  };
  const hit = (x: number, y: number): DropPoint | null => {
    const at = under(x, y);
    const zone = at?.closest<HTMLElement>('[data-drop-zone]');
    if (!zone) return null;
    const items = selector();
    const found = at!.closest<HTMLElement>(items);
    const halves = (item: HTMLElement) => {
      const box = item.getBoundingClientRect(); // screen-px: compared with the pointer's clientX/Y
      return { upper: box.height === 0 || y < box.top + box.height / 2, left: box.width === 0 || x < box.left + box.width / 2 };
    };
    /* With a gap open the items stand aside of where they are laid out, and are asked where they are laid out: asked
       where they are seen, the gap moved what was under the pointer, which moved the gap. */
    const gapped = Boolean(latest.current.gap);
    if (found && zone.contains(found) && !(gapped && (found.hasAttribute('data-drag-origin') || shifts.get(found))))
      return { zone, item: found, ...halves(found) };
    /* A page not laid out (no item has a size) has no gap to be over: what is under the pointer is the answer. */
    if (found && zone.contains(found) && found.getBoundingClientRect().height === 0) return { zone, item: found, ...halves(found) }; // screen-px: only its size is read
    /* Over a gap between items: the first item whose middle is below the pointer, else past the last. */
    for (const item of zone.querySelectorAll<HTMLElement>(items)) {
      if (item.closest('[data-drop-zone]') !== zone || (gapped && item.hasAttribute('data-drag-origin'))) continue;
      const box = item.getBoundingClientRect(); // screen-px: compared with the pointer's clientY
      const top = laidTop(item, box.top);
      if (y < top + box.height / 2) return { zone, item, upper: true, left: true };
    }
    return { zone, upper: false, left: false };
  };

  /** Begin a gesture from a press on `element`, which stands for `item`. A host whose rows are not its own delegates here. */
  const start = (event: PointerEvent | ReactPointerEvent, item: T, element: HTMLElement) => {
    if (active || !event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
    /* A modified click is the list's own gesture (a range, a toggle), and a control inside the item is the control's. */
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    const ignored = (event.target as Element | null)?.closest?.(IGNORED);
    if (ignored && element.contains(ignored)) return;
    const pointer = event.pointerId;
    let gesture: Gesture = beginGesture(event.pointerType, event.clientX, event.clientY, performance.now());
    let x = event.clientX,
      y = event.clientY;
    let ghost: HTMLElement | null = null;
    let offset = { x: 0, y: 0 };
    let scale = 1;
    let scrollers: HTMLElement[] = [];
    let frame = 0;
    /* The run the item stands in, for the gap: the item as an entry of its zone, and the zone. */
    const origin = (element.closest<HTMLElement>(selector()) ?? element) as HTMLElement;
    const home = origin.closest<HTMLElement>('[data-drop-zone]');
    let slot: DropSlot | null = null;
    const slid = new Set<HTMLElement>();
    const roomy = new Map<HTMLElement, string>();
    const unsnapped = new Map<HTMLElement, string>();
    const stepped = new Map<HTMLElement, number>();
    const motion = !still();

    const runOf = (zone: HTMLElement) =>
      [...zone.querySelectorAll<HTMLElement>(selector())].filter((each) => each.closest('[data-drop-zone]') === zone);
    const slide = (node: HTMLElement, by: number) => {
      if ((shifts.get(node) ?? 0) === by) return;
      if (motion && !node.style.transition) node.style.transition = `translate ${SLIDE}`;
      node.style.translate = by ? along(by) : '';
      shifts.set(node, by);
      slid.add(node);
    };
    /* The gap where the slot is: the run it is in opens by the item's size, the run the item left closes over it. */
    const open = (next: DropSlot | null) => {
      if (next?.zone === slot?.zone && next?.before === slot?.before) return;
      slot = next;
      const step = sizeOf(origin);
      const zones = new Set<HTMLElement>([...slid].map((node) => node.closest<HTMLElement>('[data-drop-zone]')!).filter(Boolean));
      if (home) zones.add(home);
      if (next) zones.add(next.zone);
      for (const zone of zones) {
        const run = runOf(zone);
        const at = run.indexOf(origin);
        const others = run.filter((each) => each !== origin);
        const landing = next?.zone === zone ? (next.before ? others.indexOf(next.before) : others.length) : undefined;
        const offsets = next
          ? slideOffsets(run.map(sizeOf), at < 0 ? undefined : at, landing !== undefined && landing >= 0 ? landing : undefined, step)
          : run.map(() => 0);
        run.forEach((node, i) => slide(node, offsets[i]));
        /* A run the item enters grows by it at its foot, so the last item slides into the run's own room. */
        const entering = Boolean(next && next.zone === zone && at < 0);
        if (entering && !roomy.has(zone)) {
          roomy.set(zone, zone.style.paddingBottom);
          zone.style.paddingBottom = `${(parseFloat(getComputedStyle(zone).paddingBottom) || 0) + step}px`;
        } else if (!entering && roomy.has(zone)) {
          zone.style.paddingBottom = roomy.get(zone)!;
          roomy.delete(zone);
        }
      }
      /* Gone from its run, the item's own place closes; back in it, it is the faded slot the gap stands for. */
      origin.style.opacity = next && next.zone !== home ? '0' : '';
    };
    const unslide = () => {
      for (const node of slid) {
        node.style.transition = '';
        node.style.translate = '';
        shifts.delete(node);
      }
      slid.clear();
      for (const [zone, padding] of roomy) zone.style.paddingBottom = padding;
      roomy.clear();
      origin.style.opacity = '';
      slot = null;
    };

    const track = () => {
      if (!ghost) return;
      ghost.style.transform = `translate(${(x - offset.x) / scale}px, ${(y - offset.y) / scale}px)`;
      const next = latest.current.over(item, hit(x, y));
      if (latest.current.gap) open(next || null);
    };
    /* Near an edge of anything that scrolls, it scrolls, faster the nearer; then what is under the pointer is asked
       again. A strip that snapped steps a stop at a time, once the last step has had its moment: scrolled a few
       pixels a frame it was snapped straight back, and a phone's drag never reached the next lane. */
    const scroll = () => {
      let moved = false;
      const now = performance.now();
      for (const node of scrollers) {
        const box = node.getBoundingClientRect(); // screen-px: compared with the pointer's clientX/Y
        const dx = node.scrollWidth > node.clientWidth ? edgeSpeed(x, box.left, box.right) : 0;
        const dy = node.scrollHeight > node.clientHeight ? edgeSpeed(y, box.top, box.bottom) : 0;
        const [left, top] = [node.scrollLeft, node.scrollTop];
        if (dx && unsnapped.has(node)) {
          if (now - (stepped.get(node) ?? 0) > 600) {
            const stops = stopsOf(node, scale);
            const to = dx > 0 ? stops.find((stop) => stop > left + 2) : stops.filter((stop) => stop < left - 2).at(-1);
            if (to !== undefined) node.scrollTo({ left: to, behavior: motion ? 'smooth' : 'auto' });
            stepped.set(node, now);
          }
        } else if (dx) node.scrollLeft += dx;
        if (dy) node.scrollTop += dy;
        moved ||= node.scrollLeft !== left || node.scrollTop !== top;
      }
      const dy = edgeSpeed(y, 0, window.innerHeight);
      if (dy) {
        const top = window.scrollY;
        window.scrollBy(0, dy);
        moved ||= window.scrollY !== top;
      }
      if (moved) track();
      frame = requestAnimationFrame(scroll);
    };
    const lift = () => {
      unpress();
      scale = scaleNow = zoom();
      const box = element.getBoundingClientRect(); // screen-px: the pointer's offset in it, in the pointer's own pixels
      offset = { x: gesture.x0 - box.left, y: gesture.y0 - box.top };
      /* Every reading before the first write: a style read after one would lay the whole page out again, and the
         lift is the frame a hand feels. */
      scrollers = scrollersOf(element);
      const snapped = scrollers.filter((node) => {
        const snap = getComputedStyle(node).scrollSnapType;
        return Boolean(snap) && !snap.startsWith('none');
      });
      ghost = copyOf(element, scale);
      for (const node of snapped) {
        unsnapped.set(node, node.style.scrollSnapType);
        node.style.scrollSnapType = 'none';
      }
      element.setAttribute('data-lifted', '');
      origin.setAttribute('data-drag-origin', '');
      window.getSelection()?.removeAllRanges();
      fingerDragging = gesture.touch;
      setDragging(() => item);
      frame = requestAnimationFrame(scroll);
    };
    const apply = ([next, effect]: [Gesture, GestureEffect]) => {
      gesture = next;
      if (effect === 'abandon') {
        stop();
        return;
      }
      if (effect === 'lift') lift();
      if (effect === 'lift' || effect === 'move') track();
    };

    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      x = e.clientX;
      y = e.clientY;
      apply(moveGesture(gesture, x, y, performance.now()));
    };
    const onUp = (e: PointerEvent) => {
      if (e.pointerId !== pointer) return;
      x = e.clientX;
      y = e.clientY;
      if (endGesture(gesture) !== 'drop') {
        stop();
        return;
      }
      const at = hit(x, y);
      /* Where every slid item is seen now, before the drop is drawn: what moved on its own is carried from there. */
      const seen = new Map([...slid].map((node) => [node, node.getBoundingClientRect().top] as const)); // screen-px: compared after the redraw, divided by the zoom
      const copy = stop(true);
      /* The press ends in a click on whatever it was let go over; a drop is not a click. */
      const swallow = (click: MouseEvent) => {
        click.preventDefault();
        click.stopPropagation();
      };
      addHostListener(window, 'click', swallow, true);
      setTimeout(() => removeHostListener(window, 'click', swallow, true), 0);
      latest.current.drop(item, at);
      latest.current.end?.(item);
      /* Only a host that says where the item now stands is settled into it; any other draws its move after this
         returns, and the copy goes at once, as it always has. */
      const locate = latest.current.locate;
      settle(copy, locate ? locate(item) : null, seen);
    };
    const onCancel = (e: PointerEvent) => {
      if (e.pointerId === pointer) putBack();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      /* Escape puts the item back, and closes nothing else while it does. */
      if (ghost) {
        e.preventDefault();
        e.stopPropagation();
      }
      putBack();
    };
    /* A long press is the drag's, not the browser's menu; an image or a link inside is not the browser's to drag. */
    const onMenu = (e: Event) => {
      if (gesture.touch) e.preventDefault();
    };
    const onNativeDrag = (e: Event) => e.preventDefault();
    /* A drag selects nothing on its way: a selection about to start is refused, rather than every element restyled. */
    const onSelect = (e: Event) => {
      if (ghost) e.preventDefault();
    };
    const timer = gesture.touch ? window.setTimeout(() => apply(holdGesture(gesture, performance.now())), TOUCH_HOLD_MS) : 0;
    /* A finger held on text is, to the browser, the start of a selection —
       and a selection takes the pointer back (pointercancel) — so while a
       finger presses, nothing on the page is selectable. Only then: a mouse
       still selects a row's text. */
    if (gesture.touch) shellRoot().classList.add('is-pressing');
    /* The hold says it is taking: the item gives a little under the finger, as any press lands (0.97 over the
       house's press, motion rule 12 — not drawn out over the hold, which would break the 300ms ceiling), so a press
       that will lift is seen to be one before it does. Nothing under reduced motion, where the lift itself says it. */
    let pressed = false;
    if (gesture.touch && motion) {
      pressed = true;
      element.style.transition = `scale ${SLIDE}`;
      requestAnimationFrame(() => {
        if (pressed) element.style.scale = '0.97';
      });
    }
    function unpress() {
      if (!pressed) return;
      pressed = false;
      element.style.removeProperty('scale');
      element.style.removeProperty('transition');
    }

    const listeners: Array<[string, EventListener, boolean]> = [
      ['pointermove', onMove as EventListener, false],
      ['pointerup', onUp as EventListener, false],
      ['pointercancel', onCancel as EventListener, false],
      ['keydown', onKey as EventListener, true],
      ['contextmenu', onMenu, true],
      ['dragstart', onNativeDrag, true],
      ['selectstart', onSelect, true],
      ['blur', () => putBack(), false],
    ];
    for (const [type, listener, capture] of listeners) addHostListener(window, type, listener, capture);
    /* The gesture's end: everything it set on the page taken back. The copy is handed on to settle when `keep` asks. */
    function stop(keep = false): HTMLElement | null {
      window.clearTimeout(timer);
      cancelAnimationFrame(frame);
      unpress();
      for (const [type, listener, capture] of listeners) removeHostListener(window, type, listener, capture);
      const copy = ghost;
      ghost = null;
      if (!keep) copy?.remove();
      unslide();
      for (const [node, snap] of unsnapped) node.style.scrollSnapType = snap;
      unsnapped.clear();
      if (!keep) element.removeAttribute('data-lifted');
      origin.removeAttribute('data-drag-origin');
      shellRoot().classList.remove('is-pressing');
      fingerDragging = false;
      active = own.current = null;
      if (copy) setDragging(null);
      return copy;
    }
    /* The copy goes to where the item now stands, and what slid on its own is carried from where it was seen to its
       new place: the move is drawn already (the host's drop), so this only says where it went. Instant under reduced
       motion; never waited on — a press meanwhile finds the finished page. */
    function settle(copy: HTMLElement | null, target: HTMLElement | null, seen: Map<HTMLElement, number>) {
      const lifted = element;
      if (!copy) {
        lifted.removeAttribute('data-lifted');
        return;
      }
      const done = () => {
        copy.remove();
        lifted.removeAttribute('data-lifted');
        if (target) target.style.removeProperty('opacity');
      };
      /* A target with no box (hidden, or a page not laid out) has nowhere to be settled into. */
      const box = target?.isConnected ? target.getBoundingClientRect() : null; // screen-px: the copy is placed in layout pixels
      if (!motion || !target || !box || (box.width === 0 && box.height === 0)) {
        done();
        return;
      }
      for (const [node, top] of seen) {
        if (!node.isConnected || node === origin || node.contains(target)) continue;
        const by = (top - node.getBoundingClientRect().top) / scale; // screen-px: into the layout pixels a transform takes
        if (Math.abs(by) < 0.5) continue;
        node.style.transition = 'none';
        node.style.translate = along(by);
        requestAnimationFrame(() => {
          node.style.transition = `translate ${SLIDE}`;
          node.style.translate = '';
          setTimeout(() => node.style.removeProperty('transition'), pressMs() + 50);
        });
      }
      target.style.opacity = '0';
      copy.style.transition = `transform ${SLIDE}`;
      copy.style.transform = `translate(${box.left / scale}px, ${box.top / scale}px)`;
      setTimeout(done, pressMs() + 20);
    }
    function putBack() {
      const copy = stop(true);
      if (copy) {
        settle(copy, element.isConnected ? element : null, new Map());
        latest.current.end?.(item);
      } else element.removeAttribute('data-lifted');
    }
    active = own.current = { cancel: putBack };
  };

  /** The props that make an element a drag source for `item`: nothing where it may not move. */
  const source = (item: T, enabled: boolean) =>
    enabled
      ? { 'data-draggable': 'true', onPointerDown: (event: ReactPointerEvent<HTMLElement>) => start(event, item, event.currentTarget) }
      : {};
  return { source, start, dragging };
}
