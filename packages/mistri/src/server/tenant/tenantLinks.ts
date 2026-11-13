/**
 * A tenant App's capability links, the runtime half (the model is tenantLinkModel.ts): the backend the shared link
 * door (links/linkDoor.ts) runs on, over the deployment's genuine sources.
 *
 * A link is found by its id on the reader, in one snapshot with its tenant's and `@platform`'s versions; nothing is
 * admitted where it is revoked, expired, minted outside a tenant, or its tenant or the platform is not active. Every
 * write it causes — a use spent, its revocation, a command it runs — is one writer transaction fenced on those
 * anchors at those versions and on the link row, still live, over its one record within its tenant. Its record is
 * read the same way on the reader. A link is the grant: no membership is read, no role is given and no row policy
 * is asked.
 *
 * A link found under a tenant's own host belongs to that tenant or is the door's miss, so one tenant's link opened
 * under another's address answers as a link that does not exist.
 */
import { isProxy } from 'node:util/types';
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import type { CommandJournal, CommandLinkRow } from '../../adapters/commands/commandJournalTypes.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { LINK_ID } from '../../adapters/commands/commandLinks.js';
import { declaredReferences, physicalBindings, tenantAppShape, type AppDef } from '../../shared/app.js';
import { assertScopeCatalog } from '@mistriwork/engine/shared/scopeCatalog.js';
import type { RowScope } from '@mistriwork/engine/shared/rowScope.js';
import {
  captureTenantData,
  denyTenant,
  recordRefusalCause,
  refusalCause,
  tenantIdentifier,
  tenantOptions,
} from '@mistriwork/engine/server/evidence.js';
import { AppAccessDenied, type ResourceAccess } from '../app/appAccess.js';
import { appResourceCatalog } from '../app/appResources.js';
import { compileAppDefinitionValidation } from '../app/appValidation.js';
import type { AuthorizedBusinessCommand, BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import { createBusinessCommandAuthorizer, type BusinessCommandAuthorization } from '../commands/businessCommandAuthorization.js';
import { BusinessCommandExecutionError, executeBusinessCommand } from '../commands/businessCommandExecution.js';
import {
  defineCommands,
  getCommandEffects,
  getCommandEvents,
  type BusinessCommandActor,
  type BusinessCommandRegistry,
} from '../commands/businessCommands.js';
import { keyFilter } from '../commands/commandDb.js';
import { scopedLookupReader } from '../commands/commandLookup.js';
import { commandKeyText, parseCommandPrepareRequest } from '../commands/commandPayload.js';
import { readPreparedRecord, withPreparedAhead } from '../commands/commandPrepare.js';
import type { CommandResultReference } from '../commands/scopedBusinessCommandAccess.js';
import type { EmailTransport } from '../email/email.js';
import type { FoundLink, LinkBackend } from '../links/linkDoor.js';
import { holdsLinkRef, linkUrl, renderLinkRefs } from '../links/linkToken.js';
import { tenantCommandDomain } from './tenantCommands.js';
import { runTenantCommandTransaction, type TenantCommandRecords } from './tenantCommandTransaction.js';
import { captureLinkEvidence, type TenantLinkEvidence } from './tenantLinkModel.js';
import { captureTenantReadSource, readSharedProfile, type TenantReadSource } from './tenantReadSource.js';
import { tenantCommandReadAudit } from './tenantReadAudit.js';
import { tenantRuntimeClock } from './tenantRuntimeClock.js';
import { assertTenantSourcePair } from './tenantSourceIdentity.js';
import { captureTenantWriteSource, TenantLinkMoved, TenantWriteFailure, type TenantWriteSource } from './tenantWriteSource.js';

interface TenantLinksOptions {
  readonly app: AppDef;
  readonly reader: TenantReadSource;
  readonly writer: TenantWriteSource;
  readonly deployment: string;
  readonly maxLifetimeMs: number;
  readonly registry: BusinessCommandRegistry;
  readonly resultReferences: Readonly<Record<string, (result: unknown) => readonly CommandResultReference[]>>;
  readonly now?: () => number;
}

/** A link as one request at the door found it: its row, and the evidence everything after runs under. */
export interface TenantFoundLink extends FoundLink {
  readonly evidence: TenantLinkEvidence;
  readonly active: () => void;
  readonly scope: Readonly<{ principal: TenantLinkEvidence; grants: ResourceAccess; session: () => Promise<void> }>;
}

export type TenantLinks = ReturnType<typeof bindTenantLinks>;
const deny = (): never => {
  throw new AppAccessDenied();
};

/** The commands the App's links declare, each once. */
function linkCommands(app: AppDef): Set<string> {
  const ids = new Set<string>();
  for (const resource of Object.values(app.resources ?? {}))
    for (const link of Object.values(resource.links ?? {})) for (const id of link.commands ?? []) ids.add(id);
  return ids;
}

export function bindTenantLinks(options: TenantLinksOptions) {
  const raw = tenantOptions(options, ['app', 'reader', 'writer', 'deployment', 'maxLifetimeMs', 'registry', 'resultReferences', 'now']);
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
  const deployment = raw.deployment as string,
    maxLifetimeMs = raw.maxLifetimeMs as number;
  tenantIdentifier(deployment);
  if (!Number.isSafeInteger(maxLifetimeMs) || maxLifetimeMs < 1 || maxLifetimeMs > 300_000) return denyTenant();
  if (raw.now !== undefined && typeof raw.now !== 'function') return denyTenant();
  const now = tenantRuntimeClock((raw.now ?? Date.now) as () => number);
  if (!raw.registry || typeof raw.registry !== 'object' || isProxy(raw.registry)) return denyTenant();
  const registry = defineCommands(
    tenantOptions(raw.registry, Object.keys(Object.getOwnPropertyDescriptors(raw.registry))) as BusinessCommandRegistry,
  );
  const ownerFields = Object.fromEntries(
    Object.entries(ownership.ownership).flatMap(([id, rule]) => (rule.kind === 'tenant' ? [[id, rule.column]] : [])),
  );
  const authorizer = createBusinessCommandAuthorizer({
    app,
    registry,
    schema: ownership.schema,
    connectionFor: (resource) => (Object.hasOwn(ownership.resources, resource) ? identity.source.connection : deny()),
    writableConnection: (connection) => connection === identity.source.connection,
    transactionalConnection: (connection) => connection === identity.source.connection,
    managedOwnership: ownerFields,
  });
  const declarations = tenantOptions(raw.resultReferences, Object.keys(registry));
  const extractors = new Map<string, (result: unknown) => readonly CommandResultReference[]>();
  for (const id of linkCommands(app)) {
    const command = registry[id],
      extractor = declarations[id];
    if (!command || typeof extractor !== 'function' || isProxy(extractor)) return denyTenant();
    /* A member's event-emitting command runs beside the tenant's event runtime (tenantCommandEvents.ts), which a
       link's request has none of: refused here, said to the operator who starts the deployment, rather than
       answered as a refusal on every run of it. */
    if (getCommandEvents(command) !== undefined || getCommandEffects(command) !== undefined)
      throw new Error(`Command "${id}" is run by a link and emits events or effects, which a tenant App's link does not run.`);
    extractors.set(id, extractor as (result: unknown) => readonly CommandResultReference[]);
  }
  const validation = compileAppDefinitionValidation(ownership.schema, app);
  // No role: the link's one record bounds the footprint, as intake's place does.
  const grants: ResourceAccess = { readable: new Set(), writable: new Set(), ...(validation ? { validation } : {}) };
  const nothing = (): Record<string, boolean> => Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, false]));
  /** The link's own resource, and nothing else: what its record is read and its row is written under. */
  const ownRows = (resource: string): RowScope => Object.freeze({ ...nothing(), [resource]: true });
  /** The command's footprint as a scope of trues: the writer composes the link's one record over it. */
  const footprintOf = (authorization: BusinessCommandAuthorization): RowScope =>
    Object.freeze(Object.fromEntries(Object.keys(ownership.ownership).map((table) => [table, authorization.read.includes(table)])));

  let retired = false,
    retirement: Promise<void> | undefined;
  const pending = new Set<Promise<void>>();
  /** One backend call, held for retirement to wait on. */
  const held = async <T>(work: () => Promise<T>): Promise<T> => {
    let finish!: () => void;
    const promise = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(promise);
    try {
      if (retired) throw new BusinessCommandExecutionError('temporarily_unavailable');
      return await work();
    } finally {
      pending.delete(promise);
      finish();
    }
  };

  /** One resolution: the link's row and its anchors in one snapshot, or undefined, the door's one miss. */
  const admit = async (id: string, hostTenant: string | undefined): Promise<TenantFoundLink | undefined> => {
    if (!LINK_ID.test(id)) return undefined;
    const started = now();
    const resolved = captureTenantData(await reader.resolveLink({ id }));
    if (retired || !resolved) return undefined;
    const row = resolved.link as CommandLinkRow;
    // Under a tenant's own host only that tenant's links open; another's is a link that does not exist.
    if (hostTenant !== undefined && row.tenant !== hostTenant) return undefined;
    const evidence = captureLinkEvidence(
      {
        realm: 'link',
        appId: app.id,
        source: identity.source,
        deployment,
        linkId: row.id,
        name: row.name,
        resource: row.resource,
        rowKey: row.rowKey,
        tenantId: row.tenant,
        tenantVersion: resolved.tenantVersion,
        platformVersion: resolved.platformVersion,
        verifiedAt: started,
        validUntil: started + maxLifetimeMs,
      },
      ownership,
    );
    let lastTime = started;
    const active = () => {
      if (retired) return denyTenant();
      const instant = now();
      if (!Number.isSafeInteger(instant) || instant < lastTime || instant >= evidence.validUntil) return denyTenant();
      lastTime = instant;
    };
    const scope = Object.freeze({ principal: evidence, grants, session: async () => active() });
    return Object.freeze({ row, tenant: row.tenant, evidence, active, scope });
  };

  /** One fenced writer transaction under the link, its work's own refusal kept as the cause. */
  const inLink = async <T>(
    found: TenantFoundLink,
    footprint: RowScope,
    work: (records: WriteTransaction, journal: CommandJournal) => Promise<T>,
  ): Promise<T> => {
    let workFailure: { error: unknown } | undefined;
    try {
      return await writer.linkCommandTransaction(
        found.evidence,
        footprint,
        async (records, journal) => {
          try {
            return await work(records, journal);
          } catch (error) {
            workFailure = { error };
            throw error;
          }
        },
        found.active,
      );
    } catch (error) {
      /* The fence refused before the handler ran: the link was revoked (or its tenant suspended) while the request was in
         flight. It answers as that link's next request does at the door, a miss, not as a store that cannot answer. */
      if (error instanceof TenantLinkMoved) throw new CommandTransactionFailure(new AppAccessDenied(), 'not_applied');
      throw new CommandTransactionFailure(workFailure?.error ?? error, error instanceof TenantWriteFailure ? error.outcome : 'unknown');
    }
  };

  /** A command's refusal as the door answers one: the command's own, or the tenant realm's reading of the writer's. */
  const answered = (error: unknown): never => {
    if (error instanceof BusinessCommandExecutionError || error instanceof AppAccessDenied) throw error;
    const known = tenantCommandDomain(error);
    throw recordRefusalCause(
      new BusinessCommandExecutionError(
        known?.code ?? 'temporarily_unavailable',
        known?.outcome === 'unknown' || (error instanceof TenantWriteFailure && error.outcome === 'unknown') ? 'unknown' : 'not_applied',
        known?.field,
        known?.key,
        known?.reason,
      ),
      refusalCause(known) ?? refusalCause(error) ?? error,
    );
  };

  /** The revision, and the starting values a command declares, read in one transaction under the link. */
  const prepare = async (found: TenantFoundLink, actor: BusinessCommandActor, envelope: Record<string, unknown>) => {
    const prepared = parseCommandPrepareRequest(envelope, { creating: (id) => authorizer.creates(id) });
    const authorization = authorizer.authorize(prepared.command, actor);
    if (prepared.commandVersion !== authorization.command.version)
      throw new BusinessCommandExecutionError('command_version_mismatch', 'unknown');
    // The executor holds a run to the link's key (businessCommandExecution.ts); a prepare is held to it here.
    if (commandKeyText(prepared.key) !== found.row.rowKey) return deny();
    const extractor = extractors.get(prepared.command) ?? deny();
    const tenant = await readSharedProfile(reader, app, found.evidence.tenantId);
    found.active();
    return withPreparedAhead(authorization.command, authorization.catalog, prepared.key, () =>
      inLink(found, footprintOf(authorization), (records, journal) =>
        runTenantCommandTransaction(ownership, found.scope, authorization, records, journal, extractor, async (tx) => {
          await tx.target(prepared.key);
          return readPreparedRecord(tx.records, {
            command: authorization.command,
            commandId: prepared.command,
            actor: authorization.actor,
            key: prepared.key,
            catalog: authorization.catalog,
            ...(authorization.people ? { people: authorization.people } : {}),
            ...(authorization.insertOnly ? { insertOnly: authorization.insertOnly } : {}),
            tenant,
          });
        }),
      ),
    );
  };

  /** One run, through the executor, which reads the link again in the transaction it runs in. */
  const execute = async (found: TenantFoundLink, actor: BusinessCommandActor, envelope: Record<string, unknown>) => {
    const tenant = await readSharedProfile(reader, app, found.evidence.tenantId);
    found.active();
    const binding = Object.freeze<BusinessCommandBinding>({
      scoped: true,
      creates: (id: string): boolean => authorizer.creates(id),
      authorize: (id, supplied) => {
        if (supplied !== actor) return deny();
        const extractor = extractors.get(id) ?? deny();
        const authorization = authorizer.authorize(id, actor);
        const contexts = new WeakMap<WriteTransaction, TenantCommandRecords>();
        return Object.freeze<AuthorizedBusinessCommand>({
          ...authorization,
          tenant,
          transaction: deny,
          readsInCommand: true,
          // A lookup reads the link's one record and nothing else, as its holder does.
          ...(authorization.lookupTables
            ? { lookup: scopedLookupReader(authorization, () => reader.bindLinkReads(found.evidence, ownRows(found.row.resource))) }
            : {}),
          ...tenantCommandReadAudit(
            authorization,
            { app: app.id, tenant: found.evidence.tenantId, actor: actor.id },
            identity.source.connection,
            (row) => writer.appendReadAudit(row),
          ),
          // The receipt is the link's tenant's: the executor reads the link again there, and one of another tenant is none.
          receiptOwner: captureTenantData({ storeId: identity.storeId, sourceId: identity.source.id, tenantId: found.evidence.tenantId }),
          assertTarget: (records: WriteTransaction, key: Readonly<Record<string, string | number>>) =>
            contexts.get(records)?.target(key) ?? deny(),
          assertResult: (records: WriteTransaction, key: Readonly<Record<string, string | number>>, result: unknown) =>
            contexts.get(records)?.result(key, result) ?? deny(),
          commandTransaction: (run) =>
            inLink(found, footprintOf(authorization), (records, journal) =>
              runTenantCommandTransaction(ownership, found.scope, authorization, records, journal, extractor, async (tx) => {
                contexts.set(tx.records, tx);
                try {
                  return await run(tx.records, tx.journal!);
                } finally {
                  contexts.delete(tx.records);
                }
              }),
            ),
        });
      },
    });
    return executeBusinessCommand(binding, actor, envelope, {});
  };

  /**
   * The door's backend for one request. `hostTenant` is the tenant whose own host the request came in on, if any:
   * only its links open there. `mail` is where a step-up code is sent from.
   */
  const backend = (hostTenant?: string, mail?: () => EmailTransport | undefined): LinkBackend<TenantFoundLink> =>
    Object.freeze<LinkBackend<TenantFoundLink>>({
      commands: registry,
      lookUp: (id) => held(() => admit(id, hostTenant)),
      open: (found, at) =>
        held(() => inLink(found, Object.freeze(nothing()), async (_records, journal) => journal.openLink!(app.id, found.row.id, at))),
      async readRecord(found, key, columns) {
        return held(async () => {
          const reads = await reader.bindLinkReads(found.evidence, ownRows(found.row.resource));
          const read = await reads.query({ table: found.row.resource, columns: [...columns], filter: keyFilter(key), limit: 2, offset: 0 });
          found.active();
          return read.rows as Record<string, unknown>[];
        });
      },
      revoke: (found, at) =>
        held(() =>
          inLink(found, Object.freeze(nothing()), async (_records, journal) =>
            journal.revokeLinks!(app.id, found.row.resource, found.row.rowKey, undefined, at),
          ),
        ),
      run: (found, actor, route, envelope) =>
        held(async () => {
          try {
            return await (route === 'prepare' ? prepare(found, actor, envelope) : execute(found, actor, envelope));
          } catch (error) {
            return answered(error);
          }
        }),
      mail: () => mail?.(),
      // Nothing is leased per request: the sources are the deployment's.
      close: () => {},
    });

  /**
   * One link's URL, for the people of `tenant` (absent: the link's own tenant, as an effect delivered after commit
   * names none): undefined for another tenant's link or one no longer live. `base` says where a tenant's links are
   * served, its own mapped host or the shared address; the server knows its hosts, the binding does not.
   */
  const render = async (
    id: string,
    tenant: string | undefined,
    base: (tenant: string) => string | undefined,
  ): Promise<string | undefined> => {
    if (retired || !LINK_ID.test(id)) return undefined;
    const resolved = captureTenantData(await reader.resolveLink({ id }));
    if (!resolved) return undefined;
    const row = resolved.link as CommandLinkRow;
    if (tenant !== undefined && row.tenant !== tenant) return undefined;
    const at = base(row.tenant);
    return at === undefined ? undefined : linkUrl(app.id, row, at);
  };
  /** `value` with each link reference it holds rendered for `tenant` (a member's command answer); as it was where one does not render. */
  const rendered = async <T>(value: T, tenant: string, base: (tenant: string) => string | undefined): Promise<T> => {
    const text = JSON.stringify(value);
    if (typeof text !== 'string' || !holdsLinkRef(text)) return value;
    const out = await renderLinkRefs(text, (id) => render(id, tenant, base));
    return out === undefined || out === text ? value : (JSON.parse(out) as T);
  };

  return Object.freeze({
    backend,
    render,
    rendered,
    retire(): Promise<void> {
      if (retirement) return retirement;
      retired = true;
      retirement = Promise.allSettled([...pending]).then(() => {});
      return retirement;
    },
  });
}
