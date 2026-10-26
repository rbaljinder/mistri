/**
 * The tools that reason about the shape rather than read rows: what a
 * table's columns hold, how two connections differ, what has to exist first,
 * a real row as a fixture, what the shape will cost, and what a change would
 * break. Each wraps one analysis that lives elsewhere; this file is their
 * declarations and the argument handling in front of them.
 */
import { changeImpact } from '../../changeimpact.js';
import { extractFixture } from '../../fixture.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { lintCounts, lintSchema } from '../../../shared/lint.js';
import { diffSchemas } from '../../../shared/diff.js';
import { insertOrder } from '@mistriwork/engine/shared/order.js';
import { linkTo, openFor, READS, STATS, wholeKeyOrThrow, type Handler } from '../toolkit.js';

export const definitions = [
  {
    name: 'profile',
    description:
      'What a table’s columns actually hold: null share, distinct count, range, and the ' +
      'values that repeat most — the look before writing a filter, so `status = closed` ' +
      'is a lookup, not a guess. On Postgres this reads the planner’s own statistics and ' +
      'costs nothing; elsewhere it scans, and `source` says which happened, so the numbers ' +
      'carry their own credibility.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Table id, e.g. "invoice".' },
        connection: { type: 'string' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { title: 'Profile a table', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        rows: { type: 'number', description: 'Estimated under `statistics`, exact otherwise.' },
        sampled: { type: 'number', description: 'Rows the fractions are relative to, when `source` is sample.' },
        source: {
          type: 'string',
          enum: ['statistics', 'scan'],
          description:
            'statistics: the planner’s kept numbers, sample-based and free. scan: computed by reading the table. sample: a bounded slice of a table too large to scan.',
        },
        columns: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              column: { type: 'string' },
              type: { type: 'string' },
              nullFrac: { type: 'number', description: 'Share of rows where this column is null, 0..1.' },
              distinct: { type: 'number' },
              min: {},
              max: {},
              common: {
                type: 'array',
                description: 'The values that repeat most, each with its share of rows. Absent when nothing repeats.',
                items: { type: 'object', properties: { value: {}, frac: { type: 'number' } } },
              },
            },
          },
        },
        link: { type: 'string' },
        stats: STATS,
      },
    },
  },
  {
    name: 'diff',
    description:
      'Two connections, and what is different about their shape: tables on one side only, ' +
      'columns added or dropped, types, nullability, defaults and allowed values that ' +
      'changed, foreign keys gained or lost, and delete rules that now do something else. ' +
      'Compares the model rather than two dumps, so formatting is never a difference and a ' +
      'column that became nullable always is. Answers "is staging the same shape as ' +
      'production" and "what did that migration actually change".',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Connection id you have. Defaults to the active one.' },
        to: { type: 'string', description: 'Connection id to compare against.' },
      },
      required: ['to'],
      additionalProperties: false,
    },
    annotations: { title: 'Compare two schemas', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string' },
        to: { type: 'string' },
        same: { type: 'boolean', description: 'True when the two describe the same shape.' },
        tables: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              onlyIn: { type: 'string', description: '"left" is `from`, "right" is `to`.' },
              columnsOnlyLeft: { type: 'array', items: { type: 'string' } },
              columnsOnlyRight: { type: 'array', items: { type: 'string' } },
              changed: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    column: { type: 'string' },
                    what: { type: 'string' },
                    left: { type: 'string' },
                    right: { type: 'string' },
                  },
                },
              },
              keysOnlyLeft: { type: 'array', items: { type: 'string' } },
              keysOnlyRight: { type: 'array', items: { type: 'string' } },
              deleteRuleChanged: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'order',
    description:
      'What has to exist first. Every foreign key is a statement about time — a row ' +
      'cannot point at a row that is not there yet — so this answers the order to insert ' +
      'in, the reverse order to delete in, and what each table requires with the columns ' +
      'that require it. Cycles are named rather than broken arbitrarily, along with the ' +
      'nullable reference that is the way through one; a table that points at itself is ' +
      'reported separately, because it is an order inside the table rather than between ' +
      'tables. Building fixtures, tearing them down, and planning a migration all ask ' +
      'this same question.',
    inputSchema: {
      type: 'object',
      properties: {
        tables: {
          type: 'array',
          items: { type: 'string' },
          description: 'The tables to order. Omit for every table in the schema.',
        },
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'What has to exist first', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        insert: { type: 'array', items: { type: 'string' }, description: 'Parents first.' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Children first.' },
        requires: {
          type: 'object',
          description: 'Table id → what must exist before it, with the columns and whether it can wait.',
        },
        cycles: {
          type: 'array',
          items: { type: 'array', items: { type: 'string' } },
          description: 'Tables with no order between them. Present only when there are any.',
        },
        selfReferencing: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tables whose rows have an order among themselves.',
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'fixture',
    description:
      'One real row, and everything it needs to exist. Walks the references away from a ' +
      'row — its customer, that customer\u2019s country — and optionally the rows pointing ' +
      'at it, then returns them grouped by table in the order they must be inserted, plus ' +
      'ready-to-paste INSERT statements. The rule the output satisfies: inserted in the ' +
      'order given, nothing dangles. Bounded, and it says what it cut. This is test data ' +
      'taken from a database that already has the shape you need, rather than invented.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        key: { type: 'object', description: 'The row to start from: {"id": 1885}.' },
        children: {
          type: 'boolean',
          description: 'Also take rows that point at it, with their own references resolved.',
        },
        depth: { type: 'number', description: 'Reference hops to follow. Default 3.' },
        per_child: { type: 'number', description: 'Rows per child relationship. Default 5.' },
        max: { type: 'number', description: 'Ceiling on the whole fixture. Default 100.' },
        connection: { type: 'string' },
      },
      required: ['table', 'key'],
      additionalProperties: false,
    },
    annotations: { title: 'Take a row as a fixture', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        key: { type: 'object' },
        tables: {
          type: 'array',
          description: 'Tables in insert order, each with its rows.',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              rows: { type: 'array', items: { type: 'object' } },
            },
          },
        },
        order: { type: 'array', items: { type: 'string' } },
        sql: { type: 'string', description: 'The same rows as INSERT statements, in order.' },
        truncated: {
          type: 'array',
          items: { type: 'string' },
          description: 'What was left out. Absent when nothing was.',
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'lint',
    description:
      'What this shape will cost: tables with no primary key (no row can be linked to or ' +
      'edited), foreign keys with no index leading on them (every walk back is a full ' +
      'scan, and so is deleting a parent), references with no ON DELETE rule, and ' +
      'timestamps with no time zone. Catalog facts only — no queries, no guesses about ' +
      'intent. Useful before a migration, and before writing code against a table you ' +
      'have not met. Summary-first: complete counts, the rule explanations once each in ' +
      '`rules`, and at most five example findings per rule — `all: true`, `table` or ' +
      '`severity` for the rest.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'Only this table. Omit for the whole schema.' },
        severity: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'At least this severe. Default: everything.',
        },
        all: {
          type: 'boolean',
          description:
            'Every finding. Default is at most 5 per rule, which is what "what kind of trouble ' +
            'is this schema in" needs — the counts are always complete either way.',
        },
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Lint the shape', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        counts: {
          type: 'object',
          properties: { high: { type: 'number' }, medium: { type: 'number' }, low: { type: 'number' } },
        },
        rules: {
          type: 'object',
          description:
            'Each rule that fired, once: its severity and what it costs. Findings name their ' + 'rule rather than repeating this.',
          additionalProperties: {
            type: 'object',
            properties: { severity: { type: 'string' }, why: { type: 'string' } },
          },
        },
        total: { type: 'number', description: 'Findings matching the filters.' },
        shown: { type: 'number', description: 'How many are listed below.' },
        note: { type: 'string', description: 'Present when findings were withheld, and how to get them.' },
        findings: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              rule: { type: 'string', description: 'Look it up in `rules` for what it costs.' },
              severity: { type: 'string' },
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              message: { type: 'string', description: 'What is true of this table.' },
            },
          },
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'change_impact',
    description:
      'What breaks if you change this table or column — asked BEFORE writing the migration. ' +
      'Every table pointing at it with its ON DELETE rule, whether those referencing columns ' +
      'are NOT NULL (so their rows cannot be left pointing at nothing), whether an index leads ' +
      'on them (so whether each constraint check is a scan), and how many rows each holds. ' +
      'For a named column: its type, default, allowed values, and — the one that decides ' +
      'whether an ALTER succeeds — how many rows actually hold null. Answers "can I add NOT ' +
      'NULL to this", "what does dropping this cascade into", "why is this migration slow". ' +
      'These are the facts that live in the database rather than the repository, so grep ' +
      'cannot answer any of them. Read-only: it never alters anything.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string', description: 'The table being changed.' },
        column: {
          type: 'string',
          description: 'Narrow to one column. Omit to ask about the whole table.',
        },
        connection: { type: 'string' },
      },
      required: ['table'],
      additionalProperties: false,
    },
    annotations: { title: 'What a change would break', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        column: { type: 'string' },
        rows: { type: 'number', description: 'Rows in the table being changed.' },
        columnFacts: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            type: { type: 'string' },
            nullable: { type: 'boolean' },
            primaryKey: { type: 'boolean' },
            default: { type: 'string' },
            allowed: { type: 'array', items: { type: 'string' } },
            references: { type: 'object' },
            indexed: { type: 'boolean', description: 'Absent when the adapter does not report indexes.' },
            nulls: { type: 'number', description: 'Rows holding null. Counted only where it can be non-zero.' },
          },
        },
        referencedBy: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              constraint: { type: 'string' },
              table: { type: 'string' },
              columns: { type: 'array', items: { type: 'string' } },
              toColumns: { type: 'array', items: { type: 'string' } },
              onDelete: { type: 'string', description: 'Absent is "not reported", not "no action".' },
              nullable: { type: 'boolean' },
              indexed: { type: 'boolean' },
              rows: { type: 'number' },
            },
          },
        },
        references: { type: 'array', items: { type: 'object' } },
        notes: {
          type: 'array',
          items: { type: 'string' },
          description: 'The consequences in sentences, worst first. Every claim is checkable against the fields.',
        },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

export const handlers: Record<Name, Handler> = {
  profile: async ({ args, adapter, schema, id }) => {
    if (!adapter.profile) {
      throw new Error(`${schema.dialect} connections cannot profile in this build.`);
    }
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const result = await adapter.profile(table.id);
    return { connection: id, ...result, link: linkTo(id, encodeURIComponent(table.id)) };
  },
  diff: async ({ registry, args, schema, id }) => {
    const other = String(args.to ?? '').trim();
    if (!other) throw new Error('`to` names the connection to compare against. Ask `connections` for what exists.');
    if (other === id) throw new Error(`"${id}" compared with itself is always the same shape. Name a different connection.`);
    /* Opened here rather than through the caller's resolved pair: a diff is
       the one read that is *about* two connections, and the second one may
       never have been opened this session. */
    const { schema: theirs } = await openFor(registry, other);
    /* The labels are dropped: `from` and `to` are the connection ids a caller
       can act on, and two names for the same pair invites using the wrong
       one in the next call. */
    const { left: _left, right: _right, ...rest } = diffSchemas(schema, theirs);
    return { from: id, to: other, ...rest };
  },
  order: async ({ args, schema, id }) => {
    /* An array, or the comma-separated string clients send when the schema
       says array — the `pre-migration-check` prompt takes tables that way,
       and being strict here would refuse the shape this server's own prompt
       teaches. */
    const asked = Array.isArray(args.tables)
      ? args.tables.map(String)
      : typeof args.tables === 'string' && args.tables.trim()
        ? args.tables
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
        : undefined;
    for (const wanted of asked ?? []) {
      if (!tableNamed(schema, wanted)) {
        throw new Error(`Unknown table "${wanted}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
      }
    }
    const plan = insertOrder(
      schema,
      asked?.map((t) => tableNamed(schema, t)!.id),
    );
    return {
      connection: id,
      insert: plan.insert,
      remove: plan.remove,
      requires: plan.requires,
      /* Absent rather than empty: "there are no cycles" is the ordinary case
         and an empty array in every answer is noise the reader learns to
         skip past — which is how the one that is not empty gets missed. */
      cycles: plan.cycles.length ? plan.cycles : undefined,
      selfReferencing: plan.selfReferencing.length ? plan.selfReferencing : undefined,
    };
  },
  lint: async ({ args, schema, id }) => {
    const only = args.table === undefined ? undefined : tableNamed(schema, String(args.table));
    if (args.table !== undefined && !only) {
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    }
    const levels = ['high', 'medium', 'low'];
    const floor = args.severity === undefined ? levels.length - 1 : levels.indexOf(String(args.severity));
    if (floor === -1) throw new Error('`severity` is high, medium or low.');
    const wanted = new Set(levels.slice(0, floor + 1));
    const findings = lintSchema(schema)
      .filter((f) => (only ? f.table === only.id : true))
      .filter((f) => wanted.has(f.severity));

    /* `why` is a property of the rule, not of the finding — the type that
       carries it says so, and it was still being written out once per
       finding. On a 66-table schema that is 265 findings sharing three
       sentences: a third of a 24,000-token answer spent repeating them, on a
       tool an agent calls to *orient*, before it has formed an opinion.

       So the sentences go out once, keyed by rule, and each finding names its
       rule. Nothing is lost — the same text is still one lookup away — and
       the answer stops charging the reader for the same paragraph 88 times. */
    const rules: Record<string, { severity: string; why: string }> = {};
    for (const f of findings) rules[f.rule] ??= { severity: f.severity, why: f.why };

    /* And the list itself is summary-first. A caller that wants everything
       says so; the common case is "what kind of trouble is this schema in",
       which the counts and a few examples per rule answer completely. The
       filters that narrow it already existed — only the default was wrong. */
    const PER_RULE = 5;
    const all = args.all === true;
    const kept: typeof findings = [];
    const seen: Record<string, number> = {};
    for (const f of findings) {
      seen[f.rule] = (seen[f.rule] ?? 0) + 1;
      if (all || seen[f.rule] <= PER_RULE) kept.push(f);
    }
    const withheld = findings.length - kept.length;

    return {
      connection: id,
      counts: lintCounts(findings),
      rules,
      findings: kept.map(({ why: _why, ...rest }) => rest),
      total: findings.length,
      shown: kept.length,
      /* Said out loud rather than left to be inferred from two numbers: a
         truncated list that does not admit it reads as a complete one. */
      ...(withheld
        ? {
            note:
              `${withheld} more finding${withheld === 1 ? '' : 's'} not listed — showing at most ` +
              `${PER_RULE} per rule. Ask with \`all: true\` for every one, or narrow with ` +
              '`table` or `severity`.',
          }
        : {}),
    };
  },
  change_impact: async ({ args, adapter, schema, id }) => {
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table) {
      throw new Error(
        `Unknown table "${String(args.table ?? '')}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`,
      );
    }
    return {
      connection: id,
      ...(await changeImpact(adapter, schema, table.id, args.column === undefined ? undefined : String(args.column))),
    };
  },
  fixture: async ({ args, adapter, schema, id }) => {
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const key = (args.key ?? {}) as Record<string, string | number>;
    wholeKeyOrThrow(schema, table, key);
    const taken = await extractFixture(adapter, schema, table.id, key, {
      children: args.children === true,
      depth: args.depth === undefined ? undefined : Number(args.depth),
      perChild: args.per_child === undefined ? undefined : Number(args.per_child),
      max: args.max === undefined ? undefined : Number(args.max),
    });
    return { connection: id, ...taken };
  },
};
