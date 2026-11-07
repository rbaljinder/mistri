/**
 * What a board asks to draw its lanes, written once for the browser that asks
 * it (mistri client BoardList.tsx, kit TableRoom.tsx) and the first page that
 * asks it ahead of the browser (mistri server firstPaintRooms.ts): a carried
 * answer is found by its question, so the two must ask in the same words.
 *
 * Two reads: every lane's count (and sum) in one breakdown by the lane
 * column, and every lane's first cards in one read windowed by it
 * (`lanes: { by, limit }`, adapter.ts lanesStatement). A lane's "Show more"
 * reads that lane alone.
 */
import { currencyPath } from './money.js';
import { splitQuery } from './clauses.js';

/** A lane's cards are read this many at a time; "Show more" reads the next. */
export const LANE_PAGE = 20;
/** The window over every lane: a page of each of a board's eight lanes and its four final states, at most. */
const LANE_WINDOW = LANE_PAGE * 12;

/* The lane breakdown's two measures, and the currency each is summed apart by, by names no column is read by. */
export const LANE_COUNT = 'lane_cards';
export const LANE_SUM = 'lane_amount';
export const LANE_CURRENCY = 'lane_currency';

/** The lane breakdown's question: the list's conditions, without its show, sort or page, counted (and summed) by the lane column. */
export function laneCountsText(query: string | undefined, by: string, amount?: string, currencyBy?: string): string | null {
  const parts = query ? splitQuery(query) : undefined;
  /* With an amount, the same breakdown sums it beside each count, named so neither is read for the other. */
  const measures = amount ? `count as ${LANE_COUNT}, sum ${amount} as ${LANE_SUM}` : 'count';
  const keys = amount && currencyBy ? `${by}, ${currencyBy} as ${LANE_CURRENCY}` : by;
  return parts ? `${parts.table} ${parts.filter ?? ''} ${measures} by ${keys}`.replace(/\s+/g, ' ') : null;
}

/** What the list's read adds to read as a board's lanes: the first page of each lane, one statement, no total. */
export const laneWindow = (by: string) => ({ limit: LANE_WINDOW, count: 'none' as const, lanes: { by, limit: LANE_PAGE } });

type AmountRule = { format?: string; currencyColumn?: string };
/**
 * What a card is worth: the board's `sum`, else the first money its card shows (a line, a fact on its foot), and
 * the column that says each card's currency where it says its own. `rule` is a column's display rule where it
 * says money or a number, else null.
 */
export function boardAmount(
  spec: { sum?: string; lines?: readonly string[]; footer?: ReadonlyArray<{ column: string }> },
  rule: (column: string) => AmountRule | null,
): { amount?: string; said?: AmountRule; currencyBy?: string } {
  const amount =
    spec.sum ?? [...(spec.lines ?? []), ...(spec.footer ?? []).map((fact) => fact.column)].find((name) => rule(name)?.format === 'money');
  if (!amount) return {};
  const said = rule(amount) ?? { format: 'number' };
  const currencyBy = said.format === 'money' ? currencyPath(said, amount) : undefined;
  return { amount, said, ...(currencyBy ? { currencyBy } : {}) };
}

/**
 * The lists this browser reads as boards (kit LayoutSwitch.tsx), said to the server too, so a page it opens on one
 * carries the board's reads rather than the list's: the view ids, each encoded, joined by commas.
 */
export const BOARD_COOKIE = 'mistri_boards';

/** The views a request's Cookie header says are read as boards. */
export function boardsInCookie(header: string | undefined): ReadonlySet<string> {
  const found = header
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${BOARD_COOKIE}=`));
  if (!found) return new Set();
  return new Set(
    found
      .slice(BOARD_COOKIE.length + 1)
      .split(',')
      .flatMap((each) => {
        try {
          return each ? [decodeURIComponent(each)] : [];
        } catch {
          return [];
        }
      }),
  );
}
