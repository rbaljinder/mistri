/**
 * A tenant deployment's service principals (tenantServiceModel.ts) over its genuine sources: the one place a
 * command or a read is bound as a service rather than a member. A job's attempt, a mail or webhook delivery and a
 * test host's service actor bind through it (tenantJobs.ts), and so does whatever else acts for a tenant with no
 * membership. Enrollment binds it whether or not the deployment runs jobs; binding it opens nothing — no `LISTEN`,
 * no worker — and runs nothing until a caller binds a service.
 *
 * The evidence is what the caller's admission read: the tenant's and `@platform`'s anchor versions, which the
 * writer fences to COMMIT, and the service's roles, whose grants and the tenant bound its scope.
 */
import { isProxy } from 'node:util/types';
import type { FlagRequestLifetime } from '../flags/requestRuntime.js';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { declaredReferences, physicalBindings, tenantAppShape, type AppDef } from '../../shared/app.js';
import { zoneColumn } from '../../shared/appZone.js';
import { assertScopeCatalog, captureScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { Adapter, ScopedReads } from '@mistriwork/engine/adapters/adapter.js';
import { assertStructuredReadFilter } from '@mistriwork/engine/server/resourceReadOperations.js';
import { AppAccessDenied, authorizeResources, type ResourceAccess } from '../app/appAccess.js';
import type { RuntimeResources } from '../app/appRuntimeResources.js';
import { appResourceCatalog } from '../app/appResources.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import {
  registerTenantServiceEventBinding,
  type AuthorizedBusinessCommand,
  type BusinessCommandBinding,
} from '../commands/businessCommandAccess.js';
import { scopedLookupReader } from '../commands/commandLookup.js';
import { createBusinessCommandAuthorizer } from '../commands/businessCommandAuthorization.js';
import { defineCommands, type BusinessCommandActor, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import type { JobCommandBinding } from '../jobs/jobCommands.js';
import { runTenantCommandTransaction, type TenantCommandRecords } from './tenantCommandTransaction.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions } from '@mistriwork/engine/server/evidence.js';
import type { TenantOwnershipSnapshot } from './tenantOwnership.js';
import { captureTenantReadSource, readSharedProfile, type TenantReadSource } from './tenantReadSource.js';
import { commandZone } from '../app/readerZone.js';
import { captureServiceEvidence, type TenantServiceEvidence } from './tenantServiceModel.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { brandTenantServices } from './tenantServiceBrand.js';
import { captureTenantWriteSource, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';
import { tenantCommandReadAudit, withTenantReadAudit } from './tenantReadAudit.js';
import { tenantVisibleFields } from './tenantVisibleFields.js';

const deny = (): never => {
  throw new AppAccessDenied();
};
/** Each tenant-owned table's ownership column: what the authorizer keeps a command from writing. */
export const ownerFields = (owned: TenantOwnershipSnapshot): Record<string, string> =>
  Object.fromEntries(Object.entries(owned.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])));

/** The anchor versions an admission read: what the writer fences to COMMIT. */
export type ServiceAnchors = Readonly<{ tenantVersion: string | null; platformVersion: string }>;

interface TenantServicesOptions {
  readonly captureFlags?: (
    principal: TenantServiceEvidence,
    lifetime: FlagRequestLifetime,
  ) => CommandFlags | undefined | Promise<CommandFlags | undefined>;
  readonly app: AppDef;
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  readonly registry: BusinessCommandRegistry;
  /** The deployment's clock, which its writer checks every evidence against. */
  readonly now: () => number;
}

/**
 * The service bindings over a tenant deployment's genuine sources. Bound by enrollment once its sources are
 * acquired; retired with the deployment, after which no binding acts.
 */
export function bindTenantServices(options: TenantServicesOptions) {
  const raw = tenantOptions(options, ['app', 'reader', 'writer', 'deployment', 'registry', 'now', 'captureFlags']);
  if (raw.captureFlags !== undefined && (typeof raw.captureFlags !== 'function' || isProxy(raw.captureFlags))) return denyTenant();
  const captureFlags = raw.captureFlags as TenantServicesOptions['captureFlags'];
  const reader = captureTenantReadSource(raw.reader as TenantReadSource),
    writer = captureTenantWriteSource(raw.writer as TenantWriteSource);
  const identity = assertTenantSourcePair(reader, writer),
    ownership = writer.ownership;
  const app = captureTenantData(raw.app as AppDef);
  if (!app || !tenantAppShape(app, ownership)) return denyTenant();
  const catalog = appResourceCatalog(
    ownership.physicalSchema,
    physicalBindings(app, ownership.source.id),
    declaredReferences(app, ownership.source.id),
  );
  assertScopeCatalog(ownership.schema, catalog.schema);
  const deploymentId = raw.deployment as string;
  tenantIdentifier(deploymentId);
  if (typeof raw.now !== 'function' || isProxy(raw.now)) return denyTenant();
  const now = raw.now as () => number;
  if (!raw.registry || typeof raw.registry !== 'object' || isProxy(raw.registry)) return denyTenant();
  const registry = defineCommands(
    tenantOptions(raw.registry, Object.keys(Object.getOwnPropertyDescriptors(raw.registry))) as BusinessCommandRegistry,
  );
  const validation = compileAppDefinitionValidation(ownership.schema, app);

  /* One authorizer per command set: the App's own, or a jobs runtime's with its flows runners' commands beside
     them (workflows/flowCommand.ts). Built when first asked for, so a caller's own refusals come first. */
  const authorizers = new WeakMap<BusinessCommandRegistry, ReturnType<typeof createBusinessCommandAuthorizer>>();
  const authorizerFor = (commands: BusinessCommandRegistry) => {
    let authorizer = authorizers.get(commands);
    if (!authorizer) {
      authorizer = createBusinessCommandAuthorizer({
        app,
        registry: commands,
        schema: ownership.schema,
        connectionFor: (resource) => (Object.hasOwn(ownership.resources, resource) ? identity.source.connection : deny()),
        writableConnection: (connection) => connection === identity.source.connection,
        transactionalConnection: (connection) => connection === identity.source.connection,
        managedOwnership: ownerFields(ownership),
      });
      authorizers.set(commands, authorizer);
    }
    return authorizer;
  };

  // The binding this function returns, for the event owner registration: set once it is built, before any service binds.
  let self: object | undefined;
  let retired = false;
  const pending = new Set<Promise<void>>();

  /** The zone a tenant's command counts its day in, where `ui.timezone` names a column its profile shares
   * (`tenant.<column>`): the tenant's own, as a member's command is given (tenantCommands.ts), so a job's
   * `today()` and `timezone` agree with the zone its slot was kept in (`timezone: 'tenant'`). Undefined, the App's. */
  const zoneOf = async (tenantId: string | null): Promise<string | undefined> => {
    if (tenantId === null || zoneColumn(app.ui)?.resource !== 'tenant') return undefined;
    return commandZone(app.ui, () => deny(), await readSharedProfile(reader, app, tenantId));
  };

  /** A service's binding over anchors read for one tenant (or the platform): the evidence, the
   * fenced writer transaction, and the commands `extract` admits. */
  const bindService = (options: {
    runAs: string;
    place: 'tenant' | 'platform';
    roles: readonly string[];
    grants: ResourceAccess;
    tenantId: string | null;
    /** The tenant's own zone for its command's day (zoneOf), where the App keeps one. */
    zone?: string | undefined;
    anchors: ServiceAnchors;
    /** How long the evidence holds: at most the caller's own attempt. */
    lifetimeMs: number;
    /** The command set `extract` names commands of: the App's, or a jobs runtime's with its flows commands. */
    commands: BusinessCommandRegistry;
    aborted: () => boolean;
    /** The caller's own holds, which its retirement awaits beside this binding's. */
    pending?: Set<Promise<void>>;
    extract: (id: string) => (result: unknown) => readonly CommandResultReference[];
  }): JobCommandBinding => {
    const { runAs, place, roles, grants, tenantId, anchors } = options;
    const authorizer = authorizerFor(options.commands);
    const verifiedAt = now();
    const evidence = captureServiceEvidence(
      {
        realm: 'service',
        appId: app.id,
        source: identity.source,
        deployment: deploymentId,
        principal: runAs,
        place,
        tenantId,
        tenantVersion: anchors.tenantVersion,
        platformVersion: anchors.platformVersion,
        roles: [...roles],
        verifiedAt,
        validUntil: verifiedAt + options.lifetimeMs,
      },
      ownership,
    );
    let lastTime = verifiedAt,
      live = true;
    const active = () => {
      if (!live || retired || options.aborted()) return denyTenant();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= evidence.validUntil) return denyTenant();
      lastTime = instant;
    };
    const scope = Object.freeze({ principal: evidence, grants, session: async () => active() });
    const actorId = `service:${runAs}`;
    const principal = (actor: BusinessCommandActor) =>
      !!actor &&
      typeof actor === 'object' &&
      !isProxy(actor) &&
      actor.id === actorId &&
      actor.kind === 'service' &&
      actor.appId === app.id &&
      Array.isArray(actor.roles) &&
      actor.roles.length === roles.length &&
      actor.roles.every((role) => roles.includes(role));
    /* What a command's lookup may read as this service: its declared sources' tables and, when it names a record, that
       record's table (the lookup reads the target before the transaction). Never wider; the read source composes the
       scope itself from the evidence, within the tenant, and fences it on the anchors as the writer does. */
    const lookupFootprint = (authorization: ReturnType<typeof authorizer.authorize>): RowScope => {
      const tables = authorization.lookupTables!;
      const allowed = new Set<string>();
      for (const [source, catalog] of Object.entries(tables.catalogs))
        for (const local of Object.keys(catalog)) allowed.add(tables.logical(source, local));
      if (authorization.command.targets !== 'none') allowed.add(authorization.resource);
      return Object.freeze(Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, allowed.has(table)])));
    };
    const binding = Object.freeze<BusinessCommandBinding>({
      scoped: true,
      // A command at times names no record (`targets: 'none'`): its envelope's key is empty, as on a single App.
      creates: (id: string): boolean => authorizer.creates(id),
      authorize: (id, actor) => {
        if (!principal(actor)) return deny();
        const extract = options.extract(id);
        const authorization = authorizer.authorize(id, actor);
        // The footprint as a scope of trues: the writer composes the service's scope over it.
        const footprint = Object.freeze(
          Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, authorization.read.includes(table)])),
        );
        const contexts = new WeakMap<WriteTransaction, TenantCommandRecords>();
        return Object.freeze<AuthorizedBusinessCommand>({
          ...authorization,
          ...(options.zone === undefined ? {} : { timezone: options.zone, ownZone: options.zone }),
          transaction: deny,
          /* No plain transaction: a decision's reads (its record, its choices) run in this command's own fenced
             transaction, scoped to the tenant's rows, and write nothing (decideReads.ts). Without it every tenant
             decision failed at its first read, as `deny` above, and no customer was ever asked about. */
          readsInCommand: true,
          // Before the transaction, as a member's lookup is; the anchor fence inside it still holds.
          ...(place === 'tenant' && authorization.lookupTables
            ? { lookup: scopedLookupReader(authorization, () => reader.bindServiceReads(evidence, lookupFootprint(authorization))) }
            : {}),
          ...(place === 'tenant'
            ? { receiptOwner: captureTenantData({ storeId: identity.storeId, sourceId: identity.source.id, tenantId: tenantId! }) }
            : {}),
          ...tenantCommandReadAudit(
            authorization,
            { app: app.id, tenant: place === 'tenant' ? tenantId! : '', actor: actorId },
            identity.source.connection,
            (row) => writer.appendReadAudit(row),
          ),
          assertTarget: (records: WriteTransaction, target: Readonly<Record<string, string | number>>) =>
            contexts.get(records)?.target(target) ?? deny(),
          assertResult: (records: WriteTransaction, target: Readonly<Record<string, string | number>>, result: unknown) =>
            contexts.get(records)?.result(target, result) ?? deny(),
          commandTransaction: async (run) => {
            let workFailure: { error: unknown } | undefined;
            try {
              return await writer.serviceCommandTransaction(
                evidence,
                footprint,
                (records, journal) =>
                  runTenantCommandTransaction(ownership, scope, authorization, records, journal, extract, async (tx) => {
                    contexts.set(tx.records, tx);
                    try {
                      return await run(tx.records, tx.journal!);
                    } catch (error) {
                      workFailure = { error };
                      throw error;
                    } finally {
                      contexts.delete(tx.records);
                    }
                  }),
                active,
              );
            } catch (error) {
              // The source's confirmed or unknown outcome, around the handler's own refusal.
              throw new CommandTransactionFailure(
                workFailure?.error ?? error,
                error instanceof TenantWriteFailure ? error.outcome : 'unknown',
              );
            }
          },
        });
      },
    });
    // The deployment's own service binding records events in the tenant's store, as a member's does (a tenant's place only).
    if (place === 'tenant') registerTenantServiceEventBinding(self!, evidence, binding);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    options.pending?.add(held);
    const lifetime: FlagRequestLifetime = {
      generation: Object.freeze({}),
      assertCurrent: active,
      async current() {
        active();
        const fresh = await reader.readServiceAnchors(tenantId);
        active();
        if (
          fresh.platformVersion !== evidence.platformVersion ||
          (evidence.place === 'tenant' && fresh.tenantVersion !== evidence.tenantVersion)
        )
          return denyTenant();
      },
    };
    const flags = commandFlagsOnce(async () => {
      active();
      const reader = await captureFlags?.(evidence, lifetime);
      active();
      return reader;
    });
    return Object.freeze({
      binding,
      captureFlags: flags,
      release: () => {
        live = false;
        pending.delete(held);
        options.pending?.delete(held);
        finish();
      },
    });
  };

  /** A service's reads in one tenant (a tenant service token's App API reads, tenantApiReadOwner.ts): its grants
   * seen as a tenant reads them, every row of the tenant in each granted table, fenced on the anchors its admission
   * read and written to the read audit as `service:<runAs>`. The App's row policies take a member's evidence and do
   * not narrow it (composeServiceScope): its grants and the tenant bound it. */
  const bindServiceReads = (options: {
    runAs: string;
    roles: readonly string[];
    grants: ResourceAccess;
    tenantId: string;
    anchors: ServiceAnchors;
    lifetimeMs: number;
    aborted: () => boolean;
  }): Readonly<{ schema: DatabaseSchema; data: ScopedReads; release: () => void }> => {
    const { runAs, roles, grants, tenantId, anchors } = options;
    const verifiedAt = now();
    const evidence = captureServiceEvidence(
      {
        realm: 'service',
        appId: app.id,
        source: identity.source,
        deployment: deploymentId,
        principal: runAs,
        place: 'tenant',
        tenantId,
        tenantVersion: anchors.tenantVersion,
        platformVersion: anchors.platformVersion,
        roles: [...roles],
        verifiedAt,
        validUntil: verifiedAt + options.lifetimeMs,
      },
      ownership,
    );
    let lastTime = verifiedAt,
      live = true;
    const active = () => {
      if (!live || retired || options.aborted()) return denyTenant();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= evidence.validUntil) return denyTenant();
      lastTime = instant;
    };
    const visible = tenantVisibleFields(ownership, { ...grants, writable: new Set(), creatable: new Set() });
    // The footprint as a scope of trues, as a command's is: the source composes the tenant's rows over it itself.
    const rows: RowScope = Object.freeze(
      Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, visible.readable.has(table)])),
    );
    const adapter: Adapter = Object.freeze({
      dialect: 'sqlite',
      introspect: async () => ownership.schema,
      close: async () => {},
      query: denyTenant,
      count: denyTenant,
      scopeReads: (scope: RowScope) => reader.bindServiceReads(evidence, scope),
    });
    const connection = identity.source.connection;
    const resource = (id: string) => (Object.hasOwn(ownership.resources, id) ? id : denyTenant());
    const resources: RuntimeResources = {
      adapter,
      schema: ownership.schema,
      connections: [connection],
      toPhysical: (id) => ownership.resources[resource(id)],
      toLogical: catalog.toLogical,
      connectionFor: (id) => {
        resource(id);
        return connection;
      },
      toLogicalAt: (id, owner) => (owner === connection ? catalog.toLogical(id) : denyTenant()),
      forConnection: (owner) => (owner === connection ? adapter : denyTenant()),
    };
    const guarded = authorizeResources(
      resources,
      withTenantReadAudit({ ...visible, rows }, { app: app.id, tenant: tenantId, actor: `service:${runAs}` }, (row) =>
        writer.appendReadAudit(row),
      ),
      active,
    ).adapter;
    // Compiler diagnostics carry private predicates and physical names.
    const plain = <T extends { sql: unknown }>(result: T): T => ({ ...result, sql: { text: '', params: [] } });
    const data = Object.freeze<ScopedReads>({
      query: async (input) => {
        assertStructuredReadFilter(input.filter, 'column');
        return plain(await guarded.query(input));
      },
      count: (table, filter, limit) => {
        assertStructuredReadFilter(filter, 'column');
        return guarded.count(table, filter, limit);
      },
      runView: async (view, offset) => {
        assertStructuredReadFilter(view.filter, 'path');
        return plain(await guarded.runView!(view, offset));
      },
      countView: (view, limit) => {
        assertStructuredReadFilter(view.filter, 'path');
        return guarded.countView!(view, limit);
      },
      runBreakdown: denyTenant,
      countBreakdown: denyTenant,
    });
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    return Object.freeze({
      schema: captureScopeCatalog(ownership.schema),
      data,
      release: () => {
        live = false;
        pending.delete(held);
        finish();
      },
    });
  };

  const services = Object.freeze({
    app,
    reader,
    writer,
    identity,
    ownership,
    /** The App's commands, as `defineCommands` pinned them. */
    registry,
    now,
    validation,
    authorizerFor,
    zoneOf,
    bindService,
    bindServiceReads,
    /** No binding acts after this; it settles once every binding held is released. */
    retire(): Promise<void> {
      retired = true;
      return Promise.allSettled([...pending]).then(() => {});
    },
  });
  brandTenantServices(services);
  self = services;
  return services;
}
export type TenantServices = ReturnType<typeof bindTenantServices>;
