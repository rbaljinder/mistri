/**
 * `record`: one row, its human name, and every table that points at it with
 * a count — the reverse walk no SQL client surfaces — for one key or twenty.
 */
import type { Adapter, Filter } from '@mistriwork/engine/adapters/adapter.js';
import { readCount, readRecords, readView } from '@mistriwork/engine/server/resourceReadOperations.js';
import { findTable, labelPath, primaryKey, referencesTo, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { quoteValue } from '@mistriwork/engine/shared/query.js';
import { COUNT_LIMIT, COUNT_LIMIT_WORDS as bound, linkTo, READS, STATS, type Handler } from '../toolkit.js';

export const definitions = [
  {
    name: 'record',
    description:
      'One row and everything about it: the fields, the row’s human name (resolved through ' +
      'identity references, e.g. an employee named by its party), and every table that points ' +
      `at this row with a count, up to ${bound} — the reverse walk no SQL client surfaces. ` +
      'Key values: `{"id": 42}`, or every column of a composite key. ' +
      'Several records in one call with `keys: [{id: 1}, {id: 2}]` (up to 20); ' +
      '`expand: 3` inlines the first rows of each non-empty relationship, so record-then-' +
      'children stops costing a call per relationship.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        key: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        keys: {
          type: 'array',
          description: 'Several keys at once; answers arrive as `records`, in this order.',
          items: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        },
        expand: { type: 'number', description: 'Inline up to this many rows per non-empty relationship (max 10).' },
        connection: { type: 'string' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { title: 'One row, walked', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        key: { type: 'object' },
        found: { type: 'boolean', description: 'false is an answer: nothing lives at this key.' },
        label: { type: 'string', description: 'The row’s human name, resolved through identity references.' },
        row: { type: 'object' },
        pointedAtBy: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              via: { type: 'array', items: { type: 'string' } },
              count: { type: 'number', description: `Rows pointing here, counted up to ${bound}.` },
              capped: {
                type: 'boolean',
                description: 'Present when the count reached its bound: `count` is the bound, and more rows point here.',
              },
              query: { type: 'string', description: 'Feed back to `query` verbatim to see the rows behind the count.' },
            },
          },
        },
        link: { type: 'string', description: 'Open this record in the tablewalk UI.' },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

export const handlers = {
  record: async ({ args, adapter, schema, id }) => {
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const keys = Array.isArray(args.keys)
      ? (args.keys as Array<Record<string, string | number>>)
      : args.key
        ? [args.key as Record<string, string | number>]
        : [];
    if (!keys.length) throw new Error('Give `key` for one record, or `keys` for several.');
    if (keys.length > 20) throw new Error(`${keys.length} keys is more than one call carries. Take 20 at a time.`);
    const expand = Math.max(0, Math.min(10, Number(args.expand ?? 0) || 0));

    const wanted = primaryKey(table);
    for (const key of keys) {
      const missing = wanted.filter((c) => key[c] === undefined);
      if (missing.length) {
        throw new Error(`A key is missing ${missing.join(', ')} — a ${table.name} is identified by (${wanted.join(', ')}).`);
      }
    }

    const records = [];
    for (const key of keys) records.push(await recordAnswer(adapter, schema, id, table, key, expand));

    /* One key keeps the shape every earlier caller learned; several arrive
       as `records`, in the order the keys came. */
    return Array.isArray(args.keys) ? { connection: id, table: table.id, records } : { connection: id, table: table.id, ...records[0] };
  },
} satisfies Record<Name, Handler>;

/**
 * One record's whole answer: the row, its walked-to name, and what points at
 * it — with the counts' rows inlined when the caller asked to expand. The
 * chattiest pattern in real sessions was record-then-one-query-per-
 * relationship; `expand` folds it into the call that already knew the
 * conditions.
 */
async function recordAnswer(
  adapter: Adapter,
  schema: DatabaseSchema,
  id: string,
  table: NonNullable<ReturnType<typeof findTable>>,
  key: Record<string, string | number>,
  expand: number,
): Promise<Record<string, unknown>> {
  const filter: Filter = {
    groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))],
  };
  const { result: found } = await readRecords(adapter, schema, { table: table.id, filter, limit: 1, offset: 0 });
  const row = found.rows[0] as Record<string, unknown> | undefined;
  if (!row) return { key, found: false };

  let label: unknown;
  const path = labelPath(schema, table);
  if (path && !path.includes('.')) label = row[path];
  else if (path && adapter.runView) {
    const { result: named } = await readView(
      adapter,
      schema,
      {
        id: 'mcp:name',
        name: table.name,
        base: table.id,
        columns: [{ path }],
        filter: { groups: [Object.entries(key).map(([p, value]) => ({ path: p, op: '=' as const, value }))] },
        limit: 1,
      },
      { offset: 0 },
      'none',
    );
    label = (named.rows[0] as Record<string, unknown> | undefined)?.[path];
  }

  const pointedAtBy = [];
  /* A reference may point at a column that is not this row's key (a code, a
     unique slug): its value is the row's, which is already read. */
  const referenced: Record<string, unknown> = { ...row, ...key };
  for (const fk of referencesTo(schema, table.id)) {
    const conditions = fk.to.columns.map((toCol, i) => ({
      column: fk.from.columns[i] ?? fk.from.columns[0],
      op: '=' as const,
      value: (referenced[toCol] ?? undefined) as string | number | undefined,
    }));
    if (conditions.some((c) => c.value === undefined || c.value === null)) continue;
    try {
      const { count, capped } = await readCount(adapter, schema, {
        table: fk.from.table,
        filter: { groups: [conditions] },
        exact: true,
        countLimit: COUNT_LIMIT,
      });
      const entry: Record<string, unknown> = {
        table: fk.from.table,
        via: fk.from.columns,
        count,
        ...(capped ? { capped } : {}),
        query:
          count > 0 ? `${fk.from.table} ${conditions.map((c) => `${c.column} = ${quoteValue(String(c.value))}`).join(' and ')}` : undefined,
      };
      if (expand > 0 && count > 0) {
        const { result: children } = await readRecords(adapter, schema, {
          table: fk.from.table,
          filter: { groups: [conditions] },
          limit: expand,
          offset: 0,
        });
        entry.rows = children.rows;
      }
      pointedAtBy.push(entry);
    } catch {
      /* One unreadable table should not blank the answer. */
    }
  }

  const body =
    Object.keys(key).length === 1
      ? String(Object.values(key)[0])
      : Object.entries(key)
          .map(([c, v]) => `${c}=${v}`)
          .join(',');
  return {
    key,
    found: true,
    label: label ?? undefined,
    row,
    pointedAtBy,
    link: linkTo(id, `${encodeURIComponent(table.id)}/~${encodeURIComponent(body)}`),
  };
}
