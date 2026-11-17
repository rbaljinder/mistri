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
   `data-locked`, `data-pending`). The range is drawn by ./SpansGridParts.tsx, and a move can be asked about before
   it is final (`onCommit`, ./commit.tsx). */
import { announce, type Span, type SpanAction, type SpansReason } from '@ui-sdk/core';
import { createParts } from '@ui-sdk/react/primitive';
import { type ComponentProps, type ReactNode, useMemo, useRef } from 'react';
import { type CommitProps, movedSpans, PendingProvider, useCommit, usePending } from './commit.js';
import { type Change, heard } from './heard.js';
import { spans } from './spans.js';
import { refusedBy, type SpansRange, SpansRangeContext, type SpansRegionEntry } from './spansRange.js';

const parts = createParts(spans, { root: 'div', track: 'div', span: 'div' });

type SpansChange = Change<SpansReason, { id: string; action: SpanAction }>;

/* With `onCommit` (./commit.tsx) a move is asked about before it is final: the stretch is `data-pending` meanwhile,
   a run of Alt-arrow steps is one call, and a refusal puts it back. */
export function Spans({
  onValueChange,
  onCommit,
  commitDelay,
  value,
  defaultValue,
  ...props
}: Omit<ComponentProps<typeof parts.Root>, 'onValueChange' | 'value' | 'defaultValue'> & {
  value?: Span[];
  defaultValue?: Span[];
  onValueChange?: (value: Span[], details: SpansChange) => void;
} & CommitProps<Span[], SpansChange>) {
  const commit = useCommit<Span[], SpansChange>({ value, defaultValue, onValueChange, onCommit, commitDelay, moved: movedSpans });
  const regions = useRef(new Map<string, SpansRegionEntry>());
  const { min = 0, max = 100, axis = 'x' } = props as { min?: number; max?: number; axis?: 'x' | 'y' };
  const range = useMemo<SpansRange>(() => ({ min, max, axis, regions: regions.current }), [min, max, axis]);
  /* A change that would leave a stretch in a region is refused here, before the page or a commit hears of it. It is
     said on the assertive announcer because the keyboard says the move it was asked for on the polite one. */
  const heardChange = (next: Span[], details: SpansChange): void => {
    const span = next.find((each) => each.id === details.id);
    const region = span && regions.current.size > 0 ? refusedBy(range, span.track, span.start, span.end) : undefined;
    if (region) {
      details.cancel();
      announce(region.label ? `${region.label} is not open to that` : 'Not available there', { priority: 'assertive' });
      return;
    }
    commit.onValueChange?.(next, details);
  };
  const root = (
    <SpansRangeContext.Provider value={range}>
      <parts.Root {...props} value={commit.value} defaultValue={commit.defaultValue} {...heard({ onValueChange: heardChange })} />
    </SpansRangeContext.Provider>
  );
  return commit.pending ? <PendingProvider value={commit.pending}>{root}</PendingProvider> : root;
}

export function SpansTrack({
  children,
  ...props
}: Omit<ComponentProps<typeof parts.Track>, 'children'> & {
  children: (spans: Span[]) => ReactNode;
}) {
  return <parts.Track {...props}>{(state) => children(state.spans)}</parts.Track>;
}

export function SpansSpan(props: ComponentProps<typeof parts.Span>) {
  return <parts.Span {...props} {...usePending(props.value)} />;
}
export type { Span };
