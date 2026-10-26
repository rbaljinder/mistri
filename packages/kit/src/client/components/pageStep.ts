/**
 * How the pager reached the page on screen, so the next read of it is by key
 * (shared/keysetPage.ts): Next is the rows after the last row shown,
 * Previous the rows before the first, Last the list's final rows read from
 * its end. A page reached by number — the page box, an address, First —
 * carries no step and is read by offset, which is cheap near the top and
 * refused past 10,000 rows.
 *
 * One step is kept, for one list and one page: it names the list by its
 * question and page size, so a step taken on another list, or before the
 * size changed, is never read as this one's. The page number stays what the
 * pager and the range say; the step only decides how it is read.
 */
import type { Boundary } from '@mistriwork/engine/shared/keysetPage.js';

type PageStepBody = { after: Boundary } | { before: Boundary } | { end: true };
interface Kept {
  list: string;
  page: number;
  body: PageStepBody;
  limit?: number;
}

let kept: Kept | undefined;

/** The list a step belongs to: its connection, table, question and page size. */
export function stepList(source: unknown, table: string, query: string, size: number): string {
  return JSON.stringify([source ?? null, table, query, size]);
}

/** Remember how `page` of `list` is reached; nothing, for a page reached by number. */
export function takePageStep(list: string, page: number, body?: PageStepBody, limit?: number): void {
  kept = body ? { list, page, body, ...(limit === undefined ? {} : { limit }) } : undefined;
}

/** How `page` of `list` is read, when the pager stepped to it: the request's step, and a limit of its own for the end. */
export function pageStepFor(list: string, page: number): { body: PageStepBody; limit?: number } | undefined {
  return kept && kept.list === list && kept.page === page
    ? { body: kept.body, ...(kept.limit === undefined ? {} : { limit: kept.limit }) }
    : undefined;
}
