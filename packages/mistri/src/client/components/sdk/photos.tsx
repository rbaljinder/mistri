/**
 * `<Photos>` — one record's photographs as a lead image, thumbnail strip, and lightbox, with per-instance aspect
 * ratio (`3/2`, `3/4`, `16/9`, `4/3`, `1/1`). Wraps the record page's `Gallery` component over `useRows` + `useFile`
 * so custom pages get the full photo stage (and tenant-lease blob URL support) without rebuilding it from `<img>`.
 */
import { useMemo } from 'react';
import { Gallery, type GalleryItem } from '@mistriwork/kit/client/components/Gallery.js';
import { primaryKey, tableNamed, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { state } from '@mistriwork/kit/client/core.js';
import { useFile, useRows } from './hooks.js';
import { Loaded } from './kit.js';
import { say } from '../../copy/components/components/sdk/photos.js';

interface PhotosProps {
  /** The child file resource holding the photographs (e.g. `'vehicle_photo'`). */
  from: string;
  /** The reference column on `from` pointing to the owning record (e.g. `'vehicle_id'`). */
  whose: string;
  /** The owning record row (object with its key) or its key value (`id`). */
  record: Readonly<Record<string, unknown>> | string | number | null | undefined;
  /** Order of photographs (e.g. `'position'` or `'created_at desc'`). */
  sort?: string;
  /** Frame aspect ratio: `'3/2'`, `'3/4'`, `'4/3'`, `'16/9'`, `'1/1'`, etc. */
  aspect?: string;
  /** Column name holding alt text (defaults to `'alt'` or `'alt_text'` if present). */
  alt?: string;
  /** Column name holding the caption shown beneath the lead photo. */
  caption?: string;
  /** Accessible label for the gallery region. */
  label?: string;
  /** Empty-state message when the record has no photographs. */
  empty?: string;
  /** Maximum number of photographs to load (default 50). */
  limit?: number;
  className?: string;
}

function ownerValue(record: PhotosProps['record'], fromTable: TableMeta | undefined, whose: string): string | number | undefined {
  if (record === null || record === undefined) return undefined;
  if (typeof record === 'string' || typeof record === 'number') return record;
  const fk = state.schema?.foreignKeys.find(
    (each: { from: { table: string; columns: readonly string[] }; to: { columns: readonly string[] } }) =>
      each.from.table === fromTable?.id && each.from.columns.length === 1 && each.from.columns[0] === whose,
  );
  const keyCol = fk?.to.columns[0] ?? 'id';
  const val = record[keyCol];
  return typeof val === 'string' || typeof val === 'number' ? val : undefined;
}

export function Photos({ from, whose, record, sort, aspect, alt, caption, label, empty, limit = 50, className }: PhotosProps) {
  const table = state.schema ? (tableNamed(state.schema, from) as TableMeta | undefined) : undefined;
  const ownerId = ownerValue(record, table, whose);
  const fileUrl = useFile(from);
  const query = useRows(from, {
    where: ownerId !== undefined ? { [whose]: ownerId } : undefined,
    ...(sort ? { sort } : {}),
    limit,
    enabled: ownerId !== undefined,
  });
  const pk = useMemo(() => (table ? primaryKey(table) : ['id']), [table]);
  const items = useMemo<GalleryItem[]>(() => {
    const rows = query.data ?? [];
    const altCol =
      alt ??
      (table?.columns.some((c) => c.name === 'alt') || (!table && rows[0] && 'alt' in rows[0])
        ? 'alt'
        : table?.columns.some((c) => c.name === 'alt_text') || (!table && rows[0] && 'alt_text' in rows[0])
          ? 'alt_text'
          : undefined);
    const out: GalleryItem[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const keyObj = Object.fromEntries(pk.map((col) => [col, row[col]]));
      const src = fileUrl(keyObj);
      if (!src) continue;
      const thumb = fileUrl(keyObj, { thumbnail: true });
      const altText = altCol && row[altCol] != null ? String(row[altCol]) : '';
      const captionText = caption && row[caption] != null ? String(row[caption]) : undefined;
      out.push({
        id: pk.map((col) => String(row[col] ?? i)).join(':'),
        src,
        ...(thumb && thumb !== src ? { thumb } : {}),
        alt: altText,
        ...(captionText ? { caption: captionText } : {}),
      });
    }
    return out;
  }, [query.data, pk, fileUrl, alt, caption, table]);

  if (ownerId === undefined && record !== undefined) {
    return (
      <Gallery
        key="empty"
        items={[]}
        label={label ?? say('photos')}
        emptyText={empty ?? say('noPhotosYet')}
        aspect={aspect}
        className={className}
      />
    );
  }

  return (
    <Loaded query={query} empty={empty ?? say('noPhotosYet')}>
      {() => (
        <Gallery
          key={ownerId !== undefined ? String(ownerId) : 'pending'}
          items={items}
          label={label ?? say('photos')}
          emptyText={empty ?? say('noPhotosYet')}
          aspect={aspect}
          className={className}
        />
      )}
    </Loaded>
  );
}
