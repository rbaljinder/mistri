/**
 * An anchor for Base UI's positioners, measured with the house ruler.
 *
 * The density preference puts a `zoom` on the root, so a box measured with
 * getBoundingClientRect comes back in screen pixels while a `top` set on a
 * positioned element inside the root is scaled on its way back — measured
 * with one ruler, placed with the other, a list landed a room away from
 * its trigger. Floating UI corrects for transforms on an offset parent but
 * not for a zoom on the root, so the anchor it is handed is a virtual
 * element that reports the trigger's box already divided by the zoom
 * (ruler.ts `viewportBox`), and every coordinate it derives is a layout
 * pixel the browser scales back exactly once.
 */
import { viewportBox, viewportSize } from './ruler.js';

interface VirtualAnchor {
  getBoundingClientRect: () => DOMRect;
  contextElement: Element;
}

export function zoomAnchor(element: Element): VirtualAnchor {
  return {
    contextElement: element,
    getBoundingClientRect: () => {
      const b = viewportBox(element) as { top: number; left: number; right: number; bottom: number; width: number; height: number };
      return {
        x: b.left,
        y: b.top,
        top: b.top,
        left: b.left,
        right: b.right,
        bottom: b.bottom,
        width: b.width,
        height: b.height,
        toJSON: () => b,
      } as DOMRect;
    },
  };
}

/**
 * The viewport, in the same layout pixels the anchor reports, for the
 * positioner's collision boundary — so "is there room below" is answered
 * on the ruler the anchor was measured with. Positioners retain this object
 * across viewport resizes without re-rendering their owning control, so read
 * its dimensions when collision detection runs, not when JSX was rendered.
 */
export function layoutViewport(): { x: number; y: number; width: number; height: number } {
  return {
    x: 0,
    y: 0,
    get width() {
      return viewportSize().width;
    },
    get height() {
      return viewportSize().height;
    },
  };
}
