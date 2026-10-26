/**
 * Composition: an App's `features`, merged into one flat root before
 * anything is parsed.
 *
 * A feature is an ordered slice of an App's content — views, pages, a nav
 * fragment of its own views, how its resources present, home rules — and the
 * authority that content needs: grants to the roles the App declares, and the
 * App's own bindings and ceilings restated. The merge is one pure function
 * over authored data, run by the parse fronts (parseAppConfig and
 * parseAppPages) and by the loader, which keeps the provenance it returns to
 * report authority. A root without `features` passes through untouched, so a
 * flat App parses exactly as it always did.
 *
 * The rules, each refusal naming the contributors involved — "the App", or
 * features "<id>":
 *   - a key is an address, so a view, page or nav group id is declared once
 *     across the App and all its features, even identically;
 *   - a resource fact (a display rule or caption per column, a form, a page, a
 *     binding or ceiling, a column grant) merges when equal and is refused
 *     otherwise; validation rules and actions concatenate in contributor
 *     order, an equal repeat from another contributor kept once;
 *   - a feature never widens authority: its grants add to roles the App
 *     declares, by name and within the ceilings the App states, and a binding
 *     or ceiling it states must be the App's own;
 *   - home rules append after the App's, and none may follow another
 *     contributor's rule that already matches every visitor.
 * Then the flattened root meets every existing rule, unchanged: features
 * never loosen one.
 */
import { VIEW_KEY, allowKeys, isRecord, plainRecord } from '@mistriwork/engine/shared/model.js';
import { RESOURCE_BLOCK_KEYS } from './appResourceBlocks.js';
import { MAX_FORM_RULES } from './formRules.js';
import { sameData } from './authoredData.js';
import { apiAuthorityKey, composeAppApi, type AppApiDef } from './appApi.js';
import { captureFlagDeclaration } from './appExperiments.js';
import { flagCapabilityKey, normalizeFlagCapabilities } from './appFlagCapabilities.js';

/** The contributor every flat App fact comes from. */
export const THE_APP = 'the App';

/** The keys a feature takes. Everything else at a feature's root is the App's. */
export const FEATURE_KEYS = [
  'id',
  'resources',
  'auth',
  'views',
  'pages',
  'nav',
  'home',
  'api',
  'flags',
  'audiences',
  'experiments',
  'analytics',
] as const;

/**
 * Who contributed what, kept beside the flattened root. Server-side only:
 * nothing here is served, and a flat App's origins are empty.
 */
export interface AppOrigins {
  /** Feature ids, in `features` order. */
  features: string[];
  /** View key → the id of the feature that declares it; absent: the App. */
  views: Record<string, string>;
  pages: Record<string, string>;
  /**
   * Authority fact → every contributor that states it, in order: a
   * resource's `resources.<r>.<physical|access|fields|owner|audit>`, and a
   * role's `roles.<role>.<read|write|commands|actions|operations|fields>.<name>`.
   * Absent: the App.
   */
  authority: Record<string, string[]>;
  /** Each rule of a home that features append to: who wrote it, and its number there. Absent: the App's home alone. */
  home?: Array<{ by: string; n: number }>;
  /** Each spliced fragment entry: its path in the merged nav (1-based, one number per level), who wrote it, and its number in the fragment. */
  nav: Array<{ path: number[]; by: string; n: number }>;
  resources: Record<string, ResourceOrigins>;
}

/** Who wrote what in one merged resource block, by contributor ("the App", or features "<id>"). */
export interface ResourceOrigins {
  /** Every contributor to the block, in order. */
  by: string[];
  display: Record<string, string>;
  labels: Record<string, string>;
  form?: string;
  page?: string;
  recordLabel?: string;
  /** Who wrote each action, by id. */
  actions: Record<string, string>;
  /** The merged validation rules, in order: who wrote each. */
  validation: string[];
}

const MAX_FEATURES = 64;
const APP_ONLY = {
  name: "is the App's: an App is named once, in its own name",
  connection: "is the App's: bindings to server connections are declared once, in the App",
  sources: "is the App's: bindings to server connections are declared once, in the App",
  ui: "is the App's: chrome is one per App, in the App's ui",
  features:
    "is the App's: composition is one level, so the App lists every feature (nesting is plain TypeScript: features: [...shared, leads])",
};
const APP_AUTH = "is the App's: sign-in and row scoping are one security manifest, in the App's auth";
/** What bounds what the App reads and writes. A feature restates the App's, and never states one it does not. */
const CEILING_FACTS: readonly string[] = ['physical', 'access', 'delete', 'fields', 'owner'];
/** Why a whole fact is one value per resource, not merged. */
const WHOLE: Record<string, string> = {
  form: 'A New form is one per resource, and its order, groups and steps span its columns, so it is not merged: keep it in one place.',
  page: 'A resource opens through one page: keep the choice in one place.',
  audit: 'What the audit keeps is one rule per resource: keep it in one place.',
  recordLabel: 'A resource has one record name: keep the path in one place.',
};

interface Contributor {
  /** "the App", or features "<id>". */
  by: string;
  /** Where a message about the whole contributor starts, and the prefix for one of its parts. */
  at: string;
  within: string;
  raw: Record<string, unknown>;
  id?: string;
}

/**
 * The root with its features merged in, and who contributed what. Throws,
 * naming every contributor involved, on any merge a rule refuses; the
 * flattened root is then the parsers' to judge like any other.
 *
 * The api block is the one part composition cannot merge while it is still
 * raw — crediting a contributor and comparing two command references needs
 * the parsed shapes — so composeAppApi parses it here, and it is handed back
 * as `api` instead of being written onto the root. The root a caller gets is
 * therefore raw everywhere it still has to be parsed: putting a parsed
 * AppApiDef back under `root.api` made parseRoot parse it a second time, and
 * a command reference does not survive that (its `input` normalises from an
 * object of fields to a list, which the second parse rightly refuses).
 * Callers that only want pages or origins can ignore it.
 */
export function composeFeatures(raw: unknown, where: string): { root: unknown; origins: AppOrigins; api?: AppApiDef } {
  const origins: AppOrigins = { features: [], views: {}, pages: {}, authority: {}, nav: [], resources: {} };
  if (!isRecord(raw) || raw.features === undefined) {
    const stray = isRecord(raw) ? placementIn(raw.nav, 0) : undefined;
    if (stray) {
      throw new Error(
        `${where}: "nav" places { feature: '${String(stray.feature)}' }, and the App lists no "features". ` +
          'Add the feature to "features", or remove the placement.',
      );
    }
    return { root: raw, origins };
  }
  const a = plainRecord(raw, where, 'an object');
  const app: Contributor = { by: THE_APP, at: where, within: `${where}: `, raw: a };
  const features = readFeatures(a.features, where);
  origins.features = features.map((feature) => feature.id!);
  const all = [app, ...features];
  const credit = (path: string, by: string) => {
    const list = (origins.authority[path] ??= []);
    if (!list.includes(by)) list.push(by);
  };

  const views = keyed(all, 'views', 'view', where, origins.views);
  const pages = keyed(all, 'pages', 'page', where, origins.pages);
  const flags = keyed(all, 'flags', 'flag', where, {});
  const audiences = keyed(all, 'audiences', 'audience', where, {});
  const experiments = keyed(all, 'experiments', 'experiment', where, {});
  for (const key of ['flags', 'experiments'] as const) {
    const declarations = key === 'flags' ? flags : experiments;
    for (const [id, by] of declarations?.by ?? []) credit(`${key}.${id}`, by);
  }
  const analytics = mergeAnalytics(all, where);
  const resources = mergeResources(all, where, origins, credit);
  checkCommandReferences(all, where);
  const auth = mergeGrants(app, features, where, credit);
  const home = mergeHome(app, features, where, origins);
  const nav = mergeNav(app, features, where, views?.by ?? new Map(), origins);
  const declaredAuth = isRecord(a.auth) && isRecord(a.auth.roles) ? a.auth.roles : {};
  const api =
    a.api !== undefined || features.some((feature) => feature.raw.api !== undefined)
      ? composeAppApi(
          a.api,
          features.map((feature) => ({ id: feature.id!, api: feature.raw.api })),
          Object.keys(declaredAuth),
          `${where}: api`,
        )
      : { api: undefined, authority: {} };
  Object.assign(origins.authority, api.authority);
  for (const { view } of api.api?.views ?? []) {
    origins.authority[apiAuthorityKey('viewDefinition', view)] = [origins.views[view] ? `features "${origins.views[view]}"` : THE_APP];
  }
  // `api` leaves the root: it is already parsed, and only parsed once.
  const { features: _features, api: _api, ...rest } = a;
  return {
    root: {
      ...rest,
      ...(views ? { views: views.merged } : {}),
      ...(pages ? { pages: pages.merged } : {}),
      ...(flags ? { flags: flags.merged } : {}),
      ...(audiences ? { audiences: audiences.merged } : {}),
      ...(experiments ? { experiments: experiments.merged } : {}),
      ...(analytics ? { analytics } : {}),
      ...(resources ? { resources } : {}),
      ...(auth ? { auth } : {}),
      ...(home ? { home } : {}),
      ...(nav ? { nav } : {}),
    },
    origins,
    ...(api.api ? { api: api.api } : {}),
  };
}

function readFeatures(raw: unknown, where: string): Contributor[] {
  if (!Array.isArray(raw) || raw.length > MAX_FEATURES) {
    throw new Error(
      `${where}: "features" must be a list of at most ${MAX_FEATURES} features, each { id, resources?, auth?, views?, pages?, nav?, home? }.`,
    );
  }
  const seen = new Map<string, number>();
  return raw.map((entry, i) => {
    const feature = plainRecord(
      entry,
      `${where}: features ${i + 1}`,
      'an object: a feature is { id, resources?, auth?, views?, pages?, nav?, home? }',
    );
    const id = feature.id;
    if (typeof id !== 'string' || !VIEW_KEY.test(id)) {
      throw new Error(
        `${where}: features ${i + 1} needs an "id" of lowercase letters, digits and hyphens; it names the feature in refusals, in the authority report and in a nav placement.`,
      );
    }
    const first = seen.get(id);
    if (first !== undefined) throw new Error(`${where}: features ${first + 1} and ${i + 1} both have the id "${id}".`);
    seen.set(id, i);
    const at = `${where}: features "${id}"`;
    allowKeys(feature, FEATURE_KEYS, at, APP_ONLY);
    if (!FEATURE_KEYS.some((key) => key !== 'id' && feature[key] !== undefined)) {
      throw new Error(`${at} contributes nothing: give it views, pages, nav, resources, home or auth, or remove it.`);
    }
    return { by: `features "${id}"`, at, within: `${at}, `, raw: feature, id };
  });
}

/** Views or pages: the union of every contributor's keys, each declared once. */
function keyed(
  all: readonly Contributor[],
  key: 'views' | 'pages' | 'flags' | 'audiences' | 'experiments',
  word: string,
  where: string,
  owners: Record<string, string>,
): { merged: Record<string, unknown>; by: Map<string, string> } | undefined {
  if (
    all.every((contributor) =>
      key === 'views' || key === 'pages' ? contributor.raw[key] === undefined : !Object.hasOwn(contributor.raw, key),
    )
  )
    return undefined;
  const merged: Record<string, unknown> = {};
  const by = new Map<string, string>();
  for (const contributor of all) {
    const descriptor = Object.getOwnPropertyDescriptor(contributor.raw, key);
    if (descriptor && ['flags', 'audiences', 'experiments'].includes(key) && (!('value' in descriptor) || !descriptor.enumerable))
      throw new Error(`${where}: ${key} requires plain data.`);
    const record =
      ['flags', 'audiences', 'experiments'].includes(key) && descriptor ? captureFlagDeclaration(descriptor.value) : contributor.raw[key];
    if (record === undefined) continue;
    if (!isRecord(record)) throw new Error(`${contributor.within}"${key}" must be an object of ${key} keyed by id.`);
    for (const [id, value] of Object.entries(record)) {
      const first = by.get(id);
      if (first !== undefined) {
        throw new Error(
          `${where}: ${key} "${id}" is declared by ${first} and ${contributor.by}. A ${word} key is its address, so it is declared once across the App and its features: rename one.`,
        );
      }
      by.set(id, contributor.by);
      merged[id] = value;
      if (contributor.id !== undefined) owners[id] = contributor.id;
    }
  }
  return { merged, by };
}

/**
 * The analytics block: `collect` is a union, and each custom event and funnel
 * is declared once across the App and its features (a name is its address).
 */
function mergeAnalytics(all: readonly Contributor[], where: string): Record<string, unknown> | undefined {
  if (all.every((contributor) => !Object.hasOwn(contributor.raw, 'analytics'))) return undefined;
  const collect: unknown[] = [];
  const events: Record<string, unknown> = {},
    funnels: Record<string, unknown> = {};
  const by = { events: new Map<string, string>(), funnels: new Map<string, string>() };
  for (const contributor of all) {
    const descriptor = Object.getOwnPropertyDescriptor(contributor.raw, 'analytics');
    if (!descriptor) continue;
    if (!('value' in descriptor) || !descriptor.enumerable) throw new Error(`${where}: analytics requires plain data.`);
    const block = captureFlagDeclaration(descriptor.value);
    if (!isRecord(block)) throw new Error(`${contributor.within}"analytics" must be an object.`);
    if (block.collect !== undefined && !Array.isArray(block.collect))
      throw new Error(`${contributor.within}analytics collect must be a list.`);
    for (const kind of (block.collect as unknown[] | undefined) ?? []) if (!collect.includes(kind)) collect.push(kind);
    for (const [key, target] of [
      ['events', events],
      ['funnels', funnels],
    ] as const) {
      const entries = block[key];
      if (entries === undefined) continue;
      if (!isRecord(entries)) throw new Error(`${contributor.within}analytics ${key} must be an object.`);
      for (const [name, value] of Object.entries(entries)) {
        const first = by[key].get(name);
        if (first !== undefined) {
          throw new Error(
            `${where}: analytics ${key === 'events' ? 'event' : 'funnel'} "${name}" is declared by ${first} and ${contributor.by}. A name is its address, so it is declared once across the App and its features: rename one. [analytics-name-clash]`,
          );
        }
        by[key].set(name, contributor.by);
        target[name] = value;
      }
    }
  }
  return {
    ...(collect.length ? { collect } : {}),
    ...(by.events.size ? { events } : {}),
    ...(by.funnels.size ? { funnels } : {}),
  };
}

/** One block per resource, every contributor's facts merged into it by the rules above. */
function mergeResources(
  all: readonly Contributor[],
  where: string,
  origins: AppOrigins,
  credit: (path: string, by: string) => void,
): Record<string, unknown> | undefined {
  if (all.every((contributor) => contributor.raw.resources === undefined)) return undefined;
  const appBlocks = isRecord(all[0].raw.resources) ? all[0].raw.resources : {};
  const merged: Record<string, Record<string, unknown>> = {};
  /* Who set each whole fact, and each display or label column, first. */
  const firstBy = new Map<string, string>();
  const listed = new Map<string, Array<{ value: unknown; by: string; n: number }>>();
  for (const contributor of all) {
    const blocks = contributor.raw.resources;
    if (blocks === undefined) continue;
    if (!isRecord(blocks)) throw new Error(`${contributor.within}"resources" must be an object of resource blocks keyed by logical name.`);
    for (const [name, block] of Object.entries(blocks)) {
      const at = `${contributor.within}resources "${name}"`;
      const here = `${where}: resources "${name}"`;
      if (!isRecord(block)) throw new Error(`${at} is not an object.`);
      if (contributor.id !== undefined) allowKeys(block, [...RESOURCE_BLOCK_KEYS, 'owner', 'audit'], at);
      const into = (merged[name] ??= {});
      const origin = (origins.resources[name] ??= { by: [], display: {}, labels: {}, actions: {}, validation: [] });
      if (!origin.by.includes(contributor.by)) origin.by.push(contributor.by);
      for (const [key, value] of Object.entries(block)) {
        if (value === undefined) continue;
        const path = `resources.${name}.${key}`;
        if (CEILING_FACTS.includes(key)) {
          if (contributor.id !== undefined) {
            const stated = isRecord(appBlocks[name]) ? (appBlocks[name] as Record<string, unknown>)[key] : undefined;
            if (stated === undefined) {
              throw new Error(
                `${at} has "${key}", which the App does not state. A feature restates the App's bindings and ceilings and never widens them: ` +
                  `state it in the App's resources.${name}, or drop it from the feature.`,
              );
            }
            if (!sameData(stated, value)) {
              throw new Error(
                `${here} ${key} is stated by the App and ${contributor.by}, differently. A feature restates the App's bindings and ceilings exactly, and never widens them.`,
              );
            }
          }
          into[key] = value;
          credit(path, contributor.by);
        } else if (key === 'display' || key === 'labels' || key === 'actions') {
          if (!isRecord(value))
            throw new Error(`${at} has a "${key}" that is not an object keyed by ${key === 'actions' ? 'action id' : 'column'}.`);
          const columns = (into[key] ??= {}) as Record<string, unknown>;
          for (const [column, rule] of Object.entries(value)) {
            const first = firstBy.get(`${path}.${column}`);
            if (first === undefined) {
              firstBy.set(`${path}.${column}`, contributor.by);
              columns[column] = rule;
              origin[key][column] = contributor.by;
            } else if (!sameData(columns[column], rule)) {
              if (key === 'actions') {
                throw new Error(
                  `${here} has the action "${column}" from ${first} and ${contributor.by}, and they differ in "${differingKey(columns[column], rule)}". ` +
                    'An id names one action on a resource: keep one definition, or give one another id.',
                );
              }
              throw new Error(
                `${here} ${key} "${column}" is set by ${first} and ${contributor.by}, differently. ` +
                  `One ${key === 'display' ? 'rule' : 'caption'} per column: keep it in one place, or share one constant.`,
              );
            }
          }
        } else if (key === 'validation' || key === 'notify') {
          if (!Array.isArray(value)) throw new Error(`${at} has "${key}" that are not a list.`);
          const entries = listed.get(path) ?? [];
          listed.set(path, entries);
          for (const [i, item] of value.entries()) {
            const same = entries.find((entry) => entry.by !== contributor.by && sameData(entry.value, item));
            if (!same) entries.push({ value: item, by: contributor.by, n: i + 1 });
          }
          into[key] = entries.map((entry) => entry.value);
          if (key === 'validation') origin.validation = entries.map((entry) => entry.by);
        } else {
          const first = firstBy.get(path);
          if (first === undefined) {
            firstBy.set(path, contributor.by);
            into[key] = value;
            if (key === 'form' || key === 'page' || key === 'recordLabel') origin[key] = contributor.by;
          } else if (!sameData(into[key], value)) {
            throw new Error(`${here} ${key} is declared by ${first} and ${contributor.by}, differently. ${WHOLE[key] ?? ''}`.trim());
          }
          if (key === 'audit') credit(path, contributor.by);
        }
      }
    }
  }
  /* The cap is the merged list's; a list one contributor alone overfills is the parser's to refuse. */
  for (const [path, entries] of listed) {
    const by = [...new Set(entries.map((entry) => entry.by))];
    if (!path.endsWith('.validation') || entries.length <= MAX_FORM_RULES || by.length < 2) continue;
    const counts = by.map((name) => `${name} ${entries.filter((entry) => entry.by === name).length}`).join(', ');
    throw new Error(
      `${where}: resources "${path.slice('resources.'.length, -'.validation'.length)}" has ${entries.length} validation rules (${counts}); the limit is ${MAX_FORM_RULES}.`,
    );
  }
  return merged;
}

/** One command id means one reference, whichever contributors offer it. */
function checkCommandReferences(all: readonly Contributor[], where: string): void {
  const seen = new Map<string, { ref: Record<string, unknown>; by: string; at: string }>();
  for (const contributor of all) {
    const refs: Array<[Record<string, unknown>, string]> = [];
    const { resources, views } = contributor.raw;
    for (const [name, block] of Object.entries(isRecord(resources) ? resources : {})) {
      if (!isRecord(block) || !isRecord(block.actions)) continue;
      for (const [id, action] of Object.entries(block.actions)) {
        if (isRecord(action) && isRecord(action.command)) refs.push([action.command, `resources "${name}", action "${id}"`]);
      }
    }
    for (const [key, view] of Object.entries(isRecord(views) ? views : {})) {
      if (isRecord(view) && isRecord(view.command)) refs.push([view.command, `views "${key}"`]);
    }
    for (const [ref, at] of refs) {
      if (typeof ref.id !== 'string') continue;
      const first = seen.get(ref.id);
      if (!first) seen.set(ref.id, { ref, by: contributor.by, at });
      else if (first.by !== contributor.by && !sameData(first.ref, ref)) {
        throw new Error(
          `${where}: the command "${ref.id}" is referenced by ${first.by} (${first.at}) and ${contributor.by} (${at}), ` +
            `and the references differ in "${differingKey(first.ref, ref)}". A command has one reference: export it once and import it.`,
        );
      }
    }
  }
}

/**
 * Role grants: additive, only to roles the App declares, by name and within
 * the App's ceilings. A column grant is one fact per role and resource.
 */
function mergeGrants(
  app: Contributor,
  features: readonly Contributor[],
  where: string,
  credit: (path: string, by: string) => void,
): Record<string, unknown> | undefined {
  const granting = features.filter((feature) => feature.raw.auth !== undefined);
  if (!granting.length) return undefined;
  const auth = app.raw.auth;
  const appRoles = isRecord(auth) && isRecord(auth.roles) ? auth.roles : undefined;
  const blocks = isRecord(app.raw.resources) ? app.raw.resources : {};
  const access = (name: string) => (isRecord(blocks[name]) ? (blocks[name] as Record<string, unknown>).access : undefined);
  const ceiling = {
    read: Object.keys(blocks),
    write: Object.keys(blocks).filter((name) => access(name) === 'write'),
  };
  const roles: Record<string, Record<string, unknown>> = {};
  const firstBy = new Map<string, string>();
  for (const [role, grant] of Object.entries(appRoles ?? {})) {
    if (!isRecord(grant)) throw new Error(`${app.within}"auth", role "${role}" is not an object.`);
    plainRecord(grant, `${app.within}"auth", role "${role}"`, 'a role grant');
    roles[role] = { ...grant };
    for (const key of ['flags', 'experiments'] as const) {
      if (!Object.hasOwn(grant, key)) continue;
      const entries = normalizeFlagCapabilities(grant[key], key);
      roles[role][key] = entries;
      for (const entry of entries) credit(`roles.${role}.${key}.${flagCapabilityKey(entry)}`, THE_APP);
    }
    for (const key of ['read', 'write', 'commands', 'operations']) {
      if (Array.isArray(grant[key])) for (const name of grant[key] as unknown[]) credit(`roles.${role}.${key}.${String(name)}`, THE_APP);
    }
    for (const resource of Object.keys(isRecord(grant.fields) ? grant.fields : {}))
      firstBy.set(`roles.${role}.fields.${resource}`, THE_APP);
    for (const [resource, labels] of Object.entries(isRecord(grant.actions) ? grant.actions : {})) {
      if (Array.isArray(labels)) for (const label of labels) credit(`roles.${role}.actions.${resource}.${String(label)}`, THE_APP);
    }
  }
  for (const feature of granting) {
    const at = `${feature.within}"auth"`;
    const raw = feature.raw.auth;
    if (!isRecord(raw)) throw new Error(`${at} is not an object { roles }.`);
    allowKeys(
      raw,
      ['roles'],
      at,
      Object.fromEntries(
        ['providers', 'signUp', 'store', 'defaultRole', 'rows', 'challenge', 'tenancy', 'me'].map((key) => [key, APP_AUTH]),
      ),
    );
    if (!isRecord(raw.roles) || !Object.keys(raw.roles).length)
      throw new Error(`${at} has "roles" that are not a non-empty object of grants to the App's roles.`);
    if (!appRoles)
      throw new Error(
        `${at} grants to roles, and the App declares none in auth.roles. A feature grants to the App's roles and never creates one.`,
      );
    for (const [role, grant] of Object.entries(raw.roles)) {
      const here = `${at}, role "${role}"`;
      if (!Object.hasOwn(roles, role)) {
        throw new Error(
          `${here} is not a role the App declares; a feature grants to the App's roles and never creates one. The App declares: ${Object.keys(roles).join(', ')}.`,
        );
      }
      if (!isRecord(grant)) throw new Error(`${here} is not an object.`);
      plainRecord(grant, here, 'a role grant');
      allowKeys(grant, ['read', 'write', 'commands', 'actions', 'operations', 'fields', 'realm', 'flags', 'experiments'], here, {
        claims: "is the App's to say: which claims give a role is identity authority, declared in the App's own auth.roles",
      });
      const into = roles[role];
      for (const key of ['flags', 'experiments'] as const) {
        if (!Object.hasOwn(grant, key)) continue;
        const entries = normalizeFlagCapabilities(grant[key], key);
        into[key] = [...(Array.isArray(into[key]) ? (into[key] as unknown[]) : []), ...entries];
        for (const entry of entries) credit(`roles.${role}.${key}.${flagCapabilityKey(entry)}`, feature.by);
      }
      // A realm is identity authority owned by the root, not an additive grant.
      if (grant.realm !== undefined) {
        if (into.realm === undefined) {
          throw new Error(
            `${here}, "realm" is not declared by the App. A feature may only restate the App's explicit role realm; declare it in the App's auth.roles.`,
          );
        }
        if (!sameData(into.realm, grant.realm)) {
          throw new Error(`${here}, "realm" differs from the App's. A feature may only restate the App's explicit role realm.`);
        }
      }
      for (const key of ['read', 'write'] as const) {
        if (grant[key] === undefined) continue;
        if (typeof grant[key] === 'boolean') {
          throw new Error(
            `${here}, "${key}" is ${String(grant[key])}. A feature grants the resources its content needs by name; true, the App's whole ceiling, is the App's to grant.`,
          );
        }
        const names = nameList(grant[key], `${here}, "${key}"`, 'resource names');
        for (const name of names) {
          if (!ceiling[key].includes(name)) {
            throw new Error(
              `${here}, "${key}" names "${name}", which is outside the App's ${key} ceiling. A feature grants within the ceilings the App states, and never widens them. ` +
                `${key === 'read' ? 'Declared resources' : "Resources with access 'write'"}: ${ceiling[key].join(', ') || 'none'}.`,
            );
          }
          if (into[key] === true) credit(`roles.${role}.${key}.${name}`, THE_APP);
          credit(`roles.${role}.${key}.${name}`, feature.by);
        }
        if (into[key] !== true) into[key] = union(Array.isArray(into[key]) ? (into[key] as unknown[]) : [], names);
      }
      for (const key of ['commands', 'operations'] as const) {
        if (grant[key] === undefined) continue;
        const names = nameList(grant[key], `${here}, "${key}"`, key === 'commands' ? 'command ids' : 'operations');
        /* Who reads a dealer's support history is the App's to declare in its own roles, never a feature's to widen. */
        if (key === 'operations' && names.includes('support'))
          throw new Error(
            `${here}, "operations" names "support", which only the App's own roles grant: the support sessions are its to open.`,
          );
        into[key] = union(Array.isArray(into[key]) ? (into[key] as unknown[]) : [], names);
        for (const name of names) credit(`roles.${role}.${key}.${name}`, feature.by);
      }
      /* Fixed actions: additive by resource and label, like commands. */
      if (grant.actions !== undefined) {
        if (!isRecord(grant.actions)) throw new Error(`${here}, "actions" must be an object of resource → action ids.`);
        const actions = { ...(isRecord(into.actions) ? into.actions : {}) } as Record<string, unknown>;
        for (const [resource, labels] of Object.entries(grant.actions)) {
          const names = nameList(labels, `${here}, "actions", "${resource}"`, 'action ids');
          actions[resource] = union(Array.isArray(actions[resource]) ? (actions[resource] as unknown[]) : [], names);
          for (const name of names) credit(`roles.${role}.actions.${resource}.${String(name)}`, feature.by);
        }
        into.actions = actions;
      }
      if (grant.fields !== undefined) {
        if (!isRecord(grant.fields)) throw new Error(`${here}, "fields" must be an object of field grants keyed by resource.`);
        const fields = { ...(isRecord(into.fields) ? into.fields : {}) };
        for (const [resource, rule] of Object.entries(grant.fields)) {
          const path = `roles.${role}.fields.${resource}`;
          const first = firstBy.get(path);
          if (first !== undefined && !sameData(fields[resource], rule)) {
            throw new Error(
              `${where}: "auth", role "${role}" fields "${resource}" are granted by ${first} and ${feature.by}, differently. ` +
                'A column grant is one fact per role and resource: keep it in one place.',
            );
          }
          if (first === undefined) {
            firstBy.set(path, feature.by);
            fields[resource] = rule;
          }
          credit(path, feature.by);
        }
        into.fields = fields;
      }
    }
  }
  return { ...(isRecord(auth) ? auth : {}), roles };
}

/** Home rules: the App's, then each feature's in `features` order, never one after another contributor's catch-all. */
function mergeHome(app: Contributor, features: readonly Contributor[], where: string, origins: AppOrigins): unknown[] | undefined {
  const adding = features.filter((feature) => feature.raw.home !== undefined);
  if (!adding.length) return undefined;
  const rules: unknown[] = [];
  let everyone: { by: string; n: number } | undefined;
  let signedOut: { by: string; n: number } | undefined;
  for (const contributor of [app, ...adding]) {
    const home = contributor.raw.home;
    if (home === undefined) continue;
    const own = typeof home === 'string' ? [{ view: home }] : Array.isArray(home) && home.length ? home : undefined;
    if (!own) throw new Error(`${contributor.within}"home" is not a view id or a non-empty list of rules { view, signedOut?, roles? }.`);
    own.forEach((rule, i) => {
      const n = i + 1;
      if (everyone && everyone.by !== contributor.by) {
        throw new Error(
          `${where}: home rule ${n} of ${contributor.by} can never match: rule ${everyone.n} of ${everyone.by} has no condition and matches every visitor first. ` +
            'Only the last rule of the combined list may match everyone.',
        );
      }
      if (isRecord(rule)) {
        if (rule.signedOut === true && signedOut && signedOut.by !== contributor.by) {
          throw new Error(
            `${where}: home rule ${n} of ${contributor.by} can never match: rule ${signedOut.n} of ${signedOut.by} already sends every signed-out visitor to its view.`,
          );
        }
        if (rule.signedOut === undefined && rule.roles === undefined) everyone ??= { by: contributor.by, n };
        if (rule.signedOut === true) signedOut ??= { by: contributor.by, n };
      }
      rules.push(rule);
      (origins.home ??= []).push({ by: contributor.by, n });
    });
  }
  return rules;
}

/**
 * Nav: each feature's fragment arranges only its own views; the App's nav
 * places each fragment once with `{ feature }`, or, without a nav of its
 * own, gets the fragments in `features` order. Group ids are one namespace.
 * Where each fragment entry lands is kept, so a refusal the nav parser makes
 * about it names the feature, at the entry's place in its fragment.
 */
function mergeNav(
  app: Contributor,
  features: readonly Contributor[],
  where: string,
  viewsBy: ReadonlyMap<string, string>,
  origins: AppOrigins,
): unknown[] | undefined {
  const fragments = new Map<string, { nav: unknown[]; by: string; within: string }>();
  for (const feature of features) {
    const nav = feature.raw.nav;
    if (nav === undefined) continue;
    if (!Array.isArray(nav) || !nav.length)
      throw new Error(`${feature.within}"nav" must be a non-empty list of its own views, checked App links and groups.`);
    const own = new Set(isRecord(feature.raw.views) ? Object.keys(feature.raw.views) : []);
    walkNav(nav, feature.within, (node, at) => {
      if (isRecord(node) && Object.hasOwn(node, 'feature')) {
        throw new Error(
          `${at} places features "${String(node.feature)}". Placing a fragment is the App's nav's work; a feature's nav arranges its own views.`,
        );
      }
      // Checked destinations are not references to a feature's local views.
      // The nav parser validates their closed, row-free shape after composition.
      if (isRecord(node) && Object.hasOwn(node, 'to')) return;
      const view = typeof node === 'string' ? node : isRecord(node) && Object.hasOwn(node, 'view') ? node.view : undefined;
      if (typeof view === 'string' && !own.has(view)) {
        throw new Error(
          `${at} names the view "${view}", which ${viewsBy.get(view) ?? 'neither the App nor any feature'} declares. ` +
            "A feature's nav arranges its own views; arrange across features in the App's nav.",
        );
      }
    });
    fragments.set(feature.id!, { nav, by: feature.by, within: feature.within });
  }
  const groups = new Map<string, string>();
  const claim = (node: unknown, by: string, at: string) => {
    if (!isRecord(node) || !Array.isArray(node.children) || typeof node.id !== 'string') return;
    const first = groups.get(node.id);
    if (first !== undefined) {
      throw new Error(
        `${at}: the nav group "${node.id}" is declared by ${first} and ${by}. A group id is unique across the App's nav and every fragment in it.`,
      );
    }
    groups.set(node.id, by);
  };
  /* A fragment's entries go where it is placed, each remembered by its path there. */
  const place = (fragment: { nav: unknown[]; by: string; within: string }, out: unknown[], path: number[]) => {
    walkNav(fragment.nav, fragment.within, (node, at) => claim(node, fragment.by, at));
    fragment.nav.forEach((entry, j) => {
      out.push(entry);
      origins.nav.push({ path: [...path, out.length], by: fragment.by, n: j + 1 });
    });
  };
  const appNav = app.raw.nav;
  if (appNav === undefined) {
    if (!fragments.size) return undefined;
    const out: unknown[] = [];
    for (const fragment of fragments.values()) place(fragment, out, []);
    return out;
  }
  if (!Array.isArray(appNav)) return undefined;
  const listed = features.map((feature) => feature.id!);
  const placed = new Set<string>();
  const visiting = new Set<object>();
  const splice = (entries: unknown[], prefix: string, path: number[], depth: number): unknown[] => {
    const out: unknown[] = [];
    entries.forEach((node, i) => {
      const at = `${prefix}nav entry ${i + 1}`;
      if (isRecord(node) && Object.hasOwn(node, 'feature')) {
        allowKeys(node, ['feature'], `${at} (a feature placement)`);
        const id = node.feature;
        if (typeof id !== 'string' || !listed.includes(id)) {
          throw new Error(`${at} places features "${String(id)}", which the App does not list. It lists: ${listed.join(', ')}.`);
        }
        const fragment = fragments.get(id);
        if (!fragment)
          throw new Error(`${at} places features "${id}", which has no nav fragment to place; name its views in the App's nav instead.`);
        if (placed.has(id)) throw new Error(`${at} places features "${id}" a second time; a fragment is placed once.`);
        placed.add(id);
        place(fragment, out, path);
        return;
      }
      if (!isRecord(node) || !Array.isArray(node.children) || depth >= 8 || visiting.has(node)) {
        out.push(node);
        return;
      }
      claim(node, THE_APP, at);
      visiting.add(node);
      const children = splice(node.children, `${at} (${String(node.id)}): `, [...path, out.length + 1], depth + 1);
      visiting.delete(node);
      out.push({ ...node, children });
    });
    return out;
  };
  const nav = splice(appNav, `${where}: `, [], 0);
  for (const id of fragments.keys()) {
    if (!placed.has(id)) {
      throw new Error(
        `${where}: features "${id}" has a nav fragment that the App's nav does not place. Put { feature: '${id}' } where it belongs, or drop the feature's nav.`,
      );
    }
  }
  return nav;
}

/**
 * Every node of a nav tree with its location, as the nav parser names it;
 * `prefix` ends where "nav entry" begins. Bounded like the parser: eight
 * groups deep, and no cycles.
 */
function walkNav(
  entries: unknown[],
  prefix: string,
  visit: (node: unknown, at: string) => void,
  depth = 0,
  visiting = new Set<object>(),
): void {
  entries.forEach((node, i) => {
    const at = `${prefix}nav entry ${i + 1}`;
    visit(node, at);
    if (isRecord(node) && Array.isArray(node.children) && depth < 8 && !visiting.has(node)) {
      visiting.add(node);
      walkNav(node.children, `${at} (${String(node.id)}): `, visit, depth + 1, visiting);
      visiting.delete(node);
    }
  });
}

/** The first `{ feature }` placement in a nav tree, if any. */
function placementIn(nav: unknown, depth: number): { feature: unknown } | undefined {
  if (!Array.isArray(nav) || depth > 8) return undefined;
  for (const node of nav) {
    if (!isRecord(node)) continue;
    if (Object.hasOwn(node, 'feature')) return { feature: node.feature };
    const inner = placementIn(node.children, depth + 1);
    if (inner) return inner;
  }
  return undefined;
}

function nameList(raw: unknown, at: string, what: string): string[] {
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== 'string' || !name.trim()))
    throw new Error(`${at} must be a list of ${what}.`);
  return raw as string[];
}

function union(list: readonly unknown[], more: readonly string[]): unknown[] {
  return [...list, ...more.filter((name) => !list.includes(name))];
}

/** The first key two records disagree on, for a refusal that says where to look. */
function differingKey(a: unknown, b: unknown): string {
  if (!isRecord(a) || !isRecord(b)) return 'shape';
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].find((key) => !sameData(a[key], b[key])) ?? 'shape';
}
