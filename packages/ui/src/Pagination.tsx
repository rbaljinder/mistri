/**
 * Pagination: the pages of a list, as a row of buttons, over UI SDK's
 * Pagination, with the rules a list's pages need: the current page is
 * `aria-current`, never a button to itself; Previous and Next are
 * disabled at the ends, never hidden, so the row keeps its shape; and a
 * long run of pages is shortened with an ellipsis, never with a jump the
 * reader cannot see. Pages are 1-based, as the reader counts them;
 * `pages` is the count of pages, not of rows. With one page or none, the
 * row renders nothing: a pager for a single page is noise.
 */
import {
  Pagination as Pages,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationList,
  PaginationNext,
  PaginationPrevious,
} from '@ui-sdk/react/pagination';
import type { ReactNode } from 'react';
import type { ChangeDetails } from './changeDetails.js';
import { told } from './internal/told.js';
import { slotted } from './internal/uiKitContext.js';

export interface PaginationProps {
  /** The current page, 1-based. */
  page: number;
  /** The number of pages. */
  pages: number;
  onPageChange: (page: number, details: ChangeDetails<'page-press'>) => void;
  /** The list's accessible name, where the pager needs one ("Invoices, pages"). */
  ariaLabel?: string;
  /** Every word the pager says, in the caller's language; any left out are English. */
  words?: Partial<PaginationWords>;
}

interface PaginationWords {
  /** The nav's name when `ariaLabel` is not given. */
  pages: string;
  previous: ReactNode;
  next: ReactNode;
}

/** The page numbers to draw: the first, the last, and a window of five around the current, with gaps as ellipses. */
export function paginationItems(page: number, pages: number): Array<number | '…'> {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const window = new Set<number>([1, pages]);
  for (let p = page - 2; p <= page + 2; p++) if (p >= 1 && p <= pages) window.add(p);
  const sorted = [...window].sort((a, b) => a - b);
  const items: Array<number | '…'> = [];
  for (const p of sorted) {
    if (items.length && typeof items[items.length - 1] === 'number' && p - (items[items.length - 1] as number) > 1) items.push('…');
    items.push(p);
  }
  return items;
}

/* A step is typed as the link it can be and drawn as a button here, where no page has an address: `disabled` is
   the button's. */
const shut = (at: boolean): object => (at ? { disabled: true } : {});

function DefaultPagination({ page, pages, onPageChange, ariaLabel, words: given }: PaginationProps) {
  const words: PaginationWords = { pages: 'Pages', previous: 'Previous', next: 'Next', ...given };
  if (pages <= 1) return null;
  const current = Math.min(Math.max(page, 1), pages);
  return (
    <Pages
      aria-label={ariaLabel ?? words.pages}
      page={current}
      pageCount={pages}
      siblings={2}
      onPageChange={(next, details) => onPageChange(next, told('page-press', details))}
    >
      <PaginationList>
        {({ items }) => (
          <>
            <PaginationItem>
              {/* An end with nowhere to go is disabled outright, and not only said to be, so the row keeps its shape
                  and the keyboard passes it. */}
              <PaginationPrevious data-kind="words" {...shut(current === 1)}>
                {words.previous}
              </PaginationPrevious>
            </PaginationItem>
            {items.map((item) => (
              <PaginationItem key={item}>
                {typeof item === 'number' ? <PaginationLink page={item} /> : <PaginationEllipsis />}
              </PaginationItem>
            ))}
            <PaginationItem>
              <PaginationNext data-kind="words" {...shut(current === pages)}>
                {words.next}
              </PaginationNext>
            </PaginationItem>
          </>
        )}
      </PaginationList>
    </Pages>
  );
}

/* Slotted (UiKit.tsx): an App's control kit may draw its own in place of the default, with the same props. */
export const Pagination = slotted('Pagination', DefaultPagination, { onPageChange: [1, 'page-press'] });
