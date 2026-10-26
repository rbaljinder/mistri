/**
 * A record's decisions, for the person reading it (design §2, §3, §7):
 *
 * - `/api/record-decisions` — the suggestions waiting on one record's fields;
 * - `/api/record-decisions/marks` — which of a list's rows have one, for the cell's mark;
 * - `/api/record-decisions/settle` — Dismiss, or "I ran it" after Accept or Change…;
 * - `/api/record-decisions/why` — what was asked, of whom, and how sure it was.
 *
 * Each reads the record through the reader's own facade first, as its history
 * does: a record they cannot see has no decisions for them, and a field they
 * cannot read has none either; and a suggestion is only for the people who
 * could accept it, those granted its answer command (`answerDecisions`).
 * Nothing here writes the record: Accept and
 * Change… run the answer command as the person, through the ordinary command
 * route, under their own grants; settling only says what came of it, and is
 * checked against the record as it now is, never taken on the client's word.
 *
 * What people did since is read where it shows, at the moment it is read: a
 * suggestion whose field was filled some other way is ignored (an equal value
 * counts as accepted), and an applied value a person has since changed is
 * corrected — the signal auto-apply's accuracy is judged by.
 *
 * A tenant App answers the same paths on the lease (tenant/tenantHttp.ts),
 * through `answerDecisions` with the lease's own tenant as the rows' owner.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';
import { findTable, labelColumn, type DatabaseSchema, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { columnCaption } from '@mistriwork/engine/shared/columnCaption.js';
import { humanName } from '@mistriwork/engine/shared/model.js';
import type { DecisionOwner, StoredDecision } from '../../adapters/decide/decisionStore.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { appForConnection } from '../app/apps.js';
import { isEmpty, recordKeyText, sameAnswer } from '../decide/decideReads.js';
import { decisionsServedBy, type ServedDecisions } from '../decide/decisionServing.js';
import { exactKey } from '../recordHistory.js';
import { appCommandGrants, type AppDef } from '../../shared/app.js';
import type { DecisionMark, DecisionWhy, FieldSuggestion } from '../../shared/decisionSuggestions.js';

export const DECISION_PATHS: readonly string[] = Object.freeze([
  '/api/record-decisions',
  '/api/record-decisions/marks',
  '/api/record-decisions/settle',
  '/api/record-decisions/why',
]);
/** A list's page at most: a mark per row it shows. */
const MARKS_MOST = 200;

export async function decisionRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appHosts } = post;
  if (!DECISION_PATHS.includes(path)) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  if (!host) {
    send(res, 404, { error: "Decisions belong to an App's records." });
    return true;
  }
  const app = host.app.app;
  const reply = await answerDecisions(path, body, {
    app,
    served: decisionsServedBy(registry, app.id),
    owner: { app: app.id, tenant: '' },
    reader: adapter,
    schema,
    roles: sessionRoles(post.role),
    by: post.who ?? '',
  });
  send(res, 200, reply);
  return true;
}

/** Who asks about a record's decisions, and where: the transport's half of a decision route (a single App's, a tenant's). */
interface DecisionAsker {
  readonly app: AppDef;
  /** What the App decides and the store it decides into; undefined where it decides nothing. */
  readonly served: ServedDecisions | undefined;
  /** Whose rows: the App, and the tenant whose lease this is ('' for an App without tenants). Never the request's word. */
  readonly owner: DecisionOwner;
  /** The record read as the person reads it: their grants, their row scope, their tenant's lease. */
  readonly reader: Adapter;
  readonly schema: DatabaseSchema;
  /** Their verified roles: a suggestion is shown only to someone granted its answer command. */
  readonly roles: readonly string[];
  /** Who settles, for the row's `outcomeBy`. */
  readonly by: string;
}

/**
 * One decision route's answer, or a denial (AppAccessDenied). A suggestion is
 * offered to the people who could accept it: those granted the decision's
 * answer command. Anyone else who reads the field is told of no suggestion
 * there, sees no mark, and is refused its "Why this?" and its settling — a
 * resident reads their own repair, and never the technician the office is
 * offered for it.
 */
export async function answerDecisions(path: string, body: Record<string, unknown>, asker: DecisionAsker): Promise<unknown> {
  const { app, owner, reader, schema, by } = asker;
  const granted = asker.served && appCommandGrants(app, [...asker.roles]);
  const decisions = asker.served
    ? new Map([...asker.served.decisions].filter(([, decision]) => granted!.has(decision.answer.command.id)))
    : undefined;
  const served = asker.served && decisions?.size ? { decisions, store: asker.served.store } : undefined;
  if (path === '/api/record-decisions/marks')
    return served ? await listMarks(served, owner, reader, schema, body.table, body.keys) : { marks: [] };
  if (path === '/api/record-decisions') {
    if (served) return await recordSuggestions(served, owner, reader, schema, body.table, body.key);
    /* Not granted its answer command, the reader is told of no suggestion; a record they cannot read is still refused
       as its history is, not answered as if it were theirs. */
    if (asker.served) await readFor(asker.served, reader, schema, body.table, body.key);
    return { suggestions: [] };
  }
  if (!DECISION_PATHS.includes(path) || !served || typeof body.id !== 'string' || body.id.length > 64) throw new AppAccessDenied();
  const row = await served.store.get(owner, body.id);
  // A row of a decision this person is not offered is no row of theirs.
  if (!row || !served.decisions.has(row.decision)) throw new AppAccessDenied();
  const read = await readFor(served, reader, schema, row.resource, JSON.parse(row.recordKey) as unknown, [row.field]);
  if (!read.fields.includes(row.field)) throw new AppAccessDenied();
  if (path === '/api/record-decisions/why') return await why(app, served, reader, schema, row, read.key);
  const at = new Date().toISOString();
  if (body.action === 'dismiss') {
    const moved = await served.store.settle(owner, row.id, { outcome: 'ignored', reason: 'dismissed', by, at });
    return { outcome: moved ? 'ignored' : row.outcome };
  }
  if (body.action !== 'done') throw new AppAccessDenied();
  // Accept or Change… ran the command as the person: what landed is what the record holds now.
  const current = read.row[row.field];
  if (row.outcome !== 'suggested' || isEmpty(current)) return { outcome: row.outcome };
  const same = sameAnswer(row.answer, current);
  const moved = await served.store.settle(
    owner,
    row.id,
    same ? { outcome: 'accepted', reason: '', by, at } : { outcome: 'corrected', reason: '', correctedTo: current, by, at },
  );
  return { outcome: moved ? (same ? 'accepted' : 'corrected') : row.outcome };
}

/** The decided fields of a table this reader may read: field → its decision's name. */
function decidedFields(served: ServedDecisions, table: TableMeta): Map<string, string> {
  const fields = new Map<string, string>();
  for (const decision of served.decisions.values())
    if (decision.target === table.id && table.columns.some((column) => column.name === decision.answer.field))
      fields.set(decision.answer.field, decision.name);
  return fields;
}

/** The record as this reader sees it, or a denial: its exact key, the decided fields they may read, and those columns' values. */
async function readFor(
  served: ServedDecisions,
  reader: Adapter,
  schema: DatabaseSchema,
  tableId: unknown,
  rawKey: unknown,
  extra: readonly string[] = [],
): Promise<{ table: TableMeta; key: Record<string, string | number>; fields: string[]; row: Record<string, unknown> }> {
  if (typeof tableId !== 'string') throw new AppAccessDenied();
  const table = findTable(schema, tableId);
  if (!table) throw new AppAccessDenied();
  const key = exactKey(schema, tableId, rawKey);
  const fields = [...decidedFields(served, table).keys()];
  const readable = new Set(table.columns.map((column) => column.name));
  const columns = [...new Set([...Object.keys(key), ...fields, ...extra.filter((name) => readable.has(name))])];
  const visible = await reader.query({
    table: tableId,
    columns,
    limit: 1,
    offset: 0,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  if (visible.rows.length !== 1) throw new AppAccessDenied();
  const row = visible.rows[0] as Record<string, unknown>;
  /* The key as the database holds it: a record's address carries `{"id":"3"}`, and the store keys rows by the typed
     value the decision read (`{"id":3}`), so the address's text would find nothing. */
  const held = Object.fromEntries(Object.keys(key).map((column) => [column, (row[column] ?? key[column]) as string | number]));
  return { table, key: held, fields, row };
}

/** The newest row of each decision, from a record's rows newest first. */
const newestEach = (rows: readonly StoredDecision[]) => {
  const seen = new Set<string>();
  return rows.filter((row) => !seen.has(row.decision) && seen.add(row.decision));
};

/**
 * What people did since, read off the record as it is now: a suggestion its
 * field was filled past (equal: accepted; otherwise ignored, filled another
 * way), and an applied value since changed (corrected, edited). True when
 * the row still waits.
 */
async function reconcile(served: ServedDecisions, owner: DecisionOwner, row: StoredDecision, current: unknown): Promise<boolean> {
  const at = new Date().toISOString();
  if (row.outcome === 'applied') {
    if (!isEmpty(current) && !sameAnswer(row.answer, current))
      await served.store.settle(owner, row.id, { outcome: 'corrected', reason: 'edited', correctedTo: current, by: '', at });
    return false;
  }
  if (row.outcome !== 'suggested') return false;
  if (isEmpty(current)) return row.outcomeReason !== 'filled';
  if (sameAnswer(row.answer, current)) {
    await served.store.settle(owner, row.id, { outcome: 'accepted', reason: '', by: '', at });
    return false;
  }
  // Suggested beside a person's value: it stands until someone settles it, unless that value changed to something else since.
  if (row.outcomeReason === 'filled') return true;
  await served.store.settle(owner, row.id, { outcome: 'ignored', reason: 'filled', by: '', at });
  return false;
}

/** A reference answer's record by its label, read as the reader reads; anything else as itself. */
async function answerLabels(reader: Adapter, schema: DatabaseSchema, table: TableMeta, field: string, answers: readonly unknown[]) {
  const labels = new Map<string, string>();
  const said = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));
  const reference = table.columns.find((column) => column.name === field)?.references;
  const target = reference && findTable(schema, reference.table);
  const label = target && labelColumn(target);
  const keys = [...new Set(answers.flatMap((answer) => (Array.isArray(answer) ? answer : [answer])).filter((value) => !isEmpty(value)))];
  if (target && label && keys.length) {
    try {
      const read = await reader.query({
        table: target.id,
        columns: [reference.column, label],
        limit: keys.length,
        offset: 0,
        filter: { groups: [[{ column: reference.column, op: 'in' as const, value: keys as never }]] },
      });
      for (const row of read.rows as Array<Record<string, unknown>>)
        if (!isEmpty(row[label])) labels.set(String(row[reference.column]), String(row[label]));
    } catch {
      // A reference the reader cannot read is said by its key.
    }
  }
  return (answer: unknown) =>
    Array.isArray(answer)
      ? answer.map((each) => labels.get(String(each)) ?? said(each)).join(', ')
      : (labels.get(String(answer)) ?? said(answer));
}

async function recordSuggestions(
  served: ServedDecisions,
  owner: DecisionOwner,
  reader: Adapter,
  schema: DatabaseSchema,
  tableId: unknown,
  rawKey: unknown,
): Promise<{ suggestions: FieldSuggestion[] }> {
  const read = await readFor(served, reader, schema, tableId, rawKey);
  if (!read.fields.length) return { suggestions: [] };
  const rows = newestEach(await served.store.ofRecord(owner, read.table.id, recordKeyText(read.key), 64));
  const waiting: StoredDecision[] = [];
  for (const row of rows) {
    if (!read.fields.includes(row.field) || !served.decisions.has(row.decision)) continue;
    if (await reconcile(served, owner, row, read.row[row.field])) waiting.push(row);
  }
  const suggestions: FieldSuggestion[] = [];
  for (const row of waiting) {
    const decision = served.decisions.get(row.decision);
    if (!decision || row.probability === null) continue;
    const say = await answerLabels(reader, schema, read.table, row.field, [row.answer]);
    suggestions.push({
      id: row.id,
      decision: row.decision,
      field: row.field,
      command: decision.answer.command.id,
      answer: row.answer,
      label: say(row.answer),
      probability: row.probability,
      filled: !isEmpty(read.row[row.field]),
      at: row.outcomeAt || row.createdAt,
    });
  }
  return { suggestions };
}

async function listMarks(
  served: ServedDecisions,
  owner: DecisionOwner,
  reader: Adapter,
  schema: DatabaseSchema,
  tableId: unknown,
  rawKeys: unknown,
): Promise<{ marks: DecisionMark[] }> {
  if (typeof tableId !== 'string' || !Array.isArray(rawKeys) || rawKeys.length > MARKS_MOST) throw new AppAccessDenied();
  const table = findTable(schema, tableId);
  if (!table || !rawKeys.length) return { marks: [] };
  const fields = decidedFields(served, table);
  if (!fields.size) return { marks: [] };
  const keys = rawKeys.map((raw) => exactKey(schema, tableId, raw));
  const texts = new Map(keys.map((key) => [recordKeyText(key), key]));
  const places = new Map<string, number>();
  keys.forEach((key, index) => {
    const text = recordKeyText(key);
    if (!places.has(text)) places.set(text, index);
  });
  const rows = (await served.store.waiting(owner, tableId, [...texts.keys()])).filter(
    (row) => fields.has(row.field) && served.decisions.has(row.decision),
  );
  if (!rows.length) return { marks: [] };
  // Only the rows this reader sees, with their decided fields as they are now: a field filled since shows no mark.
  const asked = [...new Set(rows.map((row) => row.recordKey))].map((text) => texts.get(text)!);
  const visible = await reader.query({
    table: tableId,
    columns: [...new Set([...Object.keys(asked[0]), ...fields.keys()])],
    limit: asked.length,
    offset: 0,
    filter: { groups: asked.map((key) => Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))) },
  });
  const now = new Map(
    (visible.rows as Array<Record<string, unknown>>).map((row) => [
      recordKeyText(Object.fromEntries(Object.keys(asked[0]).map((column) => [column, row[column] as string | number]))),
      row,
    ]),
  );
  const marks: DecisionMark[] = [];
  for (const row of rows) {
    const current = now.get(row.recordKey);
    if (!current || !isEmpty(current[row.field])) continue;
    const say = await answerLabels(reader, schema, table, row.field, [row.answer]);
    marks.push({ row: places.get(row.recordKey)!, field: row.field, label: say(row.answer) });
  }
  return { marks };
}

async function why(
  app: AppDef,
  served: ServedDecisions,
  reader: Adapter,
  schema: DatabaseSchema,
  row: StoredDecision,
  key: Record<string, string | number>,
): Promise<DecisionWhy> {
  const decision = served.decisions.get(row.decision);
  const table = findTable(schema, row.resource)!;
  const readable = new Set(table.columns.map((column) => column.name));
  const names = decision?.inputs ?? row.inputFields;
  // A path or a rollup is named, not read here: its value is its own table's, under that table's grants.
  const own = names.filter((name) => !name.includes('.') && readable.has(name));
  const read = own.length ? await readFor(served, reader, schema, row.resource, key, own) : undefined;
  const caption = (name: string) =>
    name.includes('.')
      ? humanName(name.split('.').pop() ?? name)
      : (columnCaption(app.resources ?? {}, schema, row.resource, name) ?? humanName(name));
  return {
    decision: row.decision,
    question: decision?.question ?? '',
    inputs: names.map((name) =>
      read && own.includes(name)
        ? { name, label: caption(name), value: read.row[name] ?? null, readable: true }
        : { name, label: caption(name), readable: false },
    ),
    provider: row.provider,
    model: row.model,
    modelVersion: row.modelVersion,
    probability: row.probability,
    outcome: row.outcome,
    at: row.createdAt,
  };
}
