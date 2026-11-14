import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { widths } from './widths';

const parts = createParts(widths, { root: 'div', column: 'th', handle: 'span' });

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
export function Widths({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children'> & {
  children: (widths: Record<string, number>, sizing: string | null) => ReactNode;
}) {
  return <parts.Root {...props}>{(state) => children(state.widths, state.sizing)}</parts.Root>;
}

export const WidthsColumn = parts.Column;
export const WidthsHandle = parts.Handle;
