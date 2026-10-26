/**
 * The Console's Operations and Analytics rooms: each App's jobs,
 * deliveries, workflows and store layouts, and its analytics, behind the
 * Console's own transport.
 *
 * Authority is the App's, never the Console's. Each request asks the App's
 * own session projection who the caller is there and which `operations`
 * words that App's roles grant (the same vocabulary as the App host's
 * `operations: ['workflows']`), so one App's grant never reaches another
 * App's queues: the App is named in the path and answered only for its own
 * grant. A write is judged twice, before its body is read and again after,
 * and its store records the account as the operator. A refusal is a code;
 * nothing here carries an input, payload, result, error text, unit id or
 * database address.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { appOperationsGrants, type AppDef, type OperationsGrantAction } from '../../shared/app.js';
import {
  EVENT_DELIVERY_STATES,
  EventDeliveryRefusal,
  type EventDeliveryInspection,
  type EventDeliveryState,
} from '../../adapters/events/eventDeliveryTypes.js';
import { JOB_STATES, JobRefusal, type JobInspection, type JobState } from '../../adapters/jobs/jobStoreTypes.js';
import { captureAppAuthRuntime, type AppAuthRuntime } from '../auth/auth.js';
import type { DeliveryQueueOperator, JobQueueOperator } from '../operations/queueOperator.js';
import { workflowOperationsReply } from '../operations/workflowOperationsHttp.js';
import type { WorkflowOperator } from '../workflows/workflowOperator.js';
import type { WorkflowState } from '../../adapters/workflows/workflowStoreTypes.js';
import type { AnalyticsStore } from '../analytics/store.js';
import { analyticsReport, analyticsTotals, ANALYTICS_REPORT_DAYS } from '../analytics/report.js';
import { HttpError, readJson, send } from '@mistriwork/engine/server/http/reply.js';
import type { ConsoleGovernance } from './governance.js';

/** One store layout's status in one of the App's databases (`mistri migrate stores status`). */
interface ConsoleStoreStatus {
  /** The connection's name, or `analytics`: never its address. */
  readonly database: string;
  readonly dialect: string;
  readonly id: string;
  readonly title: string;
  readonly found: number | null;
  readonly current: number;
  readonly pending: readonly number[];
  readonly refused?: string;
}

/** One App's operations, as its host holds them. Absent parts are rooms the App does not have. */
export interface ConsoleOperationsOwner {
  readonly appId: string;
  readonly name: string;
  /** The App served now: its grants are read at every request. */
  readonly app: () => AppDef;
  /** The App's own projection of the suite session. */
  readonly auth: AppAuthRuntime;
  readonly jobs?: JobQueueOperator;
  readonly deliveries?: readonly DeliveryQueueOperator[];
  readonly workflows?: WorkflowOperator;
  readonly stores?: () => Promise<readonly ConsoleStoreStatus[]>;
  readonly analytics?: () => AnalyticsStore | undefined;
  /** The Governance room: its audit, authority and accounts, for the App's own administrators (governance.ts). */
  readonly governance?: ConsoleGovernance;
}

type Section = 'jobs' | 'deliveries' | 'workflows' | 'stores';
const SECTIONS: readonly Section[] = ['jobs', 'deliveries', 'workflows', 'stores'];
const PAGE = 50;
const KEY = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const DESTINATION = /^(?:job|workflow|webhook):[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;
/** What the room's filter asks for: a group of states, so "needs attention" is one question rather than three. */
type Group = 'attention' | 'scheduled' | 'done';
const GROUP_STATES: Record<'jobs' | 'deliveries' | 'workflows', Record<Group, readonly string[]>> = {
  jobs: { attention: ['failed', 'unknown', 'retry'], scheduled: ['scheduled', 'leased'], done: ['succeeded', 'cancelled'] },
  deliveries: { attention: ['failed', 'unknown', 'retry'], scheduled: ['pending', 'leased'], done: ['delivered'] },
  workflows: { attention: ['failed', 'diverged'], scheduled: ['running', 'waiting'], done: ['completed', 'cancelled'] },
};
const isGroup = (value: string | null): value is Group => value === 'attention' || value === 'scheduled' || value === 'done';
/** How many rows of one state, counted up to a page: past it the room says "50+", and nothing heavier is asked of a store. */
async function counted(list: (state: string) => Promise<readonly unknown[]>, state: string): Promise<{ count: number; capped: boolean }> {
  const rows = await list(state);
  return { count: rows.length, capped: rows.length >= PAGE };
}

const iso = (at: number | null) => (at === null ? null : new Date(at).toISOString());
const refuse = (response: ServerResponse, status: number, code: string) => {
  send(response, status, { ok: false, code });
  return true;
};

/** Who the caller is in this App, and what its roles there grant. An App without auth grants nothing. */
export async function grantsIn(
  owner: Pick<ConsoleOperationsOwner, 'auth' | 'app'>,
  request: IncomingMessage,
  accountId: string,
): Promise<{ roles: readonly string[]; grants: ReadonlySet<OperationsGrantAction> }> {
  const none = { roles: [], grants: new Set<OperationsGrantAction>() };
  let proof;
  try {
    proof = await captureAppAuthRuntime(owner.auth).sessionInstance(request);
  } catch {
    return none;
  }
  if (!proof || proof.identity.id !== accountId) return none;
  const roles = (proof.identity.role ?? '')
    .split(',')
    .map((role) => role.trim())
    .filter(Boolean);
  return { roles, grants: appOperationsGrants(owner.app(), roles) };
}
const available = (owner: ConsoleOperationsOwner, section: Section) =>
  section === 'jobs'
    ? Boolean(owner.jobs)
    : section === 'deliveries'
      ? Boolean(owner.deliveries?.length)
      : section === 'workflows'
        ? Boolean(owner.workflows)
        : Boolean(owner.stores);

function single(url: URL, allowed: readonly string[]): boolean {
  return [...url.searchParams.keys()].every((key) => allowed.includes(key) && url.searchParams.getAll(key).length === 1);
}

/** The `[from, to)` a report reads: whole UTC days, the last thirty unless asked. */
function reportWindow(url: URL): { fromMs: number; toMs: number } | undefined {
  const from = url.searchParams.get('from'),
    to = url.searchParams.get('to');
  const today = Math.floor(Date.now() / DAY) * DAY;
  const day = (text: string | null) =>
    text === null ? undefined : DATE.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) ? Date.parse(`${text}T00:00:00Z`) : NaN;
  const toDay = day(to),
    fromDay = day(from);
  if (Number.isNaN(toDay) || Number.isNaN(fromDay)) return undefined;
  const toMs = (toDay ?? today) + DAY,
    fromMs = fromDay ?? toMs - 30 * DAY;
  return fromMs < toMs && toMs - fromMs <= ANALYTICS_REPORT_DAYS * DAY ? { fromMs, toMs } : undefined;
}

/**
 * Answer one `/api/console/operations…` or `/api/console/analytics…` request;
 * false for any other path. `acknowledged` is called once a write has
 * committed, so a later failure is reported as an unknown outcome.
 */
export async function consoleOperationsApi(
  input: Readonly<{
    request: IncomingMessage;
    response: ServerResponse;
    url: URL;
    path: string;
    accountId: string;
    owners: readonly ConsoleOperationsOwner[];
    acknowledged: () => void;
  }>,
): Promise<boolean> {
  const { request, response, url, accountId, owners } = input;
  const match =
    /^\/(operations|analytics)(?:\/([A-Za-z0-9_-]{1,64})(?:\/(jobs|deliveries|workflows|stores|summary)(?:\/(attempts|redrive|steps|cancel|retry))?)?)?$/.exec(
      input.path,
    );
  if (!match) return false;
  const [, room, appId, section, verb] = match;
  const method = request.method ?? 'GET',
    reading = method === 'GET' || method === 'HEAD';

  if (!appId) {
    if (!reading) return refuse(response, 405, 'invalid_request');
    if (!single(url, [])) return refuse(response, 400, 'invalid_request');
    const apps = [];
    for (const owner of owners) {
      const { grants } = await grantsIn(owner, request, accountId);
      if (room === 'analytics') {
        if (grants.has('analytics') && owner.analytics) {
          apps.push({ id: owner.appId, name: owner.name, funnels: Object.keys(owner.app().analytics?.funnels ?? {}) });
        }
        continue;
      }
      const sections = SECTIONS.filter((name) => grants.has(name) && available(owner, name));
      if (sections.length)
        apps.push({
          id: owner.appId,
          name: owner.name,
          sections,
          ...(sections.includes('deliveries')
            ? { destinations: owner.deliveries!.map((item) => ({ id: item.id, kind: item.kind, name: item.name })) }
            : {}),
        });
    }
    send(response, 200, { ok: true, apps });
    return true;
  }

  const owner = owners.find((item) => item.appId === appId);
  // An App this Console does not serve and one the caller holds no grant in are told alike.
  const asked: OperationsGrantAction = room === 'analytics' ? 'analytics' : ((section ?? 'jobs') as Section);
  if (room === 'analytics' ? section !== undefined : section === undefined) return refuse(response, 404, 'not_found');
  if (!owner) return refuse(response, 403, 'not_granted');
  const first = await grantsIn(owner, request, accountId);
  if (section === 'summary') {
    if (verb !== undefined) return refuse(response, 404, 'not_found');
    if (!reading) return refuse(response, 405, 'invalid_request');
    if (!single(url, [])) return refuse(response, 400, 'invalid_request');
    const granted = SECTIONS.filter((name) => first.grants.has(name) && available(owner, name));
    if (!granted.length) return refuse(response, 403, 'not_granted');
    try {
      send(response, 200, { ok: true, sections: await summary(owner, granted) });
    } catch {
      return refuse(response, 503, 'unavailable');
    }
    return true;
  }
  if (!first.grants.has(asked)) return refuse(response, 403, 'not_granted');

  if (room === 'analytics') {
    const store = owner.analytics?.();
    if (!store) return refuse(response, 404, 'unavailable');
    if (!reading) return refuse(response, 405, 'invalid_request');
    const window = single(url, ['from', 'to', 'kind', 'name']) ? reportWindow(url) : undefined;
    // One event the chart and totals follow: both of its words or neither, each a short name, never a pattern.
    const kind = url.searchParams.get('kind'),
      name = url.searchParams.get('name');
    const only = kind !== null && name !== null && kind.length <= 64 && name.length <= 200 ? { kind, name } : undefined;
    if (!window || (kind === null) !== (name === null) || (kind !== null && !only)) return refuse(response, 400, 'invalid_request');
    try {
      const report = await analyticsReport(store, owner.app().analytics ?? {}, window, only);
      // The equal period before the window, for each tile's change and each name's trend; none where it would start before the epoch.
      const span = window.toMs - window.fromMs,
        current = await analyticsTotals(store, window, [], only);
      const previous =
        window.fromMs - span >= 0
          ? await analyticsTotals(store, { fromMs: window.fromMs - span, toMs: window.fromMs }, report.names, only)
          : undefined;
      send(response, 200, {
        ok: true,
        ...report,
        from: iso(report.fromMs),
        to: iso(report.toMs),
        units: current.units,
        ...(only ? { only } : {}),
        ...(previous
          ? {
              previous: {
                from: iso(window.fromMs - span),
                tracked: previous.tracked,
                business: previous.business,
                units: previous.units,
                names: previous.names,
              },
            }
          : {}),
      });
    } catch {
      return refuse(response, 503, 'unavailable');
    }
    return true;
  }
  if (!available(owner, section as Section)) return refuse(response, 404, 'unavailable');

  const writes = verb === 'redrive' || verb === 'cancel' || verb === 'retry';
  if (writes ? method !== 'POST' : !reading) return refuse(response, 405, 'invalid_request');
  if (writes && request.headers['x-mistri-account'] !== accountId) return refuse(response, 409, 'account_changed');
  let body: Record<string, unknown> = {};
  if (writes) {
    try {
      body = (await readJson(request, 4_096)) as Record<string, unknown>;
    } catch (error) {
      if (error instanceof HttpError) return refuse(response, 400, 'invalid_request');
      throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return refuse(response, 400, 'invalid_request');
    // The grant is asked again once the body has arrived: a revoked role does not act on a held request.
    const again = await grantsIn(owner, request, accountId);
    if (!again.grants.has(asked)) return refuse(response, 403, 'not_granted');
  }

  if (section === 'workflows') {
    const group = url.searchParams.get('group');
    if (verb === undefined && group !== null) {
      // A group is its states asked one after another, each through the same reply, and merged newest first.
      if (!single(url, ['group']) || !isGroup(group)) return refuse(response, 400, 'invalid_request');
      const instances: { updatedAt: string | null }[] = [];
      for (const state of GROUP_STATES.workflows[group]) {
        const reply = await workflowOperationsReply({
          app: owner.app(),
          route: 'list',
          method,
          actor: { id: accountId, roles: first.roles },
          operator: owner.workflows,
          query: new URLSearchParams({ state }),
          body,
        });
        if (reply.status !== 200) {
          send(response, reply.status, reply.body);
          return true;
        }
        instances.push(...(reply.body.instances as { updatedAt: string | null }[]));
      }
      instances.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
      send(response, 200, { ok: true, instances: instances.slice(0, PAGE) });
      return true;
    }
    const route = verb === undefined ? 'list' : (verb as 'steps' | 'cancel' | 'retry');
    if (verb !== undefined && !['steps', 'cancel', 'retry'].includes(verb)) return refuse(response, 404, 'not_found');
    const reply = await workflowOperationsReply({
      app: owner.app(),
      route,
      method,
      actor: { id: accountId, roles: first.roles },
      operator: owner.workflows,
      query: url.searchParams,
      body,
    });
    if (writes && reply.status === 200) input.acknowledged();
    send(response, reply.status, reply.body);
    return true;
  }

  if (section === 'stores') {
    if (verb !== undefined || !single(url, [])) return refuse(response, 400, 'invalid_request');
    try {
      send(response, 200, { ok: true, stores: await owner.stores!() });
    } catch {
      return refuse(response, 503, 'unavailable');
    }
    return true;
  }

  try {
    if (section === 'jobs') {
      const jobs = owner.jobs!;
      if (verb === undefined) {
        if (!single(url, ['state', 'after', 'group'])) return refuse(response, 400, 'invalid_request');
        const state = url.searchParams.get('state') ?? undefined,
          after = url.searchParams.get('after') ?? undefined,
          group = url.searchParams.get('group');
        if (
          (state !== undefined && !JOB_STATES.includes(state as JobState)) ||
          (after !== undefined && !KEY.test(after)) ||
          (group !== null && (!isGroup(group) || state !== undefined || after !== undefined))
        )
          return refuse(response, 400, 'invalid_request');
        let rows: readonly JobInspection[];
        if (isGroup(group)) {
          const merged: JobInspection[] = [];
          for (const one of GROUP_STATES.jobs[group]) merged.push(...(await jobs.list({ state: one as JobState }, PAGE)));
          rows = merged.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, PAGE);
        } else rows = await jobs.list({ ...(state ? { state: state as JobState } : {}), ...(after ? { after } : {}) }, PAGE);
        send(response, 200, {
          ok: true,
          jobs: rows.map((row) => ({
            id: row.id,
            job: row.job,
            version: row.version,
            state: row.state,
            attempts: row.attempts,
            maxAttempts: row.maxAttempts,
            redrives: row.redrives,
            runAt: iso(row.runAt),
            leaseUntil: iso(row.leaseUntil),
            lastCode: row.lastCode,
            createdAt: iso(row.createdAt),
            updatedAt: iso(row.updatedAt),
          })),
          ...(rows.length === PAGE && !group ? { after: rows.at(-1)!.id } : {}),
        });
        return true;
      }
      if (verb === 'attempts') {
        const id = url.searchParams.get('id');
        if (!single(url, ['id']) || id === null || !KEY.test(id)) return refuse(response, 400, 'invalid_request');
        const rows = await jobs.attempts(id);
        send(response, 200, {
          ok: true,
          attempts: rows.map((row) => ({
            attempt: row.attempt,
            startedAt: iso(row.startedAt),
            outcome: row.outcome,
            code: row.code,
            finishedAt: iso(row.finishedAt),
            operator: row.operator,
          })),
        });
        return true;
      }
      if (verb !== 'redrive' || typeof body.id !== 'string' || !KEY.test(body.id) || Object.keys(body).length !== 1)
        return refuse(response, 400, 'invalid_request');
      const row = await jobs.redrive(body.id, accountId);
      input.acknowledged();
      send(response, 200, { ok: true, job: { id: row.id, state: row.state, redrives: row.redrives } });
      return true;
    }
    const destinations = owner.deliveries!;
    if (verb === undefined) {
      if (!single(url, ['destination', 'state', 'after', 'group'])) return refuse(response, 400, 'invalid_request');
      const destination = destinations.find((item) => item.id === url.searchParams.get('destination'));
      const state = url.searchParams.get('state') ?? undefined,
        after = url.searchParams.get('after') ?? undefined,
        group = url.searchParams.get('group');
      if (
        !destination ||
        (state !== undefined && !EVENT_DELIVERY_STATES.includes(state as EventDeliveryState)) ||
        (after !== undefined && !KEY.test(after)) ||
        (group !== null && (!isGroup(group) || state !== undefined || after !== undefined))
      )
        return refuse(response, 400, 'invalid_request');
      let rows: readonly EventDeliveryInspection[];
      if (isGroup(group)) {
        const merged: EventDeliveryInspection[] = [];
        for (const one of GROUP_STATES.deliveries[group])
          merged.push(...(await destination.list({ state: one as EventDeliveryState }, PAGE)));
        rows = merged.sort((a, b) => b.nextAt - a.nextAt).slice(0, PAGE);
      } else rows = await destination.list({ ...(state ? { state: state as EventDeliveryState } : {}), ...(after ? { after } : {}) }, PAGE);
      send(response, 200, {
        ok: true,
        deliveries: rows.map((row) => ({
          eventId: row.eventId,
          ordinal: row.ordinal,
          state: row.state,
          attempts: row.attempts,
          maxAttempts: row.maxAttempts,
          redrives: row.redrives,
          nextAt: iso(row.nextAt),
          leaseUntil: iso(row.leaseUntil),
          lastCode: row.lastCode,
        })),
        ...(rows.length === PAGE && !group ? { after: rows.at(-1)!.eventId } : {}),
      });
      return true;
    }
    if (verb === 'attempts') {
      const id = url.searchParams.get('id'),
        destination = destinations.find((item) => item.id === url.searchParams.get('destination'));
      if (!single(url, ['destination', 'id']) || !destination || id === null || !KEY.test(id))
        return refuse(response, 400, 'invalid_request');
      const rows = await destination.attempts(id);
      send(response, 200, {
        ok: true,
        attempts: rows.map((row) => ({
          attempt: row.attempt,
          startedAt: iso(row.startedAt),
          outcome: row.outcome,
          code: row.code,
          finishedAt: iso(row.finishedAt),
          operator: row.operator,
        })),
      });
      return true;
    }
    const destination =
      typeof body.destination === 'string' && DESTINATION.test(body.destination)
        ? destinations.find((item) => item.id === body.destination)
        : undefined;
    if (verb !== 'redrive' || !destination || typeof body.id !== 'string' || !KEY.test(body.id) || Object.keys(body).length !== 2)
      return refuse(response, 400, 'invalid_request');
    const row = await destination.redrive(body.id, accountId);
    input.acknowledged();
    send(response, 200, { ok: true, delivery: { eventId: row.eventId, state: row.state, redrives: row.redrives } });
    return true;
  } catch (error) {
    if (error instanceof JobRefusal || error instanceof EventDeliveryRefusal) {
      const code = error.code;
      return refuse(
        response,
        code === 'job_not_found' || code === 'not_found'
          ? 404
          : code === 'not_redrivable' || code === 'redrive_limit' || code === 'lease_held'
            ? 409
            : 400,
        code === 'job_not_found' ? 'not_found' : code,
      );
    }
    return refuse(response, 503, 'unavailable');
  }
}

/**
 * The health strip: per granted section, how many rows need attention, how
 * many are waiting their turn, and how much finished lately. Each state is
 * counted up to one page, so a busy queue costs the same question as a quiet
 * one; a count at the page says so (`capped`). Counts only, never a row.
 */
async function summary(owner: ConsoleOperationsOwner, sections: readonly Section[]) {
  const out: Record<string, unknown> = {};
  const since = Date.now() - DAY;
  for (const section of sections) {
    if (section === 'jobs') {
      const list = (state: string) => owner.jobs!.list({ state: state as JobState }, PAGE);
      const failed = await counted(list, 'failed'),
        unknown = await counted(list, 'unknown'),
        retry = await counted(list, 'retry');
      const scheduled = await counted(list, 'scheduled'),
        leased = await counted(list, 'leased');
      const succeeded = await list('succeeded');
      out.jobs = {
        dead: failed.count + unknown.count,
        retrying: retry.count,
        scheduled: scheduled.count + leased.count,
        recent: succeeded.filter((row) => row.updatedAt >= since).length,
        capped: [failed, unknown, retry, scheduled, leased].some((entry) => entry.capped) || succeeded.length >= PAGE,
      };
    } else if (section === 'deliveries') {
      const totals = { dead: 0, retrying: 0, scheduled: 0, delivered: 0, capped: false };
      for (const destination of owner.deliveries!) {
        const list = (state: string) => destination.list({ state: state as EventDeliveryState }, PAGE);
        for (const [state, into] of [
          ['failed', 'dead'],
          ['unknown', 'dead'],
          ['retry', 'retrying'],
          ['pending', 'scheduled'],
          ['leased', 'scheduled'],
          ['delivered', 'delivered'],
        ] as const) {
          const one = await counted(list, state);
          totals[into] += one.count;
          totals.capped ||= one.capped;
        }
      }
      out.deliveries = totals;
    } else if (section === 'workflows') {
      const list = (state: string) => owner.workflows!.list({ state: state as WorkflowState }, PAGE);
      const failed = await counted(list, 'failed'),
        diverged = await counted(list, 'diverged');
      const running = await counted(list, 'running'),
        waiting = await counted(list, 'waiting'),
        completed = await counted(list, 'completed');
      out.workflows = {
        failed: failed.count + diverged.count,
        running: running.count + waiting.count,
        completed: completed.count,
        capped: [failed, diverged, running, waiting, completed].some((entry) => entry.capped),
      };
    } else {
      const rows = (await owner.stores!()).filter((row) => row.id || row.refused);
      out.stores = {
        total: rows.length,
        behind: rows.filter((row) => !row.refused && row.pending.length).length,
        refused: rows.filter((row) => row.refused).length,
      };
    }
  }
  return out;
}

/**
 * `mistri migrate stores status` for one App's databases, read when asked:
 * each named by its connection (or `analytics`), never by its address. One
 * that cannot be opened says so as a refusal and the rest are still read.
 */
export function consoleStoreStatuses(
  databases: () => readonly Readonly<{ name: string; url: string | undefined }>[],
): () => Promise<readonly ConsoleStoreStatus[]> {
  return async () => {
    const [{ openMigrationDb, dialectOf }, { storeStatuses }] = await Promise.all([
      import('@mistriwork/engine/server/migrate/database.js'),
      import('../storeLayouts.js'),
    ]);
    const rows: ConsoleStoreStatus[] = [];
    for (const { name, url } of databases()) {
      if (url === undefined) continue;
      let dialect: string;
      try {
        dialect = dialectOf(url);
      } catch {
        continue;
      }
      let db: Awaited<ReturnType<typeof openMigrationDb>>;
      try {
        db = await openMigrationDb(url, [], false);
      } catch {
        rows.push(
          Object.freeze({
            database: name,
            dialect,
            id: '',
            title: '',
            found: null,
            current: 0,
            pending: [],
            refused: 'the database could not be opened',
          }),
        );
        continue;
      }
      try {
        for (const status of await storeStatuses(db)) {
          rows.push(
            Object.freeze({
              database: name,
              dialect,
              id: status.id,
              title: status.title,
              found: status.found,
              current: status.current,
              pending: Object.freeze([...status.pending]),
              // The store's own sentence, but never a driver's error text: that is the operator's console's, not a browser's.
              ...(status.refused
                ? { refused: status.refused.startsWith('its version cannot be read') ? 'its version cannot be read' : status.refused }
                : {}),
            }),
          );
        }
      } finally {
        await db.close().catch(() => {});
      }
    }
    return Object.freeze(rows);
  };
}
