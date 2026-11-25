/**
 * The five tools, answered as the person: every read is a request through
 * the server's own dispatcher with the turn's headers (the loopback first
 * paint uses), so the gate, grants, hidden columns and a row policy apply as
 * they do to the page. There is no other read path here to get wrong.
 *
 * `run` writes nothing. It checks the verb against the person's catalog and
 * the record's state now, and returns a proposal the panel draws as a card.
 * A New form or a fixed action waits for the person's own confirmation, which
 * runs it through the page's write path, and its outcome comes back to the
 * conversation (assistantTurn.ts). A command is kept as a stored proposal for
 * review (commands/proposals.ts), with the records the turn read as its
 * evidence, and the turn goes on: approving it runs it as the approver.
 *
 * Every tool answers twice: the model gets a compact summary (ids, counts,
 * the first rows, addresses), the person gets what the panel draws (a folded
 * step line, a block, a card).
 */
import type { AppAssistant } from '../../shared/appAssistant.js';
import { appAddressBook, recordSegments, type AddressBook } from '../../shared/appAddress.js';
import { viewOrder } from '../../shared/appModel.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { primaryKey, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { dashboardListQuery } from '@mistriwork/engine/shared/dashboardAsks.js';
import { formShownFields } from '@mistriwork/engine/shared/form.js';
import type { Loop } from '@mistriwork/engine/server/http/firstPaint.js';
import { lookupsOf } from '../http/firstPaintRooms.js';
import type { CommandProposalRow, ProposalEvidence } from '../../adapters/commands/commandJournalTypes.js';
import { isBusinessCommandExecutionError } from '../commands/commandErrors.js';
import type { ProposalDraft } from '../commands/proposals.js';
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
  /** A command's stored proposal (commands/proposals.ts): decided by approve or dismiss, as the review queue does, and
   * the turn did not wait for it. */
  review?: string;
}

export type DisplayItem =
  | { type: 'step'; id: string; tool: string; label: string; failed?: true }
  | { type: 'block'; id: string; block: AssistantBlock }
  | { type: 'proposal'; id: string; proposal: Proposal }
  /* Ask shows what it read: the line it ran, as the query bar would take it, and the rows it read there, each a record
     the person may open. Only what this person's own read returned, so it says nothing they could not see. */
  | { type: 'query'; id: string; q: string; resource?: string; total: number; evidence: AskEvidence[] };

/** One row an Ask read: the evidence shape a proposal keeps, with the address the reader opens it at. */
interface AskEvidence extends ProposalEvidence {
  address?: string;
}

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
  /** Keeps a command's proposal for review as this person, under the grant and row policy their own run would meet
   * (http/assistantProposal.ts; a tenant App's host, tenant/tenantHttp.ts `propose`). */
  propose?: (draft: ProposalDraft) => Promise<CommandProposalRow>;
  /** Ask: the turn reads and shows what it read; the only change it may make is a command kept for review. */
  ask?: true;
}

/** A refusal the model is told and may act on: a wrong name, a field that is not there. */
class ToolRefusal extends Error {}

const MAX_ROWS = 50;
const SHOWN_TO_MODEL = 20;
const TEXT_TO_MODEL = 160;
/* What one tool result may be, as JSON: about 1,700 tokens. Every later step of the turn reads every earlier result
   again, so a wide table's twenty rows told back whole were paid for five times over; a field report's "Which tickets
   are mine?" spent its 60,000 tokens in five steps. Past this a result is cut to fit, and says so. */
const RESULT_CHARS = 6_000;
/* A table block's rows the model is told: enough to name and link a few. The person sees the block itself. */
const TABLE_ROWS_TO_MODEL = 5;
const RECORDS_TO_MODEL = 20;
/* What a stored proposal may carry as evidence (adapters/commands/commandProposals.ts keeps 64): the last records the
   turn read, nearest the proposal. */
const EVIDENCE_KEPT = 32;
const plain = (text: unknown, most: number) =>
  String(text ?? '')
    .replace(/\p{Cc}+/gu, ' ')
    .trim()
    .slice(0, most);
const CHOICES_TO_MODEL = 20;

const quoted = (value: unknown): string => {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  const text = String(value ?? '');
  if (/^-?\d+$/.test(text)) return text;
  if (text.includes('"') || /[\r\n]/.test(text)) throw new ToolRefusal('A key with a quote or a line break cannot be named.');
  return `"${text}"`;
};
const clipped = (value: unknown): unknown =>
  typeof value === 'string' && value.length > TEXT_TO_MODEL ? `${value.slice(0, TEXT_TO_MODEL)}…` : value;

/**
 * A result as the model is told it, at most RESULT_CHARS of JSON: a list in it (rows, records, fields) is halved
 * until the whole fits, an object of values loses its last keys, and `cut` says how many went, so the model asks for
 * fewer columns or rows rather than taking a part for the whole.
 */
function fitted(result: unknown, most = RESULT_CHARS): string {
  let text = JSON.stringify(result);
  if (text.length <= most || !result || typeof result !== 'object' || Array.isArray(result)) return text;
  const out = { ...(result as Record<string, unknown>) };
  let cut = 0;
  for (const [key, value] of Object.entries(out)) {
    if (text.length <= most) break;
    if (Array.isArray(value)) {
      let kept = value;
      while (kept.length > 1 && text.length > most) {
        kept = kept.slice(0, Math.ceil(kept.length / 2));
        out[key] = kept;
        text = JSON.stringify({ ...out, cut: cut + value.length - kept.length });
      }
      cut += value.length - kept.length;
    } else if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      let kept = entries;
      while (kept.length > 1 && text.length > most) {
        kept = kept.slice(0, Math.ceil(kept.length / 2));
        out[key] = Object.fromEntries(kept);
        text = JSON.stringify({ ...out, cut: cut + entries.length - kept.length });
      }
      cut += entries.length - kept.length;
    }
  }
  if (cut) out.cut = `${cut} left out to keep this short: ask for fewer columns or rows`;
  text = JSON.stringify(out);
  // A single value too long to keep (it was clipped already) is said as the part that fits.
  return text.length <= most ? text : JSON.stringify({ partial: text.slice(0, most) });
}

/* One turn's reads share their catalog: each tool call asked `/api/schema` again, a request through the tenant host's
   admission per call on a slow deployment. A session is one turn. */
const contexts = new WeakMap<ToolSession, ReturnType<typeof makeContext>>();
function toolContext(session: ToolSession) {
  let context = contexts.get(session);
  if (!context) contexts.set(session, (context = makeContext(session)));
  return context;
}

function makeContext(session: ToolSession) {
  let schema: Promise<DatabaseSchema> | undefined;
  let book: AddressBook | undefined;
  /* The records this turn read, as a reviewer is shown them: what the assistant had before it proposed. Read again,
     a record moves to the end, so the newest reads are the ones kept. */
  const evidence = new Map<string, ProposalEvidence>();
  const read = (table: string, key: Record<string, unknown>, label: unknown) => {
    const ref = `${table}/${JSON.stringify(key)}`;
    if (ref.length > 2048) return;
    evidence.delete(ref);
    evidence.set(ref, { kind: 'record', ref, label: plain(label, 200) || ref.slice(0, 200) });
  };
  const evidenceRead = () => [...evidence.values()].slice(-EVIDENCE_KEPT);
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
  /* Where a table's records are named, as the App's lists and breadcrumbs read it: the resource's `recordLabel` (a
     column, a path, or a template the catalog computes as `$label`), and only without one the engine's guess at a
     name column. A card that said "visit 12" beside a page titled "Ada Park · Annual physical" named another thing. */
  const naming = async (table: TableMeta): Promise<string | undefined> =>
    lookupsOf({ schema: await catalogSchema(), resources: session.payload.resources }).naming(table);
  const said = (value: unknown) => (value === null || value === undefined || value === '' ? undefined : value);
  /** One record by key, if this person can see it. */
  const record = async (table: TableMeta, id: unknown, condition?: string) => {
    const [pk, ...more] = primaryKey(table);
    if (!pk || more.length) throw new ToolRefusal(`${table.id} has no single-column key to name a record by.`);
    if (id === undefined || id === null || id === '') throw new ToolRefusal('Name the record by its id.');
    const { rows } = await run(`${table.id} ${pk} = ${quoted(id)}${condition ? ` and (${condition})` : ''} limit 1`, 1);
    if (!rows.length) return undefined;
    const label = await naming(table);
    let name = label ? said(rows[0][label]) : undefined;
    /* A name that is a path or a template is not one of the row's own columns: it is read as a list reads it. A
       name that cannot be read (a path this person may not follow) leaves the record named by its key. */
    if (label && name === undefined && !(label in rows[0])) {
      const named = await run(`${table.id} ${pk} = ${quoted(id)} show ${pk}, ${label} limit 1`, 1).catch(() => undefined);
      name = said(named?.rows[0]?.[label]);
    }
    const key = { [pk]: rows[0][pk] ?? id };
    const title = String(name ?? `${table.id} ${String(id)}`);
    read(table.id, key, title);
    return { row: rows[0], key, title, address: await addressOf(table.id, key) };
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
  return { ask, run, measure, record, naming, tableOf, addressOf, verbOf, servedAction, catalogSchema, read, evidenceRead };
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
    const label = table && (await context.naming(table));
    const [pk, ...more] = table ? primaryKey(table) : [];
    if (!table || !label || !pk || more.length) continue;
    try {
      const { rows } = await context.run(
        `${table.id} ${label} contains ${JSON.stringify(text.replaceAll('"', ''))} show ${pk}, ${label} limit 5`,
        5,
      );
      for (const row of rows) {
        const key = { [pk]: row[pk] };
        context.read(table.id, key, row[label]);
        records.push({ resource, id: row[pk], label: row[label], address: await context.addressOf(table.id, key) });
      }
    } catch {
      /* A table this text cannot be compared on is not a match. */
    }
  }
  return {
    result: {
      ...catalog,
      records: records.slice(0, RECORDS_TO_MODEL),
      ...(records.length > RECORDS_TO_MODEL ? { more: records.length - RECORDS_TO_MODEL } : {}),
    },
    label: `Searched for “${text}”`,
    count: records.length,
  };
}

/** A resource's New form as this person is served it, and the fields it asks: all a proposal for it may fill. */
function newForm(session: ToolSession, resource: string, table: TableMeta) {
  const form = (
    session.payload.resources[resource] as
      | { form?: { show?: string[]; steps?: Array<{ fields: string[] }>; defaults?: Record<string, unknown> } }
      | undefined
  )?.form;
  const shown = formShownFields(form) ?? table.columns.filter((column) => !column.primaryKey).map((column) => column.name);
  return { form, shown };
}

async function describe(context: Context, session: ToolSession, input: Record<string, unknown>) {
  if (typeof input.action === 'string') {
    const verb = context.verbOf(input.action);
    const table = await context.tableOf(verb.resource);
    if (verb.kind === 'new') {
      const { form, shown } = newForm(session, verb.resource, table);
      const fields = table.columns
        .filter((column) => shown.includes(column.name))
        .map((column) => ({
          name: column.name,
          type: column.type,
          ...(!column.nullable && column.default === undefined && form?.defaults?.[column.name] === undefined ? { required: true } : {}),
          ...(column.allowed ? { choices: column.allowed.slice(0, CHOICES_TO_MODEL) } : {}),
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
    ...(column.allowed ? { choices: column.allowed.slice(0, CHOICES_TO_MODEL) } : {}),
    ...(column.references ? { references: column.references.table } : {}),
  }));
  const changes = session.catalog.resources.find((each) => each.name === resource)?.verbs.map((verb) => `${resource}.${verb.id}`) ?? [];
  return { result: { resource, label: await context.naming(table), fields, changes }, label: `Looked at ${resource}` };
}

async function query(context: Context, input: Record<string, unknown>) {
  const q = String(input.q ?? '').trim();
  if (!q) throw new ToolRefusal('query takes q, a line of the query language.');
  const limit = Math.max(1, Math.min(MAX_ROWS, Number.isInteger(input.limit) ? (input.limit as number) : 20));
  /* A line with measures is a grouped read, which the query bar's route does not answer. */
  if (/\b(count|sum|avg|min|max)\b/i.test(q) && !/\bshow\b/i.test(q)) {
    const grouped = await context.measure(q, limit);
    return {
      asked: { q, total: grouped.total ?? grouped.rows.length, evidence: [] as AskEvidence[] },
      result: { columns: grouped.columns, rows: grouped.rows.slice(0, SHOWN_TO_MODEL), groups: grouped.total ?? grouped.rows.length },
      label: `Counted: ${q.split(/\s+/)[0]}`,
    };
  }
  const { rows, columns, total, table } = await context.run(q, limit, 'exact');
  const schema = await context.catalogSchema();
  const meta = table ? schema.tables.find((each) => each.id === table) : undefined;
  const [pk] = meta ? primaryKey(meta) : [];
  const label = meta && (await context.naming(meta));
  const cited: AskEvidence[] = [];
  /* The rows' names, where the read did not carry them (a `show` without it, a name that is a path or a template):
     one more read, by key, so the model has a name to say and the evidence a name to show, not "visit 12". */
  const names = new Map<string, unknown>();
  const head = rows.slice(0, SHOWN_TO_MODEL);
  if (meta && pk && label && head.length && head.every((row) => row[pk] !== undefined && !(label in row))) {
    try {
      const named = await context.run(
        `${meta.id} ${pk} in (${head.map((row) => quoted(row[pk])).join(', ')}) show ${pk}, ${label} limit ${head.length}`,
        head.length,
      );
      for (const row of named.rows) if (row[label] != null && row[label] !== '') names.set(String(row[pk]), row[label]);
    } catch {
      /* A name that cannot be read leaves the rows named by their keys. */
    }
  }
  const shown = await Promise.all(
    head.map(async (row) => {
      const name = meta && pk && label ? (row[label] != null && row[label] !== '' ? row[label] : names.get(String(row[pk]))) : undefined;
      const said = meta && pk && row[pk] !== undefined ? (name ?? `${meta.id} ${String(row[pk])}`) : undefined;
      if (meta && pk && row[pk] !== undefined) context.read(meta.id, { [pk]: row[pk] }, said);
      const out = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, clipped(value)]));
      if (label && name !== undefined && !(label in row)) out.label = clipped(name);
      if (meta && pk && row[pk] !== undefined) {
        const address = await context.addressOf(meta.id, { [pk]: row[pk] });
        if (address) out.address = address;
        const ref = `${meta.id}/${JSON.stringify({ [pk]: row[pk] })}`;
        if (ref.length <= 2048)
          cited.push({ kind: 'record', ref, label: plain(said, 200) || ref.slice(0, 200), ...(address ? { address } : {}) });
      }
      return out;
    }),
  );
  return {
    asked: { q, ...(table ? { resource: table } : {}), total: total ?? rows.length, evidence: cited },
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
    /* Unasked, a table is the App's own list of these records: what names the row first, then the list view's
       columns, and only for a table no list shows its first columns. The model's own `show` is drawn as asked. */
    const [pk] = primaryKey(table);
    const label = await context.naming(table);
    const listed = Object.values(session.payload.views as Record<string, { kind?: string; table?: string; show?: string[] }>).find(
      (view) => (view.kind ?? 'list') === 'list' && view.table === table.id && view.show?.length,
    )?.show;
    const asked = Array.isArray(input.show) && input.show.length ? (input.show as unknown[]).map(String) : undefined;
    let show =
      asked ??
      [
        ...new Set(
          [label, ...(listed ?? table.columns.filter((column) => !column.primaryKey).map((column) => column.name))].filter(
            (name) => name && name !== pk,
          ) as string[],
        ),
      ].slice(0, 5);
    const sort = typeof input.sort === 'string' && input.sort.trim() ? input.sort.trim() : undefined;
    if (sort && !SORT.test(sort)) throw new ToolRefusal('sort is one column, then asc or desc: "created_on desc".');
    const limit = Math.max(1, Math.min(MAX_ROWS, Number.isInteger(input.limit) ? (input.limit as number) : 10));
    const sectionOf = (columns: string[]) => ({
      kind: 'rows',
      title: title ?? '',
      table: table.id,
      ...(condition ? { query: condition } : {}),
      show: columns,
      ...(sort ? { sort } : {}),
      limit,
    });
    /* Read as the panel will read it: the dashboard's own question for this section (shared/dashboardAsks.ts), the
       names of its references and its keys with it. A block is drawn only over a read that answered, so a question
       the panel's table could not ask is the model's to correct, never a table that says "No rows match." */
    const rules = { schema: await context.catalogSchema(), resources: session.payload.resources };
    const { rows, total } = await context.run(dashboardListQuery(lookupsOf(rules), sectionOf(show)).query, limit, 'exact');
    /* A column with nothing in any row drawn says nothing and takes a fifth of the table: it is left out, unless
       that would leave no column at all. The panel reads these same rows, so what is empty here is empty there. */
    const filled = show.filter((name) => rows.some((row) => row[name] !== null && row[name] !== undefined && row[name] !== ''));
    const dropped = rows.length && filled.length ? show.filter((name) => !filled.includes(name)) : [];
    if (dropped.length) show = filled;
    const section = sectionOf(show);
    const told = await Promise.all(
      rows.slice(0, TABLE_ROWS_TO_MODEL).map(async (row) => {
        const out: Record<string, unknown> = Object.fromEntries(
          [...new Set([...(pk ? [pk] : []), ...show])].filter((name) => name in row).map((name) => [name, clipped(row[name])]),
        );
        const address = pk && row[pk] !== undefined ? await context.addressOf(table.id, { [pk]: row[pk] }) : undefined;
        if (address) out.address = address;
        return out;
      }),
    );
    const matched = total ?? rows.length;
    /* An empty table is not an answer: "No rows match." under a title said less than one sentence does, and sent
       the model looking again. Nothing is drawn; the model says so. */
    if (!rows.length)
      return {
        result: {
          shown: 'nothing',
          total: 0,
          note: 'No rows match, so no table was drawn. Say so in a sentence; if that is unexpected, check the condition with describe.',
        },
        label: `Found no ${table.id} for ${title ?? 'that'}`,
      };
    return {
      result: {
        shown: 'table',
        total: matched,
        drawn: rows.length,
        columns: show,
        ...(dropped.length ? { empty: `${dropped.join(', ')}: empty in every row, so not drawn` } : {}),
        first: told,
      },
      label: `Showed ${title ?? table.id}: ${matched} ${matched === 1 ? 'row' : 'rows'}`,
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
  /* A figure, a chart or a breakdown over no rows is "Nothing to count yet" above the answer, as an empty table was
     "No rows match.": nothing is drawn, and the model says so. A count of none still answers with its one row, 0. */
  if (!rows.length || (!by && rows.every((row) => Object.values(row).every((value) => value === null || value === undefined))))
    return {
      result: {
        shown: 'nothing',
        note: `Nothing to measure, so no ${kind} was drawn. Say so in a sentence; if that is unexpected, check the condition with describe.`,
      },
      label: `Found nothing to measure for ${title ?? table.id}`,
    };
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
  session: ToolSession,
  input: Record<string, unknown>,
  id: string,
): Promise<{ proposal: Proposal; label: string; result: unknown; review?: boolean }> {
  const verb = context.verbOf(String(input.action ?? ''));
  /* Ask changes nothing in front of the person: a command may be kept for review (below), where someone approves it
     on its own; a set or a New form would be a card confirmed in the answer, which Ask does not draw. */
  const readOnly = () => new ToolRefusal(`Ask only reads: ${verb.label} cannot be proposed here. Say what would change, in words.`);
  if (session.ask && (verb.kind !== 'command' || !session.propose)) throw readOnly();
  const table = await context.tableOf(verb.resource);
  const values =
    input.values && typeof input.values === 'object' && !Array.isArray(input.values) ? (input.values as Record<string, unknown>) : {};
  const why = typeof input.why === 'string' && input.why.trim() ? input.why.trim().slice(0, 300) : undefined;
  if (verb.kind === 'new') {
    /* Only what the New form asks: a column it does not show (a hidden one, one the machine or the platform fills)
       would otherwise ride into the form as a default the person never sees, and be written on their Confirm. */
    const { shown } = newForm(session, verb.resource, table);
    const unknown = Object.keys(values).filter((name) => !shown.includes(name));
    if (unknown.length)
      throw new ToolRefusal(
        `The New ${verb.resource} form has no field ${unknown.map((name) => `"${name}"`).join(', ')}; describe ${verb.resource}.new for its fields.`,
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
  const command = verb.kind === 'command' ? (action.command as { id?: unknown } | undefined)?.id : undefined;
  if (session.propose && typeof command === 'string') {
    /* A command is kept for review, as the person: their grant and their rows decide it (http/assistantProposal.ts),
       and approving it runs it as whoever approves. The turn does not wait for it. */
    let row: CommandProposalRow;
    try {
      row = await session.propose({
        command,
        key: found.key as Record<string, string | number>,
        input: kept,
        maker: 'assistant',
        makerActor: 'assistant',
        ...(session.assistant.model ? { model: plain(session.assistant.model, 200) } : {}),
        evidence: context.evidenceRead(),
        reason: plain(why ?? `${verb.label}: ${found.title}`, 2000) || verb.label,
      });
    } catch (error) {
      if (session.signal.aborted || !isBusinessCommandExecutionError(error)) throw error;
      throw new ToolRefusal(
        error.code === 'forbidden'
          ? `This person may not run ${verb.label}, so it cannot be proposed for them.`
          : error.code === 'invalid_input'
            ? `${verb.label} does not take those values${error.field ? `: ${error.field} is not right` : ''}.`
            : error.code === 'not_found'
              ? `No ${verb.resource} with that id is visible to this person.`
              : `${verb.label} could not be kept for review just now.`,
      );
    }
    return {
      proposal: { ...proposal, review: row.id },
      label: `Proposed ${verb.label}: ${found.title}`,
      result: { proposed: `${verb.resource}.${verb.id}`, record: found.title, kept: 'for review in the queue', id: row.id },
      review: true,
    };
  }
  if (session.ask) throw readOnly();
  return {
    proposal,
    label: `Proposed ${verb.label}: ${found.title}`,
    result: { proposed: `${verb.resource}.${verb.id}`, record: found.title, waiting: 'for the person to confirm' },
  };
}

/** What a tool call is doing, in a few words, said while it runs (the panel's working line). */
export function runningLabel(name: string, input: unknown): string {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const said = (value: unknown) => (typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 60) : '');
  const label =
    name === 'find' && said(args.text)
      ? `Searching for “${said(args.text)}”`
      : name === 'describe' && (said(args.action) || said(args.resource))
        ? `Looking at ${said(args.action) || said(args.resource)}`
        : name === 'query' && said(args.q)
          ? `Reading ${said(args.q).split(' ')[0]}`
          : name === 'show' && (said(args.title) || said(args.resource))
            ? `Drawing ${said(args.title) || said(args.resource)}`
            : name === 'run' && said(args.action)
              ? `Preparing ${said(args.action)}`
              : 'Working';
  return `${label}…`;
}

/** Answer one tool call. A refusal is told to the model as an error it can correct; anything else is a failed step. */
export async function answerTool(session: ToolSession, name: string, input: unknown, id: string): Promise<ToolAnswer> {
  const context = toolContext(session);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  try {
    if (!(session.assistant.tools as string[]).includes(name)) throw new ToolRefusal(`There is no tool "${name}" here.`);
    if (name === 'run') {
      const { proposal, label, result, review } = await propose(context, session, args, id);
      return {
        result: JSON.stringify(result),
        // A stored proposal is not waited for: without `proposal`, the turn goes on (assistantTurn.ts).
        ...(review ? {} : { proposal }),
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
    if (session.ask && 'asked' in answered && answered.asked) display.push({ type: 'query', id, ...answered.asked });
    return { result: fitted(answered.result), display };
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
