/**
 * Where the primitives' popups — a dialog, a menu, a listbox — are drawn.
 *
 * Undefined lets Base UI choose, which is the body, or the enclosing portal
 * for a popup inside a popup, which an explicit body would not keep. That is
 * right for a page of its own; a shell drawn inside another page (an embed)
 * names its own container with `drawPopupsIn`
 * (packages/mistri/src/embed/seams/shellHost.ts).
 */

let container: () => HTMLElement | undefined = () => undefined;

/** The container handed to Base UI's portals. */
export const popupContainer = (): HTMLElement | undefined => container();

/** Draw every popup in this container from now on. */
export function drawPopupsIn(where: () => HTMLElement | undefined): void {
  container = where;
}
