/**
 * Building DOM, and the keyboard manners of the page's own popups: a
 * disclosure that Escape and an outside click close, and a trap that keeps
 * Tab inside a panel and hands the focus back on the way out.
 *
 * Out of core.js, which re-exports all four so every caller keeps its
 * import. Nothing here reads the walk, the schema or the API, so this module
 * imports nothing and core.js can import it without a cycle.
 */
import { addHostListener, removeHostListener, shellQuery } from './shellHost.js';

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false || v === null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    node.append(child);
  }
  return node;
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null) continue;
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, String(v));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/**
 * Make a `<details>` announce itself as the control it looks like.
 *
 * A `<summary>` styled as a button is read by Chromium as `group: + Count` —
 * no role, no state, nothing to say it can be opened or that it currently is.
 * The reader sees a button; the screen reader is told about a grouping box.
 * Every disclosure in this app is a button in appearance and in intent, so
 * each one says so, and keeps `aria-expanded` in step with the element's own
 * `open` — through the `toggle` event, because a `<details>` can be opened by
 * the keyboard, by a click on the marker, or by `open` being set in code, and
 * only the event sees all three.
 */
export function disclosure(details, { dismissible = true } = {}) {
  const summary = details.querySelector(':scope > summary');
  if (!summary) return details;
  summary.setAttribute('role', 'button');
  summary.setAttribute('aria-expanded', String(details.open));
  /* Light dismissal, here so every disclosure gets it: the Export menu was
     the one popup on the page that Escape and an outside click both left
     open. Escape closes only this layer — stopped, the way every stacked
     surface here learned to — and hands focus back to the summary. */
  const outside = (e) => {
    if (!details.contains(e.target)) details.open = false;
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    details.open = false;
    summary.focus();
  };
  details.addEventListener('toggle', () => {
    summary.setAttribute('aria-expanded', String(details.open));
    if (!dismissible) return;
    if (details.open) {
      addHostListener(document, 'pointerdown', outside, true);
      addHostListener(document, 'keydown', onKey, true);
    } else {
      removeHostListener(document, 'pointerdown', outside, true);
      removeHostListener(document, 'keydown', onKey, true);
    }
  });
  return details;
}

/**
 * Keep the keyboard inside a panel, and give it back on the way out.
 *
 * Eight surfaces here declare `role="dialog"` and `aria-modal="true"` on a
 * plain `<div>`. The attribute is a promise: it tells a screen reader that
 * everything behind this is inert and not to be reached. Nothing was
 * enforcing it, so Tab walked straight out of the panel and into the table
 * underneath — the page reading as sealed to one user and open to another,
 * which is worse than not claiming it at all. The `<dialog>` elements
 * elsewhere get this from the platform; these had to be told.
 *
 * It also puts focus back where it came from. Closing a panel used to drop
 * focus on `<body>`, so the next Tab started again from the top of the
 * document — a keyboard user who opened the connection manager from the
 * toolbar and pressed Escape had to walk the whole page to get back.
 *
 * Returns the release function. Call it when the panel goes.
 */
export function trapFocus(panel) {
  const cameFrom = document.activeElement;

  /* Queried per keystroke rather than cached: these panels rebuild their own
     contents constantly — a filter that repaints a list, a tour that swaps
     the card — and a list captured on open goes stale immediately. */
  const focusable = () =>
    [
      ...panel.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]),' +
          ' textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((node) => node.offsetWidth > 0 || node.offsetHeight > 0 || node === document.activeElement);

  /* Focus in a modal opened over this panel is that modal's to keep. Since
     Modal.tsx moved every dialog onto Base UI there is no `<dialog open>` to
     see: a modal is an `aria-modal` element on a portal of its own, and this
     trap pulled focus back from it while Base UI's pulled it in again — the
     connection form's name, filled as it opened, landed in the URL box. */
  const aboveUs = (node) => {
    if (shellQuery('dialog[open]')) return true;
    const owner = node instanceof Element ? node.closest('[aria-modal="true"]') : null;
    return Boolean(owner && owner !== panel && !owner.contains(panel));
  };

  const onKey = (e) => {
    if (e.key !== 'Tab') return;
    if (aboveUs(document.activeElement)) return;
    const stops = focusable();
    /* Nothing to move to yet — a panel painted but not filled. Swallowing the
       key is the honest answer: the alternative is Tab escaping into the page
       this panel has told a screen reader is inert. Escape still closes. */
    if (!stops.length) {
      e.preventDefault();
      return;
    }
    const first = stops[0];
    const last = stops[stops.length - 1];
    /* Focus outside the panel entirely — it can happen, because a panel may
       be opened while something behind it is focused. Pull it back rather
       than letting the first Tab escape. */
    if (!panel.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  /**
   * Focus that ends up outside, brought back.
   *
   * Tab is not the only way out. These panels repaint themselves — the
   * connection list arrives and replaces the loading state, a filter redraws
   * the rows — and replacing the node that had focus drops it on `<body>`,
   * outside the thing that claims to be modal. A click on the page behind
   * does the same.
   *
   * A modal on top is the exception, and it has to be: the connections
   * panel opens one to add a connection, and pulling focus back to the panel
   * underneath would make that dialog impossible to type into. The modal
   * keeps its own focus, so this stands aside.
   */
  const onFocusIn = (e) => {
    if (!panel.isConnected) return;
    if (panel.contains(e.target)) return;
    if (aboveUs(e.target)) return;
    const stops = focusable();
    if (stops.length) stops[0].focus();
  };

  /**
   * The panel rebuilding itself out from under the keyboard.
   *
   * This is the one that actually bit. These panels paint twice — a loading
   * state, then the answer — and `replaceChildren` destroys whatever had
   * focus. Removing a focused element does not reliably fire `blur` or
   * `focusout` in Chrome, so nothing above hears it; focus simply becomes
   * `<body>` and the next Tab starts from the top of the document, outside
   * the panel that claims to be modal.
   *
   * Watching the subtree catches it whatever caused it — a repaint, a row
   * that removed itself, a list that filtered. If the panel put focus
   * somewhere itself, as the connection filter does, this sees focus already
   * inside and stands aside.
   */
  const watcher = new MutationObserver(() => {
    if (!panel.isConnected) return;
    if (panel.contains(document.activeElement)) return;
    if (aboveUs(document.activeElement)) return;
    const stops = focusable();
    if (stops.length) stops[0].focus();
  });
  watcher.observe(panel, { childList: true, subtree: true });

  addHostListener(document, 'keydown', onKey, true);
  addHostListener(document, 'focusin', onFocusIn);
  return () => {
    watcher.disconnect();
    removeHostListener(document, 'keydown', onKey, true);
    removeHostListener(document, 'focusin', onFocusIn);
    /* Only if the panel still holds it. Something that closed itself by
       sending you somewhere — a connection row that opens that database —
       has already put focus where it belongs. */
    if (cameFrom?.isConnected && !document.activeElement?.closest?.('dialog')) {
      if (cameFrom instanceof HTMLElement && (!panel.isConnected || panel.contains(document.activeElement))) cameFrom.focus();
    }
  };
}
