import { BrandingRefused } from '../../shared/tenantBranding.js';
import { lagTolerantReads, primaryReads } from '@mistriwork/engine/adapters/replicas.js';
import { toleratesLag } from '@mistriwork/engine/server/http/readRouting.js';
import type { TenantBrandingService } from './tenantBranding.js';
import { refusalSaid } from '@mistriwork/engine/shared/refusal.js';
import { AppAccessDenied } from '../app/appAccessDenied.js';
import { resolveLocale } from '@mistriwork/engine/shared/appLocale.js';
import { pickedLocale } from '../app/readerLocale.js';
import { readTenantMessages } from '../app/recordMessages.js';
import { localizedApp } from '../app/apps.js';
import { componentMessages } from '../app/appMessages.js';
import type { TenantIntegrations } from './tenantIntegrations.js';
import { IntegrationSettingsRefusal } from '../integrations/integrationRuntime.js';
import { LogoRefused } from '../app/brandImage.js';
import { EXPERIMENT_EXPOSURES_PATH } from '../experiments/exposureHttp.js';
import { applyServerTimeouts } from '@mistriwork/engine/server/serverTimeouts.js';
import { platformRequests } from '@mistriwork/engine/server/http/traceRequest.js';
import { probe } from '@mistriwork/engine/server/http/probes.js';
import { observerRoute } from '../observe/mount.js';
import { createServer, validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { isPromise, isProxy } from 'node:util/types';
import {
  TransactionOutcomeUnknown,
  type Adapter,
  type InsertRequest,
  type InsertResult,
  type ScopedReads,
  type UpdateRequest,
  type UpdateResult,
} from '@mistriwork/engine/adapters/adapter.js';
import { appFileRules, isTenantApp, tenantAppShape, zonedNow, type AppDef } from '../../shared/app.js';
import { wearing, type TenantLook } from './tenantLook.js';
import { appZone } from '../../shared/appUi.js';
import { localeWeekStart } from '@mistriwork/engine/shared/weekStart.js';
import { readStoredFile, shownWrite, uploadValues } from '../http/fileRows.js';
import { fileStoreTrouble, placeFile, writePlaced, type FileScope } from '../files/fileStorage.js';
import { judgeLines } from '../http/formLinesWrite.js';
import type { LineCollection } from '@mistriwork/engine/server/recordWriteOperations.js';
import { findTable, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { sniffImage } from '../http/imageSniff.js';
import {
  FILE_READ_PATH,
  FILE_UPLOAD_PATH,
  HttpError,
  TENANT_FILE_MOST,
  TENANT_FILE_UPLOAD_BODY,
} from '@mistriwork/engine/server/http/reply.js';
import type { ResourceHttpPath } from '@mistriwork/engine/shared/resourceHttp.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextAssertion, type TenantContextReply } from '../../shared/tenantContext.js';
import type { TenantHttpResourceReply } from '../../shared/tenantHttp.js';
import type { VerifiedSessionInstance } from '../auth/auth.js';
import { businessCommandHttpError } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { doorRefusal, writes as changesSomething, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { setBaselineHeaders } from '@mistriwork/engine/server/http/baselineHeaders.js';
import { dispatchResourceReadHttp } from '@mistriwork/engine/server/resourceReadHttp.js';
import { APP_READS } from '../app/appReads.js';
import { createTenantContexts, TenantContextsBusy, tenantLeaseFailureCode } from './tenantContexts.js';
import {
  captureTenantData,
  databaseFault,
  denyTenant,
  TenantContextError,
  TenantRequestFault,
  TenantUnavailableError,
  tenantIdentifier,
  tenantOptions,
  tenantRecord,
} from '@mistriwork/engine/server/evidence.js';
import { reportRefusal } from '@mistriwork/engine/server/http/refusalReport.js';
import { databaseUnanswered, unansweredWrite } from './tenantWriteFault.js';
import { captureTenantEnrollment, type TenantEnrollment } from './tenantEnrollment.js';
import { parseTenantSelector, type TenantMembershipEvidence } from './tenantMembership.js';
import type { TenantReadContext } from './tenantReadRuntime.js';
import type { PlatformReadContext } from './tenantPlatformReadRuntime.js';
import type { SupportReadContext } from './tenantSupportReadRuntime.js';
import { tenantRetirement } from './tenantRetirement.js';
import { projectTenantMetadata, tenantSuggestedPage } from './tenantMetadata.js';
import { tenantPagePlan, tenantReferences } from './tenantPageOperations.js';
import { composeInputValid, composeTenantRecordPage } from './tenantCompose.js';
import { replyJson } from './tenantReplyJson.js';
import {
  BRANDING_SAVE_BODY,
  IMPORT_BODY,
  TENANT_COMMAND_ROUTES as commands,
  TENANT_CONTROL_ROUTES as controls,
  TENANT_METADATA_GETS as metadataGets,
  TENANT_METADATA_POSTS as metadataPosts,
  TENANT_READ_ROUTES as reads,
  TENANT_ROUTE_FIELDS as fields,
  TENANT_WRITE_ROUTES as writes,
} from './tenantHttpRoutes.js';
import { tenantServedSchema } from './tenantServedSchema.js';
import { lookupTenantPerson } from '../app/appMe.js';
import { TenantWriteFailure } from './tenantWriteSource.js';
import { SUPPORT_HTTP_OPERATIONS, SUPPORT_HTTP_ROOT } from '../../shared/tenantSupport.js';
import { SUPPORT_LOG_PATH, SUPPORT_SESSIONS_PATH, type SupportAuditReply, type SupportLogReply } from '../../shared/tenantSupportLog.js';
import { projectSupportAudit, projectSupportLog, type SupportLogFields } from './tenantSupportLogProjection.js';
import { appCommandGrants, resolveAppAccess } from '../../shared/appAccess.js';
import { dispatchTenantSupportHttp } from './tenantSupportHttp.js';
import { TenantSupportUnledgered, tenantSupportRefusal, tenantSupportRefused } from './tenantSupportLease.js';
import type { TenantSupport } from './tenantSupportOperations.js';
import { greetReader } from '../../shared/appGreeting.js';
import type { RecordActivityQuery, RecordHistoryQuery } from '../../adapters/history/recordHistory.js';
import { commandActionLabel, readRecordHistoryFor, updateActionLabel } from '../recordHistory.js';
import { readRecordFlowsFor, startRecordFlowFor } from '../recordFlows.js';
import { flowRunsOf } from '../workflows/flowRuns.js';
import { readRecordActivityFor } from '../recordActivity.js';
import { appForRoles } from '../../shared/appViewRoles.js';
import { appSurfaceForRealm } from '../../shared/appTenancy.js';
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';
import { pageLoad } from '../http/pageLoad.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import { attributeAction, attributeWrites } from '@mistriwork/engine/adapters/writeAttribution.js';
import { tenantHistoryStoreKey } from './tenantRecordHistoryStore.js';
import { decisionsServedBy, servedDecisions } from '../decide/decisionServing.js';
import { answerDecisions, DECISION_PATHS } from '../http/decisionRoutes.js';
import { inboxEmailFor, markInboxFor, readInboxFor } from '../inbox.js';
import { TenantTokenRefusal, type TenantTokenService } from './tenantTokenService.js';
import type { TenantSearch } from './tenantSearch.js';
import { ImportUnavailable, readImportRequest, runImport } from '../app/appImport.js';
import { importDeclaration } from '../../shared/appImportDeclaration.js';
import { leaseInbox } from './tenantInbox.js';
import { answerLiveOff, LIVE_PATH } from '../live/liveRoute.js';
import { liveOffResources, liveSyncOn } from '../live/liveBinding.js';
import { trackingReads } from '../live/liveReads.js';
import type { RoomInput } from '../http/firstPaintRooms.js';
import { bootRoom } from './tenantBootRoom.js';
import { itemKey, readKey, type FirstPaintData } from '@mistriwork/engine/shared/firstPaint.js';
import {
  TENANT_BOOT_PATH,
  TENANT_ENTER_PATH,
  soleTenant,
  tenantBatchRequest,
  tenantBootRequest,
  tenantEnterRequest,
  tenantReadAddress,
  tenantReadBody,
} from '../../shared/tenantBoot.js';
import { PLATFORM_TENANT_ID } from '../../shared/tenantContext.js';
import type { AppPayloadApp } from '../../shared/appPayload.js';
import { appKeepsInbox } from '../../shared/appNotify.js';
import { endLiveStreams } from '../live/liveStream.js';
import { tenantLiveHub } from './tenantLive.js';
import { openTenantLiveStream, tenantLiveAuthority, tenantLiveGrants, tenantProbe } from './tenantLiveRoute.js';
import { brandingTenant, scopedRecordBranding, withRecordBranding, closeRecordBranding } from '../http/recordBranding.js';
import { flagHttpRequest } from '../flags/httpRuntime.js';
import { APP_FLAG_VALUES_PATH } from '../../shared/appFlagValues.js';
import { timedPart, timeRequests } from '@mistriwork/engine/adapters/telemetry/serverTiming.js';

class InvalidRequest extends Error {
  constructor(readonly status = 400) {
    super('The tenant request is invalid.');
  }
}
const invalid = (status = 400): never => {
  throw new InvalidRequest(status);
};

/** rawHeaders preserves duplicates that Node's convenience map may combine or
 * discard. Ownership has one spelling, without comma-list or legacy fallbacks. */
export function tenantHttpHeader(req: IncomingMessage, name: string): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() !== name) continue;
    if (result !== undefined) return invalid();
    result = req.rawHeaders[index + 1];
  }
  if (result !== undefined && (!result || result !== result.trim() || result.includes(','))) return invalid();
  return result;
}
const header = tenantHttpHeader;
function revisionHeader(req: IncomingMessage): number {
  const value = header(req, headers.revision);
  if (!value || !/^[1-9][0-9]*$/.test(value)) return invalid();
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) return invalid();
  return revision;
}

/** Shared restart-only host boundary for the data transport and auth host. */
export function tenantHttpBinding(value: unknown): () => Bound {
  const capture = (): Bound => {
    const bound = captureTenantData(tenantOptions(value, ['host', 'port', 'allowedHosts', 'identityHeader']));
    if (
      bound.identityHeader !== undefined ||
      typeof bound.host !== 'string' ||
      !bound.host ||
      typeof bound.port !== 'number' ||
      !Number.isInteger(bound.port) ||
      bound.port < 0 ||
      bound.port > 65535 ||
      (bound.allowedHosts !== undefined &&
        (!Array.isArray(bound.allowedHosts) || bound.allowedHosts.some((value) => typeof value !== 'string')))
    )
      return denyTenant();
    return bound as unknown as Bound;
  };
  const original = capture();
  return () => {
    const current = capture();
    if (current.host !== original.host || !isDeepStrictEqual(current.allowedHosts, original.allowedHosts)) return denyTenant();
    return current;
  };
}
function exposed(name: string, value: string): string {
  tenantIdentifier(value, 1024);
  validateHeaderValue(name, value);
  return value;
}
function ownerHeaders(owner: TenantContextReply): Record<string, string> {
  if (!Number.isSafeInteger(owner.revision) || owner.revision < 1) return denyTenant();
  return {
    [headers.app]: exposed(headers.app, owner.appId),
    [headers.account]: exposed(headers.account, owner.accountId),
    [headers.tenant]: exposed(headers.tenant, owner.tenantId),
    [headers.tab]: exposed(headers.tab, owner.tabId),
    [headers.context]: exposed(headers.context, owner.context),
    [headers.revision]: String(owner.revision),
    ...(owner.realm === 'platform' || owner.realm === 'support' ? { [headers.realm]: owner.realm } : {}),
  };
}
/** What a read needs from a context, a tenant's or the platform realm's. Both
 * present their granted commands; only a tenant context presents edits. */
/* Where one read the page's boot carries says the tables it answered from (live/liveReads.ts), as its own
   request's `mistri-reads` header would have said them: each read apart, never the union of the boot's. */
class ReadsTold {
  readonly headersSent = false;
  value: string | undefined;
  setHeader(_name: string, value: string): void {
    this.value = value;
  }
  removeHeader(): void {
    this.value = undefined;
  }
}

/** A reply the client takes as an answer: a success that says no error (engine http/firstPaint.ts `ok`). */
const carriable = (reply: { status: number; body: unknown }): boolean =>
  reply.status >= 200 &&
  reply.status < 300 &&
  reply.body !== null &&
  typeof reply.body === 'object' &&
  !('error' in reply.body) &&
  !('errors' in reply.body && Array.isArray(reply.body.errors) && reply.body.errors.length > 0);

/** What discovery answers (`/api/tenant/bootstrap`): signed out, or the account's tenants with their names and marks. */
type TenantDiscovery =
  | Readonly<{ status: 'signed_out' }>
  | Readonly<{
      status: 'ready';
      appId: string;
      accountId: string;
      memberships: readonly Readonly<{ tenantId: string; name?: string; sandbox?: true }>[];
      platform?: true;
    }>;
type ReadContext = Pick<TenantReadContext, 'schema' | 'data'> & {
  readonly capabilities?: TenantReadContext['capabilities'];
  readonly principal: { readonly roles: readonly string[]; readonly tenantId?: string };
  /** A tenant context's zone; the platform realm, which spans tenants, keeps the App's own. */
  readonly zone?: string;
  /** A tenant context's member's own locale; the platform realm reads none, as it reads no zone. */
  readonly locale?: string;
  /** A member's context: many reads asked at once, on one snapshot (tenantReadRuntime.ts). */
  readonly together?: TenantReadContext['together'];
};
/** `work` with its reads on one snapshot of `context`, where the context can share one; else as it is. */
const together = <T>(context: ReadContext, work: () => Promise<T>): Promise<T> => (context.together ? context.together(work) : work());
export function readAdapter(context: ReadContext): Adapter {
  return Object.freeze({
    dialect: context.schema.dialect,
    introspect: async () => context.schema,
    close: async () => denyTenant(),
    ...context.data,
  });
}
/**
 * One file of a file resource, read on the lease: through the context's own
 * reader, so the member's grants and the tenant's rows are the only ones it
 * can reach. The bytes come back as base64 with the type the bytes say when
 * they are a picture asked for in place, and as a download otherwise — the
 * page makes a blob of it, never a link.
 */
export async function tenantFileRead(
  app: AppDef,
  reader: Adapter,
  schema: DatabaseSchema,
  input: Record<string, unknown>,
  scope: FileScope,
): Promise<{ status: number; body: unknown }> {
  const table = findTable(schema, typeof input.table === 'string' ? input.table : '');
  const rule = table ? appFileRules(app, schema).rules.get(table.id) : undefined;
  if (!table || !rule) return { status: 404, body: { error: 'This resource does not hold files.' } };
  let stored: Awaited<ReturnType<typeof readStoredFile>>;
  try {
    stored = await readStoredFile(reader, table, rule, input.key, input.variant, scope);
  } catch (error) {
    const trouble = fileStoreTrouble(error, 'read');
    if (!trouble) throw error;
    return { status: 503, body: { error: trouble } };
  }
  if ('error' in stored) return { status: stored.status, body: { error: stored.error } };
  const image = input.inline === true ? sniffImage(stored.bytes) : undefined;
  return {
    status: 200,
    body: { name: stored.name, type: image ?? 'application/octet-stream', data: Buffer.from(stored.bytes).toString('base64') },
  };
}
async function body(req: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if ((size += chunk.length) > maximum) return invalid(413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = captureTenantData(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))),
    );
    tenantRecord(value);
    return value;
  } catch {
    return invalid();
  }
}
function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, ownership: Record<string, string> = {}): void {
  // Serialize before installing ownership headers: a failed projection must not
  // release either a partial private body or a success-looking owner assertion.
  const json = replyJson(value);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(json),
    ...ownership,
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}
function sendResource<Path extends ResourceHttpPath>(
  req: IncomingMessage,
  res: ServerResponse,
  _path: Path,
  value: TenantHttpResourceReply<NoInfer<Path>>,
  owner: TenantContextReply,
): void {
  send(req, res, 200, value, ownerHeaders(owner));
}

interface TenantHttpOptions {
  readonly app: AppDef;
  /** The look a save changed in place (tenantLook.ts, G175): worn by the App payload, never by its authority. */
  readonly look?: () => TenantLook | undefined;
  readonly enrollment: TenantEnrollment<IncomingMessage>;
  readonly verifySessionInstance: (request: IncomingMessage) => VerifiedSessionInstance | null | Promise<VerifiedSessionInstance | null>;
  readonly bound: Bound;
  /** The host's support owner: its routes and the support lease's fence. */
  readonly support?: TenantSupport;
  /** Where each of the App's compiled custom components is served (appComponents.ts componentHrefs): code, never a row. */
  readonly components?: Readonly<Record<string, { kind: string; href: string; css?: string }>>;
  /** A member's own App API tokens (tenantTokenService.ts), when the App declares an `api`. */
  readonly tokens?: TenantTokenService;
  /** The App's search (tenantSearch.ts): a context's reader made searchable within its tenant. */
  readonly search?: Pick<TenantSearch, 'reader'>;
  /** Each tenant's branding (tenantBranding.ts), when the App declares `branding`. */
  readonly branding?: TenantBrandingService;
  /** The integrations' settings screen (tenantIntegrations.ts), when the jobs module lists integrations. */
  readonly integrations?: NonNullable<TenantIntegrations['settings']>;
  /** Whether a tenant has the App's assistant (tenantAssistant.ts): its switch is on and a model is set up. */
  readonly assistant?: { offered(tenantId: string): Promise<boolean> };
  /** The verified reader's own name, for a dashboard that greets `{me.name}` (appGreeting.ts): words on a
      screen, never an authority. Absent, or saying nothing, the greeting is left out. */
  readonly readerName?: (req: IncomingMessage) => string | undefined;
  /** The free-form pages' loaders, by name: the commands module's `loaders` (commands/pageLoaders.ts). */
  readonly loaders?: Readonly<Record<string, PageLoader>>;
}

/* The loaders as handed over, captured once: own names, each a defineLoader's object, never a proxy. */
function capturedLoaders(value: unknown): Readonly<Record<string, PageLoader>> {
  if (!value || typeof value !== 'object' || isProxy(value) || Array.isArray(value)) return denyTenant();
  const held: Record<string, PageLoader> = Object.create(null);
  for (const [name, loader] of Object.entries(value)) {
    if (!loader || typeof loader !== 'object' || isProxy(loader) || typeof (loader as PageLoader).load !== 'function') return denyTenant();
    held[name] = loader as PageLoader;
  }
  return Object.freeze(held);
}

/** Private integration server, deliberately not mounted by the CLI/createApp.
 * No Registry, ordinary adapter, authoring store, static UI or raw-SQL fallback
 * is reachable here. Successful construction transfers enrollment retirement. */
export function createTenantHttpServer(options: TenantHttpOptions) {
  const raw = tenantOptions(options, [
    'app',
    'look',
    'enrollment',
    'verifySessionInstance',
    'bound',
    'support',
    'components',
    'tokens',
    'search',
    'branding',
    'integrations',
    'assistant',
    'readerName',
    'loaders',
  ]);
  const integrationSettings = raw.integrations as TenantHttpOptions['integrations'];
  const tokens = raw.tokens as TenantTokenService | undefined;
  const tenantBranding = raw.branding as TenantBrandingService | undefined;
  const search = raw.search as TenantHttpOptions['search'];
  const assistantSwitch = raw.assistant as TenantHttpOptions['assistant'];
  if (raw.readerName !== undefined && (typeof raw.readerName !== 'function' || isProxy(raw.readerName))) return denyTenant();
  const readerName = raw.readerName as TenantHttpOptions['readerName'];
  if (raw.look !== undefined && (typeof raw.look !== 'function' || isProxy(raw.look))) return denyTenant();
  const look = raw.look as TenantHttpOptions['look'];
  /* A name that is not one plain line of text is no name (appGreeting.ts). */
  const nameOf = (req: IncomingMessage): string | undefined => {
    let said: unknown;
    try {
      said = readerName?.(req);
    } catch {
      return undefined;
    }
    return typeof said === 'string' && said.trim() && said.length <= 200 && !/\p{Cc}/u.test(said) ? said : undefined;
  };
  const components = raw.components === undefined ? undefined : (captureTenantData(raw.components) as TenantHttpOptions['components']);
  const loaders = raw.loaders === undefined ? undefined : capturedLoaders(raw.loaders);
  const support = raw.support as TenantSupport | undefined;
  if (support !== undefined && (!support || typeof support !== 'object' || isProxy(support))) return denyTenant();
  const {
    enrollment,
    app: enrolled,
    pages,
    clock: now,
    ownership,
  } = captureTenantEnrollment(raw.enrollment as TenantEnrollment<IncomingMessage>);
  const app = captureTenantData(raw.app as AppDef);
  /* The history store as readRecordHistoryFor asks for one: reads by the store key, which the route derives. */
  const historyStore = Object.freeze({
    recordHistoryReady: async () => true,
    readRecordHistory: (query: RecordHistoryQuery) => enrollment.deployment.recordHistory(query),
    readRecordActivity: (query: RecordActivityQuery) => enrollment.deployment.recordActivity(query),
  });
  if (
    !isDeepStrictEqual(app, enrolled) ||
    !isTenantApp(app) ||
    !tenantAppShape(app) ||
    typeof raw.verifySessionInstance !== 'function' ||
    isProxy(raw.verifySessionInstance)
  )
    return denyTenant();
  exposed(headers.app, app.id);
  const computedSaysMe = Object.values(app.resources ?? {}).some((resource) =>
    Object.values(resource.computed ?? {}).some((computed) => /\bme\b/i.test(computed.value)),
  );
  // The host may fill an ephemeral port after listen(). Capture one consistent
  // descriptor-safe binding per request, never access mutable config mid-check.
  const binding = tenantHttpBinding(raw.bound);
  const verify = raw.verifySessionInstance as TenantHttpOptions['verifySessionInstance'];
  let retired = false;
  const pending = new Set<Promise<void>>(),
    accepted = new Set<IncomingMessage>();
  const expectedAccounts = new WeakMap<IncomingMessage, string | undefined>();
  const assertActive = () => {
    if (retired) return denyTenant();
  };
  const verified = async (req: IncomingMessage): Promise<VerifiedSessionInstance | null> => {
    assertActive();
    const returned = verify(req);
    const value = isPromise(returned)
      ? ((await Promise.prototype.then.call(returned, captureTenantData, () => denyTenant())) as VerifiedSessionInstance | null)
      : captureTenantData(returned);
    assertActive();
    if (!expectedAccounts.has(req)) return denyTenant();
    const expected = expectedAccounts.get(req);
    if (value === null) {
      if (expected !== undefined) return denyTenant();
      return null;
    }
    tenantRecord(value, ['identity', 'sessionId', 'expiresAt']);
    tenantRecord(value.identity, ['id', 'who', 'role']);
    exposed(headers.account, value.identity.id);
    tenantIdentifier(value.sessionId, 1024);
    const instant = now();
    assertActive();
    if (
      typeof value.identity.who !== 'string' ||
      (value.identity.role !== undefined && typeof value.identity.role !== 'string') ||
      !Number.isSafeInteger(value.expiresAt) ||
      value.expiresAt <= instant
    )
      return denyTenant();
    if (expected !== undefined && expected !== value.identity.id) return denyTenant();
    return value;
  };
  /**
   * The person's tenants, each with what it is called and whether it is a sandbox: `/api/tenant/bootstrap`'s answer,
   * and the first part of `/api/tenant/enter`'s. The session is read before and after discovery and must be the same
   * session throughout, and still live once discovery has answered. `seen` is told the tenants discovery's first
   * snapshot found (tenantBootstrap.ts), to start what it would ask of them next beside the rest.
   */
  const discoverFor = async (req: IncomingMessage, seen?: (tenantIds: readonly string[]) => void): Promise<TenantDiscovery> => {
    const proof = await verified(req);
    let expiresAt = proof?.expiresAt;
    /* What each tenant is called, and which is a sandbox, asked of the tenants the first snapshot found beside the
       snapshots that confirm them, rather than after: two more round trips before the chooser could draw. Said only
       of the tenants discovery answers with, and asked again where those are not the ones asked. */
    let early: { ids: readonly string[]; marks: Promise<readonly [Readonly<Record<string, string>>, ReadonlySet<string>]> } | undefined;
    const marksOf = (ids: readonly string[]) =>
      Promise.all([
        enrollment.names(ids).catch((): Readonly<Record<string, string>> => ({}) /* ids only */),
        enrollment.sandboxes(ids),
      ] as const);
    const discovered = await enrollment.discover(
      req,
      async () => {
        const current = await verified(req);
        if (proof === null || current === null) {
          if (proof !== current) return denyTenant();
        } else {
          if (proof.identity.id !== current.identity.id || proof.sessionId !== current.sessionId) return denyTenant();
          expiresAt = Math.min(expiresAt!, current.expiresAt);
        }
      },
      (ids) => {
        if (ids.length) {
          early = { ids, marks: marksOf(ids) };
          early.marks.catch(() => {});
        }
        seen?.(ids);
      },
    );
    const instant = now();
    assertActive();
    if (
      proof === null
        ? discovered.status !== 'signed_out'
        : instant >= expiresAt! ||
          discovered.status !== 'ready' ||
          discovered.accountId !== proof.identity.id ||
          discovered.appId !== app.id
    )
      return denyTenant();
    if (discovered.status !== 'ready' || !discovered.memberships.length) return discovered;
    /* Each choice with what the tenant is called, for the chooser and the
       bar: words for a person beside the id the choice still sends. A
       lookup that fails leaves the ids to speak for themselves. */
    const chosen = discovered.memberships.map((member) => member.tenantId);
    /* A sandbox says so to its members wherever its name is said.
       Unlike a name, this is not left out quietly: a sandbox read as live
       is the mistake the mark exists to prevent. */
    const asked =
      early && early.ids.length === chosen.length && early.ids.every((id, at) => id === chosen[at]) ? early.marks : marksOf(chosen);
    const [names, sandboxes] = await asked;
    assertActive();
    return {
      ...discovered,
      memberships: discovered.memberships.map((member) => ({
        ...member,
        ...(Object.hasOwn(names, member.tenantId) ? { name: names[member.tenantId] } : {}),
        ...(sandboxes.has(member.tenantId) ? { sandbox: true as const } : {}),
      })),
    };
  };
  /**
   * A CSV file imported into a resource the member writes (app/appImport.ts),
   * on this tab's lease: every read it makes is a read in the member's own
   * context, and its rows are written in one transaction of that context, the
   * tenant's ownership injected on each (tenantRecordHistory.ts importRows), or
   * each through the resource's declared command. Nothing in the request names
   * a tenant, an owner or a key the context did not admit.
   */
  const tenantImport = async (
    req: IncomingMessage,
    selectors: readonly string[],
    expected: TenantContextAssertion,
    input: Record<string, unknown>,
    attributed: <T>(work: () => Promise<T>, action?: string) => Promise<T>,
    signal: AbortSignal,
  ) => {
    let last: TenantContextReply | undefined;
    const owned = <T>(answer: { value: T; context: TenantContextReply }): T => {
      last = answer.context;
      return answer.value;
    };
    const reading = <T>(run: (context: TenantReadContext) => T | Promise<T>) =>
      contexts.withContext(req, selectors, expected, run).then(owned);
    try {
      const request = readImportRequest(input);
      const { schema, zone } = await reading((context) => ({
        schema: tenantServedSchema(context, app, new Date(now())),
        zone: context.zone,
      }));
      const call = <K extends keyof ScopedReads>(method: K) =>
        ((...args: unknown[]) =>
          reading((context) => (context.data[method] as (...values: unknown[]) => unknown)(...args))) as ScopedReads[K];
      const reader = Object.freeze({
        dialect: schema.dialect,
        introspect: async () => schema,
        close: async () => denyTenant(),
        query: call('query'),
        count: call('count'),
        runView: call('runView'),
        countView: call('countView'),
        runBreakdown: call('runBreakdown'),
        countBreakdown: call('countBreakdown'),
      }) as unknown as Adapter;
      /* A list that names roles the member does not hold in this tenant imports nothing for them, as one that is not there. */
      const roles = await reading((context) => context.principal.roles);
      const declared = importDeclaration(appForRoles(app, roles), request.table, request.view);
      if (!declared) throw new ImportUnavailable(404, 'This list does not import files.');
      const runtime = {
        app,
        schema,
        reader,
        locale: app.ui.locale ?? 'en-US',
        now: () => zonedNow(appZone(app.ui, zone), new Date(now())),
        signal,
      };
      const unknownAsUnknown = async <T>(work: () => Promise<T>): Promise<T> => {
        try {
          return await work();
        } catch (error) {
          throw error instanceof TenantWriteFailure && error.outcome === 'unknown' ? new TransactionOutcomeUnknown(error) : error;
        }
      };
      const report = declared.def.command
        ? await runImport(
            {
              ...runtime,
              commandLabel: `${commandActionLabel(app, { command: declared.def.command.id }) ?? 'Command'} (import)`,
              commands: {
                prepare: (body) => contexts.prepare(req, selectors, expected, body).then(owned),
                execute: (body) => attributed(() => contexts.execute(req, selectors, expected, body).then(owned)),
              },
            },
            request,
          )
        : await runImport(
            {
              ...runtime,
              writer: {
                trial: (insert) =>
                  unknownAsUnknown(() =>
                    contexts.importRows(req, selectors, expected, { inserts: [insert], trial: true }).then(owned),
                  ).then(() => {}),
                commit: (inserts) =>
                  unknownAsUnknown(() =>
                    attributed(() => contexts.importRows(req, selectors, expected, { inserts, trial: false }).then(owned)),
                  ).then(() => ({ undo: 'An import is undone record by record here.' })),
              },
            },
            request,
          );
      if (!last) return denyTenant();
      return { report, context: last };
    } catch (error) {
      if (error instanceof ImportUnavailable) return { refused: { status: error.status, message: error.message } };
      throw error;
    }
  };
  const contexts = createTenantContexts({
    deployment: enrollment.deployment,
    verifySessionInstance: verified,
    now,
    ...(support
      ? {
          support: {
            admit: (request: IncomingMessage, target: Parameters<TenantSupport['admit']>[1]) => support.admit(request, target),
            holds: (request: IncomingMessage) => support.holds(request),
          },
        }
      : {}),
  });
  /* Live streams this server holds open: ended when it retires, so its close does not wait ten minutes for them. */
  const liveStreams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    setBaselineHeaders(req, res, (raw.bound as Bound | undefined)?.trustedProxies);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    pending.add(held);
    accepted.add(req);
    let path = '',
      completedWrite = false;
    const controller = new AbortController(),
      abort = () => controller.abort();
    req.once('aborted', abort);
    res.once('close', abort);
    const work = async () => {
      assertActive();
      const target = req.url ?? '';
      if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) return invalid();
      const url = new URL(target, 'http://localhost');
      path = url.pathname;
      if (path !== target.split('?')[0]) return invalid();
      const bound = binding();
      if (doorRefusal(req, bound, { writing: changesSomething(req) })) return invalid(403);
      // Reject duplicate ownership headers even on bootstrap/control requests.
      for (const name of Object.values(headers)) header(req, name);
      expectedAccounts.set(req, header(req, headers.account));
      // The two views are under the same root but are not the login's own
      // operations: each is read on a lease — the dealer's log on that dealer's
      // tenant lease, the lender's audit view on a platform one — so they go
      // the ordinary lease-bearing way below.
      if (path.startsWith(`${SUPPORT_HTTP_ROOT}/`) && path !== SUPPORT_LOG_PATH && path !== SUPPORT_SESSIONS_PATH) {
        const operation = path.slice(SUPPORT_HTTP_ROOT.length + 1) as (typeof SUPPORT_HTTP_OPERATIONS)[number];
        if (!support || !SUPPORT_HTTP_OPERATIONS.includes(operation)) return invalid(403);
        if (req.method !== 'POST') return invalid(405);
        // A bearer token belongs to the App API, never to a support session.
        if (req.headers.authorization !== undefined) return invalid(403);
        if (
          [...url.searchParams.keys()].some((key) => key !== 'app') ||
          url.searchParams.getAll('app').length !== 1 ||
          url.searchParams.get('app') !== app.id
        )
          return invalid();
        // The native login's own request: it names no tenant, realm, tab or lease.
        if (
          [headers.tenant, headers.realm, headers.tab, headers.context, headers.revision].some((name) => header(req, name) !== undefined) ||
          (header(req, headers.app) !== undefined && header(req, headers.app) !== app.id)
        )
          return invalid();
        const account = header(req, headers.account);
        if (account === undefined) return invalid();
        exposed(headers.account, account);
        const input = await body(req, 16384);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const reply = await dispatchTenantSupportHttp(req, operation, input, account, { support, contexts, names: enrollment.names });
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        return send(req, res, reply.status, reply.body, reply.context ? ownerHeaders(reply.context) : {});
      }
      /* `let`, these four: an enter request, once its lease is open, is answered as the boot on that lease (below). */
      let control = controls.has(path);
      /* An enter request past its lease: discovery's answer and the lease, which its boot's answer carries. */
      let entering: { found: TenantDiscovery; lease: TenantContextReply } | undefined;
      const selected =
        !control || path.endsWith('/open') || path.endsWith('/switch') || path.endsWith('/renew') || path.endsWith('/resume');
      const supportLog = path === SUPPORT_LOG_PATH,
        supportSessions = path === SUPPORT_SESSIONS_PATH;
      const flagValues = path === APP_FLAG_VALUES_PATH && flagHttpRequest()?.request === req;
      const flagExposures = path === EXPERIMENT_EXPOSURES_PATH && flagHttpRequest()?.request === req;
      const live = path === LIVE_PATH;
      const get =
        flagValues ||
        live ||
        path === '/api/schema' ||
        path === '/api/tenant/bootstrap' ||
        metadataGets.has(path) ||
        supportLog ||
        supportSessions;
      if (
        !(
          control ||
          reads.has(path) ||
          writes.has(path) ||
          commands.has(path) ||
          path === '/api/schema' ||
          metadataGets.has(path) ||
          metadataPosts.has(path) ||
          supportLog ||
          supportSessions ||
          flagValues ||
          flagExposures ||
          live
        )
      )
        return invalid(403);
      if (get ? req.method !== 'GET' && req.method !== 'HEAD' : req.method !== 'POST') return invalid(405);
      if (
        get &&
        (req.headers['transfer-encoding'] !== undefined ||
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))
      )
        return invalid();
      const keys = [...url.searchParams.keys()];
      const suggested = path === '/api/pages/suggested';
      // A selected request names one tenant (`?tenant=`) or the platform realm
      // (`?realm=platform`), never both, and the realm only where the
      // deployment has it.
      const realm = selected ? url.searchParams.get('realm') : null;
      const platform = selected && realm === 'platform';
      // A support session names both: the realm it is acting in, and the dealer
      // it entered. It names the dealer so that every path which is not a read
      // still reaches the tenant families and is refused there by the one
      // support rule, rather than dying earlier on an empty selector and
      // answering something other than "support refused this".
      const onSupport = selected && realm === 'support';
      if (
        keys.some(
          (key) =>
            ![
              'app',
              ...(selected ? (platform ? ['realm'] : onSupport ? ['realm', 'tenant'] : ['tenant']) : []),
              ...(suggested ? ['table'] : []),
              ...(live ? ['after'] : []),
            ].includes(key),
        ) ||
        url.searchParams.getAll('app').length !== 1 ||
        url.searchParams.get('app') !== app.id ||
        (selected && !platform && url.searchParams.getAll('tenant').length !== 1) ||
        (selected && (platform || onSupport) && url.searchParams.getAll('realm').length !== 1) ||
        (realm !== null && !platform && !onSupport) ||
        (platform && !enrollment.deployment.platform) ||
        // A support lease is opened through the support routes, never by naming
        // its realm on a context control path.
        (onSupport && (!support || control)) ||
        (suggested && url.searchParams.getAll('table').length !== 1) ||
        (live && url.searchParams.getAll('after').length > 1)
      )
        return invalid();
      // Not offered on a support lease, where each card is its own ledgered
      // read: a 404 tells the client to ask each card alone (breakdownBatch.ts).
      if (onSupport && path === '/api/breakdowns') return invalid(404);
      /* Nor a composed record page, for the same reason: its client asks the plan and each part alone. */
      if (onSupport && path === '/api/pages/compose') return invalid(404);
      /* Nor the page's boot, which is many reads in one: its client asks each read alone (shared/tenantBoot.ts). */
      if (onSupport && path === TENANT_BOOT_PATH) return invalid(404);
      let selectors = selected && !platform ? [url.searchParams.get('tenant')!] : [];
      if (selected && !platform) {
        parseTenantSelector(selectors);
        exposed(headers.tenant, selectors[0]);
      }
      // app/tenant are URL selectors, never competing request headers. App's
      // response header is accepted only as a matching stale-App precondition.
      if (
        header(req, headers.tenant) !== undefined ||
        header(req, headers.realm) !== undefined ||
        (header(req, headers.app) !== undefined && header(req, headers.app) !== app.id)
      )
        return invalid();
      if (control && [headers.tab, headers.context, headers.revision].some((name) => header(req, name) !== undefined)) return invalid();
      let assertion: TenantContextAssertion | undefined = control
        ? undefined
        : {
            tabId: header(req, headers.tab) ?? '',
            expectedContext: header(req, headers.context) ?? '',
            expectedRevision: revisionHeader(req),
          };
      if (!control && (!assertion!.tabId || !assertion!.expectedContext)) return invalid();
      let input =
        get || flagExposures
          ? {}
          : await body(
              req,
              commands.has(path)
                ? 65536
                : control
                  ? 16384
                  : path === '/api/import'
                    ? IMPORT_BODY
                    : path === FILE_UPLOAD_PATH
                      ? TENANT_FILE_UPLOAD_BODY
                      : path === '/api/branding/save'
                        ? BRANDING_SAVE_BODY
                        : 262144,
            );
      if (!get && !flagExposures) tenantRecord(input, fields[path]);
      assertActive();
      if (req.aborted || res.destroyed) return denyTenant();
      if (path === '/api/tenant/bootstrap') {
        const found = await discoverFor(req);
        if (req.aborted || res.destroyed) return denyTenant();
        return send(req, res, 200, found);
      }
      if (path === TENANT_ENTER_PATH) {
        /* The person's tenants, and where they are entered without being asked, the lease and the page's boot on it,
           in one request (shared/tenantBoot.ts). Nothing here is a new proof: each step is the function its own
           route runs, in the order the page asked them, and each refuses what that route refuses. */
        const asked = tenantEnterRequest(input, app.id) ?? invalid();
        /* A lease in `tenantId`, in the page's own order (client tenantBrowser.ts `contextFor`): this tab's kept
           context resumed where it is that tenant's, else a new one. A refusal is no lease: the page then asks to
           open one itself, and hears why in that route's words. */
        const leaseIn = async (tenantId: string): Promise<TenantContextReply | undefined> => {
          if (asked.kept?.tenantId === tenantId) {
            try {
              return await contexts.resume(req, [tenantId], { tabId: asked.kept.tabId });
            } catch {
              /* Gone, expired, or held by another page: a new one. */
            }
          }
          return contexts.open(req, [tenantId], {}).catch(() => undefined);
        };
        /* A lease the answer will not carry is let go at once, as a page leaving lets its own go. */
        const letGo = async (pending: Promise<TenantContextReply | undefined> | undefined) => {
          const lease = await pending;
          if (lease)
            await contexts
              .release(req, { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision })
              .catch(() => {});
        };
        /* The tenant the page has reason to expect — the link's, the one this tab kept, or else the one discovery's
           first snapshot finds — is opened beside the rest of discovery rather than after it: opening is its own
           admission, exactly what the page could ask of `/open` for any tenant without asking discovery first, and
           nothing of the tenant is read before discovery has answered that it is the person's one. Where it is not,
           the lease is let go unseen. */
        const hint = asked.tenant ?? asked.kept?.tenantId;
        let ahead = hint === undefined ? undefined : { tenantId: hint, lease: leaseIn(hint) };
        let found: TenantDiscovery;
        try {
          /* Named nowhere, the tenant is the one discovery's first snapshot finds, where it finds one. */
          found = await discoverFor(req, (ids) => {
            if (ahead === undefined && ids.length === 1) ahead = { tenantId: ids[0]!, lease: leaseIn(ids[0]!) };
          });
        } catch (error) {
          await letGo(ahead?.lease);
          throw error;
        }
        const sole =
          found.status === 'ready'
            ? soleTenant(
                (found.memberships ?? []).map((member) => member.tenantId),
                found.platform === true,
                asked.tenant,
              )
            : undefined;
        if (ahead && ahead.tenantId !== sole) await letGo(ahead.lease);
        const lease = sole === undefined ? undefined : ahead?.tenantId === sole ? await ahead.lease : await leaseIn(sole);
        assertActive();
        if (lease && (lease.tenantId !== sole || lease.realm !== undefined || req.aborted || res.destroyed)) {
          await letGo(Promise.resolve(lease));
          return denyTenant();
        }
        if (!lease) return send(req, res, 200, found);
        /* Entered: the page's boot on that lease, answered by the boot's own branch below as a `/api/boot` request
           bearing the lease would be — its tenant as the selector, its tab, context and revision as the assertion,
           the address as the boot's — so each of its reads is admitted on the lease and gated as its own request. */
        parseTenantSelector([sole!]);
        exposed(headers.tenant, sole!);
        entering = { found, lease };
        control = false;
        selectors = [sole!];
        assertion = { tabId: lease.tabId, expectedContext: lease.context, expectedRevision: lease.revision };
        input = { path: asked.page.path, search: asked.page.search };
        path = TENANT_BOOT_PATH;
      }
      if (control) {
        const asserted = input as unknown as TenantContextAssertion,
          opening = input as Record<string, never>;
        const result = path.endsWith('/open')
          ? await (platform ? contexts.openPlatform(req, opening) : contexts.open(req, selectors, opening))
          : path.endsWith('/switch')
            ? await (platform ? contexts.switchToPlatform(req, asserted) : contexts.switch(req, selectors, asserted))
            : path.endsWith('/renew')
              ? await (platform ? contexts.renewPlatform(req, asserted) : contexts.renew(req, selectors, asserted))
              : path.endsWith('/resume')
                ? await (platform
                    ? contexts.resumePlatform(req, input as unknown as { tabId: string })
                    : contexts.resume(req, selectors, input as unknown as { tabId: string }))
                : path.endsWith('/release')
                  ? await contexts.release(req, asserted)
                  : await contexts.recover(req, input as unknown as { tabId: string });
        return send(req, res, 200, result, 'context' in result ? ownerHeaders(result) : {});
      }
      const expected = assertion!;
      if (flagValues || flagExposures) {
        if (onSupport) return invalid(403);
        const scope = flagHttpRequest()!;
        const handler = scope.runtime.valuesHttp({
          bound,
          async withRequest(request, response, guard, use) {
            const run = async (context: TenantReadContext | PlatformReadContext, lease: TenantContextReply) => {
              guard();
              if (lease.realm === 'support') return denyTenant();
              await use(await scope.runtime.tenant(request, context.principal), { ...lease, realm: lease.realm });
            };
            const admitted = platform
              ? await contexts.withPlatformContext(request, expected, run)
              : await contexts.withContext(request, selectors, expected, run);
            assertActive();
            guard();
            for (const [name, value] of Object.entries(ownerHeaders(admitted.context))) response.setHeader(name, value);
          },
        });
        await handler(req, res);
        return;
      }
      if (live) {
        /* A member's own tenant only: the platform realm reads across tenants and a support visit is ledgered read by read, so neither follows changes. */
        if (platform || onSupport) return invalid(404);
        const hub = tenantLiveHub(ownership);
        if (req.method !== 'GET') return send(req, res, 404, { error: 'Live sync is read with GET.' });
        if (!hub || !liveSyncOn() || !app.live) return answerLiveOff(res);
        const session = await verified(req);
        if (!session) return denyTenant();
        const actor = session.identity.who;
        const resolve = async () => {
          const admitted = await contexts.withContext(req, selectors, expected, (context: TenantReadContext) =>
            tenantLiveGrants(context, app, ownership, now()),
          );
          return { grants: admitted.value, context: admitted.context };
        };
        const probe = (table: string, keys: Parameters<typeof tenantProbe>[2]) =>
          contexts
            .withContext(req, selectors, expected, (context: TenantReadContext) => tenantProbe(context, table, keys))
            .then((answer) => answer.value);
        const first = await resolve();
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const cursor = url.searchParams.get('after') ?? undefined;
        await openTenantLiveStream({
          req,
          res,
          hub,
          account: first.grants.accountId,
          ...(cursor === undefined ? {} : { cursor }),
          authority: tenantLiveAuthority(app.id, first.grants, actor, probe),
          resolve: async () => {
            const again = await resolve();
            /* The same member of the same tenant, or the stream ends: a lease switched to another tenant is another stream. */
            if (again.grants.tenantId !== first.grants.tenantId || again.grants.accountId !== first.grants.accountId) return denyTenant();
            return tenantLiveAuthority(app.id, again.grants, actor, probe);
          },
          headers: ownerHeaders(first.context),
          off: liveOffResources(app),
        });
        /* The stream's probes and re-resolutions are this request's reads, verified against the account it named, until it closes. */
        if (res.destroyed || res.writableEnded) return;
        liveStreams.add(res);
        res.once('close', () => {
          liveStreams.delete(res);
          expectedAccounts.delete(req);
        });
        return;
      }
      if (supportLog) {
        // A dealer's own view of support visits into it. The lease is the
        // authority: it proves this account is a member of this dealer, and
        // the tenant whose history is read is taken from the admitted evidence
        // rather than from the request, so no id in a URL can reach another
        // dealer's sessions. The support realm has no business here — an
        // operator inside a dealer reads that dealer's rows, not its log of
        // being visited.
        if (!support || platform || onSupport) return invalid(403);
        // What comes back out of the lease is plain data, as every context
        // result must be: the tenant it admitted, and the readable columns of
        // each resource as arrays. The map is built here, outside.
        const viewer = await contexts.withContext(req, selectors, expected, (context: TenantReadContext) => {
          const roles = context.principal.roles;
          // The grant is a role's, declared in the App. Without it the log is
          // refused outright: being a member of the dealer is not by itself
          // being someone the dealer chose to show its support history to.
          if (!roles.some((role) => app.auth?.roles?.[role]?.supportLog === true)) return denyTenant();
          // Resolved against the deployment's own attested catalog: a tenant
          // context's schema omits the platform's resources while the App's
          // ceilings name them, so only the whole catalog can say what a role
          // may read.
          const access = resolveAppAccess(app, ownership.schema, roles);
          return {
            tenantId: context.principal.tenantId,
            fields: [...access.readable].map((id) => ({
              id,
              read: [...(access.fields?.get(id)?.read ?? [])],
              all: access.fields?.get(id) === undefined,
            })),
          };
        });
        const { tenantId, fields } = viewer.value;
        const rows = await support.readLog(req, tenantId);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const readable: SupportLogFields = new Map(fields.map((field) => [field.id, field.all ? undefined : new Set(field.read)]));
        const label = app.auth?.tenancy?.platform?.label ?? 'Platform';
        const body: SupportLogReply = { tenantId, sessions: projectSupportLog(rows, tenantId, label, readable), more: rows.more };
        return send(req, res, 200, body, ownerHeaders(viewer.context));
      }
      if (supportSessions) {
        // The lender's own audit view: every dealer's sessions, on a platform
        // lease, for a platform role granted `supportAudit`. This is the one
        // view that carries an operator's email — a dealer's log deliberately
        // does not — so it is the platform realm's alone and reads nothing on
        // a tenant's lease.
        if (!support || !platform) return invalid(403);
        const viewer = await contexts.withPlatformContext(req, expected, (context: PlatformReadContext) => {
          const roles = context.principal.roles;
          if (!roles.some((role) => app.auth?.roles?.[role]?.supportAudit === true)) return denyTenant();
          const access = resolveAppAccess(app, ownership.schema, roles);
          return {
            fields: [...access.readable].map((id) => ({
              id,
              read: [...(access.fields?.get(id)?.read ?? [])],
              all: access.fields?.get(id) === undefined,
            })),
          };
        });
        const { rows, emails } = await support.readAudit(req);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const readable: SupportLogFields = new Map(
          viewer.value.fields.map((field) => [field.id, field.all ? undefined : new Set(field.read)]),
        );
        const label = app.auth?.tenancy?.platform?.label ?? 'Platform';
        const body: SupportAuditReply = {
          sessions: projectSupportAudit(rows, label, readable, (accountId) => emails[accountId] ?? null),
          more: rows.more,
        };
        return send(req, res, 200, body, ownerHeaders(viewer.context));
      }
      if (reads.has(path) || path === '/api/schema' || metadataGets.has(path) || metadataPosts.has(path)) {
        // One read path for either realm's lease: the platform realm's context
        // presents its own commands and no edits, and reads across tenants.
        const within = <T>(run: (context: ReadContext) => Promise<T>) =>
          platform
            ? contexts.withPlatformContext(req, expected, (context: PlatformReadContext) => run(context))
            : onSupport
              ? contexts.withSupportContext(req, selectors, expected, (context: SupportReadContext) => run(context))
              : contexts.withContext(req, selectors, expected, (context: TenantReadContext) => run(context));
        /* Who `me` is on this lease (appMe.ts lookupTenantPerson), asked on
           every request that compares with it and never kept: the admitted
           membership's account, in the lease's own realm, read through its
           own reader. A tenant's people are its own rows (a tenant-owned
           table), the platform realm's its own — its staff, where
           auth.tenancy.platform.me names them; a people table of
           the other realm, or a shared one, holds nobody's row here, and a
           support operator is never one of a dealer's people. */
        const tenantPerson = async (context: ReadContext, schema: ReturnType<typeof tenantServedSchema>) => {
          const session = await verified(req);
          const staff = platform ? app.auth?.tenancy?.platform?.me : undefined;
          const people = staff ? { ...app, auth: { ...app.auth!, me: staff } } : app;
          const owned = people.auth?.me ? ownership.ownership[people.auth.me.from]?.kind : undefined;
          const account = (context.principal as { accountId?: unknown }).accountId;
          const own = !onSupport && owned === (platform ? 'platform' : 'tenant') && typeof account === 'string';
          return lookupTenantPerson(
            people,
            schema,
            session?.identity.who ?? null,
            own ? (account as string) : undefined,
            readAdapter(context),
          );
        };
        /* The App and its pages as this context is offered them, in `locale` with the tenant's own `words`: what
           `/api/app` and `/api/pages` answer from, and what the page's boot plans its room from. Projected once per
           served schema, look, locale and words: the boot asks both routes together, and it was projected for each. */
        const projections = new WeakMap<object, Array<{ look: unknown; key: string; value: ReturnType<typeof projectTenantMetadata> }>>();
        const projected = (
          context: ReadContext,
          schema: ReturnType<typeof tenantServedSchema>,
          locale: string | undefined,
          words: Awaited<ReturnType<typeof readTenantMessages>>,
        ) => {
          /* The payload wears the look a save changed in place; every check above read the App it started with. */
          const wearingNow = look?.();
          const key = JSON.stringify([locale ?? null, words?.words.size ? words.stamp : null]);
          const held = projections.get(schema) ?? [];
          const found = held.find((entry) => entry.look === wearingNow && entry.key === key);
          if (found) return found.value;
          const worn = wearing(app, wearingNow);
          const local = localizedApp({ app: worn, pages: [...pages] }, locale, words);
          const said = local.app === worn ? { app: worn, pages } : captureTenantData(local);
          /* The lease's realm, not the schema's shape, decides which
             surface this context is offered. A support session reads as
             the dealer it entered, so it is offered the dealer's realm. */
          const value = projectTenantMetadata(
            said.app,
            said.pages,
            schema,
            context.capabilities,
            context.principal.roles,
            platform ? 'platform' : 'tenant',
            context.zone,
            locale,
          );
          projections.set(schema, [...held, { look: wearingNow, key, value }]);
          return value;
        };
        /* One read on this context, as its own request is answered: the
           metadata posts and the resource reads. A composed record page asks
           each of its parts through this, under the one context it holds. */
        const route = async (
          context: ReadContext,
          schema: ReturnType<typeof tenantServedSchema>,
          path: string,
          input: Record<string, unknown>,
          /* A read asked inside another (the page's boot): its own query string, and where the tables it answered
             from are told, where its own request's reply would have said them. */
          asked: { query?: URLSearchParams; told?: ReadsTold } = {},
        ): Promise<{ status: number; body: unknown }> => {
          if (path === '/api/schema') return { status: 200, body: schema };
          if (metadataGets.has(path) || metadataPosts.has(path)) {
            const reply = (body: unknown) => ({ status: 200, body });
            if (path === PAGE_LOAD_PATH) {
              /* A free-form page's loader, run as a single App runs it (http/pageLoad.ts): the page found in this
                 realm's surface as the lease's roles are offered it, every read in the lease's own catalog, and its
                 db the lease's reader — this tenant's rows under the member's grants and row scope, read-only —
                 with its time and its result bounded. A support operator reads as the dealer it entered, ledgered
                 as the one read the request is, and is no account of the dealer's. */
              const account = (context.principal as { accountId?: unknown }).accountId;
              const loaded = await pageLoad({
                app: appSurfaceForRealm(app, pages, platform ? 'platform' : 'tenant').app,
                roles: context.principal.roles,
                signedIn: true,
                ...(onSupport || typeof account !== 'string' ? {} : { account }),
                loaders,
                body: input,
                reader: readAdapter(context),
                schema,
                ...(context.zone === undefined ? {} : { zone: context.zone }),
              });
              return { status: loaded.status, body: loaded.body };
            }
            // These replies consume the fresh lease context and its projected
            // catalog directly; resolving the served App/pages cannot change
            // them. Keep that pure projection for the routes that publish or
            // select from it below.
            if (path === '/api/runtime')
              return reply({
                appConfigured: true,
                active: app.id,
                apps: [{ id: app.id, name: app.name, writable: Boolean(context.capabilities?.writable.length) }],
              });
            if (path === '/api/pages/suggested')
              return reply({ appId: app.id, page: tenantSuggestedPage(schema, (asked.query ?? url.searchParams).get('table')!) });
            if (path === '/api/app' || path === '/api/pages') {
              /* The member's words and figures (readerLocale.ts): their own row's locale (else their pick in this
                 browser), their tenant's, the App's;
                 and the tenant's own words over the App's, read under this lease's scope (recordMessages.ts). */
              const wordsTenant = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              /* What the payload reads below waits on nothing of the rest — the tenant's locale and own words, the
                 record's or the tenant's saved branding, whether its assistant is switched on, its addresses — so
                 each is asked here at once and awaited where it is used, in the order it always was. One after
                 another they were a round trip each before a first page could draw. */
              const asked = <T>(work: () => Promise<T>): Promise<T> => {
                const pending = work();
                void pending.catch(() => {});
                return pending;
              };
              const forApp = path === '/api/app';
              const tenantDefaultAsked =
                typeof wordsTenant === 'string' && tenantBranding?.declaration.allow.includes('locale')
                  ? asked(async () => (await tenantBranding.state(wordsTenant).catch(() => undefined))?.value.locale)
                  : undefined;
              const tenantWordsAsked =
                typeof wordsTenant === 'string'
                  ? asked(() => readTenantMessages({ app, schema: context.schema, query: context.data.query, tenant: wordsTenant }))
                  : undefined;
              const brandingAsked = forApp
                ? asked(() =>
                    scopedRecordBranding({
                      app,
                      schema: context.schema,
                      data: context.data,
                      owner: enrollment,
                      source: ownership.source.id,
                      req,
                      publicly: false,
                      tenant: brandingTenant(req, app, url, platform ? undefined : context.principal.tenantId),
                    }),
                  )
                : undefined;
              /* A tenant's own branding, where the App lets its tenants brand it: the lease's tenant, never one the
                 request names. The platform realm keeps the App's brand; a support operator sees the dealer's. */
              const tenantId = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              const ownAsked =
                forApp && tenantBranding && typeof tenantId === 'string'
                  ? asked(async () =>
                      (await brandingAsked) ? undefined : tenantBranding.presentation(tenantId, { roles: context.principal.roles }),
                    )
                  : undefined;
              const offeredTo = app.assistant?.roles;
              const assistantAsked =
                forApp &&
                app.assistant !== undefined &&
                !platform &&
                !onSupport &&
                typeof tenantId === 'string' &&
                (!offeredTo || context.principal.roles.some((role: string) => offeredTo.includes(role))) &&
                assistantSwitch !== undefined
                  ? asked(() => assistantSwitch.offered(tenantId))
                  : undefined;
              /* The tenant's own addresses, for a link it hands out: every member of its own lease,
                 by the lease's tenant and never one the request names, read fresh so a rotation shows on the
                 next load. Never on the platform realm or a support session, which are not the tenant. */
              const addressesAsked =
                forApp && !platform && !onSupport && typeof tenantId === 'string' ? asked(() => enrollment.addresses(tenantId)) : undefined;
              const tenantDefault = await tenantDefaultAsked;
              const locale = resolveLocale({ person: context.locale ?? pickedLocale(app, req), tenant: tenantDefault, app: app.ui.locale });
              const tenantWords = await tenantWordsAsked;
              const metadata = projected(context, schema, locale, tenantWords);
              /* Where each custom component is served, for the page to load it the first time it is drawn. */
              const branding = await brandingAsked;
              const own = branding ? undefined : await ownAsked;
              const branded = metadata.app && withRecordBranding(metadata.app, branding ?? own);
              /* The App's catalog in this reader's words beside the components that say it (`useMessage`). */
              const catalog = components && Object.keys(components).length ? componentMessages(app, locale, tenantWords) : undefined;
              const shown = branded && components ? { ...branded, components, ...(catalog ? { messages: catalog } : {}) } : branded;
              /* The assistant is drawn only where its routes answer (tenantAssistant.ts): a tenant's own lease, a
                 role it is offered to, a model to talk to, and the tenant's switch on, read on every page load. Never
                 on the platform realm or a support session. */
              const keepAssistant =
                path === '/api/app' &&
                shown?.assistant !== undefined &&
                !platform &&
                !onSupport &&
                typeof tenantId === 'string' &&
                (!offeredTo || context.principal.roles.some((role: string) => offeredTo.includes(role))) &&
                assistantSwitch !== undefined &&
                (await (assistantAsked ?? assistantSwitch.offered(tenantId)));
              let served = shown;
              if (served?.assistant !== undefined && !keepAssistant) {
                const { assistant: _assistant, ...rest } = served;
                served = rest;
              }
              /* The fields a decision answers, where this member could accept one (granted its answer command): a
                 record reserves the suggestion's place, as a single App's payload does (http/appProjection.ts). On
                 the tenant's own lease only, where the decision routes answer. */
              const decided =
                path === '/api/app' && served && !platform && !onSupport && typeof tenantId === 'string'
                  ? servedDecisions(
                      enrollment,
                      app.id,
                      new Set(schema.tables.map((table) => table.id)),
                      appCommandGrants(app, context.principal.roles),
                    )
                  : undefined;
              if (served && decided) served = { ...served, decisions: decided };
              /* The screens over routes this lease already answers, offered on the same conditions those routes
                 check: every tenant's support sessions on a platform lease for a role granted `supportAudit`, and a
                 member's own API tokens on their tenant's lease. The shell never offers one the route would refuse. */
              if (served) {
                const supportAudit =
                  support !== undefined &&
                  platform &&
                  context.principal.roles.some((role: string) => app.auth?.roles?.[role]?.supportAudit === true);
                const apiTokens = tokens !== undefined && !platform && !onSupport;
                const addresses = await addressesAsked;
                served = {
                  ...served,
                  ...(supportAudit ? { supportAudit: true as const } : {}),
                  ...(apiTokens ? { apiTokens: true as const } : {}),
                  ...(addresses && Object.keys(addresses).length ? { addresses: { ...addresses } } : {}),
                };
              }
              return path === '/api/app'
                ? reply({
                    appId: app.id,
                    /* A greeting is said to the lease's own member, never to a support operator inside the tenant. */
                    app: served && greetReader(served, onSupport ? undefined : nameOf(req)),
                  })
                : reply({ appId: app.id, pages: metadata.pages });
            }
            if (path === '/api/inbox' || path === '/api/inbox/read' || path === '/api/inbox/email') {
              /* The lease's own inbox, as the lease's account: its tenant's, or
                 the platform realm's (tenantInbox.ts). A support operator inside
                 a tenant reads its rows, never its people's notices. */
              if (onSupport) return denyTenant();
              const tenantId = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              if (!platform && typeof tenantId !== 'string') return denyTenant();
              const session = await verified(req);
              const options = {
                app,
                reader: readAdapter(context),
                schema,
                who: session?.identity.who,
                registry: { store: enrollment.deployment.inbox, namespace: leaseInbox(app.id, tenantId as string | undefined) },
              };
              return reply(
                path === '/api/inbox'
                  ? await readInboxFor({ ...options, limit: input.limit, before: input.before, unread: input.unread })
                  : path === '/api/inbox/read'
                    ? await markInboxFor({ ...options, ids: input.ids, all: input.all })
                    : await inboxEmailFor({ ...options, email: input.email }),
              );
            }
            if (path === '/api/tokens' || path === '/api/tokens/issue' || path === '/api/tokens/revoke') {
              /* A member's own API tokens, on their tenant's lease: the
                 membership the lease admitted is the one a token binds, and
                 nothing the body says chooses another. Not in the platform
                 realm, and never for a support operator inside a tenant. */
              if (!tokens || platform || onSupport) return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
              const principal = context.principal as TenantMembershipEvidence;
              if (typeof principal.membershipId !== 'string' || typeof principal.accountId !== 'string') return denyTenant();
              try {
                if (path === '/api/tokens') return reply({ tokens: await tokens.list(principal), choices: tokens.choices(principal) });
                if (path === '/api/tokens/issue') return reply(await tokens.issue(principal, input));
                await tokens.revoke(principal, input.id);
                return reply({ revoked: true });
              } catch (error) {
                if (error instanceof TenantTokenRefusal)
                  return { status: error.status, body: { error: error.message, code: error.code, outcome: 'not_applied' } };
                throw error;
              }
            }
            if (path === '/api/branding' || path === '/api/branding/save') {
              /* The lease's tenant's branding, read by any member and saved only by the roles the App names as its
                 editors, in their own tenant. Not in the platform realm, and never by a support operator. */
              const tenantId = (context.principal as { tenantId?: unknown }).tenantId;
              if (!tenantBranding || platform || typeof tenantId !== 'string')
                return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
              const editor = !onSupport && context.principal.roles.some((role) => tenantBranding.declaration.editors.includes(role));
              /* The scope comes with the value, so the Branding form offers exactly what the App allows and previews it as the save will judge it. */
              const scope = { allow: tenantBranding.declaration.allow, themes: tenantBranding.declaration.themes };
              /* The saved value is `branding` on the wire: a service's result wrapper never becomes the envelope. */
              const said = ({ value, revision }: { value: unknown; revision: number }) => ({ branding: value, revision, editor, ...scope });
              if (path === '/api/branding') return reply(said(await tenantBranding.state(tenantId)));
              if (!editor)
                return {
                  status: 403,
                  body: { error: "Only this organization's admins may change its branding.", code: 'forbidden', outcome: 'not_applied' },
                };
              const session = await verified(req);
              if (!session) return denyTenant();
              try {
                const saved = await tenantBranding.save(
                  tenantId,
                  { value: input.branding, logo: input.logo, darkLogo: input.darkLogo },
                  session.identity.id,
                );
                return reply(said(saved));
              } catch (error) {
                if (error instanceof BrandingRefused)
                  return {
                    status: 422,
                    body: { error: error.message, errors: error.refusals, code: 'branding_refused', outcome: 'not_applied' },
                  };
                if (error instanceof LogoRefused)
                  return {
                    status: 422,
                    body: {
                      error: error.message,
                      errors: [{ field: 'logo', message: error.message }],
                      code: 'branding_refused',
                      outcome: 'not_applied',
                    },
                  };
                throw error;
              }
            }
            if (path === '/api/integrations' || path === '/api/integrations/save') {
              /* The lease's tenant's integrations: which secrets are set, never a value, read by any member and
                 saved only by the roles the jobs module names as its editors, in their own tenant. Not in the
                 platform realm, and never by a support operator: a dealer does not hold a tenant's keys. */
              const tenantId = (context.principal as { tenantId?: unknown }).tenantId;
              if (!integrationSettings || platform || typeof tenantId !== 'string')
                return { status: 404, body: { error: 'Not found.', code: 'not_found' } };
              const editor = !onSupport && context.principal.roles.some((role) => integrationSettings.editors.includes(role));
              if (path === '/api/integrations') return reply({ ...(await integrationSettings.read(tenantId)), editor });
              if (!editor)
                return {
                  status: 403,
                  body: {
                    error: "Only this organization's admins may change its integrations.",
                    code: 'forbidden',
                    outcome: 'not_applied',
                  },
                };
              const session = await verified(req);
              if (!session) return denyTenant();
              try {
                await integrationSettings.save(tenantId, session.identity.id, input);
              } catch (error) {
                if (error instanceof IntegrationSettingsRefusal)
                  return { status: 422, body: { error: error.message, code: 'integration_refused', outcome: 'not_applied' } };
                throw error;
              }
              return reply({ ...(await integrationSettings.read(tenantId)), editor });
            }
            if (path === '/api/record-activity') {
              /* A dashboard's feed. In a tenant's context the store reads that
                 tenant's rows of its tenant-owned resources alone (and the
                 platform's rows), so no other tenant's writes crowd it or reach
                 it; each record a row names is then read in this context, under
                 the owner this context is, before anything about it is said.
                 The platform realm's feed spans tenants, each record read as
                 the platform realm reads it (tenantRecordHistoryStore.ts). */
              const tenantId = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              if (!platform && typeof tenantId !== 'string') return denyTenant();
              const owned = Object.entries(ownership.ownership).flatMap(([resource, rule]) =>
                rule.kind === 'tenant' && ownership.resources[resource] !== undefined
                  ? [[ownership.resources[resource], rule.column] as const]
                  : [],
              );
              return reply(
                await readRecordActivityFor({
                  app,
                  pages,
                  reader: readAdapter(context),
                  schema,
                  ...(context.zone === undefined ? {} : { zone: context.zone }),
                  mapping: { connectionFor: () => app.id, toPhysical: (table) => ownership.resources[table] ?? denyTenant() },
                  open: async () => historyStore as unknown as Adapter,
                  storeKey: tenantHistoryStoreKey(ownership, tenantId as string | undefined),
                  ...(typeof tenantId === 'string'
                    ? {
                        owners: (physical: readonly string[]) => ({
                          tenant: tenantId,
                          columns: Object.fromEntries(owned.filter(([table]) => physical.includes(table))),
                        }),
                      }
                    : {}),
                  view: input.view,
                  section: input.section,
                  period: input.period,
                  now: new Date(now()),
                  roles: context.principal.roles,
                }),
              );
            }
            if (DECISION_PATHS.includes(path)) {
              /* A record's suggestions, as a single App serves them (http/decisionRoutes.ts), on this lease: the
                 rows its own tenant's decisions wrote, never another's — the owner is the lease's tenant, not
                 anything the request names — read through this context first, and only for a member granted
                 the decision's answer command. The platform realm decides nothing, and a support operator
                 inside a dealer is offered none. A record or row out of reach is the ordinary not-found, which
                 ends no context. */
              const tenantId = (context.principal as { tenantId?: unknown }).tenantId;
              const served = platform || onSupport || typeof tenantId !== 'string' ? undefined : decisionsServedBy(enrollment, app.id);
              if (path === '/api/record-decisions' || path === '/api/record-decisions/marks') tenantIdentifier(input.table);
              if (path === '/api/record-decisions') tenantRecord(input.key);
              const session = served && (path === '/api/record-decisions/settle' ? await verified(req) : undefined);
              try {
                return reply(
                  await answerDecisions(path, input, {
                    app,
                    served,
                    owner: { app: app.id, tenant: typeof tenantId === 'string' ? tenantId : '' },
                    reader: readAdapter(context),
                    schema,
                    roles: context.principal.roles,
                    by: session?.identity.who ?? '',
                  }),
                );
              } catch (error) {
                if (error instanceof AppAccessDenied) throw new TenantRequestFault(404, 'not_found');
                throw error;
              }
            }
            tenantRecord(input.key);
            if (path === '/api/record-history') {
              /* The record is read first, in this context and through its own
                 scope, as its page is; only then is the store asked, under the
                 key and the owner this context is (tenantRecordHistoryStore.ts). */
              tenantIdentifier(input.table);
              const tenantId = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              if (!platform && typeof tenantId !== 'string') return denyTenant();
              /* A record this context cannot read, or one whose page keeps no
                 history, is the ordinary not-found, as a decision's is. Let
                 out as the context's denial, it ended a session the person
                 still held: a record's head asks who changed it for any table
                 a live change names, and a write to one whose page shows no
                 history put up "Session unavailable" over a committed save. */
              const outOfReach = (error: unknown): never => {
                if (error instanceof AppAccessDenied) throw new TenantRequestFault(404, 'not_found');
                throw error;
              };
              return reply(
                await readRecordHistoryFor({
                  app,
                  pages,
                  reader: readAdapter(context),
                  schema,
                  mapping: { connectionFor: () => app.id, toPhysical: (table) => ownership.resources[table] ?? denyTenant() },
                  open: async () => historyStore as unknown as Adapter,
                  storeKey: tenantHistoryStoreKey(ownership, tenantId as string | undefined),
                  table: input.table,
                  key: input.key,
                  before: input.before,
                  limit: input.limit,
                }).catch(outOfReach),
              );
            }
            if (path === '/api/record-flows' || path === '/api/record-flows/start') {
              /* A record's flow runs, asked as its history is: the record is
                 read first, in this context; the runs are then those of the
                 tenant its stored key names (workflows/flowRuns.ts), which in
                 a tenant's context is that tenant and in the platform realm
                 the owner the row says. A manual start is a member's, in
                 their own tenant, never the platform realm's or a support
                 operator's: the run acts as that tenant's service. */
              tenantIdentifier(input.table);
              const tenantId = platform ? undefined : (context.principal as { tenantId?: unknown }).tenantId;
              if (!platform && typeof tenantId !== 'string') return denyTenant();
              const flows = {
                app,
                reader: readAdapter(context),
                schema,
                runs: flowRunsOf(app.id),
                table: input.table,
                key: input.key,
                roles: context.principal.roles,
                tenancy: {
                  storeKey: tenantHistoryStoreKey(ownership, tenantId as string | undefined),
                  tenantOf: (table: string, stored: Readonly<Record<string, unknown>>) => {
                    const rule = ownership.ownership[table];
                    const owner = rule?.kind === 'tenant' ? stored[rule.column] : undefined;
                    return typeof owner === 'string' && (platform || owner === tenantId) ? owner : denyTenant();
                  },
                },
              };
              try {
                if (path === '/api/record-flows') return reply(await readRecordFlowsFor(flows));
                if (platform || onSupport) return denyTenant();
                const session = await verified(req);
                return reply(await startRecordFlowFor({ ...flows, flow: input.flow, operator: session?.identity.who }));
              } catch (error) {
                // The route's own words (no runner, not a manual flow); a record out of reach stays a denial.
                if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
                throw error;
              }
            }
            if (path === '/api/references') {
              tenantIdentifier(input.table);
              return reply(await tenantReferences(readAdapter(context), schema, input.table, input.key as Record<string, string | number>));
            }
            const metadata = projectTenantMetadata(
              app,
              pages,
              schema,
              context.capabilities,
              context.principal.roles,
              platform ? 'platform' : 'tenant',
              context.zone,
            );
            tenantIdentifier(input.page, 1024);
            const page = (input.page as string).startsWith('suggested:')
              ? tenantSuggestedPage(schema, (input.page as string).slice('suggested:'.length))
              : metadata.pages.find((page) => page.id === input.page);
            if (!page) return denyTenant();
            const planned = await tenantPagePlan(
              readAdapter(context),
              schema,
              page,
              input.key as Record<string, string | number>,
              zonedNow(appZone(app.ui, context.zone), new Date(now())),
            );
            if (path === '/api/pages/plan') return reply(planned);
            /* A record page whole: its plan and every read its sections will
               ask, each asked through this route on this one context. */
            return reply(
              /* On the primary whole, related lists and all: a record is
                 where a person looks for what they saved (readRouting.ts). */
              await primaryReads(() =>
                /* Its reads leave together, on one snapshot: each on one of its own took a reader of the pool, a
                   BEGIN, a LOCK and a COMMIT apiece (a field report: 35 statements in 35 round trips). */
                together(context, () =>
                  composeTenantRecordPage({
                    schema,
                    planned,
                    key: input.key as Record<string, unknown>,
                    rows: input.rows,
                    tab: input.tab,
                    app: metadata.app,
                    ask: (part, given) => route(context, schema, part, given, { told: asked.told }),
                  }),
                ),
              ),
            );
          }
          if (path === FILE_READ_PATH) {
            /* A member reads its own tenant's objects; the platform realm, any tenant's of this App, as it reads their rows. */
            const tenantId = (context.principal as { tenantId?: unknown }).tenantId;
            if (!platform && typeof tenantId !== 'string') return denyTenant();
            return tenantFileRead(
              app,
              readAdapter(context),
              schema,
              input,
              platform ? { app: app.id, anyTenant: true } : { app: app.id, tenant: tenantId as string },
            );
          }
          /* A list's text filter on a searched field is asked of the engine
             within this context's tenant, then read here as any row is. The
             platform realm, which spans tenants, filters on the database. */
          const tenantId = (context.principal as { tenantId?: unknown }).tenantId;
          const reader =
            search && !platform && typeof tenantId === 'string'
              ? search.reader(readAdapter(context), schema, tenantId)
              : readAdapter(context);
          /* A list, a count, a breakdown may read a replica of the tenant's
             database, under the same membership and row scope (tenantReadSource.ts). */
          /* And each says which tables it answered from, as an App's own reads do (live/liveReads.ts): a member's
             page asks it again only when one of them changes, where without it every change asked every list,
             count and breakdown on the page. Only a member follows changes (the live route below). */
          const told = liveSyncOn() && app.live && !platform && !onSupport ? trackingReads(reader, schema, asked.told ?? res) : reader;
          const dispatch = () =>
            dispatchResourceReadHttp(path as ResourceHttpPath, input, told, schema, {
              app: APP_READS,
              now: () => zonedNow(appZone(app.ui, context.zone), new Date(now())),
              weekStart: localeWeekStart(app.ui.locale),
              me: () => tenantPerson(context, schema),
            });
          const result = await (toleratesLag(path, input) ? lagTolerantReads(dispatch) : dispatch());
          if (!result) return denyTenant();
          return result;
        };
        if (path === '/api/pages/compose' && !composeInputValid(input)) return invalid();
        /* A computed column that says `me` is this reader's: their session is
           asked only where one does, since asking it costs a store read. */
        const readerEmail = computedSaysMe ? ((await verified(req))?.identity.who ?? null) : null;
        /* A composed record page without its `checks`, and with which of its verbs the record offers: advice,
           asked as its own request asks it (the command's footprint, in one read snapshot), once the page's
           reads are in. A refusal leaves them to the page. */
        const withVerbs = async (value: unknown): Promise<unknown> => {
          if (!value || typeof value !== 'object' || !('checks' in value)) return value;
          const { checks, ...composed } = value as {
            checks: Array<{ command: string; commandVersion: number; keys: unknown[] }>;
            reads: unknown[];
          };
          if (!checks.length) return composed;
          const asked = { checks };
          try {
            const verbs = await (platform
              ? contexts.availabilityPlatform(req, expected, asked, { signal: controller.signal })
              : contexts.availability(req, selectors, expected, asked, { signal: controller.signal }));
            return {
              ...composed,
              reads: [...composed.reads, { path: '/api/commands/availability', body: asked, status: 200, reply: verbs.value }],
            };
          } catch {
            /* The page asks its verbs itself. */
            return composed;
          }
        };
        if (path === TENANT_BOOT_PATH) {
          /* The page's first reads in one (shared/tenantBoot.ts), on the one context this request holds: the
             runtime, the App, its pages and its schema, each as its own request is answered, and then the room
             the address opens, planned as an ordinary App's first page plans it (http/firstPaintRooms.ts) and
             each read asked through the route its own request reaches. Each answer is keyed by that request as
             the tenant transport sends it, and only a success is carried: anything else, the page asks itself
             and hears in its own words. Asked with `reads` instead, it is a batch of the page's own reads asked in
             one moment past its first (shared/tenantBoot.ts `tenantBatchRequest`): those, and nothing planned. */
          const batch = input.reads === undefined ? undefined : (tenantBatchRequest(input) ?? invalid());
          const page = batch ? undefined : (tenantBootRequest(input, app.id) ?? invalid());
          const leaseTenant = platform ? PLATFORM_TENANT_ID : selectors[0];
          const keyOf = (method: 'GET' | 'POST', target: string, body?: Record<string, unknown>) =>
            readKey(method, tenantReadAddress(target, app.id, leaseTenant), tenantReadBody(body));
          const following = liveSyncOn() && app.live && !platform;
          /* Every read on one snapshot of the one context, as a composed page's are (tenantReadSource.ts `together`). */
          const reading = within((context) =>
            together(context, async () => {
              const schema = tenantServedSchema(context, app, new Date(now()), readerEmail);
              const answers: FirstPaintData['reads'] = {};
              const itemAnswers: FirstPaintData['items'] = {};
              /* One read, as its own request would be gated and answered; a request fault (a bad question, a
               record not found) is that read's alone and leaves the context standing. */
              /* Each timed as a part of the request where server timing is on (serverTiming.ts), by its route alone. */
              const one = (target: string, body: Record<string, unknown> | undefined) =>
                timedPart(
                  `read.${new URL(target, 'http://mistri.invalid').pathname.replace(/^\/api\//, '').replace(/[^a-z0-9-]+/gi, '.')}`,
                  () => answerOne(target, body),
                );
              const answerOne = async (target: string, body: Record<string, unknown> | undefined) => {
                const address = new URL(target, 'http://mistri.invalid');
                const at = address.pathname;
                const given = tenantReadBody(body) ?? {};
                const query = new URLSearchParams(address.search);
                query.delete('app');
                const getting = at === '/api/schema' || metadataGets.has(at);
                if (
                  at === TENANT_BOOT_PATH ||
                  !(getting || reads.has(at) || metadataPosts.has(at)) ||
                  getting !== (body === undefined) ||
                  [...query.keys()].some((key) => at !== '/api/pages/suggested' || key !== 'table') ||
                  (at === '/api/pages/suggested' && query.getAll('table').length !== 1) ||
                  (at === '/api/pages/compose' && !composeInputValid(given))
                )
                  return undefined;
                try {
                  if (!getting) tenantRecord(given, fields[at]);
                } catch {
                  return undefined;
                }
                const told = new ReadsTold();
                try {
                  const reply = await route(context, schema, at, given, { query, told });
                  return carriable(reply) ? { body: reply.body, reads: following ? told.value : undefined } : undefined;
                } catch (error) {
                  /* A refusal in the read's own words is the read's: the page asks it and hears them. One that is
                   the context's ends the boot, as it would have ended the read. */
                  if (error instanceof TenantRequestFault || error instanceof HttpError) return undefined;
                  throw error;
                }
              };
              const carry = (key: string, answer: { body: unknown; reads?: string } | undefined) => {
                if (answer) answers[key] = { body: answer.body, ...(answer.reads === undefined ? {} : { reads: answer.reads }) };
                return answer?.body;
              };
              /* Each read asked once, however many plans name it: the room is planned twice below. */
              const asking = new Map<string, Promise<unknown>>();
              const ask = (method: 'GET' | 'POST', target: string, body?: Record<string, unknown>) => {
                const key = keyOf(method, target, body);
                let answer = asking.get(key);
                if (!answer) asking.set(key, (answer = one(target, body).then((read) => carry(key, read))));
                return answer;
              };
              if (batch) {
                await Promise.all(batch.map((read) => ask(read.method, read.path, read.body)));
                return { reads: answers, items: itemAnswers };
              }
              const plannedRoom = bootRoom(ask, one, (kind, key, body) => {
                itemAnswers[itemKey(kind, app.id, key)] = { body };
              });
              /** The reads the room at the page's address asks, planned from `payload`. */
              const askRoom = (payload: AppPayloadApp, pages: RoomInput['pages']) =>
                plannedRoom({ app: app.id, path: page!.path, search: page!.search, payload, schema, pages, me: {}, visitor: false });
              /* The room's reads leave with the App's rather than after them. Its plan needs the App's payload, and
                 what that payload reads — the tenant's words and locale, its branding, its assistant's switch, its
                 addresses — moves no read the room asks; so the room is planned first from the App as this context
                 is offered it in the App's own words, and those reads are asked at once. Planned again from the
                 payload the page is answered with, anything that plan names and the first did not is asked then: the
                 answer is never short of a read the page will ask. A read only the first named is answered unused. */
              let early: Promise<unknown> = Promise.resolve();
              try {
                const projection = projected(
                  context,
                  schema,
                  resolveLocale({ person: context.locale ?? pickedLocale(app, req), tenant: undefined, app: app.ui.locale }),
                  undefined,
                );
                if (projection.app)
                  early = askRoom(projection.app as unknown as AppPayloadApp, { pages: projection.pages as RoomInput['pages']['pages'] });
              } catch {
                /* Planned once, from the payload. */
              }
              void early.catch(() => {});
              const [, payload, pageList] = await Promise.all([
                ask('GET', '/api/runtime'),
                ask('GET', '/api/app'),
                ask('GET', '/api/pages'),
                ask('GET', '/api/schema'),
                /* The bell's count (InboxBell.tsx), where the App keeps an inbox: drawn with the bar, it would
                 otherwise be one more round after the page's. */
                appKeepsInbox(app) && enrollment.deployment.inbox !== undefined ? ask('POST', '/api/inbox', { limit: 1 }) : undefined,
              ]);
              const appPayload = (payload as { app?: AppPayloadApp } | undefined)?.app;
              await Promise.all([appPayload && pageList ? askRoom(appPayload, pageList as RoomInput['pages']) : undefined, early]);
              return { reads: answers, items: itemAnswers };
            }),
          );
          /* Entered, a boot that fails is the boot's alone: the lease is open and the page's, so it is answered
             with discovery's, and the page asks its boot itself on it and hears why in that request's words. */
          const booted = entering ? await reading.catch(() => undefined) : await reading;
          if (!booted) {
            assertActive();
            if (req.aborted || res.destroyed) return denyTenant();
            return send(req, res, 200, { ...entering!.found, entered: { context: entering!.lease } }, ownerHeaders(entering!.lease));
          }
          /* A record page's verbs, as its own compose request would have carried them. */
          const carried = Object.fromEntries(
            await Promise.all(
              Object.entries(booted.value.reads).map(async ([key, read]) =>
                key.startsWith('POST /api/pages/compose?') ? [key, { ...read, body: await withVerbs(read.body) }] : [key, read],
              ),
            ),
          ) as FirstPaintData['reads'];
          assertActive();
          if (req.aborted || res.destroyed) return denyTenant();
          const boot = { reads: carried, items: booted.value.items };
          if (entering)
            return send(req, res, 200, { ...entering.found, entered: { context: booted.context, boot } }, ownerHeaders(booted.context));
          return send(req, res, 200, boot, ownerHeaders(booted.context));
        }
        const result = await within(async (context) =>
          route(context, tenantServedSchema(context, app, new Date(now()), readerEmail), path, input),
        );
        let value = result.value.body;
        if (path === '/api/pages/compose') value = await withVerbs(value);
        const failure =
          result.value.status >= 400 ||
          (value &&
            typeof value === 'object' &&
            ('error' in value || ('errors' in value && Array.isArray(value.errors) && value.errors.length > 0)));
        // The read is ledgered here: after the body exists, and before a byte of
        // it is released. The entry commits in its own short writer transaction,
        // and this await is what makes the ledger a precondition of the answer
        // rather than a note taken alongside it — if the commit fails, the throw
        // reaches the handler below and the operator is told the read was
        // refused. A read that cannot be ledgered is refused, never truncated.
        if (onSupport && !failure) {
          // The ledger's own failure is not repeated to the caller: it is the
          // owner's, and may name its store. What the operator is told is that
          // the read was refused, with the one public code.
          try {
            await support!.ledgerRead(req, {
              tenantId: result.context.tenantId,
              supportId: result.context.supportId!,
              detail: { path, ...(suggested ? { table: url.searchParams.get('table')! } : {}) },
            });
          } catch {
            throw new TenantSupportUnledgered();
          }
          assertActive();
          if (req.aborted || res.destroyed) return denyTenant();
        }
        return send(req, res, result.value.status, value, failure ? {} : ownerHeaders(result.context));
      }
      /* Who a write is, for the record history its transaction keeps
         (tenantRecordHistoryStore.ts): the verified session's account, never a
         request's word, and a command's writes under its action's label. Its
         name is the sign-in store's for that same proof, as the greeting's is:
         a history kept without one said "Someone". */
      const session = await verified(req);
      const name = session ? nameOf(req) : undefined;
      const attributed = <T>(work: () => Promise<T>, action?: string): Promise<T> =>
        attributeWrites({ via: 'app', ...(session ? { actor: session.identity.who, ...(name ? { name } : {}) } : {}) }, () =>
          attributeAction(action, work),
        );
      if (commands.has(path)) {
        const execution = { signal: controller.signal };
        const result = await attributed(
          async () =>
            platform
              ? path.endsWith('/availability')
                ? await contexts.availabilityPlatform(req, expected, input, execution)
                : path.endsWith('/prepare')
                  ? await contexts.preparePlatform(req, expected, input, execution)
                  : path.endsWith('/status')
                    ? await contexts.statusPlatform(req, expected, input, execution)
                    : await contexts.executePlatform(req, expected, input, execution)
              : path.endsWith('/availability')
                ? await contexts.availability(req, selectors, expected, input, execution)
                : path.endsWith('/prepare')
                  ? await contexts.prepare(req, selectors, expected, input, execution)
                  : path.endsWith('/status')
                    ? await contexts.status(req, selectors, expected, input, execution)
                    : await contexts.execute(req, selectors, expected, input, execution),
          commandActionLabel(app, input),
        );
        completedWrite = path.endsWith('/execute');
        return send(req, res, 200, result.value, ownerHeaders(result.context));
      }
      /* The platform realm's generic edit is Save, New and Delete on its own rows, judged by its
         lease's own catalog and grants. Import, Undo and an upload are not part of it: a bulk load, a replay
         across tenants and a file under a tenant's prefix each have no platform answer, so they are refused. */
      if (platform && (path === '/api/import' || path === '/api/revert' || path === FILE_UPLOAD_PATH)) return invalid(403);
      const writeContext = <T>(run: (context: TenantReadContext | PlatformReadContext) => T | Promise<T>) =>
        platform
          ? contexts.withPlatformContext(req, expected, (context: PlatformReadContext) => run(context))
          : contexts.withContext(req, selectors, expected, (context: TenantReadContext) => run(context));
      if (path === '/api/import') {
        const imported = await tenantImport(req, selectors, expected, input, attributed, controller.signal);
        if (imported.refused) return send(req, res, imported.refused.status, { error: imported.refused.message });
        return send(req, res, 200, imported.report, ownerHeaders(imported.context!));
      }
      /* A record's lines (formLinesWrite.ts), judged on the lease's own catalog and grants; each row is then
         written in the record's transaction as this member could write it alone (tenantRecordHistory.ts). */
      let lines: LineCollection[] | undefined;
      if (path === '/api/insert' && input.lines !== undefined) {
        const judged = (
          await writeContext((context) => {
            const schema = tenantServedSchema(context, app, new Date(now()));
            const granted = (child: string) => context.capabilities?.resources[child];
            return judgeLines(
              {
                app,
                schema,
                refused: (child) => (granted(child)?.insertable ? undefined : 'This App does not add these lines here.'),
              },
              typeof input.table === 'string' ? findTable(schema, input.table)?.id : undefined,
              input.lines,
            );
          })
        ).value;
        if ('error' in judged) return send(req, res, judged.status, { error: judged.error });
        lines = judged.lines;
      }
      if (path === '/api/update') {
        const values = input.values ?? (typeof input.column === 'string' ? { [input.column]: input.value ?? null } : {});
        const change = {
          table: input.table,
          key: input.key,
          values,
          ...(input.expected === undefined ? {} : { expected: input.expected }),
        } as UpdateRequest;
        const result: { value: { result: UpdateResult; undoId?: string }; context: TenantContextReply } = await attributed(
          () => (platform ? contexts.updatePlatform(req, expected, change) : contexts.update(req, selectors, expected, change)),
          updateActionLabel(app, input.table, values),
        );
        completedWrite = true;
        return sendResource(
          req,
          res,
          path,
          {
            affected: result.value.result.affected,
            applied: shownWrite(app, input.table, result.value.result.applied),
            ...(result.value.undoId === undefined ? {} : { undoId: result.value.undoId }),
          },
          result.context,
        );
      }
      /* A file into a file resource: the upload read as the single-App host reads it (http/fileRows.ts), then
         an insert like any other on this lease — the tenant stamped, the member's grants held, its history kept
         without the bytes (an image of a row with a file in it is not kept: tenantInverseImages.ts). */
      let inserted = { table: input.table, values: input.values, ...(lines ? { lines } : {}) } as unknown as InsertRequest;
      let placed: Awaited<ReturnType<typeof placeFile>> | undefined;
      if (path === FILE_UPLOAD_PATH) {
        const { schema, tenantId } = (
          await contexts.withContext(req, selectors, expected, (context) => ({
            schema: tenantServedSchema(context, app, new Date(now())),
            tenantId: (context.principal as { tenantId?: unknown }).tenantId,
          }))
        ).value;
        const table = findTable(schema, typeof input.table === 'string' ? input.table : '');
        const rule = table ? appFileRules(app, schema).rules.get(table.id) : undefined;
        const upload = uploadValues(rule && { ...rule, maxBytes: Math.min(rule.maxBytes, TENANT_FILE_MOST) }, input);
        if ('error' in upload) return send(req, res, upload.status, { error: upload.error });
        if (typeof tenantId !== 'string') return denyTenant();
        /* Into the bucket under this tenant's prefix before the row is written (files/fileStorage.ts). */
        try {
          placed = await placeFile(rule!, upload.values, { app: app.id, tenant: tenantId });
        } catch (error) {
          const trouble = fileStoreTrouble(error, 'stored');
          if (!trouble) throw error;
          return send(req, res, 503, { error: trouble });
        }
        inserted = { table: table!.id, values: placed.values } as InsertRequest;
      }
      if (path === '/api/insert' || path === FILE_UPLOAD_PATH) {
        const insert = (): Promise<{ value: { result: InsertResult; undoId?: string }; context: TenantContextReply }> =>
          attributed(() =>
            platform ? contexts.insertPlatform(req, expected, inserted) : contexts.insert(req, selectors, expected, inserted),
          );
        const result = placed ? await writePlaced(placed, insert) : await insert();
        completedWrite = true;
        return sendResource(
          req,
          res,
          '/api/insert',
          {
            key: result.value.result.key,
            applied: shownWrite(app, input.table, result.value.result.applied),
            ...(result.value.result.row === undefined ? {} : { row: shownWrite(app, input.table, result.value.result.row) }),
            ...(result.value.undoId === undefined ? {} : { undoId: result.value.undoId }),
          },
          result.context,
        );
      }
      if (path === '/api/delete') {
        if (input.confirm !== undefined && typeof input.confirm !== 'boolean') return invalid();
        const target = { table: input.table, key: input.key } as Parameters<typeof contexts.remove>[3];
        if (input.confirm !== true) {
          const result = platform
            ? await contexts.previewRemovePlatform(req, expected, target)
            : await contexts.previewRemove(req, selectors, expected, target);
          return sendResource(req, res, path, result.value, result.context);
        }
        const result: { value: { result: { affected: number }; undoId?: string }; context: TenantContextReply } = await attributed(() =>
          platform ? contexts.removePlatform(req, expected, target) : contexts.remove(req, selectors, expected, target),
        );
        completedWrite = true;
        return sendResource(
          req,
          res,
          path,
          {
            impact: [],
            deleted: true,
            ...result.value.result,
            ...(result.value.undoId === undefined ? {} : { undoId: result.value.undoId }),
          },
          result.context,
        );
      }
      if (input.confirm !== undefined && typeof input.confirm !== 'boolean') return invalid();
      if (input.expectedId !== undefined && typeof input.expectedId !== 'string') return invalid();
      if (input.confirm === true) {
        const result = await attributed(() => contexts.undo(req, selectors, expected, { expectedId: input.expectedId as string }), 'Undo');
        completedWrite = true;
        return sendResource(req, res, '/api/revert', result.value, result.context);
      }
      const result = await contexts.preview(req, selectors, expected, input.limit === undefined ? {} : { limit: input.limit as number });
      return sendResource(req, res, '/api/revert', { reverted: false, ...result.value }, result.context);
    };
    void work()
      .catch((error) => {
        // A support refusal: nothing ran, and the reply says which support rule
        // refused — business work not being available on this lease, or the
        // account being inside a dealer while another tab asked to act as the
        // platform. Both are plain, and neither says anything private.
        if (tenantSupportRefused(error)) {
          const refusal = tenantSupportRefusal(error);
          return send(req, res, 403, {
            error: refusal.message,
            code: refusal.code,
            outcome: 'not_applied',
            ...(path === '/api/delete' ? { deleted: false } : path === '/api/revert' ? { reverted: false } : {}),
          });
        }
        const leaseCode = tenantLeaseFailureCode(error);
        if (leaseCode) {
          // Keep a post-commit/receipt-uncertain result uncertain. Renewing access
          // never makes replaying the business operation safe.
          const outcome =
            error instanceof BusinessCommandExecutionError || error instanceof TenantWriteFailure
              ? error.outcome
              : completedWrite
                ? 'unknown'
                : undefined;
          return send(req, res, 409, {
            error: 'The selected tenant lease must be renewed before continuing.',
            code: leaseCode,
            ...(outcome === undefined ? {} : { outcome }),
            ...(path === '/api/delete'
              ? { deleted: outcome === 'unknown' ? null : false }
              : path === '/api/revert'
                ? { reverted: false }
                : {}),
          });
        }
        if (commands.has(path) || path.startsWith('/api/commands/')) {
          const failure = businessCommandHttpError(
            error instanceof BusinessCommandExecutionError || error instanceof AppAccessDenied
              ? error
              : new BusinessCommandExecutionError(
                  error instanceof InvalidRequest ? 'invalid_input' : databaseUnanswered(error) ? 'temporarily_unavailable' : 'forbidden',
                  'unknown',
                ),
            path.endsWith('/status'),
          );
          reportRefusal(req, failure.status, failure.body.code, failure.body.message, error);
          return send(req, res, failure.status, failure.body);
        }
        if (writes.has(path)) {
          const unknown = completedWrite || (error instanceof TenantWriteFailure && error.outcome === 'unknown');
          if (!unknown && databaseUnanswered(error)) {
            const failure = unansweredWrite(path);
            reportRefusal(req, failure.status, 'temporarily_unavailable', String(failure.body.error), error, true);
            return send(req, res, failure.status, failure.body);
          }
          /* The App's rules refused the record: the same rejected envelope a
             plain App answers (dataWriteRoutes.ts), so the form keeps the
             draft and marks the fields. Names and fixed sentences only. */
          if (
            !unknown &&
            error instanceof TenantWriteFailure &&
            error.fields?.length &&
            (path === '/api/insert' || path === '/api/update')
          ) {
            const message = 'The record does not satisfy the application rules.';
            reportRefusal(req, 200, 'validation_failed', message, error);
            return send(req, res, 200, { errors: [{ code: 'validation_failed', message, fields: error.fields }], outcome: 'rejected' });
          }
          const outcome = unknown ? 'unknown' : path === '/api/revert' ? 'not_applied' : 'rejected';
          const message = unknown
            ? 'The change could not be confirmed. Refresh and reconcile before trying again.'
            : (refusalSaid(error) ?? 'The change is unavailable under the current permissions or record state.');
          reportRefusal(req, unknown ? 503 : 403, unknown ? 'write_unconfirmed' : 'forbidden', message, error);
          return send(req, res, unknown ? 200 : error instanceof InvalidRequest ? error.status : 403, {
            error: message,
            errors: [{ code: unknown ? 'write_unconfirmed' : 'forbidden', message }],
            outcome,
            ...(path === '/api/delete' ? { deleted: unknown ? null : false } : path === '/api/revert' ? { reverted: false } : {}),
          });
        }
        /* The database failing to answer a read — a statement it refused, a
         lock, a dropped connection — decided nothing about the tenant, and
         answering it as a denial told the browser its tenant context was gone:
         one bad count in a menu blanked the whole shell. It is the 503 the
         unavailable error exists for; a denial stays a 403. Either way the
         operator hears why (refusalReport.ts), and the caller does not. */
        /* Neither of these says anything about the context, and answering
         either as its denial ended a session the person still held: a record
         page for another customer's address, or a read the client asked
         wrongly (a label path where a view belongs). The first is the
         ordinary not-found, said the same for a missing record; the second
         is the request's fault, and says no more than that. */
        /* Every context the account holds is in use (tenantContexts.ts): not
           a denial, so not its words. The person is told to finish or close a
           tab, and the operator always hears it, which the opaque refusal
           never let them. */
        if (error instanceof TenantContextsBusy) {
          reportRefusal(req, 429, error.code, error.message, error, true);
          return send(req, res, 429, { error: error.message, code: error.code });
        }
        if (error instanceof TenantRequestFault) {
          reportRefusal(req, error.status, error.code, error.message, error);
          return send(req, res, error.status, { error: error.message, code: error.code });
        }
        const unavailable = error instanceof TenantUnavailableError || (!(error instanceof TenantContextError) && databaseFault(error));
        const failure = unavailable ? new TenantUnavailableError() : new TenantContextError();
        const status = error instanceof InvalidRequest ? error.status : unavailable ? 503 : 403;
        reportRefusal(req, status, failure.code, failure.message, error, !(error instanceof TenantContextError));
        return send(req, res, status, { error: failure.message, code: failure.code });
      })
      .catch(() => {
        if (!res.destroyed) res.destroy();
      })
      .finally(() => {
        req.off('aborted', abort);
        res.off('close', abort);
        if (!liveStreams.has(res)) expectedAccounts.delete(req);
        accepted.delete(req);
        pending.delete(held);
        finish();
      });
  });
  // The probes and the dev observer's address, and a span per request, as the App server has (http/server.ts).
  platformRequests(server, (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    return probe(req, res, path) || observerRoute(req, res, new URL(req.url ?? '/', 'http://localhost'));
  });
  /* Outermost, so a request's timing covers every listener above (serverTiming.ts); nothing when off. */
  timeRequests(server);
  applyServerTimeouts(server);
  const close = server.close.bind(server);
  const retire = tenantRetirement(
    [
      contexts.retire,
      async () => {
        const stopped = new Promise<void>((resolve, reject) =>
          close((error) => {
            if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
            else resolve();
          }),
        );
        void stopped.catch(() => {});
        endLiveStreams(liveStreams, 'stopping');
        for (const req of accepted) if (!req.complete) req.destroy();
        await Promise.allSettled([...pending]);
        await stopped;
      },
    ],
    [enrollment.retire],
  );
  return Object.freeze({
    server,
    retire(): Promise<void> {
      retired = true;
      closeRecordBranding(enrollment);
      return retire();
    },
  });
}
