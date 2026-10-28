/**
 * Tenancy in the App DSL (`auth.rows: 'tenant'`): whose rows each resource
 * holds (`owner`), the platform realm (`auth.tenancy.platform`), and which
 * realm each role, view, menu group, page, home rule and command reference
 * belongs to.
 *
 * The server enforces isolation on its own: the tenant runtime refuses a
 * platform row in a tenant context whatever the App says. These checks make a
 * tenant App say what it means, so a dealer's menu never names a lender's
 * table and a mistake is refused when the App loads, not found later as a
 * quietly empty list.
 */
import type { AppAction, AppDef, AppHomeRule, AppNavNode, AppRealm, AppRoleGrant, ResourceDef } from './appModel.js';
import { checkedGrants } from './appAuthGrants.js';
import type { PageDef } from '@mistriwork/engine/shared/pageModel.js';
import { ASSISTANT_ROOM } from '@mistriwork/engine/shared/servedApp.js';

const realmOf = (value: unknown): AppRealm | undefined => (value as { realm?: AppRealm } | undefined)?.realm;
/* The assistant's page (placement 'page') is a nav word with no view behind it, and it is the tenant's: the assistant
   answers inside one customer only (tenant/tenantAssistant.ts). Read as a view, its missing `realm` threw a TypeError
   out of `mistri check` (a field report). */
const assistantRoom = (app: AppDef, key: string): boolean => key === ASSISTANT_ROOM && !Object.hasOwn(app.views, key);
const NEEDS_PLATFORM = 'needs the platform realm: auth.tenancy.platform';
/* What a platform-only source's resource never takes: each would write it,
   act on it or read it through something other than the platform realm's reads. */
const PLATFORM_ONLY_REFUSED = [
  'delete',
  'favorite',
  'validation',
  'defined',
  'form',
  'actions',
  'machine',
  'at',
  'file',
  'tags',
  'search',
] as const satisfies readonly (keyof ResourceDef)[];

/** Where the menu places each view, by realm: a root group or entry says it,
 * and a group's children keep it. `report` is checkTenancy's refusal; without
 * one the walk is lenient and simply places what the menu does say, for an App
 * that has already loaded and so has already agreed with checkTenancy. */
function navRealms(app: AppDef, at: string, report?: (message: string) => never): Map<string, AppRealm> {
  const placed = new Map<string, AppRealm>();
  const walk = (nodes: AppNavNode[], inherited: AppRealm | undefined, where: string) =>
    nodes.forEach((node, i) => {
      const here = `${where}: nav entry ${i + 1}`;
      if ('group' in node) {
        if (inherited && node.realm && node.realm !== inherited) {
          report?.(`${here} (${node.group}) is "realm": "${node.realm}" inside a "${inherited}" group; a group's children keep its realm.`);
        }
        const realm = node.realm ?? inherited;
        if (!realm)
          report?.(
            `${here} (${node.group}) has no "realm". With the platform realm every root menu group says whose context it serves: "tenant" or "platform".`,
          );
        walk(node.children, realm, `${here} (${node.group})`);
        return;
      }
      // Destination intent never classifies a local view or changes the source realm.
      if ('to' in node) return;
      if (assistantRoom(app, node.view)) {
        if (inherited === 'platform')
          report?.(
            `${here} places the assistant's page in a "platform" group; the assistant answers inside one tenant, so place it in a "tenant" group.`,
          );
        placed.set(node.view, 'tenant');
        return;
      }
      const own = realmOf(app.views[node.view]);
      if (inherited && own && own !== inherited) {
        report?.(`${here}: the view "${node.view}" is "realm": "${own}" inside a "${inherited}" group; a group's children keep its realm.`);
      }
      const realm = own ?? inherited;
      if (!realm)
        report?.(
          `${here} names the view "${node.view}", which has no "realm"; with the platform realm every root menu entry says whose context it serves.`,
        );
      if (realm) placed.set(node.view, realm);
    });
  walk(app.nav, undefined, at);
  return placed;
}

/**
 * Which realm each authored thing belongs to, for an App that has loaded.
 *
 * Without the platform realm there is one realm and everything is the
 * tenant's, which is the whole of most tenant Apps. With it, a view's realm is
 * where the menu places it, or its own word, or the App's own realm; a page's,
 * a home rule's and a command reference's are their own words; and a
 * resource's is whose rows it holds, because that is what decides which
 * catalog its table is even in.
 */
export interface AppRealms {
  /** Whether the App declares the platform realm at all. */
  readonly platform: boolean;
  view(key: string): AppRealm;
  page(page: PageDef): AppRealm;
  home(rule: AppHomeRule): AppRealm;
  resource(name: string): AppRealm;
}
export function appRealms(app: AppDef): AppRealms {
  const platform = app.auth?.tenancy?.platform !== undefined;
  const placed = platform ? navRealms(app, app.name) : new Map<string, AppRealm>();
  const view = (key: string): AppRealm =>
    platform ? (placed.get(key) ?? (Object.hasOwn(app.views, key) ? realmOf(app.views[key]) : undefined) ?? 'tenant') : 'tenant';
  return {
    platform,
    view,
    page: (page) => (platform ? (page.realm ?? 'tenant') : 'tenant'),
    home: (rule) => (platform ? (rule.realm ?? view(rule.view)) : 'tenant'),
    resource: (name) => (platform && app.resources?.[name]?.owner === 'platform' ? 'platform' : 'tenant'),
  };
}

/**
 * The App's *surface* in one realm: the views that realm opens as rooms, the
 * menu over them, the home rules it may start on, and its pages. Everything
 * either realm is offered comes from here, whether it is being checked or
 * served.
 *
 * **The realm projection must never fall back to table ownership.** Which
 * realm a view belongs to is authored — its own `realm`, or the group that
 * holds it — and whose rows its table holds is a different fact entirely. They
 * agree often enough to be mistaken for one rule, and where they part the
 * mistake is a leak. `review_file` is platform-owned, so a dealership's
 * catalog has no such table and the lender's view over it cannot resolve
 * there; drop what will not resolve and the lender's screens seem to
 * disappear. But `application_document` is the dealership's *own* table, so
 * the lender's "Document checklist" resolves perfectly in a dealership's
 * catalog — and was served as one of its rooms, under the lender's headings,
 * answering with the dealership's own rows. No row crossed. What crossed was
 * the knowledge that the lender keeps a checklist at all, and what its columns
 * and its question are. That is the lender's surface, not the dealership's, so
 * only the realm each thing was authored in may decide who is offered it.
 */
export function appSurfaceForRealm(app: AppDef, pages: readonly PageDef[], realm: AppRealm): { app: AppDef; pages: readonly PageDef[] } {
  const realms = appRealms(app);
  if (!realms.platform) return { app, pages };
  const views = Object.fromEntries(Object.entries(app.views).filter(([key]) => realms.view(key) === realm));
  const keep = (nodes: readonly AppNavNode[], inherited?: AppRealm): AppNavNode[] =>
    nodes.flatMap((node): AppNavNode[] => {
      if ('group' in node) {
        const sourceRealm = node.realm ?? inherited ?? 'tenant';
        if (sourceRealm !== realm) return [];
        const children = keep(node.children, sourceRealm);
        return children.length ? [{ ...node, children }] : [];
      }
      // Root checked targets are realm-neutral; grouped ones follow the source group.
      if ('to' in node) return [node];
      if (assistantRoom(app, node.view)) return realm === 'tenant' ? [node] : [];
      return Object.hasOwn(views, node.view) ? [node] : [];
    });
  /* The platform realm reads its staff as `me` (auth.tenancy.platform.me), so its surface says so too: served with
     the tenant's `me`, a platform tab such as `owner_id = me` was judged against the tenant's people, failed, and
     took its whole view out of the provider's menu. */
  const staff = realm === 'platform' ? app.auth?.tenancy?.platform?.me : undefined;
  return {
    app: {
      ...app,
      ...(staff ? { auth: { ...app.auth!, me: staff } } : {}),
      views,
      nav: keep(app.nav),
      home: app.home.filter((rule) => realms.home(rule) === realm),
    },
    pages: pages.filter((page) => realms.page(page) === realm),
  };
}

/**
 * The App as one realm declares it, for the authoring checks.
 *
 * A two-realm App is two authored surfaces over two catalogs: the tenant's,
 * which has neither the platform's tables nor the ownership column, and the
 * platform's, which has every table and reads the ownership column. Checking
 * either surface against the other's catalog is what made a correct App fail
 * `mistri check`, so each declaration is judged in the realm it names, and the
 * tenant's half is judged exactly as it always was. A resource block travels
 * with its owner, since that is which catalog holds its table — with one
 * exception its rows make necessary: an **action** belongs to its command's
 * realm. A platform command assigns a lender's reviewer to a dealer's
 * application, so its target is the tenant's row while its inputs name the
 * platform's own tables; judged in the tenant catalog, that reviewer picker
 * cannot resolve. So each pass keeps the actions its own realm runs, and a
 * resource owned by the other realm appears only for those actions, carrying
 * its binding and the names its rows are read by (segments, computed columns, rollups) and nothing else — a
 * form, transitions, display rules and a search stay where the rows live. Without the platform realm this is the App
 * unchanged.
 */
/**
 * The names a resource's rows are read by beyond their columns: its segments, computed columns and rollups. They
 * travel together because each may say the others — a segment `busy: 'open_tickets > 3'` reads a rollup, a rollup's
 * `query` a segment or a computed column of the rows it counts — so a realm judging one without the rest refuses a
 * condition the App serves (G164). None of them grants a row: a rollup still counts only what the reader's scope
 * holds.
 */
function vocabulary(resource: ResourceDef): Pick<ResourceDef, 'segments' | 'computed' | 'rollups'> {
  return {
    ...(resource.segments === undefined ? {} : { segments: resource.segments }),
    ...(resource.computed === undefined ? {} : { computed: resource.computed }),
    ...(resource.rollups === undefined ? {} : { rollups: resource.rollups }),
  };
}

export function appForRealm(app: AppDef, pages: readonly PageDef[], realm: AppRealm): { app: AppDef; pages: readonly PageDef[] } {
  const realms = appRealms(app);
  if (!realms.platform) return { app, pages };
  const surface = appSurfaceForRealm(app, pages, realm);
  /* A command reference that says nothing, and a fixed update, run where the
     resource's rows do; a reference that says `realm` runs there instead. */
  const actionRealm = (action: AppAction, owner: AppRealm): AppRealm => (action.command ? (action.command.realm ?? owner) : owner);
  const forRealm = (name: string, resource: ResourceDef): ResourceDef | undefined => {
    const owner = realms.resource(name);
    const actions = (resource.actions ?? []).filter((action) => actionRealm(action, owner) === realm);
    if (owner === realm) return resource.actions === undefined ? resource : { ...resource, actions };
    /* Kept for the words its rows are read by alone, too: the other realm's list of these rows names its segments
       as tabs, and shows and filters by its computed columns and rollups. */
    const words = vocabulary(resource);
    if (!actions.length && !Object.keys(words).length) return undefined;
    return {
      ...(resource.physical === undefined ? {} : { physical: resource.physical }),
      ...(resource.source === undefined ? {} : { source: resource.source }),
      ...(resource.access === undefined ? {} : { access: resource.access }),
      ...(resource.owner === undefined ? {} : { owner: resource.owner }),
      ...words,
      actions,
    };
  };
  const resources =
    app.resources === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(app.resources).flatMap(([name, resource]) => {
            const block = forRealm(name, resource);
            return block === undefined ? [] : [[name, block] as [string, ResourceDef]];
          }),
        );
  // Validate the whole authority before narrowing this authoring-only copy:
  // an invalid grant must not disappear with the resource it names. Keep all
  // command grants: one machine graph can have verbs in both realms.
  const grants = checkedGrants(app);
  const retained = new Set(Object.keys(resources ?? {}));
  const names = (value: boolean | string[]) => (Array.isArray(value) ? value.filter((name) => retained.has(name)) : value);
  const fields = <T>(value: Record<string, T> | undefined) =>
    value === undefined ? {} : { fields: Object.fromEntries(Object.entries(value).filter(([name]) => retained.has(name))) };
  const roles = Object.fromEntries(
    Object.entries(grants.roles).map(([role, grant]): [string, AppRoleGrant] => [
      role,
      {
        ...grant,
        read: names(grant.read),
        write: names(grant.write),
        ...(grant.create === undefined
          ? {}
          : { create: grant.create === false ? false : grant.create.filter((name) => retained.has(name)) }),
        ...(grant.export === undefined ? {} : { export: grant.export.filter((name) => retained.has(name)) }),
        ...fields(grant.fields),
      },
    ]),
  );
  /* The platform realm's `me` is its staff's row (auth.tenancy.platform.me), judged as auth.me is: each realm's
     conditions, stamps and notices are checked against the people that realm's lease reads. */
  const staff = realm === 'platform' ? app.auth?.tenancy?.platform?.me : undefined;
  const auth = {
    ...app.auth!,
    ...(staff ? { me: staff } : {}),
    roles,
    ...(grants.public
      ? { public: { ...grants.public, read: grants.public.read.filter((name) => retained.has(name)), ...fields(grants.public.fields) } }
      : {}),
  };
  return { app: { ...surface.app, ...(resources === undefined ? {} : { resources }), auth }, pages: surface.pages };
}

export function checkTenancy(app: AppDef, pages: readonly PageDef[]): void {
  const at = app.name;
  const auth = app.auth;
  const tenantApp = auth?.rows === 'tenant';
  const platform = auth?.tenancy?.platform !== undefined;
  const resources = app.resources ?? {};
  const owner = (name: string) => (Object.hasOwn(resources, name) ? resources[name].owner : undefined);
  /* A record's history() is kept on a tenant App too, under its key and its
     owner (tenant/tenantRecordHistoryStore.ts). */
  /* Notices are kept too, each in the inbox of the tenant whose record the
     write was to (tenant/tenantInbox.ts). */
  /* A dashboard's feed is served too: in a tenant's context it reads that
     tenant's changes alone (tenant/tenantHttp.ts, '/api/record-activity'). */
  /* A tenant's reads are its membership's, in the one location its source
     names; a reference into another source would read rows there that no
     tenant boundary covers. Within one source it is scoped like a real key. */
  for (const [name, resource] of Object.entries(resources)) {
    for (const [column, reference] of Object.entries(resource.references ?? {})) {
      const into = Object.hasOwn(resources, reference.to) ? resources[reference.to].source : undefined;
      if (tenantApp && into !== resource.source) {
        throw new Error(
          `${at}: resources "${name}", references "${column}" names ${reference.to}, in another source. A tenant App ("auth.rows": "tenant") ` +
            "reads each tenant's rows from its own source, so a reference stays within one. Declare it between resources of one source, or drop it.",
        );
      }
    }
  }

  /* Platform-only sources (`realm: 'platform'`): another database the platform
     realm alone reads. Every resource of one says so, and nothing that would
     write it, act on it or reach it some other way is accepted. */
  const platformOnly = new Set(
    Object.entries(app.sources ?? {})
      .filter(([, source]) => source.realm === 'platform')
      .map(([name]) => name),
  );
  const inPlatformOnly = (name: string) => Object.hasOwn(resources, name) && platformOnly.has(resources[name].source ?? '');
  for (const name of platformOnly) {
    if (!tenantApp || !platform) {
      throw new Error(
        `${at}: source "${name}" is "realm": "platform", a source the platform realm alone reads, which needs a tenant App ("auth.rows": "tenant") and the platform realm: auth.tenancy.platform.`,
      );
    }
  }
  for (const [name, resource] of Object.entries(resources)) {
    if (!inPlatformOnly(name)) continue;
    const here = `${at}: resources "${name}"`;
    if (resource.owner !== 'platform' || resource.access === 'write') {
      throw new Error(
        `${here} is in the platform-only source "${resource.source}", so it says "owner": "platform" and no "access": the platform realm reads it and nothing writes it.`,
      );
    }
    const acted = PLATFORM_ONLY_REFUSED.find((key) => resource[key] !== undefined);
    if (acted)
      throw new Error(
        `${here} has "${acted}", which a platform-only source's resource does not take: it is read, never written, acted on or searched.`,
      );
  }
  if (auth?.tenancy?.profile !== undefined && inPlatformOnly(auth.tenancy.profile)) {
    throw new Error(
      `${at}: "auth", "tenancy", "profile" names "${auth.tenancy.profile}", in a platform-only source. The profile is the App's own platform table, which a tenant's rows reference.`,
    );
  }
  const shown = auth?.public?.read.find(inPlatformOnly);
  if (shown)
    throw new Error(`${at}: "auth", "public", "read" names "${shown}", in a platform-only source, which only the platform realm reads.`);
  /* A home the App's own source cannot open. Every owner but the platform
     realm's reads is built without these sources (tenantBusinessApp), so an App
     whose every home rule reads one would project to no home at all: say so
     here rather than leave that to be discovered as an empty projection. */
  if (platformOnly.size && app.home.length) {
    const readsOutside = (key: string) => {
      const view = app.views[key] as
        | { table?: string; sections?: readonly { table?: string }[]; aside?: readonly { table?: string }[] }
        | undefined;
      return (
        view !== undefined &&
        ((view.table !== undefined && inPlatformOnly(view.table)) ||
          [...(view.sections ?? []), ...(view.aside ?? [])].some((section) => section.table !== undefined && inPlatformOnly(section.table)))
      );
    };
    if (app.home.every((rule) => readsOutside(rule.view))) {
      throw new Error(
        `${at}: every "home" rule opens a view that reads a platform-only source, so the App has no home of its own. ` +
          "Give it a home rule over its own source; a platform-only source is read by the platform realm's own reads alone.",
      );
    }
  }

  /* Ownership: every resource of a tenant App says whose rows it holds. */
  for (const [name, resource] of Object.entries(resources)) {
    const here = `${at}: resources "${name}"`;
    if (resource.clone !== undefined && !tenantApp)
      throw new Error(`${here} has a "clone", which says what a tenant clone copies; it needs "auth.rows": "tenant".`);
    if (resource.owner === undefined) {
      if (tenantApp) {
        throw new Error(
          `${here} has no "owner". In a tenant App ("auth.rows": "tenant") every resource says whose rows it holds: "tenant", "global" or "platform".`,
        );
      }
      continue;
    }
    if (!tenantApp)
      throw new Error(`${here} has an "owner", which says whose rows a tenant App's resource holds; it needs "auth.rows": "tenant".`);
    if (resource.owner === 'global' && resource.access === 'write') {
      throw new Error(
        `${here} is "owner": "global", rows every tenant reads and none owns, so it takes no "access": it is read, never written.`,
      );
    }
    if (resource.owner === 'platform' && !platform) throw new Error(`${here} is "owner": "platform", which ${NEEDS_PLATFORM}.`);
    /* A clone copies one tenant's rows into another: a global or platform row is no tenant's to copy. */
    if (resource.clone !== undefined && resource.owner !== 'tenant') {
      throw new Error(
        `${here} is "owner": "${resource.owner}" and says "clone": "${resource.clone}". A clone copies one tenant's rows into a sandbox tenant, so only an "owner": "tenant" resource takes "clone".`,
      );
    }
  }

  const tenancy = auth?.tenancy;
  if (tenancy) {
    if (!tenantApp) throw new Error(`${at}: "auth", "tenancy" describes a tenant App's tenants; it needs "auth.rows": "tenant".`);
    if (tenancy.profile !== undefined && owner(tenancy.profile) !== 'platform') {
      throw new Error(
        `${at}: "auth", "tenancy", "profile" names "${tenancy.profile}", which is not a platform-owned resource. The profile is the platform's table with one row per tenant: "owner": "platform".`,
      );
    }
    /* Each realm's `me` is its own people's row, read on its own lease (tenantHttp.ts tenantPerson): the platform's
       staff in a table only the platform reads, a tenant's people in tenant rows. A staff table a tenant could read,
       or one table named for both, would make a member's `me` and the staff's `me` the same question. */
    const staff = tenancy.platform?.me;
    if (staff && owner(staff.from) !== 'platform') {
      throw new Error(
        `${at}: "auth", "tenancy", "platform", "me" names "${staff.from}", which is not a platform-owned resource. The platform's \`me\` is a row of its own staff table, which no tenant reads: "owner": "platform".`,
      );
    }
    if (staff && auth?.me && owner(auth.me.from) === 'platform') {
      throw new Error(
        `${at}: "auth", "me" names "${auth.me.from}", a platform-owned resource, and "auth", "tenancy", "platform", "me" names the platform's staff. With both, "auth", "me" is a tenant's people: a resource with "owner": "tenant".`,
      );
    }
  }

  /* A signed-out visitor to a tenant App reads one tenant's public rows, by
     that tenant's public address, which the profile holds (tenantPublicRead.ts):
     so a tenant's resources and global ones, never the platform's. */
  if (tenantApp && auth?.public) {
    const platformOwned = auth.public.read.find((name) => owner(name) === 'platform');
    if (platformOwned !== undefined)
      throw new Error(
        `${at}: "auth", "public", "read" names "${platformOwned}", a platform-owned resource. A visitor reads one tenant's public rows and global ones, never the platform's.`,
      );
    if (tenancy?.profile === undefined)
      throw new Error(
        `${at}: "auth", "public" opens a tenant's rows to visitors by that tenant's public address, which its row in the profile holds; name the profile: "auth", "tenancy", "profile".`,
      );
  }

  /* Roles: with the platform realm, each is a tenant's role or the platform's, never both. */
  for (const [role, grant] of Object.entries(auth?.roles ?? {})) {
    const here = `${at}: "auth", role "${role}"`;
    if (!platform) {
      if (grant.realm !== undefined) throw new Error(`${here} has a "realm", which ${NEEDS_PLATFORM}.`);
      // A support session is a platform member entering a tenant, so without
      // the platform realm there is no history for either grant to read.
      if (grant.supportLog !== undefined || grant.supportAudit !== undefined)
        throw new Error(`${here} has "operations": ["support"], which ${NEEDS_PLATFORM}.`);
      continue;
    }
    if (grant.realm === undefined) {
      throw new Error(
        `${here} has no "realm". With the platform realm every role is a tenant's ("realm": "tenant") or the platform's ("realm": "platform").`,
      );
    }
    /* Each realm reads its own half of the support record — a dealer its own
       sessions, the lender every dealer's — and "operations": ["support"]
       takes the half from the realm, so neither can name the other's. */
    /* A platform role edits the platform's own rows generically
       and nothing else: a tenant's rows change through commands, which say
       what they do and are journaled; a global row is read by everyone and
       written by no one; a platform-only source is read, never written. The
       profile's row is the tenant's anchor, so no generic New makes one. */
    if (grant.realm === 'platform') {
      if (grant.write === true)
        throw new Error(
          `${here} is a platform role with "write": true. A platform role names the platform's own resources it edits; a tenant's rows change through commands.`,
        );
      const writes = [
        ...(Array.isArray(grant.write) ? grant.write.map((name) => ({ name, key: 'write' })) : []),
        ...(Array.isArray(grant.create) ? grant.create.map((name) => ({ name, key: 'create' })) : []),
        ...Object.entries(grant.fields ?? {})
          .filter(([, access]) => (access.write ?? []).length > 0)
          .map(([name]) => ({ name, key: 'fields' })),
      ];
      for (const { name, key } of writes) {
        // A name the App does not declare is the grant checks' to refuse, in their words.
        if (!Object.hasOwn(resources, name)) continue;
        const named = `${here} has "${key}" naming "${name}"`;
        if (inPlatformOnly(name))
          throw new Error(
            `${named}, in the platform-only source "${resources[name].source}": the platform realm reads it and nothing writes it.`,
          );
        if (owner(name) !== 'platform')
          throw new Error(
            `${named}, a ${owner(name) ?? 'tenant'}-owned resource. A platform role edits only the platform's own rows; a tenant's rows change through commands.`,
          );
        if (resources[name].access !== 'write')
          throw new Error(`${named}, which has no "access": "write": a platform role edits only a resource that may be written.`);
        if (key === 'create' && name === tenancy?.profile)
          throw new Error(`${named}, the tenancy profile: a tenant's profile row is made with the tenant, never by a generic New.`);
      }
      continue;
    }
    const named = [
      ...(Array.isArray(grant.read) ? grant.read : []),
      ...(Array.isArray(grant.write) ? grant.write : []),
      ...Object.keys(grant.fields ?? {}),
    ];
    const crossing = named.find((name) => owner(name) === 'platform');
    if (crossing) {
      throw new Error(
        `${here} is a tenant role and names "${crossing}", a platform-owned resource: a tenant's context never reads the platform realm's rows.`,
      );
    }
  }

  /* Realms on content: a word only the platform realm gives meaning to. */
  const groups: Array<{ at: string; realm?: AppRealm }> = [];
  const collect = (nodes: AppNavNode[]) =>
    nodes.forEach((node) => {
      if ('group' in node) {
        groups.push({ at: `nav group "${node.group}"`, realm: node.realm });
        collect(node.children);
      }
    });
  collect(app.nav);
  const realmed: Array<{ at: string; realm?: AppRealm }> = [
    ...Object.entries(app.views).map(([key, view]) => ({ at: `views "${key}"`, realm: realmOf(view) })),
    ...pages.map((page) => ({ at: `pages "${page.id}"`, realm: page.realm })),
    ...app.home.map((rule, i) => ({ at: `home rule ${i + 1}`, realm: rule.realm })),
    ...Object.entries(resources).flatMap(([name, resource]) =>
      (resource.actions ?? []).flatMap((action) =>
        action.command ? [{ at: `resources "${name}", action "${action.id}"`, realm: realmOf(action.command) }] : [],
      ),
    ),
    ...groups,
  ];
  if (!platform) {
    const stray = realmed.find((entry) => entry.realm !== undefined);
    if (stray) throw new Error(`${at}: ${stray.at} has a "realm", which ${NEEDS_PLATFORM}.`);
    return;
  }

  /* The menu: every root node says its realm, as a group or as its view; a
     group's children keep it. What the menu places, it places in one realm.
     One walk, shared with `appRealms` below, so the projection that decides
     which catalog each declaration is checked against reads the same menu. */
  const placed = navRealms(app, at, (message) => {
    throw new Error(message);
  });
  // Off the menu, a view is the App's own realm unless it says otherwise.
  const viewRealm = (key: string): AppRealm => placed.get(key) ?? realmOf(app.views[key]) ?? 'tenant';

  const platformTable = (tables: readonly (string | undefined)[]) =>
    tables.find((table) => table !== undefined && owner(table) === 'platform');
  for (const [key, view] of Object.entries(app.views)) {
    if (viewRealm(key) !== 'tenant') continue;
    const tables =
      'table' in view
        ? [view.table]
        : 'sections' in view
          ? [...view.sections, ...(view.aside ?? [])].map((section) => (section as { table?: string }).table)
          : [];
    const crossing = platformTable(tables);
    if (crossing) {
      throw new Error(
        `${at}: views "${key}" is in the tenant realm and reads "${crossing}", a platform-owned resource. Place it in a "platform" group, or give it "realm": "platform".`,
      );
    }
  }
  for (const page of pages) {
    const here = `${at}: pages "${page.id}"`;
    if (owner(page.base) === 'platform' && page.realm !== 'platform') {
      throw new Error(`${here} has the platform-owned base "${page.base}", so it says "realm": "platform".`);
    }
    if ((page.realm ?? 'tenant') !== 'tenant') continue;
    const crossing = platformTable(
      page.sections.flatMap((section) =>
        section.kind === 'timeline' ? section.streams.map((stream) => stream.from) : [(section as { from?: string }).from],
      ),
    );
    if (crossing) throw new Error(`${here} is in the tenant realm and reads "${crossing}", a platform-owned resource.`);
  }
  app.home.forEach((rule, i) => {
    if (rule.realm !== undefined && rule.realm !== viewRealm(rule.view)) {
      throw new Error(
        `${at}: home rule ${i + 1} is "realm": "${rule.realm}" and opens the view "${rule.view}", which is in the ${viewRealm(rule.view)} realm.`,
      );
    }
  });
}
