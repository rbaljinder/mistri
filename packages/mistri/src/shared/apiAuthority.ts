/** Authored API facts only. Exposure facts do not claim that a
 * role can execute an operation: that requires the checked runtime catalog. */
import { apiAuthorityKey, type AppApiDef } from './appApi.js';
import type { AppDef } from './appModel.js';

/** Suitable for the existing authority reporter's fact/provenance boundary.
 * Missing API declarations add no facts, preserving existing App locks. */
export function apiAuthorityFacts(api: AppApiDef | undefined, views: AppDef['views']): readonly { fact: string; path: string }[] {
  if (!api) return Object.freeze([]);
  const facts: { fact: string; path: string }[] = [];
  const add = (fact: string, kind: string, ...names: string[]) => facts.push({ fact, path: apiAuthorityKey(kind, ...names) });
  add(`api version ${api.version}`, 'version');
  add(`api public-spec ${api.publicSpec}`, 'publicSpec');
  // Only when set: listening beyond loopback is authority the lock names, and
  // an App that never asked for it keeps the lock it had.
  if (api.network) add('api network', 'network');
  for (const role of [...api.roles].sort()) add(`api role ${role}`, 'role', role);
  for (const name of Object.keys(api.resources).sort()) {
    const resource = api.resources[name];
    for (const [kind, values] of [
      ['field', resource.fields],
      ['filter', resource.filters],
      ['sort', resource.sorts],
    ] as const) {
      for (const value of [...values].sort()) add(`api resource ${name} ${kind} ${value}`, kind, name, value);
    }
    // A generic write is authority the lock names: opting into one is reviewed like any grant.
    for (const verb of ['create', 'update', 'delete'] as const)
      if (resource[verb]) add(`api resource ${name} ${verb}`, 'write', name, verb);
  }
  for (const { view: name } of [...api.views].sort((a, b) => (a.view < b.view ? -1 : a.view > b.view ? 1 : 0))) {
    const view = views[name];
    if (!view || !('table' in view)) throw new Error(`api.views.${name}: authority facts require a resolved list view.`);
    add(`api view ${name}`, 'view', name);
    // UI show/presentation are not the API output shape. Standing questions,
    // default order and parameter choices are, even before a DB is available.
    // Tab/sort labels currently identify browser choices, so retain them until
    // the API's selector identity contract is independently finalized.
    const semantics = {
      table: view.table,
      realm: view.realm ?? 'tenant',
      query: view.query ?? '',
      sort: view.sort ?? view.order ?? '',
      tabs: (view.tabs ?? []).map((tab) => ({ label: tab.label, query: tab.query ?? '' })),
      filters: [...(view.filters ?? [])].sort(),
      totals: [...(view.totals ?? [])].sort(),
      sorts: (view.sorts ?? []).map((sort) => ({ label: sort.label, sort: sort.sort })),
    };
    // Composition credits this path to the view's author, not merely the
    // feature that elected to expose an independently authored view.
    add(`api view ${name} definition ${JSON.stringify(semantics)}`, 'viewDefinition', name);
  }
  for (const { command } of [...api.commands].sort((a, b) => (a.command.id < b.command.id ? -1 : a.command.id > b.command.id ? 1 : 0))) {
    // Its version is the contract line's (commandContracts.ts), which a bump rewrites; the exposure is the name.
    const target =
      'target' in command
        ? { target: command.target, targets: command.targets ?? 'one', realm: command.realm ?? 'tenant' }
        : { targets: 'none' };
    add(`api command ${command.id} target ${JSON.stringify(target)}`, 'command', command.id);
  }
  for (const name of [...(api.events ?? [])].sort()) add(`api event ${name}`, 'event', name);
  return Object.freeze(facts.map((fact) => Object.freeze(fact)));
}
