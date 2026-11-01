/**
 * Pagination: the pages of a list, as a row of buttons. Plain React —
 * Base UI has no pagination, and a row of buttons is all one is — with
 * the rules a list's pages need: the current page is `aria-current`,
 * never a button to itself; Previous and Next are disabled at the ends,
 * never hidden, so the row keeps its shape; and a long run of pages is
 * shortened with an ellipsis, never with a jump the reader cannot see.
 * Pages are 1-based, as the reader counts them; `pages` is the count of
 * pages, not of rows. With one page or none, the row renders nothing:
 * a pager for a single page is noise.
 */
import type { ReactNode } from 'react';

export interface PaginationProps {
  /** The current page, 1-based. */
  page: number;
  /** The number of pages. */
  pages: number;
  onPageChange: (page: number) => void;
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

export function Pagination({ page, pages, onPageChange, ariaLabel, words: given }: PaginationProps) {
  const words: PaginationWords = { pages: 'Pages', previous: 'Previous', next: 'Next', ...given };
  if (pages <= 1) return null;
  const current = Math.min(Math.max(page, 1), pages);
  return (
    <nav className="ui-pagination" aria-label={ariaLabel ?? words.pages}>
      <button type="button" className="ui-page ui-page-step" disabled={current === 1} onClick={() => onPageChange(current - 1)}>
        {words.previous}
      </button>
      {paginationItems(current, pages).map((item, i) =>
        item === '…' ? (
          <span key={`gap-${i}`} className="ui-page-gap" aria-hidden="true">
            …
          </span>
        ) : (
          <button
            key={item}
            type="button"
            className="ui-page"
            aria-current={item === current ? 'page' : undefined}
            onClick={() => onPageChange(item)}
          >
            {item}
          </button>
        ),
      )}
      <button type="button" className="ui-page ui-page-step" disabled={current === pages} onClick={() => onPageChange(current + 1)}>
        {words.next}
      </button>
    </nav>
  );
}
