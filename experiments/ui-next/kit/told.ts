import type { ChangeDetails } from '@mistriwork/ui/changeDetails.js';

/* What UI SDK says of a change, in the words every mistri caller reads second: the primitive's own reason, the
   hand that did it, and the DOM event where there was one. UI SDK names more hands than mistri does (a pen, a
   touch, a screen reader's virtual click, an agent); to a caller each is a pointer or the page itself. */
type Said = { source?: string; event?: unknown } | undefined;

export function told<Reason extends string>(reason: Reason, said: Said): ChangeDetails<Reason> {
  const source =
    said?.source === 'keyboard' ? 'keyboard' : !said || said.source === 'programmatic' || said.source === 'agent' ? 'program' : 'pointer';
  return said?.event instanceof Event ? { reason, source, event: said.event } : { reason, source };
}
