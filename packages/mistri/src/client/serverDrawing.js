/**
 * Whether the server drew this public page's content pane, and which:
 * `data-ssr` on the pane names the kind (server/publicRender.ts). Asked once,
 * by the surface that draws that kind, which then takes the markup over in
 * place; the mark is cleared either way, so a later draw starts afresh. Any
 * other content — a shell room replacing a server-drawn document — clears
 * the pane as it always did.
 *
 * The taking over is here, in the public chunk, and not in mount.tsx, which
 * every surface loads: only a public page is ever drawn by the server.
 */
import { hydrateRoot } from 'react-dom/client';

/* A page that differs from the server's copy is drawn afresh by React, quietly: the copy was a courtesy. */
const quietly = () => {};

/**
 * The starter for mount.tsx that takes the server's markup over, or
 * undefined when the pane is not the server's drawing of this kind.
 * @param {Element} host
 * @param {'landing' | 'form'} kind
 * @returns {((host: Element, tree: import('react').ReactNode) => import('react-dom/client').Root) | undefined}
 */
export function takeServerDrawing(host, kind) {
  const drawn = host.getAttribute('data-ssr') === kind && host.childElementCount > 0;
  host.removeAttribute('data-ssr');
  return drawn ? (at, tree) => hydrateRoot(at, tree, { onRecoverableError: quietly }) : undefined;
}
