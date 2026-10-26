/**
 * `/api/record-history`: one record's history, for the reader asking
 * (server/recordHistory.ts says what they may see), and `/api/record-activity`:
 * a dashboard's feed of recent changes across resources, read from the same
 * log by the same rule (server/recordActivity.ts). An App's routes only: the
 * Workbench keeps no history, and its journal is Undo's, not a record's.
 */
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { appForConnection } from '../app/apps.js';
import { readRecordHistoryFor } from '../recordHistory.js';
import { readRecordActivityFor } from '../recordActivity.js';
import { readRecordFlowsFor, startRecordFlowFor } from '../recordFlows.js';
import { flowRunsOf } from '../workflows/flowRuns.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

const RECORD_HISTORY_PATH = '/api/record-history';
const RECORD_ACTIVITY_PATH = '/api/record-activity';
/* A record's flow runs, and a manual flow's start (recordFlows.ts): the same reader and the same rule as its history. */
const RECORD_FLOWS_PATH = '/api/record-flows';
const RECORD_FLOWS_START_PATH = '/api/record-flows/start';

export async function recordHistoryRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, appHosts, resources } = post;
  if (![RECORD_HISTORY_PATH, RECORD_ACTIVITY_PATH, RECORD_FLOWS_PATH, RECORD_FLOWS_START_PATH].includes(path)) return false;
  const host = appHosts?.length ? appForConnection(appHosts, connection, registry.configOf(connection)?.name) : undefined;
  if (!host) {
    send(res, 404, { error: "Record history belongs to an App's record pages." });
    return true;
  }
  if (path === RECORD_FLOWS_PATH || path === RECORD_FLOWS_START_PATH) {
    const flows = {
      app: host.app.app,
      reader: adapter,
      schema,
      runs: flowRunsOf(host.app.app.id),
      table: body.table,
      key: body.key,
      roles: host.app.app.auth && !post.who ? [] : sessionRoles(post.role),
    };
    send(
      res,
      200,
      path === RECORD_FLOWS_PATH
        ? await readRecordFlowsFor(flows)
        : await startRecordFlowFor({ ...flows, flow: body.flow, operator: post.who }),
    );
    return true;
  }
  /* A row-policy App's reads come through its policy facade, which carries
     no physical mapping; the mapping alone is loaded here, and only reaches
     the store after the reader's own facade has read the record. */
  let mapping = resources;
  if (!mapping) {
    const releases: Array<() => void> = [];
    res.once('close', () => {
      for (const release of releases.splice(0).reverse()) release();
    });
    mapping = await loadAppRuntimeResources(registry, host.app.app, connection, (owner) => releases.push(registry.lease(owner)));
  }
  if (path === RECORD_ACTIVITY_PATH) {
    send(
      res,
      200,
      await readRecordActivityFor({
        app: host.app.app,
        pages: host.app.pages,
        reader: adapter,
        schema,
        mapping,
        open: async (owner) => (await registry.open(owner)).adapter,
        view: body.view,
        section: body.section,
        period: body.period,
        now: clockNow(),
        ...(post.zone === undefined ? {} : { zone: post.zone }),
        roles: host.app.app.auth && !post.who ? [] : sessionRoles(post.role),
      }),
    );
    return true;
  }
  const reply = await readRecordHistoryFor({
    app: host.app.app,
    pages: host.app.pages,
    reader: adapter,
    schema,
    mapping,
    open: async (owner) => (await registry.open(owner)).adapter,
    table: body.table,
    key: body.key,
    before: body.before,
    limit: body.limit,
  });
  send(res, 200, reply);
  return true;
}
