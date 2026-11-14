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
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { type Change, heard } from './heard.js';
import { scrub, type ScrubReason } from './scrub.js';

const parts = createParts(scrub, { root: 'div', track: 'div' });

export function Scrub({
  children,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children' | 'onValueChange'> & {
  children: (at: number | null, last: number) => ReactNode;
  onValueChange?: (value: number | null, details: Change<ScrubReason>) => void;
}) {
  return (
    <parts.Root {...props} {...heard({ onValueChange })}>
      {(state) => children(state.at, state.last)}
    </parts.Root>
  );
}

export const ScrubTrack = parts.Track;
