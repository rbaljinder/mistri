/**
 * A first page is revealed finished, as a navigation is (navigationHold.ts).
 *
 * Boot resolves once the room is chosen and drawn, but a room draws its
 * frame first and its parts as their reads answer — a dashboard's sections,
 * a record's related lists, a list's count and tab badges, the bar's account
 * control, a chart's chunk — and each arrival moved everything under it.
 * That was most of the layout shift measured on a first paint
 * (test/built-client-vitals.mjs), and the reader met it before they had
 * done anything. So the startup veil (index.html, startup.ts) stays up until
 * the page is quiet: nothing asked is still out (pendingWork.ts: every api()
 * request and every part fetched on demand), no read is running (the shell's
 * probe, TanStack Query), and nothing has been drawn into the page, for four
 * frames and 60 ms together — long enough for an answer to be drawn and for
 * the reads its drawing starts to begin, even on a slow phone where one
 * render outlasts a frame. A second at most: a slow read costs a late
 * section, never a blank page.
 *
 * A tenant's chosen workspace is veiled again and revealed the same way
 * (app.js). Depends on nothing but pendingWork, so the entry chunk carries it.
 */
import { workSince } from './pendingWork.js';
import { shellBody, shellRoot } from './shellHost.js';

/** The longest the veil waits for the room, in ms, once boot has drawn it. */
const CAP = 1000;
const QUIET_FRAMES = 4;
const QUIET_MS = 60;

/** What else says the page is still arriving: its reads, which may wait on more than a request. */
interface StartupProbe {
  busy(): boolean;
  watch(changed: () => void): () => void;
}
let probe: StartupProbe = { busy: () => false, watch: () => () => {} };

/** The shell's reads, told once it has them (app.js). */
export function setStartupProbe(reads: StartupProbe): void {
  probe = reads;
}

/* A frame, or a moment where there are none (a tab opened in the background). */
const nextFrame = () =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Resolve once the veiled page is quiet, or at the cap; at once when nothing is veiled. */
export async function startupSettled(cap = CAP): Promise<void> {
  if (!shellRoot().hasAttribute('data-starting')) return;
  const until = performance.now() + cap;
  let stirred = false;
  const drawn =
    typeof MutationObserver === 'function'
      ? new MutationObserver(() => {
          stirred = true;
        })
      : null;
  drawn?.observe(shellBody(), { childList: true, characterData: true, subtree: true });
  const stop = probe.watch(() => {
    stirred = true;
  });
  try {
    let quiet = 0,
      since = performance.now();
    while ((quiet < QUIET_FRAMES || performance.now() - since < QUIET_MS) && performance.now() < until) {
      await nextFrame();
      if (!stirred && !workSince(0) && !probe.busy()) quiet++;
      else {
        quiet = 0;
        since = performance.now();
      }
      stirred = false;
    }
  } finally {
    drawn?.disconnect();
    stop();
  }
}
