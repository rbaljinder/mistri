/**
 * A nudge, in this process, that a command wrote facts: the `--jobs` host
 * listens so an idle loop that has backed off to its ceiling looks again at
 * once instead of up to half a minute later.
 *
 * A signal carries nothing — no receipt, no tenant, no event — and grants
 * nothing: a host that wakes still reads only what its stores attest. It is
 * sent while the writing transaction is still open, so the first look may
 * find nothing yet; the host then polls from its shortest wait again, which
 * sees the commit within a second. A fact written by another process is not
 * signalled here; the host's longest wait bounds how late it is seen.
 */
const listeners = new Set<() => void>();

/** Called on every append; returns the unsubscribe. */
export function onCommandEvents(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** A batch of command facts was just appended in this process. */
export function commandEventsAppended(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* A listener's failure is its own; the write goes on. */
    }
  }
}
