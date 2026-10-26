/**
 * `GET /api/live` on a served App: the reader's authority on each database
 * the App reads, resolved the way their reads are, and the stream
 * (liveStream.ts).
 *
 * An ordinary App's reader reads every row of each resource their grants
 * name, so no probe ever runs for them: their authority is the tables and
 * columns their catalog serves. A row-policy App's reader is resolved inside
 * the policy's own context, the one the route runs in, and their row scope
 * read from it; a probe of whether a changed row is in their scope is a read
 * in a context of its own, through the same scoped reader as any read, so it
 * re-verifies their session too. The authority is resolved again every 30 s
 * the same way, and a resolution that finds another account, other roles or
 * no session ends the stream.
 *
 * Under a row policy the route answers after the context closes: the reply
 * the policy defers (reply.ts `policyResponses`) is the stream's start, so no
 * context is held open for the stream's life.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { LiveKey } from '../../adapters/live/liveChange.js';
import type { Filter } from '@mistriwork/engine/shared/filter.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { RowScope, RowScopeFilter } from '@mistriwork/engine/shared/rowScope.js';
import { rollupReads } from '@mistriwork/engine/shared/rollups.js';
import { isRowPolicyApp, resolveAppAccess, withRollups, type AppDef } from '../../shared/app.js';
import { sessionRoles } from '../../shared/appViewRoles.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { HttpError, policyResponses, send } from '@mistriwork/engine/server/http/reply.js';
import { clockNow } from '@mistriwork/engine/server/http/clock.js';
import type { AppHost } from '../app/apps.js';
import { AppAccessDenied, authorizeResources } from '../app/appAccess.js';
import { accountOf, signedInAs } from '../app/appStamps.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { httpPolicyReads, type HttpAppPolicy } from '../policy/appPolicyHttp.js';
import { policyLiveScopeOf, type AppPolicyContext } from '../policy/appPolicyContext.js';
import { connectionHub, liveOffResources, liveSyncOn } from './liveBinding.js';
import { keyText, scopeFingerprint, type LiveAuthority, type LiveGrant } from './liveFilter.js';
import { guard, type LiveHub } from './liveHub.js';
import { openLiveStream } from './liveStream.js';

export const LIVE_PATH = '/api/live';

/* ---------- what a served catalog reads ---------- */

/**
 * The columns of each table a reader reads, by table id: the catalog's own,
 * and those a computed column or a rollup it serves reads, since a change
 * there changes what they read.
 */
export function readColumns(served: DatabaseSchema): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>(served.tables.map((table) => [table.id, new Set(table.columns.map((column) => column.name))]));
  const add = (table: string, column: string) => out.get(table)?.add(column);
  for (const table of served.tables) {
    for (const computed of Object.values(table.computed ?? {})) for (const path of computed.reads) add(table.id, path.split('.')[0]);
    for (const rollup of Object.values(table.rollups ?? {}))
      for (const read of rollupReads(rollup)) for (const field of read.fields) add(read.table, field.split('.')[0]);
  }
  return out;
}

/** One table's grant, by its physical name, or undefined where the scope admits no row. */
function grantFor(
  served: DatabaseSchema,
  id: string,
  columns: ReadonlySet<string>,
  scope: boolean | RowScopeFilter | undefined,
  owner: string,
  physical: string,
): LiveGrant | undefined {
  const table = served.tables.find((each) => each.id === id);
  if (!table || scope === false || scope === undefined) return undefined;
  const filter = scope === true ? true : scope;
  return Object.freeze({ id, key: primaryKey(table), columns, scope: filter, fingerprint: scopeFingerprint(owner, physical, filter) });
}

/** A probe's answer as the change store's keys are matched: each value as text, so `7` and `"7"` are the one key. */
const matchText = (key: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(key)
      .sort()
      .map((column) => [column, key[column] === null || key[column] === undefined ? null : String(key[column])]),
  );

/** `keys` as a filter: each key's columns ANDed, the keys ORed. */
const keysFilter = (keys: readonly LiveKey[]): Filter => ({
  groups: keys.map((key) => Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))),
});

/** Which of `keys` a read through `query` returns: the rows the reader's scope admits now, as change-store key texts. */
export async function probedKeys(
  query: (request: { table: string; filter: Filter; columns: string[]; limit: number; offset: number }) => Promise<{
    rows: ReadonlyArray<Record<string, unknown>>;
  }>,
  table: string,
  keys: readonly LiveKey[],
): Promise<ReadonlySet<string>> {
  if (!keys.length) return new Set();
  const columns = Object.keys(keys[0]);
  const result = await query({ table, filter: keysFilter(keys), columns, limit: keys.length, offset: 0 });
  const found = new Set(result.rows.map((row) => matchText(Object.fromEntries(columns.map((column) => [column, row[column]])))));
  return new Set(keys.filter((key) => found.has(matchText(key))).map(keyText));
}

/* ---------- the route ---------- */

interface Resolved {
  readonly connections: readonly string[];
  readonly authority: readonly LiveAuthority[];
}

/** The App a live request is for: the one served, or the one `?app=` names. */
function hostOf(ctx: RequestContext): AppHost {
  const id = ctx.url.searchParams.get('app');
  const hosts = (ctx.appHosts ?? []) as AppHost[];
  const host = id ? hosts.find((each) => each.app.app.id === id) : hosts.length === 1 ? hosts[0] : undefined;
  if (!host) throw new HttpError(id ? 404 : 400, id ? 'Application not found.' : 'Choose an application.');
  return host;
}

/**
 * Live sync off (`--no-live`, or no change store): 204, nothing to follow. Not a 404, which a browser prints as a
 * failed load on every page of an App whose store is not provisioned, though off is an answer, not an error.
 */
export function answerLiveOff(res: ServerResponse): void {
  res.writeHead(204, { 'cache-control': 'no-store' });
  res.end();
}

/** Answer `/api/live`; false for every other path. */
export async function liveRoute(ctx: RequestContext): Promise<boolean> {
  if (ctx.path !== LIVE_PATH) return false;
  const { req, res } = ctx;
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    send(res, 405, { error: 'Live sync is read with GET.' });
    return true;
  }
  if (!liveSyncOn() || !ctx.appHosts?.length) {
    answerLiveOff(res);
    return true;
  }
  const host = hostOf(ctx);
  const app = host.app.app;
  /* The App's choice: one that does not ask is off, as under --no-live. */
  if (!app.live) {
    answerLiveOff(res);
    return true;
  }
  const cursor = ctx.url.searchParams.get('after') ?? undefined;
  const policyContext = ctx.policyContext as AppPolicyContext | undefined;
  const policy = ctx.policy as HttpAppPolicy | undefined;
  const identity = { id: ctx.identity.id, role: ctx.identity.role ?? '' };
  let resolve: () => Promise<Resolved>;
  let first: Resolved;
  if (isRowPolicyApp(app)) {
    if (!policyContext || !policy) throw new AppAccessDenied();
    resolve = () =>
      policy.withContext(req, async (context) => {
        const same =
          context.principal.kind === 'public'
            ? identity.id === undefined
            : context.principal.id === identity.id &&
              JSON.stringify([...context.principal.roles].sort()) === JSON.stringify(sessionRoles(identity.role).sort());
        if (!same) throw new AppAccessDenied();
        return policyAuthority(app, req, policy, context, accountOf(ctx.identity) ?? '');
      });
    first = policyAuthority(app, req, policy, policyContext, accountOf(ctx.identity) ?? '');
  } else {
    resolve = async () => {
      await sameSession(ctx, identity);
      return ordinaryAuthority(ctx, host);
    };
    first = await ordinaryAuthority(ctx, host);
  }
  /* A database the reader is served nothing from starts nothing for them. */
  const wanted = first.connections.flatMap((_connection, index) => (first.authority[index].tables.size ? [index] : []));
  const answers = await Promise.all(wanted.map((index) => connectionHub(ctx.registry, first.connections[index])));
  const hubs: LiveHub[] = [];
  const kept: number[] = [];
  answers.forEach((answer, at) => {
    if (!('hub' in answer)) return;
    hubs.push(answer.hub);
    kept.push(wanted[at]);
  });
  /* A database whose setup did not finish in time: the client comes back shortly rather than going without. */
  if (answers.some((answer) => 'late' in answer)) {
    res.writeHead(503, { 'cache-control': 'no-store', 'retry-after': '5' });
    res.end();
    return true;
  }
  if (!hubs.length) {
    answerLiveOff(res);
    return true;
  }
  const pick = (resolved: Resolved) => {
    if (resolved.connections.join('\u0000') !== first.connections.join('\u0000')) throw new AppAccessDenied();
    return kept.map((index) => resolved.authority[index]);
  };
  const start = () =>
    void openLiveStream({
      req,
      res,
      account: identity.id ?? `visitor:${req.socket.remoteAddress ?? ''}`,
      hubs,
      off: liveOffResources(app),
      ...(cursor === undefined ? {} : { cursor }),
      authority: pick(first),
      resolve: async () => pick(await resolve()),
    }).catch((error: unknown) =>
      guard('stream', () => {
        if (!res.writableEnded) res.end();
        throw error;
      }),
    );
  /* Under a row policy the context closes first; the deferred reply is the stream's start. */
  const deferred = policyResponses.get(res);
  if (deferred) deferred.reply = start;
  else start();
  return true;
}

/* The session is the one the stream opened under: an expired, signed-out or changed one ends it. */
async function sameSession(ctx: RequestContext, identity: { id?: string; role: string }): Promise<void> {
  const signedIn = ctx.signedIn as AppHost | undefined;
  if (!signedIn?.auth) return;
  let session: { id?: unknown; role?: unknown } | null;
  try {
    session = (await signedIn.auth.session(ctx.req)) as { id?: unknown; role?: unknown } | null;
  } catch {
    throw new AppAccessDenied();
  }
  if (identity.id === undefined) {
    if (session) throw new AppAccessDenied();
    return;
  }
  if (!session || session.id !== identity.id || (session.role ?? '') !== identity.role) throw new AppAccessDenied();
}

/* An ordinary App: the grants of the reader's roles, every row of what they name. */
async function ordinaryAuthority(ctx: RequestContext, host: AppHost): Promise<Resolved> {
  const { registry, identity } = ctx;
  const app = host.app.app;
  const target = appEntrypoint(host, registry);
  if (!target) throw new HttpError(503, 'Application data is unavailable.');
  const releases: Array<() => void> = [];
  try {
    /* Leased while resolving only: a stream that held a lease would keep its connection from ever reconnecting. */
    const resources = await loadAppRuntimeResources(registry, app, target, (owner) => releases.push(registry.lease(owner)));
    const visitor = typeof identity.id !== 'string' || !identity.id.trim();
    const access = resolveAppAccess(app, resources.schema, visitor ? [] : sessionRoles(identity.role), visitor ? 'public' : undefined);
    const authorized = authorizeResources(resources, access);
    const served = withRollups(app, authorized.schema, clockNow(), signedInAs(identity) ?? null);
    const columns = readColumns(served);
    const tables = new Map<string, Map<string, LiveGrant>>(resources.connections.map((connection) => [connection, new Map()]));
    for (const table of served.tables) {
      if (app.resources?.[table.id]?.live === false) continue;
      const physical = resources.toPhysical(table.id);
      const grant = grantFor(served, table.id, columns.get(table.id)!, true, app.id, physical);
      if (grant) tables.get(resources.connectionFor(table.id))?.set(physical, grant);
    }
    const actor = accountOf(identity) ?? '';
    return {
      connections: resources.connections,
      authority: resources.connections.map((connection) =>
        Object.freeze({ actor, tables: tables.get(connection)!, probe: async () => new Set<string>() }),
      ),
    };
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/* A row-policy App: its context's catalog and rows; a scoped table is probed in a context of its own. */
function policyAuthority(app: AppDef, req: IncomingMessage, policy: HttpAppPolicy, context: AppPolicyContext, actor: string): Resolved {
  const scope = policyLiveScopeOf(context);
  if (!scope) throw new AppAccessDenied();
  const rows: RowScope = scope.rows;
  const served = withRollups(app, context.schema, clockNow(), context.principal.email ?? null);
  const columns = readColumns(served);
  const connections = [...new Set(served.tables.map((table) => scope.connectionFor(table.id)))].sort();
  const tables = new Map<string, Map<string, LiveGrant>>(connections.map((connection) => [connection, new Map()]));
  const logical = new Map<string, string>();
  for (const table of served.tables) {
    if (app.resources?.[table.id]?.live === false) continue;
    const physical = scope.toPhysical(table.id);
    const grant = grantFor(served, table.id, columns.get(table.id)!, rows[table.id], app.id, physical);
    if (!grant) continue;
    tables.get(scope.connectionFor(table.id))!.set(physical, grant);
    logical.set(`${scope.connectionFor(table.id)}\u0000${physical}`, table.id);
  }
  return {
    connections,
    authority: connections.map((connection) =>
      Object.freeze({
        actor,
        tables: tables.get(connection)!,
        probe: (table: string, keys: readonly LiveKey[]) => {
          const id = logical.get(`${connection}\u0000${table}`);
          if (!id) return Promise.resolve(new Set<string>());
          return policy.withContext(req, (probing) => {
            /* Asked as the reader the stream is for, or not at all. */
            if (probing.principal.id !== context.principal.id || probing.principal.kind !== context.principal.kind)
              throw new AppAccessDenied();
            return probedKeys((request) => httpPolicyReads(probing).adapter.query(request), id, keys);
          });
        },
      }),
    ),
  };
}
