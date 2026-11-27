/**
 * The assistant's door, reachable from a page: `useAssistant().open(...)` opens
 * the panel the App bar's button opens (AssistantTrigger.tsx), with the record
 * the person is on as its context and words in the box. Opening never sends:
 * the words are the reader's to edit and send, as a composer's fill is.
 *
 * One slot, held while the door is mounted, which is wherever the App serves
 * this reader an assistant and nowhere else: without it, `open` answers false.
 */
export interface AssistantHandoff {
  /** The record the person is on, by its table and id: read and named by the server as them (`/api/assistant/about`). */
  about?: { table: string; id: string | number };
  /** Words put in the box, never sent. */
  text?: string;
  /** Optional presentation mode to open the panel in (`'sidebar'`, `'floating'`, `'fullscreen'`). */
  mode?: 'sidebar' | 'floating' | 'fullscreen';
}

let held: ((handoff: AssistantHandoff) => void) | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of [...listeners]) listener();
};

/** The door takes the slot while it is mounted; the returned function gives it back. */
export function holdAssistantDoor(open: (handoff: AssistantHandoff) => void): () => void {
  held = open;
  notify();
  return () => {
    if (held === open) {
      held = null;
      notify();
    }
  };
}

/** Subscribes to the door mounting and leaving (`useSyncExternalStore`). */
export function subscribeAssistantDoor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether a door is mounted: the App serves this reader an assistant. */
export function assistantDoorOpen(): boolean {
  return held !== null;
}

/** Opens the panel with what a page hands it; false where there is no assistant for this reader. */
export function openAssistantDoor(handoff: AssistantHandoff): boolean {
  if (!held) return false;
  held(handoff);
  return true;
}
