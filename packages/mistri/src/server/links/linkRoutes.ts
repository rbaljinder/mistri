/**
 * The link door (linkDoor.ts) for an App without tenants: the link is read from the journal beside the App's
 * records, its record from the App's own connection, and a command runs through the App's executor — or, in a
 * row-policy App, through the policy's link scope, where the link is the grant for its one row.
 */
import { isRowPolicyApp, isTenantApp, type AppDef } from '../../shared/app.js';
import { appEntrypoint } from '../app/appEntrypoint.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { keyFilter } from '../commands/commandDb.js';
import { dispatchBusinessCommandHttp, dispatchScopedBusinessCommandHttp } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { emailOf } from '../serviceConnections.js';
import { requestLocale } from '../app/readerLocale.js';
import { lookUpLink, servesLinks } from './linkLookup.js';
import { LINK_PATH, linkDoor, type FoundLink, type LinkBackend, type LinkStep } from './linkDoor.js';

type Host = NonNullable<RequestContext['appHosts']>[number] & { app: { app: AppDef } };
type JournalFound = FoundLink & { journal: NonNullable<Awaited<ReturnType<typeof lookUpLink>>>['journal'] };

export async function linkRoutes(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, registry, bound, mount } = ctx;
  const match = LINK_PATH.exec(path);
  if (!match) return false;
  let appId: string;
  try {
    appId = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  const host = (ctx.appHosts as Host[] | undefined)?.find((each) => each.app.app.id === appId);
  const app = host?.app.app;
  if (!host || !app || !servesLinks(app)) return false;
  const door = { req, res, bound, mount, app, segment: match[2], step: match[3] as LinkStep | undefined };

  /* A link is served here where its principal is the whole story: no tenant (tenant/tenantLinks.ts serves those), a
     writable entry point and a command host for this App. In a row-policy App the link is the grant for its one row
     and the policy is not asked (policy/appPolicyContext.ts withLink); a policy that did not load, or is not this
     App's, opens nothing, as a link that does not exist. */
  const commands = ctx.commands;
  const connection = appEntrypoint(host as never, registry);
  const policy = ctx.policy;
  if (
    ctx.policyUnavailable ||
    (policy ? !policy.matches(app) : isRowPolicyApp(app)) ||
    isTenantApp(app) ||
    !commands ||
    commands.appId !== appId ||
    !connection ||
    registry.configOf(connection)?.writable !== true
  )
    return linkDoor(door, undefined);

  /* Leased on first use, inside the door's try: a store that cannot load is the door's one miss. */
  const releases: Array<() => void> = [];
  let loaded: ReturnType<typeof loadAppRuntimeResources> | undefined;
  const resources = () => (loaded ??= loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner))));

  const backend: LinkBackend<JournalFound> = {
    commands: commands.registry,
    async lookUp(id, now) {
      const found = await lookUpLink(app, await resources(), id, now);
      return found ? { row: found.row, tenant: '', journal: found.journal } : undefined;
    },
    open: (found, now) => found.journal((journal) => journal.openLink?.(appId, found.row.id, now) ?? Promise.resolve(undefined)),
    async readRecord(found, key, columns) {
      const loadedResources = await resources();
      const reader = loadedResources.forConnection(loadedResources.connectionFor(found.row.resource));
      const read = await reader.query({ table: found.row.resource, columns: [...columns], filter: keyFilter(key), limit: 2, offset: 0 });
      return read.rows as Record<string, unknown>[];
    },
    revoke: (found, now) =>
      found.journal((journal) => journal.revokeLinks?.(appId, found.row.resource, found.row.rowKey, undefined, now) ?? Promise.resolve(0)),
    run: (_found, actor, route, envelope) =>
      policy
        ? policy.withLink(actor.link!, (context) => {
            if (!context.commands) throw new BusinessCommandExecutionError('forbidden', 'not_applied');
            /* The link's holder is known by the link alone: read as a visitor on a public form is. */
            const locale = requestLocale(app, { visitor: true, req });
            return dispatchScopedBusinessCommandHttp({
              req,
              res,
              path: `/api/commands/${route}`,
              commands: context.commands,
              body: envelope,
              ...(locale ? { locale } : {}),
            });
          })
        : dispatchBusinessCommandHttp({
            req,
            res,
            path: `/api/commands/${route}`,
            registry,
            app,
            commands: commands.registry,
            connection,
            actor,
            body: envelope,
            ...(commands.events ? { events: commands.events } : {}),
          }),
    mail: () => emailOf(registry),
    close: () => {
      for (const release of releases.reverse()) release();
    },
  };
  return linkDoor(door, backend);
}
