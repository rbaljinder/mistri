/**
 * The page's side of the dev observer (server/observe/), loaded by boot.js
 * only when a `--dev` server put its tag in the page.
 *
 * It reports what only the browser knows — an uncaught error or rejection,
 * with its stack, each layout shift with the elements that moved, and the
 * page's web vitals (LCP, CLS, INP) — to
 * the observer, tied to the request the page last made. And it shows the
 * observer's small badge in a corner: "Observer", or, after a refusal or a
 * failure, "Open in observer" straight to that request's trace.
 */

import { say } from '../copy/observe/observe/beacon.js';

/* Where the observer is, as the server said it in the page's tag: under the base path when there is one. */
const HOME = document.querySelector('meta[name="mistri-observe"]')?.getAttribute('content') || '/_mistri/observe/';
const ENDPOINT = `${HOME}api/page`;

/** @type {string | undefined} */
let lastTrace;

/** @param {Record<string, unknown>} report */
function send(report) {
  try {
    void fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({ path: location.pathname + location.search, ...(lastTrace ? { traceId: lastTrace } : {}), ...report }),
    }).catch(() => {});
  } catch {
    /* a report is never worth an error of its own */
  }
}

/** A node as a person would find it in devtools: `div#id.class.class`. @param {Node | null | undefined} node */
function describe(node) {
  if (!node || !(node instanceof Element)) return node?.nodeName?.toLowerCase() ?? '(gone)';
  const classes = [...node.classList]
    .slice(0, 3)
    .map((name) => `.${name}`)
    .join('');
  return `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes}`;
}
/** @param {DOMRectReadOnly | undefined} rect */
const box = (rect) =>
  rect ? `${Math.round(rect.x)},${Math.round(rect.y)} ${Math.round(rect.width)}×${Math.round(rect.height)}` : undefined;

function badge() {
  const link = document.createElement('a');
  link.href = HOME;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = say('observer');
  link.title = say('theDevObserver');
  const style = link.style;
  style.position = 'fixed';
  style.insetInlineEnd = '10px';
  style.insetBlockEnd = '10px';
  style.zIndex = '2147483000';
  style.font = '500 11.5px/1 var(--code, ui-monospace, monospace)';
  style.padding = '5px 8px';
  style.borderRadius = 'var(--radius-item, 5px)';
  style.border = '1px solid var(--line-strong, #cbc5b9)';
  style.background = 'var(--surface, #fff)';
  style.color = 'var(--ink-muted, #6d675d)';
  style.textDecoration = 'none';
  style.opacity = '0.85';
  document.body.append(link);
  window.addEventListener('mistri:observe', (event) => {
    const where = /** @type {CustomEvent<string>} */ (event).detail;
    if (typeof where !== 'string' || !where.startsWith(HOME)) return;
    link.href = where;
    link.textContent = say('openInObserver');
    style.color = 'var(--status-critical, #a12d2d)';
    style.borderColor = 'currentColor';
  });
}

export function startBeacon() {
  // The request the page made last, from the header a --dev server adds (server/http/traceRequest.ts).
  const original = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const response = await original(...args);
    const trace = response.headers.get('x-mistri-trace');
    if (trace && /^[0-9a-f]{32}$/.test(trace)) lastTrace = trace;
    return response;
  };
  window.addEventListener('error', (event) => {
    send({
      kind: 'error',
      message: event.message || String(event.error),
      ...(event.error?.stack ? { stack: String(event.error.stack) } : {}),
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    send({
      kind: 'error',
      message: say('unhandledRejection', { reason: reason instanceof Error ? reason.message : String(reason) }),
      ...(reason instanceof Error && reason.stack ? { stack: reason.stack } : {}),
    });
  });
  const vitals = watchVitals();
  try {
    new PerformanceObserver((list) => {
      for (const entry of /** @type {Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node; previousRect?: DOMRectReadOnly; currentRect?: DOMRectReadOnly }> }>} */ (
        list.getEntries()
      )) {
        if (entry.hadRecentInput) continue;
        vitals.shift(entry.startTime, entry.value);
        if (entry.value < 0.001) continue;
        send({
          kind: 'layout-shift',
          name: 'layout-shift',
          value: entry.value,
          sources: (entry.sources ?? []).map((source) => ({
            node: describe(source.node),
            previous: box(source.previousRect),
            current: box(source.currentRect),
          })),
        });
      }
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {
    /* a browser without layout-shift entries */
  }
  if (document.body) badge();
  else addEventListener('DOMContentLoaded', badge, { once: true });
}

/**
 * LCP, CLS and INP, as the web-vitals library defines them, sent as `vital`
 * reports: LCP once it is final — at the first input, or when the page is
 * hidden — and CLS and INP each time the page is hidden, which is when a
 * person switches to the observer's tab to read them. A value already sent
 * is not sent again.
 *
 *   LCP  the last largest-contentful-paint entry before any input;
 *   CLS  the worst session window of shifts without recent input (a window
 *        ends after a 1 s gap or 5 s in all);
 *   INP  the slowest interaction by its longest event, one ignored for every
 *        fifty (the 98th percentile on a busy page).
 */
function watchVitals() {
  /** @type {{ time: number; node?: string } | undefined} */
  let lcp;
  let lcpFinal = false;
  let cls = 0,
    session = 0,
    first = 0,
    last = 0;
  /** @type {Map<number, { duration: number; node: string; type: string }>} */
  const interactions = new Map();
  /** @type {Map<string, number>} */
  const sent = new Map();
  /** @param {string} name @param {number} value @param {string | undefined} node */
  const report = (name, value, node) => {
    const rounded = name === 'CLS' ? Math.round(value * 10000) / 10000 : Math.round(value);
    if (sent.get(name) === rounded) return;
    sent.set(name, rounded);
    send({ kind: 'vital', name, value: rounded, ...(node ? { sources: [{ node }] } : {}) });
  };
  const inp = () => {
    const worst = [...interactions.values()].sort((a, b) => b.duration - a.duration);
    return worst[Math.min(worst.length - 1, Math.floor(interactions.size / 50))];
  };
  const finishLcp = () => {
    if (!lcpFinal && lcp) {
      lcpFinal = true;
      report('LCP', lcp.time, lcp.node);
    }
  };
  try {
    new PerformanceObserver((list) => {
      if (lcpFinal) return;
      const entry = /** @type {PerformanceEntry & { element?: Element | null }} */ (list.getEntries().at(-1));
      if (entry) lcp = { time: entry.startTime, node: describe(entry.element) };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
  } catch {
    /* a browser without LCP entries */
  }
  try {
    new PerformanceObserver((list) => {
      for (const entry of /** @type {Array<PerformanceEntry & { interactionId?: number; target?: Node | null }>} */ (list.getEntries())) {
        if (!entry.interactionId) continue;
        const known = interactions.get(entry.interactionId);
        if (!known || known.duration < entry.duration)
          interactions.set(entry.interactionId, { duration: entry.duration, node: describe(entry.target), type: entry.name });
      }
    }).observe(/** @type {PerformanceObserverInit} */ ({ type: 'event', buffered: true, durationThreshold: 40 }));
  } catch {
    /* a browser without event timing */
  }
  for (const type of ['keydown', 'pointerdown']) addEventListener(type, finishLcp, { once: true, capture: true });
  const hidden = () => {
    if (document.visibilityState !== 'hidden') return;
    finishLcp();
    report('CLS', cls, undefined);
    const slowest = inp();
    if (slowest) report('INP', slowest.duration, say('inpSource', { type: slowest.type, node: slowest.node }));
  };
  document.addEventListener('visibilitychange', hidden);
  addEventListener(
    'pagehide',
    () => {
      finishLcp();
      report('CLS', cls, undefined);
    },
    { capture: true },
  );
  return {
    /** A layout shift without recent input, into its session window. @param {number} time @param {number} value */
    shift(time, value) {
      if (session && time - last < 1000 && time - first < 5000) session += value;
      else {
        session = value;
        first = time;
      }
      last = time;
      cls = Math.max(cls, session);
    },
  };
}
