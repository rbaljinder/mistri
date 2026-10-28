/**
 * A first page's data, carried in the page itself (server/http/firstPaint.ts
 * writes it, client/firstPaint.ts reads it).
 *
 * The shell used to arrive empty and ask for everything it draws in three
 * rounds — who is here, then the runtime, then the App, its schema, its
 * pages and saved views together — and only then the first room's rows:
 * four round trips before a first page, each a network's latency. The
 * server knows the address when it sends the page, so it asks those same
 * requests of itself, through the same routes and gate a fetch reaches, and
 * writes each answer into the page under the request it answers. The client
 * asks as it always did; a request the page already answers is answered
 * from it, once, and any other goes out.
 *
 * An answer is keyed by the request exactly as the client sends it: the
 * method, the address with its query string and the JSON body, the App's
 * selector included (requestIdentity.ts). A read that a batch carries — a
 * dashboard's breakdowns and lists, the menu's and a list's tab counts — is
 * keyed by the one item, because which items share a batch depends on what a
 * paint mounted together, which the server cannot know and need not.
 *
 * Imports nothing but the key text, so the entry chunk carries no more than this.
 */
import { canonicalText } from './recordReadKeys.js';

/** The id of the page's data block: `<script type="application/json" id=…>`, never run. */
export const FIRST_PAINT_ELEMENT = 'mistri-first-paint';

/** One answer: the reply's JSON and the account the reply said it was for (`x-mistri-account`), as a fetch would have been told. */
export interface FirstPaintRead {
  body: unknown;
  account?: string;
  /** The tables it answered from (`mistri-reads`), where a reply's header would have said: live sync asks it again only when one changes. */
  reads?: string;
}

/** What the page carries. `reads` by readKey, `items` by itemKey. */
export interface FirstPaintData {
  reads: Record<string, FirstPaintRead>;
  items: Record<string, FirstPaintRead>;
}

/** A request as the client sends it: `GET /api/app?app=compass`, or a POST and its body. */
export function readKey(method: 'GET' | 'POST', url: string, payload?: unknown): string {
  return `${method} ${url}\u0000${payload === undefined ? '' : canonicalText(payload)}`;
}

/**
 * One read a batch carries, on the connection it goes to: a breakdown
 * (`{ text, limit }` or `{ def, limit }`), a list's rows (the `run` a
 * dashboard's table asks) or a count (`{ q, countLimit }`), each as its item
 * is sent.
 */
export type FirstPaintItemKind = 'breakdown' | 'run' | 'count';
export function itemKey(kind: FirstPaintItemKind, owner: string, item: unknown): string {
  return `${kind}\u0000${owner}\u0000${canonicalText(item)}`;
}
