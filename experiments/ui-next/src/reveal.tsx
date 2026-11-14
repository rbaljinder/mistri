import { CaretDown, CaretLeft, CaretRight, X } from '@phosphor-icons/react';
import { Accordion as Stack, AccordionHeader, AccordionItem, AccordionPanel, AccordionTrigger } from '@ui-sdk/react/accordion';
import { Dialog, DialogBackdrop, DialogClose, DialogContent, DialogTitle } from '@ui-sdk/react/dialog';
import { type ReactNode, useState } from 'react';
import { words } from './words';

/* Things that are there and shown on a press: sections that fold, and a picture read large. */

export type AccordionSection = {
  value: string;
  title: ReactNode;
  /* A word at the title's end: a count. */ meta?: ReactNode;
  content: ReactNode;
  disabled?: boolean;
};

/* Sections that fold under their titles, over UI SDK's accordion. Any number are open at once unless `single`,
   since a reader comparing two sections should not have one shut on them for opening the other. */
export function Accordion({
  sections,
  single,
  value,
  defaultValue,
  onValueChange,
  headingLevel = 3,
}: {
  sections: AccordionSection[];
  single?: boolean;
  value?: string[];
  defaultValue?: string[];
  onValueChange?: (value: string[]) => void;
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as 'h3';
  return (
    <Stack
      multiple={!single}
      collapsible
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange ? (next) => onValueChange(next) : undefined}
    >
      {sections.map((section) => (
        <AccordionItem key={section.value} value={section.value} disabled={section.disabled}>
          <AccordionHeader render={<Heading />}>
            <AccordionTrigger>
              <span data-slot="accordion-title">{section.title}</span>
              {section.meta !== undefined && <span data-slot="accordion-meta">{section.meta}</span>}
              <CaretDown aria-hidden="true" data-slot="accordion-caret" />
            </AccordionTrigger>
          </AccordionHeader>
          <AccordionPanel>{section.content}</AccordionPanel>
        </AccordionItem>
      ))}
    </Stack>
  );
}

export type Picture = { src: string; alt: string; caption?: string };

/* Pictures as small tiles, each opening large over the page. Large, the arrow keys go from one to the next, Home
   and End to the ends, and the count says where the reader is; closing puts the keyboard back on the tile that
   was opened. A tile is a button named by its picture's words, so the set is read as what it shows. */
export function PictureGallery({ label, pictures }: { label: string; pictures: Picture[] }) {
  const [at, setAt] = useState<number | null>(null);
  const shown = at === null ? undefined : pictures[at];
  const go = (to: number) => setAt(Math.min(Math.max(to, 0), pictures.length - 1));
  return (
    <>
      <ul data-slot="picture-gallery" aria-label={label}>
        {pictures.map((picture, index) => (
          <li key={picture.src}>
            <button type="button" aria-label={words.openPicture(picture.alt)} onClick={() => setAt(index)}>
              <img src={picture.src} alt="" loading="lazy" decoding="async" />
            </button>
          </li>
        ))}
      </ul>
      <Dialog open={at !== null} onOpenChange={(open) => !open && setAt(null)}>
        <DialogBackdrop />
        <DialogContent
          data-kind="lightbox"
          onKeyDown={(event) => {
            if (at === null) return;
            const to = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: pictures.length - 1 }[event.key];
            if (to === undefined) return;
            event.preventDefault();
            go(to);
          }}
        >
          <header>
            <DialogTitle>{shown?.alt}</DialogTitle>
            {pictures.length > 1 && at !== null && (
              <span data-slot="lightbox-count" aria-live="polite">
                {words.countOf(at + 1, pictures.length)}
              </span>
            )}
            <DialogClose aria-label={words.close} data-variant="quiet">
              <X aria-hidden="true" />
            </DialogClose>
          </header>
          <figure>
            {shown && <img src={shown.src} alt={shown.alt} />}
            {shown?.caption && <figcaption>{shown.caption}</figcaption>}
          </figure>
          {pictures.length > 1 && at !== null && (
            <>
              <button
                type="button"
                data-slot="lightbox-step"
                data-side="before"
                aria-label={words.previousPicture}
                disabled={at === 0}
                onClick={() => go(at - 1)}
              >
                <CaretLeft aria-hidden="true" weight="bold" />
              </button>
              <button
                type="button"
                data-slot="lightbox-step"
                data-side="after"
                aria-label={words.nextPicture}
                disabled={at === pictures.length - 1}
                onClick={() => go(at + 1)}
              >
                <CaretRight aria-hidden="true" weight="bold" />
              </button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
