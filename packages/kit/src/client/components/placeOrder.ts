/**
 * A record's place among its neighbors, for every run a reader arranges by
 * hand — a board's lane (BoardList) and a list with an `order` column
 * (useListOrder) — so the two can never number, or save, differently.
 */

/* A run renumbered is numbered this far apart, so the next many moves each
   find a number between their neighbors and write the one record. */
import { say } from '../copy/lists/components/placeOrder.js';

export const STEP = 1024;

/**
 * The writes that give a record its new place, as few as the numbers allow:
 * the one record, halfway between its new neighbors (a step past the end one
 * at either end of the run). Only when there is no number between them — two
 * whole numbers side by side, a fraction halved away to nothing, or a
 * neighbor with no place yet — is the run numbered again, a step apart with
 * the record in its place, skipping every record already on its number.
 */
export function placements<Item extends { id: string; position?: number }>(
  item: Item,
  others: Item[],
  index: number,
  whole: boolean,
): Array<[Item, number]> {
  const above = others[index - 1],
    below = others[index];
  const a = above?.position,
    b = below?.position;
  if ((above || below) && (!above || a !== undefined) && (!below || b !== undefined)) {
    const value =
      a !== undefined && b !== undefined ? (whole ? Math.floor((a + b) / 2) : (a + b) / 2) : a !== undefined ? a + STEP : b! - STEP;
    if ((a === undefined || value > a) && (b === undefined || value < b)) return value === item.position ? [] : [[item, value]];
  }
  const run = [...others.slice(0, index), item, ...others.slice(index)];
  return run.flatMap((each, i): Array<[Item, number]> => (each.position === (i + 1) * STEP ? [] : [[each, (i + 1) * STEP]]));
}

/** A stored place as a number: absent where the record has none yet, or its value is not one. */
export function positionOf(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim() || NaN) : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** Whether a place column holds whole numbers only, so a midpoint is rounded down rather than halved. */
export const wholeColumn = (type: string | undefined) => /int|serial/i.test(type ?? '');

/** The places a record's menu names, in the order it names them. */
export type Place = 'up' | 'down' | 'top' | 'bottom';
export const PLACES: Array<[Place, string]> = [
  ['up', say('common.moveUp')],
  ['down', say('common.moveDown')],
  ['top', say('moveToTop')],
  ['bottom', say('moveToBottom')],
];

/**
 * Where one of the menu's places puts a record: its index among the others
 * as they will be, 0 at the top — or undefined where it already stands
 * there, so the menu leaves that place out.
 */
export function placeIndex(ids: readonly string[], id: string, place: Place): number | undefined {
  const at = ids.indexOf(id);
  const index = place === 'up' ? at - 1 : place === 'down' ? at + 1 : place === 'top' ? 0 : ids.length - 1;
  return at >= 0 && index !== at && index >= 0 && index < ids.length ? index : undefined;
}

/** A write that did not apply: what it said, and whether that was a refusal (an uncertain write says so on its record). */
export interface PlaceFailure {
  message: string;
  refused: boolean;
}

/**
 * The writes, one ordinary update each and in order, so each is checked,
 * recorded and undoable on its own. The first that does not apply stops the
 * rest; a page that has gone (another connection, a signed-out session)
 * stops them too, and says so as `stale`.
 */
export async function savePlaces<Item>(
  writes: Array<[Item, number]>,
  write: (item: Item, value: number) => Promise<PlaceFailure | null>,
  isCurrent: () => boolean,
): Promise<{ applied: number; failed?: PlaceFailure; stale: boolean }> {
  let applied = 0;
  for (const [item, value] of writes) {
    const failed = await write(item, value);
    if (!isCurrent()) return { applied, stale: true };
    if (failed) return { applied, failed, stale: false };
    applied++;
  }
  return { applied, stale: false };
}
