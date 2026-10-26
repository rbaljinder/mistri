/**
 * This page's own writes, for the live stream that echoes them back.
 *
 * Every write the page sends is answered, and its caller then asks again what
 * it changed (recordWriteRefresh.ts). The same write then comes back on the
 * live stream, marked `self` (the reader's own account), a few hundred
 * milliseconds later. Taken as a change someone else made, it asked every read
 * the write's own refresh had just begun once more: a read that began before
 * the echo arrived had, by live sync's rule, begun before the change, so the
 * record page composed twice and every list and count on it was read twice,
 * and the composed answers were forgotten as a write's are, so each section
 * then asked on its own (a field report: 65 to 112 requests after one write).
 *
 * A change is in a read that began after it committed. The page's own write
 * had committed by the time it was answered, so its echo is measured from that
 * moment instead (liveInvalidate.ts): a read begun since already shows it and
 * is left alone, and only a read that began before it (one the write's own
 * refresh did not reach) is asked again. An echo that arrives while a write of
 * the page's is still out waits for its answer, so its refresh and the echo
 * agree on which reads are fresh.
 */

/** How long after the page's own write a `self` change is taken to be that write's echo. Short, since the same
    account writing in another tab within it would have its change taken for this page's: a read this page began
    between the two would not be asked again for it (the next change, focus or the counts' clock asks it). */
const ECHO_WINDOW_MS = 3_000;
/** The longest an echo waits for the page's writes still out to be answered. */
const ECHO_WAIT_MS = 10_000;

let out = 0;
let answered: { at: number; mark: number } | undefined;
let waiting: Array<() => void> = [];
/* The moment a write was answered, in the order reads begin in (recordWriteRefresh.ts liveMark). */
let marker: () => number = () => 0;

/** Where an answered write stands among the reads (recordWriteRefresh.ts installs it). */
export function setOwnWriteMarker(mark: () => number): void {
  marker = mark;
}

/** A write is going out: call what this returns once it is answered, or has failed. */
export function ownWriteSent(): () => void {
  out++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    out--;
    answered = { at: Date.now(), mark: marker() };
    if (out > 0) return;
    const ready = waiting;
    waiting = [];
    for (const resume of ready) resume();
  };
}

/** Whether a write of this page's is still out. */
export const ownWritesOut = (): boolean => out > 0;

/** Once every write of this page's that is out has been answered, or ECHO_WAIT_MS has passed. */
export function ownWritesAnswered(): Promise<void> {
  if (out === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ECHO_WAIT_MS);
    waiting.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** Where the page's last write was answered, when that was a moment ago; undefined when no write of the page's is that recent. */
export function ownWriteMark(): number | undefined {
  return answered && Date.now() - answered.at < ECHO_WINDOW_MS ? answered.mark : undefined;
}

/** Forget every write: the session or connection ended. */
export function forgetOwnWrites(): void {
  answered = undefined;
}
