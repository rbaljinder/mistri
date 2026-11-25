/**
 * A record's lead photograph read like a column: declaring `photos: { from, whose, sort?, aspect? }` on a resource
 * lets `cover` ride on every row the view compiler returns — in one SQL statement via a correlated scalar subquery
 * through the statement's relations (so row policies and tenant scopes narrow the photo table automatically).
 *
 * Like `tags` (tagLists.ts) and rollups, `cover` is never a stored column on the table; it lives on `TableMeta.cover`
 * so insert forms, plain queries, and exports never see it, while `useRows`, `useRecord`, cards, landing embeds, and
 * `related` ("more like this") all read the cover without hand-written child-table lookups.
 */
import type { ColumnMeta } from './schema.js';

/** The virtual column name a record's lead photograph key is read by. */
export const COVER_COLUMN = 'cover';
/** The synthetic column type carried where a column's type would stand. */
const COVER_TYPE = 'cover';

/** A resource's lead photo rule as the catalog serves it and a view pins it: never supplied by a request. */
export interface CoverPhotoSet {
  /** The child file resource's table id (e.g. `vehicle_photo`). */
  from: string;
  /** The column on `from` referencing the owning record. */
  whose: string;
  /** The column on the owning record that `whose` points to. */
  key: string;
  /** The primary key column on `from` returned as the lead photo key. */
  photoKey: string;
  /** Optional sort column on `from` deciding which photo leads (default: primary key ascending). */
  sort?: string;
  /** Sort direction for `sort` (default: `'asc'`). */
  sortDir?: 'asc' | 'desc';
  /** True when the photo file resource stores a thumbnail column. */
  thumbnail?: true;
  /** Optional default aspect ratio for this resource's photos (e.g. `'3/2'`, `'3/4'`). */
  aspect?: string;
}

/** A view's pinned cover rule, keyed by path (`'cover'` or `'vehicle_id.cover'`). */
export interface CoverPath extends CoverPhotoSet {
  on: string;
}

/** The cover photo key read as a column: never written, nullable when a record has no photos. */
export function coverColumnMeta(name = COVER_COLUMN): ColumnMeta {
  return { name, type: COVER_TYPE, nullable: true, primaryKey: false, writable: false };
}
