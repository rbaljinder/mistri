/** Pure suite destination catalog. No session, grant, membership or row lookup. */
import { appTargetFields, parseAppTarget, type AppTarget, type BoundAppTarget } from '@mistriwork/engine/shared/appLinks.js';
import type { AppDef } from '../../shared/appModel.js';
import { appRealms } from '../../shared/appTenancy.js';
import { recordSegments, mountClashes, type AddressBook } from '../../shared/appAddress.js';
import {
  appMounts,
  parseBasePath,
  parseMountPath,
  outward,
  segmentsTakenFrom,
  type AddressMount,
} from '@mistriwork/engine/shared/mount.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

export interface SuiteLinkSurface {
  realm: 'app' | 'tenant' | 'platform';
  schema: DatabaseSchema;
  book: AddressBook;
  /** Authored resource name → resolved table id; omitted uses the logical catalog. */
  resources?: Readonly<Record<string, string>>;
  /** Source resource → authoring-visible fields. Runtime binding narrows again per reader. */
  visibleFields?: Readonly<Record<string, readonly string[]>>;
}
export interface SuiteLinkApp {
  app: AppDef;
  pages: readonly PageDef[];
  surfaces: readonly SuiteLinkSurface[];
}
interface SuiteLinkDeclaration {
  sourceApp: string;
  at: string;
  realm: SuiteLinkSurface['realm'] | 'neutral';
  sourceResource?: string;
  target: AppTarget;
}
export interface SuiteLinkCatalog {
  readonly declarations: readonly SuiteLinkDeclaration[];
}
interface State {
  apps: Map<string, SuiteLinkApp>;
  mount: AddressMount;
}
const states = new WeakMap<SuiteLinkCatalog, State>();
const tenantApp = (app: AppDef) => app.auth?.rows === 'tenant';

/** Collect authored CTAs, checked nav leaves and explicit App-menu choices. */
export function collectAppLinks(input: Pick<SuiteLinkApp, 'app' | 'pages'>): SuiteLinkDeclaration[] {
  const { app, pages } = input,
    realms = appRealms(app);
  const links: SuiteLinkDeclaration[] = [];
  const add = (action: unknown, at: string, realm: SuiteLinkDeclaration['realm'], sourceResource?: string) => {
    if (!action || typeof action !== 'object' || !Object.hasOwn(action, 'to')) return;
    const target = parseAppTarget((action as { to: unknown }).to, `${at}.to`, sourceResource !== undefined);
    links.push({ sourceApp: app.id, at, realm, ...(sourceResource === undefined ? {} : { sourceResource }), target });
  };
  const nav = (nodes: AppDef['nav'], at: string, realm: SuiteLinkDeclaration['realm']) =>
    nodes.forEach((node, i) => {
      const here = `${at}[${i}]`;
      if ('group' in node)
        nav(
          node.children,
          `${here} (${node.group}).children`,
          tenantApp(app) ? (node.realm ?? (realm === 'neutral' ? 'tenant' : realm)) : 'app',
        );
      else if ('to' in node) add(node, here, realm);
    });
  nav(app.nav, `App "${app.id}", nav`, 'neutral');
  const switcher = app.ui.appSwitcher;
  if (switcher?.groups)
    switcher.groups.forEach((group, i) =>
      group.links.forEach((link, j) => add(link, `App "${app.id}", ui.appSwitcher.groups[${i}].links[${j}]`, 'neutral')),
    );
  if (Array.isArray(switcher?.apps))
    switcher.apps.forEach((id, i) => add({ to: { app: id, kind: 'home' } }, `App "${app.id}", ui.appSwitcher.apps[${i}]`, 'neutral'));
  for (const [key, view] of Object.entries(app.views)) {
    if (!('sections' in view)) continue;
    for (const [region, sections] of [
      ['sections', view.sections],
      ['aside', view.aside ?? []],
    ] as const) {
      sections.forEach((section, i) => {
        if (section.kind === 'note')
          add(section.action, `App "${app.id}", view "${key}", ${region} ${i + 1}`, tenantApp(app) ? realms.view(key) : 'app');
      });
    }
  }
  for (const page of pages)
    page.sections.forEach((section, i) => {
      const at = `App "${app.id}", page "${page.id}", section ${i + 1}`;
      const realm = tenantApp(app) ? realms.page(page) : 'app';
      if (section.kind === 'note') add(section.action, at, realm, page.base);
      if (section.kind === 'fields') section.actions?.forEach((action, j) => add(action, `${at}, action ${j + 1}`, realm, page.base));
    });
  return links;
}

/** A standalone load can report unresolved declarations without inventing addresses. */
export function unresolvedAppLinks(input: Pick<SuiteLinkApp, 'app' | 'pages'>): string[] {
  return collectAppLinks(input).map((link) => `${link.at}: target App "${link.target.app}" is unresolved without a suite link catalog.`);
}

function destination(state: State, target: AppTarget): { surface: SuiteLinkSurface; table?: string } {
  const deployed = state.apps.get(target.app);
  if (!deployed) throw new Error(`Unknown target App "${target.app}".`);
  if (!Object.hasOwn(state.mount.apps, target.app)) throw new Error(`Target App "${target.app}" has no suite mount.`);
  const isTenant = tenantApp(deployed.app);
  if (!isTenant && target.tenant !== undefined) throw new Error(`Ordinary target App "${target.app}" cannot take tenant intent.`);
  const realm = !isTenant ? 'app' : target.tenant?.kind === 'platform' ? 'platform' : 'tenant';
  if (realm === 'platform' && !deployed.app.auth?.tenancy?.platform)
    throw new Error(`Target App "${target.app}" declares no platform realm.`);
  const surface = deployed.surfaces.find((candidate) => candidate.realm === realm);
  if (!surface) throw new Error(`Target App "${target.app}" has no ${realm} route catalog.`);
  if (target.kind === 'home') return { surface };
  if (target.kind === 'view') {
    if (isTenant && appRealms(deployed.app).view(target.view) !== realm)
      throw new Error(`Target view "${target.view}" belongs to another realm.`);
    if (!Object.hasOwn(deployed.app.views, target.view) || !surface.book.views.has(target.view))
      throw new Error(`Target App "${target.app}" has no routable ${realm} view "${target.view}".`);
    return { surface };
  }
  if (!Object.hasOwn(deployed.app.resources ?? {}, target.resource))
    throw new Error(`Target App "${target.app}" does not declare resource "${target.resource}".`);
  if (realm === 'tenant' && deployed.app.resources?.[target.resource]?.owner === 'platform')
    throw new Error(`Target resource "${target.resource}" belongs to the platform realm.`);
  const table =
    surface.resources && Object.hasOwn(surface.resources, target.resource)
      ? surface.resources[target.resource]
      : tableNamed(surface.schema, target.resource)?.id;
  const meta = surface.schema.tables.find((candidate) => candidate.id === table);
  if (!table || !meta || !surface.book.records.has(table))
    throw new Error(`Target resource "${target.resource}" has no ${realm} record route.`);
  const pk = meta.columns.filter((column) => column.primaryKey).map((column) => column.name);
  const keys = Object.keys(target.key);
  if (!pk.length || pk.length !== keys.length || pk.some((column) => !Object.hasOwn(target.key, column))) {
    throw new Error(`Target resource "${target.resource}" needs exactly its primary-key columns: ${pk.join(', ') || '(none)'}.`);
  }
  if (Object.values(target.key).every((value) => typeof value !== 'object')) {
    const segments = recordSegments(surface.book, table, { key: target.key });
    if (!segments) throw new Error('The target record has no canonical address.');
    const path = `/${encodeURIComponent(target.app)}/${segments.join('/')}`;
    if (new URL(path, 'http://suite-link.invalid').pathname !== path) throw new Error('The target key would be normalized by the browser.');
  }
  return { surface, table };
}

function examine(
  apps: readonly SuiteLinkApp[],
  mount: AddressMount,
): { state: State; declarations: SuiteLinkDeclaration[]; problems: string[] } {
  const state: State = { apps: new Map(), mount },
    declarations: SuiteLinkDeclaration[] = [],
    problems: string[] = [];
  try {
    if (parseBasePath(mount.base) !== mount.base) throw new Error('Suite base path must be canonical.');
    for (const [id, segment] of Object.entries(mount.apps))
      if (parseMountPath(segment || '/', `App "${id}"`) !== segment) throw new Error('Suite mount segments must be canonical.');
    appMounts(
      apps.map((input) => input.app.id),
      { base: mount.base, mounts: mount.apps },
    );
  } catch (error) {
    problems.push((error as Error).message);
  }
  for (const input of apps) {
    if (state.apps.has(input.app.id)) problems.push(`Duplicate suite App "${input.app.id}".`);
    state.apps.set(input.app.id, input);
    if (!Object.hasOwn(mount.apps, input.app.id)) problems.push(`App "${input.app.id}" has no suite mount.`);
    const realms = new Set<string>();
    for (const surface of input.surfaces) {
      if (realms.has(surface.realm)) problems.push(`App "${input.app.id}" repeats its ${surface.realm} route catalog.`);
      realms.add(surface.realm);
      problems.push(
        ...surface.book.problems.map((problem) => `App "${input.app.id}": ${problem}`),
        ...mountClashes(surface.book, segmentsTakenFrom(mount, input.app.id)),
      );
    }
    try {
      declarations.push(...collectAppLinks(input));
    } catch (error) {
      problems.push((error as Error).message);
    }
  }
  for (const link of declarations) {
    try {
      destination(state, link.target);
      const fields = appTargetFields(link.target);
      if (!fields.length) continue;
      const source = state.apps.get(link.sourceApp)!;
      const surface = source.surfaces.find((candidate) => candidate.realm === link.realm);
      const resource = link.sourceResource;
      if (!resource || !surface) throw new Error('Source bindings need a record surface and its realm catalog.');
      const table = surface.resources?.[resource] ?? tableNamed(surface.schema, resource)?.id;
      const columns = surface.schema.tables.find((candidate) => candidate.id === table)?.columns.map((column) => column.name) ?? [];
      const visible = surface.visibleFields?.[resource] ?? columns;
      const hidden = source.app.resources?.[resource]?.hidden ?? [];
      for (const field of fields)
        if (!columns.includes(field) || !visible.includes(field) || hidden.includes(field))
          throw new Error(`Source field "${field}" is not visible on "${resource}".`);
    } catch (error) {
      problems.push(`${link.at}: ${(error as Error).message}`);
    }
  }
  return { state, declarations, problems };
}

export function suiteLinkProblems(apps: readonly SuiteLinkApp[], mount: AddressMount): string[] {
  return examine(apps, mount).problems;
}

/** Snapshot validated metadata; later caller mutations cannot change a checked target. */
export function createSuiteLinkCatalog(apps: readonly SuiteLinkApp[], mount: AddressMount): SuiteLinkCatalog {
  const checked = examine(structuredClone(apps), structuredClone(mount));
  if (checked.problems.length) throw new Error(checked.problems.join('\n'));
  const freeze = (value: object): void => {
    for (const nested of Object.values(value)) if (nested && typeof nested === 'object') freeze(nested);
    Object.freeze(value);
  };
  freeze(checked.declarations);
  const catalog: SuiteLinkCatalog = Object.freeze({ declarations: checked.declarations });
  states.set(catalog, checked.state);
  return catalog;
}

/**
 * Resolve already-bound data with the suite mount, never a source child's mount. `book`: the destination's address
 * book for the person following the link (apps.ts appRoutes with their roles), so a record opens at the address
 * their browser says; a record it has no address for is said by the App's own, which the server sends on (personAddress.ts).
 */
export function resolveSuiteLink(catalog: SuiteLinkCatalog, raw: BoundAppTarget, book?: AddressBook): string {
  const state = states.get(catalog);
  if (!state) throw new Error('A checked suite link catalog is required.');
  const target = parseAppTarget(raw) as BoundAppTarget;
  const { surface, table } = destination(state, target);
  let segments: string[] = [];
  if (target.kind === 'view') segments = [encodeURIComponent(surface.book.views.get(target.view)!)];
  if (target.kind === 'record') {
    const record = (book && recordSegments(book, table!, { key: target.key })) || recordSegments(surface.book, table!, { key: target.key });
    if (!record) throw new Error('The target record has no canonical address.');
    segments = record;
  }
  let internal = `/${encodeURIComponent(target.app)}${segments.length ? `/${segments.join('/')}` : ''}`;
  if (new URL(internal, 'http://suite-link.invalid').pathname !== internal)
    throw new Error('The target key would be normalized by the browser.');
  const query = new URLSearchParams();
  if (target.kind === 'home' && state.mount.apps[target.app] === '') query.set('app', target.app);
  if (target.tenant?.kind === 'tenant') query.set('tenant', String(target.tenant.id));
  if (target.tenant?.kind === 'platform') query.set('realm', 'platform');
  if (query.size) internal += `?${query}`;
  return outward(state.mount, internal);
}
