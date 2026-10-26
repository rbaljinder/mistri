/**
 * The answers the page arrived with (shared/firstPaint.ts says why): its
 * data block read once, and each answer handed to the request it answers,
 * once. A refetch, a second look, a request built any other way goes out as
 * it always did.
 *
 * They are the page's, and only for its first moments: none outlives
 * LIFETIME, the session identity it was first read under, or the next write
 * (core.js forgets them as it forgets a record page's composed answers).
 */
import {
  FIRST_PAINT_ELEMENT,
  itemKey,
  readKey,
  type FirstPaintData,
  type FirstPaintItemKind,
  type FirstPaintRead,
} from '@mistriwork/engine/shared/firstPaint.js';
import { sessionIdentity } from './sessionIdentity.js';
import { shellById } from './shellHost.js';

/* Long enough for the first room and what it asks as it draws, and no
   longer: past it every read is the reader's own again. */
const LIFETIME = 15_000;

let data: FirstPaintData | null | undefined;
let until = 0;
let owner: ReturnType<typeof sessionIdentity> | undefined;

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** The page's data, read from its block the first time it is asked for; the block goes with it. */
function held(): FirstPaintData | null {
  if (data === undefined) {
    data = null;
    const block = typeof document === 'undefined' ? null : shellById(FIRST_PAINT_ELEMENT);
    if (block) {
      try {
        const parsed: unknown = JSON.parse(block.textContent ?? '');
        if (isRecord(parsed) && isRecord(parsed.reads) && isRecord(parsed.items)) data = parsed as unknown as FirstPaintData;
      } catch {
        /* A block that does not read is no block: everything is asked. */
      }
      block.remove();
      until = Date.now() + LIFETIME;
    }
  }
  if (!data) return null;
  /* Who the answers are for is settled by the first of them, who-am-I; a
     session that changes after it (another account signed in, a sign-out)
     is not the page's reader any more. */
  const identity = sessionIdentity();
  if (Date.now() > until || (owner && identity !== owner)) {
    data = null;
    return null;
  }
  if (!owner && identity.mode !== 'unknown') owner = identity;
  return data;
}

/** The answer the page carries for this request, once, or undefined. */
export function firstPaintRead(method: 'GET' | 'POST', url: string, payload?: unknown): FirstPaintRead | undefined {
  const reads = held()?.reads;
  if (!reads) return undefined;
  const key = readKey(method, url, payload);
  if (!Object.hasOwn(reads, key)) return undefined;
  const read = reads[key];
  delete reads[key];
  return read;
}

/** The answer the page carries for one read a batch would carry, once, or undefined. */
export function firstPaintItem(kind: FirstPaintItemKind, connection: string | null | undefined, item: unknown): unknown {
  const items = held()?.items;
  if (!items || !connection) return undefined;
  const key = itemKey(kind, connection, item);
  if (!Object.hasOwn(items, key)) return undefined;
  const answer = items[key];
  delete items[key];
  // Boot may have fetched who-am-I when its inline answer exceeded the cap.
  // Bind each item to the actual reader even on the block's first use.
  const identity = sessionIdentity();
  if (identity.mode === 'unknown' || identity.mode === 'locked' || (answer.account ?? null) !== identity.accountId) return undefined;
  return answer.body;
}

/** Every answer forgotten: after a write, what the page was sent is not the data any more. */
export function forgetFirstPaint(): void {
  data = null;
}

/** For tests: read the page's block again, as a new page would. */
export function rereadFirstPaint(): void {
  data = undefined;
  owner = undefined;
}
