import type { Span } from '@ui-sdk/core';
import { createParts } from '@ui-sdk/react/primitive';
import type { ComponentProps, ReactNode } from 'react';
import { spans } from './spans';

const parts = createParts(spans, { root: 'div', track: 'div', span: 'div' });

/* The React parts of stretches along tracks (./spans.ts is the primitive). A track's element runs its whole
   range and hands its stretches to its children as they stand now, the one being carried where it is; a stretch
   places itself. An element marked `data-span-edge="start"` or `"end"` inside a stretch is an edge it is
   lengthened from.

     <Spans value={bars} onValueChange={setBars} min={0} max={days} stay>
       {tasks.map((task) => (
         <SpansTrack key={task.id} value={task.id}>
           {(onTrack) => onTrack.map((bar) => (
             <SpansSpan key={bar.id} value={bar.id} aria-label={said(bar)}>
               <i data-span-edge="start" />{task.name}<i data-span-edge="end" />
             </SpansSpan>
           ))}
         </SpansTrack>
       ))}
     </Spans>

   Slots: `spans` (`data-changing`), `spans-track` and `spans-span` (`data-dragging`, `data-resizing`,
   `data-locked`). */
export const Spans = parts.Root;

export function SpansTrack({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Track>, 'children'> & {
  children: (spans: Span[]) => ReactNode;
}) {
  return <parts.Track {...props}>{(state) => children(state.spans)}</parts.Track>;
}

export const SpansSpan = parts.Span;
export type { Span };
