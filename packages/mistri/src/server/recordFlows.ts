/**
 * One record's flow runs, for the reader asking, and a person's
 * start of a manual flow on it. The rule is the record history's: the record
 * must be one the reader's own read returns, so a record they cannot see has
 * no runs for them. A run is told by its state and its steps' names and
 * moments (workflows/flowRuns.ts); a flow and a step are named by their rows,
 * read as the reader reads them — a reader who may not read the flows is
 * told "Flow 2" and "Step 3", not their names.
 *
 * A manual flow is started by an operator of the App's workflows (a role
 * with `operations: ['workflows']`): the same people who cancel and retry
 * runs. The start is a request: the runner's dispatch decides, against the
 * record as it is then, whether the flow starts.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import { historyKey } from '../adapters/history/recordHistory.js';
import { WORKFLOW_OPERATOR } from '../adapters/workflows/workflowStoreTypes.js';
import { appOperationsGrants, type AppDef } from '../shared/app.js';
import { flowActive } from '../shared/appFlows.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { AppAccessDenied } from './app/appAccess.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import { exactKey, type RecordHistoryStoreKey } from './recordHistory.js';
import type { FlowRunsAccess } from './workflows/flowRuns.js';

/** What a step of a run did, by the engine's name for it (flowRunner.ts). */
const DOING: Readonly<Record<string, string>> = Object.freeze({
  load: 'Read the flow',
  set: 'Set a field',
  wait: 'Wait',
  date: 'Read the date',
  until: 'Wait until the date',
  check: 'Check the condition',
  run: 'Run the step',
  event: 'Wait for the event',
  remind: 'Send a reminder',
  tell: 'Tell',
});

interface RecordFlowsReply {
  readonly running: boolean;
  readonly runs: readonly Readonly<{
    id: string;
    flow: string;
    name: string;
    state: string;
    waitingFor: string | null;
    wakeAt: string | null;
    problem: string | null;
    startedAt: string;
    updatedAt: string;
    /* A step's place in its flow, where its name has one: the position, and its lane where several share it. */
    steps: readonly Readonly<{ label: string; status: string; at: string; position?: number; member?: number }>[];
  }>[];
  /** The manual flows this reader may start on the record. */
  readonly manual: readonly Readonly<{ id: string; name: string }>[];
}

interface Options {
  app: AppDef;
  reader: Adapter;
  schema: DatabaseSchema;
  runs: FlowRunsAccess | undefined;
  table: unknown;
  key: unknown;
  roles: readonly string[];
  /** A tenant App's (tenant/tenantHttp.ts): the record's history key with its owner, as its history is read
   * (tenantRecordHistoryStore.ts), and the tenant whose runs those are — the owner that key names. */
  tenancy?: Readonly<{ storeKey: RecordHistoryStoreKey; tenantOf: (table: string, stored: Readonly<Record<string, unknown>>) => string }>;
}

/** The record, read as the reader reads it: its stored key, its key's value and, on a tenant App, its tenant; or AppAccessDenied. */
async function visibleRecord(options: Options) {
  const { app, reader, schema, tenancy } = options;
  if (typeof options.table !== 'string' || !app.resources?.[options.table]?.flows || !findTable(schema, options.table))
    throw new AppAccessDenied();
  const table = options.table;
  const columns = primaryKey(findTable(schema, table)!);
  if (columns.length !== 1) throw new AppAccessDenied();
  const key = exactKey(schema, table, options.key);
  const visible = await reader.query({
    table,
    columns: [...new Set([...Object.keys(key), ...(tenancy?.storeKey.read(table) ?? [])])],
    limit: 1,
    offset: 0,
    filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
  });
  if (visible.rows.length !== 1) throw new AppAccessDenied();
  const stored = tenancy ? tenancy.storeKey.key(table, key, visible.rows[0]) : key;
  return {
    table,
    binding: app.resources[table].flows!,
    record: historyKey(stored),
    target: String(key[columns[0]]),
    tenantId: tenancy?.tenantOf(table, stored),
  };
}

/** The rows of a table the reader may read, or none: a name is a courtesy, never a reason to refuse. */
async function readable(
  reader: Adapter,
  schema: DatabaseSchema,
  table: string,
  wanted: readonly string[],
): Promise<Record<string, unknown>[]> {
  const meta = findTable(schema, table);
  if (!meta) return [];
  const columns = wanted.filter((column) => meta.columns.some((each) => each.name === column));
  try {
    return (await reader.query({ table, columns, limit: 200, offset: 0 })).rows as Record<string, unknown>[];
  } catch {
    return [];
  }
}

const canStart = (app: AppDef, roles: readonly string[]) => appOperationsGrants(app, roles).has('workflows');

export async function readRecordFlowsFor(options: Options): Promise<RecordFlowsReply> {
  const { binding, table, record, tenantId } = await visibleRecord(options);
  if (!options.runs?.runs(table)) return { running: false, runs: [], manual: [] };
  const runs = await options.runs.of(table, record, tenantId);
  const flows = await readable(options.reader, options.schema, binding.from, ['id', 'name', 'start', 'active']);
  const steps = runs.length ? await readable(options.reader, options.schema, binding.steps, ['id', 'flow_id', 'position', 'title']) : [];
  const nameOf = (flow: string) => {
    const row = flows.find((each) => String(each.id) === flow);
    return typeof row?.name === 'string' && row.name ? row.name : `Flow ${flow}`;
  };
  /* A step's name is its kind and its position (flowRunner.ts): `run[3]`, one of several at a position `run[3.2]`, a
     wait's later round or a reminder `event[3-1]`. Several at one position are ordered as the plan orders them. */
  const parse = (name: string) => /^([a-z]+)(?:\[(\d+)(?:\.(\d+))?(?:-\d+)?\])?$/.exec(name) ?? [];
  const label = (flow: string, name: string) => {
    const [, kind, position, member] = parse(name);
    if (!kind) return name;
    if (position === undefined) return DOING[kind] ?? kind;
    const rows = steps
      .filter((each) => String(each.flow_id) === flow && String(each.position) === position)
      .sort((a, b) => String(a.id ?? '').localeCompare(String(b.id ?? '')));
    const row = rows[member === undefined ? 0 : Number(member) - 1];
    const title = typeof row?.title === 'string' && row.title.trim() ? row.title.trim() : (DOING[kind] ?? kind);
    return `${position}. ${kind === 'remind' ? `${title}: ${DOING.remind.toLowerCase()}` : title}`;
  };
  return {
    running: true,
    runs: runs.map((run) => ({
      id: run.id,
      flow: run.flow,
      name: nameOf(run.flow),
      state: run.state,
      waitingFor: run.waitingFor,
      wakeAt: run.wakeAt,
      problem: run.problem,
      startedAt: run.startedAt,
      updatedAt: run.updatedAt,
      // A wait's reading of the clock (`clock[3-1]`) is the runner's bookkeeping, not a step a person took.
      steps: run.steps
        .filter((step) => !step.name.startsWith('clock['))
        .map((step) => {
          // Where it stands in the flow, so a diagram of the run can say which of its steps are done (PageFlowDiagram.tsx).
          const [, , position, member] = parse(step.name);
          return {
            label: label(run.flow, step.name),
            status: step.status,
            at: step.at,
            ...(position === undefined ? {} : { position: Number(position) }),
            ...(member === undefined ? {} : { member: Number(member) }),
          };
        }),
    })),
    manual: canStart(options.app, options.roles)
      ? flows
          .filter((row) => row.start === 'manual' && flowActive(row))
          .map((row) => ({ id: String(row.id), name: nameOf(String(row.id)) }))
      : [],
  };
}

/** Start a manual flow on the record, for an operator of the App's workflows. */
export async function startRecordFlowFor(options: Options & { flow: unknown; operator: string | undefined }): Promise<{ ok: true }> {
  if (!canStart(options.app, options.roles) || !options.operator || !WORKFLOW_OPERATOR.test(options.operator)) throw new AppAccessDenied();
  const { binding, table, record, target, tenantId } = await visibleRecord(options);
  if (typeof options.flow !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(options.flow)) throw new HttpError(400, 'Name the flow to start.');
  if (!options.runs?.runs(table)) throw new HttpError(409, 'Flows run on a server started with --jobs.');
  const flows = await readable(options.reader, options.schema, binding.from, ['id', 'start', 'active']);
  const flow = flows.find((row) => String(row.id) === options.flow);
  if (!flow || flow.start !== 'manual' || !flowActive(flow)) throw new HttpError(409, 'That flow is not one to start by hand.');
  await options.runs.start(table, { record, target, flow: options.flow }, options.operator, tenantId);
  return { ok: true };
}
