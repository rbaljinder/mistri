/**
 * A record at another person's address, sent on to this person's.
 *
 * A record's address is the first view showing its table among the views
 * the person reading is served (shared/appAddress.ts): a resident's repair is
 * `/my-requests/12`, the office's the same record at `/repairs/12`. A link
 * one of them pastes to the other names a view the other is not served, and
 * their browser would read it as nothing. So a signed-in request for an
 * address the whole App answers to but this person's book does not answers
 * 302 to the same record at their own address — or their notifications,
 * where none of their views shows it. Whether they may read that row is
 * asked after, as for any address: this says where, never what.
 *
 * Anything it cannot place is the shell as ever, which the client resolves.
 */
import { INBOX_SEGMENT, readAppSegments, recordSegments } from '../../shared/appAddress.js';
import { isRowPolicyApp } from '../../shared/app.js';
import { appRoutes } from '../app/apps.js';
import type { AppPolicyContext } from '../policy/appPolicyContext.js';
import { browserApp } from './appProjection.js';
import type { RequestContext } from '@mistriwork/engine/server/http/context.js';
import { publicAddressBook } from './publicPage.js';
import { resolveSource } from './source.js';

/** Where this signed-in person's copy of the address is, inside the mount; undefined to serve the page as asked. */
export async function personAddress(ctx: RequestContext): Promise<string | undefined> {
  const { req, path } = ctx;
  if ((req.method !== 'GET' && req.method !== 'HEAD') || path.startsWith('/api/')) return undefined;
  /* Only a page is moved. Under the dev client every module the browser fetches is a GET here too, and with an
     App at the root `/copy/lists/TableView.ts` reads as a record; asking each one cost Payday's page threefold. */
  if (!String(req.headers.accept ?? '').includes('text/html')) return undefined;
  const host = ctx.signedIn;
  if (!host?.auth || host.app.app.auth?.rows === 'tenant') return undefined;
  if (typeof ctx.identity.id !== 'string' || !ctx.identity.id.trim()) return undefined;
  const segments = path.split('/').filter(Boolean);
  // The App's id, a route, an id: only a record is moved.
  if (segments.length < 3) return undefined;
  const appId = host.app.app.id;
  let head: string;
  try {
    head = decodeURIComponent(segments[0]);
  } catch {
    return undefined;
  }
  if (head !== appId) return undefined;
  const rest = segments.slice(1);
  try {
    if (!(ctx.policy || ctx.policyUnavailable || isRowPolicyApp(host.app.app))) return await moved(ctx, rest);
    const policy = ctx.policy;
    if (ctx.policyUnavailable || !policy || !policy.matches(host.app.app)) return undefined;
    return await policy.withContext(req, async (context: AppPolicyContext) =>
      context.principal.kind === 'public' || context.principal.appId !== appId
        ? undefined
        : moved({ ...ctx, policyContext: context }, rest),
    );
  } catch {
    return undefined;
  }
}

async function moved(ctx: RequestContext, rest: string[]): Promise<string | undefined> {
  const host = ctx.signedIn!;
  const source = await resolveSource(ctx, host.app.app.id);
  const { app } = browserApp(ctx, source);
  if (!app || !source.schema) return undefined;
  /* This person's book, as their browser builds it from the payload it is served: an address it reads stays. */
  const mine = publicAddressBook(app, source.schema);
  if (readAppSegments(mine, rest)) return undefined;
  const parsed = readAppSegments(appRoutes(host.app, source.schema), rest);
  if (parsed?.kind !== 'record') return undefined;
  const at = recordSegments(mine, parsed.table, {
    key: parsed.key,
    ...(parsed.natural ? { natural: parsed.natural.value } : {}),
    ...(parsed.tab ? { tab: parsed.tab } : {}),
  });
  const there = at ?? (mine.routes.has(INBOX_SEGMENT) ? [INBOX_SEGMENT] : []);
  return `/${encodeURIComponent(host.app.app.id)}${there.length ? `/${there.join('/')}` : ''}${ctx.url.search}`;
}
