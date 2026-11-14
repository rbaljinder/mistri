/* The React parts of a list worked one at a time (./turns.ts is the primitive). The root hands what is in hand
   and how far along the reader is to its children:

     <Turns keys={ids} value={answered} onValueChange={setAnswered}>
       {({ current, handled, total }) =>
         current ? (
           <>
             <p>{handled.length + 1} of {total}</p>
             <TurnsName>{name(current)}</TurnsName>
             <TurnsSkip>Skip</TurnsSkip>
           </>
         ) : (
           <TurnsName>All done</TurnsName>
         )
       }
     </Turns>

   To finish the one in hand from a component of your own, make the instance with `usePrimitive(turns, …)` from
   `@ui-sdk/react/primitive` and call its `api.finish()`: the library's `Queue` does, once a verb has settled.

   Slots: `turns` (`data-done`), `turns-name` and `turns-skip`. */
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps } from 'react';
import { type Change, heard } from './heard.js';
import { turns, type TurnsReason } from './turns.js';

const parts = createParts(turns, { root: 'div', name: 'h2', skip: 'button' });

export function Turns({
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'onValueChange'> & {
  onValueChange?: (value: string[], details: Change<TurnsReason>) => void;
}) {
  return <parts.Root {...props} {...heard({ onValueChange })} />;
}
export const TurnsName = parts.Name;
export const TurnsSkip = parts.Skip;
