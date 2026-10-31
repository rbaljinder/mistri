/**
 * A scroll area: a region that scrolls inside itself, with its own
 * thumb, instead of growing the page around it. Over Base UI's ScrollArea,
 * which gives it the viewport, the thumb that tracks it and the corner
 * where two thumbs meet. The viewport is a tab stop with the region's
 * name, so a keyboard reader can reach it and scroll with the arrows
 * without a mouse; a region whose content never overflows draws no thumb
 * and is no tab stop to nowhere. `orientation` says which thumbs exist
 * (vertical by default); `maxHeight` caps the region where the caller
 * wants one, as a CSS length, and is otherwise the caller's own height.
 * Where the scrolled content is a list, the list's own semantics stay on
 * the content — this region adds scrolling, never a second list.
 */
import type { ReactNode } from 'react';
import { ScrollArea as BaseScrollArea } from '@base-ui/react/scroll-area';

export interface ScrollAreaProps {
  children: ReactNode;
  /** The scrollable region's accessible name ("Recent activity"). */
  label?: string;
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** A cap on the region's height, as a CSS length (for example "320px"). */
  maxHeight?: string;
  className?: string;
}

export function ScrollAreaControl({ children, label, orientation = 'vertical', maxHeight, className }: ScrollAreaProps) {
  const vertical = orientation === 'vertical' || orientation === 'both';
  const horizontal = orientation === 'horizontal' || orientation === 'both';
  return (
    <BaseScrollArea.Root className={['ui-scroll-area', className].filter(Boolean).join(' ')}>
      <BaseScrollArea.Viewport
        className="ui-scroll-area-viewport"
        tabIndex={0}
        /* Base UI renders its viewport as presentation; a named scroll
           region needs the region role, or the label is dropped with it. */
        role="region"
        aria-label={label}
        style={maxHeight ? { maxHeight } : undefined}
      >
        {/* Content is required inside the viewport once the region scrolls
            sideways; it costs nothing vertically, so it is always here. */}
        <BaseScrollArea.Content className="ui-scroll-area-content">{children}</BaseScrollArea.Content>
      </BaseScrollArea.Viewport>
      {vertical ? (
        <BaseScrollArea.Scrollbar className="ui-scroll-area-scrollbar ui-scroll-area-scrollbar-vertical" orientation="vertical">
          <BaseScrollArea.Thumb className="ui-scroll-area-thumb" />
        </BaseScrollArea.Scrollbar>
      ) : null}
      {horizontal ? (
        <BaseScrollArea.Scrollbar className="ui-scroll-area-scrollbar ui-scroll-area-scrollbar-horizontal" orientation="horizontal">
          <BaseScrollArea.Thumb className="ui-scroll-area-thumb" />
        </BaseScrollArea.Scrollbar>
      ) : null}
      {vertical && horizontal ? <BaseScrollArea.Corner className="ui-scroll-area-corner" /> : null}
    </BaseScrollArea.Root>
  );
}

/** The short name, as the other primitives export theirs. */
export const ScrollArea = ScrollAreaControl;
