/**
 * The list a record was opened from, carried so the record can step to its
 * neighbors.
 *
 * Every list already hands `openRecord` the records it is showing (the
 * modal's Previous and Next read them); a grid adds its own question and
 * page. That rides the walk entry as `trail`, so a record page, a peek and
 * the split's detail can say "3 of 20" and move one record along — in the
 * list's own order and filter, never a second query of their own. Past the
 * page's edge the list's next or previous page is read with the same
 * question; where the list has no total (an API reports none), a full page
 * is the only sign that more follow, as it is for the pager.
 *
 * Pure: the page reader is passed in, so core.js can import this without a
 * cycle and a test needs no server.
 */

export interface TrailRecord {
  key: Record<string, unknown>;
  label?: string;
}
/** The list's question and the page the records came from. `total` only when it is exact. */
export interface TrailList {
  query: string;
  offset: number;
  limit: number;
  total?: number;
}
export interface RecordTrail {
  table: string;
  records: TrailRecord[];
  index: number;
  list?: TrailList;
}
/** Reads one page of the list's question, as trail records. */
export type TrailPageReader = (table: string, list: TrailList, offset: number) => Promise<TrailRecord[]>;

/**
 * The list a room's answer is one page of, so a record opened from any of
 * its presentations — the grid, cards, a queue, a checklist, a split's list
 * — steps past the page with the same question. Undefined where the answer
 * does not say which page it was. An estimate is no end to stop at: without
 * an exact total, a full page is the sign that more follow — nor is a
 * bounded one ("10,000+"), which says only where counting stopped.
 */
export function trailListFor(
  query: string,
  page: { limit?: number; offset?: number; total?: number; exactTotal?: boolean; cappedTotal?: boolean },
): TrailList | undefined {
  if (typeof page.limit !== 'number') return undefined;
  return {
    query,
    offset: page.offset ?? 0,
    limit: page.limit,
    ...(page.exactTotal === false || page.cappedTotal || typeof page.total !== 'number' ? {} : { total: page.total }),
  };
}

/** A key said the same way whatever its column order or value types. */
export const keyText = (key: Record<string, unknown>) =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((name) => [name, String(key[name])]),
  );

/**
 * The trail for a record opened from a list, or undefined where there is
 * nothing to step to: the record is not among the list's records, or it is
 * the only one and no page follows.
 */
export function trailFor(
  table: string,
  key: Record<string, unknown>,
  records?: readonly TrailRecord[],
  list?: TrailList,
): RecordTrail | undefined {
  if (!records?.length) return undefined;
  const index = records.findIndex((record) => keyText(record.key) === keyText(key));
  if (index < 0) return undefined;
  const trail: RecordTrail = {
    table,
    index,
    records: records.map((record) => ({ key: { ...record.key }, ...(record.label === undefined ? {} : { label: record.label }) })),
    ...(list ? { list: { ...list } } : {}),
  };
  return trail.records.length > 1 || canStep(trail, 1) || canStep(trail, -1) ? trail : undefined;
}

/** Where the record sits: its place in the whole list, and the list's length when it is known. */
export function trailPosition(trail: RecordTrail): { at: number; of?: number } {
  const at = (trail.list?.offset ?? 0) + trail.index + 1;
  const of = trail.list ? trail.list.total : trail.records.length;
  return of === undefined ? { at } : { at, of };
}

/** Whether a step that way leads anywhere. */
export function canStep(trail: RecordTrail, step: 1 | -1): boolean {
  if (step === -1) return trail.index > 0 || Boolean(trail.list && trail.list.offset > 0);
  if (trail.index < trail.records.length - 1) return true;
  const list = trail.list;
  if (!list) return false;
  // Without a total, a full page is the only sign that another follows.
  return list.total === undefined ? trail.records.length >= list.limit : list.offset + trail.records.length < list.total;
}

/**
 * The trail one record along within the page, or undefined where the step
 * leaves it. Synchronous, so a step that reads nothing lands at once.
 */
export function stepWithin(trail: RecordTrail, step: 1 | -1): RecordTrail | undefined {
  const next = trail.index + step;
  return next >= 0 && next < trail.records.length ? { ...trail, index: next } : undefined;
}

/**
 * The trail one record along. Within the page it is a move of the index;
 * past it, the list's next (or previous) page is read and the step lands on
 * its first (or last) record. Undefined when there is nowhere to go, which
 * a reader answering an empty page also says.
 */
export async function stepTrail(trail: RecordTrail, step: 1 | -1, read: TrailPageReader): Promise<RecordTrail | undefined> {
  const within = stepWithin(trail, step);
  if (within) return within;
  if (!trail.list || !canStep(trail, step)) return undefined;
  const offset = Math.max(0, trail.list.offset + step * trail.list.limit);
  const records = await read(trail.table, trail.list, offset);
  if (!records.length) return undefined;
  return { ...trail, records, index: step === 1 ? 0 : records.length - 1, list: { ...trail.list, offset } };
}
