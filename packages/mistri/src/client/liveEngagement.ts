/**
 * Whether the reader is working in a list, so that a change does not move it under them.
 *
 * Engaged is any of: rows selected, a row menu open, a row focused or being
 * edited; the list scrolled more than a row from its top, or past its first
 * page; the pointer over its rows in the last three seconds, or a text
 * selection inside them. Engagement ends when none holds for two seconds, and
 * the list is shown what it was held back from (liveInvalidate.ts showHeld).
 *
 * Read from the page, not from the list: a list is a grid, a set of cards, a
 * board or a queue, and each already says what is selected, open and focused
 * in the attributes a screen reader reads.
 */
import { state } from '@mistriwork/kit/client/core.js';
import { heldHolds, setEngagement } from '@mistriwork/kit/client/liveState.js';
import { showHeld } from './liveInvalidate.js';
import { addHostListener, shellQuery } from '@mistriwork/kit/client/shellHost.js';

const POINTER_MS = 3_000;
const QUIET_MS = 2_000;
const POLL_MS = 500;
const ROW = 'tbody tr, [data-row-key], [role="option"], [role="row"], .board-card';
const CONTENT = '.content';

let lastPointer = 0;
let quietAt = 0;

function engagedNow(): boolean {
  const content = shellQuery<HTMLElement>(CONTENT);
  if (!content) return false;
  if (content.querySelector('input.row-select:checked, tr[aria-selected="true"], [role="option"][aria-selected="true"]')) return true;
  if (content.querySelector('[aria-expanded="true"]') || shellQuery('[role="menu"]:not([data-closed])')) return true;
  const focused = document.activeElement;
  if (focused && focused !== document.body && content.contains(focused) && focused.closest(ROW)) return true;
  const first = content.querySelector<HTMLElement>('tbody tr:not(.virtual-spacer), [data-row-key]');
  const height = first?.offsetHeight || 40;
  if (content.scrollTop > height || (document.scrollingElement?.scrollTop ?? 0) > height) return true;
  if (Number((state as { page?: number }).page ?? 0) > 0) return true;
  if (Date.now() - lastPointer < POINTER_MS) return true;
  const selection = document.getSelection();
  const anchor = selection && !selection.isCollapsed ? selection.anchorNode : null;
  return Boolean(anchor && content.contains(anchor) && (anchor.nodeType === 1 ? (anchor as Element) : anchor.parentElement)?.closest(ROW));
}

/** Engaged now, or within two seconds of having been. */
function engaged(): boolean {
  const now = Date.now();
  if (engagedNow()) quietAt = now + QUIET_MS;
  return now < quietAt;
}

const onMove = (event: PointerEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(`${CONTENT} :is(${ROW})`)) lastPointer = Date.now();
};

/** Watch the reader, and show held lists their changes when they stop. Returns the way to stop. */
export function watchEngagement(): () => void {
  setEngagement(engaged);
  const unlisten = addHostListener(document, 'pointermove', onMove, { passive: true });
  const timer = setInterval(() => {
    if (!heldHolds().length || engaged()) return;
    for (const hold of heldHolds()) showHeld(hold);
  }, POLL_MS);
  return () => {
    clearInterval(timer);
    lastPointer = quietAt = 0;
    unlisten();
    setEngagement(() => false);
  };
}
