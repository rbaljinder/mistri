/**
 * What a list asks of its cards before it draws them, kept out of
 * CardsList.tsx so the cards themselves load on demand (onDemand.tsx): the
 * list decides whether its answer can stand as cards on the first page, and
 * the file route's picture address is written by records, galleries and
 * avatars that draw no card at all.
 */
import { served } from '../addressMount.js';
import { ownedBy } from '../requestIdentity.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { cardsColumns, type AppCardsList } from '@mistriwork/engine/shared/appCards.js';

/** A presentation stands in for the grid only when the answer carries every column it reads. */
export function canShowCards(table: TableMeta | undefined, columns: string[] | undefined, spec: AppCardsList): table is TableMeta {
  return Boolean(
    table && primaryKey(table).length && [...cardsColumns(spec), ...primaryKey(table)].every((name) => columns?.includes(name)),
  );
}

/**
 * The file route's inline address for one file row. `thumb` asks for the
 * resource's smaller copy where it declares one (`file.thumbnail`) — what a
 * card or a gallery strip draws at a few hundred pixels — and the file
 * itself where it does not.
 */
export function inlineFileAddress(
  tableId: string,
  key: Record<string, unknown>,
  connection: string | null | undefined,
  variant?: 'thumb',
): string {
  return served(
    `/api/file?${new URLSearchParams({ ...ownedBy(connection ?? null), table: tableId, key: JSON.stringify(key), inline: '1', ...(variant ? { variant } : {}) })}`,
  );
}
