/**
 * The authoring check for a tenant App: every problem `mistri check` and
 * startup can name, judged realm by realm.
 *
 * A tenant App is authored against the catalog its readers get, not the
 * database's: the ownership column is managed privately, so a form or a view
 * must not name it, and a table is a resource only where its realm can read
 * one. With the platform realm there are two such catalogs — the tenant's,
 * which holds neither the platform's tables nor the ownership column, and the
 * platform's, which holds every table and the ownership column it reads across
 * tenants — so a correct two-realm App cannot be judged against either alone.
 * Each declaration is checked in the realm it names (`appForRealm`), and the
 * tenant realm's half is checked exactly as a single-realm App's always was:
 * a tenant view, page, form or nav entry that names a platform-owned table
 * still finds no such table, and is refused in the same words.
 *
 * This decides which catalog a *declaration* is validated against. It grants
 * nothing: what a context may read is the row scope's and the runtime's, which
 * hold every platform table false for a tenant before either policy resolver
 * runs.
 */
import type { AppRealm } from '../../shared/appModel.js';
import { appForRealm } from '../../shared/appTenancy.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appProblems, type LoadedApp } from '../app/apps.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { withPlatformSources } from './tenantPlatformSource.js';
import { tenantAuthoringSchema } from './tenantVisibleFields.js';

/** One authoring problem, and the realm whose catalog found it: an author with
 * two surfaces needs to know which one a line belongs to. */
export interface TenantAuthoringProblem {
  readonly realm: AppRealm;
  readonly problem: string;
}

export function tenantAuthoringProblems(
  loaded: LoadedApp,
  owned: TenantOwnershipSnapshot,
  options: {
    /** Each platform-only source's declared catalog: the platform realm's reads alone see them. */
    readonly platformSources?: readonly DatabaseSchema[];
    /** Judge one realm only — an API token's catalog is a tenant's, never the platform's. */
    readonly only?: AppRealm;
  } = {},
): TenantAuthoringProblem[] {
  const { platformSources = [], only } = options;
  const realms: readonly AppRealm[] = only
    ? [only]
    : loaded.app.auth?.tenancy?.platform !== undefined
      ? ['tenant', 'platform']
      : ['tenant'];
  const problems: TenantAuthoringProblem[] = [];
  const said = new Set<string>();
  for (const realm of realms) {
    const projected = appForRealm(loaded.app, loaded.pages, realm);
    // Only the platform realm's reads see a platform-only source's tables.
    const schema =
      realm === 'platform' ? withPlatformSources(tenantAuthoringSchema(owned, 'platform'), platformSources) : tenantAuthoringSchema(owned);
    // This judges authored declarations. Field projection is only for a
    // served catalog: it deliberately turns an unavailable name into the
    // opaque false sentinel, which would hide an author's misspelling here.
    for (const problem of appProblems({ ...loaded, app: projected.app, pages: [...projected.pages] }, schema)) {
      // One declaration judged in both realms says its line once, in the first
      // realm that found it: the author has one thing to fix, not two.
      if (said.has(problem)) continue;
      said.add(problem);
      problems.push({ realm, problem });
    }
  }
  return problems;
}

/** The lines a trusted diagnostic prints — `mistri check` and the startup log —
 * each naming the realm whose catalog judged it. Never an HTTP response: the
 * tenant transport's refusals stay the one sanitized sentence. */
export function sayTenantAuthoringProblems(problems: readonly TenantAuthoringProblem[]): string[] {
  return problems.map(({ realm, problem }) => `${realm} realm: ${problem}`);
}
