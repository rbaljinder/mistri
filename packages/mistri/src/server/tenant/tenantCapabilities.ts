import {
  appCommandGrants,
  appDeletable,
  declaredReferences,
  physicalBindings,
  resolveAppAccess,
  tenantAppShape,
  type AppDef,
} from '../../shared/app.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { ResourceAccess } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import { MAX_COMMAND_IDS } from '../commands/commandLimits.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { tenantDeleteEligible } from './tenantInverseImages.js';
import { platformDeletable, platformInsertable, tenantVisibleFields } from './tenantVisibleFields.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';
import type { AppFormCommandReference } from '../../shared/command.js';

/** Commands that name no record and that no signed-in form runs, by id, as a form's command is served. */
type FormCommands = Readonly<Record<string, AppFormCommandReference>>;

/** Host-supplied availability from the successfully bound deployment. These
 * values are presentation inputs, never request credentials or new authority. */
interface TenantCapabilityServices {
  readonly recordWrites: boolean;
  readonly deletedRecordPolicy: boolean;
  readonly commands: readonly string[];
  /** Of `commands`, those `useCommand` reaches by name: their contracts. */
  readonly formCommands?: FormCommands;
}
interface TenantResourceCapabilities {
  readonly write: readonly string[];
  readonly insertable: boolean;
  readonly deletable: boolean;
}
export interface TenantCapabilities {
  readonly resources: Readonly<Record<string, TenantResourceCapabilities>>;
  readonly writable: readonly string[];
  readonly grantedCommands: readonly string[];
  readonly formCommands?: FormCommands;
}
export interface TenantCapabilityOptions {
  readonly app: AppDef;
  readonly ownership: TenantOwnershipSnapshot;
  readonly principal: TenantMembershipEvidence;
  readonly services: TenantCapabilityServices;
}

/* Every tenant request projected its capabilities from scratch: the App's
   resource catalog rebuilt and compared, the role grants resolved again
   (G118). Both halves are pure functions of frozen inputs, so each is kept:

   - that an App and an ownership snapshot agree, by the identity of the two
     objects — each is frozen data from a capture, which nothing can change,
     and a reload builds new ones;
   - a projection, under that pair, by everything else it reads: the roles
     (in their order), the two service switches and the registered commands.
     It reads nothing about the tenant, the membership or the clock, so two
     tenants' members with the same roles get the same answer by
     construction; the principal is still checked in full on every call.

   The projections under one pair are bounded, oldest out first. */
const agreed = new WeakMap<object, WeakSet<object>>();
const projections = new WeakMap<object, WeakMap<object, Map<string, TenantCapabilities>>>();
const PROJECTIONS = 256;
/** Test-only: how many times capabilities were projected rather than reused. */
export const capabilityCounters = { projected: 0 };

/** Pure, bounded presentation from current membership roles. The invocation
 * owner verifies membership/session freshness before and after metadata work;
 * this helper neither admits a principal nor opens/modifies a data capability. */
export function projectTenantCapabilities(input: TenantCapabilityOptions): TenantCapabilities {
  try {
    const given = captureTenantData(input);
    tenantRecord(given, ['app', 'ownership', 'principal', 'services']);
    const owned = captureTenantOwnership(given.ownership),
      { app, principal, services } = given;
    tenantRecord(app);
    if (!agreed.get(app)?.has(owned)) {
      if (!tenantAppShape(app, owned)) return denyTenant();
      const catalog = appResourceCatalog(
        owned.physicalSchema,
        physicalBindings(app, owned.source.id),
        declaredReferences(app, owned.source.id),
      );
      assertScopeCatalog(owned.schema, catalog.schema);
      for (const id of Object.keys(owned.resources)) if (catalog.toPhysical(id) !== owned.resources[id]) return denyTenant();
      let pairs = agreed.get(app);
      if (!pairs) agreed.set(app, (pairs = new WeakSet()));
      pairs.add(owned);
    }
    tenantRecord(principal, [
      'appId',
      'accountId',
      'tenantId',
      'source',
      'deployment',
      'membershipId',
      'membershipVersion',
      'tenantVersion',
      'roles',
      'verifiedAt',
      'validUntil',
    ]);
    tenantRecord(principal.source, ['id', 'connection']);
    if (
      principal.appId !== owned.appId ||
      principal.source.id !== owned.source.id ||
      principal.source.connection !== owned.source.connection
    )
      return denyTenant();
    parseTenantSelector([principal.tenantId]);
    tenantIdentifier(principal.accountId, 1024);
    tenantIdentifier(principal.membershipId, 1024);
    tenantIdentifier(principal.deployment);
    for (const revision of [principal.membershipVersion, principal.tenantVersion]) {
      if (typeof revision !== 'string' || revision.length > 128 || !/^(0|[1-9][0-9]*)$/.test(revision)) return denyTenant();
    }
    if (
      !Number.isSafeInteger(principal.verifiedAt) ||
      principal.verifiedAt < 0 ||
      !Number.isSafeInteger(principal.validUntil) ||
      principal.validUntil <= principal.verifiedAt
    )
      return denyTenant();
    const names = (value: readonly string[], most = 256) => {
      if (!Array.isArray(value) || value.length > most || new Set(value).size !== value.length) return denyTenant();
      for (const name of value) tenantIdentifier(name);
      return value;
    };
    names(principal.roles);
    tenantRecord(services, ['recordWrites', 'deletedRecordPolicy', 'commands', 'formCommands']);
    if (typeof services.recordWrites !== 'boolean' || typeof services.deletedRecordPolicy !== 'boolean') return denyTenant();
    const registered = new Set(names(services.commands, MAX_COMMAND_IDS));
    let kept = projections.get(app);
    if (!kept) projections.set(app, (kept = new WeakMap()));
    let byInput = kept.get(owned);
    if (!byInput) kept.set(owned, (byInput = new Map()));
    // Validated above: string arrays and booleans, so this text says exactly what was asked.
    const key = JSON.stringify([principal.roles, services.recordWrites, services.deletedRecordPolicy, services.commands]);
    const known = byInput.get(key);
    if (known) return known;
    capabilityCounters.projected++;
    const grants = resolveAppAccess(app, owned.schema, [...principal.roles]);
    const resources: Record<string, TenantResourceCapabilities> = Object.create(null);
    const writable = new Set<string>();
    const fields = new Map<string, { read: ReadonlySet<string>; write: ReadonlySet<string> }>();
    for (const table of owned.schema.tables) {
      // A platform-owned table is no tenant resource, whatever a role grants.
      if (!grants.readable.has(table.id) || owned.ownership[table.id].kind === 'platform') continue;
      const rule = owned.ownership[table.id],
        configured = grants.fields?.get(table.id);
      const read = new Set(configured?.read ?? table.columns.map((column) => column.name));
      const write = table.columns
        .filter(
          (column) =>
            services.recordWrites &&
            grants.writable.has(table.id) &&
            rule.kind === 'tenant' &&
            !table.isView &&
            column.name !== rule.column &&
            read.has(column.name) &&
            (configured?.write.has(column.name) ?? true),
        )
        .map((column) => column.name);
      fields.set(table.id, { read, write: new Set(write) });
      if (write.length) writable.add(table.id);
      const primary = table.columns.filter((column) => column.primaryKey);
      resources[table.id] = {
        write,
        insertable:
          write.length > 0 &&
          primary.length > 0 &&
          primary.every((column) => read.has(column.name)) &&
          (grants.creatable?.has(table.id) ?? true),
        deletable: false,
      };
    }
    const access: ResourceAccess = {
      readable: grants.readable,
      writable,
      fields,
    };
    const deletes = appDeletable(app, owned.schema);
    for (const [id, resource] of Object.entries(resources)) {
      resources[id] = {
        ...resource,
        deletable: deletes.has(id) && !!tenantDeleteEligible(owned, access, id, services.deletedRecordPolicy),
      };
    }
    const grantedCommands = [...appCommandGrants(app, principal.roles)].filter((id) => registered.has(id)).sort();
    const projected = captureTenantData({
      resources,
      writable: [...writable].sort(),
      grantedCommands,
      ...formCommandsOf(services.formCommands, grantedCommands),
    });
    if (byInput.size >= PROJECTIONS) byInput.delete(byInput.keys().next().value!);
    byInput.set(key, projected);
    return projected;
  } catch {
    return denyTenant();
  }
}

interface PlatformCapabilityOptions {
  readonly app: AppDef;
  readonly ownership: TenantOwnershipSnapshot;
  readonly principal: PlatformMembershipEvidence;
  /** The platform realm's registered commands visible in its context; never a tenant's. */
  readonly services: {
    readonly commands: readonly string[];
    readonly formCommands?: FormCommands;
  };
  /** The profile's columns never generically written (platformHeldColumns). */
  readonly held?: readonly string[];
}

/** The platform realm's presentation: its commands, and the edits its roles
 * grant on the platform's own rows — the same answer its write
 * judges by (tenantPlatformWriteRuntime.ts). A tenant's rows and global ones
 * are never writable here, whatever a role says: they change through
 * commands. Tenant evidence is refused by shape, as a platform principal is
 * by projectTenantCapabilities. */
export function projectPlatformCapabilities(input: PlatformCapabilityOptions): TenantCapabilities {
  try {
    const given = captureTenantData(input);
    tenantRecord(given, ['app', 'ownership', 'principal', 'services', 'held']);
    const owned = captureTenantOwnership(given.ownership),
      { app, principal, services } = given;
    tenantRecord(app);
    if (!tenantAppShape(app, owned) || !app.auth?.tenancy?.platform) return denyTenant();
    if (given.held !== undefined && (!Array.isArray(given.held) || given.held.some((name) => typeof name !== 'string')))
      return denyTenant();
    tenantRecord(principal, [
      'realm',
      'appId',
      'accountId',
      'source',
      'deployment',
      'membershipId',
      'membershipVersion',
      'platformVersion',
      'roles',
      'verifiedAt',
      'validUntil',
    ]);
    tenantRecord(principal.source, ['id', 'connection']);
    if (
      principal.realm !== 'platform' ||
      principal.appId !== owned.appId ||
      principal.source.id !== owned.source.id ||
      principal.source.connection !== owned.source.connection
    )
      return denyTenant();
    tenantIdentifier(principal.accountId, 1024);
    tenantIdentifier(principal.membershipId, 1024);
    tenantIdentifier(principal.deployment);
    for (const revision of [principal.membershipVersion, principal.platformVersion]) {
      if (typeof revision !== 'string' || revision.length > 128 || !/^(0|[1-9][0-9]*)$/.test(revision)) return denyTenant();
    }
    if (
      !Number.isSafeInteger(principal.verifiedAt) ||
      principal.verifiedAt < 0 ||
      !Number.isSafeInteger(principal.validUntil) ||
      principal.validUntil <= principal.verifiedAt
    )
      return denyTenant();
    const names = (value: readonly string[], most = 256) => {
      if (!Array.isArray(value) || value.length > most || new Set(value).size !== value.length) return denyTenant();
      for (const name of value) tenantIdentifier(name);
      return value;
    };
    // A role outside the platform realm never grants here, even if evidence names it.
    for (const role of names(principal.roles)) if (app.auth.roles?.[role]?.realm !== 'platform') return denyTenant();
    tenantRecord(services, ['commands', 'formCommands']);
    const registered = new Set(names(services.commands, MAX_COMMAND_IDS));
    const grantedCommands = [...appCommandGrants(app, principal.roles)].filter((id) => registered.has(id)).sort();
    const access = tenantVisibleFields(
      owned,
      resolveAppAccess(app, owned.schema, [...principal.roles]),
      'platform',
      new Set(given.held ?? []),
    );
    const deletes = appDeletable(app, owned.schema);
    const resources: Record<string, TenantResourceCapabilities> = Object.create(null);
    for (const id of [...access.writable].sort()) {
      const table = owned.schema.tables.find((each) => each.id === id);
      const write = table && !table.isView ? [...(access.fields?.get(id)?.write ?? [])] : [];
      // Only what it may edit is named: a table it reads alone is read as it always was.
      if (!write.length) continue;
      resources[id] = {
        write,
        insertable: platformInsertable(owned, access, id),
        deletable: deletes.has(id) && platformDeletable(owned, access, id),
      };
    }
    return captureTenantData({
      resources,
      writable: Object.keys(resources),
      grantedCommands,
      ...formCommandsOf(services.formCommands, grantedCommands),
    });
  } catch {
    return denyTenant();
  }
}

/* The form contracts of the commands granted here: what a component's `useCommand` draws and sends. */
function formCommandsOf(given: FormCommands | undefined, granted: readonly string[]): { formCommands?: FormCommands } {
  if (given === undefined) return {};
  tenantRecord(given);
  const kept = Object.fromEntries(granted.flatMap((id) => (Object.hasOwn(given, id) ? [[id, given[id]]] : [])));
  return Object.keys(kept).length ? { formCommands: kept } : {};
}
