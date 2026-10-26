/**
 * The tools that speak tablewalk's query language: `query` for rows, with
 * its fall-through to a multi-table view, and `breakdown` for groups. Both
 * bind every value and check every path against the catalog, which is why
 * the descriptions send an agent here before `sql`.
 */
import { readBreakdown, readRecords, readView } from '@mistriwork/engine/server/resourceReadOperations.js';
import { findTable } from '@mistriwork/engine/shared/schema.js';
import { explain, parseQuery } from '@mistriwork/engine/shared/query.js';
import { textToView } from '@mistriwork/engine/shared/viewtext.js';
import { looksLikeBreakdown, textToBreakdown } from '@mistriwork/engine/shared/breakdowntext.js';
import { COUNT_LIMIT, COUNT_LIMIT_WORDS as bound, linkTo, READS, STATS, type Handler } from '../toolkit.js';

export const definitions = [
  {
    name: 'query',
    description:
      `Run a query in tablewalk’s query language and get rows, a total counted up to ${bound}, and ` +
      'the SQL it compiled to. The language: table first, then filters — ' +
      '`invoice total >= 500 and status != paid sort total desc limit 20`. Operators: ' +
      '= != < <= > >= contains startswith endswith in, `is empty`/`is not empty`; dates as ' +
      'phrases (`invoice_date = last 30 days`); dotted paths walk references ' +
      '(`invoice customer_id.name contains Acme show id, total, customer_id.name`). ' +
      'A path on the right, or a column name beside a number or date, compares two columns ' +
      '(`stock on_hand < product_id.reorder_level`); quote a word to mean the text. ' +
      'Aggregate clauses summarise children onto each row: ' +
      '`customer show name count invoice via customer_id as invoices sum invoice.total via customer_id as revenue` ' +
      '— count/sum/min/max/avg, `via` names the child\u2019s reference column, and `sort invoices desc` ' +
      'sorts by the alias. Filtering or projecting by an alias is not supported and says so. ' +
      'Errors come back with suggestions — a misspelled column names its nearest match, and ' +
      'an unknown column answers with the table\u2019s real columns — so fix and retry. Prefer ' +
      '`show` on wide tables: sixteen columns of every row is tokens spent on nothing. ' +
      'Prefer this over `sql`: every value is bound, never spliced.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'The query text, starting with a table name.' },
        limit: { type: 'number', description: 'Rows to return (default 20, clamped).' },
        offset: { type: 'number' },
        connection: { type: 'string' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    annotations: { title: 'Query rows', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' } },
        columns: { type: 'array', items: { type: 'string' } },
        total: { type: 'number', description: `Rows matching the filter, not just the page, counted up to ${bound}.` },
        cappedTotal: {
          type: 'boolean',
          description: 'Present when the count reached its bound: `total` is the bound, and more rows match.',
        },
        offset: { type: 'number' },
        sql: { type: 'object', description: 'What actually ran: text and bound params.' },
        explain: { type: 'string', description: 'The query, said back in words.' },
        link: { type: 'string', description: 'Open this query in the tablewalk UI.' },
        errors: {
          type: 'array',
          description: 'A query that did not parse: messages with suggestions, in place of rows.',
          items: { type: 'string' },
        },
        stats: STATS,
      },
    },
  },
  {
    name: 'breakdown',
    description:
      'Counts and sums, grouped by something — the GROUP BY question, in the same language ' +
      'and with the same guarantees as `query`. Measures first, then `by`, then what to ' +
      'group by: `invoice count by status`, `invoice count, sum total as billed by month ' +
      'invoice_date sort billed desc limit 12`. Measures are count / sum / avg / min / max, ' +
      'plus `count distinct <column>`; a bare `count` counts rows, `count <column>` skips ' +
      'its nulls. Group keys walk references like any path — `by customer_id.country_code.name` ' +
      '— and a date column can be cut to a period with `by day|month|quarter|year <column>`, ' +
      'which comes back as a label (`2026-08`) that sorts correctly as text. `where`, `sort` ' +
      'and `limit` work as they do in `query`, except that `sort` names a column of the ' +
      'answer rather than a path. Reach for this before `sql`: every value is bound, the ' +
      'paths are checked against the catalog, and a mistake comes back as a message rather ' +
      'than a database exception.',
    inputSchema: {
      type: 'object',
      properties: {
        q: {
          type: 'string',
          description: 'The breakdown, starting with a table name. `invoice count by status`.',
        },
        limit: { type: 'number', description: 'Groups to return (default 20, clamped).' },
        offset: { type: 'number' },
        connection: { type: 'string' },
      },
      required: ['q'],
      additionalProperties: false,
    },
    annotations: { title: 'Group and count', ...READS },
    outputSchema: {
      type: 'object',
      properties: {
        connection: { type: 'string' },
        rows: { type: 'array', items: { type: 'object' }, description: 'One row per group.' },
        columns: { type: 'array', items: { type: 'string' } },
        resolved: {
          type: 'array',
          description: 'Of each column: whether it is a group key or a measure, and of what.',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              kind: { type: 'string' },
              fn: { type: 'string' },
              path: { type: 'string' },
              type: { type: 'string' },
            },
          },
        },
        total: { type: 'number', description: `How many groups there are, not just the page, counted up to ${bound}.` },
        cappedTotal: {
          type: 'boolean',
          description: 'Present when the count reached its bound: `total` is the bound, and there are more groups.',
        },
        offset: { type: 'number' },
        sql: { type: 'object', description: 'What actually ran: text and bound params.' },
        errors: { type: 'array', items: { type: 'string' } },
        stats: STATS,
      },
    },
  },
] as const;

type Name = (typeof definitions)[number]['name'];

export const handlers = {
  breakdown: async ({ args, adapter, schema, id }) => {
    if (!adapter.runBreakdown) {
      throw new Error(`${schema.dialect} connections cannot group in this build.`);
    }
    const text = String(args.q ?? '');
    const parsed = textToBreakdown(schema, text);
    if (!parsed.breakdown) {
      /* Answered as a result rather than a protocol error, like `query`: a
         breakdown that does not parse is the caller's to fix, and the message
         names the path or the missing clause. */
      return { connection: id, errors: parsed.errors.map((e) => e.message) };
    }
    const { result, total, capped, offset } = await readBreakdown(
      adapter,
      schema,
      parsed.breakdown,
      {
        limit: args.limit ?? parsed.breakdown.limit ?? 20,
        offset: args.offset,
      },
      COUNT_LIMIT,
    );
    return {
      connection: id,
      rows: result.rows,
      columns: result.columns,
      resolved: result.resolved,
      total,
      ...(capped ? { cappedTotal: true } : {}),
      offset,
      sql: result.sql,
    };
  },
  query: async ({ args, adapter, schema, id }) => {
    const text = String(args.q ?? '');
    const parsed = parseQuery(text, { schema });
    /* The query's own `limit 3` wins over the tool's default, exactly as the
       query bar treats it — an explicit argument beats both. */
    const limit = args.limit ?? parsed.query?.limit ?? 20;

    /* A dotted path is not a legal single-table query and is a perfectly good
       view — the same one-way fall-through the query bar takes, so the
       language means the same thing here as there. */
    if ((!parsed.query || parsed.errors.length) && adapter.runView) {
      const asView = textToView(schema, text, { id: 'mcp', name: '' });
      /* Text that clearly reached for an aggregate gets the view parser's
         errors, which teach — "a filter runs before the aggregate exists" —
         rather than the plain parser's "not a column", which is true of the
         alias and useless about it. */
      if (asView.errors.length && /\b(count|sum|min|max|avg)\s+\S+\s+via\b/i.test(text)) {
        const about = findTable(schema, parsed.query?.table ?? text.trim().split(/\s+/)[0] ?? '');
        return {
          connection: id,
          errors: asView.errors.map((e) => e.message),
          columns: about ? about.columns.map((c) => c.name) : undefined,
        };
      }
      if (asView.view && !asView.errors.length) {
        const { result, total, capped } = await readView(
          adapter,
          schema,
          asView.view,
          {
            limit: args.limit ?? asView.view.limit ?? 20,
            offset: args.offset,
          },
          'exact',
          COUNT_LIMIT,
        );
        return {
          connection: id,
          rows: result.rows,
          columns: result.columns,
          total,
          ...(capped ? { cappedTotal: true } : {}),
          sql: result.sql,
          link: linkTo(id, encodeURIComponent(text).replace(/!/g, '%21')),
        };
      }
    }

    if ((!parsed.query || parsed.errors.length) && looksLikeBreakdown(text)) {
      /* Pointed at the right tool rather than run here. `query` falls through
         to a view because a view still answers one row per record — the same
         kind of answer. A breakdown does not: its rows are groups, they
         cannot be opened, and its `resolved` says of each column whether it
         is a key or a measure. Quietly returning that from `query` would be
         a different shape under the same name. */
      return {
        connection: id,
        errors: [`"${text.trim()}" groups rows, which \`query\` does not do. Call \`breakdown\` with the same text.`],
      };
    }

    if (!parsed.query || parsed.errors.length) {
      /* The errors carry suggestions — "no column contry_code, nearest is
         country_code" — which is what lets a model correct itself in one
         step instead of flailing. Answered as a result, not a protocol
         error: a query that does not parse is the caller's to fix.

         And when the table is known, its real columns ride along: a name too
         far from any column for a nearest-match ("sales_order_id" against
         "order_id") was a dead end that cost a second round trip to
         \`table\`. */
      const about = findTable(schema, parsed.query?.table ?? text.trim().split(/\s+/)[0] ?? '');
      return {
        connection: id,
        errors: parsed.errors.map((e) => e.message ?? e),
        columns: about ? about.columns.map((c) => c.name) : undefined,
      };
    }

    const q = parsed.query;
    const { request, result, total } = await readRecords(
      adapter,
      schema,
      {
        ...q,
        limit,
        offset: args.offset,
      },
      'exact',
      COUNT_LIMIT,
    );
    return {
      connection: id,
      rows: result.rows,
      columns: result.columns,
      total: total?.count,
      ...(total?.capped ? { cappedTotal: true } : {}),
      offset: request.offset,
      sql: result.sql,
      explain: explain(q),
      link: linkTo(id, encodeURIComponent(text).replace(/!/g, '%21')),
    };
  },
} satisfies Record<Name, Handler>;
