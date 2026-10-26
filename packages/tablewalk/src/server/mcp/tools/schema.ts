/**
 * The tools that answer from the catalog: which connections there are,
 * re-reading one, the shape in names and numbers, the table list, one table
 * in full, and where a name or a value lives. `find`'s value sweep is the
 * one that reads rows, and it is here because it answers the same question
 * as the name search.
 */
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { readRecords } from '@mistriwork/engine/server/resourceReadOperations.js';
import {
  primaryKey,
  referencesFrom,
  referencesTo,
  renderDDL,
  tableNamed,
  type DatabaseSchema,
  type TableMeta,
} from '@mistriwork/engine/shared/schema.js';
// Plain JS and pure on purpose — the same analysis the landing page says out
// loud, importable here because it takes a schema and touches nothing else.
import { describeSchema } from '@mistriwork/engine/shared/shape.js';
import { linkTo, READS, sessionEgress, STATS, type Handler } from '../toolkit.js';

export const definitions = [
  {
    name: 'connections',
    description:
      'List the configured database connections: id, name, dialect, and table count. ' +
      'Call this first when unsure which database to ask about; every other tool takes ' +
      'an optional "connection" (the id) and defaults to the active one.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { title: 'List connections', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connections: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string' },
              dialect: { type: 'string' },
              tables: { type: 'number' },
              active: { type: 'boolean', description: 'The default when no connection is named.' },
              writable: { type: 'boolean' },
            },
          },
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'refresh',
    description:
      'Re-read a connection\u2019s schema from the database catalog. The schema is introspected ' +
      'once when a connection opens and cached; after running a migration or any DDL, call ' +
      'this so every other tool stops answering from the world before it.',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { title: 'Refresh the schema', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        tables: { type: 'number' },
        foreignKeys: { type: 'number' },
        readAt: { type: 'string' },
        stats: STATS,
      },
    },
  },
  {
    name: 'schema_summary',
    description:
      'Orient in an unfamiliar schema in one call: which tables the domain centres on ' +
      '(hubs), which record events, which are join tables, the deepest reference chain, ' +
      'and what stands alone. Derived from the foreign-key graph, so it cannot name a ' +
      'table that does not exist. Start here before reaching for table lists or DDL.',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string', description: 'Connection id; defaults to the active connection.' } },
      additionalProperties: false,
    },
    annotations: { title: 'Orient in the schema', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        label: { type: 'string' },
        dialect: { type: 'string' },
        tables: { type: 'number' },
        foreignKeys: { type: 'number' },
        centresOn: {
          type: 'array',
          description: 'The hubs the domain is about.',
          items: { type: 'object', properties: { table: { type: 'string' }, pointedAtBy: { type: 'number' } } },
        },
        recordsEventsIn: { type: 'array', items: { type: 'string' } },
        joinTables: {
          type: 'array',
          items: { type: 'object', properties: { table: { type: 'string' }, connects: { type: 'array', items: { type: 'string' } } } },
        },
        deepestWalk: { type: 'array', items: { type: 'string' } },
        standingAlone: { type: 'array', items: { type: 'string' } },
        startAt: { type: 'string' },
        stats: STATS,
      },
    },
  },
  {
    name: 'tables',
    description: 'Every table on a connection: id, column count, approximate rows, and whether it is a view.',
    inputSchema: {
      type: 'object',
      properties: { connection: { type: 'string' } },
      additionalProperties: false,
    },
    annotations: { title: 'List tables', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        tables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              columns: { type: 'number' },
              approxRows: { type: 'number', description: 'An estimate, not a count; views go unestimated.' },
              isView: { type: 'boolean' },
            },
          },
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'table',
    description:
      'One table in full: columns with types, nullability, defaults and — where the ' +
      'database pins them — the values a column is allowed to hold, plus the primary ' +
      'key, DDL, and the part not in any ORM file: its foreign keys in BOTH directions, ' +
      'what it points at and every table that points at it, with ON DELETE rules.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table id, e.g. "invoice".' },
        connection: { type: 'string' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { title: 'One table in full', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        isView: { type: 'boolean' },
        approxRows: { type: 'number' },
        primaryKey: { type: 'array', items: { type: 'string' } },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: { type: 'string' },
              nullable: { type: 'boolean' },
              primaryKey: { type: 'boolean' },
              references: { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' } } },
              default: { type: 'string' },
              allowed: {
                type: 'array',
                items: { type: 'string' },
                description: 'The values the database accepts here — an enum, or a CHECK the adapter could read.',
              },
            },
          },
        },
        pointsAt: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              via: { type: 'array', items: { type: 'string' } },
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              onDelete: { type: 'string' },
            },
          },
        },
        pointedAtBy: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              via: { type: 'array', items: { type: 'string' } },
              onDelete: { type: 'string' },
            },
          },
        },
        ddl: { type: 'string' },
        link: { type: 'string', description: 'Open this table in the tablewalk UI.' },
        stats: STATS,
      },
    },
  },
  {
    name: 'find',
    description:
      'Where something lives. `name` searches table and column names, case-insensitive ' +
      'substring — "which tables carry warehouse_id". `value` searches the data itself: ' +
      'the text columns of every table, plus uuid columns when the value is a whole ' +
      'uuid — "which table mentions Nakamura". Give one or the other, not both.\n' +
      'The sweep is bounded and says how it ended: `searched` counts tables actually ' +
      'read, `failed` names any it could not read and why, `moreIn` names tables that ' +
      'had more matches than it returned, and `stopped` with `unreached` says when a ' +
      'cap or the time budget ended it rather than the data. No `failed` and no ' +
      '`stopped` is the only reading of "not in this database". Matches count as rows read.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'A name or fragment, matched against table and column names.' },
        value: { type: ['string', 'number'], description: 'A value, matched against the text columns of every table.' },
        /* `name` and `value` are both optional and mutually exclusive, which
           JSON Schema can say and few clients enforce — the tool refuses in
           words as well. */
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Find a name or a value', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        tables: {
          type: 'array',
          items: { type: 'object', properties: { id: { type: 'string' }, columns: { type: 'number' }, isView: { type: 'boolean' } } },
        },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              column: { type: 'string' },
              type: { type: 'string' },
              references: { type: 'object', properties: { table: { type: 'string' }, column: { type: 'string' } } },
            },
          },
        },
        truncated: {
          type: 'object',
          description: 'Name search only: present when the caps cut the lists; the real totals.',
          properties: { tables: { type: 'number' }, columns: { type: 'number' } },
        },
        matches: {
          type: 'array',
          description: 'Value search only: one entry per matching row.',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              key: { type: 'object', description: 'The row key, so the match can be walked to.' },
              values: { type: 'object' },
            },
          },
        },
        searched: { type: 'number', description: 'Tables actually read. Tables that failed are not counted here.' },
        withoutText: { type: 'number', description: 'Tables skipped for having nothing a text search can ask about.' },
        failed: {
          type: 'array',
          description: 'Tables that could not be searched, with the reason. Any entry here means the answer is partial.',
          items: { type: 'object', properties: { table: { type: 'string' }, reason: { type: 'string' } } },
        },
        moreIn: {
          type: 'array',
          description: 'Tables with more matches than were returned.',
          items: { type: 'string' },
        },
        stopped: {
          type: 'string',
          description: 'Set when a cap or the time budget ended the sweep rather than the data.',
        },
        unreached: { type: 'number', description: 'Tables never looked at, because the sweep stopped.' },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

/** The one tool answered without opening a connection: the list is the registry's. */
export function connections(registry: Registry): Record<string, unknown> {
  return {
    connections: registry.list().map((c) => ({
      id: c.id,
      name: c.name,
      dialect: c.dialect,
      tables: c.tables,
      active: c.id === registry.active,
      writable: c.writable,
      /* The trust boundary as a number: data rows this session has handed
         to the caller from this connection. Zero is an auditable answer. */
      rowsReadThisSession: sessionEgress.get(c.id) ?? 0,
    })),
  };
}

export const handlers = {
  refresh: async ({ registry, id }) => {
    const { schema: fresh } = await registry.refresh(id);
    return {
      connection: id,
      tables: fresh.tables.length,
      foreignKeys: fresh.foreignKeys.length,
      readAt: fresh.readAt,
    };
  },
  schema_summary: async ({ schema, id }) => {
    /* Names and numbers only. `describeSchema` returns whole TableMeta
       objects because the landing page renders links from them; serialised
       for a model that would be the column dump this tool exists to avoid —
       a 65-table shape is a few hundred tokens this way and thousands the
       other. `table` is one call away for any name this surfaces. */
    type Shaped = {
      counts: Record<string, number>;
      hubs: Array<{ table: { name: string }; from: string[] }>;
      leaves: Array<{ name: string }>;
      joins: Array<{ table: { name: string }; connects: string[] }>;
      chain: Array<{ name: string }>;
      islands: Array<{ name: string }>;
      start?: { name: string };
    };
    const shape = describeSchema(schema) as Shaped;
    return {
      connection: id,
      label: schema.label,
      dialect: schema.dialect,
      tables: schema.tables.length,
      foreignKeys: schema.foreignKeys.length,
      centresOn: shape.hubs.map((h) => ({ table: h.table.name, pointedAtBy: h.from.length })),
      recordsEventsIn: shape.leaves.map((t) => t.name),
      joinTables: shape.joins.map((j) => ({ table: j.table.name, connects: j.connects })),
      deepestWalk: shape.chain.map((t) => t.name),
      standingAlone: shape.islands.map((t) => t.name),
      startAt: shape.start?.name,
    };
  },
  tables: async ({ schema, id }) => {
    return {
      connection: id,
      tables: schema.tables.map((t) => ({
        id: t.id,
        columns: t.columns.length,
        approxRows: t.approxRows,
        isView: t.isView || undefined,
      })),
    };
  },
  table: async ({ args, adapter, schema, id }) => {
    const asked = String(args.table ?? '');
    if (!asked) throw new Error('Which table? Pass `table`, e.g. {"table": "invoice"}.');
    const table = tableNamed(schema, asked);
    if (!table) throw new Error(`Unknown table "${asked}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const stored = adapter.ddl ? await adapter.ddl(table.id) : undefined;
    return {
      connection: id,
      table: table.id,
      isView: table.isView || undefined,
      approxRows: table.approxRows,
      primaryKey: primaryKey(table),
      columns: table.columns.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable,
        primaryKey: c.primaryKey || undefined,
        references: c.references,
        default: c.default,
        /* The states the system has. A `status` column typed `text` says
           nothing, and an agent that guesses `'OPEN'` gets an empty result
           that reads like an empty table rather than a spelling mistake. */
        allowed: c.allowed,
      })),
      pointsAt: referencesFrom(schema, table.id).map((fk) => ({
        via: fk.from.columns,
        table: fk.to.table,
        columns: fk.to.columns,
        onDelete: fk.onDelete,
      })),
      pointedAtBy: referencesTo(schema, table.id).map((fk) => ({
        table: fk.from.table,
        via: fk.from.columns,
        onDelete: fk.onDelete,
      })),
      ddl: stored ?? renderDDL(schema, table.id),
      link: linkTo(id, encodeURIComponent(table.id)),
    };
  },
  find: async ({ args, adapter, schema, id }) => {
    /* A number is a perfectly ordinary thing to search for, and a client that
       does not coerce to the declared type sends one. Coerced here rather
       than type-checked, or `find {value: 42}` answers "you gave me
       nothing" — about an argument it was given. */
    const value = args.value === undefined || args.value === null ? '' : String(args.value).trim();
    const needle = (args.name === undefined || args.name === null ? '' : String(args.name)).trim();
    /* The description says one or the other; saying it and then quietly
       preferring one is worse than either rule. */
    if (value && needle) {
      throw new Error(
        'Give `name` or `value`, not both. `name` searches table and column names; ' +
          '`value` searches the data. Two different questions, two calls.',
      );
    }
    if (value) return findValue(adapter, schema, id, value);
    if (!needle) throw new Error('Nothing to look for. Give `name` or `value`.');
    const lowered = needle.toLowerCase();
    /* Capped and said so: a one-letter needle on a wide schema matches half
       of it, and a silent cut reads as "that is all there is". */
    const CAP = 40;
    const tables = schema.tables.filter((t) => t.id.toLowerCase().includes(lowered));
    const columns = schema.tables.flatMap((t) =>
      t.columns
        .filter((c) => c.name.toLowerCase().includes(lowered))
        .map((c) => ({
          table: t.id,
          column: c.name,
          type: c.type,
          references: c.references,
        })),
    );
    return {
      connection: id,
      tables: tables.slice(0, CAP).map((t) => ({ id: t.id, columns: t.columns.length, isView: t.isView || undefined })),
      columns: columns.slice(0, CAP),
      truncated: tables.length > CAP || columns.length > CAP ? { tables: tables.length, columns: columns.length } : undefined,
    };
  },
} satisfies Record<Exclude<Name, 'connections'>, Handler>;

/** A uuid, whole — the only shape of it a sweep can match honestly. */
const WHOLE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The columns of one table a value sweep can actually ask about.
 *
 * The type list is not "which columns hold text" but "which columns this
 * database will accept a LIKE against", and the difference is the whole
 * finding: `character varying[]` contains "varchar" and `uuid` reads like a
 * string, and Postgres has no LIKE operator for either. One thrown statement
 * takes the whole table with it — its genuine text columns included — so a
 * table full of the value reports nothing while `scanned` counts it as
 * searched.
 *
 * uuid columns come back separately because equality does work on them: a
 * whole uuid is exactly the value someone pastes out of a log, and dropping
 * uuid keys from the sweep would miss the commonest primary key in modern
 * Postgres.
 */
function searchableColumns(table: TableMeta, value: string): { like: string[]; exact: string[] } {
  const like: string[] = [];
  const exact: string[] = [];
  for (const column of table.columns) {
    const type = column.type;
    /* An array of text is not text: `text[] LIKE '%x%'` is an error, not an
       empty result. */
    if (/\[\]|^ARRAY$/i.test(type)) continue;
    if (/^uuid$/i.test(type)) {
      if (WHOLE_UUID.test(value)) exact.push(column.name);
      continue;
    }
    if (/char|text|varchar|string|clob|citext|enum/i.test(type)) like.push(column.name);
  }
  return { like, exact };
}

/**
 * Where a value lives: a bounded sweep of every table's text columns.
 *
 * Honest about being a sweep, which means honest about three separate
 * things, because a sweep that hides any of them fabricates a negative —
 * `{matches: [], scanned: 12}` reads as "I searched twelve tables and it is
 * not there":
 *
 *   - a table it could not read is named, with the reason, not counted as
 *     searched;
 *   - a table that had more matches than it reported is named;
 *   - and when a budget rather than the data ended the sweep, it says so and
 *     says how many tables it never reached.
 *
 * The budgets bound the work, not just the answer. A value that matches
 * nothing — the usual reason for searching — costs one unindexed scan per
 * table with no early exit, and on SQLite the driver is synchronous, so
 * those scans block the web UI and every other call with them.
 */
export async function findValue(adapter: Adapter, schema: DatabaseSchema, id: string, value: string): Promise<Record<string, unknown>> {
  const PER_TABLE = 5;
  const TOTAL = 40;
  const BUDGET_MS = 5_000;
  const deadline = Date.now() + BUDGET_MS;

  const matches: Array<Record<string, unknown>> = [];
  const failed: Array<{ table: string; reason: string }> = [];
  const moreIn: string[] = [];
  const needle = value.toLowerCase();
  let searched = 0;
  let withoutText = 0;
  let unreached = 0;
  let stopped: string | undefined;

  for (const table of schema.tables) {
    if (stopped) {
      unreached += 1;
      continue;
    }
    if (matches.length >= TOTAL) {
      stopped = 'match cap';
      unreached += 1;
      continue;
    }
    if (Date.now() > deadline) {
      stopped = 'time budget';
      unreached += 1;
      continue;
    }

    const { like, exact } = searchableColumns(table, value);
    if (!like.length && !exact.length) {
      withoutText += 1;
      continue;
    }

    const key = primaryKey(table);
    const wanted = [...new Set([...key, ...like, ...exact])];
    /* One more than needed, so "there were exactly five" and "there were at
       least five" stay distinguishable. */
    const room = Math.min(PER_TABLE, TOTAL - matches.length);
    try {
      const { result: found } = await readRecords(adapter, schema, {
        table: table.id,
        /* One group per column: groups are OR-ed, which is exactly "any of
           these columns holds it". */
        filter: {
          groups: [
            ...like.map((column) => [{ column, op: 'contains' as const, value }]),
            ...exact.map((column) => [{ column, op: '=' as const, value }]),
          ],
        },
        columns: wanted,
        limit: room + 1,
        offset: 0,
      });
      searched += 1;
      const rows = found.rows as Array<Record<string, unknown>>;
      if (rows.length > room) moreIn.push(table.id);
      for (const row of rows.slice(0, room)) {
        const where = wanted.filter((c) => {
          const held = row[c];
          if (held === null || held === undefined) return false;
          return exact.includes(c)
            ? String(held).toLowerCase() === needle
            : like.includes(c) && String(held).toLowerCase().includes(needle);
        });
        /* A match that cannot name the column it matched on is not evidence
           of anything — it is the row the database returned for a pattern
           this code no longer understands. */
        if (!where.length) continue;
        matches.push({
          table: table.id,
          columns: where,
          key: key.length ? Object.fromEntries(key.map((c) => [c, row[c]])) : undefined,
          values: Object.fromEntries(where.map((c) => [c, row[c]])),
        });
      }
      if (matches.length >= TOTAL) stopped = 'match cap';
    } catch (err) {
      /* Named, not swallowed. One unreadable table must not stop the sweep,
         and must not be reported as a searched one either. */
      failed.push({ table: table.id, reason: (err as Error).message });
    }
  }

  return {
    connection: id,
    value,
    matches,
    searched,
    withoutText,
    failed: failed.length ? failed : undefined,
    moreIn: moreIn.length ? moreIn : undefined,
    stopped,
    unreached: unreached || undefined,
  };
}
