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

/** Root column-widths controller sharing active widths with header columns and body cells. */
export function Widths({
  children,
  onValueChange,
  formatWidth,
  words,
  resizeLabel,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'children' | 'onValueChange'> & {
  children: (widths: Record<string, number>, sizing: string | null) => ReactNode;
  onValueChange?: (value: Record<string, number>, details: Change<WidthsReason, { key: string }>) => void;
  formatWidth?: (label: string, width: number | undefined) => string;
  words?: { resizeColumn?: (label: string) => string };
}) {
  const legacySay = (props as Record<string, unknown>).say as ((label: string, width: number | undefined) => string) | undefined;
  const rest = { ...props };
  delete (rest as Record<string, unknown>).say;
  return (
    <parts.Root
      {...rest}
      formatWidth={formatWidth ?? legacySay}
      resizeLabel={resizeLabel ?? words?.resizeColumn}
      {...heard({ onValueChange })}
    >
      {(state) => children(state.widths, state.sizing)}
    </parts.Root>
  );
}

/** Resizable table column header cell (`data-slot="widths-column"`). */
export const WidthsColumn = parts.Column;
/** Focusable pointer and keyboard resize handle at a column's trailing edge (`data-slot="widths-handle"`). */
export const WidthsHandle = parts.Handle;
