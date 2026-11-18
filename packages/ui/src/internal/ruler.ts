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
 * embedded shell wears its zoom on its own `.mistri-root` and names it with
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

/*
 * The window's three bands, named once (docs/design.md, Mobile). A phone is up to 760px: one column, the
 * navigation in a drawer, a list drawn as cards. A tablet is 761–1100px: the navigation folded to its icon rail, a
 * record keeping its side column at 280px, a dashboard two-up. A desk is 1101px and wider. A media query measures
 * the window in CSS pixels before the root's zoom, so these are read with matchMedia, not against the ruler above;
 * the stylesheets say the same numbers in their @media rules, which cannot import them.
 */
const PHONE_MAX = 760;
const DESK_MIN = 1101;
export const PHONE_QUERY = `(max-width: ${PHONE_MAX}px)`;
export const TABLET_QUERY = `(min-width: ${PHONE_MAX + 1}px) and (max-width: ${DESK_MIN - 1}px)`;
