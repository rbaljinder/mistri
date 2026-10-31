/**
 * A navigation swaps finished screens (docs/design.md, motion rule 9).
 *
 * Every paint that starts a room over used to take the room it left off the
 * screen at once and draw the new one as its answers came in: an empty pane
 * for a frame, then a skeleton, then the header, the sections, the aside and
 * the related lists one by one, each pushing the next down. Measured on
 * Compass and on the Keystone lender App, list → record painted in four to
 * eight steps over 100–450 ms, with a layout shift at each.
 *
 * So the screen being left is held — a still copy of it, standing where it
 * stood — while the room that replaces it is drawn underneath, laid out but
 * not shown, and asks for what it needs. When nothing asked since the
 * navigation began is still out (pendingWork.ts, and the room's reads), the
 * copy goes and the new room is there, complete. Most rooms are complete
 * well inside BUDGET ms, and the reader sees one screen replace another.
 * Past it the copy is dimmed, still, so the wait is said without anything
 * moving; and a room still not complete at CAP ms is shown as it stands, its
 * own placeholders saying the rest is coming — a server that slow should not
 * keep the reader looking at a screen they left.
 *
 * The copy is a picture and nothing else: drawn in a closed shadow root,
 * under the page's own stylesheets and a twin of every element the pane
 * stands in, so it looks exactly as the screen did — and no lookup by id,
 * no selector, no test's locator and no assistive technology finds a second
 * record title, a second radio group or a second field in it. The room
 * beneath is the only one there is: laid out and focusable, only not yet
 * painted. Any input — a press, a key, a wheel — ends the hold at once, so
 * nothing waits on it (motion rule 7).
 *
 * A step to a new place starts at the top; Back and Forward return to where
 * the reader was on that screen; a refinement of the place on screen (a
 * sort, a tab, a write that repaints) keeps the scroll it had. A step to a
 * new place taken with the pointer may enter with 160 ms of opacity and a
 * few pixels of settle, once the screen is complete; a key, a refinement or
 * Back animates nothing, and reduced motion silences the enter in the
 * stylesheet.
 */
import { motionStill } from './motionStill.js';
import { workMark, workSince } from './pendingWork.js';
import { addHostListener, onNavigate, shellRoot } from './shellHost.js';
import { herePath, hereSearch } from './addressMount.js';

/** How long a navigation holds the screen it left without saying so, in ms. */
export const BUDGET = 300;
/** The longest it holds it at all, in ms. */
export const CAP = 1500;
/* Quiet frames, counted from the frame after the paint: a Query that answers
   enables the next one in the render after it, and React draws that render
   in slices between frames, so a frame or two with nothing out can sit
   between two asks. Anything drawn into the room counts as not quiet. */
const QUIET_FRAMES = 3;
/* Scroll positions to return to, by address; bounded, as a walk is. */
const REMEMBERED = 100;
const ENTER_CLASS = 'nav-enter';

interface Place {
  kind?: string;
  table?: string;
  pageId?: string;
  key?: unknown;
  view?: string;
}

interface Hold {
  copy: HTMLElement;
  picture: HTMLElement;
  mark: number;
  timers: Array<ReturnType<typeof setTimeout>>;
  frame: number;
  quiet: number;
  scroll: 'top' | 'keep' | 'restore';
  enter: boolean;
}

/** What else says a room is still arriving: its reads (TanStack Query), which may wait on more than a request. */
interface HoldProbe {
  /** Whether a read is running now. */
  busy(): boolean;
  /** Told of every change to any read; returns the way to stop listening. */
  watch(changed: () => void): () => void;
}

let content: HTMLElement | null = null;
let probe: HoldProbe = { busy: () => false, watch: () => () => {} };
let stirred = false;
let hold: Hold | null = null;
let shown: { entry: unknown; place: string; depth: number; address: string } | null = null;
/* When the last Back or Forward came. A traversal the shell refuses (a
   change still pending) paints nothing, so the mark is read only by a paint
   that follows it closely, and only once. */
let traversedAt = -Infinity;
const TRAVERSAL_WINDOW = 1000;
let lastInput: { pointer: boolean; at: number; target?: EventTarget | null } = { pointer: false, at: 0 };
const scrollAt = new Map<string, number>();
let restoring: { top: number; until: number } | null = null;

const address = () => herePath() + hereSearch();
const placeOf = (entry: Place | undefined): string =>
  entry ? JSON.stringify([entry.kind, entry.table, entry.pageId, entry.view, entry.key ?? null]) : '';
/* Whether the entry names another thing altogether, not another look at this one. */
const sameThing = (a: Place | undefined, b: Place | undefined) =>
  (a?.kind ?? '') === (b?.kind ?? '') && (a?.table ?? '') === (b?.table ?? '') && (a?.pageId ?? '') === (b?.pageId ?? '');

/**
 * Start listening. Once, from the shell: Back and Forward are told apart from
 * a click by the `popstate` that precedes their paint, and the hold ends on
 * the reader's first input.
 */
export function installNavigationHold(host: HTMLElement, reads?: HoldProbe): void {
  const first = content === null;
  content = host;
  if (!first) return;
  if (reads) probe = reads;
  /* A read that answers enables the next in the render after it, with
     nothing out between the two: any change to a read starts the quiet
     count again. */
  probe.watch(() => {
    if (hold) stirred = true;
  });
  /* And a room still drawing itself is still arriving: a commit into the pane
     (not the picture, whose own drawing is in its shadow root) stirs too. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver((records) => {
      if (hold && records.some((record) => record.target !== hold!.copy)) stirred = true;
    }).observe(host, { childList: true, subtree: true, characterData: true, attributes: true });
  }
  /* Registered before the shell's own listener, which paints: the mark is set when the paint comes. */
  onNavigate(() => {
    traversedAt = performance.now();
  }, true);
  /* The page's stylesheets, read for the picture before the first navigation
     needs them — when the page is idle, so starting up never waits on it. */
  const warm = () => {
    mirrorSheets();
  };
  if (typeof requestIdleCallback === 'function') requestIdleCallback(warm, { timeout: 3000 });
  else setTimeout(warm, 1000);
  /* And each one a part brings when it loads, as it arrives. The published
     client links a part's stylesheet when the part is first drawn (a record's
     sections, the related lists); read only at the next navigation, it was
     still on its way then, and that navigation went unheld — the related
     record painted into an empty pane. Under Vite every sheet is a style
     element, whose text is there at once, so only the bundle showed it. */
  if (typeof MutationObserver === 'function') {
    new MutationObserver((records) => {
      for (const record of records)
        for (const node of Array.from(record.addedNodes)) {
          if (!(node instanceof HTMLLinkElement) || !/\bstylesheet\b/i.test(node.rel) || !node.href) continue;
          if (node.sheet) readLinked(node.href);
          else node.addEventListener('load', () => readLinked(node.href), { once: true });
        }
    }).observe(document.head, { childList: true });
  }
  const input = (pointer: boolean) => (event: Event) => {
    lastInput = { pointer, at: performance.now(), target: event.target };
    if (hold) release();
    restoring = null;
  };
  addHostListener(window, 'pointerdown', input(true), true);
  addHostListener(window, 'keydown', input(false), true);
  const moved = () => {
    if (hold) release();
    restoring = null;
  };
  addHostListener(window, 'wheel', moved, { capture: true, passive: true });
  addHostListener(window, 'touchmove', moved, { capture: true, passive: true });
}

/**
 * Before a paint: hold the screen on show when the paint starts the room over.
 * `room` is whether the room is new; `entry` and `depth` are the walk's top
 * entry and length as the paint will draw them.
 */
export function beforePaint(room: boolean, entry: Place | undefined, depth: number): void {
  const pane = content;
  const traversal = performance.now() - traversedAt < TRAVERSAL_WINDOW;
  traversedAt = -Infinity;
  if (!pane || !pane.isConnected || !shown) return;
  if (!hold) scrollAt.set(shown.address, pane.scrollTop);
  if (scrollAt.size > REMEMBERED) scrollAt.delete(scrollAt.keys().next().value!);
  if (!room) return;
  const again = entry === shown.entry;
  const scroll: Hold['scroll'] = traversal ? 'restore' : again || placeOf(entry) === shown.place ? 'keep' : 'top';
  if (hold) {
    /* A room that redirects as it opens (a bare list to its first tab, a row
       to its page) is still the same navigation: the copy stays, the budget
       runs on, and a step it began is not undone by a replace it made. */
    if (hold.scroll === 'keep') hold.scroll = scroll;
    return;
  }
  if (!pane.firstElementChild) return;
  const recent = performance.now() - lastInput.at < 1000;
  const enter =
    !traversal &&
    !again &&
    lastInput.pointer &&
    recent &&
    !motionStill() &&
    (!sameThing(entry, shown.entry as Place | undefined) || depth !== shown.depth);
  /* The focus leaves the room it stands in now, while nothing on the page waits to be restyled. Taken away with the
     room, it went in the middle of the paint, and Chrome brought the whole pane's style up to date to let it go: the
     picture and the room being left, restyled only to be removed, 60 ms of a tab's click on the vitals' slowed CPU.
     The blur is the one removal sends (Chrome sends it), sent first; the room puts the focus back where it belongs.
     Only where the focus is what was just clicked: a search narrowing the list as it is typed into a rail's box,
     arriving while the pointer goes down on one of the box's suggestions, leaves the focus in the box, which the
     suggestion still needs. */
  const focused = document.activeElement;
  if (
    lastInput.pointer &&
    recent &&
    focused &&
    pane.contains(focused) &&
    lastInput.target instanceof Node &&
    focused.contains(lastInput.target)
  )
    (focused as HTMLElement).blur();
  const made = picture(pane);
  /* Nothing to draw the picture with (no constructable stylesheets): the paint is only a paint, as it was. */
  if (!made) return;
  const { copy } = made;
  pane.append(copy);
  /* Written only where there is a scroll to copy: writing it lays the whole
     picture out inside the click, before the room's own render, and a
     screen left at its top — most of them — has nothing to copy. */
  if (made.scrolled) made.picture.scrollTop = made.scrolled;
  /* A room reached from the keyboard, or a refinement of the room on screen,
     puts the focus back where the reader's hands are (a tab, a filter, the
     first row) the moment it is drawn: under the picture it is transparent,
     so it can take it. A step to a new place taken with the pointer, and Back,
     move no focus into the room, and there it is hidden outright, so nothing
     it does while arriving is a layout shift. */
  const focusable = !traversal && (scroll === 'keep' || (recent && !lastInput.pointer));
  pane.classList.add('nav-holding');
  pane.classList.toggle('nav-holding-focusable', focusable);
  pane.classList.remove(ENTER_CLASS);
  hold = {
    copy,
    picture: made.picture,
    mark: workMark(),
    quiet: 0,
    frame: 0,
    scroll,
    enter,
    timers: [
      setTimeout(() => {
        copy.classList.add('nav-held-waiting');
        pane.setAttribute('aria-busy', 'true');
      }, BUDGET),
      setTimeout(release, CAP),
    ],
  };
}

/** After the paint: the address is the new one; start watching for the room to be complete. */
export function afterPaint(entry: Place | undefined, depth: number): void {
  shown = { entry, place: placeOf(entry), depth, address: address() };
  if (!hold) return;
  hold.quiet = 0;
  /* The frame this paint lands in is not counted: the room's effects, which
     ask for what it needs, run after it. */
  if (!hold.frame)
    hold.frame = requestAnimationFrame(() => {
      if (hold) hold.frame = requestAnimationFrame(watch);
    });
}

function watch(): void {
  if (!hold) return;
  const busy = stirred || workSince(hold.mark) || probe.busy();
  stirred = false;
  hold.quiet = busy ? 0 : hold.quiet + 1;
  if (hold.quiet >= QUIET_FRAMES) {
    release();
    return;
  }
  hold.frame = requestAnimationFrame(watch);
}

/** The room underneath is shown, and the copy of the one it replaced goes. */
function release(): void {
  const ending = hold;
  if (!ending) return;
  hold = null;
  ending.timers.forEach(clearTimeout);
  if (ending.frame) cancelAnimationFrame(ending.frame);
  const pane = content;
  ending.copy.remove();
  if (!pane) return;
  pane.classList.remove('nav-holding', 'nav-holding-focusable');
  pane.removeAttribute('aria-busy');
  if (ending.scroll === 'top') pane.scrollTop = 0;
  else if (ending.scroll === 'restore') restoreScroll(pane, scrollAt.get(address()) ?? 0);
  if (ending.enter) {
    pane.classList.add(ENTER_CLASS);
    /* Off again once it has run, so nothing is left transformed under a popup. */
    setTimeout(() => pane.classList.remove(ENTER_CLASS), 400);
  }
}

/**
 * Back to where the reader was. A room past its budget may still be growing
 * toward that point, so the position is asked again each frame for a moment,
 * until it can be reached or the reader moves.
 */
function restoreScroll(pane: HTMLElement, top: number): void {
  pane.scrollTop = top;
  if (pane.scrollTop >= top - 1) {
    restoring = null;
    return;
  }
  restoring = { top, until: performance.now() + 1500 };
  const again = () => {
    if (!restoring || performance.now() > restoring.until) {
      restoring = null;
      return;
    }
    pane.scrollTop = restoring.top;
    if (pane.scrollTop >= restoring.top - 1) {
      restoring = null;
      return;
    }
    requestAnimationFrame(again);
  };
  requestAnimationFrame(again);
}

/* ---------- the picture ---------- */

/* The page's stylesheets, one constructed twin of each, for the picture's
   shadow root to adopt. Read from each sheet's source — a style element's
   text, a linked file's — because the CSS object model does not give it
   back whole: Chrome serializes `font: 500 12px/1.5 var(--sans)` followed by
   a `font-variant-numeric` as nothing at all, and the picture's list count
   came out in the wrong weight and size. `:root` is read as the root's twin,
   by a class of the same weight (as `html` it weighed less than a
   pseudo-class and lost rules it had won on the page). A sheet switched off
   is left out and a sheet under media keeps it. Another origin's sheet is
   left out: it can only hold font faces, and those are the document's. The
   twins of the pane's ancestors draw no box — they are there for the
   selectors (`body.app-mode .content`, a look's `[data-visual-theme]`) and
   for what inherits — and the root's zoom is not applied twice. */
const TWIN = 'nav-held-twin';
const ROOT_TWIN = 'nav-held-root';
const built = new WeakMap<CSSStyleSheet, { text: string; media: string; sheet: CSSStyleSheet }>();
/* A linked sheet's text: undefined while it is read, null for one that cannot be (another origin's). */
const linked = new Map<string, string | null | undefined>();
let twins: CSSStyleSheet | null = null;

function readLinked(href: string): void {
  if (linked.has(href)) return;
  let url: URL;
  try {
    url = new URL(href, document.baseURI);
  } catch {
    linked.set(href, null);
    return;
  }
  if (url.origin !== window.location.origin) {
    linked.set(href, null);
    return;
  }
  linked.set(href, undefined);
  /* The file the page already loaded, asked for as the page asked for it (a
     server that answers a script to a plain fetch of a stylesheet — Vite's,
     under development — answers the stylesheet): the cache answers. */
  void fetch(url, { credentials: 'same-origin', headers: { accept: 'text/css,*/*;q=0.1' } })
    .then(
      (reply) => (reply.ok ? reply.text() : null),
      () => null,
    )
    .then((text) => {
      linked.set(href, text);
      /* And its twin built now, while nothing waits: left to the next navigation, the App's own sheet (390 KB),
         still on its way when the page was first idle, was built in the click that opened a record or a tab, 35 ms
         of it on the vitals' slowed CPU (test/built-client-vitals.mjs). */
      mirrorSheets();
    });
}

/** A sheet's own text, null to leave it out, or undefined while it is still being read. */
function sourceOf(sheet: CSSStyleSheet): string | null | undefined {
  const owner = sheet.ownerNode;
  if (owner instanceof HTMLStyleElement) return owner.textContent ?? '';
  if (!sheet.href) return null;
  if (!linked.has(sheet.href)) readLinked(sheet.href);
  return linked.get(sheet.href);
}

function mirrorSheets(): CSSStyleSheet[] | null {
  try {
    const sheets: CSSStyleSheet[] = [];
    let unread = false;
    for (const sheet of Array.from(document.styleSheets)) {
      if (sheet.disabled) continue;
      const text = sourceOf(sheet);
      if (text === undefined) {
        unread = true;
        continue;
      }
      if (text === null) continue;
      const media = sheet.media?.mediaText ?? '';
      let twin = built.get(sheet);
      if (!twin || twin.text !== text || twin.media !== media) {
        const made = new CSSStyleSheet({ baseURL: sheet.href ?? document.baseURI, ...(media ? { media } : {}) });
        made.replaceSync(text.replace(/:root\b/g, `.${ROOT_TWIN}`));
        twin = { text, media, sheet: made };
        built.set(sheet, twin);
      }
      sheets.push(twin.sheet);
    }
    /* A sheet not read yet would draw a picture that differs from the screen: this navigation goes unheld. */
    if (unread) return null;
    if (!twins) {
      twins = new CSSStyleSheet();
      twins.replaceSync(`.${TWIN}{display:contents!important;zoom:1!important}`);
    }
    return [...sheets, ...(document.adoptedStyleSheets ?? []), twins];
  } catch {
    return null;
  }
}

/**
 * The picture of the pane as it stands: a host in the pane's scroll content,
 * over exactly the part the reader sees, holding in a closed shadow root a
 * twin of every ancestor, the pane's own twin scrolled to where the pane is,
 * and a still copy of what the pane holds.
 */
function picture(pane: HTMLElement): { copy: HTMLElement; picture: HTMLElement; scrolled: number } | null {
  const sheets = mirrorSheets();
  if (!sheets || typeof pane.attachShadow !== 'function') return null;
  const copy = document.createElement('div');
  copy.className = 'nav-held';
  copy.setAttribute('aria-hidden', 'true');
  copy.inert = true;
  /* Scroll offsets and a pane's client height are layout pixels, the ruler `top` speaks. */
  copy.style.top = `${pane.scrollTop}px`;
  copy.style.height = `${pane.clientHeight}px`;
  const root = copy.attachShadow({ mode: 'closed' });
  try {
    root.adoptedStyleSheets = sheets;
  } catch {
    return null;
  }
  let inner: ParentNode = root;
  const chain: Element[] = [];
  for (let at = pane.parentElement; at; at = at.parentElement) chain.unshift(at);
  for (const ancestor of chain) {
    const twin = document.createElement(ancestor.tagName.toLowerCase());
    for (const { name, value } of Array.from(ancestor.attributes)) twin.setAttribute(name, value);
    twin.classList.add(TWIN);
    if (ancestor === shellRoot()) twin.classList.add(ROOT_TWIN);
    inner.append(twin);
    inner = twin;
  }
  const twin = pane.cloneNode(false) as HTMLElement;
  twin.classList.remove('nav-holding', ENTER_CLASS);
  twin.removeAttribute('aria-busy');
  twin.style.height = '100%';
  twin.style.overflow = 'hidden';
  for (const child of Array.from(pane.children)) {
    if (child instanceof HTMLElement && !child.classList.contains('nav-held')) twin.append(still(child));
  }
  inner.append(twin);
  return { copy, picture: twin, scrolled: pane.scrollTop };
}

/**
 * A still copy of a part of the screen: what it looks like, and nothing it
 * does. The names of form controls go (a radio copied into the picture must
 * not join a group), and so does autofocus; a canvas is copied as its
 * picture, and a field as the value typed into it.
 */
function still(node: HTMLElement): HTMLElement {
  const copy = node.cloneNode(true) as HTMLElement;
  for (const element of [copy, ...Array.from(copy.querySelectorAll<HTMLElement>('[name], [autofocus]'))]) {
    element.removeAttribute('name');
    element.removeAttribute('autofocus');
  }
  const from = node.querySelectorAll('canvas');
  if (from.length) {
    const to = copy.querySelectorAll('canvas');
    from.forEach((canvas, i) => {
      try {
        to[i]?.getContext('2d')?.drawImage(canvas, 0, 0);
      } catch {
        /* A tainted or empty canvas is left blank. */
      }
    });
  }
  /* Values typed into fields are state, not attributes: carried over so the picture matches. */
  const fields = node.querySelectorAll('input, textarea, select');
  if (fields.length) {
    const copies = copy.querySelectorAll('input, textarea, select');
    fields.forEach((field, i) => {
      const twin = copies[i] as HTMLInputElement | undefined;
      if (!twin) return;
      if (field instanceof HTMLInputElement && (field.type === 'checkbox' || field.type === 'radio')) twin.checked = field.checked;
      else twin.value = (field as HTMLInputElement).value;
    });
  }
  return copy;
}

/** Whether a navigation is holding the screen it left; for tests and the shell. */
export const holding = (): boolean => hold !== null;
/** The picture being held, which only its shadow root reaches; for tests. */
export const heldPicture = (): HTMLElement | null => hold?.picture ?? null;
