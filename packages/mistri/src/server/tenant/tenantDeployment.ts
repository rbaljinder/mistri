import { bindTenantCommands, type TenantCommandExecutionOptions, type TenantCommandOptions } from './tenantCommands.js';
import { captureHttpCommandFlags, captureHttpTenantFlags } from '../flags/httpRuntime.js';
import { captureTenantData, denyTenant, TenantContextError, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import { bindTenantReadRuntime, type TenantReadRuntimeOptions } from './tenantReadRuntime.js';
import { captureTenantReadSource, type TenantReadSource } from './tenantReadSource.js';
import { bindTenantRecordHistory } from './tenantRecordHistory.js';
import type { RecordActivityQuery, RecordHistoryQuery } from '../../adapters/history/recordHistory.js';
import type { InboxMark, InboxQuery } from '../../adapters/inbox/inbox.js';
import type { BrandingLogoQuery, BrandingQuery, BrandingWrite } from '../../adapters/branding/branding.js';
import { bindTenantRequestRuntime } from './tenantRequestRuntime.js';
import { tenantRetirement } from './tenantRetirement.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import type { TenantWriteRuntimeOptions } from './tenantWriteRuntime.js';
import { captureTenantWriteSource, type TenantWriteSource } from './tenantWriteSource.js';
import { tenantWriteFailed } from './tenantWriteKindContract.js';
import type { TenantDeletedRecordPolicy } from './tenantInverseImages.js';
import { appCommandGrants, platformSourceNames, tenantBusinessApp, type AppDef } from '../../shared/app.js';
import { servedCommandIds } from '../../shared/appCommandIds.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import {
  grantedFormCommands,
  validateBusinessCommandReferences,
  visibleBusinessCommandActions,
} from '../commands/businessCommandLoader.js';
import { projectPlatformCapabilities, projectTenantCapabilities } from './tenantCapabilities.js';
import type { PlatformMembershipEvidence } from './tenantPlatform.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { TenantInvocationGuard } from './tenantInvocation.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import {
  bindPlatformReadRuntime,
  type PlatformInvocationGuard,
  type PlatformReadContext,
  type PlatformReadRuntimeOptions,
} from './tenantPlatformReadRuntime.js';
import { captureTenantPlatformSources, type TenantPlatformSource } from './tenantPlatformSource.js';
import {
  bindSupportReadRuntime,
  type SupportInvocationGuard,
  type SupportReadContext,
  type SupportReadRuntimeOptions,
} from './tenantSupportReadRuntime.js';
import type { SupportMembershipEvidence } from './tenantSupportLease.js';
import { isProxy } from 'node:util/types';
import { bindPlatformCommands, bindPlatformRequestRuntime } from './tenantPlatformCommands.js';
import { bindPlatformWriteRuntime } from './tenantPlatformWriteRuntime.js';
import { platformHeldColumns } from './tenantVisibleFields.js';
import { bindTenantIntake, type TenantIntake, type TenantIntakeResume, type TenantIntakeSubmission } from './tenantIntake.js';
import { tenantPublicForms } from './tenantIntakeModel.js';
import { createAdmissionCache } from './tenantAdmissionCache.js';
import {
  bindPublicReadRuntime,
  type PublicPlacement,
  type PublicReadContext,
  type PublicReadRuntimeOptions,
} from './tenantPublicReadRuntime.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';

export interface TenantDeploymentOptions<Request> extends Omit<TenantCommandOptions<Request>, 'commands'> {
  readonly commands?: TenantCommandOptions<Request>['commands'];
  /** The platform realm (`auth.tenancy.platform`): its row policy and its roles,
      both or neither. `roles` above are then the tenant realm's only. */
  readonly resolvePlatformRows?: PlatformReadRuntimeOptions<Request>['resolvePlatformRows'];
  readonly platformRoles?: readonly string[];
  /** The App's platform-only sources, in its order: exactly those it declares,
      read by the platform realm's reads alone. Retirement closes them. */
  readonly platformSources?: readonly TenantPlatformSource[];
  /** Public intake (the policy's `intake`): required exactly when the App has a public form. */
  readonly intake?: { readonly address: string };
  /** Public reads (the policy's `public` and `resolvePublicRows`): required exactly when the App says `auth.public`. */
  readonly publicReads?: {
    readonly address: string;
    readonly resolvePublicRows: PublicReadRuntimeOptions['resolvePublicRows'];
  };
}
const deployments = new WeakSet<object>();
type PlatformWrites<Request> = ReturnType<typeof bindPlatformWriteRuntime<Request>>;
const refusedPlatformWrite = (): Promise<never> => Promise.reject(new TenantContextError());
export type TenantDeployment<Request> = ReturnType<typeof createTenantDeployment<Request>>;
export function captureTenantDeployment<Request>(deployment: TenantDeployment<Request>): TenantDeployment<Request> {
  if (!deployments.has(deployment)) return denyTenant();
  return deployment;
}

/** Internal fixed narrowing lease. Extra caller arguments cannot replace the
 * captured guard; neither sibling retirement nor sources are in this facade. */
export function bindTenantDeploymentContext<Request>(input: TenantDeployment<Request>, guard: TenantInvocationGuard) {
  const deployment = captureTenantDeployment(input);
  if (typeof guard !== 'function' || isProxy(guard)) return denyTenant();
  return Object.freeze({
    withContext<T>(request: Request, selectors: readonly string[], run: (context: TenantReadContext) => T | Promise<T>) {
      return deployment.withContext(request, selectors, run, guard);
    },
    update: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.update>[2]) =>
      deployment.update(request, selectors, value, guard),
    insert: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.insert>[2]) =>
      deployment.insert(request, selectors, value, guard),
    importRows: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.importRows>[2]) =>
      deployment.importRows(request, selectors, value, guard),
    remove: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.remove>[2]) =>
      deployment.remove(request, selectors, value, guard),
    previewRemove: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.previewRemove>[2]) =>
      deployment.previewRemove(request, selectors, value, guard),
    preview: (request: Request, selectors: readonly string[], value?: Parameters<typeof deployment.preview>[2]) =>
      deployment.preview(request, selectors, value, guard),
    undo: (request: Request, selectors: readonly string[], value: Parameters<typeof deployment.undo>[2]) =>
      deployment.undo(request, selectors, value, guard),
    prepare: (request: Request, selectors: readonly string[], value: unknown, options?: Parameters<typeof deployment.prepare>[3]) =>
      deployment.prepare(request, selectors, value, options, guard),
    availability: (request: Request, selectors: readonly string[], value: unknown, options?: Parameters<typeof deployment.prepare>[3]) =>
      deployment.availability(request, selectors, value, options, guard),
    execute: (request: Request, selectors: readonly string[], value: unknown, options?: Parameters<typeof deployment.execute>[3]) =>
      deployment.execute(request, selectors, value, options, guard),
    status: (request: Request, selectors: readonly string[], value: unknown, options?: Parameters<typeof deployment.status>[3]) =>
      deployment.status(request, selectors, value, options, guard),
  });
}

/** The platform realm's fixed narrowing lease: its reads, its commands, and
 * generic Save, New and Delete on the platform's own rows. It has
 * no import, Undo or upload: a tenant's rows change through commands. */
export function bindPlatformDeploymentContext<Request>(input: TenantDeployment<Request>, guard: PlatformInvocationGuard) {
  const deployment = captureTenantDeployment(input);
  if (typeof guard !== 'function' || isProxy(guard)) return denyTenant();
  return Object.freeze({
    withContext<T>(request: Request, run: (context: PlatformReadContext) => T | Promise<T>) {
      return deployment.withPlatformContext(request, run, guard);
    },
    prepare: (request: Request, value: unknown, options?: TenantCommandExecutionOptions) =>
      deployment.preparePlatform(request, value, options, guard),
    availability: (request: Request, value: unknown, options?: TenantCommandExecutionOptions) =>
      deployment.availabilityPlatform(request, value, options, guard),
    execute: (request: Request, value: unknown, options?: TenantCommandExecutionOptions) =>
      deployment.executePlatform(request, value, options, guard),
    status: (request: Request, value: unknown, options?: TenantCommandExecutionOptions) =>
      deployment.statusPlatform(request, value, options, guard),
    update: (request: Request, value: Parameters<typeof deployment.updatePlatform>[1]) => deployment.updatePlatform(request, value, guard),
    insert: (request: Request, value: Parameters<typeof deployment.insertPlatform>[1]) => deployment.insertPlatform(request, value, guard),
    remove: (request: Request, value: Parameters<typeof deployment.removePlatform>[1]) => deployment.removePlatform(request, value, guard),
    previewRemove: (request: Request, value: Parameters<typeof deployment.previewRemovePlatform>[1]) =>
      deployment.previewRemovePlatform(request, value, guard),
  });
}

/** Private one-App/source deployment. Capture and validate every binding before
 * transferring ownership; failed construction leaves the caller's sources open.
 * Discovery, enrollment, HTTP/context handles and browser switching are separate. */
export function createTenantDeployment<Request>(options: TenantDeploymentOptions<Request>) {
  try {
    const raw = tenantOptions(options, [
      'app',
      'reader',
      'writer',
      'deployment',
      'roles',
      'maxLifetimeMs',
      'verifySession',
      'resolveMembershipRows',
      'resolveRows',
      'authorizeDeletedRecord',
      'now',
      'commands',
      'resolvePlatformRows',
      'platformRoles',
      'platformSources',
      'intake',
      'publicReads',
    ]);
    if (raw.now !== undefined && typeof raw.now !== 'function') throw new Error();
    if ((raw.resolvePlatformRows === undefined) !== (raw.platformRoles === undefined)) throw new Error();
    const reader = captureTenantReadSource(raw.reader as TenantReadSource),
      writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
    const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
    // The whole App reaches the platform realm's reads alone; every other owner
    // is built on it without its platform-only sources, so they are not there.
    const app = captureTenantData(raw.app as AppDef);
    const outside = captureTenantPlatformSources(raw.platformSources, app);
    if (outside.length && raw.resolvePlatformRows === undefined) throw new Error();
    /* One login's admission evidence, kept between its requests and shared by
       this deployment's four owners (tenantAdmissionCache.ts). This
       deployment's alone: a restart onto another database starts empty. */
    const admissions = createAdmissionCache(assertTenantSourcePair(reader, writer), raw.deployment as string);
    const shared: Record<string, unknown> = {
      ...raw,
      app: tenantBusinessApp(app),
      now,
      admissions,
    };
    delete shared.commands;
    // The platform realm's and public intake's options belong to their own
    // owners, below; the tenant owners take exact option sets and refuse anything else.
    delete shared.resolvePlatformRows;
    delete shared.platformRoles;
    delete shared.platformSources;
    delete shared.intake;
    delete shared.publicReads;
    const requests = bindTenantRequestRuntime(shared as unknown as TenantWriteRuntimeOptions<Request>);
    const readOptions: Record<string, unknown> = { ...shared, source: reader };
    delete readOptions.reader;
    delete readOptions.writer;
    delete readOptions.authorizeDeletedRecord;
    let commands: ReturnType<typeof bindTenantCommands<Request>>;
    let registry: BusinessCommandRegistry | undefined;
    let resultReferences: TenantCommandOptions<Request>['commands']['resultReferences'] | undefined;
    if (raw.commands === undefined) {
      // A generic-edit/read App need not invent a command registry. Absence is
      // allowed only when neither public references nor any role grants one.
      const app = requests.app;
      if (appCommandGrants(app, Object.keys(app.auth!.roles!)).size) throw new Error();
      validateBusinessCommandReferences(app, Object.freeze(Object.create(null)), { schema: requests.ownership.schema });
      commands = Object.freeze({
        availability: async () => {
          throw new BusinessCommandExecutionError('forbidden');
        },
        prepare: async () => {
          throw new BusinessCommandExecutionError('forbidden');
        },
        execute: async () => {
          throw new BusinessCommandExecutionError('forbidden', 'unknown');
        },
        status: async () => {
          throw new BusinessCommandExecutionError('forbidden', 'unknown');
        },
      });
    } else {
      const configured = tenantOptions(raw.commands, ['registry', 'resultReferences']);
      if (!configured.registry || typeof configured.registry !== 'object' || isProxy(configured.registry)) return denyTenant();
      registry = defineCommands(
        tenantOptions(configured.registry, Object.keys(Object.getOwnPropertyDescriptors(configured.registry))) as BusinessCommandRegistry,
      );
      resultReferences = configured.resultReferences as TenantCommandOptions<Request>['commands']['resultReferences'];
      commands = bindTenantCommands(requests, {
        registry,
        resultReferences,
        captureFlags: captureHttpTenantFlags,
      });
    }
    const history = bindTenantRecordHistory(requests, raw.authorizeDeletedRecord as TenantDeletedRecordPolicy | undefined);
    // Each realm is offered only the commands it binds: a button for the other
    // realm's command would only ever be refused, and would say it exists.
    const realmRegistry = (realm: 'tenant' | 'platform'): BusinessCommandRegistry | undefined =>
      registry &&
      Object.freeze(Object.fromEntries(Object.entries(registry).filter(([, command]) => (command.realm ?? 'tenant') === realm)));
    const tenantRegistry = realmRegistry('tenant'),
      platformRegistry = realmRegistry('platform');
    readOptions.presentation = (principal: TenantReadContext['principal'], schema: TenantReadContext['schema']) => {
      const registered = servedCommandIds(visibleBusinessCommandActions(requests.app, tenantRegistry, schema, principal.roles));
      const formCommands = grantedFormCommands(requests.app, tenantRegistry, schema, principal.roles, 'tenant');
      return projectTenantCapabilities({
        app: requests.app,
        ownership: requests.ownership,
        principal,
        services: {
          recordWrites: true,
          deletedRecordPolicy: raw.authorizeDeletedRecord !== undefined,
          commands: [...registered, ...Object.keys(formCommands)],
          formCommands,
        },
      });
    };
    const reads = bindTenantReadRuntime(readOptions as unknown as TenantReadRuntimeOptions<Request>);
    /* The profile's columns no generic platform write reaches: its identity and
       the addresses the policy reads off it (platformHeldColumns). The served
       catalog, the capabilities and the write are all judged by this one set. */
    const addressOf = (value: unknown) =>
      value && typeof value === 'object' && typeof (value as { address?: unknown }).address === 'string'
        ? ((value as { address: string }).address as string)
        : undefined;
    const held = platformHeldColumns(requests.ownership, [addressOf(raw.intake), addressOf(raw.publicReads)]);
    // The platform realm reads through the same genuine reader, under its own
    // issuer, scope and visible fields, and alone reads the platform-only
    // sources, over the whole App; an App without the realm has no such owner.
    const platform =
      raw.resolvePlatformRows === undefined
        ? undefined
        : bindPlatformReadRuntime({
            app,
            source: reader,
            admissions,
            ...(outside.length ? { platformSources: outside } : {}),
            deployment: raw.deployment as string,
            roles: raw.platformRoles as readonly string[],
            maxLifetimeMs: raw.maxLifetimeMs as number,
            verifySession: raw.verifySession as PlatformReadRuntimeOptions<Request>['verifySession'],
            resolvePlatformRows: raw.resolvePlatformRows as PlatformReadRuntimeOptions<Request>['resolvePlatformRows'],
            now,
            presentation: (principal: PlatformMembershipEvidence, schema: PlatformReadContext['schema']) =>
              projectPlatformCapabilities({
                app: requests.app,
                ownership: requests.ownership,
                principal,
                held: [...held],
                services: (() => {
                  const formCommands = grantedFormCommands(requests.app, platformRegistry, schema, principal.roles, 'platform');
                  return {
                    commands: [
                      ...servedCommandIds(visibleBusinessCommandActions(requests.app, platformRegistry, schema, principal.roles)),
                      ...Object.keys(formCommands),
                    ],
                    formCommands,
                  };
                })(),
              }),
          });
    // A support session ("enter as dealer") reads the dealer's rows through the
    // same genuine reader, under its own owner, and — deliberately — through the
    // App's same row rules a member's read uses, so a dealer's rows are governed
    // by one policy rule rather than two that could disagree. It is offered no
    // writes and no commands: what it may see is audited, and everything that
    // acts stays refused, so its capabilities say so rather than offering a
    // button that would only ever be refused.
    const support = bindSupportReadRuntime<Request>({
      app: requests.app,
      source: reader,
      deployment: raw.deployment as string,
      verifySession: raw.verifySession as SupportReadRuntimeOptions<Request>['verifySession'],
      resolveMembershipRows: raw.resolveMembershipRows as SupportReadRuntimeOptions<Request>['resolveMembershipRows'],
      resolveRows: raw.resolveRows as SupportReadRuntimeOptions<Request>['resolveRows'],
      presentation: (principal) =>
        projectTenantCapabilities({
          app: requests.app,
          ownership: requests.ownership,
          principal,
          services: {
            recordWrites: false,
            deletedRecordPolicy: false,
            commands: [],
          },
        }),
      now,
    });
    // Each realm's roles grant only that realm's commands, and a platform
    // command needs the platform realm.
    const realmOf = (id: string) => registry?.[id]?.realm ?? 'tenant';
    if (
      [...appCommandGrants(requests.app, raw.roles as readonly string[])].some((id) => realmOf(id) !== 'tenant') ||
      [...appCommandGrants(requests.app, (raw.platformRoles ?? []) as readonly string[])].some((id) => realmOf(id) !== 'platform') ||
      (!platform && Object.values(registry ?? {}).some((command) => command.realm === 'platform'))
    )
      throw new Error();
    // The platform realm's commands and its generic edits run under their own
    // request owner over the same genuine sources; without the realm they are
    // refused, and its commands are without a registry too.
    const platformRequests = platform
      ? bindPlatformRequestRuntime({
          app: requests.app,
          reader,
          writer,
          admissions,
          deployment: raw.deployment as string,
          roles: raw.platformRoles as readonly string[],
          maxLifetimeMs: raw.maxLifetimeMs as number,
          verifySession: raw.verifySession as PlatformReadRuntimeOptions<Request>['verifySession'],
          resolvePlatformRows: raw.resolvePlatformRows as PlatformReadRuntimeOptions<Request>['resolvePlatformRows'],
          platformSources: platformSourceNames(app),
          now,
        })
      : undefined;
    const platformWrites = platformRequests ? bindPlatformWriteRuntime(platformRequests, held) : undefined;
    const platformCommands: ReturnType<typeof bindPlatformCommands<Request>> =
      platformRequests && registry
        ? bindPlatformCommands(platformRequests, {
            registry: registry!,
            resultReferences: resultReferences!,
            captureFlags: captureHttpTenantFlags,
          })
        : Object.freeze({
            availability: async () => {
              throw new BusinessCommandExecutionError('forbidden');
            },
            prepare: async () => {
              throw new BusinessCommandExecutionError('forbidden');
            },
            execute: async () => {
              throw new BusinessCommandExecutionError('forbidden', 'unknown');
            },
            status: async () => {
              throw new BusinessCommandExecutionError('forbidden', 'unknown');
            },
          });
    // Public intake over the same genuine sources, for exactly the App's
    // public forms. Without it no public form runs: a tenant App declaring
    // one without intake is refused here rather than answering 503 later.
    let intake: TenantIntake | undefined;
    if (raw.intake !== undefined) {
      const declared = tenantOptions(raw.intake, ['address']);
      if (!platform || !registry || !resultReferences) throw new Error();
      intake = bindTenantIntake({
        app: requests.app,
        reader,
        writer,
        deployment: raw.deployment as string,
        captureFlags: captureHttpCommandFlags,
        maxLifetimeMs: raw.maxLifetimeMs as number,
        column: declared.address as string,
        registry,
        resultReferences,
        now,
      });
    } else if (tenantPublicForms(requests.app).size) throw new Error();
    // A visitor's reads over the same genuine reader, under their own owner:
    // exactly when the App opens resources to visitors.
    let publicReads: ReturnType<typeof bindPublicReadRuntime> | undefined;
    if (raw.publicReads !== undefined) {
      const declared = tenantOptions(raw.publicReads, ['address', 'resolvePublicRows']);
      if (!requests.app.auth?.public) throw new Error();
      publicReads = bindPublicReadRuntime({
        app: requests.app,
        source: reader,
        deployment: raw.deployment as string,
        column: declared.address as string,
        resolvePublicRows: declared.resolvePublicRows as PublicReadRuntimeOptions['resolvePublicRows'],
        maxLifetimeMs: raw.maxLifetimeMs as number,
        now,
      });
    } else if (requests.app.auth?.public) throw new Error();
    const retire = tenantRetirement(
      [
        reads.retire,
        ...(publicReads ? [publicReads.retire] : []),
        history.retire,
        requests.retire,
        support.retire,
        ...(platform ? [platform.retire] : []),
        ...(platformRequests ? [platformRequests.retire] : []),
        ...(intake ? [intake.retire] : []),
        async () => admissions.retire(),
      ],
      [reader.close, writer.close, ...outside.map((platformSource) => platformSource.close)],
    );
    const withPlatformContext = <T>(
      request: Request,
      run: (context: PlatformReadContext) => T | Promise<T>,
      guard?: PlatformInvocationGuard,
    ): Promise<T> => (platform ? platform.withContext(request, run, guard) : Promise.reject(new TenantContextError()));
    /** A read on an already-admitted support session. The evidence is the
     * support owner's own; this facade neither mints nor widens it. */
    const withSupportContext = <T>(
      request: Request,
      principal: SupportMembershipEvidence,
      run: (context: SupportReadContext) => T | Promise<T>,
      guard?: SupportInvocationGuard,
    ): Promise<T> => support.withContext(request, principal, run, guard);
    /** A visitor's read, placed by an address or a mapped host's tenant (tenantPublicReadRuntime.ts). */
    const withPublicContext = <T>(placement: PublicPlacement, run: (context: PublicReadContext) => T | Promise<T>): Promise<T> =>
      publicReads ? publicReads.withContext(placement, run) : Promise.reject(new TenantContextError());
    const deployment = Object.freeze({
      withContext: reads.withContext,
      withPublicContext,
      withPlatformContext,
      withSupportContext,
      update: history.update,
      insert: history.insert,
      importRows: history.importRows,
      remove: history.remove,
      previewRemove: history.previewRemove,
      preview: history.preview,
      undo: history.undo,
      ...commands,
      retire,
      preparePlatform: platformCommands.prepare,
      executePlatform: platformCommands.execute,
      statusPlatform: platformCommands.status,
      availabilityPlatform: platformCommands.availability,
      // Without the realm there is no platform lease to edit under: refused as its reads are.
      updatePlatform: (platformWrites?.update ?? refusedPlatformWrite) as PlatformWrites<Request>['update'],
      insertPlatform: (platformWrites?.insert ?? refusedPlatformWrite) as PlatformWrites<Request>['insert'],
      removePlatform: (platformWrites?.remove ?? refusedPlatformWrite) as PlatformWrites<Request>['remove'],
      previewRemovePlatform: (platformWrites?.previewRemove ?? refusedPlatformWrite) as PlatformWrites<Request>['previewRemove'],
      withPublicFlagIntake: intake?.withPublicFlags,
      // The refusals take the request their bound twins take, so the
      // deployment's declared type names both envelopes.
      submitIntake: intake
        ? intake.submit
        : async (_request: TenantIntakeSubmission): Promise<never> => {
            throw new BusinessCommandExecutionError('temporarily_unavailable');
          },
      resumeIntake: intake
        ? intake.resume
        : async (_request: TenantIntakeResume): Promise<never> => {
            throw new BusinessCommandExecutionError('temporarily_unavailable');
          },
      /* A record's stored history by its store key, for the host that has read
         the record in the reader's own context first (tenantHttp.ts). */
      recordHistory: (query: RecordHistoryQuery) => reader.readRecordHistory(query),
      /* A dashboard feed's stored rows, for the host that narrows them to the
         reader's tenant and reads each record they name in that context. */
      recordActivity: (query: RecordActivityQuery) => reader.readRecordActivity(query),
      /* One person's notices in one inbox, read and marked for the host that
         names the lease's own inbox and account (tenantHttp.ts). */
      inbox: Object.freeze({
        inboxReady: async () => true,
        readInbox: (query: InboxQuery) => reader.readInbox(query),
        markInboxRead: (mark: InboxMark) => writer.markInboxRead(mark),
        /* The outbox beside it and each inbox's email switch, for the host's
           sender (tenantNoticeMail.ts) and a person's own switch on their lease. */
        inboxMail: () => writer.inboxMail,
        /* The tenants active now: whose inbox a due row's is, for the sender. */
        tenants: () => reader.readActiveTenants(),
      }),
      /* One tenant's saved branding and its logos, read and saved for the
         host that names the tenant from the lease (adapters/branding). */
      branding: Object.freeze({
        read: (query: BrandingQuery) => reader.readBranding(query),
        logo: (query: BrandingLogoQuery) => reader.readBrandingLogo(query),
        write: (write: BrandingWrite) => writer.writeBranding(write),
      }),
      platform: platform !== undefined,
      intake: intake !== undefined,
      publicReads: publicReads !== undefined,
    });
    deployments.add(deployment);
    return deployment;
  } catch (error) {
    throw tenantWriteFailed('not_applied', error);
  }
}
