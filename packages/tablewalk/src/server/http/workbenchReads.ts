/**
 * What the database browser draws around the data (readRoutes.ts
 * `ReadHooks.projection`): no App — `app: null` is an answer, and the client
 * draws the ordinary sidebar — the pages the config file names for the
 * connection in hand, and the page-shaping reads both products serve
 * (pageReads.ts), with the schema's suggested page and no sign-in.
 */
import { suggestPage, validatePage } from '@mistriwork/engine/shared/page.js';
import { withAvailablePageEmptyActions } from '@mistriwork/engine/shared/pageEmptyActions.js';
import { send, sendRevalidated } from '@mistriwork/engine/server/http/reply.js';
import { principalOf, type RequestContext, type ResolvedSource } from '@mistriwork/engine/server/http/context.js';
import { pageReadRoutes, type PageReadHooks } from '@mistriwork/engine/server/http/pageReads.js';

const PAGE_READS: PageReadHooks = { suggested: (_source, schema, table) => suggestPage(schema, table), signsIn: () => false };

export async function workbenchReads(ctx: RequestContext, source: ResolvedSource): Promise<boolean> {
  const { res, path, registry, identity, configPages } = ctx;
  const { schema, connectionId, publicScope, publicDefinition } = source;
  if (path === '/api/app/live') {
    send(res, 404, { error: 'Saves to this App are not followed here.' });
    return true;
  }
  if (path === '/api/app') {
    sendRevalidated(res, { app: null, ...publicScope }, principalOf(identity));
    return true;
  }
  /**
   * Pages the config file names, for the connection in hand, checked against
   * its schema here (appProjection.ts says why) and returned with their
   * reason when they do not fit it. A page's way on to a room goes: there are
   * no rooms here.
   */
  if (path === '/api/pages') {
    const name = registry.list().find((c) => c.id === connectionId)?.name;
    const mine = configPages.filter((p) => !p.connection || p.connection === connectionId || p.connection === name);
    let pages = mine.map((p) => publicDefinition(validatePage(schema, p)));
    if (pages.some((page) => page.sections.some((section) => section.kind === 'list' && section.empty?.action)))
      pages = withAvailablePageEmptyActions(pages, { views: {} });
    sendRevalidated(res, { ...publicScope, pages }, principalOf(identity));
    return true;
  }
  return pageReadRoutes(ctx, source, PAGE_READS);
}
