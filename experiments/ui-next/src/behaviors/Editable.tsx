import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { editable } from './editable';

const parts = createParts(editable, { root: 'div', value: 'span', input: 'input' });

/* The React parts of values edited in place (./editable.ts is the primitive). The root lays nothing out
   (`display: contents`) and hands down which value is being edited, so the composer draws the box in its place:

     <Editable text={(id) => texts[id]} onCommit={(id, text) => save(id, text)}>
       {(editing) => (
         <EditableValue value="rent" press tabIndex={0}>
           {editing === 'rent' ? <EditableInput aria-label="Rent" /> : money(rent)}
         </EditableValue>
       )}
     </Editable>

   Slots: `editable` (`data-editing`), `editable-value` (`data-editing`, `data-locked`) and `editable-input`. */
export function Editable({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children'> & {
  children: (editing: string | null) => ReactNode;
}) {
  return <parts.Root {...props}>{(state) => children(state.editing)}</parts.Root>;
}

export const EditableValue = parts.Value;
export const EditableInput = parts.Input;
