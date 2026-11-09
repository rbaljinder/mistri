/**
 * A review a page showed before a run (`useCommand(...).prepare`): the record's revision the server prepared, held
 * under an opaque token, and whether a change has reached that record since. A run that hands the review back is sent
 * for exactly that revision and never prepared again (sdk/commands.tsx), so what the person reviewed is what the
 * server judges: a record that moved is refused `stale`, not silently run over a revision nobody saw.
 *
 * Nothing here is server state. The token names the revision the prepare already returns; the server's own check of
 * that revision is what refuses. `fresh` is the browser's early word on it, from live sync (liveInvalidate.ts), so
 * the page can show the review again before anyone presses Run.
 */
import { liveKeyText } from '@mistriwork/kit/client/liveState.js';

interface Held {
  /** The command, its version and the record, as the run that takes the review must name them. */
  readonly owner: string;
  readonly table: string;
  readonly key: string;
  readonly expectedVersion: number;
  fresh: boolean;
}

/* A page keeps a few reviews open at most; the oldest let go first, and a token no longer held is a stale review. */
const MOST = 200;
const held = new Map<string, Held>();
const listeners = new Set<() => void>();
let made = 0;

const announce = () => {
  for (const listener of [...listeners]) listener();
};

/** The owner text a review is held for: the run that hands it back must be the same command on the same record. */
export const reviewOwner = (connection: string, command: string, commandVersion: number, key: Readonly<Record<string, unknown>>) =>
  JSON.stringify([connection, command, commandVersion, liveKeyText(key)]);

/** Hold a prepared revision for review; the token is what the page hands back with the run. */
export function holdReview(owner: string, table: string, key: Readonly<Record<string, unknown>>, expectedVersion: number): string {
  // Not a secret: the server judges the revision again on the run. Unique in this tab is all it has to be.
  const token = `r${(++made).toString(36)}.${Math.random().toString(36).slice(2, 10)}`;
  held.set(token, { owner, table, key: liveKeyText(key), expectedVersion, fresh: true });
  while (held.size > MOST) held.delete(held.keys().next().value!);
  announce();
  return token;
}

/** The review a token names, where this tab still holds it. */
export const heldReview = (token: string): Readonly<Held> | undefined => held.get(token);

/** Whether the review a token names still reads the record as it is: false once a change reached it, or let go. */
export const reviewFresh = (token: string | undefined): boolean => (token === undefined ? false : (held.get(token)?.fresh ?? false));

/** A token's review gone stale: the server refused it, so the page shows the record again before another run. */
export function staleReview(token: string): void {
  const review = held.get(token);
  if (!review?.fresh) return;
  review.fresh = false;
  announce();
}

/**
 * Changes live sync heard (liveInvalidate.ts): the reviews of those records go stale; a change that named no keys
 * (`'many'`) stales every review of its table, and a reset (`undefined` table) every review. The page's own write
 * counts too: what it changed is no longer what was reviewed.
 */
export function staleReviews(table?: string, keys?: Iterable<string> | 'many'): void {
  const named = keys === undefined || keys === 'many' ? undefined : new Set(keys);
  let moved = false;
  for (const review of held.values()) {
    /* A form command's review names no table: no change can move what it showed, a reset included. */
    if (!review.fresh || review.table === '' || (table !== undefined && review.table !== table) || (named && !named.has(review.key)))
      continue;
    review.fresh = false;
    moved = true;
  }
  if (moved) announce();
}

/** For useSyncExternalStore: a component reading `reviewFresh` draws again when any review goes stale. */
export function subscribeReviews(listener: () => void): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

/** Forget every review (tests; a session the page lets go of). */
export function resetReviews(): void {
  held.clear();
  announce();
}
