/**
 * An App's pages: keyed by id (`pages.<id>`), or one file per page under
 * `pages/`, the file's basename its key. The body is the shared page body —
 * the one `mistri.json` pages, the page builder and `mistri check` use —
 * minus `id`, which is the key. `mistri.json` pages stay an array with
 * `id`; that contract is page.ts's and is untouched here.
 *
 * A page's `base`, section `from` and stream `from` are resource slots: a
 * dot in one is a source qualifier. `resources.<table>.page` chooses the
 * page a resource's records open through when two share its base; the
 * loader orders that page first among them (the client takes the first).
 */
import { parseRealm, type AppDef, type AppListView } from './appModel.js';
import { PAGE_KEY, isRecord } from '@mistriwork/engine/shared/model.js';
import { parsePageBody, type PageDef, type PageList } from '@mistriwork/engine/shared/page.js';
import { APP_PAGE_KEYS } from '@mistriwork/engine/shared/pageConfig.js';
import { andQuery, splitClauseTail } from '@mistriwork/engine/shared/query.js';
import { listPresentationColumns } from '@mistriwork/engine/shared/appListColumns.js';
import { parseRoutePath } from './appAddress.js';
import { checkResourceSlot, sourceScopeOf, type SourceScope } from './appResourceBlocks.js';
import { unfoldSegments } from './appSegments.js';
import { composeFeatures } from './appFeatures.js';
import { withProvenance } from './appProvenance.js';
import { AppProblems, gather } from './appProblems.js';
import { parseOpenRoles } from './appViewRoles.js';
import { documentProblems, documentSections, isDocument, parseDocument } from '@mistriwork/engine/shared/appDocuments.js';
import { tabWord } from '@mistriwork/engine/shared/addressParams.js';
import { applyPageLayout, chooseLayout } from '@mistriwork/engine/shared/pageLayouts.js';

/** The manifest's own `pages`, keyed. Pages under `pages/` come through parseAppPage. */
export function parseAppPages(raw: unknown, where: string): PageDef[] {
  // Composition (appFeatures.ts): a feature's pages are the App's, each keyed once, and a refusal names the feature.
  const { root, origins } = composeFeatures(raw, where);
  const pages = isRecord(root) ? root.pages : undefined;
  if (pages === undefined) return [];
  if (!isRecord(pages)) throw new Error(`${where}: "pages" must be an object of pages keyed by id.`);
  const scope = sourceScopeOf(root);
  return withProvenance(origins, where, () => {
    // Each page is judged on its own, so one run names every page's refusal (appProblems.ts).
    const problems: string[] = [];
    const parsed = Object.entries(pages).map(([key, body]) =>
      gather(problems, () => parseAppPage(body, key, `${where}: pages "${key}"`, scope)),
    );
    if (problems.length) throw new AppProblems(problems);
    return parsed as PageDef[];
  });
}

export function parseAppPage(authored: unknown, key: string, at: string, scope: SourceScope): PageDef {
  if (!PAGE_KEY.test(key)) throw new Error(`${at}: a page key is its id, and must be lowercase letters, digits, hyphens and underscores.`);
  if (!isRecord(authored)) throw new Error(`${at} is not an object.`);
  // A segment a section names is its word in that section's query from here on (appSegments.ts).
  const body = unfoldSegments(authored, scope.segments ?? {}, at) as Record<string, unknown>;
  // `realm` is the platform realm's word, checked against the base once the
  // App is whole (appTenancy.ts); the body parser reads a page alone.
  // `path` is an App page's address (appAddress.ts); a mistri.json page has none.
  // `roles` too is an App page's, judged against auth.roles once the App is whole (orderAppPages).
  // `document` puts the page on paper (appDocuments.ts): its sections are judged as paper draws them.
  const { realm, path, roles, document, ...rest } = body;
  const page = parsePageBody(
    rest,
    at,
    key,
    false,
    typeof body.base === 'string' ? scope.nouns?.[body.base.trim()] : undefined,
    APP_PAGE_KEYS,
  );
  // A record page that declares no aside is given one of the record's remaining fields (pageAnatomy.ts), unless it says `aside: false`.
  if (page.aside !== false && document === undefined) page.defaultAside = true;
  // Paper has one layout; the archetypes are a screen's (pageLayouts.ts). document() hands its options to the paper.
  if (document !== undefined && (page.layout !== undefined || (isRecord(document) && document.layout !== undefined)))
    throw new Error(`[page-layout] ${at} is a document, and a document has one layout, paper's. Remove "layout".`);
  // A screen page that names no layout is drawn in the one its sections make, chosen here, once, before any row is read.
  if (page.layout === undefined && document === undefined) {
    const chosen = chooseLayout(page);
    if (chosen.layout !== 'record') Object.assign(page, { layout: chosen.layout, layoutWhy: chosen.why });
  }
  applyPageLayout(page, at);
  if (realm !== undefined) page.realm = parseRealm(realm, at);
  if (path !== undefined) page.path = parseRoutePath(path, at);
  if (roles !== undefined) page.roles = roles as string[];
  if (document !== undefined) {
    if (path !== undefined) throw new Error(`${at}: a document is addressed under its record (/<record>/${key}), so it has no "path".`);
    page.document = parseDocument(document, at);
    page.sections = documentSections(page.sections, at);
  }
  checkResourceSlot(page.base, `${at}, "base"`, scope);
  page.sections.forEach((section, i) => {
    if (section.kind === 'timeline') {
      section.streams.forEach((stream, j) => checkResourceSlot(stream.from, `${at}, section ${i + 1}, stream ${j + 1}, "from"`, scope));
    } else if (section.kind === 'custom') {
      for (const [name, read] of Object.entries(section.reads ?? {}))
        checkResourceSlot(read.from, `${at}, section ${i + 1}, rows "${name}", "from"`, scope);
      for (const [name, total] of Object.entries(section.aggregates ?? {}))
        checkResourceSlot(total.from, `${at}, section ${i + 1}, figures "${name}", "from"`, scope);
      // A note names no table, and an embed's is its view's (resolvePageEmbeds).
    } else if (
      section.kind !== 'fields' &&
      section.kind !== 'note' &&
      section.kind !== 'history' &&
      section.kind !== 'flows' &&
      section.kind !== 'diagram' &&
      !(section.kind === 'list' && section.view !== undefined)
    ) {
      checkResourceSlot(section.from, `${at}, section ${i + 1}, "from"`, scope);
    }
  });
  return page;
}

/**
 * `resources.<table>.page`, judged against every page the App declares (the
 * manifest's and pages/'s), and applied: that page moves to the front of the
 * pages over its table.
 */
export function orderAppPages(app: AppDef, pages: readonly PageDef[], where: string): PageDef[] {
  let ordered = resolvePageEmbeds(app, pages, where).map((page) =>
    page.roles === undefined ? page : { ...page, roles: parseOpenRoles(page.roles, `${where}: pages "${page.id}"`, app.auth)! },
  );
  const clashes = documentProblems(
    ordered,
    Object.fromEntries(Object.entries(app.resources ?? {}).map(([resource, block]) => [resource, block.page])),
    tabWord,
    where,
  );
  if (clashes.length) throw new AppProblems(clashes);
  for (const [resource, { page: id }] of Object.entries(app.resources ?? {})) {
    if (id === undefined) continue;
    const at = `${where}: resources "${resource}", "page"`;
    const page = ordered.find((candidate) => candidate.id === id);
    if (!page) {
      throw new Error(
        `${at} names the page "${id}", which this App does not declare. It declares: ${ordered.map((candidate) => candidate.id).join(', ') || 'no pages'}.`,
      );
    }
    if (page.base !== resource) throw new Error(`${at} names the page "${id}", whose base is "${page.base}", not "${resource}".`);
    // A document is never the page a record opens through, so it is not one of the pages chosen between.
    const over = ordered.filter((candidate) => candidate.base === resource && !isDocument(candidate));
    if (over.length < 2) {
      throw new Error(`${at} chooses between the pages over "${resource}", and there is one: it is already the default. Remove "page".`);
    }
    const first = ordered.indexOf(over[0]);
    ordered = ordered.filter((candidate) => candidate !== page);
    ordered.splice(first, 0, page);
  }
  return ordered;
}

/**
 * A page's `embed(view, { whose })` and note actions, judged against the
 * App's views once the App is whole. An embed becomes the related list it
 * draws as — the view's table, its show (or its card's lines), its standing
 * query and first tab, its order and its cards — keeping the view's key, so
 * one related-list renderer draws both and the two cannot drift. Only the
 * view's rows that point at the record are listed: the `whose` narrows them.
 */
export function resolvePageEmbeds(app: AppDef, pages: readonly PageDef[], where: string): PageDef[] {
  const lists = Object.entries(app.views)
    .filter((entry): entry is [string, AppListView] => 'table' in entry[1] && !('command' in entry[1]))
    .map(([key]) => key);
  return pages.map((page) => ({
    ...page,
    sections: page.sections.map((section, i) => {
      const at = `${where}: page "${page.id}", section ${i + 1}`;
      if (section.kind === 'note' && section.action && 'view' in section.action) {
        const target = Object.hasOwn(app.views, section.action.view) ? app.views[section.action.view] : undefined;
        if (!target || 'command' in target || 'form' in target || 'landing' in target) {
          throw new Error(
            `${at} is a note whose action opens "${section.action.view}", which is not a list or dashboard view this App declares.`,
          );
        }
        return section;
      }
      if (section.kind === 'list' && section.create && section.from)
        return { ...section, create: withFormDefaults(app, section.from, section.create) };
      if (section.kind === 'timeline' && section.create)
        return { ...section, create: withFormDefaults(app, section.streams[0].from, section.create) };
      if (section.kind !== 'list' || section.view === undefined || section.from) return section;
      const view = Object.hasOwn(app.views, section.view) ? app.views[section.view] : undefined;
      if (!view || !lists.includes(section.view)) {
        throw new Error(
          `${at} embeds "${section.view}", which is not a list view this App declares. Its list views: ${lists.join(', ') || 'none'}.`,
        );
      }
      return embeddedList(section, view as AppListView);
    }),
  }));
}

/* A row added from a record's page starts where the resource's own New form
   starts it (`form.defaults`), under what the create says for itself: a
   Prescribe beside a visit is still a prescription, active from today. */
function withFormDefaults(app: AppDef, resource: string, create: NonNullable<PageList['create']>): NonNullable<PageList['create']> {
  const form = app.resources && Object.hasOwn(app.resources, resource) ? app.resources[resource].form : undefined;
  if (!form?.defaults || !Object.keys(form.defaults).length) return create;
  return { ...create, defaults: { ...form.defaults, ...(create.defaults ?? {}) } };
}

/** The related list an embed draws as: the view's rows, in its words, narrowed to the record's. */
function embeddedList(section: PageList, view: AppListView): PageList {
  const tab = view.tabs?.[0];
  /* A tab's query may carry its own sort; the rows are the question's, the order is said apart. */
  const tabParts = tab?.query ? splitClauseTail(tab.query) : { head: '', tail: '' };
  const tabSort = /^(?:sort|order\s+by)\s+(.+)$/i.exec(tabParts.tail)?.[1];
  const filter = andQuery(view.query, tabParts.head) || undefined;
  const sort = tabSort ?? view.sort;
  const presentation = view.presentation;
  const cards = presentation?.kind === 'cards' ? presentation : undefined;
  /* A custom list is still its component's to draw, over the columns it reads. */
  const custom = presentation?.kind === 'custom' ? presentation : undefined;
  /* A checklist, queue or board reads as its card: the primary line and the lines under it. */
  const card =
    presentation && 'primary' in presentation && typeof presentation.primary === 'string'
      ? [presentation.primary, ...(('lines' in presentation ? presentation.lines : undefined) ?? [])]
      : undefined;
  /* A board or a calendar is drawn by the view's own component, so the rows carry every column it reads. */
  const lanes = presentation?.kind === 'board' || presentation?.kind === 'calendar' ? presentation : undefined;
  const columns = custom
    ? custom.show
    : lanes
      ? [...new Set([...(view.show ?? []), ...listPresentationColumns(lanes)])]
      : (view.show ?? (cards ? undefined : card));
  return {
    ...section,
    from: view.table,
    title: section.title ?? view.label,
    ...(columns ? { columns: [...columns] } : {}),
    ...(filter ? { filter } : {}),
    ...(sort
      ? {
          orderBy: sort
            .split(',')
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
              const [column, direction] = part.split(/\s+/);
              return { column, direction: direction?.toLowerCase() === 'desc' ? ('desc' as const) : ('asc' as const) };
            }),
        }
      : {}),
    ...(cards ? { presentation: cards } : custom ? { presentation: custom } : {}),
    ...(lanes ? { lanes } : {}),
    ...(view.empty ? { empty: view.empty } : {}),
  };
}
