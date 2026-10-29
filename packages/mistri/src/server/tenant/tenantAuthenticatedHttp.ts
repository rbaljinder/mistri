import { dirname } from 'node:path';
import { namedTenants } from './tenantNames.js';
import { createTenantBrandingService, brandingLogoHeaders, BRANDING_LOGO_PATH } from './tenantBranding.js';
import { readsAs } from '@mistriwork/engine/adapters/replicas.js';
import { readFreshness } from '@mistriwork/engine/server/http/readRouting.js';
import { MemoryCacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';
import type { BrandingPresentation } from '../http/recordBranding.js';
import {
  APP_FLAG_VALUES_PATH,
  EXPERIMENT_EXPOSURES_PATH,
  EXPERIMENT_VISITOR_PATH,
  EXPERIMENT_FORM_HEADER,
} from '../../shared/appFlagValues.js';
import { experimentPublicSelection } from '../experiments/publicSelection.js';
import { flagHttpRequest } from '../flags/httpRuntime.js';
import { applyServerTimeouts } from '@mistriwork/engine/server/serverTimeouts.js';
import { platformRequests, routedPath, servedApp } from '@mistriwork/engine/server/http/traceRequest.js';
import { routeAddress } from '@mistriwork/engine/server/http/serverCore.js';
import { arrivedUrls } from '@mistriwork/engine/server/http/context.js';
import { appHome, mountJson, NO_MOUNT, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import {
  appFaceHead,
  groundsOf,
  lookDensityFor,
  lookFacesFor,
  lookGroundsFor,
  lookSchemeFor,
  lookSheetsFor,
} from '@mistriwork/engine/server/clientSurface.js';
import { observerHome, observerMounted } from '../observe/mount.js';
import { appLook } from '../../shared/appUi.js';
import { withIconGlyphs } from '../app/iconPayload.js';
import { requestLocale } from '../app/readerLocale.js';
import { probe } from '@mistriwork/engine/server/http/probes.js';
import { embedBoot } from '../embed/boot.js';
import { observerRoute } from '../observe/mount.js';
import type { TestControl } from '../http/testControl.js';
import { signInOf, isPublicForm, type AppDef } from '../../shared/app.js';
import { createServer, validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import { LOADED_APP_KEYS, type LoadedApp } from '../app/apps.js';
import {
  authHoldsOwnProof,
  captureAppAuthRuntime,
  captureNativeDisplayName,
  signInInfo,
  type AppAuthRuntime,
  type VerifiedSessionInstance,
} from '../auth/auth.js';
import { appTenantDirectories, bindTenantDirectories } from '../auth/scimDirectory.js';
import { nativeAccountEmailOf, nativeMailAccount } from '../auth/authAccounts.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { doorRefusal, writes, type Bound, type ProxyRange } from '@mistriwork/engine/server/http/trust.js';
import { setBaselineHeaders } from '@mistriwork/engine/server/http/baselineHeaders.js';
import { embedDoor } from '../embed/crossOrigin.js';
import { TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import {
  captureTenantAdministrationEnrollment,
  captureTenantEnrollment,
  createTenantEnrollment,
  type TenantEnrollmentOptions,
} from './tenantEnrollment.js';
import { openTenantAdministration, type TenantAdministration } from './tenantAdministration.js';
import { tenantClonePlan } from './tenantClonePlan.js';
import { openTenantSupport, type TenantSupport } from './tenantSupportOperations.js';
import { SUPPORT_REFUSAL_CODES } from '../../shared/tenantSupport.js';
import { createTenantAdministrationHttp, isTenantAdministrationHttpRequest } from './tenantAdministrationHttp.js';
import {
  ADMINISTRATION_HTTP_HEADER,
  type AdministrationMembershipPageRequest,
  type AdministrationPageRequest,
} from '../../shared/tenantAdministration.js';
import { INVITATION_HTTP_HEADER } from '../../shared/tenantInvitations.js';
import { createTenantInvitationHttp, isTenantInvitationHttpRequest } from './tenantInvitationHttp.js';
import { createTenantHttpServer, tenantHttpBinding, tenantHttpHeader } from './tenantHttp.js';
import type { PageLoader } from '../commands/pageLoaders.js';
import { challengesOf, namedChallenge } from '../commands/challenges.js';
import { tenantPublicChoices } from './tenantPublicChoices.js';
import { openTenantJobHost, tenantDecisionProviders, tenantMailRuntime } from './tenantJobs.js';
import { openTenantMail, type TenantMail } from './tenantMail.js';
import { openTenantNoticeMail } from './tenantNoticeMail.js';
import { appSendsEmail } from '../email/outbox.js';
import { appEmailsContacts, openContactMail, type ContactMail } from '../email/contactMail.js';
import { UNSUBSCRIBE_PATH } from '../email/unsubscribe.js';
import { contactEmailFindings } from '../integrations/integrationChecks.js';
import { openTenantIntegrations, type TenantIntegrations } from './tenantIntegrations.js';
import type { JobHost } from '../jobs/jobHost.js';
import { tenantRetirement } from './tenantRetirement.js';
import { createTenantPublicHttp, isTenantPublicPath } from './tenantPublicHttp.js';
import { tenantPublicPlacement } from './tenantPublicPlacement.js';
import { publicHome } from '../../shared/appHome.js';
import { keepsRoles, roleLabelsOf } from '../../shared/appModel.js';
import { withTenantApiRequests } from './tenantApiRequest.js';
import type { AppHost } from '../app/apps.js';
import { createTenantApiOwner, tenantApiScopeCatalog } from '../api/tenantApiReadOwner.js';
import { createTenantTokenService } from './tenantTokenService.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { openTenantSearch, type TenantSearch } from './tenantSearch.js';
import { createAppMcpHttp } from '../api/appMcpHttp.js';
import { answerOAuthWellKnown, bearerChallenge, bindOAuthTenancy } from '../auth/oauthResource.js';
import { tenantAppMcpCommands, tenantAppMcpReads } from '../api/appMcpSession.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { createApiReadHandoffHttp } from '../api/postgresApiReadHttp.js';
import { createApiCommandHttp } from '../api/apiCommandHttp.js';
import { apiAdmission } from '../api/apiHttpAdmission.js';
import { createApiPublicSpec, renderAppApiOpenApi } from '../api/apiPublicSpec.js';
import { serveClient, shellEgress, type SocialHead } from '@mistriwork/engine/server/clientHttp.js';
import { CLIENT_FILES } from '../clientFiles.js';
import { formHead, landingHead } from '../http/publicHead.js';
import { requestOrigin } from '@mistriwork/engine/server/http/requestOrigin.js';
import { cardRequest, SHARE_CARD_PATH, sendShareCard, shareCard, shareCardImage } from '../http/shareCard.js';
import { outward } from '@mistriwork/engine/shared/mount.js';
import { componentHrefs } from '../app/appComponents.js';
import { publicComponentIds } from '../../shared/appComponentPlaces.js';
import { appKeepsInbox } from '../../shared/appNotify.js';
import { tenantComponentRoute } from '../http/componentRoutes.js';
import { fontRoute } from '../http/fontRoutes.js';
import { brandRoute } from '../http/brandRoutes.js';
import { attachDevClient, closeDevClientHmr, SOURCE_CLIENT, retireDevClient } from '@mistriwork/engine/server/devclient.js';
import { endAdmissionSession, noteAdmissionSession } from './tenantAdmissionCache.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { baseRecordBranding } from '../http/recordBranding.js';
import { createSuiteLinkAccess } from './suiteLinkAccess.js';
import { createTenantAssistant, type TenantAssistant } from './tenantAssistant.js';
import { captureSuiteFlagAccess, captureSuiteFlagScopeProof, captureSuiteFlagScopes } from './suiteFlagAccess.js';
import { tenantFilesSweep } from './tenantFilesSweep.js';
import { wearing, type TenantLook } from './tenantLook.js';
import { createTenantPublicReadHttp } from './tenantPublicReadHttp.js';
import { isPublicReadRequest } from '../../shared/tenantPublicReads.js';
import { publicAddress } from './tenantPublicRead.js';
import type { TenantAddresses } from './tenantIntakeModel.js';
import { emailConfigOf, emailOf, webhookConfigOf } from '../serviceConnections.js';
import { timeRequests } from '@mistriwork/engine/adapters/telemetry/serverTiming.js';

type EnrollmentOptions = Omit<TenantEnrollmentOptions<IncomingMessage>, 'app' | 'pages' | 'verifySession'>;
interface TenantAuthenticatedHttpOptions {
  readonly loaded: LoadedApp;
  /** Already opened by the host. This factory never migrates or provisions auth. */
  readonly auth: AppAuthRuntime;
  readonly enrollment: EnrollmentOptions;
  readonly bound: Bound;
  /** Serve the shared client in the dedicated enrolled tenant host. */
  readonly browser?: true;
  /** The suite listener owns source-client HMR when false. */
  readonly sourceClient?: false;
  /** `--api-reads`: the App API on loopback beside the browser, over this
   * deployment's own tenant API owner, with explicit integers and budget. */
  /** `network`: the operator listens beyond loopback, and the App declares
   * `api.network`. `trustedProxies`: whose X-Forwarded-For names the client
   * an address budget is charged to (`--trust-proxy`). */
  readonly api?: Readonly<{
    integers: 'decimal-string' | 'number';
    requestsPerMinute: number;
    network?: true;
    trustedProxies?: readonly ProxyRange[];
  }>;
  /** `--trust-proxy`: whose X-Forwarded-For names a signed-out visitor's address on the public forms and reads — the
      per-client budgets and the address the human check is told. Absent, the socket's peer is the client. */
  readonly trustedProxies?: readonly ProxyRange[];
  /** Where the App is mounted and the base path it is served under (shared/mount.ts); the root when absent. */
  readonly mount?: AddressMount;
  /** The host's registry, for the App's search connection alone (tenantSearch.ts) and its email service (tenantMail.ts,
      tenantNoticeMail.ts): never the data's. */
  readonly registry?: Registry;
  /** The public origin people reach this host by: where a signed mail link starts. */
  readonly publicURL?: string;
  /** A test host's setup (http/testControl.ts): present only in a process startTestApp started, never in a deployment. */
  readonly testControl?: TestControl;
}
class AuthRequestRefusal extends Error {
  constructor(readonly status: number) {
    super('The authentication request is unavailable.');
  }
}
const refuse = (status = 400): never => {
  throw new AuthRequestRefusal(status);
};
const ownedAuth = new WeakSet<AppAuthRuntime>();

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(json),
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}

/** One dedicated host composes native authentication with the existing tenant
 * transport. The captured data listener is invoked directly, never over another
 * network request. Its unlistened server remains the data-operation owner;
 * only this outer listener is exposed. Browser files require explicit opt-in;
 * public CLI startup enters through tenantStartup, never ordinary createApp. */
export async function createTenantAuthenticatedHttpServer(options: TenantAuthenticatedHttpOptions) {
  let enrollment: Awaited<ReturnType<typeof createTenantEnrollment<IncomingMessage>>> | undefined;
  let data: ReturnType<typeof createTenantHttpServer> | undefined;
  let administration: TenantAdministration | undefined;
  let support: TenantSupport | undefined;
  let claimedAuth: AppAuthRuntime | undefined;
  let apiOwner: Awaited<ReturnType<typeof createTenantApiOwner>> | undefined;
  let jobHost: JobHost | undefined;
  let retentionTimer: { stop(): void } | undefined;
  let filesSwept = false;
  let search: TenantSearch | undefined;
  let tenantAssistant: TenantAssistant | undefined;
  let mail: TenantMail | undefined;
  let integrations: TenantIntegrations | undefined;
  let noticeMail: ReturnType<typeof openTenantNoticeMail<IncomingMessage>> | undefined;
  let contactMail: ContactMail | undefined;
  /* The look a save changed in place (tenantLook.ts, G175): worn by the shell, the App payload, its faces and its public pages. */
  let look: TenantLook | undefined;
  try {
    const raw = tenantOptions(options, [
      'loaded',
      'auth',
      'enrollment',
      'bound',
      'browser',
      'api',
      'mount',
      'sourceClient',
      'registry',
      'publicURL',
      'testControl',
      'trustedProxies',
    ]);
    if (raw.trustedProxies !== undefined && !Array.isArray(raw.trustedProxies)) return denyTenant();
    /* The public doors' boundary: the host's, with the proxies whose forwarded address names a visitor, as the App API's
       is given its own (`api.trustedProxies`); the tenant binding itself takes none. */
    const publicBound: Bound = {
      ...(raw.bound as Bound),
      ...((raw.trustedProxies as readonly ProxyRange[] | undefined)?.length
        ? { trustedProxies: captureTenantData(raw.trustedProxies) as readonly ProxyRange[] }
        : {}),
    };
    if (Object.hasOwn(raw, 'testControl') && typeof (raw.testControl as TestControl | undefined)?.handle !== 'function')
      return denyTenant();
    const testControl = raw.testControl as TestControl | undefined;
    if (Object.hasOwn(raw, 'browser') && raw.browser !== true) return denyTenant();
    if (Object.hasOwn(raw, 'sourceClient') && raw.sourceClient !== false) return denyTenant();
    const browser = raw.browser === true;
    const sourceClient = browser && SOURCE_CLIENT && raw.sourceClient !== false;
    // `build` is admitted because a tenant App served from a `mistri build`
    // output carries it (apps.ts) — production is exactly the case a tenant
    // App is built for, and leaving it off this list refused every built
    // tenant deployment with a message that named nothing. `components` is
    // the App's compiled custom components (appComponents.ts): code served
    // to a signed-in reader, never a row.
    // Handlers belong to enrollment, not to the browser/auth metadata snapshot.
    const metadata = tenantOptions(raw.loaded, LOADED_APP_KEYS);
    /* A page's loaders are code beside the commands, so they are not data to capture: they are handed to the
       data server as they are, which holds each one by its own check (tenantHttp.ts capturedLoaders). */
    const pageLoaders = metadata.loaders;
    /* The App's human checks are code too: held apart, each one defineChallenges made, and the one `auth.challenge`
       names asked by every tenant's public doors (tenantPublicHttp.ts). One check for the App — its secret is the
       deployment's, in the verifier — never a tenant's, and never in anything a tenant or a visitor is sent. */
    const challenges = metadata.challenges === undefined ? undefined : challengesOf({ challenges: metadata.challenges }, 'commands');
    const loaded = captureTenantData({
      ...metadata,
      commands: undefined,
      loaders: undefined,
      challenges: undefined,
    }) as unknown as LoadedApp;
    tenantIdentifier(loaded.path, 32768);
    tenantRecord(loaded.app);
    const challenge = namedChallenge(loaded.app.auth?.challenge, challenges, loaded.path);
    if (!Array.isArray(loaded.pages)) return denyTenant();
    const auth = captureAppAuthRuntime(raw.auth as AppAuthRuntime);
    if (loaded.app.id !== auth.appId || !isDeepStrictEqual(signInOf(loaded.app.auth), signInOf(auth.spec))) return denyTenant();
    const binding = tenantHttpBinding(raw.bound);
    // `platformSources` travels with the source it belongs to: an App that
    // declares one is refused without it (tenantEnrollment's capture).
    const input = tenantOptions(raw.enrollment, [
      'policy',
      'source',
      'platformSources',
      'deployment',
      'roles',
      'maxLifetimeMs',
      'commands',
      'jobs',
      'now',
      'supportAuditKey',
    ]) as unknown as EnrollmentOptions;
    auth.assertCurrent();
    const signIn = captureTenantData(signInInfo(raw.auth as AppAuthRuntime, loaded.app.name));
    // Reserve before acquisition yields: two successful hosts must not each
    // believe they can close the same native store beneath the other's work.
    if (ownedAuth.has(raw.auth as AppAuthRuntime)) return denyTenant();
    claimedAuth = raw.auth as AppAuthRuntime;
    ownedAuth.add(claimedAuth);
    /* One tenant request asks for its session at every fence it crosses, a
       dozen times and more. The cookie cannot change within a request, so
       the token's resolution to a session (Better Auth's getSession, which
       skips its cookie cache here) is looked up once per request object and
       kept only as long as that object lives. Every call, first or not,
       observes the session row and its account (`assertSessionCurrent`, and
       `observeSession` on PostgreSQL), which refuses one that ended, was
       shortened or impersonated, or whose account is banned. The file store
       is read in place each time; a PostgreSQL store's answer may be one
       read a few seconds ago, kept until anything in this process writes the
       store (authStoreReads.ts): a sign-out here is seen by the next
       observation, one elsewhere within MISTRI_AUTH_SESSION_CACHE. Only a
       proof is kept, never a signed-out answer. */
    const resolved = new WeakMap<IncomingMessage, VerifiedSessionInstance>();
    // Both adapters derive from the same captured strong method.
    const verify = async (request: IncomingMessage) => {
      // Presentation-only storefront routing never resolves a native proof,
      // including whoami and any static component's private-code check.
      if (getTenantHostIntent(request)) return null;
      const kept = resolved.get(request);
      let proof: VerifiedSessionInstance | null = kept ?? null;
      /* A kept proof crosses no await before `assertSessionCurrent`, which
         asserts the runtime current on both sides of its own check, so only
         a fresh resolution needs fencing here. */
      if (!kept) {
        auth.assertCurrent();
        proof = await auth.sessionInstance(request);
        auth.assertCurrent();
        if (proof) resolved.set(request, proof);
      }
      if (proof) auth.assertSessionCurrent(proof);
      // A PostgreSQL auth store is read here, at the verifier's last await:
      // on admission, and again after a write's callback, before its COMMIT.
      if (proof && !auth.synchronous) {
        await auth.observeSession(proof);
        auth.assertCurrent();
      }
      // Which login this request was verified as: what kept admissions are keyed by (tenantAdmissionCache.ts).
      noteAdmissionSession(request, proof ? proof.sessionId : null);
      return captureTenantData(proof);
    };
    // One verifier for the one deployment: a browser request's session, or an
    // App API request's own native token observation (tenantApiRequest.ts).
    enrollment = await createTenantEnrollment({
      ...input,
      app: loaded.app,
      pages: loaded.pages,
      verifySession: withTenantApiRequests<IncomingMessage>(async (request) => (await verify(request))?.identity ?? null),
      // A notice to a person (a tenant App's people hold account ids) is kept at the account's email.
      accountEmail: (accountId: string) => nativeAccountEmailOf(raw.auth as AppAuthRuntime, accountId),
    });
    auth.assertCurrent();
    binding();
    const { clock: now } = captureTenantEnrollment(enrollment);
    const administrationOptions = captureTenantAdministrationEnrollment(enrollment);
    // A tenant's own SCIM directory writes that tenant's member rows through this owner (auth/scimDirectory.ts).
    const directories = appTenantDirectories(raw.auth as AppAuthRuntime);
    if (administrationOptions) {
      // Support has its own owner and writer; administration never sees its policy.
      const { support: supportPolicy, supportAuditKey: key, ...administrationOnly } = administrationOptions;
      if (administrationOnly.policy || administrationOnly.invitations) {
        const held = captureTenantEnrollment(enrollment);
        const clone = tenantClonePlan(held.app, held.ownership, input.policy);
        administration = await openTenantAdministration({
          ...administrationOnly,
          auth: raw.auth as AppAuthRuntime,
          // The App's assistant has a per-tenant switch, set here.
          ...(loaded.app.assistant ? { assistant: true as const } : {}),
          // So does each provider the App's decisions ask (setTenantDecisions).
          ...((providers) => (providers ? { decisions: providers } : {}))(tenantDecisionProviders(enrollment)),
          // The App marks resources clone: a tenant's owner clones it into a sandbox, and approves its import, here.
          ...(clone ? { clone } : {}),
          ...(Object.keys(directories).length ? { directories } : {}),
        });
      }
      if (supportPolicy) {
        support = await openTenantSupport({
          ...(administrationOnly.path === undefined ? { url: administrationOnly.url } : { path: administrationOnly.path }),
          binding: administrationOnly.binding,
          auth: raw.auth as AppAuthRuntime,
          app: loaded.app,
          policy: supportPolicy,
          key: key ?? denyTenant(),
          deployment: administrationOnly.deployment,
          now: administrationOnly.now,
        });
      }
    }
    if (Object.keys(directories).length) {
      const owner = administration?.directory;
      if (!owner) {
        throw new Error(
          `the SCIM directory "${Object.keys(directories)[0]}" manages a tenant's members, and "${loaded.app.id}" administers no tenants' members: give its tenant policy (defineAppTenantPolicy) "administration" or "invitations".`,
        );
      }
      bindTenantDirectories(raw.auth as AppAuthRuntime, (name, accountId, roles) => owner(name).apply(accountId, roles));
    }
    auth.assertCurrent();
    binding();
    // The deployment's one job host, when enrolled with jobs: opened (its
    // stores attested again) now, started once the listener is up.
    /* With it, each tenant's bucket objects no row names are swept daily, one tenant to a run (tenantFilesSweep.ts). */
    const captured = captureTenantEnrollment(enrollment);
    const builtIn = tenantFilesSweep(loaded.app, captured.ownership, captured.source);
    jobHost = await openTenantJobHost(enrollment, {
      ...(builtIn.length ? { builtIn } : {}),
      source: captured.source,
      ...(input.policy.decisions ? { decisionPolicy: input.policy.decisions } : {}),
      ...(loaded.authority
        ? { decisionsDirectory: dirname(loaded.authority.lockPath) }
        : loaded.dir
          ? { decisionsDirectory: loaded.dir }
          : {}),
    });
    filesSwept = Boolean(jobHost && builtIn.length);
    /* An App with no jobs opens no job host, so nothing would schedule its retention: the same job runs on its own timer. */
    if (!jobHost) {
      const { retentionJob, retentionPrunes, startRetentionTimer } = await import('../retention.js');
      const { storeTargetOf } = await import('../commands/appCommandEvents.js');
      const target = storeTargetOf('path' in captured.source ? captured.source.path : captured.source.url);
      if (target && retentionPrunes(loaded.app.retention)) {
        retentionTimer = startRetentionTimer(
          retentionJob({ ...(loaded.app.retention ? { retention: loaded.app.retention } : {}), targets: [target] }),
        );
      }
    }
    auth.assertCurrent();
    binding();
    const brandingRegistry = raw.registry as Registry | undefined;
    /* Each tenant's branding, where the App declares it: kept in the deployment's own store, copied in the
       deployment's shared cache (Valkey when the config names one), so a save on one instance is the next
       page on every other. */
    const branding = loaded.app.branding
      ? createTenantBrandingService({
          app: loaded.app,
          store: enrollment.deployment.branding,
          cache: brandingRegistry ? brandingRegistry.cache() : new MemoryCacheStore(),
        })
      : undefined;
    /* The jobs module's mail: the webhook and link routes now, the send loop once the job host starts.
       Its settings and transport are the config's email service, never the App's. */
    const mailRuntime = tenantMailRuntime(enrollment);
    if (mailRuntime) {
      const jobsRegistry = raw.registry as Registry | undefined;
      const service = jobsRegistry && emailConfigOf(jobsRegistry);
      if (!service) throw new Error('The jobs module declares mail, and the config names no email service ("kind": "email").');
      const base = raw.mount === undefined ? '' : (raw.mount as AddressMount).base;
      mail = await openTenantMail({
        runtime: mailRuntime,
        service,
        baseURL: `${String(raw.publicURL ?? `http://localhost`).replace(/\/+$/, '')}${base}`,
        cache: (raw.registry as Registry).cache(),
        ...(branding ? { branding } : {}),
        // Its secrets resolve where its connections do: a suite App's own environment, not the process's.
        ...((raw.registry as Registry).environment ? { environment: (raw.registry as Registry).environment } : {}),
      });
    }
    auth.assertCurrent();
    binding();
    /* Notices that are emailed too (`notify` with `email: true`): sent after each write commits, from the outbox
       beside each tenant's inbox, each read as its recipient's own membership (tenantNoticeMail.ts). Started
       with the job host's loops; the transport is the config's email service, never the App's. */
    if (appSendsEmail(loaded.app)) {
      const noticeRegistry = raw.registry as Registry | undefined;
      const transport = noticeRegistry && emailOf(noticeRegistry);
      if (!transport)
        throw new Error(`${loaded.app.name}: a notify rule says email: true, and the config names no email service ("kind": "email").`);
      noticeMail = openTenantNoticeMail<IncomingMessage>({
        loaded,
        deployment: enrollment.deployment,
        account: (email) => nativeMailAccount(raw.auth as AppAuthRuntime, email),
        transport,
        baseURL: String(raw.publicURL ?? `http://localhost`),
        ...(raw.mount === undefined ? {} : { mount: captureTenantData(raw.mount) as AddressMount }),
        names: enrollment.names,
      });
    }
    /* Effects and integrations: deliveries after commit, the signed webhooks, the channels and the settings
       screen's secrets (tenantIntegrations.ts). Opened now, their loops started with the job host. */
    {
      const registry = raw.registry as Registry | undefined;
      const base = raw.mount === undefined ? '' : (raw.mount as AddressMount).base;
      integrations = await openTenantIntegrations({
        enrollment,
        webhookConfig: (name) => registry && webhookConfigOf(registry, name),
        webhookBase: `${String(raw.publicURL ?? `http://localhost`).replace(/\/+$/, '')}${base}`,
      });
    }
    auth.assertCurrent();
    binding();
    /* Mail to an address a record holds (`notify.via` email): each tenant's write queued it beside that tenant's
       records, one loop over the deployment's source decides and sends it under that tenant's own opt-out, consent
       and caps, and the link that stops it — its token naming the tenant — is answered under this deployment's
       mount (email/contactMail.ts). Started with the job host's loops. */
    if (appEmailsContacts(loaded.app)) {
      const registry = raw.registry as Registry | undefined;
      const service = registry && emailConfigOf(registry);
      const findings = contactEmailFindings(loaded.app, {
        email: service ? { links: Boolean(service.links?.secret) } : undefined,
        ...(loaded.commands ? { commands: loaded.commands.registry } : {}),
      });
      for (const warning of findings.warnings) console.warn(`mistri: warning: ${warning}`);
      if (findings.problems.length) throw new Error(`${loaded.app.name}: ${findings.problems[0]}`);
      const base = raw.mount === undefined ? '' : (raw.mount as AddressMount).base;
      contactMail = await openContactMail({
        apps: [
          {
            id: loaded.app.id,
            name: loaded.app.name,
            target: 'path' in captured.source ? { sqlite: captured.source.path } : { postgres: captured.source.url },
          },
        ],
        transport: emailOf(registry!)!,
        // A reference, read where the deployment's connections are: a suite App's own environment, else the process's.
        secret: expandEnvReferences(service!.links!.secret, registry!.environment),
        address: `${String(raw.publicURL ?? `http://localhost`).replace(/\/+$/, '')}${base}${UNSUBSCRIBE_PATH}`,
      });
    }
    auth.assertCurrent();
    binding();
    const components = componentHrefs(loaded.app.id, loaded.components);
    /* The components a signed-out visitor's public pages and public forms draw, and their files: served to a visitor too. */
    const visitorComponents = publicComponentIds(loaded.app, loaded.pages);
    const visitorFiles = new Set(
      Object.entries(loaded.components?.entries ?? {})
        .filter(([id]) => visitorComponents.has(id))
        .flatMap(([, entry]) => [entry.js, ...(entry.css ? [entry.css] : [])]),
    );
    const visitorHrefs =
      components && visitorComponents.size
        ? Object.fromEntries(Object.entries(components).filter(([id]) => visitorComponents.has(id)))
        : undefined;
    // A member's own API tokens, wherever the App declares an API: issued here, used wherever it is served.
    // An API this deployment cannot serve (no command registry for its commands) offers no tokens either.
    let tokens: ReturnType<typeof createTenantTokenService> | undefined;
    if (loaded.app.api) {
      try {
        tokens = createTenantTokenService({
          loaded,
          catalog: tenantApiScopeCatalog(enrollment),
          now: Date.now,
          ...(administrationOptions?.policy ? { administration: administrationOptions.policy } : {}),
        });
      } catch {
        tokens = undefined;
      }
    }
    // Search, where the App declares it and a search provider is plugged in: the index follows this deployment's writer.
    const registry = raw.registry as Registry | undefined;
    search = registry
      ? openTenantSearch({
          registry,
          app: loaded.app,
          ownership: captureTenantEnrollment(enrollment).ownership,
        })
      : undefined;
    /* The reader's own name, for a dashboard's "Hello, {me.name}": the sign-in
       store's, read off the proof this request was verified by. A store that
       keeps none (or a name that is not one line) greets nobody. */
    let names: ReturnType<typeof captureNativeDisplayName> | undefined;
    try {
      names = captureNativeDisplayName(raw.auth as AppAuthRuntime);
    } catch {
      names = undefined;
    }
    const readerName = (request: IncomingMessage): string | undefined => {
      const proof = resolved.get(request);
      if (!proof || !names) return undefined;
      try {
        return names.displayName(proof);
      } catch {
        return undefined;
      }
    };
    data = createTenantHttpServer({
      app: loaded.app,
      look: () => look,
      enrollment,
      verifySessionInstance: verify,
      readerName,
      bound: raw.bound as Bound,
      ...(support ? { support } : {}),
      ...(components ? { components } : {}),
      ...(pageLoaders === undefined ? {} : { loaders: pageLoaders as Readonly<Record<string, PageLoader>> }),
      ...(tokens ? { tokens } : {}),
      ...(search ? { search } : {}),
      ...(branding ? { branding } : {}),
      ...(integrations?.settings ? { integrations: integrations.settings } : {}),
      // Asked once the assistant below exists; it is made on this server's own listener.
      ...(loaded.app.assistant
        ? {
            assistant: {
              offered: (tenantId: string) => tenantAssistant?.offered(tenantId) ?? Promise.resolve(false),
            },
          }
        : {}),
    });
    const listeners = data.server.listeners('request');
    if (listeners.length !== 1) return denyTenant();
    const dispatchData = listeners[0] as (req: IncomingMessage, res: ServerResponse) => void;
    /* The in-App assistant (tenantAssistant.ts): its store beside the tenant source, attested now where a model is
       set up, and its conversations purged past the platform owner's retention while the host runs. */
    if (loaded.app.assistant) {
      const held = captureTenantEnrollment(enrollment);
      tenantAssistant = createTenantAssistant({
        app: loaded.app,
        dispatch: dispatchData,
        binding,
        where: held.source,
        ...(held.assistant ? { policy: held.assistant } : {}),
        now,
      });
      await tenantAssistant.attest();
      auth.assertCurrent();
      binding();
      tenantAssistant.start();
    }
    // The App API: the ordinary transports' admission, routes and statuses, over this deployment's own owner — its reader and writer,
    // never a second connection. Commands mount first, as createApp mounts
    // them; the read transport keeps the rest of the namespace.
    let api:
      | {
          reads: ReturnType<typeof createApiReadHandoffHttp>;
          commands?: ReturnType<typeof createApiCommandHttp>;
          mcp: ReturnType<typeof createAppMcpHttp>;
        }
      | undefined;
    if (raw.api !== undefined) {
      const chosen = tenantOptions(raw.api, [
        'integers',
        'requestsPerMinute',
        'network',
        'trustedProxies',
      ]) as TenantAuthenticatedHttpOptions['api'] & object;
      if (chosen.network !== undefined && (chosen.network !== true || loaded.app.api?.network !== true))
        throw new Error('The App API serves beyond loopback only for an App whose api declares network: true.');
      const owner = (apiOwner = await createTenantApiOwner({
        enrollment,
        auth: raw.auth as AppAuthRuntime,
        integers: chosen.integers,
      }));
      const apiHost = Object.freeze({
        app: loaded,
        auth: raw.auth,
        pages: [],
      }) as unknown as AppHost;
      const routing = owner.routing;
      const transport = {
        bound: {
          ...(raw.bound as Bound),
          ...(chosen.trustedProxies?.length
            ? {
                trustedProxies: captureTenantData(chosen.trustedProxies) as readonly ProxyRange[],
              }
            : {}),
        },
        integers: chosen.integers,
        requestsPerMinute: chosen.requestsPerMinute,
        admission: apiAdmission(chosen.requestsPerMinute, {
          network: chosen.network === true,
        }),
        ...(loaded.app.api?.publicSpec
          ? {
              publicSpec: createApiPublicSpec(async () => ({
                from: routing,
                document: () =>
                  renderAppApiOpenApi(loaded.app, routing.schema, {
                    integers: chosen.integers,
                    ...(routing.registry ? { commands: routing.registry } : {}),
                    evidence: routing.evidence,
                    tenant: {
                      reads: routing.reads,
                      ...(routing.commands ? { commands: routing.commands } : {}),
                    },
                  }),
              })),
            }
          : {}),
      };
      const reads = createApiReadHandoffHttp(apiHost, transport, async () => owner);
      const commands = loaded.app.api?.commands.length
        ? createApiCommandHttp(apiHost, transport, {
            acquire: async () => owner,
            async deliver(active, kind, credential, envelope, signal, write) {
              const send = (
                answer: Readonly<{
                  status: number;
                  headers?: Readonly<Record<string, string>>;
                  body: string;
                }>,
              ) =>
                write({
                  status: answer.status,
                  headers: answer.headers ?? {},
                  body: answer.body,
                });
              await (kind === 'spec'
                ? active.readSpec(credential, send)
                : kind === 'prepare'
                  ? active.prepare(credential, envelope, send, signal)
                  : kind === 'recover'
                    ? active.recover(credential, envelope, send, signal)
                    : active.execute(credential, envelope, send, signal));
            },
          })
        : undefined;
      // Ready before listening: a transport that cannot acquire refuses startup.
      await reads.prepare();
      await commands?.prepare();
      /* The same API as MCP tools over HTTP, for an agent that speaks MCP
         over the network rather than stdio: one owner, one token, the same
         admission. Mounted before the reads, which claim the namespace. */
      const mcp = createAppMcpHttp({
        appId: loaded.app.id,
        version: loaded.app.api!.version,
        bound: transport.bound,
        admission: transport.admission,
        app: loaded.app,
        session: {
          version: runtimeVersion(),
          app: loaded.app,
          schema: routing.schema,
          integers: chosen.integers,
          deliver: tenantAppMcpReads(owner),
          tenant: {
            reads: routing.reads,
            ...(routing.commands ? { commands: routing.commands } : {}),
          },
          ...(routing.commands
            ? {
                commands: {
                  registry: routing.registry!,
                  evidence: routing.evidence,
                  deliver: tenantAppMcpCommands(owner),
                },
              }
            : {}),
        },
        // A refused bearer names the authorization server an agent can get one from, where the deployment has one.
        challenge: (presented: boolean) => bearerChallenge(raw.auth, 'mcp', presented),
      });
      api = { reads, mcp, ...(commands ? { commands } : {}) };
    }
    let retired = false;
    const pending = new Set<Promise<void>>(),
      accepted = new Set<IncomingMessage>();
    const active = () => {
      if (retired) return denyTenant();
      auth.assertCurrent();
    };
    /* The authorization server's view of this App's memberships (auth/oauthServer.ts): the tenants a signed-in
       person may consent for, as the host's chooser finds them, and one membership read now by account, where a
       code is exchanged or a grant refreshed with no session at all. Only an active membership of an active tenant. */
    if (loaded.app.api) {
      const observeMember = captureSuiteFlagAccess(enrollment, active);
      const enrolled = enrollment;
      bindOAuthTenancy(raw.auth as AppAuthRuntime, {
        async tenants(req) {
          active();
          const found = await enrolled.discover(req);
          active();
          if (found.status !== 'ready' || !found.memberships.length) return [];
          const ids = found.memberships.map((membership) => membership.tenantId);
          const named = await enrolled.names(ids);
          active();
          return ids.map((id) => (Object.hasOwn(named, id) ? { id, name: named[id] } : { id }));
        },
        async membership(accountId, tenantId) {
          const observed = await observeMember({ appId: loaded.app.id, environment: 'oauth', tenantId }, accountId);
          if (!observed) return null;
          const record = observed.record;
          if (
            record.appId !== loaded.app.id ||
            record.accountId !== accountId ||
            !('tenantId' in record) ||
            record.tenantId !== tenantId ||
            record.status !== 'active' ||
            record.tenantStatus !== 'active' ||
            !(record.validUntil > now())
          )
            return null;
          observed.assertCurrent();
          return Object.freeze({
            tenantId,
            membershipId: record.membershipId,
            membershipVersion: record.membershipVersion,
            roles: Object.freeze([...record.roles]),
          });
        },
      });
    }
    const dispatchAdministration = createTenantAdministrationHttp({
      appId: loaded.app.id,
      administration,
      bound: raw.bound as Bound,
      assertActive: active,
      names: enrollment.names,
    });
    const dispatchInvitations = createTenantInvitationHttp({
      appId: loaded.app.id,
      invitations: administration?.invitations,
      bound: raw.bound as Bound,
      assertActive: active,
      names: enrollment.names,
    });
    // The landing and public forms: the only data a signed-out visitor reaches here.
    const deployment = enrollment.deployment;
    const addressesOf = enrollment.addresses;
    const home = publicHome(loaded.app);
    const mount: AddressMount = raw.mount === undefined ? NO_MOUNT : (captureTenantData(raw.mount) as AddressMount);
    /* A mapped host's public pages wear its tenant's branding: the host names the tenant there, and these pages
       show only what that tenant chose to publish about its look — never a member's private presentation. */
    const hostBranding = async (req: IncomingMessage) => {
      const host = getTenantHostIntent(req);
      return branding && host && host.app === loaded.app.id
        ? branding.presentation(host.tenant, { private: false, public: true })
        : undefined;
    };
    /* A tenant's own intake address, by which this App's mapped host places a public form and a page's flags. */
    const hostAddress = deployment.intake ? async (tenant: string) => ((await addressesOf(tenant)) as TenantAddresses).intake : undefined;
    const dispatchPublic = createTenantPublicHttp({
      app: loaded.app,
      ...(loaded.components ? { components: loaded.components } : {}),
      ...(challenge ? { challenge } : {}),
      /* A form's choices from a table, read for the tenant its address or mapped host places it with, as that tenant's
         visitor reads them (`auth.public`), and kept per tenant. */
      ...(deployment.intake && deployment.publicReads && deployment.withPublicFlagIntake
        ? {
            choices: tenantPublicChoices({
              app: loaded.app,
              ownership: captured.ownership,
              ...(captured.registry ? { commands: captured.registry } : {}),
              withPublicContext: deployment.withPublicContext,
              intakeTenant: (form, address) => deployment.withPublicFlagIntake!(form, address, async (owner) => owner.tenantId),
            }),
          }
        : {}),
      /* A mapped host places a form by its tenant's own intake address, so the read, the submission and every step
         land where the host says, through the intake's one resolution and fence. */
      ...(hostAddress ? { hostAddress } : {}),
      look: () => look,
      ...(branding ? { branding: (req: IncomingMessage) => hostBranding(req) } : {}),
      bound: publicBound,
      assertActive: active,
      basePath: mount.base,
      ...(deployment.intake ? { submit: deployment.submitIntake, resume: deployment.resumeIntake } : {}),
    });
    /* A visitor's reads (`auth.public`): placed with one tenant by its public
       address (`?via=`) or by this App's mapped host, and answered by the
       deployment's public owner — never a session, a lease or a membership. */
    const dispatchPublicReads = deployment.publicReads
      ? createTenantPublicReadHttp({
          app: loaded.app,
          pages: loaded.pages,
          withPublicContext: deployment.withPublicContext,
          bound: publicBound,
          now,
          assertActive: active,
          ...(branding
            ? {
                branding: (tenantId: string) => branding.presentation(tenantId, { private: false, public: true }),
              }
            : {}),
          ...(search ? { search } : {}),
          ...(pageLoaders === undefined ? {} : { loaders: pageLoaders as Readonly<Record<string, PageLoader>> }),
          ...(visitorHrefs ? { components: visitorHrefs } : {}),
        })
      : undefined;
    /* This App's own mapped host, which names the tenant a visitor there reads. */
    const mappedHost = (req: IncomingMessage) => {
      const host = getTenantHostIntent(req);
      return host && host.app === loaded.app.id ? host : undefined;
    };
    /* Whether this request is a visitor's read: an address it carries, or this App's mapped host, on a read's route. */
    const visitorRead = (req: IncomingMessage, path: string, url: URL) =>
      dispatchPublicReads !== undefined &&
      isPublicReadRequest(req.method, path) &&
      (url.searchParams.has('via') || mappedHost(req) !== undefined);
    /* Each page's address in its inside form (`/{app}/…`), as the reserved
       routes read it before the handler (shared/mount.ts). */
    const insidePaths = new WeakMap<IncomingMessage, string>();
    /* What each page says of itself before the client boots: where it is
       mounted, so the client reads and writes its addresses by the server's
       rule (client addressMount.js); the App's name, which the tab shows
       from the first byte; and the observer, when one runs. */
    /* The landing's card: the App's landing in the host tenant's published look, never a member's (hostBranding). */
    const landingCard = (path: string, hosted: BrandingPresentation | undefined) => {
      const head = landingHead(loaded.app, path, hosted?.value.content.name ?? loaded.app.name);
      if (!head?.headline || !head.site) return undefined;
      const summary = head.page?.description?.slice(0, 300);
      const card = shareCard({
        site: head.site,
        title: head.headline,
        ...(summary ? { summary } : {}),
        ui: worn().ui,
        ...(hosted ? { branding: hosted } : {}),
      });
      return card && { head, card, summary };
    };
    /* What a link preview reads of the landing (clientHttp.ts socialMeta), as the ordinary host says it (handler.ts socialHead). */
    const landingSocial = async (req: IncomingMessage, path: string, hosted: BrandingPresentation | undefined) => {
      const landing = landingCard(path, hosted);
      const origin = landing && requestOrigin(req, raw.bound as Bound);
      if (!landing || !origin) return {};
      const image = await shareCardImage(origin, mount, path, landing.card).catch(() => undefined);
      const social: SocialHead = {
        url: origin + outward(mount, path),
        title: landing.card.title,
        site: landing.card.site,
        type: 'website',
        ...(landing.summary ? { description: landing.summary } : {}),
        ...(image ? { image, imageAlt: landing.card.title } : {}),
      };
      return { canonical: outward(mount, path), social };
    };
    // Dressed once per look, not per page: wearing copies the App.
    let dressed: { look: TenantLook | undefined; app: AppDef } = { look: undefined, app: loaded.app };
    const worn = () => (dressed.look === look ? dressed.app : (dressed = { look, app: wearing(loaded.app, look) }).app);
    const shell = (path: string, hosted?: BrandingPresentation, req?: IncomingMessage) => ({
      ...(egress ? { egress } : {}),
      /* A public form's page is titled by its form, as the ordinary host titles it (http/publicHead.ts);
         every other page by the tenant's name. */
      title:
        formHead(
          loaded.app,
          /* A root-mounted host's inside address omits the App's segment; the head reads it with. */
          path.startsWith(`/${loaded.app.id}/`) ? path : `/${loaded.app.id}${path}`,
          hosted?.value.content.name ?? loaded.app.name,
        )?.title ??
        hosted?.value.content.name ??
        loaded.app.name,
      // A navigation has no admitted tenant read context. Selectors and host
      // intent alone must never resurrect a previous tenant's presentation:
      // only a mapped host's public branding, which its sign-in page wears.
      branding: hosted ?? baseRecordBranding(loaded.app, null, true),
      mount: { base: mount.base, json: mountJson(mount) },
      path,
      tenant: true as const,
      looks: lookSheetsFor(worn().ui),
      faces: lookFacesFor(worn().ui),
      appFaces: appFaceHead(worn().ui, (href) => outward(mount, href)),
      density: hosted?.value.theme.density ?? lookDensityFor(worn().ui),
      scheme: hosted ? hosted.value.theme.scheme : lookSchemeFor(worn().ui),
      grounds: hosted ? groundsOf(hosted.value.theme) : lookGroundsFor(worn().ui),
      ...(req ? { locale: requestLocale(loaded.app, { visitor: true, req }) } : {}),
      ...(observerMounted() ? { observe: observerHome(mount) } : {}),
    });
    /* The App's declared egress in the page's policy, as the ordinary host
       writes it (clientHttp.ts shellEgress): a component may reach only the
       origins the App declared, and its pictures only those; the human check's
       provider may draw its widget. */
    const widget = challenge?.widget?.script;
    const egress = shellEgress([{ ui: loaded.app.ui, components: Boolean(loaded.components), ...(widget ? { widget } : {}) }]);
    const server = createServer((req, res) => {
      setBaselineHeaders(req, res, (raw.bound as Bound).trustedProxies);
      let finish!: () => void;
      const held = new Promise<void>((resolve) => {
        finish = resolve;
      });
      pending.add(held);
      accepted.add(req);
      // Retirement can interrupt admission before the native body reader has
      // attached its own listener. Its later body wait needs an error, not just
      // a socket close, so always own that error channel from acceptance.
      req.once('error', () => {});
      let dispatchedMutation = false;
      const work = async () => {
        /* A host's page on another origin (embed/crossOrigin.ts): its preflight
           answered, its bearer read as the session it stands for, and its
           cookies dropped either way. Never on a mapped public host. */
        if (auth.embed && !getTenantHostIntent(req)) {
          const at = (req.url ?? '').split('?')[0];
          if ((await embedDoor(req, res, at, auth.embed)) === 'answered') return;
        }
        /* A test host's setup, before any gate as on the ordinary server: it answers only its own token from
           loopback in a process started with NODE_ENV=test (http/testControl.ts), and never on a mapped host. */
        if (testControl && !getTenantHostIntent(req) && (await testControl.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))))
          return;
        // Before bearer APIs, support, administration or invitation dispatch:
        // mapped hosts expose only public intake/landing, static files and the
        // signed-out whoami. The canonical-path and Host checks below still
        // apply; neither a cookie nor a tenant header can widen this surface.
        const asked = new URL(req.url ?? '/', 'http://localhost');
        if (getTenantHostIntent(req)) {
          const path = (req.url ?? '').split('?')[0];
          if (
            !isTenantPublicPath(path) &&
            !visitorRead(req, asked.pathname, asked) &&
            !path.startsWith(BRANDING_LOGO_PATH) &&
            !(
              [APP_FLAG_VALUES_PATH, EXPERIMENT_EXPOSURES_PATH, EXPERIMENT_VISITOR_PATH].includes(path) &&
              req.headers[EXPERIMENT_FORM_HEADER]
            ) &&
            path !== '/api/whoami' &&
            !(browser && path === SHARE_CARD_PATH) &&
            !(browser && path.startsWith('/') && path !== '/api' && !path.startsWith('/api/'))
          )
            return refuse(403);
        }
        /* A public address opens a visitor's reads and nothing else: on any other
           API route it is refused before a bearer, a session or a lease is read,
           so no member's request is ever answered as a visitor's or the reverse.
           Who-am-I reads it to answer as the visitor; a public form and its
           flags carry their own address. */
        if (
          asked.searchParams.has('via') &&
          (asked.pathname === '/api' || asked.pathname.startsWith('/api/')) &&
          asked.pathname !== '/api/whoami' &&
          !isTenantPublicPath(asked.pathname) &&
          ![APP_FLAG_VALUES_PATH, EXPERIMENT_EXPOSURES_PATH, EXPERIMENT_VISITOR_PATH].includes(asked.pathname) &&
          !visitorRead(req, asked.pathname, asked)
        )
          return refuse(403);
        /* A mail provider's delivery and a requester's signed link: each proves
           itself (an HMAC, a signed token), never a session, so neither reaches
           a session's routes. The Host is still this deployment's; the Origin and the body's type are not asked, as
           a provider posts from no page and a link is followed from a mail client. */
        const proven = { writing: writes(req), origin: 'none', json: false } as const;
        if (mail) {
          const at = (req.url ?? '').split('?')[0];
          if (at === '/api/mail/inbound' || at === '/api/mail/link') {
            if (doorRefusal(req, binding(), proven)) return refuse(403);
            if (await mail.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) return;
          }
        }
        // The link at the foot of a contact email proves itself by its signed token, before any session.
        if (contactMail && (req.url ?? '').split('?')[0] === UNSUBSCRIBE_PATH) {
          if (doorRefusal(req, binding(), proven)) return refuse(403);
          if (await contactMail.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) return;
        }
        // An integration's webhook, an inbound endpoint, proves itself the same way: its provider's signature, under one tenant's secret.
        if (integrations && (req.url ?? '').split('?')[0].startsWith('/api/inbound/')) {
          if (doorRefusal(req, binding(), proven)) return refuse(403);
          if (await integrations.handle(req, res, new URL(req.url ?? '/', 'http://localhost'))) return;
        }
        // A bearer request claims the App API namespace before anything else,
        // with its own admission; it never reaches a browser or data route.
        if (api) {
          if (await api.mcp.handle(req, res)) return;
          if (api.commands && (await api.commands.handle(req, res))) return;
          if (await api.reads.handle(req, res)) return;
        }
        // Never inside a dealer: an account holding a live support session
        // manages no tenant and no invitation until it exits. Fails closed.
        if (support && (isTenantInvitationHttpRequest(req) || isTenantAdministrationHttpRequest(req)) && (await support.holds(req))) {
          active();
          return send(req, res, 403, {
            error: 'Exit the dealer before managing tenants or invitations.',
            code: SUPPORT_REFUSAL_CODES.active,
            outcome: 'not_applied',
          });
        }
        if (isTenantInvitationHttpRequest(req)) return dispatchInvitations(req, res);
        if (isTenantAdministrationHttpRequest(req)) return dispatchAdministration(req, res);
        active();
        if (tenantHttpHeader(req, ADMINISTRATION_HTTP_HEADER) !== undefined) return refuse();
        if (tenantHttpHeader(req, INVITATION_HTTP_HEADER) !== undefined) return refuse();
        const target = req.url ?? '';
        if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) return refuse();
        const url = new URL(target, 'http://localhost'),
          path = url.pathname;
        if (path !== target.split('?')[0]) return refuse();
        const bound = binding();
        /* The Host, for everything below. A write's Origin and body are each dispatcher's own door further in: the
           data server's (tenantHttp.ts), a public form's, a visitor's read, the assistant's and native auth's below. */
        if (doorRefusal(req, bound, { writing: false })) return refuse(403);
        if (visitorRead(req, path, url)) {
          // A visitor names no lease, tenant or realm, and holds no bearer: a request that does is a member's, or no one's.
          if (req.headers.authorization !== undefined) return refuse(403);
          for (const name of Object.values(headers)) tenantHttpHeader(req, name);
          const app = tenantHttpHeader(req, headers.app);
          if (
            (app !== undefined && app !== loaded.app.id) ||
            Object.values(headers).some((name) => name !== headers.app && req.headers[name] !== undefined) ||
            url.searchParams.has('tenant') ||
            url.searchParams.has('realm') ||
            url.searchParams.has('conn')
          )
            return refuse(400);
          const host = mappedHost(req);
          // A mapped host names its tenant; an address there would name a second.
          if (host && url.searchParams.has('via')) return refuse(400);
          const vias = url.searchParams.getAll('via');
          /* Two addresses, or one that is not an address, place nobody: answered as an unknown one is. */
          const placement = host
            ? { tenant: host.tenant }
            : {
                address: vias.length === 1 ? (publicAddress(vias[0]!) ?? '') : '',
              };
          return dispatchPublicReads!(req, res, url, placement);
        }
        /* A tenant's logo: public, as its sign-in page and its email need it, and named by the hash of its bytes,
           which only its tenant's pages say. Served as an image that runs nothing, whatever it holds. */
        if (branding && path.startsWith(BRANDING_LOGO_PATH)) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405);
          const hash = path.slice(BRANDING_LOGO_PATH.length);
          if (!/^[0-9a-f]{64}$/.test(hash) || url.search) return refuse(404);
          const logo = await branding.logo(hash);
          active();
          if (!logo)
            return send(req, res, 404, {
              error: 'Not found.',
              code: 'not_found',
            });
          res.writeHead(200, brandingLogoHeaders(logo));
          res.end(req.method === 'HEAD' ? undefined : Buffer.from(logo.bytes));
          return;
        }
        /* The landing's share card (shareCard.ts): drawn from the landing's words in the host tenant's published
           look, whoever asks — the address names the landing and nothing else, and no query names a tenant. */
        if (browser && path === SHARE_CARD_PATH) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405);
          const asked = cardRequest(url);
          const hosted = asked ? await hostBranding(req) : undefined;
          active();
          const card = asked && !asked.inside.search ? landingCard(asked.inside.pathname, hosted)?.card : undefined;
          return sendShareCard(req, res, card, asked?.version);
        }
        if (browser && path !== '/api' && !path.startsWith('/api/')) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405);
          // Encoded separators/names must not disguise an API path as a SPA
          // deep link when the static middleware decodes it later.
          let decodedPath: string;
          try {
            decodedPath = new URL(decodeURIComponent(path).replace(/\\/g, '/').replace(/\/+/g, '/'), 'http://localhost').pathname;
          } catch {
            return refuse();
          }
          if (decodedPath === '/api' || decodedPath.startsWith('/api/')) return refuse();
          const inside = insidePaths.get(req) ?? path;
          // The server's root, where the App is mounted elsewhere: its home.
          if (inside === '/') {
            res.writeHead(303, {
              location: appHome(mount, loaded.app.id),
              'cache-control': 'no-store',
              'content-length': '0',
            });
            res.end();
            return;
          }
          /* `/desk/` is `/desk`: the client refuses an empty segment in a tenant link, so a typed trailing
             slash left a dead start screen. Relative, so it holds behind a proxy that strips the base. */
          if (inside.length > 1 && inside.endsWith('/')) {
            const [pathname, query] = (req.url ?? '/').split(/\?(.*)/s);
            const trimmed = pathname.replace(/\/+$/, ''),
              last = trimmed.split('/').pop();
            if (last) {
              const up = '../'.repeat(pathname.length - trimmed.length);
              res.writeHead(308, {
                location: `${up}${last}${query ? `?${query}` : ''}`,
                'cache-control': 'no-store',
                'content-length': '0',
              });
              res.end();
              return;
            }
          }
          /* A theme's font files: presentation the sign-in screen wears too, so to anyone (fontRoutes.ts). */
          if (fontRoute({ req, res }, inside, (id) => (id === loaded.app.id ? (look ? look.fonts : loaded.fonts) : undefined))) return;
          if (brandRoute({ req, res }, inside, (id) => (id === loaded.app.id ? loaded.brand : undefined))) return;
          /* A custom component's code and the host modules it imports: code, never a row. Asked by its inside
             address: an App at the root is asked for `/_components/…`, which names it as `/{app}/_components/…`. */
          if (
            await tenantComponentRoute(
              { req, res },
              inside,
              loaded.app.id,
              loaded.components?.files,
              async () => {
                const proof = await verify(req);
                active();
                return proof !== null && proof.expiresAt > now();
              },
              mount.base,
              visitorFiles,
            )
          )
            return;
          const hosted = await hostBranding(req);
          // An OAuth consent page is framed by nobody, this origin included (http/handler.ts): a click there gives a token.
          const consenting = url.searchParams.has('authorize');
          if (consenting) res.setHeader('x-frame-options', 'DENY');
          return serveClient(CLIENT_FILES, req, res, {
            ...shell(inside, hosted, req),
            ...(await landingSocial(req, inside, hosted)),
            ...(consenting ? { unframed: true } : {}),
          });
        }
        if (
          [APP_FLAG_VALUES_PATH, EXPERIMENT_EXPOSURES_PATH, EXPERIMENT_VISITOR_PATH].includes(path) &&
          req.headers[EXPERIMENT_FORM_HEADER]
        ) {
          const selection = experimentPublicSelection(req),
            scope = flagHttpRequest();
          if ([...url.searchParams.keys()].some((key) => key !== 'app')) return refuse(400);
          /* Placed by the forms' one rule (tenantPublicPlacement.ts): the page's address on the shared host, the host's
             tenant's own on this App's mapped host, where an address too would name a second tenant. */
          const placement = tenantPublicPlacement(req, loaded.app.id, selection.address, hostAddress);
          if (placement.conflict) return refuse(400);
          if (
            !scope ||
            scope.request !== req ||
            !selection.form ||
            !isPublicForm(loaded.app.views[selection.form]) ||
            !deployment.withPublicFlagIntake
          )
            return refuse(403);
          if (req.headers.authorization || Object.values(headers).some((name) => name !== headers.app && req.headers[name] !== undefined))
            return refuse(403);
          const handler = scope.runtime.valuesHttp({
            bound,
            async withRequest(request, _response, guard, use) {
              await deployment.withPublicFlagIntake!(selection.form!, await placement.address(), async (owner) => {
                const assertCurrent = () => {
                  active();
                  guard();
                  scope.lifetime.assertCurrent();
                  owner.assertCurrent();
                };
                await use(
                  await scope.runtime.public(request, {
                    generation: scope.lifetime.generation,
                    form: selection.form,
                    tenantId: owner.tenantId,
                    assertCurrent,
                    async current() {
                      assertCurrent();
                      await owner.current();
                      assertCurrent();
                    },
                  }),
                );
              });
              active();
              guard();
            },
          });
          await handler(req, res);
          return;
        }
        if (isTenantPublicPath(path)) return dispatchPublic(req, res, url);
        const whoami = path === '/api/whoami',
          native = path === '/api/auth' || path.startsWith('/api/auth/');
        if (tenantAssistant?.handles(path)) return tenantAssistant.handle(req, res, url, path);
        if (!whoami && !native) {
          dispatchData(req, res);
          return;
        }
        // Native account administration is deployment-wide, not tenant-scoped.
        // Keep it off this bounded host; future operator APIs have their own
        // explicit authority. Canonical native paths prevent encoded/duplicate
        // separators from reaching a differently normalizing provider router.
        if (
          native &&
          (path.includes('%') ||
            path.includes('//') ||
            path.toLowerCase() === '/api/auth/admin' ||
            path.toLowerCase().startsWith('/api/auth/admin/'))
        )
          return refuse(403);
        // Native auth is not a JSON-only resource API: sign-out may be
        // bodyless and OAuth callbacks may be cross-site form POSTs. The routes
        // that hold their own proof are not asked their Origin (auth.ts).
        const ownProof = authHoldsOwnProof(path, auth.embed !== undefined);
        if (doorRefusal(req, bound, { writing: writes(req), origin: ownProof ? 'none' : 'writes', sameSite: true, json: false }))
          return refuse(403);
        for (const name of Object.values(headers)) tenantHttpHeader(req, name);
        const expected = tenantHttpHeader(req, headers.account),
          app = tenantHttpHeader(req, headers.app);
        if (
          (app !== undefined && app !== loaded.app.id) ||
          [headers.tenant, headers.tab, headers.context, headers.revision].some((name) => tenantHttpHeader(req, name) !== undefined)
        )
          return refuse();
        if (
          url.searchParams.has('tenant') ||
          url.searchParams.has('conn') ||
          url.searchParams.getAll('app').length > 1 ||
          (url.searchParams.has('app') && url.searchParams.get('app') !== loaded.app.id)
        )
          return refuse();
        if (whoami) {
          if (req.method !== 'GET' && req.method !== 'HEAD') return refuse(405);
          if (
            url.searchParams.getAll('app').length !== 1 ||
            [...url.searchParams.keys()].some((key) => key !== 'app' && !(key === 'via' && dispatchPublicReads)) ||
            req.headers['transfer-encoding'] !== undefined ||
            (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0')
          )
            return refuse();
          /* A visitor's address, or this App's mapped host, where the App opens reads to visitors: the
             visitor's answer, whoever's cookie rides along — a member reads as a member at the App's own
             address, never through a tenant's public one. Whether the address places anyone is the reads'
             to say, each as one missing page; this answer names no tenant either way. */
          if (dispatchPublicReads && (url.searchParams.has('via') || mappedHost(req))) {
            if (mappedHost(req) && url.searchParams.has('via')) return refuse();
            active();
            return send(req, res, 200, {
              signedIn: false,
              accountId: null,
              appId: loaded.app.id,
              who: null,
              header: null,
              ...(signIn.suite ? { suite: signIn.suite } : {}),
              signIn: {
                ...signIn,
                ...(browser ? { look: withIconGlyphs(appLook(loaded.app)) } : {}),
              },
              public: true,
              tenantPublic: true,
              ...(browser
                ? {
                    appName: loaded.app.name,
                    ...(home === undefined ? {} : { home }),
                  }
                : {}),
            });
          }
          const proof = await verify(req);
          active();
          const instant = now();
          active();
          if (!Number.isFinite(instant)) return denyTenant();
          // Signed out, the public view the App's home rules start a visitor on — its
          // landing or a public form — so the client draws it instead of the sign-in screen.
          // With invitations and email sign-in, a signed-out invitee may claim an
          // account-creating invitation: the form needs only the App to claim into.
          if (proof === null)
            return send(req, res, 200, {
              signedIn: false,
              accountId: null,
              appId: loaded.app.id,
              who: null,
              header: null,
              ...(signIn.suite ? { suite: signIn.suite } : {}),
              signIn: {
                ...signIn,
                // The door in the App's own colours, as the ordinary server draws it (gate.ts).
                ...(browser ? { look: withIconGlyphs(appLook(loaded.app)) } : {}),
                ...(administration?.invitations?.claim && Array.isArray(signIn.providers) && signIn.providers.includes('email')
                  ? { invitationClaim: loaded.app.id }
                  : {}),
              },
              ...(browser
                ? {
                    tenant: true,
                    appName: loaded.app.name,
                    ...(home === undefined ? {} : { home }),
                  }
                : {}),
            });
          tenantIdentifier(proof.identity.id, 1024);
          validateHeaderValue(headers.account, proof.identity.id);
          if (proof.expiresAt <= instant) return denyTenant();
          if (expected !== undefined && expected !== proof.identity.id) return refuse(409);
          res.setHeader(headers.account, proof.identity.id);
          return send(req, res, 200, {
            signedIn: true,
            accountId: proof.identity.id,
            appId: loaded.app.id,
            who: proof.identity.who,
            header: null,
            accountProfile: true,
            ...roleLabelsOf(loaded.app.auth),
            ...keepsRoles(loaded.app.auth),
            ...(signIn.suite ? { suite: signIn.suite } : {}),
            ...(administrationOptions?.policy ? { tenantAdministration: true } : {}),
            ...(administration?.invitations ? { tenantInvitations: true } : {}),
            ...(support ? { tenantSupport: true } : {}),
            // A bell for the notices kept in each lease's own inbox (tenantInbox.ts).
            ...(appKeepsInbox(loaded.app) ? { inbox: true } : {}),
            /* The chooser is drawn before the App's payload, which needs a
               chosen tenant: so its look, and what the App calls a tenant, travel here. */
            ...(browser
              ? {
                  tenant: true,
                  appName: loaded.app.name,
                  look: withIconGlyphs(appLook(loaded.app)),
                  ...(loaded.app.auth?.tenancy?.label ? { tenantLabel: loaded.app.auth.tenancy.label } : {}),
                  ...(loaded.app.auth?.tenancy?.platform ? { platformLabel: loaded.app.auth.tenancy.platform.label } : {}),
                }
              : {}),
          });
        }
        if (path === '/api/auth/sign-out') {
          // A sign-out that names no account is not refused for a session that no longer verifies.
          const proof = expected !== undefined ? await verify(req) : await verify(req).catch(() => null);
          active();
          if (expected !== undefined && proof !== null && proof.identity.id !== expected) return refuse(409);
          // Before the session ends, not after: evidence kept for it is gone however the sign-out goes.
          if (proof !== null) endAdmissionSession(proof.sessionId);
        }
        active();
        if (req.aborted || res.destroyed) return denyTenant();
        // Preserve native cookies, redirects, body limits and profile outcome
        // handling; these are auth operations, not selected tenant DTOs.
        res.setHeader('cache-control', 'no-store');
        dispatchedMutation = req.method !== 'GET' && req.method !== 'HEAD';
        /* Better Auth routes by the whole address, the base path with it
           (auth.ts): given back what the browser sent. */
        req.url = arrivedUrls.get(req) ?? req.url;
        await auth.handler(req, res);
      };
      /* Whether this browser (or token) wrote a moment ago, for every route
         below: a fresh one reads the primary (adapters/replicas.ts). */
      void readsAs(readFreshness(req, res, mount.base), work)
        .catch((error) => {
          if (res.headersSent) {
            if (!res.writableEnded) res.destroy();
            return;
          }
          for (const name of Object.values(headers)) res.removeHeader(name);
          send(req, res, error instanceof AuthRequestRefusal ? error.status : dispatchedMutation ? 503 : 403, {
            error: 'The authentication request could not be confirmed.',
            code: dispatchedMutation ? 'auth_unknown' : 'auth_unavailable',
            ...(dispatchedMutation ? { outcome: 'unknown' } : {}),
          });
        })
        .catch(() => {
          if (!res.destroyed) res.destroy();
        })
        .finally(() => {
          pending.delete(held);
          accepted.delete(req);
          finish();
        });
    });
    // The probes and the dev observer's address, and a span per request, as the App server has (http/server.ts).
    /* Every address read through the mount first, as createApp reads it
       (http/server.ts): the base path off `req.url`, which every route below
       reads, and the page's inside address kept for the shell. */
    platformRequests(server, (req, res) => {
      let url: URL;
      try {
        url = new URL(req.url ?? '/', 'http://localhost');
      } catch {
        return false;
      }
      /* The OAuth documents a client discovers the API's authorization server by (auth/oauthResource.ts), read
         before the base path as the App server reads them (http/server.ts). Only where the API is served. */
      if (api && answerOAuthWellKnown(raw.auth, req, res, url.pathname)) {
        routedPath(req, url.pathname);
        return true;
      }
      if (!routeAddress(req, res, url, mount)) {
        routedPath(req, undefined);
        return true;
      }
      routedPath(req, url.pathname);
      servedApp(req, loaded.app.id);
      insidePaths.set(req, url.pathname);
      /* Bare whatever it is asked: the tenant host carries no first answers, and its shell asks for itself. */
      return (
        probe(req, res, url.pathname) ||
        embedBoot(req, res, url.pathname, { origins: auth.embed?.origins }) ||
        observerRoute(req, res, url, mount)
      );
    });
    /* Outermost, so a request's timing covers every listener above (serverTiming.ts); nothing when off. */
    timeRequests(server);
    applyServerTimeouts(server);
    const close = server.close.bind(server);
    // The API first: nothing may answer a bearer once the deployment begins to drain.
    // The job host too: no attempt starts once it does, and one running is waited for.
    const jobs = jobHost;
    const retentionTick = retentionTimer;
    const mailHost = mail;
    const outbound = integrations;
    const notices = noticeMail;
    const contacts = contactMail;
    const retire = tenantRetirement(
      [
        ...(mailHost ? [() => mailHost.stop()] : []),
        ...(notices ? [() => notices.stop()] : []),
        ...(contacts ? [() => contacts.stop()] : []),
        ...(outbound ? [() => outbound.stop()] : []),
        ...(jobs ? [() => jobs.stop()] : []),
        ...(retentionTick ? [async () => retentionTick.stop()] : []),
        ...(search ? [async () => search!.close()] : []),
        ...(tenantAssistant ? [tenantAssistant.close] : []),
        ...(api?.commands ? [api.commands.retire] : []),
        ...(api ? [api.reads.retire] : []),
        data.retire,
        ...(administration ? [administration.retire] : []),
        ...(support ? [support.retire] : []),
        ...(sourceClient ? [() => closeDevClientHmr(server)] : []),
        async () => {
          const stopped = new Promise<void>((resolve, reject) =>
            close((error) => {
              if (error && (error as NodeJS.ErrnoException).code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
              else resolve();
            }),
          );
          void stopped.catch(() => {});
          for (const request of accepted) if (!request.complete) request.destroy(new Error('The server is stopping.'));
          await Promise.allSettled([...pending]);
          if (sourceClient) await retireDevClient(server);
          server.closeIdleConnections();
          await stopped;
        },
      ],
      [
        async () => {
          auth.close();
        },
      ],
    );
    if (sourceClient) attachDevClient(server);
    const tenantNamesOf = enrollment.names;
    return Object.freeze({
      server,
      /** Wear a look a save changed in place (tenantLook.ts): the next page and payload are dressed in it. */
      restyle(next: TenantLook): void {
        if (retired) return;
        look = next;
      },
      retire(): Promise<void> {
        retired = true;
        return retire();
      },
      linkAccess: createSuiteLinkAccess(enrollment, active),
      flagAccess: captureSuiteFlagAccess(enrollment, active),
      flagScopeProof: captureSuiteFlagScopeProof(enrollment, active, {
        auth: claimedAuth,
        roles: loaded.app.auth!.roles!,
      }),
      flagScopes: captureSuiteFlagScopes(enrollment, active, claimedAuth),
      attachFlagRuntime: enrollment.attachFlagRuntime,
      experimentConversionAuthority: enrollment.experimentConversionAuthority,
      /* Membership administration, read only, for the suite Console's Governance room: the same owner its own
         screen asks, with the caller's own native login, so its grant alone decides what is read. */
      ...(administration && administrationOptions?.policy
        ? {
            administrationReads: Object.freeze({
              open: async (request: IncomingMessage, accountId: string) => {
                active();
                return administration!.open(request, {
                  expectedAccount: accountId,
                });
              },
              tenants: async (request: IncomingMessage, input: AdministrationPageRequest) => {
                active();
                const page = await administration!.tenants(request, input);
                return {
                  ...page,
                  items: await namedTenants(page.items, tenantNamesOf),
                };
              },
              memberships: async (request: IncomingMessage, input: AdministrationMembershipPageRequest) => {
                active();
                return administration!.memberships(request, input);
              },
            }),
          }
        : {}),
      /* Whether this host's jobs sweep the App's buckets: the CLI says how to otherwise (files/fileStorage.ts unsweptBuckets). */
      filesSwept,
      // Started by the host once it listens; its readiness is the job host's.
      ...(jobs || mailHost || outbound || notices || contacts
        ? {
            jobs: Object.freeze({
              start: () => {
                jobs?.start();
                mailHost?.start();
                outbound?.start();
                notices?.start();
                contacts?.start();
              },
              readiness: () => [...(jobs?.readiness() ?? []), ...(outbound?.readiness() ?? [])],
              /* A test host's "run this job now" (http/testControl.ts), the declared jobs' own; nothing else calls it. */
              runNow: (name: string, timeoutMs?: number) =>
                jobs
                  ? jobs.runNow(name, timeoutMs)
                  : Promise.reject(new Error(`This server runs no jobs: start the App with --jobs to run "${name}".`)),
            }),
          }
        : {}),
    });
  } catch (error) {
    await tenantRetirement(
      [
        ...(mail ? [() => mail!.stop()] : []),
        ...(noticeMail ? [() => noticeMail!.stop()] : []),
        ...(contactMail ? [() => contactMail!.stop()] : []),
        ...(integrations ? [() => integrations!.stop()] : []),
        ...(jobHost ? [() => jobHost!.stop()] : []),
        ...(retentionTimer ? [async () => retentionTimer!.stop()] : []),
        ...(search ? [async () => search!.close()] : []),
        ...(tenantAssistant ? [tenantAssistant.close] : []),
        ...(apiOwner ? [() => apiOwner!.retire()] : []),
        ...(data ? [data.retire] : enrollment ? [enrollment.retire] : []),
        ...(administration ? [administration.retire] : []),
        ...(support ? [support.retire] : []),
      ],
      [],
    )().catch(() => {});
    if (claimedAuth) ownedAuth.delete(claimedAuth);
    // The refusal still says nothing — acquisition failing must not tell a
    // caller why — but the reason is recorded for the trusted reader, so the
    // operator who started the deployment is not left with one sentence and
    // no way to tell a bad store from a bad policy from a second copy of a
    // module. Dropping it entirely cost a diagnosis once.
    return denyTenant(error);
  }
}
