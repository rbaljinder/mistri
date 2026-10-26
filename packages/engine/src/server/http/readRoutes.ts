/**
 * The GET reads that need a resolved database: the schema and the
 * connection-scoped halves of the config file — views, saved SQL, a table's
 * DDL. What a product draws around the data (`ReadHooks.projection`: an
 * App's payload and pages, or the database browser's) sits between them in
 * the same chain, and a resource whose rows are files is the App's
 * (`ReadHooks.file`, appFileRead.ts).
 */
import { validateView, type ViewDef } from '../../shared/view.js';
import { textToView, viewToTextWithSchema } from '../../shared/viewtext.js';
import { queriesFor } from '../../shared/sqlsaved.js';
import { findTable, renderDDL, type DatabaseSchema } from '../../shared/schema.js';
import { send, sendRevalidated } from './reply.js';
import { principalOf, type RequestContext, type ResolvedSource } from './context.js';

/** The `Sec-Fetch-Dest` values that load what they fetch as code. */
const SCRIPT_DESTINATIONS = new Set(['script', 'style', 'worker', 'sharedworker', 'serviceworker', 'audioworklet', 'paintworklet', 'xslt']);

/** What a product serves among the reads. */
export interface ReadHooks {
  /** What the client draws around the data: the App, its pages, the stored layouts and filters. True when answered. */
  projection(ctx: RequestContext, source: ResolvedSource): Promise<boolean>;
  /** One file's bytes, from a resource whose rows are files. False where the resource holds none. */
  file?(ctx: RequestContext, source: ResolvedSource): Promise<boolean>;
}

export async function readRoutes(ctx: RequestContext, source: ResolvedSource, hooks: ReadHooks): Promise<boolean> {
  const { res, url, path, registry, configViews, configQueries } = ctx;
  const { adapter, schema, access, connectionId, publicScope, publicDefinition } = source;

  /**
   * Views defined in the config file, for the connection in hand.
   *
   * Saved views live in the browser, per connection — they are one person's
   * working set, and writing them into a file the server owns would make a
   * page silently edit something on disk. Config views are the shared half:
   * checked into a repo, the same for everyone, and read-only from here.
   *
   * A view whose base table does not exist on this connection is returned
   * *with its reason* rather than dropped. Dropping it shows a shorter list
   * and no explanation, which is the failure this whole tool argues against.
   */
  if (path === '/api/views') {
    const name = registry.list().find((c) => c.id === connectionId!)?.name;
    const mine = configViews.filter((v) => !v.connection || v.connection === connectionId! || v.connection === name);
    send(res, 200, {
      ...publicScope,
      views: access ? [] : mine.map((v) => publicDefinition(materialise(schema!, v))),
    });
    return true;
  }

  if (path === '/api/schema') {
    sendRevalidated(res, schema!, principalOf(ctx.identity));
    return true;
  }

  /**
   * One file's bytes, from a resource whose rows are files (`file` on the
   * resource). The read is the ordinary query, so the App's table and field
   * grants apply to it, asked for the bytes instead of their label. A
   * download, unless `inline=1` asks for a picture and the bytes are one: a
   * stored type is only the uploader's claim, so it never decides either.
   * `variant=thumb` asks for the resource's smaller copy (`file.thumbnail`),
   * which a card draws at a third of the width; a resource or a row without
   * one answers with the file itself.
   */
  if (path === '/api/file') {
    /* An upload is never code to run. A page that loads one as a script or a
       stylesheet (`<script src="/api/file?…">`) asks with its destination,
       and is refused before anything is read: with nosniff and a download's
       type the browser would refuse it too, but only if it honours both. */
    if (SCRIPT_DESTINATIONS.has(String(ctx.req.headers['sec-fetch-dest'] ?? '').toLowerCase())) {
      send(res, 403, { error: 'A file is not served as a script or a stylesheet.' });
      return true;
    }
    if (!(await hooks.file?.(ctx, source))) send(res, 404, { error: 'This resource does not hold files.' });
    return true;
  }

  if (await hooks.projection(ctx, source)) return true;

  /**
   * SQL statements the config file names, for the connection in hand.
   *
   * The committable half of saved SQL. The other half lives in the browser,
   * and the client merges them — a statement someone checked in and one you
   * saved this morning are the same kind of thing to whoever is looking for
   * one, and only differ in whether you may delete it.
   */
  if (path === '/api/queries') {
    const name = registry.list().find((c) => c.id === connectionId!)?.name;
    send(res, 200, {
      connection: connectionId!,
      queries: queriesFor(configQueries, connectionId!, name),
    });
    return true;
  }

  /**
   * A table's definition. `exact` tells the client whether it is looking at
   * the database's own stored DDL or a reconstruction from the catalog, so
   * the page can label it rather than implying an authority it lacks.
   */
  if (path === '/api/ddl') {
    const tableId = url.searchParams.get('table') ?? '';
    if (!findTable(schema!, tableId)) {
      send(res, 404, { error: `Unknown table "${tableId}"` });
      return true;
    }
    const stored = adapter!.ddl ? await adapter!.ddl(tableId) : undefined;
    send(res, 200, {
      table: tableId,
      sql: stored ?? renderDDL(schema!, tableId),
      exact: Boolean(stored),
    });
    return true;
  }

  return false;
}

/**
 * Expand a config view against a live schema, and say what is wrong with it.
 *
 * A view written as text cannot be expanded when the config file is read —
 * there is no connection open yet, and the text names tables. So it is
 * carried through and resolved here, where a schema exists. Both halves are
 * returned: the structure, so the composer can edit it by clicking, and the
 * text, so it can be read and edited as a statement.
 *
 * A view that does not resolve comes back *with its reason*, never dropped.
 * Dropping it gives someone a shorter list and no explanation, which is the
 * failure this whole tool argues against.
 */
function materialise(schema: DatabaseSchema, view: ViewDef): ViewDef & { error?: string } {
  if (!view.text) {
    const error = validateView(schema, view);
    return { ...view, error, text: error ? undefined : viewToTextWithSchema(schema, view) };
  }
  const parsed = textToView(schema, view.text, { id: view.id, name: view.name });
  if (!parsed.view || parsed.errors.length) {
    return { ...view, error: parsed.errors[0]?.message ?? `"${view.name}" could not be read.` };
  }
  const expanded: ViewDef = { ...parsed.view, source: view.source, connection: view.connection, text: view.text };
  return { ...expanded, error: validateView(schema, expanded) };
}
