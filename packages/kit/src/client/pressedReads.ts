/**
 * Reads a press on the menu began (listRowsPress.ts), by the query's hash, with when. A list's rows are read with a
 * stale time of nothing, so an answer that lands before the click does would be asked again by the room the click
 * opens; for a moment after the press the room takes what the press read as fresh. The press, and the one room it
 * is for, share one read.
 */
const KEPT_MS = 3_000;
const pressed = new Map<string, number>();

export const PRESS_KEPT_MS = KEPT_MS;

/** Note that a press began this read now. */
export function notePressed(hash: string): void {
  const now = Date.now();
  for (const [kept, at] of pressed) if (now - at >= KEPT_MS) pressed.delete(kept);
  pressed.set(hash, now);
}

/** Whether a press began this read within the last moment. */
export const wasPressed = (hash: string): boolean => {
  const at = pressed.get(hash);
  return at !== undefined && Date.now() - at < KEPT_MS;
};

/** The stale time of a list's rows: a moment where a press has just read them, nothing otherwise. */
export const rowsStaleTime = (hash: string): number => (wasPressed(hash) ? KEPT_MS : 0);
