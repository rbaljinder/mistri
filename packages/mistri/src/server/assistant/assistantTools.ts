/**
 * The five tools, answered as the person: every read is a request through
 * the server's own dispatcher with the turn's headers (the loopback first
 * paint uses), so the gate, grants, hidden columns and a row policy apply as
 * they do to the page. There is no other read path here to get wrong.
 *
 * `run` writes nothing. It checks the verb against the person's catalog and
 * the record's state now, and returns a proposal the panel draws as a card;
 * the person's own confirmation runs it through the page's write path, and
 * its outcome comes back to the conversation (assistantTurn.ts).
 *
 * Every tool answers twice: the model gets a compact summary (ids, counts,
 * the first rows, addresses), the person gets what the panel draws (a folded
 * step line, a block, a card).
 */
import type { AppAssistant } from '../../shared/appAssistant.js';
import { appAddressBook, recordSegments, type AddressBook } from '../../shared/appAddress.js';
import { viewOrder } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { labelColumn, primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import type { Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import type { AssistantCatalog, CatalogVerb } from './assistantCatalog.js';

/** A block as the panel draws it: a dashboard section, or one record's card. */
type AssistantBlock =
  | { kind: 'section'; section: Record<string, unknown> }
  | { kind: 'record'; table: string; key: Record<string, unknown>; title: string; values: Record<string, unknown>; address?: string };

export interface Proposal {
  /** The tool call it answers; its outcome is reported under this id. */
  id: string;
  kind: CatalogVerb['kind'];
  resource: string;
  action: string;
  label: string;
  key?: Record<string, unknown>;
  /** The record's label, for the card's line. */
  record?: string;
  address?: string;
  values: Record<string, unknown>;
  why?: string;
}

export type DisplayItem =
  | { type: 'step'; id: string; tool: string; label: string; failed?: true }
  | { type: 'block'; id: string; block: AssistantBlock }
  | { type: 'proposal'; id: string; proposal: Proposal };

interface ToolAnswer {
  /** What the model is told, as JSON text. */
  result: string;
  isError?: true;
  display: DisplayItem[];
  proposal?: Proposal;
}

export interface ToolSession {
  loop: Loop;
  app: string;
  payload: AppPayloadApp;
  assistant: AppAssistant;
  catalog: AssistantCatalog;
  signal: AbortSignal;
}

/** A refusal the model is told and may act on: a wrong name, a field that is not there. */
class ToolRefusal extends Error {}

const MAX_ROWS = 50;
const SHOWN_TO_MODEL = 20;
const TEXT_TO_MODEL = 160;

const quoted = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value ?? '');
  if (/^-?\d+$/.test(text)) return text;
  if (text.includes('"') || /[\r\n]/.test(text)) throw new ToolRefusal('A key with a quote or a line break cannot be named.');
  return `"${text}"`;
};
const clipped = (value: unknown): unknown =>
  typeof value === 'string' && value.length > TEXT_TO_MODEL ? `${value.slice(0, TEXT_TO_MODEL)}…` : value;

function toolContext(session: ToolSession) {
  let schema: Promise<DatabaseSchema> | undefined;
  let book: AddressBook | undefined;
  const target = (path: string) => `${path}${path.includes('?') ? '&' : '?'}app=${encodeURIComponent(session.app)}`;
  const ask = async (method: 'GET' | 'POST', path: string, body?: Record<string, unknown>) => {
    const answer = await session.loop(method, target(path), body, session.signal);
    if (!answer) throw new Error('The request was not answered.');
    return answer;
  };
  const catalogSchema = () =>
    (schema ??= ask('GET', '/api/schema').then((answer) => {
      if (answer.status !== 200) throw new Error('The catalog could not be read.');
      return answer.body as DatabaseSchema;
    }));
  const tableOf = async (resource: string): Promise<TableMeta> => {
    if (!session.catalog.resources.some((each) => each.name === resource)) {
      throw new ToolRefusal(
        `There is no resource "${resource}" here. Resources: ${session.catalog.resources.map((each) => each.name).join(', ')}.`,
      );
    }
    const table = (await catalogSchema()).tables.find((each) => each.id === resource || each.name === resource);
    if (!table) throw new ToolRefusal(`"${resource}" cannot be read by this person.`);
    return table;
  };
  const addressOf = async (table: string, key: Record<string, unknown>): Promise<string | undefined> => {
    book ??= appAddressBook({
      views: session.payload.views as never,
      order: viewOrder(session.payload),
      resources: session.payload.resources,
      pages: session.payload.pages ?? [],
      tables: (await catalogSchema()).tables,
      inbox: session.payload.inbox === true,
      assistant: session.payload.assistant?.page === true,
      projected: true,
    });
    const segments = recordSegments(book, table, { key });
    return segments ? `/${session.app}/${segments.map(encodeURIComponent).join('/')}` : undefined;
  };
  /** One read in the query language, as the query bar runs it. */
  const run = async (q: string, limit: number, count: 'none' | 'exact' = 'none') => {
    const answer = await ask('POST', '/api/run', { q, limit, count });
    const body = answer.body as {
      rows?: Array<Record<string, unknown>>;
      columns?: string[];
      total?: number;
      table?: string;
      errors?: Array<{ message: string }>;
      error?: string;
    };
    const problems = body?.errors?.length
      ? body.errors.map((error) => error.message)
      : answer.status >= 400
        ? [body?.error ?? `Refused (${answer.status}).`]
        : [];
    if (problems.length) throw new ToolRefusal(problems.join(' '));
    return { rows: body.rows ?? [], columns: body.columns ?? [], total: body.total, table: body.table };
  };
  /** One grouped read — measures, optionally by columns — as a dashboard section asks it. */
  const measure = async (text: string, limit: number) => {
    const answer = await ask('POST', '/api/breakdown', { text, limit });
    const body = answer.body as {
      rows?: Array<Record<string, unknown>>;
      columns?: string[];
      total?: number;
      errors?: Array<{ message: string }>;
      error?: string;
    };
    const problems = body?.errors?.length
      ? body.errors.map((error) => error.message)
      : answer.status >= 400
        ? [body?.error ?? `Refused (${answer.status}).`]
        : [];
    if (problems.length) throw new ToolRefusal(problems.join(' '));
    return { rows: body.rows ?? [], columns: body.columns ?? [], total: body.total };
  };
  /** One record by key, if this person can see it. */
  const record = async (table: TableMeta, id: unknown, condition?: string) => {
    const [pk, ...more] = primaryKey(table);
    if (!pk || more.length) throw new ToolRefusal(`${table.id} has no single-column key to name a record by.`);
    if (id === undefined || id === null || id === '') throw new ToolRefusal('Name the record by its id.');
    const { rows } = await run(`${table.id} ${pk} = ${quoted(id)}${condition ? ` and (${condition})` : ''} limit 1`, 1);
    if (!rows.length) return undefined;
    const label = labelColumn(table);
    const key = { [pk]: rows[0][pk] ?? id };
    return {
      row: rows[0],
      key,
      title: String(label && rows[0][label] != null ? rows[0][label] : `${table.id} ${String(id)}`),
      address: await addressOf(table.id, key),
    };
  };
  const verbOf = (name: string): CatalogVerb => {
    const [resource, action, rest] = String(name ?? '').split('.');
    const verb =
      rest === undefined
        ? session.catalog.resources.find((each) => each.name === resource)?.verbs.find((each) => each.id === action)
        : undefined;
    if (!verb) {
      throw new ToolRefusal(
        `"${name}" is not a change this person may propose. They may propose: ${
          session.catalog.resources.flatMap((each) => each.verbs.map((verb) => `${each.name}.${verb.id}`)).join(', ') || 'nothing'
        }.`,
      );
    }
    return verb;
  };
  const servedAction = (resource: string, id: string) =>
    (session.payload.resources[resource] as { actions?: Array<Record<string, unknown>> } | undefined)?.actions?.find(
      (each) => each.id === id,
    );
  return { ask, run, measure, record, tableOf, addressOf, verbOf, servedAction, catalogSchema };
}
type Context = ReturnType<typeof toolContext>;

const words = (text: string) =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1);

async function find(context: Context, session: ToolSession, input: Record<string, unknown>) {
  const text = String(input.text ?? '').trim();
  if (!text) throw new ToolRefusal('find takes text.');
  const asked = words(text);
  const matches = (...names: string[]) => asked.some((word) => names.some((name) => name.toLowerCase().includes(word)));
  const catalog = {
    resources: session.catalog.resources.filter((each) => matches(each.name, each.label)).map((each) => each.name),
    views: session.catalog.views.filter((each) => matches(each.id, each.label)).map((each) => each.id),
    changes: session.catalog.resources.flatMap((each) =>
      each.verbs.filter((verb) => matches(verb.id, verb.label)).map((verb) => `${each.name}.${verb.id}`),
    ),
  };
  const records: Array<Record<string, unknown>> = [];
  const schema = await context.catalogSchema();
  for (const resource of session.catalog.resources.map((each) => each.name).slice(0, 12)) {
    const table = schema.tables.find((each) => each.id === resource);
    const label = table && labelColumn(table);
    const [pk, ...more] = table ? primaryKey(table) : [];
    if (!table || !label || !pk || more.length) continue;
    try {
      const { rows } = await context.run(
        `${table.id} ${label} contains ${JSON.stringify(text.replaceAll('"', ''))} show ${pk}, ${label} limit 5`,
        5,
      );
      for (const row of rows) {
        const key = { [pk]: row[pk] };
        records.push({ resource, id: row[pk], label: row[label], address: await context.addressOf(table.id, key) });
      }
    } catch {
      /* A table this text cannot be compared on is not a match. */
    }
  }
  return { result: { ...catalog, records }, label: `Searched for “${text}”`, count: records.length };
}

async function describe(context: Context, session: ToolSession, input: Record<string, unknown>) {
  if (typeof input.action === 'string') {
    const verb = context.verbOf(input.action);
    const table = await context.tableOf(verb.resource);
    if (verb.kind === 'new') {
      const form = (
        session.payload.resources[verb.resource] as { form?: { show?: string[]; defaults?: Record<string, unknown> } } | undefined
      )?.form;
      const shown = form?.show ?? table.columns.filter((column) => !column.primaryKey).map((column) => column.name);
      const fields = table.columns
        .filter((column) => shown.includes(column.name))
        .map((column) => ({
          name: column.name,
          type: column.type,
          ...(!column.nullable && column.default === undefined && form?.defaults?.[column.name] === undefined ? { required: true } : {}),
          ...(column.allowed ? { choices: column.allowed } : {}),
          ...(column.references ? { references: column.references.table } : {}),
          ...(form?.defaults?.[column.name] !== undefined ? { default: form.defaults[column.name] } : {}),
        }));
      return {
        result: { action: `${verb.resource}.new`, label: `New ${verb.resource}`, fields },
        label: `Looked at the New ${verb.resource} form`,
      };
    }
    const action = context.servedAction(verb.resource, verb.id) ?? {};
    const command = action.command as { input?: Array<Record<string, unknown>> } | undefined;
    const inputs = (command?.input ?? []).map((field) => ({
      name: field.name,
      type: field.type,
      ...(field.required && !field.when ? { required: true } : {}),
      // Asked only of a record this holds for; leave it out of any other.
      ...(typeof field.when === 'string' ? { when: field.when } : {}),
      ...(Array.isArray(field.options) ? { choices: (field.options as Array<{ value: unknown }>).map((option) => option.value) } : {}),
      ...(field.type === 'reference' && field.from ? { references: field.from } : {}),
    }));
    return {
      result: {
        action: `${verb.resource}.${verb.id}`,
        label: verb.label,
        on: 'one record (give its id)',
        ...(action.when ? { when: action.when } : {}),
        ...(action.set ? { sets: action.set } : {}),
        ...(action.reason ? { asks: `a reason, in ${String(action.reason)}` } : {}),
        ...(command ? { inputs } : {}),
      },
      label: `Looked at ${verb.label}`,
    };
  }
  const resource = String(input.resource ?? '');
  const table = await context.tableOf(resource);
  const fields = table.columns.map((column) => ({
    name: column.name,
    type: column.type,
    ...(column.primaryKey ? { key: true } : {}),
    ...(column.nullable ? {} : { required: true }),
    ...(column.allowed ? { choices: column.allowed } : {}),
    ...(column.references ? { references: column.references.table } : {}),
  }));
  const changes = session.catalog.resources.find((each) => each.name === resource)?.verbs.map((verb) => `${resource}.${verb.id}`) ?? [];
  return { result: { resource, label: labelColumn(table), fields, changes }, label: `Looked at ${resource}` };
}

async function query(context: Context, input: Record<string, unknown>) {
  const q = String(input.q ?? '').trim();
  if (!q) throw new ToolRefusal('query takes q, a line of the query language.');
  const limit = Math.max(1, Math.min(MAX_ROWS, Number.isInteger(input.limit) ? (input.limit as number) : 20));
  /* A line with measures is a grouped read, which the query bar's route does not answer. */
  if (/\b(count|sum|avg|min|max)\b/i.test(q) && !/\bshow\b/i.test(q)) {
    const grouped = await context.measure(q, limit);
    return {
      result: { columns: grouped.columns, rows: grouped.rows.slice(0, SHOWN_TO_MODEL), groups: grouped.total ?? grouped.rows.length },
      label: `Counted: ${q.split(/\s+/)[0]}`,
    };
  }
  const { rows, columns, total, table } = await context.run(q, limit, 'exact');
  const schema = await context.catalogSchema();
  const meta = table ? schema.tables.find((each) => each.id === table) : undefined;
  const [pk] = meta ? primaryKey(meta) : [];
  const shown = await Promise.all(
    rows.slice(0, SHOWN_TO_MODEL).map(async (row) => {
      const out = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clipped(value)]));
      if (meta && pk && row[pk] !== undefined) {
        const address = await context.addressOf(meta.id, { [pk]: row[pk] });
        if (address) out.address = address;
      }
      return out;
    }),
  );
  return {
    result: {
      ...(table ? { resource: table } : {}),
      total: total ?? rows.length,
      columns,
      rows: shown,
      ...(rows.length > shown.length ? { more: rows.length - shown.length } : {}),
    },
    label: `Read ${table ?? 'records'}: ${total ?? rows.length} ${total === 1 ? 'row' : 'rows'}`,
  };
}

const SORT = /^[A-Za-z_][\w.]*(?: (?:asc|desc))?$/;

async function show(context: Context, session: ToolSession, input: Record<string, unknown>) {
  const kind = String(input.kind ?? '');
  if (!(session.assistant.blocks as string[]).includes(kind)) throw new ToolRefusal(`show draws ${session.assistant.blocks.join(', ')}.`);
  const resource = String(input.resource ?? '');
  const table = await context.tableOf(resource);
  const title = typeof input.title === 'string' && input.title.trim() ? input.title.trim().slice(0, 120) : undefined;
  if (kind === 'record') {
    const found = await context.record(table, input.id);
    if (!found) throw new ToolRefusal(`No ${resource} with that id is visible to this person.`);
    const block: AssistantBlock = {
      kind: 'record',
      table: table.id,
      key: found.key,
      title: title ?? found.title,
      values: found.row,
      ...(found.address ? { address: found.address } : {}),
    };
    return {
      // One record is small: the model reads its values (clipped) to say anything about it.
      result: {
        shown: 'record',
        title: found.title,
        ...(found.address ? { address: found.address } : {}),
        values: Object.fromEntries(Object.entries(found.row).map(([name, value]) => [name, clipped(value)])),
      },
      label: `Showed ${found.title}`,
      block,
    };
  }
  const condition = typeof input.query === 'string' && input.query.trim() ? input.query.trim() : undefined;
  if (condition && /^\s*(show|sort|limit)\b/i.test(condition))
    throw new ToolRefusal('query holds conditions only; show, sort and limit are their own keys.');
  if (kind === 'table') {
    const label = labelColumn(table);
    const show =
      Array.isArray(input.show) && input.show.length
        ? (input.show as unknown[]).map(String)
        : [
            ...new Set(
              [label, ...table.columns.filter((column) => !column.primaryKey).map((column) => column.name)].filter(Boolean) as string[],
            ),
          ].slice(0, 5);
    const sort = typeof input.sort === 'string' && input.sort.trim() ? input.sort.trim() : undefined;
    if (sort && !SORT.test(sort)) throw new ToolRefusal('sort is one column, then asc or desc: "created_on desc".');
    const limit = Math.max(1, Math.min(MAX_ROWS, Number.isInteger(input.limit) ? (input.limit as number) : 10));
    const { rows, total } = await context.run(
      `${table.id}${condition ? ` ${condition}` : ''} show ${show.join(', ')}${sort ? ` sort ${sort}` : ''} limit ${limit}`,
      limit,
      'exact',
    );
    const section = {
      kind: 'rows',
      title: title ?? '',
      table: table.id,
      ...(condition ? { query: condition } : {}),
      show,
      ...(sort ? { sort } : {}),
      limit,
    };
    return {
      result: {
        shown: 'table',
        rows: rows.length,
        total: total ?? rows.length,
        first: rows.slice(0, 10).map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, clipped(v)]))),
      },
      label: `Showed ${title ?? table.id}: ${total ?? rows.length} ${total === 1 ? 'row' : 'rows'}`,
      block: { kind: 'section', section } as AssistantBlock,
    };
  }
  const measure = typeof input.measure === 'string' && input.measure.trim() ? input.measure.trim() : undefined;
  const by = typeof input.by === 'string' && input.by.trim() ? input.by.trim() : undefined;
  if (kind !== 'metric' && !by) throw new ToolRefusal(`A ${kind} takes by: the column it is drawn by.`);
  const shape =
    kind === 'chart' && typeof input.shape === 'string' && ['bar', 'line', 'donut'].includes(input.shape) ? input.shape : undefined;
  const { rows } = await context.measure(
    `${table.id}${condition ? ` where ${condition}` : ''} ${measure ?? 'count'}${by ? ` by ${by}` : ''}`,
    50,
  );
  const section = {
    kind,
    title: title ?? '',
    table: table.id,
    ...(condition ? { query: condition } : {}),
    ...(measure ? { measure } : {}),
    ...(by ? { by } : {}),
    /* Asked for, the shape is kept; unasked, groups of a kind are bars and a calendar bucket ("month close_date") a line. */
    ...(kind === 'chart' ? { shape: shape ?? (by && /^(day|week|month|quarter|year)\s/.test(by) ? 'line' : 'bar') } : {}),
  };
  return {
    result: { shown: kind, values: rows.slice(0, 12) },
    label: `Showed ${title ?? `${kind} of ${table.id}`}`,
    block: { kind: 'section', section } as AssistantBlock,
  };
}

async function propose(
  context: Context,
  input: Record<string, unknown>,
  id: string,
): Promise<{ proposal: Proposal; label: string; result: unknown }> {
  const verb = context.verbOf(String(input.action ?? ''));
  const table = await context.tableOf(verb.resource);
  const values =
    input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? (input.values as Record<string, unknown>) : {};
  const why = typeof input.why === 'string' && input.why.trim() ? input.why.trim().slice(0, 300) : undefined;
  if (verb.kind === 'new') {
    const columns = new Set(table.columns.map((column) => column.name));
    const unknown = Object.keys(values).filter((name) => !columns.has(name));
    if (unknown.length)
      throw new ToolRefusal(
        `${verb.resource} has no field ${unknown.map((name) => `"${name}"`).join(', ')}; describe ${verb.resource}.new for its fields.`,
      );
    const proposal: Proposal = {
      id,
      kind: 'new',
      resource: verb.resource,
      action: 'new',
      label: `New ${verb.resource}`,
      values,
      ...(why ? { why } : {}),
    };
    return {
      proposal,
      label: `Proposed a new ${verb.resource}`,
      result: { proposed: `${verb.resource}.new`, waiting: 'for the person to confirm' },
    };
  }
  const found = await context.record(table, input.id);
  if (!found) throw new ToolRefusal(`No ${verb.resource} with that id is visible to this person.`);
  const action = context.servedAction(verb.resource, verb.id) ?? {};
  if (typeof action.when === 'string' && action.when && !(await context.record(table, input.id, action.when))) {
    throw new ToolRefusal(`${verb.label} is not offered on ${found.title} now: it applies where ${action.when}.`);
  }
  let kept: Record<string, unknown> = {};
  if (verb.kind === 'command') {
    const fields = ((action.command as { input?: Array<{ name: string }> } | undefined)?.input ?? []).map((field) => field.name);
    const unknown = Object.keys(values).filter((name) => !fields.includes(name));
    if (unknown.length) throw new ToolRefusal(`${verb.label} takes ${fields.join(', ') || 'no inputs'}; not ${unknown.join(', ')}.`);
    kept = values;
  } else if (typeof action.reason === 'string' && typeof values[action.reason] === 'string') {
    kept = { [action.reason]: values[action.reason] };
  }
  const proposal: Proposal = {
    id,
    kind: verb.kind,
    resource: verb.resource,
    action: verb.id,
    label: verb.label,
    key: found.key,
    record: found.title,
    ...(found.address ? { address: found.address } : {}),
    values: kept,
    ...(why ? { why } : {}),
  };
  return {
    proposal,
    label: `Proposed ${verb.label}: ${found.title}`,
    result: { proposed: `${verb.resource}.${verb.id}`, record: found.title, waiting: 'for the person to confirm' },
  };
}

/** Answer one tool call. A refusal is told to the model as an error it can correct; anything else is a failed step. */
export async function answerTool(session: ToolSession, name: string, input: unknown, id: string): Promise<ToolAnswer> {
  const context = toolContext(session);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    if (!(session.assistant.tools as string[]).includes(name)) throw new ToolRefusal(`There is no tool "${name}" here.`);
    if (name === 'run') {
      const { proposal, label, result } = await propose(context, args, id);
      return {
        result: JSON.stringify(result),
        proposal,
        display: [
          { type: 'step', id, tool: name, label },
          { type: 'proposal', id, proposal },
        ],
      };
    }
    const answered =
      name === 'find'
        ? await find(context, session, args)
        : name === 'describe'
          ? await describe(context, session, args)
          : name === 'query'
            ? await query(context, args)
            : await show(context, session, args);
    const display: DisplayItem[] = [{ type: 'step', id, tool: name, label: answered.label }];
    if ('block' in answered && answered.block) display.push({ type: 'block', id, block: answered.block });
    return { result: JSON.stringify(answered.result), display };
  } catch (error) {
    if (session.signal.aborted) throw error;
    const message = error instanceof ToolRefusal ? error.message : 'That could not be read just now.';
    return {
      result: JSON.stringify({ error: message }),
      isError: true,
      display: [{ type: 'step', id, tool: name, label: `${name}: ${message}`, failed: true }],
    };
  }
}

/**
 * The open record, as the person's message names it: its label, and the
 * changes on offer for it now — each fixed action or command whose `when`
 * the record meets, of those the person may propose.
 */
export async function recordContext(session: ToolSession, resource: unknown, key: unknown): Promise<string | undefined> {
  if (typeof resource !== 'string' || !key || typeof key !== 'object') return undefined;
  const context = toolContext(session);
  try {
    const table = await context.tableOf(resource);
    const [pk] = primaryKey(table);
    const id = (key as Record<string, unknown>)[pk];
    const found = await context.record(table, id);
    if (!found) return undefined;
    const offered: string[] = [];
    for (const verb of session.catalog.resources.find((each) => each.name === resource)?.verbs ?? []) {
      if (verb.kind === 'new') continue;
      const when = context.servedAction(resource, verb.id)?.when;
      if (typeof when === 'string' && when && !(await context.record(table, id, when))) continue;
      offered.push(`${resource}.${verb.id} "${verb.label}"`);
    }
    // The title is the row's text, quoted as JSON is: a quote or a line break in it cannot end it and speak as the person.
    return `Open record: ${resource}/${String(id)} ${JSON.stringify(String(found.title))}${found.address ? ` at ${found.address}` : ''}. Changes on offer for it now: ${offered.join(', ') || 'none'}.`;
  } catch {
    return undefined;
  }
}
