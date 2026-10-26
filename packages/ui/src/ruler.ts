/**
 * The zoom-aware ruler (docs/design.md, Density): every box a popup or an
 * overlay is placed by is measured with it.
 *
 * The density preference puts a CSS `zoom` on the root, for anything that
 * positions a fixed overlay. getBoundingClientRect answers in real screen
 * pixels, but a `top` set on a fixed element inside the zoomed root is
 * scaled on its way back — measured with one ruler, placed with the
 * other, a peek card landed a room away from its chip. Divide every
 * measured coordinate (and window.inner*) by this before assigning it;
 * offsetWidth/offsetHeight are already layout pixels and stay as read.
 *
 * The root is the page's own element unless a shell says otherwise: an
 * embedded shell wears its zoom on its own `.tw-root` and names it with
 * `measureFrom` (packages/mistri/src/embed/seams/shellHost.ts). The kit
 * reads these through core.js, under the names it always had.
 */

let root: () => Element = () => document.documentElement;
let zoomScale: number | null = null;

/** The element whose zoom the ruler divides by, for a shell that draws inside a page that is not its own. */
export function measureFrom(element: () => Element): void {
  root = element;
  zoomScale = null;
}

/** The zoom on the root. */
export function viewportScale(): number {
  /* Cached: the zoom is written in exactly one place (the density
     preference), but this is read per keystroke by the completion's caret
     math and per repaint by the pinned-column offsets — a fresh
     getComputedStyle on each read bought nothing. */
  zoomScale ??= Number(getComputedStyle(root()).zoom) || 1;
  return zoomScale;
}

/** Called by the density preference after it moves the root zoom. */
export function refreshViewportScale(): void {
  zoomScale = null;
}

/** An element's box in layout pixels — getBoundingClientRect, un-zoomed. */
export function viewportBox(node: Element): { top: number; bottom: number; left: number; right: number; width: number; height: number } {
  const z = viewportScale();
  const r = node.getBoundingClientRect();
  return {
    top: r.top / z,
    bottom: r.bottom / z,
    left: r.left / z,
    right: r.right / z,
    width: r.width / z,
    height: r.height / z,
  };
}

/** The viewport in the same layout pixels the boxes above use. */
export function viewportSize(): { width: number; height: number } {
  const z = viewportScale();
  return { width: window.innerWidth / z, height: window.innerHeight / z };
}
