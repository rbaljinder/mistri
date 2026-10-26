import { createTenantExperimentConversionAuthority } from './experimentConversionAuthority.js';
import { realpathSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { isProxy } from 'node:util/types';
import { PostgresAdapter } from '@mistriwork/engine/adapters/postgres.js';
import { MAX_REPLICAS } from '@mistriwork/engine/adapters/replicas.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { readSqliteReadCatalog } from '@mistriwork/engine/adapters/scoped/sqliteScopeCatalog.js';
import {
  isTenantApp,
  declaredReferences,
  physicalBindings,
  platformSourceNames,
  tenantAppShape,
  tenantBusinessApp,
  type AppDef,
} from '../../shared/app.js';
import type { PageDef } from '@mistriwork/engine/shared/page.js';
import { checkTenancy } from '../../shared/appTenancy.js';
import { appResourceCatalog } from '../app/appResources.js';
import { defineAppTenantPolicy, loadAppTenantPolicy, type AppTenantPolicy } from '../policy/appTenantPolicy.js';
import type { Identity } from '../auth/auth.js';
import { assertAuthStoreSeparation, captureAuthStoreExclusion } from '../auth/authStoreSeparation.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { MAX_COMMAND_IDS } from '../commands/commandLimits.js';
import { capturedJobModule, type CapturedJobModule, type JobModule } from '../jobs/jobModule.js';
import { createTenantBootstrap } from './tenantBootstrap.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { createTenantDeployment } from './tenantDeployment.js';
import type { TenantEnrollmentAttestation, TenantEnrollmentDeclaration } from './tenantFeatureContract.js';
import { TENANT_ENROLLMENT_HOOKS } from './tenantFeatures.js';
import { bindTenantJobs, registerTenantJobs, tenantJobDeployment, withTenantMachineTimers } from './tenantJobs.js';
import { captureTenantOwnership, type TenantOwnershipSnapshot } from './tenantOwnership.js';
import {
  assertTenantSourcesApart,
  openPostgresPlatformReadSource,
  openSqlitePlatformReadSource,
  platformSourceDeclaration,
  readPostgresSourceLocation,
  sqliteSourceLocation,
  type TenantPlatformSource,
} from './tenantPlatformSource.js';
import { openPostgresTenantReadSource, openSqliteTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { tenantRetirement } from './tenantRetirement.js';
import { canonicalLocale } from '@mistriwork/engine/shared/appLocale.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { profileNameTemplate } from './tenantNames.js';
import { registerSuiteFlagAccess } from './suiteFlagAccess.js';
import { captureTenantPages } from './tenantMetadata.js';
import { tenantHistoryBinding } from './tenantRecordHistoryStore.js';
import { tenantNoticeBinding, tenantNoticeMembers } from './tenantInbox.js';
import type { NoticeMembers } from '../../adapters/inbox/inbox.js';
import { assertSqliteTenantStore } from './tenantStore.js';
import { assertPostgresTenantStore } from './tenantStorePostgres.js';
import { keyId, supportAuditKey, type SupportAuditKey } from './tenantSupportAuditContract.js';
import type { TenantWriteAudit } from './tenantWriteKindContract.js';
import { membershipRole } from './tenantFeatureMembershipRoles.js';
import { openPostgresTenantWriteSource, openSqliteTenantWriteSource, type TenantWriteSource } from './tenantWriteSource.js';
import { declareTenantAppLive } from './tenantLive.js';
import type { TenantAdministrationOptions } from './tenantAdministration.js';
import type { SupportPolicy } from './tenantSupportChange.js';
import type { FlagRequestRuntime } from '../flags/requestRuntime.js';

/** Where one source lives: exactly one of an existing SQLite file or a resolved postgres:// URL. */
type TenantSourceWhere = {
  readonly id: string;
  readonly connection: string;
  readonly existingPath?: string;
  readonly url?: string;
  /** The PostgreSQL source's read replicas: its lag-tolerant reads go there (tenantReadSource.ts). */
  readonly replicas?: readonly string[];
  /** The PostgreSQL source's direct URL for the jobs host's `LISTEN`, when `url` is a transaction-mode pooler's. */
  readonly listen?: string;
};
export interface TenantEnrollmentOptions<Request> {
  readonly app: AppDef;
  /** Detached configured pages from the existing App loader, captured at enrollment. */
  readonly pages?: readonly PageDef[];
  readonly policy: AppTenantPolicy;
  /** A genuine host-owned audit key. Standalone support enrollment derives one when omitted. */
  readonly supportAuditKey?: SupportAuditKey;
  /** Trusted host resolution, not a path or connection accepted from a request:
   * exactly one of an existing SQLite file or a resolved postgres:// URL, which
   * is never logged. Capture refuses both, and neither. */
  readonly source: TenantSourceWhere;
  /** Each platform-only source (`realm: 'platform'`), in the App's order, resolved
   * the same way; required exactly when the App declares one. */
  readonly platformSources?: readonly TenantSourceWhere[];
  readonly deployment: string;
  readonly roles: readonly string[];
  readonly maxLifetimeMs: number;
  /** Bind the existing authentication verifier; policies cannot supply it. */
  readonly verifySession: (request: Request) => Identity | null | Promise<Identity | null>;
  /** The sign-in store's email for an account id, or null: where a notice to a person (a tenant App's people hold
   * account ids) is kept. Absent, a notice reaches only a column holding an email (tenantInbox.ts). */
  readonly accountEmail?: (accountId: string) => Promise<string | null>;
  readonly commands?: { readonly registry: BusinessCommandRegistry };
  /** A defineJobs module (or the module loaded from one) whose jobs run the
   * registry's commands as service principals. Its stores are attested here,
   * never created; its host is openTenantJobHost's, after enrollment. */
  readonly jobs?: { readonly module: JobModule | CapturedJobModule };
  readonly now?: () => number;
}
export type TenantEnrollment<Request> = Awaited<ReturnType<typeof createTenantEnrollment<Request>>>;
type TenantEnrollmentLoadOptions<Request> = Omit<TenantEnrollmentOptions<Request>, 'policy'> & { readonly policyFile: string };
const enrollments = new WeakMap<
  object,
  {
    app: AppDef;
    pages: readonly PageDef[];
    clock: () => number;
    /** The attested ownership the deployment's sources hold, for its trusted API owner's catalog. */
    ownership: TenantOwnershipSnapshot;
    /** The command registry the deployment was built with, for the same owner. */
    registry?: BusinessCommandRegistry;
    /** Where the tenant source lives, for the assistant's store beside it (tenantAssistant.ts), and the platform
     * owner's assistant policy. Never a request's to name. */
    source: { readonly path: string } | { readonly url: string };
    /** The attested store and source the deployment's command events are recorded under, for its effects (tenantIntegrations.ts). */
    events: Readonly<{ storeId: string; sourceId: string }>;
    assistant?: AppTenantPolicy['assistant'];
  }
>();
type TenantAdministrationEnrollmentOptions = Readonly<
  Omit<TenantAdministrationOptions, 'auth' | 'now' | 'maxLifetimeMs'> & {
    now: () => number;
    maxLifetimeMs: number;
    /** Audited support's policy, for the host's support owner, not administration's. */
    support?: SupportPolicy;
    supportAuditKey?: SupportAuditKey;
  }
>;
// Keep server authority separate from the App/page capture used by data hosts.
const administrationEnrollments = new WeakMap<object, TenantAdministrationEnrollmentOptions | undefined>();
/** Only a genuine, still-active enrollment may supply the shared administration/
 * invitation owner. Omitting both policies disables it; retiring owners refuse. */
export function captureTenantAdministrationEnrollment<Request>(
  value: TenantEnrollment<Request>,
): TenantAdministrationEnrollmentOptions | undefined {
  if (!administrationEnrollments.has(value)) return denyTenant();
  return administrationEnrollments.get(value);
}
/** Private host bindings cannot acquire source authority through structural
 * substitutes or mutable copies of a previously enrolled App. */
export function captureTenantEnrollment<Request>(value: TenantEnrollment<Request>): {
  enrollment: TenantEnrollment<Request>;
  app: AppDef;
  pages: readonly PageDef[];
  clock: () => number;
  ownership: TenantOwnershipSnapshot;
  /** The command registry the deployment was built with, never a second one. */
  registry?: BusinessCommandRegistry;
  source: { readonly path: string } | { readonly url: string };
  events: Readonly<{ storeId: string; sourceId: string }>;
  assistant?: AppTenantPolicy['assistant'];
} {
  const captured = enrollments.get(value);
  if (!captured) return denyTenant();
  return { enrollment: value, ...captured };
}
const keys = [
  'app',
  'pages',
  'policy',
  'supportAuditKey',
  'source',
  'platformSources',
  'deployment',
  'roles',
  'maxLifetimeMs',
  'verifySession',
  'accountEmail',
  'commands',
  'jobs',
  'now',
];

/** Validate/capture host declarations before import, writer acquisition or any
 * other await. No resolver, verifier or command handler runs during loading. */
function capture<Request>(input: TenantEnrollmentOptions<Request>) {
  const raw = tenantOptions(input, keys);
  // Validate the opaque handle itself: copying its public id loses its authority.
  const auditKey = raw.supportAuditKey as SupportAuditKey | undefined;
  if (auditKey !== undefined) keyId(auditKey);
  // AppDef is already normalized by the existing App loader (including its
  // derived connection). Re-parsing it as a manifest would reject that field.
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !isTenantApp(app) || !tenantAppShape(app)) return denyTenant();
  const pages = captureTenantPages(app, raw.pages);
  // Pages from the App loader meet the manifest's realm rules too.
  checkTenancy(app, pages);
  const source = captureTenantData(raw.source);
  // One engine per source: an existing SQLite file or a PostgreSQL URL.
  const postgres = !!source && typeof source === 'object' && Object.hasOwn(source, 'url');
  tenantRecord(source, ['id', 'connection', ...(postgres ? ['url', 'replicas', 'listen'] : ['existingPath'])]);
  tenantIdentifier(source.id);
  tenantIdentifier(source.connection, 1024);
  if (postgres) {
    tenantIdentifier(source.url, 32768);
    if (!/^postgres(ql)?:\/\//i.test(source.url)) return denyTenant();
    if (source.listen !== undefined) {
      tenantIdentifier(source.listen, 32768);
      if (!/^postgres(ql)?:\/\//i.test(source.listen)) return denyTenant();
    }
    const replicas = source.replicas;
    if (replicas !== undefined) {
      if (!Array.isArray(replicas) || !replicas.length || replicas.length > MAX_REPLICAS || new Set(replicas).size !== replicas.length)
        return denyTenant();
      for (const replica of replicas) {
        tenantIdentifier(replica, 32768);
        if (!/^postgres(ql)?:\/\//i.test(replica)) return denyTenant();
      }
    }
  } else tenantIdentifier(source.existingPath, 32768);
  if (!tenantAppShape(app, { source: { id: source.id, connection: source.connection } })) return denyTenant();
  tenantIdentifier(raw.deployment);
  const roles = captureTenantData(raw.roles);
  if (!Array.isArray(roles) || roles.length > 256 || new Set(roles).size !== roles.length) return denyTenant();
  for (const role of roles) {
    tenantIdentifier(role);
    if (!Object.hasOwn(app.auth!.roles!, role)) return denyTenant();
  }
  const maxLifetimeMs = raw.maxLifetimeMs;
  if (typeof maxLifetimeMs !== 'number' || !Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 300000)
    return denyTenant();
  for (const field of ['verifySession', 'accountEmail', 'now']) {
    if (field !== 'verifySession' && raw[field] === undefined) continue;
    if (typeof raw[field] !== 'function' || isProxy(raw[field])) return denyTenant();
  }
  let registry: BusinessCommandRegistry | undefined;
  if (raw.commands !== undefined) {
    const commands = tenantOptions(raw.commands, ['registry']),
      value = commands.registry;
    if (!value || typeof value !== 'object' || isProxy(value)) return denyTenant();
    const names = Reflect.ownKeys(value);
    if (names.length > MAX_COMMAND_IDS)
      return denyTenant(`The registry holds ${names.length} commands; an App registers at most ${MAX_COMMAND_IDS}.`);
    if (names.some((name) => typeof name !== 'string')) return denyTenant();
    registry = defineCommands(tenantOptions(value, names as string[]) as BusinessCommandRegistry);
  }
  // Only what defineJobs captured, never a lookalike; a job runs one of the registry's commands.
  let jobs: CapturedJobModule | undefined;
  if (raw.jobs !== undefined) {
    jobs = capturedJobModule(tenantOptions(raw.jobs, ['module']).module);
    if (!registry) return denyTenant();
    // The App's machine timers run through this module, as startup and provisioning wrap it: none is dropped unrun.
    jobs = withTenantMachineTimers(jobs, app, registry);
  }
  if (!postgres && !statSync(source.existingPath as string).isFile()) return denyTenant();
  const capturedSource = postgres ? source : captureTenantData({ ...source, existingPath: realpathSync(source.existingPath as string) });
  // Each platform-only source the App declares, in its order: one engine each,
  // and a SQLite one never the App's own file, its sidecars or an alias of either.
  const outside = platformSourceNames(app);
  const given = raw.platformSources === undefined ? [] : captureTenantData(raw.platformSources);
  if (!Array.isArray(given) || given.length !== outside.length) return denyTenant();
  const platformSources = given.map((entry: unknown, index): TenantSourceWhere => {
    const remote = !!entry && typeof entry === 'object' && Object.hasOwn(entry, 'url');
    tenantRecord(entry, ['id', 'connection', remote ? 'url' : 'existingPath']);
    const name = outside[index],
      connection = app.sources![name].connection;
    if (entry.id !== name || entry.connection !== connection) return denyTenant();
    if (remote) {
      tenantIdentifier(entry.url, 32768);
      if (!/^postgres(ql)?:\/\//i.test(entry.url)) return denyTenant();
      return Object.freeze({ id: name, connection, url: entry.url });
    }
    tenantIdentifier(entry.existingPath, 32768);
    if (!statSync(entry.existingPath).isFile()) return denyTenant();
    const path = realpathSync(entry.existingPath);
    if (!postgres) assertAuthStoreSeparation(path, captureAuthStoreExclusion(capturedSource.existingPath as string));
    return Object.freeze({ id: name, connection, existingPath: path });
  });
  return {
    app,
    pages,
    source: capturedSource as TenantEnrollmentOptions<Request>['source'],
    deployment: raw.deployment,
    roles: roles as string[],
    maxLifetimeMs,
    verifySession: raw.verifySession as TenantEnrollmentOptions<Request>['verifySession'],
    accountEmail: raw.accountEmail as TenantEnrollmentOptions<Request>['accountEmail'],
    now: (raw.now ?? Date.now) as () => number,
    registry,
    jobs,
    supportAuditKey: auditKey,
    platformSources: Object.freeze(platformSources),
  };
}

/** Private restart-only acquisition. Opens an existing file without migration,
 * captures actual catalog authority, then publishes only genuine runtime methods.
 * Discovery owns a separate reader: it never borrows the deployment's pair. */
async function acquire<Request>(config: ReturnType<typeof capture<Request>>, policy: AppTenantPolicy) {
  let flagRuntime: FlagRequestRuntime | undefined;
  const drains: Array<() => Promise<void>> = [],
    closes: Array<() => Promise<void>> = [];
  try {
    const { app, pages, source, deployment, roles, maxLifetimeMs, verifySession, registry, jobs, platformSources } = config;
    if (policy.appId !== app.id) return denyTenant();
    const auditKey = policy.support === undefined ? undefined : (config.supportAuditKey ?? supportAuditKey());
    const binding = { appId: app.id, source: { id: source.id, connection: source.connection }, storeId: policy.storeId };
    // Each feature's declaration agreement, in tenantFeatures.ts's order, before
    // any source opens, on the App as its own source sees it.
    const declared: TenantEnrollmentDeclaration = Object.freeze({
      app: tenantBusinessApp(app),
      policy,
      registry,
      ...(auditKey === undefined ? {} : { supportAuditKey: auditKey }),
      platformSources: Object.freeze(platformSources.map((entry) => entry.id)),
      ...(jobs && registry
        ? { jobs: Object.freeze({ module: jobs, deployment: tenantJobDeployment(jobs, { binding, commands: registry }) }) }
        : {}),
    });
    for (const hook of TENANT_ENROLLMENT_HOOKS) hook.declare?.(declared);
    const profile = app.auth!.tenancy?.profile;
    // Each realm admits its own roles only; a membership never unions the two,
    // and never holds a service role, which only a jobs module's principal does.
    const platformRoles = roles.filter((role) => membershipRole(app, role, 'platform'));
    const tenantRoles = roles.filter((role) => membershipRole(app, role, 'tenant'));
    const now = tenantRuntimeClock(config.now);
    /* A writer that can record a support change is opened with the audit key
       and the App's redaction rule; the ownership snapshot carries schema and
       ownership only, so the rule has to travel from here. Without a support
       policy there is no key and no sink, and then a support write cannot be
       constructed at all — the startup check already refuses a support policy
       whose key is missing, so this never silently opens an unrecorded path. */
    const auditing: TenantWriteAudit | undefined =
      policy.support === undefined
        ? undefined
        : Object.freeze({
            key: auditKey ?? denyTenant(),
            redact: Object.freeze(
              Object.fromEntries(
                Object.entries(app.resources ?? {}).flatMap(([name, resource]) =>
                  resource.audit === undefined ? [] : [[name, resource.audit.redact] as const],
                ),
              ),
            ),
          });
    let reader: TenantReadSource, writer: TenantWriteSource, discovery: TenantReadSource, path: string | undefined;
    const attested: TenantEnrollmentAttestation = Object.freeze({ ...declared, binding });
    /* Who a notice to a person reaches: their account's email while a member, asked of the discovery reader,
       which opens after the writer it is bound to. */
    const accountEmail = config.accountEmail;
    const members = accountEmail
      ? tenantNoticeMembers({ appId: app.id, source: binding.source, deployment, now, reader: () => discovery, accountEmail })
      : undefined;
    if (source.url !== undefined) {
      ({ reader, writer, discovery } = await acquirePostgres(source.url, attested, pages, now, closes, auditing, members, source.replicas));
    } else {
      const existingPath = source.existingPath ?? denyTenant();
      if (!statSync(existingPath).isFile()) return denyTenant();
      path = realpathSync(existingPath);
      const db = new DatabaseSync(path, { readOnly: true, enableForeignKeyConstraints: true });
      let ownership: TenantOwnershipSnapshot;
      try {
        db.exec('BEGIN');
        const physicalSchema = readSqliteReadCatalog(db).schema;
        assertSqliteTenantStore(db, binding);
        // Each feature's journal or store, on this snapshot's handle, in tenantFeatures.ts's order.
        for (const hook of TENANT_ENROLLMENT_HOOKS) hook.sqlite?.(db, attested);
        const catalog = appResourceCatalog(physicalSchema, physicalBindings(app, source.id), declaredReferences(app, source.id));
        ownership = captureTenantOwnership({
          appId: app.id,
          source: binding.source,
          physicalSchema,
          schema: catalog.schema,
          resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
          ownership: policy.ownership,
          ...(profile === undefined ? {} : { profile }),
        });
        db.exec('COMMIT');
      } finally {
        db.close();
      }
      reader = openSqliteTenantReadSource(path, ownership, binding, now);
      closes.push(reader.close);
      declareTenantAppLive(app);
      writer = await openSqliteTenantWriteSource(
        path,
        ownership,
        binding,
        now,
        auditing,
        tenantHistoryBinding(app, pages, ownership),
        tenantNoticeBinding(app, ownership, members, tenantLocaleReader(app, reader)),
        app.branding !== undefined,
      );
      closes.push(writer.close);
      discovery = openSqliteTenantReadSource(path, ownership, binding, now);
      closes.push(discovery.close);
    }
    // The platform-only sources, each attested in its own snapshot, and none
    // of them the App's own database under another name.
    const outside: TenantPlatformSource[] = [];
    for (const entry of platformSources) {
      const declaration = platformSourceDeclaration(app, entry.id);
      const opened =
        entry.url !== undefined
          ? await openPostgresPlatformReadSource(entry.url, declaration)
          : openSqlitePlatformReadSource(entry.existingPath ?? denyTenant(), declaration);
      closes.push(opened.close);
      outside.push(opened);
    }
    if (outside.length) {
      assertTenantSourcesApart(
        path !== undefined ? sqliteSourceLocation(path) : await readPostgresSourceLocation(source.url ?? denyTenant()),
        outside.map((opened) => opened.location),
      );
    }
    /* The jobs runtime over the same genuine sources, drained before the
       deployment's own. It re-derives its own catalog, so it takes the App as
       its own source sees it, exactly as the declarations do above: a
       platform-only source's tables are deliberately absent from that catalog,
       and demanding them of it refused every App that paired one with --jobs. */
    const jobRuntime = jobs
      ? bindTenantJobs({
          app: tenantBusinessApp(app),
          reader,
          writer,
          deployment,
          registry: registry!,
          captureFlags: async (principal, lifetime) => {
            if (!flagRuntime) return undefined;
            const actor = {
              id: `service:${principal.principal}`,
              appId: principal.appId,
              kind: 'service' as const,
              roles: principal.roles,
            };
            const captured = await flagRuntime.attempt(principal, {
              ...lifetime,
              actor,
              realm: principal.place,
              tenantId: principal.place === 'tenant' ? principal.tenantId : null,
            });
            return captured.captureFlags(actor);
          },
          resultReferences: policy.resultReferences!,
          module: jobs,
          target: path === undefined ? { postgres: source.url! } : { sqlite: path },
          ...(path === undefined && source.listen ? { listen: source.listen } : {}),
          now,
        })
      : undefined;
    if (jobRuntime) drains.push(jobRuntime.retire);
    const runtime = createTenantDeployment({
      app,
      reader,
      writer,
      deployment,
      roles: tenantRoles,
      maxLifetimeMs,
      verifySession,
      now,
      resolveMembershipRows: policy.resolveMembershipRows,
      resolveRows: policy.resolveRows,
      ...(policy.resolvePlatformRows === undefined ? {} : { resolvePlatformRows: policy.resolvePlatformRows, platformRoles }),
      ...(outside.length ? { platformSources: Object.freeze(outside) } : {}),
      ...(policy.authorizeDeletedRecord === undefined ? {} : { authorizeDeletedRecord: policy.authorizeDeletedRecord }),
      ...(registry ? { commands: { registry, resultReferences: policy.resultReferences! } } : {}),
      ...(policy.intake === undefined ? {} : { intake: policy.intake }),
      ...(policy.public === undefined
        ? {}
        : { publicReads: { address: policy.public.address, resolvePublicRows: policy.resolvePublicRows! } }),
    });
    drains.push(runtime.retire);
    const bootstrap = createTenantBootstrap({
      reader: discovery,
      deployment,
      roles: tenantRoles,
      maxLifetimeMs,
      verifySession,
      now,
      ...(policy.resolvePlatformRows === undefined ? {} : { platformRoles }),
    });
    drains.push(bootstrap.retire);
    // Invalidate capture synchronously, before any runtime drain can yield or
    // fail. The existing retirement still owns every drain and source closure.
    const conversionAuthorities = new Set<ReturnType<typeof createTenantExperimentConversionAuthority>>();
    let conversionAuthorityRetired = false;
    drains.unshift(async () => {
      conversionAuthorityRetired = true;
      for (const owner of conversionAuthorities) owner.close();
      conversionAuthorities.clear();
    });
    let flagAccess: ReturnType<typeof registerSuiteFlagAccess> | undefined;
    drains.unshift(async () => {
      administrationEnrollments.delete(enrollment);
      await flagAccess?.retire();
    });
    closes.unshift(async () => {
      await flagAccess?.close();
    });
    const retire = tenantRetirement(drains, closes);
    // Preserve genuine deployment identity for the private expected-context
    // owner; a flattened method copy must never acquire its WeakSet brand.
    /* What each tenant is called, for the host's chooser and support choices:
       the profile's record name, as the App's catalog names that resource's
       records. Read by the discovery reader, which bootstrap retires. */
    const profileTemplate = profileNameTemplate(app, discovery.ownership.schema, profile);
    const names = (tenants: readonly string[]) => discovery.readTenantNames({ template: profileTemplate, tenants });
    /* Which of them are sandboxes, marked so to their members:
       read only where the App marks a resource clone, so nothing else pays. */
    const cloning = Object.values(app.resources ?? {}).some((resource) => resource.clone);
    const sandboxes = (tenants: readonly string[]) =>
      cloning ? discovery.readSandboxes(tenants) : Promise.resolve(new Set<string>() as ReadonlySet<string>);
    /* A tenant's own intake and public addresses, by the policy's columns, for
       its own lease's App payload: a link it can hand out. Read
       fresh on every load, so a rotated address shows on the next. */
    const addressColumns = {
      ...(policy.intake === undefined ? {} : { intake: policy.intake.address }),
      ...(policy.public === undefined ? {} : { public: policy.public.address }),
    };
    const addresses = (tenantId: string) =>
      Object.keys(addressColumns).length
        ? discovery.readTenantAddresses({ tenantId, columns: addressColumns })
        : Promise.resolve(Object.freeze({}));
    const enrollment = Object.freeze({
      deployment: runtime,
      discover: bootstrap.read,
      names,
      sandboxes,
      addresses,
      retire,
      experimentConversionAuthority(options: Omit<Parameters<typeof createTenantExperimentConversionAuthority>[0], 'reader'>) {
        if (conversionAuthorityRetired) return denyTenant();
        const owner = createTenantExperimentConversionAuthority({ ...options, reader: discovery });
        conversionAuthorities.add(owner);
        return owner;
      },
      attachFlagRuntime(value: FlagRequestRuntime) {
        if (flagRuntime || value.appId !== app.id) return denyTenant();
        flagRuntime = value;
      },
    });
    flagAccess = registerSuiteFlagAccess(enrollment, { reader: discovery, binding, deployment, path, now, maxLifetimeMs });
    enrollments.set(enrollment, {
      app,
      pages,
      clock: now,
      ownership: writer.ownership,
      ...(registry ? { registry } : {}),
      source: Object.freeze(path === undefined ? { url: source.url! } : { path }),
      events: Object.freeze({ storeId: binding.storeId, sourceId: binding.source.id }),
      ...(policy.assistant === undefined ? {} : { assistant: policy.assistant }),
    });
    if (jobRuntime) registerTenantJobs(enrollment, jobRuntime);
    administrationEnrollments.set(
      enrollment,
      policy.administration === undefined && policy.invitations === undefined && policy.support === undefined
        ? undefined
        : Object.freeze({
            ...(path === undefined ? { url: source.url } : { path }),
            binding: captureTenantData(binding),
            deployment,
            maxLifetimeMs,
            now,
            ...(policy.administration === undefined ? {} : { policy: policy.administration }),
            ...(policy.invitations === undefined ? {} : { invitations: policy.invitations }),
            ...(policy.support === undefined ? {} : { support: policy.support, supportAuditKey: auditKey }),
          }),
    );
    return enrollment;
  } catch (error) {
    await tenantRetirement(drains, closes)().catch(() => {});
    // The reason is kept for the trusted startup that has to say which store refused (tenantStartup.ts).
    return denyTenant(error);
  }
}

/** The PostgreSQL acquisition: the same restart-only attestation — catalog,
 * tenant store and, with commands, events or administration, their journals and
 * stores — in one read snapshot, then the three owned sources. Private invitation
 * enrollment attests preprovisioned linked storage too. Each event batch is then
 * written by the tenant writer's journal, inside the transaction that holds the
 * tenant/membership fence to COMMIT, exactly as on SQLite. */
async function acquirePostgres(
  url: string,
  attested: TenantEnrollmentAttestation,
  pages: readonly PageDef[],
  now: () => number,
  closes: Array<() => Promise<void>>,
  audit?: TenantWriteAudit,
  members?: NoticeMembers,
  replicas: readonly string[] = [],
) {
  const { app, policy, binding } = attested;
  const inspector = new PostgresAdapter(url, 'Private tenant enrollment');
  let physicalSchema: DatabaseSchema;
  try {
    physicalSchema = await inspector.readSnapshot(async (snapshot) => {
      const schema = await snapshot.describe();
      await assertPostgresTenantStore(snapshot.client, binding);
      // Each feature's journal or store in this one snapshot, in tenantFeatures.ts's order.
      for (const hook of TENANT_ENROLLMENT_HOOKS) if (hook.postgres) await hook.postgres(snapshot.client, attested);
      return schema;
    });
  } finally {
    await inspector.close();
  }
  const catalog = appResourceCatalog(physicalSchema, physicalBindings(app, binding.source.id), declaredReferences(app, binding.source.id));
  const profile = app.auth?.tenancy?.profile;
  const ownership = captureTenantOwnership({
    appId: app.id,
    source: binding.source,
    physicalSchema,
    schema: catalog.schema,
    resources: Object.fromEntries(catalog.schema.tables.map((table) => [table.id, catalog.toPhysical(table.id)])),
    ownership: policy.ownership,
    ...(profile === undefined ? {} : { profile }),
  });
  /* Only the request reader takes replicas. Discovery answers who is a
     member, for sign-in and notices: that stays where it was granted. */
  const reader = await openPostgresTenantReadSource(url, ownership, binding, now, replicas);
  closes.push(reader.close);
  declareTenantAppLive(app);
  const writer = await openPostgresTenantWriteSource(
    url,
    ownership,
    binding,
    now,
    audit,
    tenantHistoryBinding(app, pages, ownership),
    tenantNoticeBinding(app, ownership, members, tenantLocaleReader(app, reader)),
    app.branding !== undefined,
  );
  closes.push(writer.close);
  const discovery = await openPostgresTenantReadSource(url, ownership, binding, now);
  closes.push(discovery.close);
  return { reader, writer, discovery };
}

export async function createTenantEnrollment<Request>(input: TenantEnrollmentOptions<Request>) {
  try {
    const config = capture(input);
    const policy = defineAppTenantPolicy(tenantOptions(input, keys).policy as AppTenantPolicy);
    return await acquire(config, policy);
    // The caller still gets the one opaque refusal; the reason is recorded for
    // the trusted startup that has to say which store or policy refused.
  } catch (error) {
    return denyTenant(error);
  }
}

export async function loadTenantEnrollment<Request>(input: TenantEnrollmentLoadOptions<Request>) {
  try {
    const raw = tenantOptions(input, [...keys.filter((key) => key !== 'policy'), 'policyFile']);
    const { policyFile, ...options } = raw;
    const config = capture({ ...options, policy: undefined } as unknown as TenantEnrollmentOptions<Request>);
    tenantIdentifier(policyFile, 32768);
    const policy = await loadAppTenantPolicy(policyFile);
    return await acquire(config, policy);
  } catch (error) {
    return denyTenant(error);
  }
}

/* A tenant's saved language, where the App lets its tenants set one (`branding.allow: 'locale'`): read through the
   request reader's branding store, outside the write, as a notice's words are said after the row is written. */
function tenantLocaleReader(
  app: AppDef,
  reader: Pick<TenantReadSource, 'readBranding'>,
): ((tenant: string) => Promise<string | undefined>) | undefined {
  if (!app.branding?.allow.includes('locale')) return undefined;
  return async (tenant) => {
    const stored = await reader.readBranding({ app: app.id, tenant });
    if (!stored) return undefined;
    try {
      return canonicalLocale((JSON.parse(stored.value) as { locale?: unknown }).locale);
    } catch {
      return undefined;
    }
  };
}
