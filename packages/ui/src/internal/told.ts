/**
 * What UI SDK says of a change, in the words every caller here reads second (changeDetails.ts): the primitive's own
 * reason, the hand that did it, and the DOM event where there was one. UI SDK names more hands than a caller does
 * (a pen, a touch, a screen reader's virtual click, an agent); to a caller each is a pointer or the page itself.
 */
import { changeSource, type ChangeDetails, type ChangeSource } from '../changeDetails.js';

/** The part of UI SDK's change details this reads. */
type Said = { source?: string; event?: unknown } | undefined;

/** UI SDK's details in this package's shape, under the reason the primitive gives its callers. */
export function told<Reason extends string>(reason: Reason, said: Said): ChangeDetails<Reason> {
  const event = typeof Event !== 'undefined' && said?.event instanceof Event ? said.event : undefined;
  /* UI SDK calls an event a script sent `programmatic`. The rule here is that a change with an event behind it came
     from a hand, and only a change with none is the page's, so the event is read for its hand as any other is. */
  const source: ChangeSource =
    said?.source === 'keyboard'
      ? 'keyboard'
      : !said || said.source === 'agent'
        ? 'program'
        : said.source === 'programmatic'
          ? changeSource(event)
          : 'pointer';
  return event ? { reason, source, event } : { reason, source };
}
