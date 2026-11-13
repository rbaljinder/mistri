/**
 * Business commands over HTTP: the App's own verbs, for a signed-in actor,
 * against the entry point — or inside the row-policy context when the
 * deployment has one.
 */
import { appEntrypoint } from '../app/appEntrypoint.js';
import { dispatchBusinessCommandHttp, dispatchScopedBusinessCommandHttp } from '../commands/businessCommandHttp.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import { clientAddress, publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { COMMAND_ROUTES } from '../../shared/commandRoutes.js';
import { commandActionLabel } from '../recordHistory.js';
import { sessionActorWords } from '../app/appStamps.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { captureHttpCommandFlags } from '../flags/httpRuntime.js';
import { stageFileHttp } from '../commands/stagedFileHttp.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { servesLinks, withLinkUrls } from '../links/linkLookup.js';
import { withAppPublicUrls } from '../links/publicLink.js';
import { personLocale, requestLocale } from '../app/readerLocale.js';

/**
 * `body`: the command's body where it was read already — availability asked
 * inside a record page's composed read (recordCompose.ts), which passes its
 * own reply and refusal in `ctx` and goes through every check below.
 */
export async function commandRoutes(ctx: RequestContext, body?: unknown): Promise<boolean> {
  const { req, res, url, path, registry, commands, identity, signedIn, commandRequest, commandRefusal, policyContext } = ctx;
  const given = body === undefined ? {} : { body };

  if (commandRequest) {
    if (!signedIn?.auth || !identity.id) {
      commandRefusal('unauthenticated');
      return true;
    }
    /* A step's check has its own budget, 60 a minute from one client, apart from what it may run. */
    if (path === COMMAND_ROUTES.check) {
      const decision = await publicFormLimiter('check').take(clientAddress(req, ctx.bound.trustedProxies));
      if (!decision.ok) {
        res.setHeader('retry-after', String(decision.retryAfterSeconds));
        send(res, 429, {
          code: 'rate_limited',
          error: `Too many checks. Try again in ${decision.retryAfterSeconds} seconds.`,
          retryAfter: decision.retryAfterSeconds,
        });
        return true;
      }
    }
    if (!commands || commands.appId !== signedIn.app.app.id) {
      commandRefusal('forbidden');
      return true;
    }
    if (url.searchParams.has('conn') || (url.searchParams.has('app') && url.searchParams.get('app') !== commands.appId)) {
      commandRefusal('forbidden');
      return true;
    }
    if (policyContext) {
      /* A row policy's commands run in its own transaction and journal, which hold no files: its forms take none. */
      if (!policyContext.commands || path === COMMAND_ROUTES.files) {
        commandRefusal('forbidden');
        return true;
      }
      res.setHeader('x-mistri-app', signedIn.app.app.id);
      /* Their own row, read under their own rows as their pages read it (http/source.ts); else their pick. */
      const person =
        path === COMMAND_ROUTES.execute || path === COMMAND_ROUTES.draft
          ? await personLocale(signedIn.app.app, policyContext.schema, policyContext.data, {
              email: sessionActorWords(identity).email,
              account: identity.id,
            }).catch(() => undefined)
          : undefined;
      const locale = requestLocale(signedIn.app.app, { ...(person ? { person } : {}), visitor: false, req });
      const result = await dispatchScopedBusinessCommandHttp({
        req,
        res,
        path,
        commands: policyContext.commands,
        label: (body) => commandActionLabel(signedIn.app.app, body),
        ...given,
        ...(locale ? { locale } : {}),
      });
      send(res, 200, path === COMMAND_ROUTES.execute ? await policyLinkUrls(ctx, result) : result);
      return true;
    }
    const connection = appEntrypoint(signedIn, registry);
    // No one connection the App names is how this deployment is set up, not a while: a retry would never succeed.
    if (!connection) {
      commandRefusal('forbidden');
      return true;
    }
    res.setHeader('x-mistri-app', signedIn.app.app.id);
    const actor = {
      id: identity.id,
      appId: signedIn.app.app.id,
      roles: (identity.role ?? '')
        .split(',')
        .map((role) => role.trim())
        .filter(Boolean),
      ...sessionActorWords(identity),
    };
    /* A file held for a command's files field, under the grant that runs the command (stagedFiles.ts). */
    if (path === COMMAND_ROUTES.files) {
      await stageFileHttp(ctx, connection, actor);
      return true;
    }
    const result = await dispatchBusinessCommandHttp({
      req,
      res,
      path,
      registry,
      connection,
      captureFlags: captureHttpCommandFlags,
      app: signedIn.app.app,
      commands: commands.registry,
      ...(commands.events ? { events: commands.events } : {}),
      label: (body) => commandActionLabel(signedIn.app.app, body),
      ...given,
      actor,
    });
    send(res, 200, result);
    return true;
  }

  return false;
}

/* A link a row-policy command minted is said as its URL to whoever ran it, as on the unscoped path
   (businessCommandHttp.ts): the receipt keeps the reference only. The link's row is the platform's, read by id. */
async function policyLinkUrls(ctx: RequestContext, answer: unknown): Promise<unknown> {
  const app = ctx.signedIn?.app.app;
  if (!app) return answer;
  const result = await withAppPublicUrls(app, answer);
  if (!servesLinks(app)) return result;
  const connection = appEntrypoint(ctx.signedIn as never, ctx.registry);
  if (!connection) return result;
  const releases: Array<() => void> = [];
  try {
    const resources = await loadAppRuntimeResources(ctx.registry, app, connection, (owner) => releases.push(ctx.registry.lease(owner)));
    return await withLinkUrls(app, resources, result);
  } finally {
    for (const release of releases.reverse()) release();
  }
}
