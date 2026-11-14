import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { scrub } from './scrub';

const parts = createParts(scrub, { root: 'div', track: 'div' });

/* The React parts of a scrub (./scrub.ts is the primitive). The root hands the position being read to its
   children, so whatever is drawn for it (a hairline, a readout) is the caller's:

     <Scrub count={months.length} text={(at) => `${months[at]}: ${said(at)}`}>
       {(at) => (
         <ScrubTrack aria-label="Rent collected">
           <svg>…{at !== null && <line x1={x(at)} x2={x(at)} … />}</svg>
         </ScrubTrack>
       )}
     </Scrub>

   Slots: `scrub` (`data-scrubbing`) and `scrub-track` (`data-at`). */
export function Scrub({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children'> & {
  children: (at: number | null, last: number) => ReactNode;
}) {
  return <parts.Root {...props}>{(state) => children(state.at, state.last)}</parts.Root>;
}

export const ScrubTrack = parts.Track;
