/**
 * What a public page knows about its pictures before the browser has one:
 * the hash that lets an address name its bytes (`&h=`, so the copy is kept
 * for good) and the room each takes (true proportions, an average colour),
 * so the server's drawing holds the space and nothing moves when they arrive.
 *
 * Read narrowly: only the stored hash and the thumbnail (320 wide), never the
 * picture itself, and only for a file resource that keeps a thumbnail. A
 * resource without one has its pictures drawn as before.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { serverRequest } from '@mistriwork/engine/server/serverRequests.js';
import type { AppFileRule } from '../../shared/app.js';
import type { ColumnGrant } from '@mistriwork/engine/server/columnGrants.js';
import { imageHashOfHex, placeholderOf, type ImagePlaceholder } from './imageVariants.js';

export interface PictureDetails {
  hash?: string;
  room?: ImagePlaceholder;
}

export const pictureKey = (table: TableMeta, row: Record<string, unknown>): string =>
  JSON.stringify(primaryKey(table).map((column) => row[column]));

/** Whether the grant lets this reader see a column of a table: the resource is readable and, where fields are named, so is the column. */
function mayRead(grant: Pick<ColumnGrant, 'readable' | 'fields'> | undefined, table: string, column: string | undefined): boolean {
  if (!column) return false;
  if (!grant) return true;
  if (!grant.readable.has(table)) return false;
  const fields = grant.fields?.get(table);
  return !fields || fields.read.has(column);
}

/**
 * `grant` is the reader's (the visitor's). The room comes from the thumbnail column, read only where `auth.public.fields`
 * lets the visitor read it; the hash is of the original, which the visitor may fetch whenever the resource is readable
 * (a file's hash column is internal, never in a field list), so it needs the resource and not the column.
 */
export async function pictureDetails(
  reader: Pick<Adapter, 'query'>,
  table: TableMeta,
  rule: AppFileRule | undefined,
  rows: Array<Record<string, unknown>>,
  grant?: Pick<ColumnGrant, 'readable' | 'fields'>,
): Promise<Map<string, PictureDetails>> {
  const found = new Map<string, PictureDetails>();
  const thumb = rule && mayRead(grant, table.id, rule.thumbnail) ? rule.thumbnail : undefined;
  const hashed = rule && (!grant || grant.readable.has(table.id)) ? rule.hash : undefined;
  const keys = primaryKey(table);
  if (!rule || !thumb || !keys.length || !rows.length) return found;
  await Promise.all(
    rows.map(async (row) => {
      try {
        const read = await reader.query(
          serverRequest({
            table: table.id,
            columns: [thumb, ...(hashed ? [hashed] : [])],
            filter: { groups: [keys.map((column) => ({ column, op: '=' as const, value: row[column] as string | number }))] },
            limit: 2,
            offset: 0,
            binary: true,
          }),
        );
        const stored = read.rows.length === 1 ? read.rows[0] : undefined;
        if (!stored) return;
        const small = stored[thumb];
        const hash = hashed ? imageHashOfHex(stored[hashed]) : undefined;
        const room = small instanceof Uint8Array && small.byteLength ? await placeholderOf(small) : undefined;
        found.set(pictureKey(table, row), { ...(hash ? { hash } : {}), ...(room ? { room } : {}) });
      } catch {
        /* A courtesy, like the rest of the page's words: the picture is drawn without it. */
      }
    }),
  );
  return found;
}
