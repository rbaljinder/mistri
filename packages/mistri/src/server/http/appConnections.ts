/**
 * What an App server says of the database browser's connection routes
 * (connectionRoutes.ts): which Apps it runs and who is asking, in an App's
 * words, and a refusal for the rest — it is not a database administrator, and
 * the diagnostic tools (raw SQL, saved queries, the view compiler, the agent
 * console) are the standalone browser's.
 */
import { appSourceConnections } from '../app/appRuntimeResources.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { appDiagnosticEndpoint } from '../app/appResponses.js';
import { send, sendRevalidated } from '@mistriwork/engine/server/http/reply.js';
import { principalOf, type RequestContext } from '@mistriwork/engine/server/http/context.js';
import { accountAdministrator } from './accountRoutes.js';
import { appKeepsInbox } from '../inbox.js';
import { keepsRoles, roleLabelsOf } from '../../shared/appModel.js';

/** True when answered. */
export function appConnectionRoutes(ctx: RequestContext): boolean {
  const { req, res, path, registry, bound, appHosts, policy, identity, signedIn, policyContext } = ctx;

  if (appDiagnosticEndpoint(path)) {
    send(res, 403, { error: 'Database diagnostic tools are available only in the standalone DB browser.' });
    return true;
  }
  if (path === '/api/runtime') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'Method not allowed.' });
      return true;
    }
    const apps = (appHosts ?? []).map((host) => {
      const app = host.app.app;
      const owner = appEntrypoint(host, registry);
      const bindings = app.sources
        ? [...appSourceConnections(registry, app).values()].map((id) => registry.configOf(id)!)
        : owner
          ? [registry.configOf(owner)!]
          : [];
      return {
        id: app.id,
        name: app.name,
        writable: policyContext
          ? Boolean(policy!.writableTables(policyContext).length)
          : bindings.some((binding) => binding.writable === true),
        ...(bindings.length && bindings.every((binding) => binding.rows === false) ? { rows: false } : {}),
      };
    });
    sendRevalidated(res, { appConfigured: true, active: apps.length === 1 ? apps[0].id : null, apps }, principalOf(ctx.identity));
    return true;
  }

  // An App server is not a database administrator.
  if (path === '/api/connections' || path.startsWith('/api/connections/')) {
    send(res, 403, { error: 'Connection management is not available on this application server.' });
    return true;
  }

  /* Who the server thinks is asking, for a client that wants to say so. */
  if (path === '/api/whoami') {
    res.setHeader('cache-control', 'no-store');
    send(res, 200, {
      who: identity.who ?? null,
      header: signedIn?.auth ? null : (bound.identityHeader ?? null),
      signedIn: Boolean(signedIn?.auth),
      ...(signedIn?.auth ? { accountId: identity.id, appId: signedIn.app.app.id } : {}),
      // What the App calls its roles, for every screen that names one (account, grant and invitation screens).
      ...(signedIn?.auth ? roleLabelsOf(signedIn.app.app.auth) : {}),
      ...(signedIn?.auth ? keepsRoles(signedIn.app.app.auth) : {}),
      ...(signedIn?.auth?.suite ? { suite: signedIn.auth.suite } : {}),
      ...(signedIn?.auth?.accountProfile === true ? { accountProfile: true } : {}),
      // Whether the account menu offers Accounts: the route asks the same question again.
      ...(accountAdministrator(ctx) ? { accountAdministration: true } : {}),
      // A bell only where there is an inbox to ring for (inbox.ts): a signed-in account in an App that notifies.
      // An address not yet proven where anyone may sign up has no inbox (inboxRoutes.ts).
      ...(signedIn?.auth && identity.id && !identity.emailUnproven && appKeepsInbox(signedIn.app.app) ? { inbox: true } : {}),
    });
    return true;
  }
  return false;
}
