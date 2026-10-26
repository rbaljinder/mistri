import { describe, expect, it } from 'vitest';
import {
  slideOffsets,
  MOUSE_SLOP,
  TOUCH_HOLD_MS,
  TOUCH_SLOP,
  beginGesture,
  edgeSpeed,
  endGesture,
  holdGesture,
  landingBefore,
  moveGesture,
} from './pointerDrag.js';

describe('the drag gesture', () => {
  it('a mouse lifts once it has moved past its slop, and a press that never moved is a click', () => {
    const pressed = beginGesture('mouse', 100, 100, 0);
    const [still, none] = moveGesture(pressed, 100 + MOUSE_SLOP, 100, 10);
    expect(none).toBe('none');
    expect(endGesture(still)).toBe('click');
    const [dragging, lift] = moveGesture(still, 100 + MOUSE_SLOP + 1, 100, 20);
    expect(lift).toBe('lift');
    expect(moveGesture(dragging, 300, 300, 30)[1]).toBe('move');
    expect(endGesture(dragging)).toBe('drop');
    // A pen is a mouse here: it can hover, and a press means what it presses.
    expect(moveGesture(beginGesture('pen', 0, 0, 0), 10, 0, 1)[1]).toBe('lift');
  });

  it('a finger lifts only after holding still; moving first was a scroll, and the scroll is left alone', () => {
    const pressed = beginGesture('touch', 50, 50, 0);
    // Moving within the slop, before the hold: still waiting.
    expect(moveGesture(pressed, 50 + TOUCH_SLOP, 50, 100)[1]).toBe('none');
    expect(holdGesture(pressed, TOUCH_HOLD_MS - 1)[1]).toBe('none');
    const [held, lift] = holdGesture(pressed, TOUCH_HOLD_MS);
    expect(lift).toBe('lift');
    expect(held.phase).toBe('dragging');
    // Past the slop before the hold: abandoned, and neither a click nor a drop.
    const [scrolled, abandon] = moveGesture(pressed, 50, 50 + TOUCH_SLOP + 1, 100);
    expect(abandon).toBe('abandon');
    expect(endGesture(scrolled)).toBe('none');
    expect(holdGesture(scrolled, TOUCH_HOLD_MS * 2)[1]).toBe('none');
    // A move that arrives after the hold time, still in place, lifts even if the timer is late.
    expect(moveGesture(pressed, 51, 51, TOUCH_HOLD_MS + 5)[1]).toBe('lift');
  });

  it('scrolls an edge faster the nearer the pointer is, and not at all in the middle or in a small box', () => {
    expect(edgeSpeed(500, 0, 1000)).toBe(0);
    expect(edgeSpeed(40, 0, 1000)).toBeLessThan(0);
    expect(edgeSpeed(2, 0, 1000)).toBeLessThan(edgeSpeed(40, 0, 1000));
    expect(edgeSpeed(990, 0, 1000)).toBeGreaterThan(0);
    expect(edgeSpeed(5, 0, 80)).toBe(0);
  });

  it('lands before the item in its first half, before the next in its second, and at the end past the last', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(landingBefore(order, 'd', 'b', true)).toBe('b');
    expect(landingBefore(order, 'd', 'b', false)).toBe('c');
    // The item being carried is not a place to land before.
    expect(landingBefore(order, 'c', 'b', false)).toBe('d');
    expect(landingBefore(order, 'a', 'd', false)).toBeUndefined();
    expect(landingBefore(order, 'a', undefined, true)).toBeUndefined();
  });

  it('opens a gap the lifted item’s height: in its own run the items between slide, in another the ones after', () => {
    const sizes = [40, 40, 40, 40];
    // Item 3 carried up to before item 1: items 1 and 2 slide down, the item itself up to the slot.
    expect(slideOffsets(sizes, 3, 1, 40)).toEqual([0, 40, 40, -80]);
    // Item 0 carried to before item 2 (index 2 among the others): item 1 and 2 slide up, it slides down past them.
    expect(slideOffsets(sizes, 0, 2, 40)).toEqual([80, -40, -40, 0]);
    // Where it stands: nothing moves.
    expect(slideOffsets(sizes, 2, 2, 40)).toEqual([0, 0, 0, 0]);
    // Another run: everything from the landing place slides down by the carried item's height.
    expect(slideOffsets([30, 30, 30], undefined, 1, 50)).toEqual([0, 50, 50]);
    expect(slideOffsets([30, 30], undefined, undefined, 50)).toEqual([0, 0]);
    // Carried out of its run: the items after it close the place it left.
    expect(slideOffsets(sizes, 1, undefined, 40)).toEqual([0, 0, -40, -40]);
  });
});
