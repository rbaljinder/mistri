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
import { createParts } from '@ui-sdk/react/primitive';
import { type ComponentProps, Fragment, type ReactNode } from 'react';
import { type CommitProps, movedKeys, PendingProvider, useCommit, usePending } from './commit.js';
import { type Change, heard } from './heard.js';
import { sortable, type SortableReason } from './sortable.js';

const parts = createParts(sortable, { root: 'div', item: 'div', handle: 'button' });

/* With `onCommit` (./commit.tsx) a move is asked about before it is final: the item is `data-pending` meanwhile, and a
   refusal puts it back. */
export function Sortable({
  children,
  onValueChange,
  onCommit,
  commitDelay,
  words,
  value,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children' | 'onValueChange' | 'value' | 'defaultValue'> & {
  children: (key: string, at: number) => ReactNode;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[], details: Change<SortableReason>) => void;
} & CommitProps<string[], Change<SortableReason>>) {
  const commit = useCommit<string[], Change<SortableReason>>({
    value,
    defaultValue,
    onValueChange,
    onCommit,
    commitDelay,
    words,
    moved: movedKeys,
  });
  const root = (
    <parts.Root {...props} value={commit.value} defaultValue={commit.defaultValue} {...heard({ onValueChange: commit.onValueChange })}>
      {({ order }) => order.map((key, at) => <Fragment key={key}>{children(key, at)}</Fragment>)}
    </parts.Root>
  );
  return commit.pending ? <PendingProvider value={commit.pending}>{root}</PendingProvider> : root;
}

export function SortableItem(props: ComponentProps<typeof parts.Item>) {
  return <parts.Item {...props} {...usePending(props.value)} />;
}
export const SortableHandle = parts.Handle;
