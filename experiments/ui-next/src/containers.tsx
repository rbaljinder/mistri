import { CaretLeft, CaretRight } from '@phosphor-icons/react';
import {
  Carousel as Slides,
  CarouselContent,
  CarouselIndicator,
  CarouselIndicatorGroup,
  CarouselItem,
  CarouselNext,
  CarouselPrevious,
  CarouselViewport,
} from '@ui-sdk/react/carousel';
import { Popover as Pop, PopoverContent, PopoverTitle, PopoverTrigger } from '@ui-sdk/react/popover';
import { Resizable, ResizableHandle, ResizablePanel } from '@ui-sdk/react/resizable';
import {
  ScrollArea as Scroller,
  ScrollAreaContent,
  ScrollAreaScrollbar,
  ScrollAreaThumb,
  ScrollAreaViewport,
} from '@ui-sdk/react/scroll-area';
import { Fragment, type ReactElement, type ReactNode, useEffect, useRef, useState } from 'react';
import { words } from './words';

/* The things that hold other things: slides, panes whose share of the room the reader sets, a region that
   scrolls, and a popup beside what opened it. Each is UI SDK's part given the few props a caller needs. */

export type CarouselSlide = { id: string; label: string; content: ReactNode };

/* Slides the reader goes through. It scrolls natively, so a finger swipes it and a trackpad scrolls it; the arrows
   and the dots are for a mouse and a keyboard, and each dot names its slide so a reader can go straight to one. */
export function Carousel({ label, slides, loop }: { label: string; slides: CarouselSlide[]; loop?: boolean }) {
  return (
    <Slides aria-label={label} loop={loop}>
      <div data-slot="carousel-stage">
        <CarouselPrevious aria-label={words.previousSlide} data-variant="quiet">
          <CaretLeft aria-hidden="true" weight="bold" />
        </CarouselPrevious>
        <CarouselViewport>
          <CarouselContent>
            {slides.map((slide) => (
              <CarouselItem key={slide.id} aria-label={slide.label}>
                {slide.content}
              </CarouselItem>
            ))}
          </CarouselContent>
        </CarouselViewport>
        <CarouselNext aria-label={words.nextSlide} data-variant="quiet">
          <CaretRight aria-hidden="true" weight="bold" />
        </CarouselNext>
      </div>
      <CarouselIndicatorGroup>
        {slides.map((slide, at) => (
          <CarouselIndicator key={slide.id} page={at + 1} aria-label={slide.label} />
        ))}
      </CarouselIndicatorGroup>
    </Slides>
  );
}

export type SplitPane = {
  id: string;
  content: ReactNode;
  /* The pane's share of the room at first and the least it may be given, in percent. */
  size?: number;
  min?: number;
};

/* Panes side by side (or stacked) with a bar between each pair that the reader drags, or moves with the arrow
   keys, to give one more room. `remember` keeps the reader's layout under that name for the next visit, since a
   layout a reader set once and has to set again every time was not worth setting. */
export function Split({
  label,
  panes,
  direction = 'horizontal',
  remember,
}: {
  /* What the panes are, for the bars' names: "Resize files". */
  label: string;
  panes: SplitPane[];
  direction?: 'horizontal' | 'vertical';
  remember?: string;
}) {
  return (
    <Resizable orientation={direction} autoSaveId={remember}>
      {panes.map((pane, at) => (
        <Fragment key={pane.id}>
          {at > 0 && <ResizableHandle aria-label={words.resizeBar(label, at)} />}
          <ResizablePanel id={remember ? `${remember}-${pane.id}` : undefined} defaultSize={pane.size} minSize={pane.min ?? 10}>
            {pane.content}
          </ResizablePanel>
        </Fragment>
      ))}
    </Resizable>
  );
}

/* A region that scrolls inside the page, no taller than it is told. The bar is thin, the same in every browser,
   and shows while the region is scrolled or pointed at; the region has a name, and a keyboard can reach it and
   scroll it. */
export function ScrollArea({ label, maxHeight, children }: { label: string; maxHeight: string; children: ReactNode }) {
  /* A region that holds all it has is not a place the keyboard needs to stop: it is one only while its content
     runs past it, which is measured again whenever either changes size. */
  const view = useRef<HTMLDivElement>(null);
  const [runsPast, setRunsPast] = useState(false);
  useEffect(() => {
    const el = view.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const measure = () => setRunsPast(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    const seen = new ResizeObserver(measure);
    seen.observe(el);
    if (el.firstElementChild) seen.observe(el.firstElementChild);
    measure();
    return () => seen.disconnect();
  }, []);
  return (
    <Scroller style={{ maxHeight }}>
      <ScrollAreaViewport
        ref={view}
        role={runsPast ? 'region' : undefined}
        aria-label={runsPast ? label : undefined}
        tabIndex={runsPast ? 0 : undefined}
      >
        <ScrollAreaContent>{children}</ScrollAreaContent>
      </ScrollAreaViewport>
      <ScrollAreaScrollbar>
        <ScrollAreaThumb />
      </ScrollAreaScrollbar>
    </Scroller>
  );
}

/* A small surface beside what opened it, for something to read or set without leaving the page: the child is the
   trigger, so a button keeps its own look. */
export function Popover({
  trigger,
  title,
  children,
  align,
  open,
  onOpenChange,
}: {
  trigger: ReactElement<Record<string, unknown>>;
  title?: string;
  children: ReactNode;
  align?: 'start' | 'center' | 'end';
  /* Whether it is open, for a caller that decides: to close it when what it holds is done. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  return (
    <Pop open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={trigger} />
      <PopoverContent align={align}>
        {title && <PopoverTitle>{title}</PopoverTitle>}
        {children}
      </PopoverContent>
    </Pop>
  );
}
