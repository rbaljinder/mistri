/**
 * What is on the other end of a reference, without going there.
 *
 * `sold_by 4` is not an answer. It is a promise that an answer exists in
 * another table, and collecting it costs a navigation, a look, and a click
 * back — by which time you have lost the row you were reading. That round
 * trip is the tax this tool charges on the thing it is best at, and most of
 * the time the question is small: *who is 4?*
 *
 * So a reference answers itself on hover — the card is `components/Peek.tsx`.
 * This module is the seam the vanilla client still uses: the marker that
 * makes an element peekable, the layer's one mount, and the cache reset.
 */
import { createElement } from 'react';
import { mount, queryClient } from './components/mount.js';
import { PeekLayer } from './components/Peek.js';
import { sessionIdentity, subscribeSessionIdentity } from './sessionIdentity.js';
import { portalRoot } from './shellHost.js';

let host = null;

/**
 * Emptied when the schema changes underneath the cached rows.
 *
 * The connection key separates databases, not accounts or tenant generations.
 * Identity changes also retire the mounted layer's hover timer and target.
 */
export function clearPeekCache() {
  queryClient.removeQueries({ queryKey: ['peek'] });
}

/** One layer for the whole page, listening on the document. */
export function initPeek() {
  if (host?.isConnected) return;
  host = document.createElement('div');
  host.className = 'peek-host';
  portalRoot().append(host);
  mount(host, createElement(PeekLayer, { key: sessionIdentity().epoch }));
}

subscribeSessionIdentity(() => {
  clearPeekCache();
  if (host?.isConnected) mount(host, createElement(PeekLayer, { key: sessionIdentity().epoch }));
});

/** Mark an element as a reference worth peeking at. */
export function peekable(node, references, value) {
  if (!references || value === null || value === undefined || value === '') return node;
  node.dataset.refTable = references.table;
  node.dataset.refColumn = references.column;
  node.dataset.refValue = String(value);
  return node;
}
