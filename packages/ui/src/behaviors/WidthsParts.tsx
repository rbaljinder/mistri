/* The React parts of column widths (./widths.ts is the primitive). The root is a box that lays nothing out
   (`display: contents`, in the parts' sheet): it shares the widths with the columns inside it and hands them to
   its children, so the cells under a header can be held to the header's width.

     <Widths value={widths} onValueChange={setWidths}>
       {(set) => (
         <table>
           <thead><tr>
             <WidthsColumn value="rent" label="Asking rent">Asking rent <WidthsHandle /></WidthsColumn>
           </tr></thead>
           <tbody>… <td style={cell(set.rent)}>…</td> …</tbody>
         </table>
       )}
     </Widths>

   Slots: `widths-column` (`data-sized`, `data-sizing`, and its width as a style) and `widths-handle`
   (`data-sizing`). */
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { type Change, heard } from './heard.js';
import { widths, type WidthsReason } from './widths.js';

const parts = createParts(widths, { root: 'div', column: 'th', handle: 'span' });

export function Widths({
  children,
  onValueChange,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children' | 'onValueChange'> & {
  children: (widths: Record<string, number>, sizing: string | null) => ReactNode;
  onValueChange?: (value: Record<string, number>, details: Change<WidthsReason, { key: string }>) => void;
}) {
  return (
    <parts.Root {...props} {...heard({ onValueChange })}>
      {(state) => children(state.widths, state.sizing)}
    </parts.Root>
  );
}

export const WidthsColumn = parts.Column;
export const WidthsHandle = parts.Handle;
