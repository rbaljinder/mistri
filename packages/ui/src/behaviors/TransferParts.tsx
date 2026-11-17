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
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { type CommitProps, movedLists, PendingProvider, useCommit, usePending } from './commit.js';
import { type Change, heard } from './heard.js';
import { transfer, type TransferMove, type TransferReason } from './transfer.js';

const parts = createParts(transfer, { root: 'div', list: 'ul', item: 'li', handle: 'button' });

type Lists = Record<string, string[]>;
type TransferChange = Change<TransferReason, TransferMove>;

/* With `onCommit` (./commit.tsx) a move is asked about before it is final: the item is `data-pending` meanwhile, and a
   refusal puts it back in the list it came from. */
export function Transfer({
  onValueChange,
  onCommit,
  commitDelay,
  value,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'onValueChange' | 'value' | 'defaultValue'> & {
  value?: Lists;
  defaultValue?: Lists;
  onValueChange?: (value: Lists, details: TransferChange) => void;
} & CommitProps<Lists, TransferChange>) {
  const commit = useCommit<Lists, TransferChange>({ value, defaultValue, onValueChange, onCommit, commitDelay, moved: movedLists });
  const root = (
    <parts.Root {...props} value={commit.value} defaultValue={commit.defaultValue} {...heard({ onValueChange: commit.onValueChange })} />
  );
  return commit.pending ? <PendingProvider value={commit.pending}>{root}</PendingProvider> : root;
}

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

export function TransferItem(props: ComponentProps<typeof parts.Item>) {
  return <parts.Item {...props} {...usePending(props.value)} />;
}
export const TransferHandle = parts.Handle;
