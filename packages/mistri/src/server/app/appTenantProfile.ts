/**
 * Startup's check of `auth.tenancy.shared`: the columns of the tenant's profile row its members' queries, row
 * scopes and handlers may read as `tenant.<column>` (tenantReadSource.ts readTenantProfile). Each must be a plain
 * value on the profile table — text, a number, a flag or a date — and not the row's key, which is the platform's
 * wiring, not a setting a member compares a row with. A reference shares its stored value (a plan kept as a pointer to
 * a vocabulary table reads as the plan's id), unless it points at the profile itself: that is another tenant's key. The platform realm reads across
 * tenants, so no tenant is meant there and `tenant.` is refused in its views (it would be an error per request).
 */
import type { AppDef, AppNavNode } from '../../shared/appModel.js';
import { columnKind, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppCatalogs } from './appMessages.js';
import type { TenantValue } from '@mistriwork/engine/shared/queryOperands.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { foldWhen } from '../commands/commandWhen.js';

/** Text, a number, a flag or a date: what a member may compare a row with. A document, bytes or a list is not. */
export function profileScalar(type: string): boolean {
  return !/json|blob|bytea|\[\]|array|xml|geometry|vector/i.test(type);
}

/* `tenant.<word>` outside quoted text, as the query language reads it (queryOperands.ts TENANT_VALUE). */
const TENANT_WORD = /(?<![\w.])tenant\.[A-Za-z_]\w*/g;
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

export function sharedProfileProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const tenancy = app.auth?.tenancy;
  const problems: string[] = [];
  const profile = tenancy?.profile;
  if (tenancy?.shared?.length && profile !== undefined) {
    const table = tableNamed(schema, profile);
    for (const name of tenancy.shared) {
      const where = `auth.tenancy.shared lists "${name}"`;
      const column = table?.columns.find((candidate) => candidate.name === name);
      if (!table) continue;
      if (!column) problems.push(`${where}, and the profile "${profile}" has no such column [tenant-shared-column].`);
      else if (column.primaryKey || schema.foreignKeys.some((fk) => fk.to.table === table.id && fk.to.columns.includes(name)))
        problems.push(`${where}, the profile's key; share a setting a member compares rows with [tenant-shared-column].`);
      else if (column.references?.table === table.id)
        problems.push(
          `${where}, which points at another tenant's profile; share a setting of this tenant's own (a reference to a vocabulary table shares its stored value) [tenant-shared-column].`,
        );
      else if (!profileScalar(column.type))
        problems.push(`${where}, which is ${column.type}; share text, a number, a flag or a date [tenant-shared-column].`);
    }
  }
  if (profile === undefined) return problems;
  const shared = new Set(tenancy?.shared ?? []);
  for (const [id, view] of Object.entries(app.views ?? {})) {
    /* A table with a column of that name reads its own column there, as the query language does. */
    const own = 'table' in view && typeof view.table === 'string' ? tableNamed(schema, view.table) : undefined;
    if (own?.columns.some((column) => column.name === 'tenant')) continue;
    for (const query of queriesIn(view))
      for (const [word] of query.replace(QUOTED, '""').matchAll(TENANT_WORD)) {
        if (view.realm === 'platform')
          problems.push(
            `view "${id}" reads ${word} in the platform realm, where no tenant is meant; quote it ("${word}") to mean the text [tenant-shared-platform].`,
          );
        else if (!shared.has(word.slice('tenant.'.length)))
          problems.push(
            `view "${id}" reads ${word}, and auth.tenancy.shared does not list "${word.slice('tenant.'.length)}" [tenant-shared-column].`,
          );
      }
  }
  return problems;
}

/**
 * Startup's check of `ui.catalog` ([ui-catalog]): a shared text column of the tenant's profile, naming a folder of
 * the App's catalogs (`messages/<variant>/<locale>.ts`). A variant folder with nothing to choose it is refused too:
 * its words would never be said.
 */
export function catalogColumnProblems(app: AppDef, schema: DatabaseSchema, catalogs: AppCatalogs | undefined): string[] {
  const column = app.ui.catalog;
  const folders = Object.keys(catalogs?.variants ?? {});
  if (column === undefined)
    return folders.length
      ? [
          `messages/ has ${folders.map((name) => `${name}/`).join(', ')}, and no ui.catalog names the tenant's column that picks one [ui-catalog].`,
        ]
      : [];
  const where = `ui.catalog reads "tenant.${column}"`;
  const tenancy = app.auth?.tenancy;
  if (tenancy?.profile === undefined) return [`${where}, and the App has no auth.tenancy.profile to read it from [ui-catalog].`];
  if (!tenancy.shared?.includes(column)) return [`${where}, and auth.tenancy.shared does not list "${column}" [tenant-shared-column].`];
  const type = tableNamed(schema, tenancy.profile)?.columns.find((candidate) => candidate.name === column)?.type;
  if (type !== undefined && columnKind(type) !== 'text')
    return [`${where}, which is ${type}; a folder's name is text like 'clinic' [ui-catalog].`];
  if (!catalogs) return [`${where}, and the App has no messages/ catalogs to choose among [ui-catalog].`];
  return [];
}

/* Every query string a view holds — its own, its tabs', its sections' — wherever it nests. */
function queriesIn(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) queriesIn(item, out);
  else if (value && typeof value === 'object')
    for (const [key, item] of Object.entries(value)) {
      if (key === 'query' && typeof item === 'string') out.push(item);
      else queriesIn(item, out);
    }
  return out;
}

/* Each `when` in the menu, with where it stands and the realm its group puts it in. */
function menuWhens(
  nodes: readonly AppNavNode[],
  realm?: string,
  out: Array<{ when: string; at: string; realm?: string }> = [],
): Array<{ when: string; at: string; realm?: string }> {
  for (const node of nodes) {
    const here = 'group' in node ? (node.realm ?? realm) : realm;
    const at = 'group' in node ? `group "${node.group}"` : 'view' in node ? `entry "${node.view}"` : `entry "${node.label}"`;
    if (node.when !== undefined) out.push({ when: node.when, at, ...(here ? { realm: here } : {}) });
    if ('group' in node) menuWhens(node.children, here, out);
  }
  return out;
}

/**
 * Startup's check of the menu's `when`s ([nav-when]): each folds over the tenant's shared profile (commandWhen.ts
 * foldWhen), so a tenant App with a profile; and none stands in the platform realm, which reads no tenant's.
 */
export function menuWhenProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const whens = menuWhens(app.nav);
  if (!whens.length) return [];
  const profile = app.auth?.tenancy?.profile;
  const table = profile === undefined ? undefined : tableNamed(schema, profile);
  return whens.flatMap(({ when, at, realm }): string[] => {
    const where = `nav ${at} has when "${when}"`;
    if (profile === undefined)
      return [`${where}; a menu's when reads the tenant's profile, and the App has no auth.tenancy.profile [nav-when].`];
    if (realm === 'platform') return [`${where} in the platform realm, which spans tenants and reads no tenant's profile [nav-when].`];
    if (!table) return [];
    try {
      foldWhen(table, app.auth?.tenancy?.shared ?? [], when);
      return [];
    } catch (error) {
      return [`${where}: ${(error as Error).message} [nav-when]`];
    }
  });
}

/** A menu judged for one tenant: what `menuFor` folds the App's `when`s into. */
interface TenantMenu {
  /** The profile columns its `when`s read: the values a projection of the menu is remembered by. */
  readonly columns: readonly string[];
  /** The nav with each entry and group whose `when` this profile does not meet left out, then each group left empty;
   * no `when` is sent on. Without a profile (the platform realm, a visitor) no `when` is met. */
  prune(nav: readonly AppNavNode[], tenant?: Readonly<Record<string, TenantValue>>): AppNavNode[];
  /** Which `when`s this profile meets, one character each: every profile that meets the same ones is shown the same
   * menu, so this, not the values it was judged from, is what a projection of the menu is remembered by. */
  met(tenant?: Readonly<Record<string, TenantValue>>): string;
  /** The App with its menu pruned for this profile, kept per App and per set of `when`s met: one captured copy for
   * every tenant that meets the same ones, so a projection keyed by its content finds it again. */
  shown(app: AppDef, tenant?: Readonly<Record<string, TenantValue>>): AppDef;
}

const menus = new WeakMap<AppDef, TenantMenu | null>();

/**
 * The App's menu `when`s, folded once per definition against the whole catalog (it holds the profile table, which a
 * member's served schema does not); undefined where the menu has none. A hidden entry is arrangement only: its room
 * still opens to whoever holds its grant, as `roles` on an entry does.
 */
export function menuFor(app: AppDef, schema: DatabaseSchema): TenantMenu | undefined {
  const held = menus.get(app);
  if (held !== undefined) return held ?? undefined;
  const whens = menuWhens(app.nav);
  const profile = app.auth?.tenancy?.profile;
  const table = profile === undefined ? undefined : tableNamed(schema, profile);
  if (!whens.length || !table) {
    menus.set(app, null);
    return undefined;
  }
  const shared = app.auth?.tenancy?.shared ?? [];
  const judged = new Map(whens.map(({ when }) => [when, foldWhen(table, shared, when)] as const));
  const columns = shared.filter((column) => whens.some(({ when }) => new RegExp(`\\btenant\\.${column}\\b`).test(when)));
  const met = (tenant: Readonly<Record<string, TenantValue>> | undefined) => (when: string) =>
    tenant !== undefined && judged.get(when)?.(tenant) === true;
  const shown = new WeakMap<AppDef, Map<string, AppDef>>();
  const menu: TenantMenu = {
    columns,
    prune: (nav, tenant) => pruneMenu(nav, met(tenant)),
    met(tenant) {
      const meets = met(tenant);
      return [...judged.keys()].map((when) => (meets(when) ? '1' : '0')).join('');
    },
    shown(app, tenant) {
      const meets = met(tenant);
      const key = menu.met(tenant);
      let held = shown.get(app);
      if (!held) shown.set(app, (held = new Map()));
      let pruned = held.get(key);
      if (!pruned) held.set(key, (pruned = captureTenantData({ ...app, nav: pruneMenu(app.nav, meets) })));
      return pruned;
    },
  };
  menus.set(app, menu);
  return menu;
}

/** The nav without each entry and group whose `when` is not met, then each group left empty; no `when` is sent on. */
function pruneMenu(nodes: readonly AppNavNode[], met: (when: string) => boolean): AppNavNode[] {
  return nodes.flatMap((node): AppNavNode[] => {
    if (node.when !== undefined && !met(node.when)) return [];
    const { when: _when, ...rest } = node;
    if (!('group' in node)) return [rest as AppNavNode];
    const children = pruneMenu(node.children, met);
    return children.length ? [{ ...(rest as typeof node), children }] : [];
  });
}

const visitors = new WeakMap<AppDef, AppDef>();

/**
 * The App as a visitor's menu shows it: a signed-out reader reads no profile, so meets no `when`. The definition
 * itself where its menu has none, and one captured copy per definition otherwise, so a projection keyed by its content
 * finds it again.
 */
export function visitorApp(app: AppDef): AppDef {
  if (!menuWhens(app.nav).length) return app;
  let visited = visitors.get(app);
  if (!visited) visitors.set(app, (visited = captureTenantData({ ...app, nav: pruneMenu(app.nav, () => false) })));
  return visited;
}
