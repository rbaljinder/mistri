/** Startup-only private declaration graph. Never serialize this object into an
 * App/browser payload: request transports serve captured decisions separately. */
import { isProxy } from 'node:util/types';
import { checkedGrants } from '../../shared/appAuthGrants.js';
import { checkFlagCapabilityReferences } from '../../shared/appFlagCapabilities.js';
import { captureFlagDeclaration, normalizeExperimentDeclarations, type ExperimentDeclaration } from '../../shared/appExperiments.js';
import { normalizeAppFlagGate } from '../../shared/appFlagGates.js';
import { normalizeFlagCatalog, type FlagCatalog } from '../../shared/appFlags.js';
import { isTenantApp, type AppDef } from '../../shared/appModel.js';
import { plainRecord } from '@mistriwork/engine/shared/model.js';
import { appRealms, checkTenancy } from '../../shared/appTenancy.js';
import type { BusinessCommandRegistry } from '../commands/businessCommands.js';
import { captureCommandFlagGate, validateCommandFlagGates } from '../commands/commandFlags.js';
import {
  normalizeFlagAuthorityCatalog,
  normalizeFlagRoleCapabilities,
  type FlagAuthorityCatalog,
  type FlagRoleCapabilities,
} from './authority.js';

export interface AppFlagCatalog {
  /** Explicit declarations, including an explicitly empty catalog, differ from
   * an App that never enrolled. Deployment configuration is the host's decision. */
  readonly declared: boolean;
  readonly tenantApp: boolean;
  readonly catalog: FlagCatalog;
  readonly authorityCatalog: FlagAuthorityCatalog;
  readonly roles: Readonly<Record<string, FlagRoleCapabilities>>;
  readonly experiments: Readonly<Record<string, ExperimentDeclaration>>;
}

/** Validate and capture before opening a provider or exposing management.
 * Every role is retained; none is synthesized from an admin/native session. */
export function captureAppFlagCatalog(app: AppDef, commands?: BusinessCommandRegistry): AppFlagCatalog {
  if (isProxy(app)) throw new Error('App flag declarations require plain data.');
  plainRecord(app, 'App flags', 'an App definition');
  if (app.auth !== undefined) {
    if (isProxy(app.auth)) throw new Error('App auth declarations require plain data.');
    plainRecord(app.auth, app.name, 'auth declarations');
    if (Object.hasOwn(app.auth, 'roles')) {
      const roles = plainRecord(app.auth.roles, app.name, 'declared roles');
      for (const grant of Object.values(roles)) {
        if (grant && typeof grant === 'object' && isProxy(grant)) throw new Error('App role declarations require plain data.');
        plainRecord(grant, app.name, 'a role grant');
      }
    }
  }
  const present = (key: 'flags' | 'audiences' | 'experiments') => Object.hasOwn(app, key);
  const captured = (key: 'flags' | 'audiences' | 'experiments') => (present(key) ? captureFlagDeclaration(app[key]) : {});
  const catalog = normalizeFlagCatalog({
    flags: captured('flags'),
    roles: Object.keys(app.auth?.roles ?? {}),
    audiences: captured('audiences'),
  });
  const experiments = normalizeExperimentDeclarations(captured('experiments'), catalog);
  const definition: AppDef = { ...app, flags: catalog.flags, audiences: catalog.audiences, experiments };
  const grants = app.auth?.roles === undefined ? {} : checkedGrants(definition).roles;
  checkFlagCapabilityReferences(grants, catalog, experiments);
  // This existing owner refuses native realms, absent realms in a two-realm
  // App and tenant/platform resource crossings before any projection occurs.
  checkTenancy(definition, []);
  const tenantApp = isTenantApp(definition),
    platform = appRealms(definition).platform;
  const authorityCatalog = normalizeFlagAuthorityCatalog({
    ...catalog,
    experiments: Object.fromEntries(
      Object.entries(experiments).map(([id, epoch]) => [id, { version: epoch.version, weights: epoch.allocation }]),
    ),
  });
  const roles = normalizeFlagRoleCapabilities(
    Object.fromEntries(
      Object.entries(grants).map(([id, grant]) => [
        id,
        {
          // Without the platform realm, every tenant-App role is implicitly tenant.
          ...(tenantApp ? { realm: platform ? grant.realm : 'tenant' } : {}),
          ...(grant.flags === undefined ? {} : { flags: grant.flags }),
          ...(grant.experiments === undefined ? {} : { experiments: grant.experiments }),
        },
      ]),
    ),
    authorityCatalog,
    tenantApp,
  );
  if (commands) validateAppCommandFlagGates(commands, catalog);
  return Object.freeze({
    declared: present('flags') || present('audiences') || present('experiments'),
    tenantApp,
    catalog,
    authorityCatalog,
    roles,
    experiments,
  });
}

/** Includes commands omitted from presentation. Exact primitive equality means
 * string "1" is not number 1, and object flags never become command gates. */
export function validateAppCommandFlagGates(commands: BusinessCommandRegistry, catalog: FlagCatalog): void {
  if (isProxy(commands)) throw new Error('Command registry must be plain data.');
  plainRecord(commands, 'flags', 'a command registry');
  for (const command of Object.values(commands)) {
    if (!command || typeof command !== 'object' || isProxy(command) || ![Object.prototype, null].includes(Object.getPrototypeOf(command)))
      throw new Error('Invalid command registration.');
    const descriptor = Object.getOwnPropertyDescriptor(command, 'enabledBy');
    if (!descriptor) continue;
    if (!descriptor.enumerable || !('value' in descriptor)) throw new Error('Command enabledBy must be an own data property.');
    const gate = captureCommandFlagGate(descriptor.value);
    normalizeAppFlagGate(gate, catalog);
    if (!Object.isFrozen(descriptor.value)) throw new Error('Command enabledBy must be captured by command registration.');
  }
  validateCommandFlagGates(commands, catalog);
}
