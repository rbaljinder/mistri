import { documentSections, parseDocument } from '@mistriwork/engine/shared/appDocuments.js';
import { parsePageLayout } from '@mistriwork/engine/shared/pageLayouts.js';
import { homeSourceOf, type AppDef } from '../../shared/app.js';
import type { AppRealm } from '../../shared/appModel.js';
import { appSurfaceForRealm } from '../../shared/appTenancy.js';
import { resolvePageEmbeds } from '../../shared/appPages.js';
import { parsePresentation } from '../../shared/appViews.js';
import { withDraftsHidden } from '../forms/savedFormLists.js';
import {
  servedApp,
  servedLanguages,
  servedLocale,
  servedZone,
  withAvailableEmptyActions,
  withAvailablePageEmptyActions,
  withHome,
  withoutBrokenViews,
  withoutSignedInParts,
  type AppPayloadApp,
} from '../../shared/appPayload.js';
import { homeViews } from '../../shared/appHome.js';
import { pageConfig, parsePageBody, suggestPage, type PageDef } from '@mistriwork/engine/shared/page.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { fieldAccessibleApp, fieldAccessiblePage, readablePage } from '../app/appFieldProjection.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { catalogLocales } from '../app/readerLocale.js';
import type { TenantCapabilities } from './tenantCapabilities.js';
import { appForRoles, pagesForRoles, parseOpenRoles } from '../../shared/appViewRoles.js';
import { parseRoutePath } from '../../shared/appAddress.js';

/** Resolved embeds retain only cards/custom objects. Convert normalized card
 * captions back to authored facts before asking the ordinary list grammar. */
function capturedListPresentation(section: Record<string, unknown>): Record<string, unknown> {
  const raw = section.presentation;
  tenantRecord(raw);
  if (section.kind !== 'list' || (raw.kind !== 'cards' && raw.kind !== 'custom')) return denyTenant();
  if (raw.kind === 'custom') {
    // Custom related lists come from an App view, not a standalone page option.
    if (typeof section.view !== 'string' || !section.view) return denyTenant();
    parsePresentation(raw, 'Tenant list');
    return raw;
  }
  tenantRecord(raw, ['kind', 'primary', 'value', 'badge', 'lines', 'facts', 'factLabels', 'image', 'media']);
  /* The model's `lines` are a card's captioned values, authored as `properties`. */
  const { factLabels, lines, ...authored } = raw;
  if (lines !== undefined) authored.properties = lines;
  if (raw.facts !== undefined && (!Array.isArray(raw.facts) || raw.facts.some((path) => typeof path !== 'string'))) return denyTenant();
  if (factLabels !== undefined) {
    tenantRecord(factLabels);
    for (const [path, label] of Object.entries(factLabels)) {
      if (!Array.isArray(raw.facts) || !raw.facts.includes(path)) return denyTenant();
      tenantRecord(label, ['one', 'many', 'position']);
      if (
        typeof label.one !== 'string' ||
        (label.many !== undefined && typeof label.many !== 'string') ||
        (label.position !== undefined && label.position !== 'before')
      )
        return denyTenant();
    }
    if (Array.isArray(raw.facts))
      authored.facts = raw.facts.map((path) => {
        const label = factLabels[path];
        if (label === undefined) return path;
        tenantRecord(label);
        const word = label.many === undefined ? label.one : { one: label.one, many: label.many };
        return label.position === undefined ? { column: path, after: word } : { column: path, before: word };
      });
  }
  parsePresentation(authored, 'Tenant list');
  return authored;
}

// The normalized-to-authored emitter deliberately omits defaults. Validate
// their types first, so malformed booleans/paths cannot disappear or coerce
// into a different declaration while capturing this restart-only catalog.
function normalizedPage(page: Record<string, unknown>): void {
  if ((page.listTabs !== undefined && typeof page.listTabs !== 'boolean') || !Array.isArray(page.sections)) return denyTenant();
  const strings = (value: unknown) => {
    if (value !== undefined && (!Array.isArray(value) || value.some((item) => typeof item !== 'string'))) return denyTenant();
  };
  const text = (value: Record<string, unknown>, names: string[]) => {
    for (const name of names) if (value[name] !== undefined && typeof value[name] !== 'string') return denyTenant();
  };
  for (const section of page.sections) {
    tenantRecord(section);
    text(section, [
      'kind',
      'title',
      'region',
      'width',
      'offsetRight',
      'when',
      'from',
      'path',
      'of',
      'column',
      'filter',
      'fn',
      'by',
      'format',
      'unit',
    ]);
    if (section.presentation !== undefined && typeof section.presentation !== 'string') capturedListPresentation(section);
    if (
      typeof section.presentation === 'string' &&
      section.kind === 'list' &&
      section.presentation !== 'gallery' &&
      section.presentation !== 'card'
    )
      return denyTenant();
    if (section.kind === 'note' && section.action !== undefined) tenantRecord(section.action);
    for (const name of ['names']) if (section[name] !== undefined && typeof section[name] !== 'boolean') return denyTenant();
    if (section.limit !== undefined && typeof section.limit !== 'number') return denyTenant();
    strings(section.paths);
    if (section.kind === 'fields') {
      if (section.columns !== undefined && typeof section.columns !== 'number') return denyTenant();
    } else strings(section.columns);
    if (section.orderBy !== undefined) {
      if (!Array.isArray(section.orderBy)) return denyTenant();
      for (const order of section.orderBy) {
        tenantRecord(order, ['column', 'direction']);
        if (typeof order.column !== 'string' || !['asc', 'desc'].includes(String(order.direction))) return denyTenant();
      }
    }
    if (section.workflow !== undefined) {
      // The machine derives this normalized strip. It is runtime metadata,
      // not an authored page option; validate it before the grammar round-trip.
      tenantRecord(section.workflow, ['field', 'steps', 'ordered']);
      if (typeof section.workflow.field !== 'string' || !Array.isArray(section.workflow.steps)) {
        return denyTenant(new Error('a page section workflow needs a field and an array of steps'));
      }
      if (section.workflow.ordered !== undefined && section.workflow.ordered !== true) {
        return denyTenant(new Error('a page section workflow is ordered or says nothing'));
      }
      for (const step of section.workflow.steps) {
        tenantRecord(step, ['value', 'label']);
        if (typeof step.value !== 'string' || typeof step.label !== 'string') {
          return denyTenant(new Error('a workflow step needs a value and a label'));
        }
      }
    }
    if (section.create !== undefined) {
      /* A create starts from the child resource's form defaults and may fill
         columns from the record (relatedCreate.ts), so both reach a host.
         Their shape is checked here and their meaning by the re-parse below;
         a tenant's ownership column named in either is still the writer's to
         refuse, as any supplied one is. */
      tenantRecord(section.create, ['label', 'show', 'defaults', 'prefill']);
      if (typeof section.create.label !== 'string') return denyTenant();
      strings(section.create.show);
      if (section.create.defaults !== undefined) {
        tenantRecord(section.create.defaults);
        for (const value of Object.values(section.create.defaults)) {
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value)) return denyTenant();
        }
      }
      if (section.create.prefill !== undefined) {
        tenantRecord(section.create.prefill);
        text(section.create.prefill, Object.keys(section.create.prefill));
      }
    }
    if (section.streams !== undefined) {
      if (!Array.isArray(section.streams)) return denyTenant();
      for (const stream of section.streams) {
        // `by` is the stream's author; the loader writes the key on every stream,
        // so leaving it out refused every tenant App that drew a timeline. `of`
        // is its `about`: planned on this context's scoped adapter like a
        // list's (tenantPageOperations.ts), so it reads only the tenant's rows.
        // A key it does not take is named, as a page's is: "could not be
        // verified" alone sent a reader to a patched server to find `about`.
        if (stream && typeof stream === 'object' && !Array.isArray(stream)) {
          const unknown = Object.keys(stream).find((key) => !STREAM_FIELDS.includes(key));
          if (unknown !== undefined)
            return denyTenant(new Error(`a timeline stream has "${unknown}", which a tenant App's timeline does not take.`));
        }
        tenantRecord(stream, STREAM_FIELDS);
        text(stream, STREAM_FIELDS);
      }
    }
  }
}

/** What a normalized timeline stream may carry into a tenant host. */
const STREAM_FIELDS = ['from', 'path', 'at', 'show', 'detail', 'by', 'filter', 'of'];
/** What a normalized App page may carry into a tenant host. */
const PAGE_FIELDS = [
  'id',
  'name',
  'base',
  'sections',
  'connection',
  'listTabs',
  'empty',
  'source',
  'error',
  'realm',
  'path',
  'roles',
  'document',
  'aside',
  'defaultAside',
  'layout',
  'layoutWhy',
];

/** The host passes the existing loader's normalized pages once, not filenames
 * or a second request-time loader. Round-trip through the shared grammar to
 * capture only supported presentation fields and discard source diagnostics. */
export function captureTenantPages(app: AppDef, input: unknown): readonly PageDef[] {
  try {
    const pages = captureTenantData(input === undefined ? [] : input);
    if (!Array.isArray(pages) || pages.length > 256) return denyTenant();
    const ids = new Set<string>();
    return captureTenantData(
      pages.map((value, index) => {
        tenantRecord(value);
        const at = `pages "${typeof value.id === 'string' ? value.id : index + 1}"`;
        /* A refusal names the key it refused and the page it was on: the
           host's own declarations are what failed, and an operator told only
           "the tenant context could not be verified" had nothing to go on. */
        const unknown = Object.keys(value).find((key) => !PAGE_FIELDS.includes(key));
        if (unknown !== undefined) return denyTenant(new Error(`${at} has "${unknown}", which a tenant App's page does not take.`));
        // Whose context the page serves; enrollment judges it by the manifest's realm rules.
        // `path` and `roles` are the App page's own (appPages.ts), judged here as the loader judges them.
        // `layoutWhy` is the loader's note on a layout it chose, for `mistri check`; the word is what a tenant serves.
        const { realm, path, roles, document, layout, layoutWhy: _why, ...rest } = value;
        if (realm !== undefined && realm !== 'tenant' && realm !== 'platform')
          return denyTenant(new Error(`${at} has an unknown "realm".`));
        const route = path === undefined ? undefined : parseRoutePath(path, at);
        const opens = parseOpenRoles(roles, at, app.auth);
        // A record on paper (appDocuments.ts): judged again here, and its sections as paper draws them.
        const paper = document === undefined ? undefined : parseDocument(document, at);
        // The archetype the App's parser judged (pageLayouts.ts): only its word is carried, read again here.
        const arranged = layout === undefined || paper !== undefined ? undefined : parsePageLayout(layout, at);
        normalizedPage(rest);
        // The App page parser's two aside words (appPages.ts): `aside` only ever says false, and `defaultAside` is its mark.
        if ((value.aside !== undefined && value.aside !== false) || (value.defaultAside !== undefined && value.defaultAside !== true))
          return denyTenant(new Error(`${at} has an invalid "aside" or "defaultAside".`));
        tenantIdentifier(value.id, 1024);
        tenantIdentifier(value.name, 1024);
        tenantIdentifier(value.base);
        if (
          value.id.startsWith('suggested:') ||
          ids.has(value.id) ||
          value.error !== undefined ||
          (value.source !== undefined && value.source !== 'config') ||
          (value.connection !== undefined && value.connection !== app.sources?.[homeSourceOf(app)!]?.connection)
        )
          return denyTenant();
        ids.add(value.id);
        const original = rest as unknown as PageDef;
        const authored = pageConfig(original);
        const { connection: _connection, ...definition } = authored;
        // These are App pages: the Workbench wrapper rejects note actions and
        // embeds. Headline options omitted by the emitter still need parsing,
        // including rejection when supplied on a non-headline fields section.
        const sections = definition.sections!.map((section, index) => {
          const source = original.sections[index];
          return source.kind === 'fields' && source.presentation !== 'headline' && source.presentation !== 'card'
            ? {
                ...section,
                ...(source.actions !== undefined ? { actions: source.actions } : {}),
                ...(source.subfigure !== undefined ? { subfigure: source.subfigure } : {}),
                ...(source.was !== undefined ? { was: source.was } : {}),
                ...(source.note !== undefined ? { note: source.note } : {}),
              }
            : source.kind === 'list' && source.view === undefined && typeof source.presentation === 'object'
              ? { ...section, presentation: capturedListPresentation(source as unknown as Record<string, unknown>) }
              : section;
        });
        const [parsed] = resolvePageEmbeds(app, [parsePageBody({ ...definition, sections }, 'Tenant pages', value.id)], 'Tenant pages');
        // The authoring grammar intentionally has no workflow option: machines
        // supply it after parsing. Keep the already checked derived metadata so
        // field projection can reject a strip whose state column is hidden.
        parsed.sections = parsed.sections.map((section, index) => {
          const source = original.sections[index];
          return section.kind === 'fields' && source?.kind === 'fields' && source.workflow
            ? { ...section, workflow: source.workflow }
            : section;
        });
        const { connection: _parsedConnection, ...page } = parsed;
        return {
          ...page,
          // pageConfig carries `aside: false` through the grammar; the mark is the loader's, so it is set again here.
          ...(value.defaultAside === true && page.aside !== false && paper === undefined ? { defaultAside: true as const } : {}),
          ...(realm === undefined ? {} : { realm }),
          ...(arranged === undefined ? {} : { layout: arranged }),
          ...(route === undefined ? {} : { path: route }),
          ...(opens === undefined ? {} : { roles: opens }),
          ...(paper === undefined ? {} : { document: paper, sections: documentSections(page.sections, at) }),
        };
      }),
    );
  } catch (error) {
    return denyTenant(error);
  }
}

function permittedPage(page: PageDef, schema: DatabaseSchema, capabilities?: TenantCapabilities): PageDef {
  return {
    ...page,
    sections: page.sections.map((section) => {
      if (section.kind !== 'list' || !section.create) return section;
      if (capabilities?.resources[section.from]?.insertable && fieldAccessiblePage(schema, { ...page, sections: [section] }))
        return section;
      const { create: _create, ...list } = section;
      return list;
    }),
  };
}

/** schema is the current context's permitted logical schema, never a physical
 * catalog or a global-login role projection. Metadata grants no writer authority;
 * capabilities come from the current membership and bound deployment services,
 * and so do `roles`, the current membership's: the home is resolved from them,
 * so one person can start differently in each tenant. None is a member holding
 * no role.
 *
 * `realm` is the lease's own — the platform realm's, or a tenant's, which a
 * support session inside a dealership reads as. It is taken first, because the
 * realm projection is what decides which surface this lease is offered
 * (appSurfaceForRealm) and nothing downstream can stand in for it: the schema
 * only says which tables this context has, and a view of the other realm over
 * a table this context owns resolves against it perfectly. Leaving the answer
 * to `withoutBrokenViews` below is exactly that mistake — it drops a room
 * because its table is missing, which filtered the lender's platform-owned
 * screens out of a dealership's menu by luck and left the lender's list over
 * the dealership's own documents standing in it. */
export function projectTenantMetadata(
  app: AppDef,
  pages: readonly PageDef[],
  schema: DatabaseSchema,
  capabilities?: TenantCapabilities,
  roles: readonly string[] = [],
  realm: AppRealm = 'tenant',
  /** This context's own zone, where `ui.timezone` reads one (readerZone.ts): the payload's days are this reader's. */
  zone?: string,
  /** This member's resolved locale (readerLocale.ts): the payload's figures are said in it, as its words were. */
  locale?: string,
  /** A visitor's read (tenantPublicReadHttp.ts): the signed-out home, and nothing only a signed-in reader is offered. */
  signedOut = false,
) {
  const surface = appSurfaceForRealm(app, pages, realm);
  /* The member's roles in this tenant decide which views and pages that name roles are theirs, as on a single App (appViewRoles.ts). */
  const realmApp = appForRoles(surface.app, roles);
  const realmPages = pagesForRoles(surface.pages, roles, surface.app.auth);
  const visible = fieldAccessibleApp(realmApp, schema);
  const granted = new Set(capabilities?.grantedCommands ?? []);
  const permitted: AppDef = {
    ...visible,
    ...(visible.resources
      ? {
          resources: Object.fromEntries(
            Object.entries(visible.resources).map(([name, resource]) => {
              const { actions, form, ...rest } = resource;
              const available = actions?.filter((action) =>
                action.command ? granted.has(action.command.id) : capabilities?.writable.includes(name),
              );
              return [
                name,
                {
                  ...rest,
                  ...(available ? { actions: available } : {}),
                  ...(form && capabilities?.resources[name]?.insertable ? { form } : {}),
                },
              ];
            }),
          ),
        }
      : {}),
  };
  // A saved form's drafts are rows of its root from the first step; the lists over it leave them out (savedFormLists.ts).
  const drafted = withDraftsHidden(permitted, 'catalog', schema);
  const served = withHome(
    withAvailableEmptyActions(withoutBrokenViews(servedApp(drafted, schema, realmPages), homeViews(realmApp))),
    realmApp,
    signedOut ? { signedIn: false } : { signedIn: true, roles: [...roles] },
  );
  // The same roles that resolve the home also answer whether this person may
  // read their tenant's support log. It travels here, beside the other runtime
  // answers, because roles are per-tenant: nothing before a lease can know it.
  const supportLog = roles.some((role) => app.auth?.roles?.[role]?.supportLog === true);
  const answer: AppPayloadApp = {
    ...(signedOut ? withoutSignedInParts(served, schema) : served),
    ui: { ...servedLanguages(servedLocale(servedZone(served.ui, zone), locale), catalogLocales(app)), export: false },
    writableTables: [...(capabilities?.writable ?? [])],
    grantedCommands: [...granted],
    ...(capabilities?.formCommands ? { formCommands: structuredClone(capabilities.formCommands) as AppPayloadApp['formCommands'] } : {}),
    ...(supportLog ? { supportLog: true as const } : {}),
  };
  return captureTenantData({
    app: answer,
    // An embed needs its view in this realm's final rooms as well as readable
    // columns; a view in another realm may use the very same logical table.
    pages: withAvailablePageEmptyActions(
      realmPages
        .map((page) => permittedPage(page, schema, capabilities))
        .flatMap((page) => {
          /* A section this member cannot read is left out, never the page (readablePage). */
          const sections = page.sections.filter(
            (section) => section.kind !== 'list' || section.view === undefined || Object.hasOwn(served.views, section.view),
          );
          const kept = sections.length || !page.sections.length ? readablePage(schema, { ...page, sections }) : undefined;
          return kept ? [kept] : [];
        }),
      served,
    ),
  });
}

export function tenantSuggestedPage(schema: DatabaseSchema, table: string): PageDef {
  tenantIdentifier(table);
  const page = suggestPage(schema, table);
  if (!page || !fieldAccessiblePage(schema, page)) return denyTenant();
  return captureTenantData(page);
}
