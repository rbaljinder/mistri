/**
 * The write tools, and the gates in front of them: the connection must be
 * marked writable, an App's write scope narrows it further, a delete reports
 * its impact before it removes anything, and a client that can ask the
 * person is asked. Every write goes through the same recorded operations the
 * browser's edits do, so each one has an undo entry.
 */
import { history, lastRevertible, revert } from '@mistriwork/engine/server/journal.js';
import { changingReferences, recordedDelete, recordedInsert, recordedUpdate } from '@mistriwork/engine/server/recordWriteOperations.js';
import { deleteImpact } from '@mistriwork/engine/server/impact.js';
import { explainWriteFailure, writeFailureOutcome } from '@mistriwork/engine/server/constraints.js';
import { deleteGraph, flattenTables, insertGraph, type GraphRow } from '../../graph.js';
import { Refusal, TransactionOutcomeUnknown, type UpdateRequest } from '@mistriwork/engine/adapters/adapter.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { linkTo, STATS, wholeKeyOrThrow, type Handler, type ToolCall } from '../toolkit.js';

/**
 * Offered only when some connection's config says `"writable": true` — the
 * same opt-in the browser's write mode rides on. A server over read-only
 * connections does not list tools it would refuse, because a tool that
 * always errors teaches the model to stop trusting the list.
 */
export const definitions = [
  {
    name: 'update',
    description:
      'Set columns on exactly one row, identified by its whole primary key: ' +
      '`{table, key: {id: 7}, set: {status: "closed", priority: 2}}`. Several columns go ' +
      'in one statement — three fields as three calls is three chances to fail half way. ' +
      'The connection must be marked writable in tablewalk.json; values are bound, coerced ' +
      'to their column types, and echoed back as applied.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        key: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        set: {
          type: 'object',
          description: 'Column name to new value. null clears a nullable column.',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
        expected: {
          type: 'object',
          description: 'Original values for exactly the fields being set; checked atomically.',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
        connection: { type: 'string' },
      },
      required: ['table', 'key', 'set'],
      additionalProperties: false,
    },
    /* destructiveHint is true because it is: the value overwritten is gone.
       Idempotent, though — the same call landing twice leaves the same row. */
    annotations: { title: 'Update one row', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        key: { type: 'object' },
        affected: { type: 'number' },
        applied: { type: 'object', description: 'The values as the column types coerced them.' },
        outcome: { type: 'string', enum: ['unknown'] },
        errors: { type: 'array', items: { type: 'string' } },
        undoId: { type: 'number' },
        sql: { type: 'object' },
        link: { type: 'string' },
        stats: STATS,
      },
    },
  },
  {
    name: 'insert',
    description:
      'Add one row: `{table, values: {status: "open", customer_id: 7}}`. Leave out what ' +
      'the database should fill — defaults and auto-assigned keys — and it answers with ' +
      'the row as stored, defaults included, plus its new key. A constraint the database ' +
      'refuses comes back in its own words as `errors`; fix and retry. The connection ' +
      'must be marked writable in tablewalk.json.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        values: {
          type: 'object',
          description: 'Column name to value for the new row.',
          additionalProperties: { type: ['string', 'number', 'boolean', 'null'] },
        },
        connection: { type: 'string' },
      },
      required: ['table', 'values'],
      additionalProperties: false,
    },
    /* Not destructive: an insert adds and destroys nothing — the hint a
       client uses to decide how loudly to ask. Not idempotent either: the
       same call twice is two rows, or one row and a UNIQUE refusal. */
    annotations: { title: 'Insert one row', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        inserted: { type: ['boolean', 'null'], description: 'Null means the write outcome is unknown; reconcile before retrying.' },
        outcome: { type: 'string', enum: ['rejected', 'unknown'] },
        undoId: { type: 'number' },
        key: { type: 'object', description: "The new row's primary key, read back from the database." },
        row: { type: 'object', description: 'The row as stored — defaults filled, types settled.' },
        sql: { type: 'object' },
        errors: { type: 'array', description: "The database's own words for a constraint it refused." },
        link: { type: 'string' },
        stats: STATS,
      },
    },
  },
  {
    name: 'delete',
    description:
      'Remove one row — in two calls, deliberately. Without `confirm: true` this only ' +
      'reports the impact: every table pointing at the row, with counts and ON DELETE ' +
      'rules, because the same three referencing rows are three deletions under cascade, ' +
      'three holes under set null, and a refusal under restrict. Read the impact, then ' +
      'call again with `confirm: true`. The connection must be marked writable.',
    inputSchema: {
      type: 'object',
      properties: {
        table: { type: 'string' },
        key: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
        confirm: { type: 'boolean', description: 'Actually delete. Absent means report only.' },
        connection: { type: 'string' },
      },
      required: ['table', 'key'],
      additionalProperties: false,
    },
    annotations: { title: 'Delete one row', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        table: { type: 'string' },
        key: { type: 'object' },
        deleted: { type: ['boolean', 'null'], description: 'Null means the write outcome is unknown; reconcile before retrying.' },
        outcome: { type: 'string', enum: ['rejected', 'unknown'] },
        undoId: { type: 'number' },
        impact: {
          type: 'array',
          description: 'Every table pointing at the row, with counts and ON DELETE rules.',
          items: {
            type: 'object',
            properties: { table: { type: 'string' }, count: { type: 'number' }, onDelete: { type: 'string' } },
          },
        },
        affected: { type: 'number' },
        note: { type: 'string' },
        errors: { type: 'array', items: { type: 'string' } },
        stats: STATS,
      },
    },
  },
  {
    name: 'insert_graph',
    description:
      'Insert several related rows as one thing, in one transaction: either every row ' +
      'lands or none does. This is how to create test data — a fixture is a graph, and ' +
      'ten separate `insert` calls that fail at the seventh leave six rows and a dirty ' +
      'database. Rows go in the order given; ask `order` if you are unsure what it is. ' +
      'A row that does not know its parent\u2019s key names it by label instead: give the ' +
      'parent `as: "c1"` and write `{"customer_id": {"ref": "c1"}}` on the child — that ' +
      'resolves to the parent\u2019s new primary key, or to `{"ref": "c1", "column": "code"}` ' +
      'for any other column of the row as stored. `fixture`\u2019s `tables` can be passed ' +
      'straight through as `tables`. The answer carries a `teardown` list, in reverse ' +
      'order, ready for `delete_graph`. The connection must be marked writable.',
    inputSchema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'The rows, in the order they must be inserted.',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              as: { type: 'string', description: 'A label, so a later row can point at this one.' },
              values: {
                type: 'object',
                description: 'Column to value. A value may be {"ref": "label"} or {"ref": "label", "column": "name"}.',
              },
            },
            required: ['table', 'values'],
          },
        },
        tables: {
          type: 'array',
          description: '`fixture`\u2019s shape — [{table, rows: [...]}] — flattened in the order given.',
          items: {
            type: 'object',
            properties: { table: { type: 'string' }, rows: { type: 'array', items: { type: 'object' } } },
            required: ['table', 'rows'],
          },
        },
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    /* Not destructive — it only adds — and emphatically not idempotent: the
       same call twice is a second copy of the whole graph. */
    annotations: {
      title: 'Insert a graph of rows',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        inserted: {
          type: 'array',
          description: 'Each row as stored, with its label and new key.',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              as: { type: 'string' },
              key: { type: 'object' },
              row: { type: 'object' },
            },
          },
        },
        teardown: {
          type: 'array',
          description: 'The same rows reversed — children first — for `delete_graph`.',
          items: { type: 'object', properties: { table: { type: 'string' }, key: { type: 'object' } } },
        },
        errors: { type: 'array', items: { type: 'string' } },
        stats: STATS,
      },
    },
  },
  {
    name: 'delete_graph',
    description:
      'Remove several rows as one thing, in one transaction, in the order given — which ' +
      'is children before parents. Hand back the `teardown` list from `insert_graph` and ' +
      'the fixture is gone; a teardown that half-succeeded would leave exactly the mess ' +
      'the insert was careful not to. Each row still needs its whole primary key, and a ' +
      'key matching anything other than one row is refused. Two calls, like `delete`: ' +
      'without `confirm: true` it reports what points at every row and removes nothing. ' +
      'The rows are ones the caller listed, but what cascades off them is not — that is ' +
      'the part worth seeing before a transaction takes it all at once. The connection ' +
      'must be marked writable.',
    inputSchema: {
      type: 'object',
      properties: {
        rows: {
          type: 'array',
          description: 'The rows to remove, in the order they must go.',
          items: {
            type: 'object',
            properties: {
              table: { type: 'string' },
              key: { type: 'object', additionalProperties: { type: ['string', 'number'] } },
            },
            required: ['table', 'key'],
          },
        },
        confirm: { type: 'boolean', description: 'Actually delete. Absent means report only.' },
        connection: { type: 'string' },
      },
      required: ['rows'],
      additionalProperties: false,
    },
    annotations: {
      title: 'Delete a graph of rows',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        removed: {
          type: 'array',
          items: {
            type: 'object',
            properties: { table: { type: 'string' }, key: { type: 'object' }, affected: { type: 'number' } },
          },
        },
        errors: { type: 'array', items: { type: 'string' } },
        stats: STATS,
      },
    },
  },
  {
    name: 'revert',
    description:
      'Undo the last write, or see what there is to undo. Without `confirm: true` it lists ' +
      'this session\u2019s writes, newest first, and changes nothing. A transaction protects a ' +
      'call from failing halfway; nothing protected you from a call that succeeded and ' +
      'should not have, which is the one that actually happens. Every step is re-read ' +
      'before anything is written and the whole revert is refused if a row has moved on ' +
      'since — putting an old value back over a newer one is not an undo. In-session ' +
      'only: a stack that outlives the process invites undoing something from an hour ago, ' +
      'by which time the row has moved on and the undo is an overwrite with a friendly ' +
      'name. Raw SQL writes are listed and cannot be undone — arbitrary SQL has no general ' +
      'inverse. An unknown outcome means the Undo may have committed: inspect the stored ' +
      'values and history, and do not retry it. Pending or uncertain Undo blocks older writes. ' +
      'First list without confirm, then pass that next.id as expectedId with confirm: true. ' +
      'Confirmation requires an exact positive safe-integer ID matching the current next write. ' +
      'After a lost response, never replace the submitted ID with an older entry to retry. ' +
      'This is an in-memory precondition, not a durable recovery receipt.',
    inputSchema: {
      type: 'object',
      properties: {
        confirm: {
          type: 'boolean',
          description:
            'Undo the previewed write; requires expectedId. Absent or false means list only, including for clients supporting elicitation.',
        },
        expectedId: {
          type: 'integer',
          minimum: 1,
          maximum: Number.MAX_SAFE_INTEGER,
          description: 'Required for confirm: true. Copy next.id from the preview exactly; retain this ID if the response is lost.',
        },
        limit: { type: 'number', description: 'How many past writes to list. Default 10.' },
        connection: { type: 'string' },
      },
      additionalProperties: false,
    },
    annotations: { title: 'Undo the last write', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        reverted: { type: 'boolean' },
        outcome: {
          type: 'string',
          enum: ['applied', 'not_applied', 'unknown'],
          description: 'Whether the Undo landed. Unknown must not be retried automatically.',
        },
        writes: {
          type: 'array',
          description: 'This session\u2019s writes, newest first.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              kind: { type: 'string' },
              at: { type: 'string' },
              summary: { type: 'string' },
              revertible: { type: 'boolean' },
              undoState: { type: 'string', enum: ['pending', 'unknown'] },
              reason: { type: 'string', description: 'Why not, when it is not.' },
            },
          },
        },
        next: { type: 'object', description: 'The write `confirm: true` would undo.' },
        steps: { type: 'array', items: { type: 'object' } },
        note: { type: 'string' },
        errors: { type: 'array', items: { type: 'string' } },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

/**
 * Ask the person, through the client, when the client can (elicitation,
 * protocol 2025-06-18+). Set by the serve loop once the client's initialize
 * says it supports it; null means the two-call `confirm: true` gate stands
 * alone. The gate stays either way — an agent that answers its own question
 * is the failure elicitation exists to prevent, so what is asked here is
 * shown to the human by the client, not to the model.
 */
type Elicitor = (message: string, title: string) => Promise<boolean>;
let elicitor: Elicitor | null = null;
export function setElicitor(fn: Elicitor | null): void {
  elicitor = fn;
}

/** True when the call may go ahead: confirmed in the call, or by the person. */
async function confirmedBy(args: Record<string, unknown>, message: string, title: string): Promise<boolean> {
  if (args.confirm === true) return true;
  if (!elicitor) return false;
  try {
    return await elicitor(message, title);
  } catch {
    return false;
  }
}

/* The gate the server can actually enforce, in the words the HTTP
   endpoint uses: the person who hits this is usually the person who can
   change it, and "forbidden" would send them hunting for why. */
function writableOrThrow({ registry, id }: ToolCall): void {
  const config = registry.configOf(id);
  if (!config?.writable) {
    throw new Error(`"${config?.name ?? id}" is read-only. ` + 'Add "writable": true to its entry in your tablewalk.json to allow edits.');
  }
}

export const handlers = {
  update: async (call) => {
    const { args, adapter, schema, id } = call;
    writableOrThrow(call);
    if (!adapter.update) throw new Error(`${schema.dialect} connections are read-only in this build.`);
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const key = (args.key ?? {}) as Record<string, string | number>;
    wholeKeyOrThrow(schema, table, key);
    const values = (args.set ?? {}) as Record<string, string | number | boolean | null>;
    if (!Object.keys(values).length) throw new Error('Nothing to set.');
    /* The adapter independently verifies the key matches exactly one row and
       refuses anything else — the same guarantee the browser's edits get. */
    let stored;
    try {
      stored = await recordedUpdate(
        { adapter, connection: id },
        {
          table: table.id,
          key,
          values,
          ...(args.expected === undefined ? {} : { expected: args.expected as UpdateRequest['expected'] }),
        },
      );
    } catch (err) {
      if (err instanceof TransactionOutcomeUnknown) {
        return { connection: id, table: table.id, key, outcome: 'unknown', errors: [err.message] };
      }
      if (err instanceof Refusal) throw err;
      throw new Error(await explainWriteFailure(adapter, schema, table.id, values, (err as Error).message));
    }
    const { result, undoId } = stored;
    const body =
      Object.keys(key).length === 1
        ? String(Object.values(key)[0])
        : Object.entries(key)
            .map(([c, v]) => `${c}=${v}`)
            .join(',');
    return {
      connection: id,
      table: table.id,
      key,
      affected: result.affected,
      applied: result.applied,
      sql: result.sql,
      ...(undoId === undefined ? {} : { undoId }),
      link: linkTo(id, `${encodeURIComponent(table.id)}/~${encodeURIComponent(body)}`),
    };
  },
  insert: async (call) => {
    const { args, adapter, schema, id } = call;
    writableOrThrow(call);
    if (!adapter.insert) throw new Error(`${schema.dialect} connections are read-only in this build.`);
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const values = (args.values ?? {}) as Record<string, string | number | boolean | null>;
    try {
      const { result, undoId } = await recordedInsert({ adapter, connection: id }, { table: table.id, values });
      const body =
        Object.keys(result.key).length === 1
          ? String(Object.values(result.key)[0])
          : Object.entries(result.key)
              .map(([c, v]) => `${c}=${v}`)
              .join(',');
      return {
        connection: id,
        table: table.id,
        inserted: true,
        ...(undoId === undefined ? {} : { undoId }),
        key: result.key,
        row: result.row,
        sql: result.sql,
        link: Object.keys(result.key).length ? linkTo(id, `${encodeURIComponent(table.id)}/~${encodeURIComponent(body)}`) : undefined,
      };
    } catch (err) {
      /* A Refusal is the caller misusing the tool and reads best as a tool
         error; a constraint violation is the *data* refusing, in the
         database's words, and rides in `errors` the way a query's do —
         something to fix and retry, not a broken server. */
      if (err instanceof Refusal) throw err;
      if (err instanceof TransactionOutcomeUnknown) {
        return { connection: id, table: table.id, inserted: null, outcome: 'unknown', errors: [err.message] };
      }
      /* And the graph turns the database's words into the missing row: one
         lookup, on the failure path only. */
      const message = await explainWriteFailure(adapter, schema, table.id, values, (err as Error).message);
      const outcome = writeFailureOutcome(err);
      return { connection: id, table: table.id, inserted: outcome === 'unknown' ? null : false, outcome, errors: [message] };
    }
  },
  delete: async (call) => {
    const { args, adapter, schema, id } = call;
    writableOrThrow(call);
    if (!adapter.remove) throw new Error(`${schema.dialect} connections cannot delete in this build.`);
    const table = tableNamed(schema, String(args.table ?? ''));
    if (!table)
      throw new Error(`Unknown table "${String(args.table)}". Ask \`tables\` for what exists — or \`refresh\` if it was just created.`);
    const key = (args.key ?? {}) as Record<string, string | number>;
    wholeKeyOrThrow(schema, table, key);

    const impact = await deleteImpact(adapter, schema, table.id, key);
    const impactWords = impact.length
      ? ` It is referenced: ${impact.map((i) => `${i.count} in ${i.table} (${i.onDelete})`).join(', ')}.`
      : '';
    if (!(await confirmedBy(args, `Delete ${table.name} ${Object.values(key).join('/')}?${impactWords}`, `Delete ${table.name}`))) {
      return {
        connection: id,
        table: table.id,
        key,
        impact,
        deleted: false,
        note: elicitor
          ? 'Nothing was removed: the person declined, or did not answer.'
          : 'Nothing was removed. Read the impact, then call again with confirm: true to delete.',
      };
    }
    /* restrict and no action are left to the database, whose message names
       the constraint; a second implementation of the same rule is how the
       two come to disagree, and tablewalk would be the one that was wrong. */
    try {
      const { result, undoId } = await recordedDelete(
        { adapter, connection: id },
        { table: table.id, key },
        { references: changingReferences(schema, table.id) },
      );
      return {
        connection: id,
        table: table.id,
        key,
        impact,
        deleted: true,
        affected: result.affected,
        ...(undoId === undefined ? {} : { undoId }),
      };
    } catch (err) {
      const outcome = err instanceof TransactionOutcomeUnknown ? 'unknown' : err instanceof Refusal ? 'rejected' : writeFailureOutcome(err);
      return {
        connection: id,
        table: table.id,
        key,
        impact,
        deleted: outcome === 'unknown' ? null : false,
        outcome,
        errors: [(err as Error).message],
      };
    }
  },
  insert_graph: async (call) => {
    const { args, adapter, schema, id } = call;
    writableOrThrow(call);
    /* `fixture`'s own shape, accepted as it comes: extract a real row out of
       development, put it into a test database, without an agent rewriting
       the shape in between. Both together is a request with two minds about
       what it wants. */
    const listed = Array.isArray(args.rows) ? (args.rows as GraphRow[]) : undefined;
    const grouped = Array.isArray(args.tables)
      ? flattenTables(args.tables as Array<{ table: string; rows: Array<Record<string, unknown>> }>)
      : undefined;
    if (listed && grouped) throw new Error('Give either `rows` or `tables`, not both.');
    const rows = listed ?? grouped;
    if (!rows) throw new Error('Give the rows to insert, as `rows` or as `fixture`\u2019s `tables`.');

    try {
      /* `rowsWritten` is dropped here on purpose: every tool reports what it
         cost through `stats`, and a count in two places is a count that will
         one day disagree with itself. */
      const { rowsWritten: _written, ...result } = await insertGraph(adapter, schema, rows);
      return { connection: id, ...result };
    } catch (err) {
      /* A refusal about the request is a message; a refusal from the database
         is also a message — and both arrive having written nothing, which is
         the fact worth reporting either way. */
      return { connection: id, inserted: [], teardown: [], errors: [(err as Error).message] };
    }
  },
  revert: async (call) => {
    const { args, adapter, id } = call;
    writableOrThrow(call);
    const listed = history(id, typeof args.limit === 'number' ? args.limit : 10);
    const next = lastRevertible(id);
    // A preview stays read-only even with elicitation: confirmation must carry
    // the caller's captured ID so a lost response cannot undo an older write.
    if (args.confirm !== true) {
      return {
        connection: id,
        reverted: false,
        writes: listed.map(({ steps: _steps, connection: _c, ...rest }) => rest),
        ...(next ? { next: { id: next.id, kind: next.kind, at: next.at, summary: next.summary } } : {}),
        note: next
          ? `Nothing was undone. Call again with confirm: true and expectedId: ${next.id} to undo: ${next.summary}.`
          : 'Nothing in this session can be undone.',
      };
    }
    if (typeof args.expectedId !== 'number' || !Number.isSafeInteger(args.expectedId) || args.expectedId <= 0) {
      return {
        connection: id,
        reverted: false,
        outcome: 'not_applied',
        errors: ['Undo requires the positive safe-integer expectedId from the history preview. List the history before confirming.'],
      };
    }
    if (!next || args.expectedId !== next.id) {
      return {
        connection: id,
        reverted: false,
        outcome: 'not_applied',
        errors: ['The undo history changed. The previewed write can no longer be undone here.'],
      };
    }
    /* An undo writes every table the entry touched; each must be in scope. */
    writableOrThrow(call);
    const result = await revert(adapter, id, next);
    return {
      connection: id,
      reverted: result.reverted,
      outcome: result.outcome,
      undone: { id: next.id, kind: next.kind, summary: next.summary },
      ...(result.steps ? { steps: result.steps } : {}),
      ...(result.errors ? { errors: result.errors } : {}),
    };
  },
  delete_graph: async (call) => {
    const { args, adapter, schema, id } = call;
    writableOrThrow(call);
    const rows = (Array.isArray(args.rows) ? args.rows : []) as Array<{
      table: string;
      key: Record<string, string | number>;
    }>;
    /* The same two-call gate `delete` has, and for a stronger reason.
    
       `delete` removes one row by key and refuses to proceed until the caller
       has seen what points at it. `delete_graph` removes a whole list of them
       inside one transaction, and had no gate at all — so the tool that could
       take the most rows away was the one that took them on the first call.
       The gate was on the less dangerous of the two.

       Impact is read before the transaction opens, per row, so what comes
       back is what `delete` would have said about each of them. */
    if (args.confirm !== true) {
      const impact = [];
      for (const [i, row] of rows.entries()) {
        const table = row?.table ? tableNamed(schema, row.table) : undefined;
        if (!table || !row?.key || !Object.keys(row.key).length) {
          return {
            connection: id,
            removed: [],
            deleted: false,
            errors: [`Row ${i + 1}${row?.table ? ` (${row.table})` : ''}: a delete needs a known table and a key.`],
          };
        }
        impact.push({ table: table.id, key: row.key, impact: await deleteImpact(adapter, schema, table.id, row.key) });
      }
      return {
        connection: id,
        removed: [],
        deleted: false,
        rows: impact,
        note: 'Nothing was removed. Read the impact of every row, then call again with confirm: true to delete them as one transaction.',
      };
    }
    try {
      const { rowsDeleted: _deleted, ...result } = await deleteGraph(adapter, schema, rows);
      return { connection: id, deleted: true, ...result };
    } catch (err) {
      return { connection: id, removed: [], deleted: false, errors: [(err as Error).message] };
    }
  },
} satisfies Record<Name, Handler>;
