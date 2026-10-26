/** One captured pair per admitted request generation. Auth/resource admission
 * remains with its native owner; control-provider failure is never auth failure. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { normalizeFlagCatalog, normalizeFlagContext, normalizeFlagScope, type FlagContext } from '../../shared/appFlags.js';
import { isPublicCommandPage, isPublicForm, type AppDef } from '../../shared/app.js';
import { captureAppAuthRuntime, type AppAuthRuntime, type VerifiedSessionInstance } from '../auth/auth.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { getTenantHostIntent } from '../http/tenantHosts.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { createCommandFlags, type CaptureCommandFlags, type CommandFlags } from '../commands/commandFlags.js';
import type { FlagRequestReadPort } from './deployment.js';
import { createComposedFlagEvaluator } from './request.js';
import { provenEmailDomain } from './audience.js';
import { createFlagValuesHttp, type FlagValuesCapture } from './valuesHttp.js';
import { captureRequestExperiments } from '../experiments/requestCapture.js';
import type { AssignmentReceiptClaims } from '../experiments/assignmentReceipt.js';
import type { VerifiedExperimentVisitor } from '../experiments/visitorIdentity.js';
import { createExperimentExposureHttp } from '../experiments/exposureHttp.js';
import { createExperimentVisitorHttp } from '../experiments/visitorHttp.js';
import { bindCommandVisitor } from '../experiments/commandVisitor.js';
import type { ExperimentExposureLease } from '../experiments/exposureHttp.js';

export interface FlagRequestLifetime {
  /** Exact native request/attempt generation; never a browser-supplied ID. */
  readonly generation: object;
  current(): Promise<void>;
  assertCurrent(): void;
}
interface PublicFlagAdmission extends FlagRequestLifetime {
  /** A declared public form, when admission is its placed/public policy owner. */
  readonly form?: string;
  /** Already admitted by the public row-policy owner, not a URL selector. */
  readonly tenantId?: string | null;
}
/** Supplied only by the admitted job-attempt owner. Service roles are its
 * declared runAs grant, never a native account or a fabricated membership. */
interface FlagJobAdmission extends FlagRequestLifetime {
  readonly actor: Parameters<CaptureCommandFlags>[0] & { readonly kind: 'service' };
  readonly realm: 'app' | 'tenant' | 'platform';
  readonly tenantId: string | null;
}
type FlagAttemptCapture = Omit<FlagRuntimeCapture, 'request'>;
export interface FlagRuntimeCapture extends FlagValuesCapture {
  /** Every read checks this capture's owner lifetime, including retained readers.
   * Commands also retain their native execution fences. */
  readonly commandFlags: CommandFlags;
  readonly captureFlags: (actor: Parameters<CaptureCommandFlags>[0]) => Promise<CommandFlags>;
  readonly experimentOwner?: {
    readonly accountId: string | null;
    readonly realm: 'app' | 'tenant' | 'platform' | 'public';
    resolveAssignment: Awaited<ReturnType<typeof captureRequestExperiments>>['resolveAssignment'];
  };
}
interface FlagRequestRuntimeOptions {
  readonly app: AppDef;
  readonly environment: string;
  readonly readPort?: FlagRequestReadPort;
  readonly auth?: AppAuthRuntime;
  /** Deployment/App generation fence, including retirement of the read port. */
  readonly assertCurrent: () => void;
  /** Native owner observes exact evidence provenance; flags only consume this
   * closed structural projection, never construct a membership capability. */
  readonly observeMembership?: (
    request: IncomingMessage,
    principal: unknown,
  ) => FlagRequestLifetime & {
    readonly principal: Readonly<
      { appId: string; accountId: string; roles: readonly string[]; membershipId: string; membershipVersion: string } & (
        | { realm: 'platform' }
        | { tenantId: string }
      )
    >;
  };
}
const denied = (): never => {
  throw new HttpError(403, 'Flag request owner unavailable.');
};
const sameRoles = (a: readonly string[], b: readonly string[]) => {
  const right = [...b].sort();
  return a.length === b.length && [...a].sort().every((role, i) => role === right[i]);
};

export function createFlagRequestRuntime(options: FlagRequestRuntimeOptions) {
  const app = captureTenantData(options.app),
    fixed = normalizeFlagScope({ appId: app.id, environment: options.environment, tenantId: null });
  const port = options.readPort,
    deploymentCurrent = options.assertCurrent,
    observeMembership = options.observeMembership;
  const catalog = normalizeFlagCatalog({
    flags: app.flags ?? {},
    roles: Object.keys(app.auth?.roles ?? {}),
    audiences: app.audiences ?? {},
  });
  if (
    port &&
    (port.appId !== fixed.appId ||
      port.environment !== fixed.environment ||
      JSON.stringify(normalizeFlagCatalog(port.catalog)) !== JSON.stringify(catalog))
  )
    throw new Error('Flag read port does not match the App.');
  const read = port?.readRequestScopes.bind(port),
    auth = options.auth && captureAppAuthRuntime(options.auth);
  if (auth && auth.appId !== fixed.appId) return denied();
  const flags = Object.freeze(Object.keys(catalog.flags));
  type Entry = { generation: object; owner: string; active: boolean; assertCurrent(): void; promise: Promise<FlagRuntimeCapture> };
  const requests = new WeakMap<IncomingMessage, Entry>(),
    captures = new WeakSet<object>();
  const attempts = new WeakMap<
    object,
    { generation: object; fingerprint: string; active: boolean; assertCurrent(): void; promise: Promise<FlagAttemptCapture> }
  >();
  const issue = (
    request: IncomingMessage,
    lifetime: FlagRequestLifetime,
    input: {
      tenantId: string | null;
      context: FlagContext;
      accountId?: string;
      actorRoles: readonly string[];
      publicContext?: true;
      form?: string;
      realm?: 'platform';
      owner: string;
    },
  ): Promise<FlagRuntimeCapture> => {
    // All mutable data and callbacks are captured before any await/provider call.
    const held = captureTenantData(input),
      scope = normalizeFlagScope({ ...fixed, tenantId: held.tenantId });
    const context = normalizeFlagContext(held.context, catalog),
      generation = lifetime.generation;
    if (!generation || typeof generation !== 'object') return denied();
    const observe = lifetime.current.bind(lifetime),
      fence = lifetime.assertCurrent.bind(lifetime);
    const headers = JSON.stringify(request.headers),
      url = request.url,
      method = request.method,
      hostIntent = getTenantHostIntent(request);
    const check = () => {
      deploymentCurrent();
      fence();
      if (
        request.aborted ||
        request.url !== url ||
        request.method !== method ||
        JSON.stringify(request.headers) !== headers ||
        getTenantHostIntent(request) !== hostIntent
      )
        return denied();
    };
    check();
    const previous = requests.get(request);
    if (previous?.generation === generation) {
      if (previous.owner !== JSON.stringify(held) || !previous.active) {
        previous.active = false;
        return Promise.reject(new HttpError(409, 'Flag request generation changed.'));
      }
      previous.assertCurrent();
      return previous.promise;
    }
    if (previous) previous.active = false;
    const entry: Entry = { generation, owner: JSON.stringify(held), active: true, assertCurrent: () => {}, promise: undefined! };
    requests.set(request, entry);
    const assertCurrent = () => {
      try {
        check();
        if (!entry.active || requests.get(request) !== entry) return denied();
      } catch (error) {
        entry.active = false;
        throw error;
      }
    };
    entry.assertCurrent = assertCurrent;
    let experimentProof: AssignmentReceiptClaims['proof'] | undefined;
    let visitorProof: VerifiedExperimentVisitor | undefined;
    const current = async () => {
      try {
        assertCurrent();
        await observe();
        assertCurrent();
        if (experimentProof?.kind === 'session') {
          const fresh = auth && (await auth.sessionInstance(request));
          assertCurrent();
          if (!fresh || fresh.identity.id !== held.accountId || fresh.sessionId !== experimentProof.id) return denied();
          auth!.assertSessionCurrent(fresh);
        } else if (visitorProof) port!.experiments!.visitors!.assertCurrent(visitorProof, request);
      } catch (error) {
        entry.active = false;
        throw error;
      }
    };
    // Start on the next microtask so reentrant consumers see the same promise.
    entry.promise = Promise.resolve()
      .then(async () => {
        await current();
        if (port?.experiments) {
          if (held.publicContext) {
            visitorProof = port.experiments.visitors?.read(request) ?? undefined;
            if (visitorProof) {
              const visitor = port.experiments.visitors!.capture(visitorProof);
              experimentProof = { kind: 'visitor', id: visitor.proofId };
            }
          } else {
            const proof = auth && (await auth.sessionInstance(request));
            if (!proof || proof.identity.id !== held.accountId) return denied();
            auth!.assertSessionCurrent(proof);
            experimentProof = { kind: 'session', id: proof.sessionId };
          }
        }
        let snapshots: unknown, failure: 'provider_error' | undefined;
        try {
          if (!read) throw new Error('No provider.');
          snapshots = captureTenantData(await read(scope));
        } catch {
          failure = 'provider_error';
        }
        await current();
        const visitor = visitorProof && port!.experiments!.visitors!.capture(visitorProof);
        const experimentalContext = visitor
          ? normalizeFlagContext({ ...context, identity: { kind: 'visitor', id: visitor.visitorId } }, catalog)
          : context;
        const captured = createComposedFlagEvaluator({
          catalog,
          scope,
          context: experimentalContext,
          snapshots,
          ...(failure ? { failure } : {}),
        });
        const experiment =
          port?.experiments && experimentProof && !failure
            ? await captureRequestExperiments({
                port: port.experiments,
                observation: {
                  appId: fixed.appId,
                  environment: fixed.environment,
                  evaluationTenantId: scope.tenantId,
                  realm:
                    app.auth?.rows === 'tenant' ? (held.realm === 'platform' || scope.tenantId === null ? 'platform' : 'tenant') : 'app',
                  context: experimentalContext,
                  snapshots: snapshots as Awaited<ReturnType<FlagRequestReadPort['readRequestScopes']>>,
                  reobserve: current,
                },
                flags: Object.keys(app.experiments ?? {}),
                proof: experimentProof,
                current,
                readSnapshots: async () => {
                  await current();
                  const fresh = await read!(scope);
                  await current();
                  return fresh;
                },
              })
            : undefined;
        const evaluation = Object.freeze({
          scope: captured.scope,
          version: captured.version,
          evaluate(id: string) {
            assertCurrent();
            return experiment?.evaluations.get(id) ?? captured.evaluate(id);
          },
        });
        const commandFlags = createCommandFlags(catalog, evaluation, assertCurrent, experiment?.recordUse);
        if (visitor && held.publicContext) bindCommandVisitor(commandFlags, { visitorId: visitor.visitorId, assertCurrent });
        const captureFlags: FlagRuntimeCapture['captureFlags'] = async (actor) => {
          const supplied = captureTenantData(actor);
          await current();
          if (
            supplied.appId !== fixed.appId ||
            !sameRoles(supplied.roles, held.actorRoles) ||
            (held.publicContext
              ? supplied.kind !== 'public' ||
                (held.form !== undefined && (supplied.form !== held.form || supplied.id !== `public:${held.form}`))
              : supplied.kind !== undefined || supplied.id !== held.accountId)
          )
            return denied();
          return commandFlags;
        };
        const result: FlagRuntimeCapture = Object.freeze({
          request,
          tenantId: scope.tenantId,
          flagIds: flags,
          evaluation,
          ...(held.publicContext ? { publicContext: true as const } : {}),
          current,
          assertCurrent,
          captureFlags,
          ...(held.realm ? { realm: held.realm } : {}),
          ...(experiment
            ? {
                issueAssignmentReceipt: experiment.issueAssignmentReceipt,
                experimentOwner: Object.freeze({
                  accountId: held.accountId ?? null,
                  realm: held.publicContext
                    ? ('public' as const)
                    : app.auth?.rows === 'tenant'
                      ? held.realm === 'platform'
                        ? ('platform' as const)
                        : ('tenant' as const)
                      : ('app' as const),
                  resolveAssignment: experiment.resolveAssignment,
                }),
              }
            : {}),
          get commandFlags() {
            assertCurrent();
            return commandFlags;
          },
        });
        captures.add(result);
        return result;
      })
      .catch((error) => {
        entry.active = false;
        throw error;
      });
    return entry.promise;
  };

  const runtime = Object.freeze({
    appId: fixed.appId,
    environment: fixed.environment,
    /** The proof must be issued by this target App's genuine auth runtime. */
    native(request: IncomingMessage, proof: VerifiedSessionInstance, lifetime: FlagRequestLifetime) {
      if (!auth || app.auth?.rows === 'tenant' || getTenantHostIntent(request)) return denied();
      auth.assertCurrent();
      auth.assertSessionCurrent(proof);
      const accountId = proof.identity.id,
        sessionId = proof.sessionId,
        emailDomain = provenEmailDomain(proof.identity);
      const roles = Object.freeze(
        (proof.identity.role ?? '')
          .split(',')
          .map((role) => role.trim())
          .filter(Boolean),
      );
      const observe = lifetime.current.bind(lifetime),
        fence = lifetime.assertCurrent.bind(lifetime);
      const assertCurrent = () => {
        deploymentCurrent();
        fence();
        auth.assertCurrent();
        auth.assertSessionCurrent(proof);
      };
      return issue(
        request,
        {
          generation: lifetime.generation,
          assertCurrent,
          async current() {
            assertCurrent();
            await observe();
            assertCurrent();
            const fresh = await auth.sessionInstance(request);
            assertCurrent();
            if (!fresh || fresh.identity.id !== accountId || fresh.sessionId !== sessionId) return denied();
            const grant = await auth.lookupEligibleAccountRolesCurrent(accountId);
            assertCurrent();
            if (!grant || grant.accountId !== accountId || !sameRoles(grant.roles, roles)) return denied();
          },
        },
        {
          tenantId: null,
          accountId,
          actorRoles: roles,
          owner: `native:${sessionId}`,
          context: {
            identity: { kind: 'subject', id: accountId },
            roles: roles.filter((role) => catalog.roles.includes(role)),
            ...(emailDomain === undefined ? {} : { attributes: { emailDomain } }),
          },
        },
      );
    },
    /** The public grant and already-admitted row-policy context are independent
     * of native cookies, including cookies sent to a mapped storefront. */
    public(request: IncomingMessage, admission: PublicFlagAdmission) {
      const form = admission.form;
      if (form !== undefined ? !(isPublicForm(app.views?.[form]) || isPublicCommandPage(app.views?.[form])) : app.auth && !app.auth.public)
        return denied();
      const tenantId = admission.tenantId ?? null,
        intent = getTenantHostIntent(request);
      if (
        (tenantId !== null && app.auth?.rows !== 'tenant' && app.auth?.rows !== 'policy') ||
        (intent && (intent.app !== fixed.appId || (tenantId !== null && intent.tenant !== tenantId))) ||
        (intent && app.auth?.rows === 'tenant' && tenantId === null)
      )
        return denied();
      return issue(request, admission, {
        tenantId,
        context: tenantId === null ? {} : { tenantId },
        actorRoles: [],
        publicContext: true,
        ...(form === undefined ? {} : { form }),
        owner: 'public',
      });
    },
    /** Only a live binding installed by the native read/request owner admits. */
    tenant(request: IncomingMessage, principal: unknown) {
      if (app.auth?.rows !== 'tenant' || getTenantHostIntent(request)) return denied();
      const owner = observeMembership?.(request, principal);
      if (!owner) return denied();
      owner.assertCurrent();
      const captured = captureTenantData(owner.principal);
      if (captured.appId !== fixed.appId) return denied();
      const platform = 'realm' in captured && captured.realm === 'platform',
        tenantId = 'tenantId' in captured ? captured.tenantId : null;
      for (const role of captured.roles) {
        const grant = app.auth.roles?.[role];
        if (!grant || (grant.realm ?? 'tenant') !== (platform ? 'platform' : 'tenant')) return denied();
      }
      return issue(request, owner, {
        tenantId,
        accountId: captured.accountId,
        actorRoles: captured.roles,
        ...(platform ? { realm: 'platform' as const } : {}),
        owner: `${platform ? 'platform' : 'tenant'}:${captured.membershipId}:${captured.membershipVersion}`,
        context: {
          identity: { kind: 'subject', id: captured.accountId },
          roles: captured.roles,
          ...(tenantId === null ? {} : { tenantId }),
        },
      });
    },
    /** Same callback shape as tenantCommands/tenantPlatformCommands. The scope
     * registration belongs to their existing native request runtime. */
    captureTenantFlags(principal: unknown, request: IncomingMessage): Promise<CommandFlags> {
      return runtime.tenant(request, principal).then(async (capture) => {
        await capture.current();
        return capture.commandFlags;
      });
    },
    /** Jobs have a real attempt token, not a synthetic HTTP request. Admission
     * and release fences come from the job owner alongside its command binding. */
    attempt(attempt: object, admission: FlagJobAdmission): Promise<FlagAttemptCapture> {
      const actor = captureTenantData(admission.actor),
        realm = admission.realm;
      const generation = admission.generation,
        observe = admission.current.bind(admission),
        fence = admission.assertCurrent.bind(admission);
      const tenantId = admission.tenantId,
        scope = normalizeFlagScope({ ...fixed, tenantId });
      if (
        !attempt ||
        typeof attempt !== 'object' ||
        !generation ||
        typeof generation !== 'object' ||
        actor.appId !== fixed.appId ||
        actor.kind !== 'service' ||
        !/^service:[a-z][a-z0-9-]{0,62}$/.test(actor.id) ||
        !['app', 'tenant', 'platform'].includes(realm) ||
        (app.auth?.rows === 'tenant') !== (realm !== 'app') ||
        (realm === 'tenant' && tenantId === null) ||
        (realm !== 'tenant' && tenantId !== null)
      )
        return denied();
      for (const role of actor.roles) {
        const grant = app.auth?.roles?.[role];
        if (!grant || (realm !== 'app' && (grant.realm ?? 'tenant') !== realm)) return denied();
      }
      const context = normalizeFlagContext({ roles: actor.roles, ...(tenantId === null ? {} : { tenantId }) }, catalog);
      const fingerprint = JSON.stringify({ actor, scope, realm }),
        previous = attempts.get(attempt);
      deploymentCurrent();
      fence();
      if (previous?.generation === generation) {
        previous.assertCurrent();
        if (previous.fingerprint !== fingerprint) {
          previous.active = false;
          return denied();
        }
        return previous.promise;
      }
      if (previous) previous.active = false;
      const entry = { generation, fingerprint, active: true, assertCurrent: () => {}, promise: undefined! as Promise<FlagAttemptCapture> };
      attempts.set(attempt, entry);
      const assertCurrent = () => {
        try {
          deploymentCurrent();
          fence();
          if (!entry.active || attempts.get(attempt) !== entry) return denied();
        } catch (error) {
          entry.active = false;
          throw error;
        }
      };
      entry.assertCurrent = assertCurrent;
      const current = async () => {
        try {
          assertCurrent();
          await observe();
          assertCurrent();
        } catch (error) {
          entry.active = false;
          throw error;
        }
      };
      entry.promise = Promise.resolve()
        .then(async () => {
          await current();
          let snapshots: unknown, failure: 'provider_error' | undefined;
          try {
            if (!read) throw new Error('No provider.');
            snapshots = captureTenantData(await read(scope));
          } catch {
            failure = 'provider_error';
          }
          await current();
          const held = createComposedFlagEvaluator({ catalog, scope, context, snapshots, ...(failure ? { failure } : {}) });
          const evaluation = Object.freeze({
            scope: held.scope,
            version: held.version,
            evaluate(id: string) {
              assertCurrent();
              return held.evaluate(id);
            },
          });
          const commandFlags = createCommandFlags(catalog, evaluation, assertCurrent);
          return Object.freeze({
            tenantId,
            flagIds: flags,
            evaluation,
            current,
            assertCurrent,
            get commandFlags() {
              assertCurrent();
              return commandFlags;
            },
            async captureFlags(input) {
              const supplied = captureTenantData(input);
              await current();
              if (
                supplied.kind !== 'service' ||
                supplied.id !== actor.id ||
                supplied.appId !== actor.appId ||
                !sameRoles(supplied.roles, actor.roles)
              )
                return denied();
              return commandFlags;
            },
          } satisfies FlagAttemptCapture);
        })
        .catch((error) => {
          entry.active = false;
          throw error;
        });
      return entry.promise;
    },
    valuesHttp(input: {
      bound: Bound;
      mount?: string;
      withRequest(
        req: IncomingMessage,
        res: ServerResponse,
        guard: () => void,
        use: (capture: FlagRuntimeCapture, lease?: ExperimentExposureLease) => Promise<void>,
      ): Promise<void>;
    }) {
      const withRequest = input.withRequest;
      const values = createFlagValuesHttp({
        ...fixed,
        bound: input.bound,
        mount: input.mount,
        withCapture: async (req, res, guard, use) => {
          await withRequest(req, res, guard, async (capture) => {
            if (!captures.has(capture) || capture.request !== req) return denied();
            await use(capture);
          });
          deploymentCurrent();
          guard();
        },
      });
      const exposures =
        port?.experiments &&
        createExperimentExposureHttp({
          ...fixed,
          bound: input.bound,
          mount: input.mount,
          receipts: port.experiments.receipts,
          store: port.experiments.store,
          async withOwner(req, res, guard, use) {
            await withRequest(req, res, guard, async (capture, lease) => {
              if (!captures.has(capture) || capture.request !== req || !capture.experimentOwner) return denied();
              const owner = capture.experimentOwner;
              await use({
                request: req,
                accountId: owner.accountId,
                scope: { ...fixed, tenantId: capture.tenantId, realm: owner.realm },
                ...(lease ? { lease } : {}),
                current: capture.current,
                assertCurrent: capture.assertCurrent,
                resolveAssignment: owner.resolveAssignment,
              });
            });
            deploymentCurrent();
            guard();
          },
        });
      const visitors =
        port?.experiments?.visitors &&
        createExperimentVisitorHttp({
          appId: fixed.appId,
          mount: input.mount ?? '',
          bound: input.bound,
          identity: port.experiments.visitors,
          async withPublic(req, res, guard, use) {
            await withRequest(req, res, guard, async (capture) => {
              if (!captures.has(capture) || capture.request !== req || !capture.publicContext) return denied();
              await use({ request: req, accountId: null, current: capture.current, assertCurrent: capture.assertCurrent });
            });
            deploymentCurrent();
            guard();
          },
        });
      return async (req: IncomingMessage, res: ServerResponse) =>
        (await visitors?.(req, res)) || (await exposures?.(req, res)) || values(req, res);
    },
  });
  return runtime;
}
export type FlagRequestRuntime = ReturnType<typeof createFlagRequestRuntime>;
