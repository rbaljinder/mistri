import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { sortable } from './sortable';

const parts = createParts(sortable, { root: 'div', item: 'div', handle: 'button' });

/* The sortable list's React parts (./sortable.ts is the primitive). The root draws its items in the order they
   stand in now, which while one is being moved is the order it would leave them in, so a caller says how one item
   is drawn and never keeps a second copy of the order:

     <Sortable value={order} onValueChange={setOrder} aria-label="Columns">
       {(key) => <SortableItem value={key}>{names[key]}</SortableItem>}
     </Sortable>

   An item with controls of its own is picked up by a handle instead (`by="handle"`):

     <Sortable by="handle" …>
       {(key) => (
         <SortableItem value={key}>
           <SortableHandle aria-label={`Move ${names[key]}`} />
           <Checkbox … /> {names[key]}
         </SortableItem>
       )}
     </Sortable>

   Each part takes `render`, `className` and `style` as UI SDK's own parts do, and carries `data-slot="sortable"`,
   `"sortable-item"` or `"sortable-handle"` with `data-sorting`, `data-grabbed`, `data-dragging` and
   `data-disabled` for a stylesheet. */
export function Sortable({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children'> & { children: (key: string, at: number) => ReactNode }) {
  return <parts.Root {...props}>{({ order }) => order.map((key, at) => children(key, at))}</parts.Root>;
}

export const SortableItem = parts.Item;
export const SortableHandle = parts.Handle;
