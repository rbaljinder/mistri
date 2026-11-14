import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { transfer } from './transfer';

const parts = createParts(transfer, { root: 'div', list: 'ul', item: 'li', handle: 'button' });

/* The React parts of things moved between lists (./transfer.ts is the primitive):

     <Transfer value={lists} onValueChange={setLists} accepts={(key, list) => …}>
       <TransferList value="todo" aria-label="To do">
         {(key) => (
           <TransferItem value={key}>
             <TransferHandle aria-label={`Carry ${names[key]}`} />
             {names[key]}
           </TransferItem>
         )}
       </TransferList>
       …
     </Transfer>

   A list draws its items as they stand now, the carried one where it would land, so a caller says how one item is
   drawn. `around` is for a list with more in it than its items: it is handed the items and what the list knows
   while something is carried (`over`, `takes`, `refuses`, the carried key), to say so in a heading or an empty
   place.

   Slots: `transfer`, `transfer-list` (`data-list`, `data-takes`, `data-refuses`, `data-over`), `transfer-item`
   (`data-carried`, `data-dragging`) and `transfer-handle` (`data-carried`). */
export const Transfer = parts.Root;

export type TransferListState = { keys: string[]; over: boolean; takes: boolean; refuses: boolean; carrying: string | null };

export function TransferList({
  children,
  around,
  ...props
}: Omit<ComponentProps<typeof parts.List>, 'children'> & {
  children: (key: string, at: number) => ReactNode;
  around?: (items: ReactNode, state: TransferListState) => ReactNode;
}) {
  return (
    <parts.List {...props}>
      {(state) => {
        const items = state.keys.map((key, at) => children(key, at));
        return around ? around(items, state) : items;
      }}
    </parts.List>
  );
}

export const TransferItem = parts.Item;
export const TransferHandle = parts.Handle;
