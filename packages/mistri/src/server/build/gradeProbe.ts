/**
 * What `mistri grade` reads off a drawn page, measured in the page itself.
 *
 * Every function here but `watchEvents` runs in the browser: it is sent as its source text, so it
 * may use nothing from this module's scope — no import, no constant above it —
 * only the DOM and its own argument. Under tsx a function's source carries
 * esbuild's `__name(…)` wrappers, which the page does not define, so it goes
 * through `inPage`, which defines one, rather than Playwright's own
 * serialization (the reason shot.ts's evaluations are single arrow functions).
 *
 * The probe only measures. Whether a measurement is a finding — a tick that is
 * not round, two number formats in one column — is judged in grade.ts, in Node,
 * where it can be unit-tested without a browser.
 */

import type { Page } from 'playwright-core';

/** A function sent to the page as source, with the helper tsx's output calls. */
export const inPage = <A>(fn: (argument: A) => unknown, argument: A): string =>
  `(() => { const __name = (target) => target; return (${fn.toString()})(${JSON.stringify(argument)}); })()`;

/** One reading of a color against what is drawn under it: what, the ratio, and the ratio the rule asks for. */
export interface ContrastReading {
  what: string;
  ratio: number;
  need: number;
  /** The two colors measured, as drawn (`#rrggbb`, the words composited on their ground): what grade names a theme's token by. */
  fg?: string;
  bg?: string;
}

/**
 * What a reader reads, measured where it is drawn (WCAG 1.4.3): every status
 * word and every avatar's initials on their own tint, a filled tab's count,
 * a calendar's dates and the list's filter placeholders, at 4.5:1; and what a
 * reader finds a field by (1.4.11): its edge, on the field and on what the
 * field sits on, at 3:1. The colors are composited the way the page paints
 * them, so a tint over a tint is read as one. `states` adds states a spec puts
 * the page in — a hover, a press, an error — as [selector, need] pairs; each
 * must match something drawn, so a renamed selector cannot pass by matching
 * nothing. `text` also reads every other run of text on a plain ground, at
 * 4.5:1, or 3:1 where it is large (24px, or 18.66px bold): what grade asks of
 * a whole page, where the theme suite asks of the parts every look dresses.
 *
 * Shared by e2e/support/contrast.ts and grade, so the browser suite and the
 * grader hold a page to one rule.
 */
export function contrastReadings(input: { states: ReadonlyArray<readonly [string, number]>; text?: boolean }): ContrastReading[] {
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string) => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = 'rgba(0,0,0,0)';
    pen.fillStyle = css;
    pen.fillRect(0, 0, 1, 1);
    const d = pen.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const over = (top: number[], under: number[]) => [0, 1, 2].map((i) => top[i]! * top[3]! + under[i]! * (1 - top[3]!)).concat(1);
  const ground = (el: Element) => {
    const layers: number[][] = [];
    for (let e: Element | null = el; e; e = e.parentElement) {
      const c = rgba(getComputedStyle(e).backgroundColor);
      if (c[3]) layers.push(c);
      if (c[3] === 1) break;
    }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]);
  };
  const lum = (c: number[]) => {
    const [r, g, b] = c.slice(0, 3).map((v) => {
      v /= 255;
      return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const hex = (c: number[]) =>
    `#${c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('')}`;
  /* The ratio, and the two colors it is between: grade names the theme's token a color is. */
  const measure = (el: Element, color: string) => {
    const bg = ground(el),
      fg = over(rgba(color), bg);
    const [a, b] = [lum(fg), lum(bg)];
    return { ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100, fg: hex(fg), bg: hex(bg) };
  };
  // What is drawn: a list also keeps its phone summaries, hidden, beside the grid.
  const WORDS =
    '.tone, .avatar, .tab[aria-selected="true"], .tab[aria-selected="true"] .tab-count, .app-mode .topbar .tn-group.active > .tn-group-button, .calendar-date';
  const words = [...document.querySelectorAll(WORDS)]
    .filter((el) => el.checkVisibility())
    .map((el) => ({
      what: `${el.className} "${el.textContent}"`,
      ...measure(el, getComputedStyle(el).color),
      need: 4.5,
    }));
  const hints = [...document.querySelectorAll<HTMLInputElement>('input[placeholder]')]
    .filter((el) => el.offsetParent && !el.value)
    .map((el) => ({
      what: `placeholder "${el.placeholder}"`,
      ...measure(el, getComputedStyle(el, '::placeholder').color),
      need: 4.5,
    }));
  /* Every field: a text box, a Select's button, a picker. A checkbox or a
     radio is the browser's own; a border drawn transparent is no edge (a
     title's picker, a focused field whose ring stands in for it). */
  const edges = [
    ...document.querySelectorAll<HTMLElement>(
      'input:not([type="checkbox"], [type="radio"], [type="hidden"]), textarea, select, .dd-button, .picker',
    ),
  ]
    .filter(
      (el) =>
        el.checkVisibility() && parseFloat(getComputedStyle(el).borderTopWidth) > 0 && rgba(getComputedStyle(el).borderTopColor)[3]! > 0,
    )
    .map((el) => {
      const edge = getComputedStyle(el).borderTopColor;
      const inside = measure(el, edge),
        outside = measure(el.parentElement!, edge);
      return {
        what: `edge of ${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}.${el.className}`,
        ...(outside.ratio < inside.ratio ? outside : inside),
        need: 3,
      };
    });
  const extra = input.states.flatMap(([selector, need]) => {
    const drawn = [...document.querySelectorAll(selector)].filter((el) => el.checkVisibility());
    if (!drawn.length) return [{ what: `nothing drawn for ${selector}`, ratio: 0, need }];
    return drawn.map((el) => ({
      what: `${selector} "${el.textContent?.trim().slice(0, 40)}"`,
      ...measure(el, getComputedStyle(el).color),
      need,
    }));
  });
  /* Every other element that holds text of its own, once: what the parts above do not reach. A ground painted with
     an image or a gradient is not one color, so it is not read; a disabled control is exempt (1.4.3). */
  const text: ContrastReading[] = [];
  if (input.text) {
    const seen = new Set<Element>(document.querySelectorAll(`${WORDS}, input, textarea, select`));
    const painted = (el: Element) => {
      for (let e: Element | null = el; e; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.backgroundImage !== 'none') return true;
        if (rgba(style.backgroundColor)[3] === 1) return false;
      }
      return false;
    };
    for (const el of document.body.querySelectorAll('*')) {
      if (seen.has(el) || el.closest('svg, [aria-hidden="true"], [disabled], [aria-disabled="true"], .visually-hidden')) continue;
      const own = [...el.childNodes].some((node) => node.nodeType === 3 && node.textContent!.trim());
      if (!own || !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
      const box = el.getBoundingClientRect();
      if (box.width < 1 || box.height < 1 || painted(el)) continue;
      const style = getComputedStyle(el);
      const size = parseFloat(style.fontSize);
      const large = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700);
      /* What opacity does to the whole element is how its words are seen. */
      let alpha = 1;
      for (let e: Element | null = el; e; e = e.parentElement) alpha *= Number(getComputedStyle(e).opacity);
      const [r, g, b, a] = rgba(style.color);
      text.push({
        what: `${el.tagName.toLowerCase()}${typeof el.className === 'string' && el.className ? `.${el.className.split(/\s+/)[0]}` : ''} "${el.textContent!.trim().slice(0, 40)}"`,
        ...measure(el, `rgba(${r}, ${g}, ${b}, ${a! * alpha})`),
        need: large ? 3 : 4.5,
      });
    }
  }
  return [...words, ...hints, ...edges, ...extra, ...text];
}

/** Everything the probe measured on one drawn page, unjudged. */
export interface Probe {
  /** How far the page scrolls sideways past the window, in CSS pixels; 0 when it does not. */
  sideways: number;
  /** Text an element cuts off: what it is, its words, whether it is a figure and whether an ellipsis says so. */
  clipped: Array<{
    what: string;
    text: string;
    numeric: boolean;
    ellipsis: boolean;
  }>;
  /** Pairs of controls drawn over one another. */
  overlaps: Array<{ a: string; b: string }>;
  /** Controls whose target, the largest of their box, a label wrapped round them and a hit area drawn round them, is narrower or shorter than `tap`. */
  small: Array<{ what: string; width: number; height: number }>;
  /** Sections drawn with nothing in them: no words but their heading, no picture, no field. */
  empty: string[];
  /** The figures each surface shows — a table's column, a strip of metrics, a section — by where they stand. */
  figures: Array<{ where: string; values: string[]; column?: boolean }>;
  /** Each chart axis's labels, by chart. */
  axes: Array<{ where: string; ticks: string[] }>;
  /** A record page's name: its words and how many lines it takes. */
  title?: { text: string; lines: number };
  /** The layout shift the page made since it started, as Core Web Vitals counts it (the largest session window). */
  shift: number;
  /** Marks toned by color with no word, name or label beside them (C6). */
  toned?: string[];
  /** Blocks of prose on two lines or more, by their characters a line (C8). */
  measures?: Array<{ what: string; chars: number }>;
  /** Parts moving or set to move: how long, whether they loop, and whether reduced motion was asked for (C9). */
  motion?: Array<{ what: string; ms: number; loops: boolean; reduced: boolean }>;
  /** Each stop the Tab key reached: its ring's width and contrast on its ground, and whether its look changed
      otherwise (C3). Measured from Node, which presses the keys. */
  focus?: Array<{ what: string; width: number; ratio?: number; changed: boolean }>;
  /** Contrast readings with the page printed (C12). */
  print?: ContrastReading[];
  /** The bytes of the theme's own faces and logo on a cold visit (C11). */
  themeBytes?: number;
  /** The first line where the accessibility tree differs from the App's own look's (C13). */
  changed?: string;
  /** Every vertical scroll container in the room that is not a deliberate one: the room's own pane, plus any
      second box that scrolls the same way. One is the policy; two are a finding. */
  scrolls?: string[];
}

/**
 * Installed before the page's own scripts (Playwright's addInitScript): every layout shift not caused by input,
 * gathered into session windows — shifts less than a second apart, a window at most five seconds — as CLS is.
 */
export function watchShifts(): void {
  const page = globalThis as unknown as {
    __twShift?: { windows: number[]; last: number; start: number };
  };
  page.__twShift = { windows: [0], last: -Infinity, start: -Infinity };
  try {
    new PerformanceObserver((list) => {
      const state = page.__twShift!;
      for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean }>) {
        if (entry.hadRecentInput) continue;
        if (entry.startTime - state.last > 1000 || entry.startTime - state.start > 5000) {
          state.windows.push(0);
          state.start = entry.startTime;
        }
        state.windows[state.windows.length - 1] += entry.value;
        state.last = entry.startTime;
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* a browser without layout-shift entries measures none */
  }
}

/** The page measured, once it has settled. `tap` is the smallest target asked for, or 0 where none is (a desk). */
export function probePage(input: { tap: number; record: boolean }): Probe {
  const view = {
    width: document.documentElement.clientWidth,
    height: window.innerHeight,
  };
  const say = (el: Element) => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
    const kind = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${kind}${label ? ` "${label}"` : ''}`;
  };
  /* Drawn for the eye: not hidden, not for a screen reader alone (a visually hidden heading is clipped to a pixel on purpose). */
  const shown = (el: Element) =>
    el.checkVisibility({ opacityProperty: true, visibilityProperty: true }) &&
    !el.closest('[aria-hidden="true"], .visually-hidden, .sr-only') &&
    getComputedStyle(el).clipPath !== 'inset(50%)';
  /* The part of a box a reader can see: cut by every ancestor that clips, and by the window. */
  const seen = (el: Element) => {
    const box = el.getBoundingClientRect();
    let [left, top, right, bottom] = [box.left, box.top, box.right, box.bottom];
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
      const clip = e.getBoundingClientRect();
      left = Math.max(left, clip.left);
      top = Math.max(top, clip.top);
      right = Math.min(right, clip.right);
      bottom = Math.min(bottom, clip.bottom);
    }
    left = Math.max(left, 0);
    top = Math.max(top, 0);
    right = Math.min(right, view.width);
    bottom = Math.min(bottom, view.height);
    return right - left > 0 && bottom - top > 0 ? { left, top, right, bottom } : undefined;
  };
  /* A figure as a table or a metric says one: a sign, a currency, digits grouped or not, decimals, a suffix. */
  const FIGURE = /^[-−+]?\s?[$€£¥₹]?\s?\d[\d,.  ']*\s?(%|[kKMB]|bn)?$/;
  const figure = (text: string) => FIGURE.test(text.trim()) && /\d/.test(text);

  // Sideways scroll: the document wider than its window.
  const sideways = Math.max(0, document.documentElement.scrollWidth - view.width, document.body.scrollWidth - view.width);

  /* Vertical scroll containers in the room: one is the room's own pane.
     A second box scrolling the same way is the double scrollbar the
     policy forbids (docs/design.md, Standing layout rules). Deliberate
     ones say so with `data-scrolls` — a board's lanes, a heat map past
     its cells' floor, a conversation timeline in its own box — and
     overlays (a dialog, a menu, a listbox, a glance panel) scroll
     inside themselves, so neither counts here. */
  const room = document.querySelector('#content, .content, .page-body, .public-page') ?? document.body;
  const inOverlay = (el: Element) => {
    for (let e: Element | null = el; e && e !== room; e = e.parentElement) {
      if (e.closest('[role="dialog"], [role="menu"], [role="listbox"], .peekpanel')) return true;
      if (getComputedStyle(e).position === 'fixed') return true;
    }
    return false;
  };
  const scrolls: string[] = [];
  /* The room's own pane counts first: it is itself a scroller, and a pane
     with one inner scroller is the double scrollbar the policy forbids —
     counting only what is inside it never reported that main case. */
  if (room !== document.body && room instanceof HTMLElement && shown(room) && !room.closest('[data-scrolls]')) {
    const style = getComputedStyle(room);
    if (
      (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
      room.clientHeight !== 0 &&
      room.scrollHeight - room.clientHeight > 1
    )
      scrolls.push(say(room));
  }
  for (const el of room.querySelectorAll('*')) {
    if (!(el instanceof HTMLElement) || !shown(el)) continue;
    if (el.closest('[data-scrolls]') || inOverlay(el)) continue;
    const style = getComputedStyle(el);
    if (style.overflowY !== 'auto' && style.overflowY !== 'scroll') continue;
    if (el.clientHeight === 0 || el.scrollHeight - el.clientHeight <= 1) continue;
    scrolls.push(say(el));
  }

  // Clipped text: an element whose own words run past its box, where the box hides the rest.
  const clipped: Probe['clipped'] = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (el.closest('svg, input, textarea, select, [contenteditable]')) continue;
    const words = [...el.childNodes]
      .filter((node) => node.nodeType === 3)
      .map((node) => node.textContent!)
      .join('')
      .trim();
    if (!words || !(el instanceof HTMLElement) || !shown(el)) continue;
    const style = getComputedStyle(el);
    if (style.display === 'inline' || el.clientWidth === 0) continue;
    const over = el.scrollWidth - el.clientWidth > 1;
    if (!over) continue;
    const hides = style.overflowX !== 'visible' || style.textOverflow === 'ellipsis';
    const numeric = figure(el.textContent ?? '');
    /* A figure that spills out of its box is cut off as surely as one that is hidden: a metric wider than its card. */
    if (!hides && !numeric) continue;
    if (!seen(el)) continue;
    clipped.push({
      what: say(el),
      text: (el.textContent ?? '').trim().slice(0, 60),
      numeric,
      ellipsis: style.textOverflow === 'ellipsis',
    });
  }

  // Controls: what a reader clicks or taps.
  const CONTROLS =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [role="option"], [tabindex]:not([tabindex="-1"])';
  const controls = [...document.querySelectorAll(CONTROLS)].filter((el) => shown(el) && !el.closest('[inert]'));
  const boxes = controls.map((el) => ({ el, box: seen(el) })).filter((entry) => entry.box) as Array<{
    el: Element;
    box: { left: number; top: number; right: number; bottom: number };
  }>;

  /* A bar pinned to the window (a phone record's verbs at its foot) has the page scroll under it: a control beneath it
     in one frame is not drawn over it if the page leaves the room to scroll it clear, which it does (the page body's
     clearance under its last section). The pinned layer is the nearest box that is fixed or sticky. */
  const pinned = (el: Element): Element | undefined => {
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      const position = getComputedStyle(e).position;
      if (position === 'fixed' || position === 'sticky') return e;
    }
    return undefined;
  };
  /* Whether some scroll of the box that scrolls `el` brings it wholly above or below the pinned `bar`. */
  const clears = (el: Element, bar: Element) => {
    let scroller: Element = document.scrollingElement ?? document.documentElement;
    for (let e = el.parentElement; e && e !== document.documentElement; e = e.parentElement) {
      const style = getComputedStyle(e);
      if (/auto|scroll/.test(style.overflowY) && e.scrollHeight > e.clientHeight) {
        scroller = e;
        break;
      }
    }
    const room = scroller.scrollHeight - scroller.clientHeight;
    const box = el.getBoundingClientRect(),
      edge = bar.getBoundingClientRect();
    const at = scroller.scrollTop;
    /* Scrolled to its end, the box rises furthest; scrolled to its start, it sinks furthest. */
    const highest = box.bottom - (room - at),
      lowest = box.top + at;
    return highest <= edge.top + 1 || lowest >= edge.bottom - 1;
  };

  /* A control wholly in a text field's padding, clear of its content box, is that field's own room (a date field's
     calendar button): the field's words never reach it. */
  const TYPED = /^(?:text|search|email|url|tel|password|number|date|datetime-local|time|month|week)$/;
  const inPadding = (field: Element, other: Element) => {
    if (!(field instanceof HTMLTextAreaElement || (field instanceof HTMLInputElement && TYPED.test(field.type)))) return false;
    const style = getComputedStyle(field);
    const px = (value: string) => parseFloat(value) || 0;
    const outer = field.getBoundingClientRect(),
      box = other.getBoundingClientRect();
    const pad = {
      left: outer.left + px(style.borderLeftWidth),
      right: outer.right - px(style.borderRightWidth),
      top: outer.top + px(style.borderTopWidth),
      bottom: outer.bottom - px(style.borderBottomWidth),
    };
    const content = {
      left: pad.left + px(style.paddingLeft),
      right: pad.right - px(style.paddingRight),
      top: pad.top + px(style.paddingTop),
      bottom: pad.bottom - px(style.paddingBottom),
    };
    const inside = box.left >= pad.left - 1 && box.right <= pad.right + 1 && box.top >= pad.top - 1 && box.bottom <= pad.bottom + 1;
    const clear = box.left >= content.right || box.right <= content.left || box.top >= content.bottom || box.bottom <= content.top;
    return inside && clear;
  };

  // Overlaps: two controls, neither inside the other, drawn over the same pixels, where one of them is the one hit there.
  const overlaps: Probe['overlaps'] = [];
  const sorted = [...boxes].sort((a, b) => a.box.left - b.box.left);
  for (let i = 0; i < sorted.length && overlaps.length < 20; i++) {
    const a = sorted[i]!;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j]!;
      if (b.box.left >= a.box.right - 2) break;
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      if (inPadding(a.el, b.el) || inPadding(b.el, a.el)) continue;
      const width = Math.min(a.box.right, b.box.right) - Math.max(a.box.left, b.box.left);
      const height = Math.min(a.box.bottom, b.box.bottom) - Math.max(a.box.top, b.box.top);
      if (width < 3 || height < 3) continue;
      const hit = document.elementFromPoint(Math.max(a.box.left, b.box.left) + width / 2, Math.max(a.box.top, b.box.top) + height / 2);
      if (!hit || !(a.el.contains(hit) || b.el.contains(hit) || hit.contains(a.el) || hit.contains(b.el))) continue;
      const barA = pinned(a.el),
        barB = pinned(b.el);
      if (barA !== barB && (!barA || !barB)) {
        const bar = (barA ?? barB)!,
          under = barA ? b.el : a.el;
        if (clears(under, bar)) continue;
      }
      overlaps.push({ a: say(a.el), b: say(b.el) });
    }
  }

  // Tap targets, where a size is asked for: a link inside a line of prose is the prose's, and exempt.
  const small: Probe['small'] = [];
  if (input.tap) {
    for (const { el } of boxes) {
      /* A disabled control takes no tap: the sign-in page's brand, which goes nowhere until a reader is in. */
      if (el.matches(':disabled')) continue;
      const style = getComputedStyle(el);
      if (el.tagName === 'A' && style.display === 'inline') {
        const line = el.parentElement?.textContent?.trim() ?? '';
        if (line.length > (el.textContent?.trim().length ?? 0) + 8) continue;
      }
      const own = el.getBoundingClientRect();
      if (own.width < 4 || own.height < 4) continue; // drawn for a screen reader, not a finger
      const label = el.closest('label') ?? (el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null);
      const wrap = label?.getBoundingClientRect();
      /* A hit area drawn bigger than the control (structure.css, on a coarse pointer): an absolutely placed,
         empty ::before or ::after that takes the taps around it. Its computed size is its used size. */
      const reach = (['::before', '::after'] as const).map((pseudo) => {
        const drawn = getComputedStyle(el, pseudo);
        if (drawn.content === 'none' || drawn.content === 'normal' || drawn.display === 'none' || drawn.pointerEvents === 'none')
          return { width: 0, height: 0 };
        if (drawn.position !== 'absolute' && drawn.position !== 'fixed') return { width: 0, height: 0 };
        return { width: parseFloat(drawn.width) || 0, height: parseFloat(drawn.height) || 0 };
      });
      const width = Math.max(own.width, wrap?.width ?? 0, ...reach.map((box) => box.width));
      const height = Math.max(own.height, wrap?.height ?? 0, ...reach.map((box) => box.height));
      if (width < input.tap - 0.5 || height < input.tap - 0.5)
        small.push({
          what: say(el),
          width: Math.round(width),
          height: Math.round(height),
        });
    }
  }

  // Empty sections: a section drawn with nothing but its heading in it.
  const empty: string[] = [];
  for (const el of document.querySelectorAll('section, [role="region"], .page-section')) {
    if (!shown(el) || el.getBoundingClientRect().height < 1) continue;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let words = false;
    for (let node = walker.nextNode(); node && !words; node = walker.nextNode()) {
      const parent = node.parentElement!;
      if (!node.textContent!.trim() || parent.closest('h1, h2, h3, h4, h5, h6, [role="heading"], legend') || !shown(parent)) continue;
      words = true;
    }
    const drawn = [...el.querySelectorAll('img, svg, canvas, video, iframe, input, select, textarea, [role="img"]')].some((media) => {
      const box = media.getBoundingClientRect();
      return shown(media) && box.width >= 16 && box.height >= 16 && !media.closest('h1, h2, h3, h4, h5, h6, button, a');
    });
    if (!words && !drawn) {
      const heading = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')?.textContent?.trim();
      empty.push(heading ? `"${heading.slice(0, 40)}"` : say(el));
    }
  }

  // Figures, by the surface they stand in: a table's column, else the nearest section.
  const groups = new Map<string, { where: string; values: string[]; column: boolean }>();
  const add = (key: string, where: string, value: string) => {
    const group = groups.get(key) ?? { where, values: [], column: key.startsWith('t') };
    group.values.push(value);
    groups.set(key, group);
  };
  const tables = [...document.querySelectorAll('table')].filter(shown);
  tables.forEach((table, t) => {
    const heads = [...table.querySelectorAll('thead th')].map((th) => th.textContent?.trim() ?? '');
    for (const row of table.querySelectorAll('tbody tr')) {
      [...row.children].forEach((cell, c) => {
        const text = cell.textContent?.trim() ?? '';
        if (shown(cell) && figure(text)) add(`t${t}:${c}`, `the "${heads[c] || `column ${c + 1}`}" column`, text);
      });
    }
  });
  let n = 0;
  for (const el of document.querySelectorAll('section, .page-section, .dash-strip')) {
    n++;
    if (!shown(el)) continue;
    const heading = el.querySelector('h1, h2, h3, h4, h5, h6')?.textContent?.trim();
    for (const leaf of el.querySelectorAll('*')) {
      if (leaf.children.length || leaf.closest('table, svg, input, button') || !shown(leaf)) continue;
      /* A figure belongs to the innermost section it stands in. */
      if (leaf.closest('section, .page-section, .dash-strip') !== el) continue;
      const text = leaf.textContent?.trim() ?? '';
      if (figure(text)) add(`s${n}`, heading ? `"${heading.slice(0, 40)}"` : 'a section', text);
    }
  }
  const figures = [...groups.values()].filter((group) => group.values.length >= 2);

  // Chart axes: each chart's y labels, then its x labels.
  const axes: Probe['axes'] = [];
  [...document.querySelectorAll('svg')].filter(shown).forEach((svg, i) => {
    for (const axis of ['y', 'x']) {
      const ticks = [...svg.querySelectorAll(`.chart-${axis}-tick`)].map((tick) => tick.textContent?.trim() ?? '').filter(Boolean);
      const title = svg.closest('section, .page-section')?.querySelector('h1, h2, h3, h4')?.textContent?.trim();
      if (ticks.length >= 2)
        axes.push({
          where: `${title ? `"${title.slice(0, 40)}"` : `chart ${i + 1}`} ${axis} axis`,
          ticks,
        });
    }
  });

  // A record page's name, by the lines its words take: distinct tops among the rectangles its text draws.
  let title: Probe['title'];
  if (input.record) {
    const name = [...document.querySelectorAll('main h1, .content h1, h1')].find(
      (el) => shown(el) && !el.classList.contains('visually-hidden'),
    );
    if (name) {
      const range = document.createRange();
      range.selectNodeContents(name);
      const tops = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top / 4)));
      title = {
        text: (name.textContent ?? '').trim().slice(0, 60),
        lines: tops.size,
      };
    }
  }

  const windows = (globalThis as unknown as { __twShift?: { windows: number[] } }).__twShift?.windows ?? [0];
  return {
    sideways,
    clipped: clipped.slice(0, 20),
    overlaps,
    small,
    empty,
    figures,
    axes,
    ...(title ? { title } : {}),
    shift: Math.round(Math.max(...windows) * 1000) / 1000,
    scrolls,
  };
}

/**
 * The theme contract's promises a drawn page shows from inside it (themeContract.ts): a mark toned by color with no
 * word, name or label beside it (C6); prose by its characters a line (C8); and motion (C9) — under reduced motion
 * (`reduced`, how every window is opened) any part that moves or loops, else any set to take past `ms`.
 */
export function contractProbe(input: { reduced: boolean; ms: number }): Pick<Probe, 'toned' | 'measures' | 'motion'> {
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string) => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = 'rgba(0,0,0,0)';
    pen.fillStyle = css;
    pen.fillRect(0, 0, 1, 1);
    const d = pen.getImageData(0, 0, 1, 1).data;
    return [d[0]! / 255, d[1]! / 255, d[2]! / 255, d[3]! / 255];
  };
  const say = (el: Element) => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
    const kind = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/)[0]}` : '';
    return `${el.tagName.toLowerCase()}${kind}${label ? ` "${label}"` : ''}`;
  };
  const drawn = (el: Element) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  const named = (el: Element) =>
    Boolean(
      (el.textContent ?? '').trim() || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.getAttribute('title'),
    );
  const all = [...document.body.querySelectorAll('*')].slice(0, 6000);

  /* C6: a small chromatic mark — a dot, a swatch — alone in its cell or item, with nothing that says it in words. */
  const toned: string[] = [];
  for (const el of all) {
    if (toned.length >= 10 || named(el) || el.closest('svg') || el.querySelector('img, svg, input')) continue;
    const box = el.getBoundingClientRect();
    if (box.width < 4 || box.height < 4 || box.width > 20 || box.height > 20 || !drawn(el)) continue;
    const [r, g, b, a] = rgba(getComputedStyle(el).backgroundColor);
    const high = Math.max(r!, g!, b!),
      low = Math.min(r!, g!, b!);
    if (a! < 0.5 || high < 0.1 || (high - low) / high < 0.25) continue;
    const holder = el.closest('td, th, li, dd, [role="cell"], [role="gridcell"], [role="option"], [role="listitem"]');
    if (!holder || named(holder)) continue;
    toned.push(`${say(el)} in ${holder.tagName.toLowerCase()}`);
  }

  /* C8: prose of two lines or more, by its characters a line — its words over the lines its text draws. */
  const measures: Array<{ what: string; chars: number }> = [];
  for (const el of document.body.querySelectorAll('p, li, dd, blockquote')) {
    const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    if (text.length < 160 || !drawn(el) || el.closest('nav, [role="navigation"], table, pre, code')) continue;
    const range = document.createRange();
    range.selectNodeContents(el);
    const lines = new Set([...range.getClientRects()].filter((rect) => rect.width > 0).map((rect) => Math.round(rect.top / 4))).size;
    if (lines >= 2) measures.push({ what: say(el), chars: Math.round(text.length / lines) });
  }
  measures.sort((a, b) => b.chars - a.chars);

  /* C9: what moves now (a running animation), and what is set to move (a transition or animation's own duration). */
  const ms = (list: string) => Math.max(0, ...list.split(',').map((part) => (part.trim().endsWith('ms') ? 1 : 1000) * parseFloat(part)));
  const MOVING = /\b(?:all|transform|translate|scale|rotate|inset|top|left|right|bottom|margin[\w-]*|width|height)\b/;
  const motion = new Map<string, { what: string; ms: number; loops: boolean; reduced: boolean }>();
  for (const animation of document.getAnimations()) {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    const timing = animation.effect?.getComputedTiming();
    if (!target || !timing || animation.playState !== 'running' || !drawn(target)) continue;
    const duration = Number(timing.duration) || 0;
    if (duration <= 1) continue;
    motion.set(say(target), { what: say(target), ms: Math.round(duration), loops: timing.iterations === Infinity, reduced: input.reduced });
  }
  for (const el of all) {
    if (motion.size >= 10) break;
    const style = getComputedStyle(el);
    const transition =
      style.transitionProperty !== 'none' && (!input.reduced || MOVING.test(style.transitionProperty)) ? ms(style.transitionDuration) : 0;
    const animation = style.animationName !== 'none' ? ms(style.animationDuration) : 0;
    const longest = Math.max(transition, animation);
    if ((input.reduced ? longest > 1 : longest > input.ms) && drawn(el) && !motion.has(say(el)))
      motion.set(say(el), {
        what: say(el),
        ms: Math.round(longest),
        loops: animation > 0 && style.animationIterationCount === 'infinite',
        reduced: input.reduced,
      });
  }
  return { toned, measures: measures.slice(0, 10), motion: [...motion.values()] };
}

/**
 * The stop the Tab key reached (C3), or null where focus left the page: its ring — an outline, else a box-shadow's
 * spread, else one drawn by ::before or ::after — its width and its contrast on the ground under it. The stop is
 * marked, and its look kept, so `focusChanges` can tell a stop that shows itself another way (a fill, an edge).
 */
function focusStop(input: { index: number }): { what: string; width: number; ratio?: number; repeat?: true } | null {
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return null;
  if (el.hasAttribute('data-tw-stop')) return { what: '', width: 0, repeat: true };
  el.setAttribute('data-tw-stop', String(input.index));
  const FOCUS_WIDTH = 2;
  const say = () => {
    const label = (el.getAttribute('aria-label') ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32);
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${label ? ` "${label}"` : ''}`;
  };
  const pen = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!;
  const rgba = (css: string) => {
    pen.clearRect(0, 0, 1, 1);
    pen.fillStyle = 'rgba(0,0,0,0)';
    pen.fillStyle = css;
    pen.fillRect(0, 0, 1, 1);
    const d = pen.getImageData(0, 0, 1, 1).data;
    return [d[0]! / 255, d[1]! / 255, d[2]! / 255, d[3]! / 255];
  };
  const lum = ([r, g, b]: number[]) =>
    [r!, g!, b!]
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
      .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i]!, 0);
  const look = (style: CSSStyleDeclaration) =>
    [
      style.outlineStyle,
      style.outlineWidth,
      style.outlineColor,
      style.boxShadow,
      style.backgroundColor,
      style.borderColor,
      style.color,
      style.textDecorationLine,
    ].join('|');
  const own = getComputedStyle(el),
    before = getComputedStyle(el, '::before'),
    after = getComputedStyle(el, '::after');
  (globalThis as unknown as { __twStops?: string[] }).__twStops ??= [];
  (globalThis as unknown as { __twStops: string[] }).__twStops[input.index] = [own, before, after].map(look).join('/');
  /* The browser's own ring (outline-style: auto) is drawn two-toned to read on any ground. */
  if (own.outlineStyle === 'auto') return { what: say(), width: Math.max(FOCUS_WIDTH, parseFloat(own.outlineWidth) || 0) };
  const ringOf = (host: Element) => {
    for (const style of [getComputedStyle(host), getComputedStyle(host, '::after'), getComputedStyle(host, '::before')]) {
      if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0)
        return { width: parseFloat(style.outlineWidth), color: style.outlineColor };
      if (style.boxShadow && style.boxShadow !== 'none') {
        const spread = /(rgba?\([^)]*\)|#\w+)\s+(?:-?[\d.]+px\s+){3}([\d.]+)px/.exec(style.boxShadow);
        if (spread && parseFloat(spread[2]!) > 0) return { width: parseFloat(spread[2]!), color: spread[1]! };
      }
    }
    return null;
  };
  /* The ring is the stop's own, else the one its field or card draws round it while it holds focus (a picker's
     box round its input, a card round the button that opens it): what a reader sees is the ring either way. */
  let host: Element = el;
  let found = ringOf(el);
  for (let up = el.parentElement, depth = 0; !found && up && depth < 3; up = up.parentElement, depth++) {
    if (!up.matches(':focus-within')) break;
    found = ringOf(up);
    if (found) host = up;
  }
  const what = say();
  if (!found) return { what, width: 0 };
  const { width, color } = found;
  /* An inset ring is drawn on the stop's own fill, an outer one on what it sits on. */
  const hostStyle = getComputedStyle(host);
  const inset = parseFloat(hostStyle.outlineOffset) < 0 || /inset/.test(hostStyle.boxShadow);
  let ground = [1, 1, 1, 1];
  for (let e: Element | null = inset ? host : host.parentElement; e; e = e.parentElement) {
    const fill = rgba(getComputedStyle(e).backgroundColor);
    if (fill[3]! >= 0.5) {
      ground = fill;
      break;
    }
  }
  const ring = rgba(color);
  const [a, b] = [lum(ring), lum(ground)];
  return { what, width, ratio: Math.round(((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)) * 100) / 100 };
}

/** Whether each stop `focusStop` marked looks otherwise once focus has left it: a stop that shows itself without a ring. */
function focusChanges(input: { count: number }): boolean[] {
  const kept = (globalThis as unknown as { __twStops?: string[] }).__twStops ?? [];
  const look = (style: CSSStyleDeclaration) =>
    [
      style.outlineStyle,
      style.outlineWidth,
      style.outlineColor,
      style.boxShadow,
      style.backgroundColor,
      style.borderColor,
      style.color,
      style.textDecorationLine,
    ].join('|');
  return Array.from({ length: input.count }, (_, i) => {
    const el = document.querySelector(`[data-tw-stop="${i}"]`);
    /* A stop drawn again since (a row re-rendered) cannot be compared: given the benefit of the doubt. */
    if (!el) return true;
    const now = [getComputedStyle(el), getComputedStyle(el, '::before'), getComputedStyle(el, '::after')].map(look).join('/');
    return now !== kept[i];
  });
}

/** The Tab key's stops on a page, at most 25: each one's ring, and whether it shows itself otherwise (C3). */
export async function focusStops(page: Page): Promise<NonNullable<Probe['focus']>> {
  await page.evaluate('document.activeElement?.blur?.()');
  const stops: Array<{ what: string; width: number; ratio?: number }> = [];
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    const stop = (await page.evaluate(inPage(focusStop, { index: stops.length }))) as Awaited<ReturnType<typeof focusStop>>;
    if (!stop || stop.repeat) break;
    stops.push(stop);
  }
  await page.evaluate('document.activeElement?.blur?.()');
  const changed = (await page.evaluate(inPage(focusChanges, { count: stops.length }))) as boolean[];
  return stops.map((stop, i) => ({ ...stop, changed: changed[i] ?? true }));
}

/**
 * What happens while a page is drawn that the probe cannot see from inside it: its uncaught errors and the requests
 * that failed or answered 400 or more. This one runs in Node, on the page's events.
 */
export function watchEvents(page: Page, events: { errors: string[]; failed: string[] }): void {
  page.on('pageerror', (error) => events.errors.push(`the page threw: ${error.message.split('\n')[0]}`));
  page.on('requestfailed', (request) => {
    const why = request.failure()?.errorText ?? '';
    /* A request the page let go of — a query it no longer needs — is not a failure. */
    if (!/ERR_ABORTED|cancel/i.test(why)) events.failed.push(`${request.method()} ${new URL(request.url()).pathname} failed (${why})`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400)
      events.failed.push(`${response.request().method()} ${new URL(response.url()).pathname} answered ${response.status()}`);
  });
}
