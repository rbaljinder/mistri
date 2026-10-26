/**
 * What the client is still waiting for: every API request and every part
 * of the client fetched on demand, from the moment it is asked until it
 * answers.
 *
 * A navigation reads it (navigationHold.ts): the room it opened is complete
 * when nothing asked since the navigation began is still out. Counted by
 * when each piece of work began rather than in total, so a slow request the
 * old room started — or a notification poll — never holds the new one.
 *
 * Depends on nothing, so core.js and the on-demand loader can both report
 * to it.
 */

let clock = 0;
const out = new Set<number>();

/** A piece of work begins; call what it returns when it has ended, however it ended. */
export function beginWork(): () => void {
  const ticket = ++clock;
  out.add(ticket);
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    out.delete(ticket);
  };
}

/** A mark to compare later work against: everything begun after it is newer. */
export const workMark = (): number => clock;

/** Whether any work begun after `mark` is still out. */
export function workSince(mark: number): boolean {
  for (const ticket of out) if (ticket > mark) return true;
  return false;
}
