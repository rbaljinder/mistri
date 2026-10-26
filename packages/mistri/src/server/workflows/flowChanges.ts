/**
 * The history rows a jobs host's flow runners start on (flowTail.ts), read
 * from the store beside the App's own source, where every resource with
 * flows lives (flowCommand.ts). A row names its record by its stored key;
 * the dispatch carries that key, as a run's instance key begins with it, and
 * the value of the record's one key column, which the runner's commands
 * target.
 *
 * On a tenant App the stored key of a tenant-owned record also holds its
 * owner, which the writer read off the row inside the write
 * (tenant/tenantRecordHistoryStore.ts): that owner is the change's tenant,
 * and the only thing that says whose a run is. No request, row of a flow or
 * payload chooses it.
 */
import type { StoredRecordChange, RecordActivityQuery } from '../../adapters/history/recordHistory.js';
import { RECORD_HISTORY_PAGE } from '../../adapters/history/recordHistory.js';
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import type { FlowRunnerRef } from './flowCommand.js';
import type { FlowChange, FlowChangeReader } from './flowTail.js';
import { FLOW_ACTOR_PREFIX } from './workflowHost.js';
import type { CapturedWorkflow } from './workflowModule.js';
import { storesOf } from '../stores/appStores.js';

/* A tenant's id, as the tenant store spells one (tenantMembership.ts parseTenantSelector): never the platform's `@platform`. */
const TENANT = /^[a-z0-9][a-z0-9_-]{0,127}$/;

/** A row no runner can target: it still moves the cursor, passed as a change a flow made, which starts nothing. */
const passed = (row: StoredRecordChange): FlowChange =>
  Object.freeze({
    id: row.id,
    at: Date.parse(row.at) || 0,
    workflow: '',
    runAs: '',
    byFlow: true,
    dispatch: { record: '', target: '', trigger: 'updated' as const, changed: [] },
  });

type ActivityStore = { readRecordActivity(query: RecordActivityQuery): Promise<StoredRecordChange[]> };

/** The flows runners a jobs module declares, as the platform's flow commands name them. */
export const flowRunnersOf = (workflows: ReadonlyMap<string, CapturedWorkflow>): FlowRunnerRef[] =>
  [...workflows.values()].flatMap((workflow) =>
    workflow.flows ? [{ workflow: workflow.name, resource: workflow.flows.resource, runAs: workflow.runAs }] : [],
  );

/** A row as a change a runner may start on, or undefined where it names no record the runner can target.
 * `owner`: a tenant App's owner column, whose value in the stored key is the change's tenant. */
function flowChangeOf(row: StoredRecordChange, runner: FlowRunnerRef, keyColumn: string, owner?: string): FlowChange | undefined {
  let key: unknown;
  try {
    key = JSON.parse(row.key);
  } catch {
    return undefined;
  }
  const value = key && typeof key === 'object' ? (key as Record<string, unknown>)[keyColumn] : undefined;
  const at = Date.parse(row.at);
  if ((typeof value !== 'string' && typeof value !== 'number') || row.key.length > 440 || !Number.isFinite(at)) return undefined;
  const target = String(value);
  if (!target || target.length > 512) return undefined;
  const owned = owner === undefined ? undefined : (key as Record<string, unknown>)[owner];
  if (owner !== undefined && (typeof owned !== 'string' || !TENANT.test(owned))) return undefined;
  const tenantId = owned as string | undefined;
  return Object.freeze({
    ...(tenantId === undefined ? {} : { tenantId }),
    id: row.id,
    at,
    workflow: runner.workflow,
    runAs: runner.runAs,
    byFlow: row.actor.startsWith(FLOW_ACTOR_PREFIX),
    dispatch: Object.freeze({
      record: row.key,
      target,
      trigger: row.kind === 'insert' ? ('created' as const) : ('updated' as const),
      // At most 120 columns of up to 128 characters: what the match op takes as input (flowCommand.ts).
      changed: Object.freeze(row.changes.map((change) => change.c).slice(0, 120)),
    }),
  });
}

/** The reader a single App's jobs host tails: its catalog read at each cycle, so a renamed table follows the App. */
export function flowChangeReader(
  options: Readonly<{ registry: Registry; app: () => AppDef; owner: string; runners: readonly FlowRunnerRef[] }>,
): FlowChangeReader {
  return async (query) => {
    const { loadAppRuntimeResources } = await import('../app/appRuntimeResources.js');
    const releases: Array<() => void> = [];
    try {
      const resources = await loadAppRuntimeResources(options.registry, options.app(), options.owner, (id) =>
        releases.push(options.registry.lease(id)),
      );
      const watched = options.runners.flatMap((runner) => {
        const table = resources.schema.tables.find((each) => each.id === runner.resource);
        const keys = table?.columns.filter((column) => column.primaryKey) ?? [];
        return keys.length === 1
          ? [
              {
                runner,
                physical: resources.toPhysical(runner.resource),
                keyColumn: keys[0].name,
                connection: resources.connectionFor(runner.resource),
              },
            ]
          : [];
      });
      if (!watched.length) return [];
      // One store: the runners' resources are all the App's own source's (flowCommandProblems).
      const store = storesOf((await options.registry.open(watched[0].connection)).adapter) as unknown as Partial<ActivityStore>;
      if (typeof store.readRecordActivity !== 'function') return [];
      const rows = await store.readRecordActivity({
        resources: [...new Set(watched.map((each) => each.physical))],
        limit: RECORD_HISTORY_PAGE,
        ...(query.after === undefined ? {} : { after: query.after }),
        ...(query.from === undefined ? {} : { from: query.from }),
      });
      const changes: FlowChange[] = [];
      for (const row of rows) {
        const at = watched.find((each) => each.physical === row.resource);
        const change = at && flowChangeOf(row, at.runner, at.keyColumn);
        changes.push(change ?? passed(row));
      }
      return changes;
    } finally {
      for (const release of releases.reverse()) release();
    }
  };
}

/**
 * The reader a tenant App's jobs host tails: every tenant's changes of the
 * resources with flows, from the deployment's own history store, each
 * carrying the tenant its stored key names. Each resource and both tables of
 * its rows are tenant-owned (tenantJobs.ts refuses anything else), so the
 * dispatch's tenant is the one every read and write of the run is scoped to.
 */
export function tenantFlowChangeReader(
  options: Readonly<{
    read: (query: RecordActivityQuery) => Promise<StoredRecordChange[]>;
    schema: DatabaseSchema;
    /** The logical resource's physical table, and its owner column. */
    resources: Readonly<Record<string, string>>;
    owners: Readonly<Record<string, string>>;
    runners: readonly FlowRunnerRef[];
  }>,
): FlowChangeReader {
  const watched = options.runners.flatMap((runner) => {
    const keys = options.schema.tables.find((each) => each.id === runner.resource)?.columns.filter((column) => column.primaryKey) ?? [];
    const physical = Object.hasOwn(options.resources, runner.resource) ? options.resources[runner.resource] : undefined;
    const owner = Object.hasOwn(options.owners, runner.resource) ? options.owners[runner.resource] : undefined;
    return keys.length === 1 && physical && owner ? [{ runner, physical, owner, keyColumn: keys[0].name }] : [];
  });
  return async (query) => {
    if (!watched.length) return [];
    const rows = await options.read({
      resources: [...new Set(watched.map((each) => each.physical))],
      limit: RECORD_HISTORY_PAGE,
      ...(query.after === undefined ? {} : { after: query.after }),
      ...(query.from === undefined ? {} : { from: query.from }),
    });
    return rows.map((row) => {
      const at = watched.find((each) => each.physical === row.resource);
      return (at && flowChangeOf(row, at.runner, at.keyColumn, at.owner)) ?? passed(row);
    });
  };
}
