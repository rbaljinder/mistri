/**
 * The GET routes both products serve that shape a page rather than read its
 * rows: what could point at a table, its suggested page, the stored record
 * layouts and saved pages, and a list's saved filters.
 *
 * What a product decides of them is `PageReadHooks`: the page a table opens
 * on when nobody wrote one (an App's record anatomy, the database browser's
 * counts and lists), and whether the App signs people in, whose filters are
 * then each account's own.
 */
import { defaultColumns, metricColumns, relationsTo, resolvePath, type PageDef } from '../../shared/page.js';
import { filtersPath, filtersSection, layoutsFor, pagesPath, type StoredLayout } from '../layouts.js';
import type { ConfigLayout } from '../../shared/recordview.js';
import { referencesFrom, referencesTo, findTable, tableNamed, type DatabaseSchema } from '../../shared/schema.js';
import { send } from './reply.js';
import type { RequestContext, ResolvedSource } from './context.js';

export interface PageReadHooks {
  /** A table's page when nobody wrote one. */
  suggested(source: ResolvedSource, schema: DatabaseSchema, table: string): PageDef | null;
  /** Whether the App this source belongs to signs people in. */
  signsIn(ctx: RequestContext, source: ResolvedSource): boolean;
}

export async function pageReadRoutes(ctx: RequestContext, source: ResolvedSource, hooks: PageReadHooks): Promise<boolean> {
  const { res, url, path, configLayouts, identity, policyContext } = ctx;
  const { schema, access, connectionId, publicScope } = source;

  /**
   * The page for a table nobody has written one for.
   *
   * Asked for by table rather than shipped with the list, because it is
   * derived from the schema and the client has the schema — but the rule that
   * derives it lives in shared/page.ts, and a second copy in the browser is
   * the drift this codebase has paid for repeatedly.
   */
  /**
   * What a page about this table could show.
   *
   * The path is the one field nobody guesses when writing a page by hand, so
   * the builder does not ask for it — it asks the schema what points here and
   * offers the answers with their paths already written. Computed on the
   * server because the rules that resolve a path live in shared/page.ts, and
   * a second copy of them in the browser is the drift this codebase has paid
   * for in every feature that tried it.
   */
  if (path === '/api/pages/relations') {
    const table = String(url.searchParams.get('table') ?? '');
    if (!findTable(schema!, table)) {
      send(res, 404, { error: `Unknown table "${table}"` });
      return true;
    }
    const relations = relationsTo(schema!, table);
    const describe = (r: ReturnType<typeof relationsTo>[number]) => ({
      ...r,
      /* Numeric columns, for what a `sum` could be about. */
      columns: metricColumns(schema!, r.from),
      defaults: defaultColumns(findTable(schema!, r.from)!, r.path, resolvePath(schema!, r.from, r.path).path),
      all: findTable(schema!, r.from)!.columns.map((c) => c.name),
    });
    /* What points at each record this table points at, one reference out.

       This is how a work-order page offers "tickets at its site": the site is
       not the root, but the root names it, and the schema knows what points
       at a site. Direct relations only — the two-hop tail on a foreign
       record is a menu nobody has asked for yet. */
    const references = referencesFrom(schema!, table)
      .filter((fk) => fk.to.table !== table && findTable(schema!, fk.to.table))
      .map((fk) => {
        const target = findTable(schema!, fk.to.table)!;
        return {
          of: fk.from.columns.length === 1 ? fk.from.columns[0] : fk.name,
          target: target.id,
          targetName: target.name,
          via: fk.from.columns.join(', '),
          relations: relationsTo(schema!, target.id, 1).map(describe),
        };
      })
      .filter((ref) => ref.relations.length);
    send(res, 200, {
      ...publicScope,
      references,
      relations: relations.map((r) => ({
        ...r,
        /* Numeric columns, for what a `sum` could be about. */
        columns: metricColumns(schema!, r.from),
        /* And what a list of this relation shows when nobody has said —
           computed here, with the resolved path, because the rule that drops
           the constant column is the same one the planner uses. A builder
           that guessed at it would be a copy, and the copy would be the one
           that forgot composite keys. */
        defaults: defaultColumns(findTable(schema!, r.from)!, r.path, resolvePath(schema!, r.from, r.path).path),
        /* Every column, so the picker can offer the ones the default leaves
           out without a second request. */
        all: findTable(schema!, r.from)!.columns.map((c) => c.name),
      })),
    });
    return true;
  }

  if (path === '/api/pages/suggested') {
    const table = String(url.searchParams.get('table') ?? '');
    /* Two different failures, and they had one message between them: a table
       this connection does not have was reported as a table without a primary
       key, which sends the reader looking for a key on something that is not
       there. */
    if (!findTable(schema!, table)) {
      send(res, 404, { error: `Unknown table "${table}"` });
      return true;
    }
    /* An App's resource with no page of its own opens on the record anatomy
       (pageAnatomy.ts), dressed in the App's words; the Workbench keeps its
       page of counts and lists, the database as it is. */
    const suggested = hooks.suggested(source, schema!, table);
    if (!suggested) {
      send(res, 404, {
        error: `No page can be built for "${table}" — it needs a primary key to identify a record by.`,
      });
      return true;
    }
    send(res, 200, { ...publicScope, page: suggested });
    return true;
  }

  /**
   * Every stored record layout for this connection.
   *
   * Sent as a set rather than one at a time: the client needs to know which
   * tables have a layout to render the "Layout" affordance honestly, and a
   * request per table would be one round trip per row you walk to.
   */
  if (path === '/api/layouts') {
    if (access) {
      send(res, 200, { ...publicScope, layouts: {} });
      return true;
    }
    const saved = await layoutsFor(connectionId!);
    /* Config layouts fill in for tables nobody has laid out here, and never
       over one somebody has. A committed layout is the default a team starts
       from; the copy in this browser is what its reader chose afterwards, and
       silently replacing that would make the config file feel like it was
       fighting them. */
    const merged: Record<string, StoredLayout> = { ...saved };
    for (const layout of configLayouts) {
      if (layout.connection && layout.connection !== connectionId!) continue;
      const table = tableNamed(schema!, layout.table);
      if (!table) continue;
      if (merged[table.id]) continue;
      merged[table.id] = resolveConfigLayout(schema!, table.id, layout);
    }
    send(res, 200, { ...publicScope, layouts: merged });
    return true;
  }

  /** Every page saved for this connection, from the same kind of file. */
  if (path === '/api/pages/saved') {
    send(res, 200, { ...publicScope, pages: access ? {} : await layoutsFor(connectionId!, pagesPath()) });
    return true;
  }

  /**
   * The saved list filters — an App list's saved views, list → [{name, query}]
   * — and whose they are (`store`): the list the connection shares, the
   * signed-in account's own, or none where nothing may be kept.
   */
  if (path === '/api/filters') {
    const account = typeof identity.id === 'string' ? identity.id : undefined;
    const section = filtersSection(connectionId!, { signIn: hooks.signsIn(ctx, source), account, rowPolicy: Boolean(policyContext) });
    const store = section === null ? 'none' : section === connectionId ? 'shared' : 'account';
    send(res, 200, { ...publicScope, store, filters: section === null ? {} : await layoutsFor(section, filtersPath()) });
    return true;
  }

  return false;
}

/**
 * A config layout, with its list sections keyed the way the client expects.
 *
 * A list is stored against the constraint name of the foreign key pointing
 * back at the record — the right key, because a child can point at a parent
 * twice and the column alone would not say which — and the wrong thing to ask
 * anyone to type into a file. So a config may name the pair instead
 * (`"from": "invoice", "whose": "customer_id"`, parsed to the internal
 * `path`) and it is turned into the constraint here, where there is a schema
 * to turn it with.
 *
 * A pair that names no real relationship keeps its section and gains an
 * `error`, rather than disappearing: the same choice `/api/views` makes for a
 * view that will not compile. A layout that silently lost a list is a layout
 * nobody can debug.
 */
function resolveConfigLayout(schema: DatabaseSchema, tableId: string, layout: ConfigLayout): StoredLayout {
  const incoming = referencesTo(schema, tableId);
  const sections = layout.sections.map((section) => {
    if (section.kind !== 'list' || section.via) return section;
    const from = String(section.from ?? '');
    const column = String(section.path ?? '');
    const child = tableNamed(schema, from);
    const match =
      child && incoming.find((fk) => fk.from.table === child.id && fk.from.columns.some((c) => c.toLowerCase() === column.toLowerCase()));
    const { from: _from, path: _path, ...rest } = section;
    if (!match) {
      return {
        ...rest,
        via: '',
        error: `No foreign key from ${from}.${column} back to ${tableId}` + `${child ? '' : ` — and no table called "${from}"`}.`,
      };
    }
    return { ...rest, via: match.name };
  });
  return {
    id: `config-${layout.table}`,
    name: layout.name ?? 'From config',
    base: tableId,
    sections,
    source: 'config',
  } as StoredLayout;
}
