/** Availability of an authored cross-App destination. A href is never a grant or context. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { parseAppTarget, type AppTarget, type BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import { resolveAppAccess } from '../../shared/app.js';
import { servedApp, withoutBrokenViews } from '../../shared/appPayload.js';
import { homeViews } from '../../shared/appHome.js';
import { tableNamed } from '@mistriwork/engine/shared/schema.js';
import { accessibleSchema } from '../app/appAccess.js';
import { fieldAccessibleApp } from '../app/appFieldProjection.js';
import { appRoutes } from '../app/apps.js';
import { resolveSuiteLink, type SuiteLinkApp, type SuiteLinkCatalog } from '../app/suiteLinks.js';
import { readJson } from '@mistriwork/engine/server/http/reply.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { captureAppAuthRuntime, type AppAuthRuntime } from './auth.js';
import { appForRoles, pagesForRoles } from '../../shared/appViewRoles.js';

/** Availability only: the retained target owner keeps discovery and contexts private. */
export type SuiteLinkTenantAccess = (
  request: IncomingMessage,
  target: BoundAppTarget,
  catalog: SuiteLinkApp,
  accountId: string,
  guard: Readonly<{ assertCurrent: () => void; observe: () => Promise<void> }>,
) => Promise<boolean>;

export interface SuiteLinkHost {
  readonly catalog: SuiteLinkApp;
  readonly auth?: AppAuthRuntime;
  readonly tenant?: SuiteLinkTenantAccess;
  readonly current: () => boolean;
}

/** Literal data must match exactly; only authored record slots may vary. Repeated
 * bindings must still describe one source field, not two independently chosen values. */
function authored(declaration: AppTarget, target: BoundAppTarget): boolean {
  const bound = new Map<string, unknown>();
  const matches = (expected: unknown, actual: unknown): boolean => {
    if (expected && typeof expected === 'object' && 'column' in expected) {
      const field = (expected as { column: string }).column;
      if (typeof actual !== 'string' && typeof actual !== 'number') return false;
      if (bound.has(field)) return bound.get(field) === actual;
      bound.set(field, actual);
      return true;
    }
    if (!expected || typeof expected !== 'object') return expected === actual;
    if (!actual || typeof actual !== 'object') return false;
    const keys = Object.keys(expected);
    return (
      isDeepStrictEqual(keys.sort(), Object.keys(actual).sort()) &&
      keys.every((key) => matches((expected as Record<string, unknown>)[key], (actual as Record<string, unknown>)[key]))
    );
  };
  return matches(declaration, target);
}

function visible(host: SuiteLinkHost, target: BoundAppTarget, roles: readonly string[]): boolean {
  const { app, pages, surfaces } = host.catalog;
  const surface = surfaces.find((item) => item.realm === 'app');
  if (!surface) return false;
  const access = resolveAppAccess(app, surface.schema, roles);
  const schema = accessibleSchema(surface.schema, access);
  if (target.kind === 'record') {
    const table = surface.resources?.[target.resource] ?? tableNamed(surface.schema, target.resource)?.id;
    return (
      table !== undefined &&
      access.readable.has(table) &&
      schema.tables.some((item) => item.id === table) &&
      surface.book.records.has(table)
    );
  }
  /* A link resolves only to a view the person may open, roles and all (appViewRoles.ts). */
  const readable = fieldAccessibleApp(appForRoles(app, roles), schema);
  const rooms = withoutBrokenViews(servedApp(readable, schema, pagesForRoles(pages, roles, app.auth)), homeViews(app));
  return target.kind === 'home' || Object.hasOwn(rooms.views, target.view);
}

export async function suiteLinkHttp(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    native: AppAuthRuntime;
    catalog: SuiteLinkCatalog;
    hosts: ReadonlyMap<string, SuiteLinkHost>;
    bound: Bound;
    current: () => boolean;
  },
): Promise<void> {
  const send = (status: number, body: unknown) => {
    if (!res.destroyed && !res.writableEnded)
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
  };
  const unavailable = () => send(404, { error: 'App link unavailable.' });
  if (!options.current()) return send(503, { error: 'App link unavailable.' });
  if (req.method !== 'POST') return send(405, { error: 'Use POST.' });
  if (getTenantHostIntent(req) || doorRefusal(req, options.bound, { writing: true })) return send(403, { error: 'Invalid origin.' });
  try {
    const native = captureAppAuthRuntime(options.native);
    const proof = await native.sessionInstance(req);
    if (!proof) return send(401, { error: 'Sign in to continue.' });
    if (req.headers['x-mistri-account'] !== proof.identity.id) return send(409, { error: 'The signed-in account changed.' });
    let sourceApp: string, target: BoundAppTarget;
    try {
      const body: unknown = await readJson(req, 16 * 1024);
      if (
        !body ||
        typeof body !== 'object' ||
        Array.isArray(body) ||
        Object.keys(body).length !== 2 ||
        !Object.hasOwn(body, 'sourceApp') ||
        !Object.hasOwn(body, 'target')
      )
        throw new Error('Invalid body.');
      const value = body as { sourceApp: unknown; target: unknown };
      if (typeof value.sourceApp !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(value.sourceApp))
        throw new Error('Invalid source.');
      sourceApp = value.sourceApp;
      target = parseAppTarget(value.target) as BoundAppTarget;
    } catch {
      return send(400, { error: 'Invalid App link request.' });
    }
    const source = options.hosts.get(sourceApp),
      destination = options.hosts.get(target.app);
    if (
      !source?.auth ||
      !destination?.auth ||
      !options.catalog.declarations.some((link) => link.sourceApp === sourceApp && authored(link.target, target))
    )
      return unavailable();
    const from = captureAppAuthRuntime(source.auth),
      into = captureAppAuthRuntime(destination.auth);
    const sourceProof = await from.sessionInstance(req),
      targetProof = await into.sessionInstance(req);
    if (
      !sourceProof ||
      !targetProof ||
      sourceProof.identity.id !== proof.identity.id ||
      targetProof.identity.id !== proof.identity.id ||
      sourceProof.sessionId !== proof.sessionId ||
      targetProof.sessionId !== proof.sessionId
    )
      return unavailable();
    const assertCurrent = () => {
      if (!options.current() || !source.current() || !destination.current() || req.aborted || res.destroyed) throw new Error('Retired.');
      native.assertSessionCurrent(proof);
      from.assertSessionCurrent(sourceProof);
      into.assertSessionCurrent(targetProof);
    };
    const guard = async () => {
      assertCurrent();
      await native.observeSession(proof);
      await from.observeSession(sourceProof);
      await into.observeSession(targetProof);
      assertCurrent();
    };
    await guard();
    if (destination.catalog.app.auth?.rows === 'tenant') {
      const owner = destination.tenant;
      if (!owner) return unavailable();
      if (!(await owner(req, target, destination.catalog, proof.identity.id, { assertCurrent, observe: guard }))) return unavailable();
    } else if (!visible(destination, target, (targetProof.identity.role ?? '').split(',').filter(Boolean))) return unavailable();
    /* A record opens at the address this person is served in the destination, as their browser there says it. */
    const surface =
      destination.catalog.app.auth?.rows === 'tenant' ? undefined : destination.catalog.surfaces.find((item) => item.realm === 'app');
    const roles = (targetProof.identity.role ?? '').split(',').filter(Boolean);
    const href = resolveSuiteLink(
      options.catalog,
      target,
      surface && target.kind === 'record' ? appRoutes(destination.catalog, surface.schema, undefined, roles) : undefined,
    );
    await guard();
    send(200, { accountId: proof.identity.id, href });
  } catch {
    unavailable();
  }
}
