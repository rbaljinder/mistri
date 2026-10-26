/**
 * Platform-only sources (`sources.<name>.realm: 'platform'`) at startup and
 * enrollment. The source itself — its catalog, its reads, its separation from
 * the App's own database — is tenantPlatformSource.ts. Every other feature is
 * judged on the App without these sources (tenantBusinessApp); what is left
 * to say here is what a platform-only source needs and what never reaches it:
 * it needs the platform realm's row policy, which names its tables, and no
 * command names it, as its source or in a lookup.
 */
import { CommandLookupRefusal, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { denyTenant } from '@mistriwork/engine/server/evidence.js';
import type { TenantEnrollmentHook, TenantStartupCheck } from './tenantFeatureContract.js';
import { TenantCommandStartupError } from './tenantStartupError.js';

const WHY = "A platform-only source is read by the platform realm's own reads alone: no command looks it up, reads or writes it.";

/** The first command that reaches a platform-only source, and how, or undefined. */
function reaching(
  registry: BusinessCommandRegistry | undefined,
  names: ReadonlySet<string>,
): { id: string; source: string; lookup: boolean } | undefined {
  if (!names.size) return undefined;
  for (const [id, command] of Object.entries(registry ?? {})) {
    const looked = Object.keys(command.sources ?? {}).find((source) => names.has(source));
    if (looked) return { id, source: looked, lookup: true };
    const own = (command as { readonly source?: unknown }).source;
    if (typeof own === 'string' && names.has(own)) return { id, source: own, lookup: false };
  }
  return undefined;
}

export const platformSourcesCheck = Object.freeze<TenantStartupCheck>({
  phase: 'policy',
  run: ({ loaded, policy, platformSources }) => {
    if (platformSources.length && (!loaded.app.auth?.tenancy?.platform || policy.resolvePlatformRows === undefined)) {
      throw new TenantCommandStartupError(
        'A platform-only source needs the platform realm: auth.tenancy.platform in the App, and the tenant ' +
          'policy\'s resolvePlatformRows, which names each of its tables the platform reads by its qualified name ("source.table").',
      );
    }
  },
});

// Before the other command checks, which judge the App without these sources and would call one merely undeclared.
export const platformSourceCommandsCheck = Object.freeze<TenantStartupCheck>({
  phase: 'commands',
  run: ({ registry, platformSources }) => {
    const found = reaching(registry, new Set(platformSources.map((source) => source.name)));
    if (found?.lookup) throw new CommandLookupRefusal(`Command "${found.id}" looks up the platform-only source "${found.source}". ${WHY}`);
    if (found)
      throw new TenantCommandStartupError(`Command "${found.id}" names the platform-only source "${found.source}" as its source. ${WHY}`);
  },
});

export const platformSourcesHook = Object.freeze<TenantEnrollmentHook>({
  declare: ({ policy, registry, platformSources }) => {
    if ((platformSources.length && policy.resolvePlatformRows === undefined) || reaching(registry, new Set(platformSources))) denyTenant();
  },
});
