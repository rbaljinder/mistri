/** One owner for picker switches, deep-link switches and schema refreshes. */
/** Tiny lifetime signal in the existing eager owner. Flag state/validation are
 * imported only by the SDK; an App without components pays no transport cost. */
let presentationGeneration = 0,
  presentationAvailable = false;
const presentationListeners = new Set<() => void>();
export const appPresentation = () => ({ generation: presentationGeneration, available: presentationAvailable });
export function replaceAppPresentation(ready = false): void {
  ++presentationGeneration;
  presentationAvailable = ready;
  for (const listener of [...presentationListeners]) {
    try {
      listener();
    } catch {
      /* Observers cannot veto retirement. */
    }
  }
}
export function subscribeAppPresentation(listener: () => void): () => void {
  presentationListeners.add(listener);
  return () => {
    presentationListeners.delete(listener);
  };
}
let generation = 0;
let pending = false;

export const connectionGeneration = (): number => generation;
export const connectionTransitionPending = (): boolean => pending;

export function beginConnectionTransition() {
  replaceAppPresentation();
  const started = ++generation;
  pending = true;
  const isCurrent = () => started === generation;
  return {
    isCurrent,
    finish: () => {
      if (isCurrent()) pending = false;
    },
  };
}
