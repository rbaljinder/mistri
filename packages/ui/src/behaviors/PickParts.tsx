/* The React parts of one picked from a list and shown beside it (./pick.ts is the primitive):

     <Pick keys={ids} value={open} onValueChange={setOpen} follow={wide}>
       <PickList aria-label="Residents">
         {ids.map((id) => (
           <PickOption key={id} value={id}>{name(id)}</PickOption>
         ))}
       </PickList>
       <PickPane aria-label={open ? name(open) : 'Residents'}>
         {open ? <Resident id={open} /> : 'Pick one to read it here.'}
       </PickPane>
     </Pick>

   Which of the list and the pane is drawn is the caller's: where only one is in view, draw the pane once
   something is picked, with a `PickBack` in it, and the list otherwise.

   Slots: `pick` (`data-picked`), `pick-list`, `pick-option` (`data-key`, `data-picked`), `pick-pane`
   (`data-empty`) and `pick-back`. */
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps } from 'react';
import { type Change, heard } from './heard.js';
import { pick, type PickReason } from './pick.js';

const parts = createParts(pick, { root: 'div', list: 'ul', option: 'li', pane: 'section', back: 'button' });

export function Pick({
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'onValueChange'> & {
  onValueChange?: (value: string | null, details: Change<PickReason>) => void;
}) {
  return <parts.Root {...props} {...heard({ onValueChange })} />;
}
export const PickList = parts.List;
export const PickOption = parts.Option;
export const PickPane = parts.Pane;
export const PickBack = parts.Back;
