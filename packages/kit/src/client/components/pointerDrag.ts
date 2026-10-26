/**
 * The gesture behind every drag in the client — which presses become drags,
 * for which pointer, and when a finger means to scroll instead. Pure, so the
 * rules are tested without a browser (pointerDrag.test.ts); usePointerDrag
 * wires them to the page.
 *
 * A mouse or a pen lifts what it pressed once it has moved a few pixels, so a
 * click stays a click. A finger has to hold still first: a long press lifts,
 * and a finger that moves before then was scrolling, and is left to scroll.
 * The browser's own drag and drop did neither — it ignored fingers on phones
 * and half of them on an iPad — which is why the board and the calendar left it.
 */
export const MOUSE_SLOP = 4;
export const TOUCH_SLOP = 8;
export const TOUCH_HOLD_MS = 350;

/** Waiting to be a drag, a drag, or over (a scroll, a click, a drop or a cancel). */
type GesturePhase = 'pending' | 'dragging' | 'over';

export interface Gesture {
  phase: GesturePhase;
  touch: boolean;
  x0: number;
  y0: number;
  t0: number;
}

/** What a step of the gesture asks of its host. */
export type GestureEffect = 'none' | 'lift' | 'move' | 'abandon';

const moved = (gesture: Gesture, x: number, y: number) => Math.hypot(x - gesture.x0, y - gesture.y0);

export function beginGesture(pointerType: string, x: number, y: number, now: number): Gesture {
  return { phase: 'pending', touch: pointerType === 'touch', x0: x, y0: y, t0: now };
}

/** The pointer moved: a mouse past its slop lifts; a finger past its slop before the hold was scrolling. */
export function moveGesture(gesture: Gesture, x: number, y: number, now: number): [Gesture, GestureEffect] {
  if (gesture.phase === 'dragging') return [gesture, 'move'];
  if (gesture.phase === 'over') return [gesture, 'none'];
  const distance = moved(gesture, x, y);
  if (!gesture.touch) return distance > MOUSE_SLOP ? [{ ...gesture, phase: 'dragging' }, 'lift'] : [gesture, 'none'];
  if (distance > TOUCH_SLOP) return [{ ...gesture, phase: 'over' }, 'abandon'];
  return now - gesture.t0 >= TOUCH_HOLD_MS ? [{ ...gesture, phase: 'dragging' }, 'lift'] : [gesture, 'none'];
}

/** The hold timer fired: a finger still pressing, still in place, lifts. */
export function holdGesture(gesture: Gesture, now: number): [Gesture, GestureEffect] {
  if (gesture.phase !== 'pending' || !gesture.touch || now - gesture.t0 < TOUCH_HOLD_MS) return [gesture, 'none'];
  return [{ ...gesture, phase: 'dragging' }, 'lift'];
}

/** The pointer let go: a drag drops; a press that never lifted was a click, and the page's click goes on. */
export function endGesture(gesture: Gesture): 'drop' | 'click' | 'none' {
  return gesture.phase === 'dragging' ? 'drop' : gesture.phase === 'pending' ? 'click' : 'none';
}

/** How far, and which way, to scroll an edge the pointer is near: 0 away from every edge. */
export function edgeSpeed(position: number, start: number, end: number, edge = 48, top = 18): number {
  if (end - start <= edge * 2) return 0;
  if (position < start + edge) return -Math.ceil(((start + edge - position) / edge) * top);
  if (position > end - edge) return Math.ceil(((position - (end - edge)) / edge) * top);
  return 0;
}

/**
 * Where a drop lands among a run of items, from the one the pointer is over:
 * before it in its first half, before the next one in its second — the next
 * that is not the item being carried — and at the end past the last. `id`
 * undefined is the run's own space, below its items: the end.
 */
export function landingBefore(order: readonly string[], carried: string, over: string | undefined, firstHalf: boolean): string | undefined {
  if (over === undefined) return undefined;
  if (firstHalf) return over;
  const at = order.indexOf(over);
  return order.slice(at + 1).find((id) => id !== carried);
}

/**
 * How far each item of a run slides, along the run, to open the gap a drop
 * would land in: the items between where the carried item stood and where it
 * would land step aside by its size, and the carried item's own slot moves to
 * the landing (a run it left closes over it; a run it enters opens for it).
 * `sizes` are the run's items in order, each with the gap after it; `origin`
 * is the carried item's index where it is in this run, `at` the landing among
 * the run's other items where the landing is here, and `step` the carried
 * item's size. Pure, so the sliding is tested without a layout.
 */
export function slideOffsets(sizes: readonly number[], origin: number | undefined, at: number | undefined, step: number): number[] {
  return sizes.map((_, j) => {
    if (origin === undefined) return at !== undefined && j >= at ? step : 0;
    if (j === origin) {
      if (at === undefined || at === origin) return 0;
      return at > origin ? sizes.slice(origin + 1, at + 1).reduce((a, b) => a + b, 0) : -sizes.slice(at, origin).reduce((a, b) => a + b, 0);
    }
    const i = j < origin ? j : j - 1;
    if (at === undefined) return j > origin ? -step : 0;
    if (i >= origin && i < at) return -step;
    if (i >= at && i < origin) return step;
    return 0;
  });
}
