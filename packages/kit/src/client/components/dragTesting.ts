/**
 * A drag as the pointer engine (usePointerDrag.tsx) hears it, for the
 * component tests: a mouse press on the source, a move past the slop over
 * each target, and a release. happy-dom lays nothing out, so the page's hit
 * test is stood in by the target itself, and every box has no height — a
 * drop on an item lands before it.
 */
import { fireEvent } from '@testing-library/react';

const pointer = (x: number) => ({ pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, clientX: x, clientY: x });

export function pressToDrag(source: Element) {
  const original = document.elementFromPoint;
  const originals = document.elementsFromPoint;
  let under: Element | null = null;
  let x = 0;
  document.elementFromPoint = () => under;
  document.elementsFromPoint = () => (under ? [under] : []);
  const done = () => {
    document.elementFromPoint = original;
    document.elementsFromPoint = originals;
  };
  fireEvent.pointerDown(source, pointer(x));
  const over = (target: Element) => {
    under = target;
    x += 10;
    fireEvent.pointerMove(window, pointer(x));
  };
  return {
    over,
    /** Let go over `target`, or where the last move left it. */
    drop(target?: Element) {
      if (target) over(target);
      fireEvent.pointerUp(window, pointer(x));
      done();
    },
    /** Escape: the item goes back. */
    cancel() {
      fireEvent.keyDown(window, { key: 'Escape' });
      done();
    },
  };
}

/** Drag `source` over `target` and let it go there. */
export const dragOnto = (source: Element, target: Element) => pressToDrag(source).drop(target);
