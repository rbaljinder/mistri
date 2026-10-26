/**
 * A person's photo in their avatar: a display rule's `avatar: { from, whose }`
 * names a file resource of photos, and the disc before the name is its first
 * file for the record, drawn through the file route — the reader's own read,
 * so a reader whose grant leaves the photos out sees the initials, as does a
 * record with no photo or one whose picture will not load.
 *
 * One question per page of rows and photo resource, as a card list asks for
 * its pictures (CardsList.tsx): the owners on the page, sorted so the first
 * row seen for each is its lead. The grid reads the answer through a context,
 * so a row that is already drawn is drawn again only where its photo arrived.
 */
import { createContext, useMemo, type ReactNode } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api, findTable, quote, state } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { inlineFileAddress } from './cardsModel.js';
import type { DisplayRule } from './valueModel.js';

type Photo = Exclude<NonNullable<DisplayRule['avatar']>, boolean>;
const photoOf = (rule: DisplayRule | null | undefined): Photo | undefined =>
  rule?.avatar && typeof rule.avatar === 'object' ? rule.avatar : undefined;

/** A column's photo, by its owner's key: the grid's rows read it here. */
type PhotoLookup = (column: string, owner: unknown) => string | undefined;
export const AvatarPhotoContext = createContext<PhotoLookup>(() => undefined);

/**
 * The row column that holds the key of the record a column's avatar is of, or
 * undefined where there is none on the row: the table's own key for its own
 * column, the reference for a one-hop label path (`author_id.display_name`
 * shows a member, so its photo is `author_id`'s).
 */
export function avatarOwner(
  table: TableMeta | undefined,
  column: string,
  rule: DisplayRule | null | undefined,
  columns: readonly string[] | undefined,
): string | undefined {
  if (!photoOf(rule) || !table) return undefined;
  const parts = column.split('.');
  if (parts.length === 1) {
    const key = primaryKey(table);
    return key.length === 1 && columns?.includes(key[0]) ? key[0] : undefined;
  }
  return parts.length === 2 && columns?.includes(parts[0]) ? parts[0] : undefined;
}

const literal = (value: unknown) => (typeof value === 'number' ? String(value) : quote(String(value)));

/** The photos of the owners on a page of rows, for each column that draws one. */
export function useAvatarPhotos(
  columns: ReadonlyArray<{ name: string; display: DisplayRule | null; photoOwner?: string }>,
  rows: ReadonlyArray<Record<string, unknown>>,
): PhotoLookup {
  const connection = (state as { activeConnection?: string | null }).activeConnection ?? null;
  const asks = columns.flatMap((column) => {
    const photo = photoOf(column.display);
    const from = photo && column.photoOwner ? (findTable(photo.from) as TableMeta | undefined) : undefined;
    const key = from ? primaryKey(from) : [];
    if (!photo || !from || !key.length || !column.photoOwner) return [];
    const owners = [...new Set(rows.map((row) => row[column.photoOwner!]).filter((value) => value !== null && value !== undefined))];
    if (!owners.length) return [];
    const [sortColumn, direction = 'asc'] = (photo.sort ?? '').split(/\s+/);
    const text =
      `${from.id} ${photo.whose} in (${owners.map(literal).join(', ')}) sort ${photo.whose}${sortColumn ? `, ${sortColumn} ${direction}` : ''}` +
      ` show ${[...new Set([...key, photo.whose])].join(', ')}`;
    return [{ column: column.name, from, key, whose: photo.whose, text }];
  });
  const answers = useQueries({
    queries: asks.map((ask) => ({
      queryKey: ['run', connection ?? '', 'avatar-photos', ask.text],
      staleTime: 60_000,
      queryFn: async () => {
        const data = (await api('/api/run', { q: ask.text, limit: 500, offset: 0, count: 'none', ...ownedBy(connection) })) as {
          rows?: Array<Record<string, unknown>>;
          errors?: Array<{ message: string }>;
        };
        // A reader who may not read the photos keeps the initials: nothing to say about it.
        return data.errors?.length ? [] : (data.rows ?? []);
      },
    })),
  });
  /* The same lookup for as long as the answers are the same ones: every row reads it, and a new
     function each paint would redraw every memoized row of the grid. */
  const stamp = asks.map((ask, i) => `${ask.text}@${answers[i]?.dataUpdatedAt ?? 0}`).join('\n');
  return useMemo(() => {
    if (!asks.length) return NO_PHOTOS;
    const byColumn = new Map<string, Map<string, string>>();
    asks.forEach((ask, i) => {
      const lead = new Map<string, string>();
      for (const row of answers[i]?.data ?? []) {
        const owner = String(row[ask.whose]);
        if (!lead.has(owner))
          lead.set(
            owner,
            inlineFileAddress(ask.from.id, Object.fromEntries(ask.key.map((column) => [column, row[column]])), connection, 'thumb'),
          );
      }
      byColumn.set(ask.column, lead);
    });
    return (column: string, owner: unknown) =>
      owner === null || owner === undefined ? undefined : byColumn.get(column)?.get(String(owner));
  }, [stamp]); // eslint-disable-line react-hooks/exhaustive-deps
}

const NO_PHOTOS: PhotoLookup = () => undefined;

/**
 * The photos for the rows below, for a grid with a column that draws one; a
 * grid without never asks, and never needs a query client to draw.
 */
export function AvatarPhotos({
  columns,
  rows,
  children,
}: {
  columns: ReadonlyArray<{ name: string; display: DisplayRule | null; photoOwner?: string }>;
  rows: ReadonlyArray<Record<string, unknown>>;
  children: ReactNode;
}) {
  return <AvatarPhotoContext.Provider value={useAvatarPhotos(columns, rows)}>{children}</AvatarPhotoContext.Provider>;
}
