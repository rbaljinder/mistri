/**
 * What a behavior's change callback hears second, in this package's words (../changeDetails.ts): the reason, the hand
 * (a pointer, the keyboard or the page itself) and the event, as every control here says them, so a caller reads one
 * shape whether the change came from a listbox or from a card carried between lanes.
 *
 * A behavior's change can also be refused, which a control's cannot: `cancel()` leaves the value as it was (a card
 * that may not enter a lane, a day that cannot be picked), and `canceled` says whether anyone did. Both are UI SDK's
 * own and are handed on, live, with whatever else the behavior adds (the key that moved, the stretch that changed).
 *
 * The primitives themselves (`sortable`, `transfer`, …) are UI SDK primitives and say UI SDK's details; only the React
 * parts, which are what a component is built from, speak this package's.
 */
import type { ChangeDetails } from '../changeDetails.js';
import { told } from '../internal/told.js';

/** A behavior's change: this package's details, what the behavior adds to them, and the way to refuse it. */
export type Change<Reason extends string = string, More = unknown> = ChangeDetails<Reason> &
  More & {
    cancel: () => void;
    readonly canceled: boolean;
  };

type Said = { reason: string; source?: string; event?: unknown; cancel?: () => void; canceled?: boolean };

/* The details stand behind the ones handed on, so a field a behavior adds is read through, and `canceled` is asked
   of UI SDK when it is read and not copied when the callback starts. */
function change(said: Said): Change {
  const ours = told(said.reason, said);
  return Object.create(said, {
    source: { value: ours.source, enumerable: true },
    cancel: { value: () => said.cancel?.(), enumerable: true },
    canceled: { get: () => said.canceled === true, enumerable: true },
  }) as Change;
}

/**
 * A root's change callbacks, each hearing this package's details. Only the ones a caller gave are returned, so a root
 * is not told of a callback that is not there.
 */
export function heard<Names extends string>(callbacks: { [Name in Names]?: ((value: never, details: never) => void) | undefined }): {
  [Name in Names]?: (value: unknown, said: unknown) => void;
} {
  const out: Record<string, (value: unknown, said: unknown) => void> = {};
  for (const [name, callback] of Object.entries(callbacks) as [string, ((value: unknown, details: Change) => void) | undefined][])
    if (callback) out[name] = (value, said) => callback(value, change(said as Said));
  return out as { [Name in Names]?: (value: unknown, said: unknown) => void };
}
