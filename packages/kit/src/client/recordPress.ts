/**
 * A press on a row or a link that opens a record begins reading the record's
 * page (recordCompose.ts) while the button is still down, so the page's one
 * request overlaps the click and the screen held for it (navigationHold.ts)
 * is let go sooner. Only a press, Enter, or a focus that stays: a pointer
 * passing over a list asks nothing.
 */
import { prefetchRecord, state } from './core.js';
import { shell } from './shellMode.js';
import { appListFor } from './components/appListModel.js';
import { beginRecordPage } from './recordCompose.js';
import { addHostListener } from './shellHost.js';

/* Whether a press on a record of this table opens its page: the record
   opener's own rule (appnav.js), asked without opening anything — a split
   shows its pick beside the list and a peek draws a drawer, and neither
   asks for a page. */
function opensAsPage(tableId: string): boolean {
  if (!shell().inApp()) return true;
  const here = (state as { stack?: Array<{ query?: string; view?: string }> }).stack?.at(-1);
  const entry = appListFor(tableId, here?.query, here?.view) as { presentation?: { kind?: string }; open?: string } | undefined;
  return entry?.presentation?.kind !== 'split' && entry?.open !== 'drawer';
}

/* A focus that stays this long is a reader choosing a row, not passing
   through a list on the arrow keys. */
const SETTLED_FOCUS = 150;

function intent(target: EventTarget | null): [string, Record<string, unknown>] | undefined {
  const element = target instanceof Element ? target.closest('[data-opens]') : null;
  const said = element?.getAttribute('data-opens');
  if (!said) return undefined;
  try {
    const [table, key] = JSON.parse(said) as [unknown, unknown];
    return typeof table === 'string' && key && typeof key === 'object' ? [table, key as Record<string, unknown>] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Begin reading a record's page for a press that opens it as one: the walk
 * asks this (core.js `prefetchRecord`) through the shell, which names it at
 * boot (app.js).
 */
export function prefetchRecordPage(pageId: string, tableId: string, key: Record<string, unknown>): void {
  if (opensAsPage(tableId)) beginRecordPage((state as { activeConnection?: string }).activeConnection ?? '', pageId, key);
}

let listening = false;
/**
 * From the shell's start (app.js): every row and link that opens a record
 * says which (`opensRecord`, recordIntent.ts), and a press, Enter, or a
 * focus that stays begins reading its page.
 */
export function listenForRecordPresses(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  let pressedAt = -Infinity;
  let focusTimer: ReturnType<typeof setTimeout> | undefined;
  const press = (event: Event) => {
    const asked = intent(event.target);
    if (asked) prefetchRecord(...asked);
  };
  addHostListener(
    document,
    'pointerdown',
    (event) => {
      pressedAt = performance.now();
      press(event);
    },
    true,
  );
  addHostListener(
    document,
    'keydown',
    (event) => {
      if ((event as KeyboardEvent).key === 'Enter') press(event);
    },
    true,
  );
  addHostListener(
    document,
    'focusin',
    (event) => {
      clearTimeout(focusTimer);
      const asked = intent(event.target);
      /* A press focuses what it pressed, and has begun its page already. */
      if (asked && performance.now() - pressedAt > 500) focusTimer = setTimeout(() => prefetchRecord(...asked), SETTLED_FOCUS);
    },
    true,
  );
  addHostListener(
    document,
    'focusout',
    () => {
      clearTimeout(focusTimer);
    },
    true,
  );
}
