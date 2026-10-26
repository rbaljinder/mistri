/**
 * A view, written down.
 *
 * The composer builds views by clicking, and a view built by clicking is UI
 * state: it can be saved and loaded, and that is all. Everything else in
 * tablewalk holds that the *query text* is the single source of truth — it is
 * why filters compose into the bar, why sorting edits the query, why a link
 * carries the whole walk. A view that cannot be written down cannot be
 * hand-edited, diffed in a config file, pasted into a conversation, or
 * explained to someone who does not have the UI open.
 *
 * So a view has a text form, and it is the same language:
 *
 *   work_order
 *     show reference, total_cost, customer_id.name as customer
 *     count work_order_part via work_order_id as parts
 *     sum work_order_part.quantity via work_order_id as units
 *     where customer_id.country_code = AU and total_cost > 500
 *     sort total_cost desc
 *     limit 20
 *
 * Only two things here are new: the base table on the front, and the
 * aggregate clauses. Paths, conditions, sort and limit are parsed by
 * `parseViewQuery`, which the composer's filter box already uses — one
 * grammar, not two that drift.
 *
 * Aggregates name the child table and the foreign key column rather than the
 * constraint, because a constraint name is a database artefact nobody reads
 * (`work_order_part_work_order_id_fkey`) and `work_order_part via
 * work_order_id` says the same thing in words that appear in the schema. The
 * pair is unambiguous: two foreign keys from one child to one parent must sit
 * on different columns.
 */
import { backrefsTo, parseViewQuery, tableAtPrefix, type AggregateFn, type ViewAggregate, type ViewDef } from './view.js';
import { findTable, type DatabaseSchema } from './schema.js';
import type { QueryError, QueryPerson } from './query.js';

const AGGREGATE_FNS: AggregateFn[] = ['count', 'sum', 'min', 'max', 'avg'];

interface ParsedViewText {
  view?: ViewDef;
  errors: QueryError[];
}

/* ---------- writing ---------- */

/**
 * Render a view as text.
 *
 * Deliberately one clause per line. A view with three joins and two
 * aggregates is a paragraph, not a phrase, and putting it on one line to fit
 * an input box makes the thing unreadable in exactly the situation — a
 * complicated view — where reading it matters.
 */
/**
 * How to render an aggregate's constraint name as readable text.
 *
 * Passed in rather than looked up globally: the schema is not always
 * available (a config file can be validated without a connection), and
 * threading it through beats module state that two concurrent renders would
 * share.
 */
type ConstraintNamer = (via: string) => [table: string, column: string] | undefined;

function viewToText(view: ViewDef, nameConstraint?: ConstraintNamer): string {
  const lines: string[] = [view.base];

  if (view.columns.length) {
    const shown = view.columns.map((c) => (c.alias && c.alias !== c.path ? `${c.path} as ${c.alias}` : c.path));
    lines.push(`  show ${shown.join(', ')}`);
  }

  for (const aggregate of view.aggregates ?? []) {
    lines.push(`  ${aggregateToText(aggregate, nameConstraint)}`);
  }

  const where = filterToText(view);
  if (where) lines.push(`  where ${where}`);

  /* A closest-first order (`near`, a similar list's) has no words in the
     grammar; the text keeps the orders it can say, over the same rows. */
  const said = (view.orderBy ?? []).filter((o) => o.near === undefined);
  if (said.length) {
    const parts = said.map((o) => (o.direction === 'desc' ? `${o.path} desc` : o.path));
    lines.push(`  sort ${parts.join(', ')}`);
  }

  if (view.limit !== undefined) lines.push(`  limit ${view.limit}`);
  return lines.join('\n');
}

function aggregateToText(aggregate: ViewAggregate, nameConstraint?: ConstraintNamer): string {
  /* `via` on the model is a constraint name; the text form names the child
     table and its foreign key column instead. The name is recoverable from
     the pair, and the pair is what a person can read.

     With no way to resolve it, the constraint name is emitted as-is rather
     than a table and column being invented — wrong-but-readable is worse
     than opaque-but-true. */
  const [table, column] = nameConstraint?.(aggregate.via) ?? [aggregate.via, ''];
  const target = aggregate.fn === 'count' || !aggregate.column ? table : `${table}.${aggregate.column}`;
  const on = aggregate.on ? ` on ${aggregate.on}` : '';
  const alias = aggregate.alias ? ` as ${aggregate.alias}` : '';
  return `${aggregate.fn} ${target} via ${column}${on}${alias}`;
}

/** A namer backed by a schema: the form callers with a connection should use. */
function constraintNamer(schema: DatabaseSchema, view: ViewDef): ConstraintNamer {
  return (via) => {
    /* An aggregate can hang off a path, not just the base, so every prefix
       the view mentions is a candidate parent. */
    const prefixes = new Set(['', ...(view.aggregates ?? []).map((a) => a.on ?? '')]);
    for (const prefix of prefixes) {
      const parent = tableAtPrefix(schema, view.base, prefix);
      if (!parent) continue;
      const candidates = backrefsTo(schema, parent.id);
      const hit = candidates.find((b) => `${b.child}.${b.fk.from.columns.join('+')}` === via) ?? candidates.find((b) => b.fk.name === via);
      if (hit) return [hit.fk.from.table, hit.fk.from.columns[0]];
    }
    return undefined;
  };
}

/** Render with a schema, so aggregates name real tables and columns. */
export function viewToTextWithSchema(schema: DatabaseSchema, view: ViewDef): string {
  return viewToText(view, constraintNamer(schema, view));
}

function filterToText(view: ViewDef): string {
  const groups = view.filter?.groups ?? [];
  if (!groups.length) return '';
  const rendered = groups.map((group) => group.map(conditionToText).join(' and '));
  // A single group needs no parentheses; several are OR-ed and each is
  // bracketed, matching how the parser reads them back.
  return rendered.length === 1 ? rendered[0] : rendered.map((g) => `(${g})`).join(' or ');
}

function conditionToText(condition: { path: string; op: string; value?: unknown; other?: string; any?: unknown }): string {
  const { path, op, value } = condition;
  // An `any`/`no` condition keeps the words it was written in (view.ts).
  if (condition.any !== undefined) return path;
  // Another column is written bare: that is how the parser tells it from a value.
  if (condition.other !== undefined) return `${path} ${op} ${condition.other}`;
  switch (op) {
    case 'isNull':
      return `${path} is empty`;
    case 'isNotNull':
      return `${path} is not empty`;
    case 'contains':
      return `${path} contains ${quote(value)}`;
    case 'startsWith':
      return `${path} startswith ${quote(value)}`;
    case 'endsWith':
      return `${path} endswith ${quote(value)}`;
    case 'in': {
      const list = Array.isArray(value) ? value : [value];
      return `${path} in (${list.map(quote).join(', ')})`;
    }
    default:
      return `${path} ${op} ${quote(value)}`;
  }
}

/** Quote only when the grammar needs it, so the common case stays readable. */
function quote(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const text = String(value);
  if (typeof value === 'number' || typeof value === 'boolean') return text;
  return /^[\w.-]+$/.test(text) ? text : `"${text.replace(/"/g, '')}"`;
}

/* ---------- reading ---------- */

/**
 * An aggregate clause: `count work_order_part via work_order_id as parts`.
 *
 * The function word is only treated as a clause when it is followed by
 * something-then-`via`. A table with a column called `count` or `sum` is not
 * unusual, and eating the word would turn `sum = 3` into a broken aggregate
 * rather than a filter.
 */
const AGGREGATE_RE = new RegExp(
  String.raw`\b(${AGGREGATE_FNS.join('|')})\s+([\w.$]+)\s+via\s+([\w$]+)` + String.raw`(?:\s+on\s+([\w.$]+))?(?:\s+as\s+([\w$]+))?`,
  'gi',
);

/**
 * Parse a written view.
 *
 * The base table and the aggregates are handled here; everything else is
 * handed to `parseViewQuery`, which the composer's filter box already uses.
 * Two parsers for one language is how a language starts disagreeing with
 * itself.
 */
export function textToView(
  schema: DatabaseSchema,
  text: string,
  options: { id?: string; name?: string; now?: Date; me?: QueryPerson | null } = {},
): ParsedViewText {
  const errors: QueryError[] = [];
  const body = String(text ?? '').trim();
  if (!body) return { errors: [{ message: 'Start with a table name.' }] };

  const baseName = body.split(/\s+/)[0];
  const base = findTable(schema, baseName) ?? schema.tables.find((t) => t.name === baseName);
  if (!base) {
    return { errors: [{ message: `No table called "${baseName}" in this database.`, at: 0 }] };
  }

  const rest = body.slice(baseName.length);

  /* Aggregates are lifted out before the rest is parsed, because
     `parseViewQuery` knows nothing about them and would read `count` as the
     start of a condition. */
  const aggregates: ViewAggregate[] = [];
  const remainder = rest.replace(AGGREGATE_RE, (_match, fn, target, viaColumn, on, alias) => {
    /* `app.invoice_line` is one qualified table; `work_order_part.quantity`
       is a table and a column; `app.invoice_line.quantity` is both. A dot
       cannot tell them apart, so the schema does: if the whole target names a
       table there is no column, otherwise the last dot separates them.

       Splitting on the first dot — the obvious implementation — turned
       `app.invoice_line` into table `app`, and the error it produced named a
       table that does not exist. Postgres schemas are the common case for
       this, which is exactly why it survived until the compiler was pointed
       at a real one. */
    const targetText = String(target);
    const namesTable = (id: string) => Boolean(findTable(schema, id)) || schema.tables.some((t) => t.name === id);

    let childTable = targetText;
    let childColumn: string | undefined;
    if (!namesTable(targetText)) {
      const lastDot = targetText.lastIndexOf('.');
      if (lastDot > 0) {
        childTable = targetText.slice(0, lastDot);
        childColumn = targetText.slice(lastDot + 1);
      }
    }

    const parent = tableAtPrefix(schema, base.id, on ?? '');
    if (!parent) {
      errors.push({ message: `"${on}" is not a reference path on ${base.name}.` });
      return '';
    }

    const backref = backrefsTo(schema, parent.id).find(
      (b) => b.fk.from.table === childTable && b.fk.from.columns.includes(String(viaColumn)),
    );
    if (!backref) {
      errors.push({
        message: `Nothing in ${childTable}.${viaColumn} points at ${parent.name}. ` + `Try: ${describeBackrefs(schema, parent.id)}`,
      });
      return '';
    }

    if (fn !== 'count' && !childColumn) {
      errors.push({ message: `${fn} needs a column, e.g. ${fn} ${childTable}.amount via ${viaColumn}` });
      return '';
    }
    if (childColumn) {
      const childTableMeta = findTable(schema, backref.fk.from.table);
      if (childTableMeta && !childTableMeta.columns.some((c) => c.name === childColumn)) {
        errors.push({ message: `"${childColumn}" is not a column on ${childTable}.` });
        return '';
      }
    }

    aggregates.push({
      fn: fn.toLowerCase() as AggregateFn,
      via: `${backref.child}.${backref.fk.from.columns.join('+')}`,
      on: on || undefined,
      column: childColumn,
      alias: alias || undefined,
    });
    return '';
  });

  /* Aliases are lifted out of the `show` clause before it is parsed.
     `parseViewQuery` validates each entry as a path, and
     `customer_id.name as customer` is not one — the alias is presentation,
     not addressing, and only this layer knows about it. */
  const { text: withoutAliases, aliases } = stripAliases(remainder);

  const parsed = parseViewQuery(schema, base.id, withoutAliases, options.now, {
    /* So `sort invoices desc` parses after `… as invoices` — the alias joins
       the synthetic table for the sort clause, and only the sort clause. */
    aggregateAliases: aggregates.map((a) => a.alias ?? '').filter(Boolean),
    ...(options.me !== undefined ? { me: options.me } : {}),
  });
  errors.push(...parsed.errors);

  const view: ViewDef = {
    id: options.id ?? 'text',
    name: options.name ?? '',
    base: base.id,
    columns: parsed.columns.map((path) => {
      const alias = aliases.get(path);
      return alias ? { path, alias } : { path };
    }),
    aggregates: aggregates.length ? aggregates : undefined,
    filter: parsed.filter.groups.length ? parsed.filter : undefined,
    orderBy: parsed.orderBy.length ? parsed.orderBy : undefined,
    limit: parsed.limit,
  };

  return { view, errors };
}

/**
 * Remove ` as <alias>` from every entry of a `show` clause, returning the
 * cleaned text and a path → alias map.
 *
 * Only the show clause: `as` means something else nowhere in this grammar
 * today, but rewriting the whole string would break the moment it does.
 */
function stripAliases(text: string): { text: string; aliases: Map<string, string> } {
  const aliases = new Map<string, string>();
  const cleaned = text.replace(
    /\b(show|select)\s+([^]*?)(?=\s+\b(?:where|filter|sort|order\s+by|limit)\b|$)/i,
    (_match, keyword: string, list: string) => {
      const entries = list.split(',').map((entry) => {
        const aliased = entry.trim().match(/^(.*?)\s+as\s+([\w$]+)$/i);
        if (!aliased) return entry.trim();
        aliases.set(aliased[1].trim(), aliased[2]);
        return aliased[1].trim();
      });
      return `${keyword} ${entries.join(', ')}`;
    },
  );
  return { text: cleaned, aliases };
}

/** A short list of what *would* have worked, for the error to name. */
function describeBackrefs(schema: DatabaseSchema, parentId: string): string {
  const options = backrefsTo(schema, parentId)
    .slice(0, 3)
    .map((b) => `${b.fk.from.table} via ${b.fk.from.columns[0]}`);
  return options.length ? options.join(', ') : 'nothing points at this table';
}
