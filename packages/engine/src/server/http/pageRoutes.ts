/**
 * The POST routes both products serve that plan or keep rather than change
 * data: a page's section plans, a record's incoming references, and a list's
 * saved filters.
 *
 * What an App decides of them is `PageRules` (mistri: http/appAuthoring.ts):
 * whether its reader's fields reach a page, the record a row policy admits,
 * whether it signs people in (whose filters are each account's own), and its
 * failures said by code. The database browser plans what its connection
 * reads, and says a failure in the database's words.
 */
import type { Filter, Adapter } from '../../adapters/adapter.js';
import { pageAbouts } from '../../shared/pageModel.js';
import { resolveOf, validatePage, type PageDef } from '../../shared/page.js';
import { planPageSections } from '../../shared/pagePlans.js';
import { filtersPath, filtersSection, writeLayout } from '../layouts.js';
import { readRecords, readCounts } from '../resourceReadOperations.js';
import { AppAccessDenied } from '../columnGrants.js';
import { inBatches } from '../impact.js';
import { referencesTo, findTable, labelColumn, primaryKey, type DatabaseSchema } from '../../shared/schema.js';
import { httpRead, send } from './reply.js';
import type { PostContext } from './context.js';

/** An App's rules for the page routes. Absent, the database browser's. */
interface PageRules {
  /** Whether the App this request names signs people in: its saved filters are then each account's own. */
  signsIn(post: PostContext): boolean;
  /** Whether a reader whose grant names fields reads every field `page` shows (appFieldProjection.ts). */
  readsPage(schema: DatabaseSchema, page: PageDef): boolean;
  /** The record a row policy admits, or a refusal (appPolicyHttp.ts). */
  requireRecord(adapter: Adapter, schema: DatabaseSchema, table: string, key: Record<string, string | number>): Promise<unknown>;
  /** The record's own row, read as a row policy admits it, with the columns asked. */
  readRecord(
    adapter: Adapter,
    schema: DatabaseSchema,
    table: string,
    key: Record<string, string | number>,
    columns: string[],
  ): Promise<Record<string, unknown>>;
  /** A failure said by code, never in a driver's words (appErrors.ts). */
  said(error: unknown): { message: string; code: string };
}

/** What a product decides of the page routes. */
export interface PageHooks {
  /** A table's suggested page (`suggested:<table>`): the App's anatomy of it, or the schema's. */
  suggested(post: PostContext, table: string): PageDef | null;
  readonly rules?: PageRules;
}

export async function pageRoutes(post: PostContext, hooks: PageHooks): Promise<boolean> {
  const { res, path, body, adapter, schema, registry, connection, configPages, access, principal, rowPolicy, appNow } = post;
  const rules = hooks.rules;

  /**
   * The saved list filters for one list (`list`: an App list view's key,
   * not a table — two views over one table keep their own): a list of
   * {name, query}, written whole — the client owns ordering and dedupe, and reads the current list
   * before it writes — or null to remove the entry. The same store
   * discipline as saved pages, for the same reason: a filter that lives in
   * one browser dies with the browser. In a signed-in App the write lands in
   * the verified account's own section (layouts.ts); the body cannot name
   * another, and a request with no account that may keep one is refused.
   */
  if (path === '/api/filters/save') {
    const section = filtersSection(connection, { signIn: Boolean(rules?.signsIn(post)), account: principal, rowPolicy });
    if (section === null) {
      send(res, 403, { error: 'Saved views are kept per account here, and this request has none that may keep them.' });
      return true;
    }
    const list = String(body.list ?? '');
    if (!list) {
      send(res, 400, { error: 'Saved filters belong to a list.' });
      return true;
    }
    const filters = body.filters;
    if (filters !== null && !Array.isArray(filters)) {
      send(res, 400, { error: 'Filters must be a list, or null to remove them.' });
      return true;
    }
    /* Shape-checked per entry, refused not coerced: the store round-trips
       whatever it is handed, so junk accepted here is junk served to every
       browser from now on. */
    if (Array.isArray(filters)) {
      for (const f of filters) {
        const shaped =
          f &&
          typeof f === 'object' &&
          typeof (f as { name?: unknown }).name === 'string' &&
          typeof (f as { query?: unknown }).query === 'string';
        if (!shaped) {
          send(res, 400, { error: 'Each saved filter must be { name, query }, both strings.' });
          return true;
        }
      }
    }
    try {
      // An array is as opaque to the store as a layout object; it only
      // round-trips what the client wrote.
      await writeLayout(section, list, filters ?? null, filtersPath());
    } catch (err) {
      /* Unlike layouts, filters keep no localStorage mirror — a failed write
         means the filter is saved nowhere, and the message must say so. */
      send(
        res,
        500,
        rules
          ? { error: 'The filter could not be saved. Try again shortly.', code: 'definition_save_failed' }
          : { error: `The filter was not saved — the filters file could not be written: ${(err as Error).message}` },
      );
      return true;
    }
    send(res, 200, { ok: true });
    return true;
  }

  /**
   * What each section of a page needs to run, for one root record.
   *
   * One call for the whole page rather than one per section, and it returns
   * *plans* rather than results: the client runs each view itself, so a count
   * over a large child table does not hold up the record's own name. Waiting
   * for all of them would make the slowest section the speed of the page.
   *
   * The views are built here because building them is path resolution against
   * a schema, and a second copy of those rules in the browser is the drift
   * this codebase has paid for in every feature that tried it.
   *
   * A section that cannot be built comes back with its reason, in place. One
   * bad path must not cost the other five sections — a page is most useful on
   * exactly the day something is misconfigured.
   */
  if (path === '/api/pages/plan') {
    const key = (body.key ?? {}) as Record<string, string | number>;
    const name = registry.list().find((c) => c.id === connection)?.name;

    /* A page arrives either as a name or as itself.

       Pages come from three places: the config file, the schema, and the
       builder — and the third lives in the browser's own storage, which the
       server has never seen. Planning by id alone meant a page someone had
       just built could be listed, opened and titled, and then rendered as
       "there is no page called that", because the only part that needed the
       schema was the part that had never heard of it.

       Handing the definition over is safe for the same reason a filter is: it
       is structured, it is validated against this connection before anything
       runs, and every value in it ends up bound rather than written into
       SQL. */
    const asked = body.page;
    const found =
      typeof asked === 'object' && asked !== null
        ? (asked as PageDef)
        : String(asked ?? '').startsWith('suggested:')
          ? hooks.suggested(post, String(asked).slice('suggested:'.length))
          : configPages.find(
              (p) => p.id === String(asked ?? '') && (!p.connection || p.connection === connection || p.connection === name),
            );
    if (!found) {
      send(res, 404, { error: `There is no page called "${String(asked ?? '')}".` });
      return true;
    }
    if (access && !access.readable.has(found.base)) throw new AppAccessDenied();
    if (access?.fields && rules && !rules.readsPage(schema, found)) throw new AppAccessDenied();
    if (typeof found.base !== 'string' || !Array.isArray(found.sections)) {
      send(res, 400, { error: 'That is not a page: it needs a "base" table and a list of sections.' });
      return true;
    }

    const page = validatePage(schema, found);
    if (page.error) {
      send(res, 400, { error: page.error });
      return true;
    }

    const base = findTable(schema, page.base)!;
    const missing = primaryKey(base).filter((c) => key[c] === undefined);
    if (missing.length) {
      send(res, 400, {
        error: `This page is about one ${base.name}, and the key is missing ${missing.join(', ')}.`,
      });
      return true;
    }
    if (rowPolicy && rules) await rules.requireRecord(adapter, schema, page.base, key);

    /* Sections about a record the root points at need that record's key,
       which only the root row knows. One read, of just the reference
       columns, shared by every such section — and a reference that is null
       resolves to `null`, which the section renders as its empty state
       rather than as a filter that can never match. */
    const ofs = pageAbouts(page);
    const ofKeys: import('../../shared/page.js').OfKeys = {};
    if (ofs.length) {
      const resolvedOfs = ofs.map((of) => ({ of, ...resolveOf(schema!, page.base, of) })).filter((r) => r.fk);
      const wanted = [...new Set(resolvedOfs.flatMap((r) => r.fk!.from.columns))];
      if (wanted.length) {
        const row = (
          await httpRead(() =>
            readRecords(adapter, schema, {
              table: page.base,
              filter: { groups: [primaryKey(base).map((c) => ({ column: c, op: '=' as const, value: key[c] }))] },
              columns: wanted,
              limit: 1,
              offset: 0,
            }),
          )
        ).result.rows[0] as Record<string, string | number | null> | undefined;
        for (const r of resolvedOfs) {
          const values = r.fk!.from.columns.map((c) => row?.[c]);
          ofKeys[r.of] = values.every((v) => v !== null && v !== undefined)
            ? Object.fromEntries(r.fk!.to.columns.map((c, i) => [c, values[i] as string | number]))
            : null;
        }
      }
    }

    /* A matched list shares the record's own values, so they are read here,
       on the server, from the record's row — never taken from the request.
       Read through the same scoped adapter, so a value the reader may not
       read is refused like any other read of it. */
    const likeColumns = [
      ...new Set(
        page.sections.flatMap((s) => (s.kind === 'list' && s.similar ? [...s.similar.same, ...Object.keys(s.similar.near ?? {})] : [])),
      ),
    ];
    let rootValues: Record<string, unknown> | undefined;
    if (likeColumns.length) {
      rootValues = ((
        await httpRead(() =>
          readRecords(adapter, schema, {
            table: page.base,
            filter: { groups: [primaryKey(base).map((c) => ({ column: c, op: '=' as const, value: key[c] }))] },
            columns: likeColumns,
            limit: 1,
            offset: 0,
          }),
        )
      ).result.rows[0] ?? {}) as Record<string, unknown>;
    }

    // Capture once after root lookup: every section uses the same App date.
    const plans = planPageSections(schema, page, key, ofKeys, appNow(), rootValues);
    send(res, 200, { page, plans });
    return true;
  }

  /**
   * The endpoint the whole tool exists for: given one row, how many rows in
   * every other table point at it, and what would you click to see them.
   *
   * Counting is done server-side and in parallel because a row in a
   * well-normalised schema can be referenced from a dozen places, and a dozen
   * sequential round trips is the difference between instant and sluggish.
   */
  if (path === '/api/references') {
    const tableId = String(body.table ?? '');
    const key = (body.key ?? {}) as Record<string, string | number>;
    const table = findTable(schema, tableId);
    if (!table) {
      send(res, 404, { error: `Unknown table "${tableId}"` });
      return true;
    }
    const incoming = referencesTo(schema, tableId);
    /* A declared reference may point at a column that is not this row's key
       (a code, a slug): its value is the row's, so the row is read for it,
       in the one read a row policy makes to admit the record anyway. */
    const unkeyed = [...new Set(incoming.flatMap((fk) => fk.to.columns))].filter((column) => !Object.hasOwn(key, column));
    let row: Record<string, unknown> = key;
    if (rowPolicy && rules) row = { ...(await rules.readRecord(adapter, schema, tableId, key, unkeyed)), ...key };
    else if (unkeyed.length && Object.keys(key).length) {
      const { result } = await readRecords(adapter, schema, {
        table: table.id,
        columns: unkeyed,
        limit: 1,
        offset: 0,
        filter: { groups: [Object.entries(key).map(([column, value]) => ({ column, op: '=' as const, value }))] },
      });
      row = { ...result.rows[0], ...key };
    }

    /* Every reference counted in one statement where the reader can say it
       in one (readCounts), each bounded: past DEFAULT_COUNT_LIMIT the answer
       is the bound and `capped`, and the panel says "10,000+". These were a
       filtered, unbounded COUNT(*) apiece, four at a time — on a hub table
       with a dozen incoming keys, a dozen scans against the connection
       serving the page they are for, most of them over unindexed columns. */
    const described = incoming
      .map((fk) => {
        /* Every column of the key has to match, which is what makes this
         correct for composite keys and not just single-column ones. */
        const conditions = fk.to.columns.map((toCol, i) => ({
          column: fk.from.columns[i] ?? fk.from.columns[0],
          op: '=' as const,
          value: row[toCol] as string | number,
        }));
        const usable = conditions.every((c) => c.value !== undefined && c.value !== null);
        const filter: Filter = { groups: [conditions] };
        return usable
          ? {
              fk,
              filter,
              base: {
                table: fk.from.table,
                columns: fk.from.columns,
                // The matching key columns on this row's side, so the client can
                // pair them by position rather than guessing from key order.
                toColumns: fk.to.columns,
                constraint: fk.name,
                filter,
                label: labelColumn(findTable(schema, fk.from.table)!),
              },
            }
          : null;
      })
      .filter((item) => item !== null);
    /* A source that reports no totals (an API) is not asked for one: the
       reference is listed without a count, and the panel's own read of its
       rows says what is there. Asking would only ever be refused. */
    const countable = described.filter((item) => findTable(schema, item.fk.from.table)?.countable !== false);
    const failed = (err: unknown) => {
      const said = rules?.said(err);
      return { count: -1, error: said ? said.message : (err as Error).message, ...(said ? { code: said.code } : {}) };
    };
    const counts = new Map<string, { count: number; capped?: true } | ReturnType<typeof failed>>();
    try {
      const answered = countable.length
        ? await readCounts(
            adapter,
            schema,
            countable.map((item) => ({ table: item.fk.from.table, filter: item.filter })),
          )
        : [];
      countable.forEach((item, i) =>
        counts.set(item.fk.name, { count: answered[i].count, ...(answered[i].capped ? { capped: true as const } : {}) }),
      );
    } catch {
      /* One unreadable table (permissions, a dropped view) should not blank
         the whole panel: asked again one at a time, each failure stays in
         its own row. A small window, as before, so the record itself can
         still be answered on the same connection. */
      await inBatches(countable, 4, async (item) => {
        try {
          const [one] = await readCounts(adapter, schema, [{ table: item.fk.from.table, filter: item.filter }]);
          counts.set(item.fk.name, { count: one.count, ...(one.capped ? { capped: true as const } : {}) });
        } catch (err) {
          counts.set(item.fk.name, failed(err));
        }
      });
    }
    const results = described.map((item) => ({ ...item.base, ...counts.get(item.fk.name) }));

    send(res, 200, {
      table: tableId,
      primaryKey: primaryKey(table),
      references: results,
    });
    return true;
  }

  return false;
}
