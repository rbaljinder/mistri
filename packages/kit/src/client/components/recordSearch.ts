/**
 * Finding records by their names: the one engine behind ⌘K's record hits
 * and a dashboard's find box. Each table is asked through `/api/run` with
 * the text filter its list's search asks (`<label> contains "…"`), so the
 * server reads it as it reads every row for this reader — their grants,
 * their row access — and asks the App's search engine where the resource
 * declares one (server/app/appSearchRuntime.ts). A table is offered only
 * where the reader is served a list of it, so a list kept from them by its
 * `roles` keeps its records out of their search too.
 */
import { api, findTable, keyOf, labelPath, openRecord, primaryKey, quote, rowLabel } from '../core.js';
import type { TableMeta } from '@mistriwork/engine/shared/schema.js';
import { appRooms, isListRoom, viewRoom } from './appRooms.js';

type ServedApp = Parameters<typeof viewRoom>[0];
type ListRoom = Extract<NonNullable<ReturnType<typeof viewRoom>>, { table: string }>;

/** A table whose records can be found: where their names live, and the list that serves it. */
export interface Findable {
  table: TableMeta;
  label: string;
  room: ListRoom;
}

/** One record found: its name, a line of its list, and the way to open it. */
export interface Found {
  label: string;
  line?: string;
  key: Record<string, unknown>;
  open: () => void;
}

/** The list rooms the reader is served: the menu's own (⌘K's), or every list, those only a dashboard embeds too. */
function listRooms(app: ServedApp, every: boolean): ListRoom[] {
  const rooms = every ? Object.keys(app.views).map((key) => viewRoom(app, key)) : appRooms(app);
  return rooms.flatMap((room): ListRoom[] => (room && isListRoom(room) && !room.error ? [room as ListRoom] : []));
}

/** The table behind a list room, findable when it has a key and a name to search by. */
function findableOf(room: ListRoom): Findable | undefined {
  const table = findTable(room.table) as TableMeta | undefined;
  const label = table ? ((labelPath(table) as string | undefined) ?? primaryKey(table)[0]) : undefined;
  return table && label && (primaryKey(table) as string[]).length ? { table, label, room } : undefined;
}

/** The tables whose records the reader may find: those of `tables` (ids), or of the App's first lists. */
export function findableTables(app: ServedApp, tables?: readonly string[], most = 6): Findable[] {
  const seen = new Set<string>();
  const out: Findable[] = [];
  const rooms = listRooms(app, Boolean(tables));
  for (const room of tables ? tables.flatMap((id) => rooms.filter((each) => each.table === id).slice(0, 1)) : rooms) {
    if (seen.has(room.table)) continue;
    seen.add(room.table);
    const found = findableOf(room);
    if (found) out.push(found);
    if (out.length >= most) break;
  }
  return out;
}

/**
 * The line a hit says under its name: what its list says first under a
 * card's title — a cards description, else the first of its lines — or its
 * first shown column that is not the name. A local column only, read with
 * the name in the same question.
 */
export function lineOf({ table, label, room }: Findable): string | undefined {
  const presentation = room.presentation as { description?: string; lines?: readonly string[] } | undefined;
  const keys = primaryKey(table) as string[];
  const candidates = [presentation?.description, presentation?.lines?.[0], ...(room.show ?? [])];
  return candidates.find(
    (name): name is string =>
      typeof name === 'string' &&
      !name.includes('.') &&
      name !== label &&
      !keys.includes(name) &&
      table.columns.some((column) => column.name === name),
  );
}

/** The records of one table whose names hold `term`, at most `limit`, by name. A refusal answers nothing, never the whole search's failure. */
export async function findRecords(findable: Findable, term: string, limit: number, line?: string): Promise<Found[]> {
  const { table, label } = findable;
  const show = [...new Set([label, ...(primaryKey(table) as string[]), ...(line ? [line] : [])])];
  try {
    const data = await api('/api/run', {
      q: `${table.id} ${label} contains ${quote(term)} show ${show.join(', ')} sort ${label}`,
      limit,
      offset: 0,
      count: 'none',
    });
    return ((data.rows ?? []) as Array<Record<string, unknown>>).flatMap((row): Found[] => {
      const key = keyOf(table, row) as Record<string, unknown> | null;
      if (!key) return [];
      const name = rowLabel(table, row) as string;
      const said = line && row[line] !== null && row[line] !== undefined && row[line] !== '' ? String(row[line]) : undefined;
      return [{ label: name, ...(said ? { line: said } : {}), key, open: () => void openRecord(table.id, key, name) }];
    });
  } catch {
    return [];
  }
}
