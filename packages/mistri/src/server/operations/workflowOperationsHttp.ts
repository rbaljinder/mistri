/**
 * The durable workflows room's routes, beside the readiness and
 * support reads and gated the same way: only a verified session whose server
 * roles carry `operations: ['workflows']` is answered.
 *
 *   GET  /api/operations/workflows[?state=&workflow=&after=&limit=]  the instances
 *   GET  /api/operations/workflows/steps?id=                         one instance's history: its steps, and who cancelled or retried it
 *   POST /api/operations/workflows/cancel   { id }
 *   POST /api/operations/workflows/retry    { id }
 *
 * Nothing carries a payload, a step's result or an error's text (a workflow_error
 * keeps the error's name and code alone, as problemError): the store's
 * inspection shape is already free of them, and times go out as ISO strings.
 * A refusal is its bare code and the caller is never echoed.
 */
import { appOperationsGrants, type AppDef } from '../../shared/app.js';
import {
  WORKFLOW_ID,
  WORKFLOW_STATES,
  WorkflowRefusal,
  type WorkflowInspection,
  type WorkflowState,
  type WorkflowStepInspection,
} from '../../adapters/workflows/workflowStoreTypes.js';
import type { WorkflowOperator } from '../workflows/workflowOperator.js';

type WorkflowOperationsRoute = 'list' | 'steps' | 'cancel' | 'retry';
const ROUTES: Readonly<Record<string, WorkflowOperationsRoute>> = Object.freeze({
  '/api/operations/workflows': 'list',
  '/api/operations/workflows/steps': 'steps',
  '/api/operations/workflows/cancel': 'cancel',
  '/api/operations/workflows/retry': 'retry',
});
export function workflowOperationsRoute(path: string): WorkflowOperationsRoute | undefined {
  return Object.hasOwn(ROUTES, path) ? ROUTES[path] : undefined;
}

/** The most one page holds. */
export const WORKFLOW_PAGE = 50;
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,59}$/;

const iso = (at: number | null): string | null => (at === null ? null : new Date(at).toISOString());
function instanceOut(row: WorkflowInspection) {
  return {
    id: row.id,
    workflow: row.workflow,
    version: row.version,
    key: row.key,
    state: row.state,
    currentStep: row.currentStep,
    waitEvent: row.waitEvent,
    wakeAt: iso(row.wakeAt),
    problem: row.problem,
    problemStep: row.problemStep,
    ...(row.problemError ? { problemError: row.problemError } : {}),
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}
const stepOut = (row: WorkflowStepInspection) => ({
  name: row.name,
  ordinal: row.ordinal,
  kind: row.kind,
  status: row.status,
  attempts: row.attempts,
  wakeAt: iso(row.wakeAt),
  errorCode: row.errorCode,
  createdAt: iso(row.createdAt),
  updatedAt: iso(row.updatedAt),
});

interface WorkflowOperationsReply {
  readonly status: number;
  readonly body: Record<string, unknown>;
}
const refused = (status: number, error: string): WorkflowOperationsReply => ({ status, body: { ok: false, error } });

/**
 * One request, for one verified actor. `query` is the URL's parameters and
 * `body` the parsed JSON of a POST; each is read only for the route that
 * takes it.
 */
export async function workflowOperationsReply(
  options: Readonly<{
    app: AppDef;
    route: WorkflowOperationsRoute;
    method: string;
    actor: Readonly<{ id: string; roles: readonly string[] }>;
    operator: WorkflowOperator | undefined;
    query: URLSearchParams;
    body: Record<string, unknown>;
  }>,
): Promise<WorkflowOperationsReply> {
  if (!appOperationsGrants(options.app, options.actor.roles).has('workflows')) return refused(403, 'not_authorized');
  const operator = options.operator;
  if (!operator) return refused(404, 'unavailable');
  const reading = options.route === 'list' || options.route === 'steps';
  if (options.method !== (reading ? 'GET' : 'POST') && !(reading && options.method === 'HEAD')) return refused(405, 'invalid_request');
  try {
    if (options.route === 'list') {
      const state = options.query.get('state') ?? undefined,
        workflow = options.query.get('workflow') ?? undefined,
        after = options.query.get('after') ?? undefined;
      const asked = options.query.get('limit');
      const limit = asked === null ? WORKFLOW_PAGE : Number(asked);
      if (
        (state !== undefined && !WORKFLOW_STATES.includes(state as WorkflowState)) ||
        (workflow !== undefined && !NAME.test(workflow)) ||
        (after !== undefined && !WORKFLOW_ID.test(after)) ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > WORKFLOW_PAGE
      )
        return refused(400, 'invalid_request');
      const rows = await operator.list(
        { ...(state ? { state: state as WorkflowState } : {}), ...(workflow ? { workflow } : {}), ...(after ? { after } : {}) },
        limit,
      );
      return {
        status: 200,
        body: { ok: true, instances: rows.map(instanceOut), ...(rows.length === limit ? { after: rows.at(-1)!.id } : {}) },
      };
    }
    const id = options.route === 'steps' ? options.query.get('id') : options.body.id;
    if (typeof id !== 'string' || !WORKFLOW_ID.test(id)) return refused(400, 'invalid_request');
    if (options.route === 'steps') {
      // One after the other: a SQLite store runs one transaction at a time.
      const steps = await operator.steps(id),
        actions = await operator.actions(id);
      return {
        status: 200,
        body: {
          ok: true,
          steps: steps.map(stepOut),
          actions: actions.map((row) => ({ action: row.action, operator: row.operator, at: iso(row.at) })),
        },
      };
    }
    if (options.route === 'cancel') {
      const result = await operator.cancel(id, options.actor.id);
      return { status: 200, body: { ok: true, outcome: result.outcome, state: result.state } };
    }
    return { status: 200, body: { ok: true, instance: instanceOut(await operator.retry(id, options.actor.id)) } };
  } catch (error) {
    if (error instanceof WorkflowRefusal)
      return refused(error.code === 'not_found' ? 404 : error.code === 'not_retryable' ? 409 : 400, error.code);
    return refused(503, 'unavailable');
  }
}
