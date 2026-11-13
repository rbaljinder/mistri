/**
 * What every change callback here hears second: why the value moved and what moved it. A caller that only wants the
 * value ignores it; one that must tell a person's choice from its own (a filter that should not save when the page set
 * it, a dialog closed by Escape rather than by Save) reads it instead of keeping a flag beside the control.
 *
 * `reason` is Base UI's word where Base UI gives one (`trigger-press`, `outside-press`, `escape-key`, `item-press`,
 * `focus-out` …) and otherwise one short word per primitive; each callback's type lists the words it can hear.
 * `source` is the hand that did it. `event` is the DOM event behind it, absent when the page made the change.
 */
export type ChangeSource = 'pointer' | 'keyboard' | 'program';

export interface ChangeDetails<Reason extends string = string> {
  reason: Reason;
  source: ChangeSource;
  event?: Event;
}

/* The hand behind an event that does not say so itself: an `input` from a range dragged or typed, a `change` from a
   native select. The last key or pointer press on the page is that hand, as a browser's own :focus-visible guesses. */
let lastHand: ChangeSource = 'program';
let listening = false;
function listen(): void {
  if (listening || typeof document === 'undefined') return;
  listening = true;
  document.addEventListener('keydown', () => (lastHand = 'keyboard'), { capture: true, passive: true });
  document.addEventListener('pointerdown', () => (lastHand = 'pointer'), { capture: true, passive: true });
}
// From load, not from the first change: that change's own press came before anything asked.
listen();

/* The one fallback for every change that came from a person's hand but whose hand cannot be read off its own event: the
   last key or pointer press on the page, and a pointer where there has been none yet (an autofill, a change before any
   press). A change that carries an event, or that a kit reports, is never `program`: only a change with no event is. */
function lastKnownHand(): Exclude<ChangeSource, 'program'> {
  listen();
  return lastHand === 'program' ? 'pointer' : lastHand;
}

/** The hand behind an event: `program` when there is none. */
export function changeSource(event: Event | undefined): ChangeSource {
  if (!event) return 'program';
  if (typeof KeyboardEvent !== 'undefined' && event instanceof KeyboardEvent) return 'keyboard';
  /* Enter and Space on a button arrive as a click that counted no presses, but so does a pointer's click where nothing
     counts them (a test's synthetic one), so the press that came before it decides. */
  if (event.type === 'click' && (event as MouseEvent).detail === 0) return lastKnownHand();
  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) return 'pointer';
  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) return 'pointer';
  return lastKnownHand();
}

/** Details for a change this module's own code makes: a React event's native event, or none when the page did it. */
export function changeDetails<Reason extends string>(reason: Reason, event?: Event | { nativeEvent: Event }): ChangeDetails<Reason> {
  // Typed by hand: the client's JSDoc check reads this module without strict null checks, and loses the narrowing.
  const native: Event | undefined = event && 'nativeEvent' in event ? event.nativeEvent : (event as Event | undefined);
  return native ? { reason, source: changeSource(native), event: native } : { reason, source: 'program' };
}

/* Details for a change a control kit reported without them (a kit may leave them out). The change came from the kit's
   control, so it was a person's hand, not the page's: a caller that skips `program` changes must not skip these too.
   The last key or pointer press is the best word for which hand. */
export function keptDetails<Reason extends string>(reason: Reason): ChangeDetails<Reason> {
  return { reason, source: lastKnownHand() };
}

/** Base UI's details in this shape, its reason kept, or this primitive's own word where Base UI says only `none`: a raw
    `none` never reaches a caller, who could not tell which of Base UI's unnamed changes it heard. */
export function fromBaseUi<Reason extends string, Own extends string>(
  details: { reason: Reason; event: Event },
  own: Own,
): ChangeDetails<Exclude<Reason, 'none'> | Own>;
export function fromBaseUi(details: { reason: string; event: Event }, own: string): ChangeDetails {
  const reason = details.reason === 'none' ? own : details.reason;
  // Base UI stands an Event named `base-ui` in for the one it did not have: the page made that change.
  const event = details.event?.type === 'base-ui' ? undefined : details.event;
  return event ? { reason, source: changeSource(event), event } : { reason, source: 'program' };
}
