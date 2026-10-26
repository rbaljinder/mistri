/**
 * The database browser's POST routes that author rather than change data:
 * stored layouts and saved pages, the agent console's tool call, and a view
 * compiled without running. An App's rooms are its definition, so an App
 * server refuses the first two (appAuthoring.ts) and the last two are its
 * diagnostic tools, which it does not offer (appConnections.ts). A page's
 * plans, a record's references and a list's saved filters are both
 * products' (pageRoutes.ts).
 */
import { pagesPath, writeLayout, type StoredLayout } from '@mistriwork/engine/server/layouts.js';
import { normaliseView, styleFor } from '@mistriwork/engine/server/resourceReadHttp.js';
import { runTool } from '../mcp.js';
import { attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { PathError, compileView, explainView } from '@mistriwork/engine/shared/view.js';
import { suggestPage } from '@mistriwork/engine/shared/page.js';
import type { PageHooks } from '@mistriwork/engine/server/http/pageRoutes.js';
import { refuse, send } from '@mistriwork/engine/server/http/reply.js';
import type { PostContext } from '@mistriwork/engine/server/http/context.js';

/** The page routes in the database browser: a table's suggested page is the schema's, and its rules are the connection's. */
export const BROWSER_PAGES: PageHooks = { suggested: (post, table) => suggestPage(post.schema, table) };

export async function authoringRoutes(post: PostContext): Promise<boolean> {
  const { res, path, body, schema, registry, connection } = post;

  /**
   * Store a record layout, or remove one.
   *
   * Keyed by connection so a layout built against one database does not
   * quietly apply to another that happens to have a table of the same name.
   */
  if (path === '/api/layouts') {
    const table = String(body.table ?? '');
    if (!table) {
      send(res, 400, { error: 'A layout needs a table.' });
      return true;
    }
    const layout = body.layout === null ? null : (body.layout as StoredLayout | undefined);
    if (layout !== null && (!layout || typeof layout !== 'object')) {
      send(res, 400, { error: 'A layout must be an object, or null to remove it.' });
      return true;
    }
    try {
      await writeLayout(connection, table, layout);
    } catch (err) {
      send(res, 500, { error: `The layout file could not be written: ${(err as Error).message}` });
      return true;
    }
    send(res, 200, { ok: true });
    return true;
  }

  /**
   * Store a saved page, or remove one. The layout endpoint's twin: keyed by
   * connection, written through the same one-writer chain. A successful
   * response acknowledges the file write, not a browser-local draft.
   */
  if (path === '/api/pages/save') {
    const id = String(body.id ?? '');
    if (!id) {
      send(res, 400, { error: 'A page needs an id.' });
      return true;
    }
    const page = body.page === null ? null : (body.page as StoredLayout | undefined);
    if (page !== null && (!page || typeof page !== 'object')) {
      send(res, 400, { error: 'A page must be an object, or null to remove it.' });
      return true;
    }
    try {
      await writeLayout(connection, id, page, pagesPath());
    } catch (err) {
      send(res, 500, { error: `The pages file could not be written: ${(err as Error).message}` });
      return true;
    }
    send(res, 200, { ok: true });
    return true;
  }

  /**
   * Run one MCP tool over HTTP, for the agent console.
   *
   * Deliberately the same runTool the stdio loop uses, so the console's
   * whole claim — "this is what the agent sees" — is structural rather than
   * aspirational. Tool errors are results here as there; the connection is
   * whatever the arguments name, defaulting to the active one, exactly as
   * an agent's call would.
   */
  if (path === '/api/agent/call') {
    const name = String(body.name ?? '');
    const args = (body.arguments ?? {}) as Record<string, unknown>;
    // The console's writes are an agent's, made in the operator's name.
    send(res, 200, await attributeWrites({ via: 'agent' }, () => runTool(registry, name, args)));
    return true;
  }

  /**
   * Compile without running: the SQL panel while a view is still being built.
   *
   * Separate from running it because a view that is half-finished — three
   * fields chosen, no filter typed yet — is still worth showing the statement
   * for, and because compiling is free while running is not.
   */
  if (path === '/api/view/compile') {
    const view = normaliseView(body.view);
    try {
      const compiled = compileView(schema, view, styleFor(schema));
      send(res, 200, {
        sql: { text: compiled.text, params: compiled.params },
        explain: explainView(schema, view, styleFor(schema)),
        columns: compiled.columns,
        joins: compiled.joins,
        errors: [],
      });
      return true;
    } catch (err) {
      if (err instanceof PathError) {
        refuse(res, 400, [err.message]);
        return true;
      }
      throw err;
    }
  }

  return false;
}
