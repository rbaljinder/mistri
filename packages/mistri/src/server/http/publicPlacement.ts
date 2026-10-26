/** The placed-form public door. The suite calls handle BEFORE its App/session
 * server; recovery remains reachable even when the original form is removed. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import type { AppDef } from '../../shared/app.js';
import { isPublicForm } from '../../shared/app.js';
import { appLook } from '../../shared/appUi.js';
import { parseBasePath } from '@mistriwork/engine/shared/mount.js';
import { withIconGlyphs } from '../app/iconPayload.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { businessCommandHttpError, commandBody } from '../commands/businessCommandHttp.js';
import { BusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { CommandInputError } from '../commands/commandPayload.js';
import { presentForm, publicFormComponents } from '../commands/formHttp.js';
import type { CompiledComponents } from '../app/appComponents.js';
import { PublicPlacementBindingError } from '../forms/publicPlacementBinding.js';
import type { AppPolicyDeployment, AppPolicyPlacementOptions } from '../policy/appPolicyDeployment.js';
import { getTenantHostIntent, normalizeSuitePublicOrigin } from './tenantHosts.js';
import { clientAddress, publicFormLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { send } from '@mistriwork/engine/server/http/reply.js';
import type { ProxyRange } from '@mistriwork/engine/server/http/trust.js';

export interface HttpPublicPlacementOptions extends AppPolicyPlacementOptions {
  publicOrigin: string;
  /** Complete operator mount, e.g. /suite/site, never derived from Host. */
  basePath: string;
  /** Current operator storefront origins for this App; no wildcard or brand data. */
  origins: readonly string[];
  /** Removed storefronts may recover only at the canonical receipt endpoint.
   * Absolute operator deadlines, at most 24 hours plus skew after retirement. */
  recoveryOrigins?: readonly { readonly origin: string; readonly recoverUntil: number }[];
  trustedProxies?: readonly ProxyRange[];
}

const RECOVERY_ORIGIN_WINDOW = (24 * 60 + 2) * 60 * 1000;

export function captureHttpPublicPlacement(input: HttpPublicPlacementOptions): HttpPublicPlacementOptions {
  if (isProxy(input)) throw new Error('Public placement requires captured operator configuration.');
  const publicOrigin = normalizeSuitePublicOrigin(input.publicOrigin),
    basePath = parseBasePath(input.basePath);
  if (publicOrigin !== input.publicOrigin || basePath !== input.basePath)
    throw new Error('Public placement requires canonical origin and mount.');
  const origins = captureTenantData(input.origins);
  if (!Array.isArray(origins) || origins.length > 128) throw new Error('Public placement requires bounded operator origins.');
  const hosts = new Set<string>();
  for (const origin of origins) {
    if (
      normalizeSuitePublicOrigin(origin) !== origin ||
      origin === publicOrigin ||
      new URL(origin).hostname === new URL(publicOrigin).hostname ||
      hosts.has(new URL(origin).hostname)
    ) {
      throw new Error('Public placement origins must name distinct storefront hosts.');
    }
    hosts.add(new URL(origin).hostname);
  }
  const descriptor = Object.getOwnPropertyDescriptor(input, 'recoveryOrigins');
  if (descriptor ? !descriptor.enumerable || !('value' in descriptor) : 'recoveryOrigins' in input) {
    throw new Error('Recovery origins must be startup data, not an accessor.');
  }
  const recoveryOrigins: HttpPublicPlacementOptions['recoveryOrigins'] =
    descriptor?.value === undefined ? undefined : captureTenantData(descriptor.value);
  const now = Date.now(),
    retained = new Set<string>();
  if (recoveryOrigins !== undefined) {
    if (!Array.isArray(recoveryOrigins) || recoveryOrigins.length > 128)
      throw new Error('Recovery origins must be a bounded operator list.');
    for (const entry of recoveryOrigins) {
      if (
        !entry ||
        typeof entry !== 'object' ||
        Array.isArray(entry) ||
        Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, 'origin') ||
        !Object.hasOwn(entry, 'recoverUntil') ||
        normalizeSuitePublicOrigin(entry.origin) !== entry.origin ||
        entry.origin === publicOrigin ||
        retained.has(entry.origin) ||
        !Number.isSafeInteger(entry.recoverUntil) ||
        entry.recoverUntil < 0 ||
        entry.recoverUntil > now + RECOVERY_ORIGIN_WINDOW
      ) {
        throw new Error('Recovery origins need canonical origins and bounded absolute recovery deadlines.');
      }
      retained.add(entry.origin);
    }
  }
  return Object.freeze({
    issuer: Object.freeze({
      issue: input.issuer.issue.bind(input.issuer),
      verifyExecution: input.issuer.verifyExecution.bind(input.issuer),
      verifyRecovery: input.issuer.verifyRecovery.bind(input.issuer),
    }),
    sourceIdentities: new Map<string, string>(Map.prototype.entries.call(input.sourceIdentities)),
    epoch: input.epoch,
    policyRevision: input.policyRevision,
    acquireReceiptSources: input.acquireReceiptSources,
    publicOrigin,
    basePath,
    origins,
    ...(recoveryOrigins === undefined ? {} : { recoveryOrigins }),
    trustedProxies: input.trustedProxies && captureTenantData(input.trustedProxies),
  });
}

const refuse = (): never => {
  throw new PublicPlacementBindingError();
};
const namedPath = /^\/api\/forms\/([a-z0-9][a-z0-9-]{0,63})(\/receipt)?$/;
const selectors = ['tenant', 'via', 'conn', 'connection', 'app', 'source', 'sourceIdentity'];

function header(req: IncomingMessage, name: string, required = false): string | undefined {
  const count = req.rawHeaders.filter((_, index) => index % 2 === 0 && req.rawHeaders[index].toLowerCase() === name).length;
  const value = req.headers[name];
  if (count > 1 || (required && count !== 1) || (value !== undefined && (typeof value !== 'string' || !value.length))) return refuse();
  return value;
}

function receiptEnvelope(input: unknown): { binding: string; submission: string } {
  const value = captureTenantData(input);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
  const data = value as Record<string, unknown>;
  if (
    Object.keys(data).length !== 2 ||
    !Object.hasOwn(data, 'submission') ||
    !Object.hasOwn(data, 'placement') ||
    typeof data.submission !== 'string' ||
    !/^[A-Za-z0-9_-]{16,128}$/.test(data.submission)
  )
    return refuse();
  const placement = data.placement;
  if (!placement || typeof placement !== 'object' || Array.isArray(placement)) return refuse();
  const proof = placement as Record<string, unknown>;
  if (Object.keys(proof).length !== 2 || proof.version !== 1 || typeof proof.binding !== 'string') return refuse();
  return { binding: proof.binding, submission: data.submission };
}

function failure(res: ServerResponse, error: unknown): void {
  if (error instanceof PublicPlacementBindingError) {
    send(res, error.code === 'forbidden' ? 403 : 409, { code: error.code, error: error.message, outcome: 'unknown' });
    return;
  }
  const failed = businessCommandHttpError(error);
  if (failed.retryAfter) res.setHeader('retry-after', String(failed.retryAfter));
  // A malformed/expired/changed retry may refer to a prior commit. The HTTP
  // boundary never strengthens an executor refusal into proof of absence.
  send(res, failed.status, { ...failed.body, outcome: 'unknown' });
}

export function createHttpPublicPlacement(options: {
  app: AppDef;
  config: HttpPublicPlacementOptions;
  deployment: AppPolicyDeployment<IncomingMessage>;
  current(): boolean;
  /** The App's compiled components as now loaded: where a placed form's input components are served, for its page. */
  components?: () => CompiledComponents | undefined;
}) {
  const app = captureTenantData(options.app),
    config = captureHttpPublicPlacement(options.config);
  const deployed = options.deployment,
    current = options.current;
  const canonical = new URL(config.publicOrigin);
  const origins = new Set(config.origins);
  const retainedOrigins = new Map(config.recoveryOrigins?.map((entry) => [entry.origin, entry.recoverUntil]));
  const clock = Date.now;
  const recoveryOriginAllowed = (origin: string) => origins.has(origin) || (retainedOrigins.get(origin) ?? 0) > clock();
  const originByHost = new Map(config.origins.map((origin) => [new URL(origin).host, origin]));
  const verifyRecovery = config.issuer.verifyRecovery;
  const active = () => {
    if (!current()) throw new BusinessCommandExecutionError('temporarily_unavailable', 'unknown');
  };
  return Object.freeze({
    isPlacedForm: (form: string) => deployed.placedPublicForm?.(form) === true,
    /** By default req.url still has the suite mount. formRoutes alone supplies
     * its already-normalized internal URL. No request field selects that mode. */
    async handle(req: IncomingMessage, res: ServerResponse, internalURL?: URL): Promise<boolean> {
      const url = internalURL ?? new URL(req.url ?? '/', 'http://localhost');
      let path = url.pathname;
      if (!internalURL && config.basePath) {
        if (!path.startsWith(`${config.basePath}/`)) return false;
        path = path.slice(config.basePath.length);
      }
      const match = namedPath.exec(path);
      if (!match || (!match[2] && deployed.placedPublicForm?.(match[1]) !== true)) return false;
      const form = match[1],
        receipt = !!match[2];
      res.setHeader('cache-control', 'no-store');
      res.removeHeader('set-cookie');
      res.removeHeader('x-mistri-account');
      res.removeHeader('access-control-allow-origin');
      res.removeHeader('access-control-allow-credentials');
      if (receipt) res.setHeader('vary', 'Origin');
      try {
        active();
        if (selectors.some((key) => url.searchParams.has(key))) return refuse();
        const host = header(req, 'host', true)!;
        // No URL-shaped authority, forwarded host, implicit port or duplicate
        // Host may choose another origin. Only exact configured authorities.
        if (!/^(?:\[[0-9a-f:]+\]|[a-z0-9.-]+)(?::[0-9]{1,5})?$/i.test(host)) return refuse();
        const authority = host.toLowerCase();
        const canonicalHost = authority === canonical.host;
        const origin = header(req, 'origin');
        if (origin !== undefined) {
          try {
            if (normalizeSuitePublicOrigin(origin) !== origin) return refuse();
          } catch {
            return refuse();
          }
        }
        const mappedOrigin = originByHost.get(authority);
        const intent = getTenantHostIntent(req);
        if (!canonicalHost && (!mappedOrigin || !intent || intent.app !== app.id || intent.host !== new URL(mappedOrigin).hostname))
          return refuse();
        if (canonicalHost && intent) return refuse();
        if (receipt && !canonicalHost) return refuse();
        if (req.method === 'OPTIONS' && receipt) {
          // A browser preflight carries no token. It reveals no receipt and
          // grants only this JSON POST from an exact operator-listed origin.
          if (
            !origin ||
            !recoveryOriginAllowed(origin) ||
            header(req, 'access-control-request-method') !== 'POST' ||
            header(req, 'access-control-request-headers')?.toLowerCase() !== 'content-type'
          )
            return refuse();
          res.setHeader('vary', 'Origin');
          res.setHeader('access-control-allow-origin', origin);
          res.setHeader('access-control-allow-methods', 'POST');
          res.setHeader('access-control-allow-headers', 'content-type');
          res.writeHead(204);
          res.end();
          return true;
        }
        const reading = req.method === 'GET' || req.method === 'HEAD';
        if (receipt ? req.method !== 'POST' : !reading && req.method !== 'POST') {
          res.setHeader('allow', receipt ? 'POST, OPTIONS' : 'GET, HEAD, POST');
          send(res, 405, { code: 'invalid_input', error: 'This method is unavailable.', outcome: 'unknown' });
          return true;
        }
        if (!receipt && origin !== undefined && origin !== (mappedOrigin ?? config.publicOrigin)) return refuse();
        if (!reading && !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(header(req, 'content-type', true)!))
          throw new CommandInputError();
        if (!receipt && !reading && origin !== mappedOrigin) return refuse();
        const limit = await publicFormLimiter(reading || receipt ? 'read' : 'submit').take(clientAddress(req, config.trustedProxies));
        if (!limit.ok) {
          res.setHeader('retry-after', String(limit.retryAfterSeconds));
          send(res, 429, { code: 'rate_limited', error: 'Too many requests. Try again later.', outcome: 'unknown' });
          return true;
        }
        active();
        if (receipt) {
          let proof: ReturnType<typeof receiptEnvelope>;
          try {
            proof = receiptEnvelope(await commandBody(req));
          } catch {
            return refuse();
          }
          const claims = verifyRecovery(proof.binding, proof.submission, { appId: app.id, form });
          if (origin !== undefined && origin !== config.publicOrigin) {
            if (!recoveryOriginAllowed(origin) || claims.origin !== origin) return refuse();
            // Authenticate the original origin before echoing any receipt POST.
            res.setHeader('vary', 'Origin');
            res.setHeader('access-control-allow-origin', origin);
          }
          const result = await deployed.recoverPublicPlacement!(form, proof.binding, proof.submission);
          active();
          send(res, 200, result);
          return true;
        }
        const view = app.views[form];
        if (!isPublicForm(view) || view.save) return refuse();
        /* The form as its page draws it: with where each of the App's own input components it draws is served, as
           the App's own form door and a tenant host's say it (formRoutes.ts, tenantPublicHttp.ts). */
        const components = publicFormComponents(app.id, options.components?.(), view);
        const presented = { ...presentForm(form, view), ...(components ? { components } : {}) };
        if (req.method === 'HEAD') {
          send(res, 200, { app: withIconGlyphs(appLook(app)), form: presented });
          return true;
        }
        if (!intent || !mappedOrigin) {
          send(res, 409, { code: 'placement_required', error: 'Open this form from its storefront.', outcome: 'unknown' });
          return true;
        }
        const selection = Object.freeze({ appId: app.id, tenant: intent.tenant, host: intent.host, origin: mappedOrigin });
        if (reading) {
          const placement = await deployed.preparePublicPlacement!(form, selection);
          active();
          send(res, 200, {
            app: withIconGlyphs(appLook(app)),
            form: presented,
            placement: { ...placement, recoveryUrl: `${config.publicOrigin}${config.basePath}/api/forms/${form}/receipt` },
          });
          return true;
        }
        const controller = new AbortController(),
          abort = () => controller.abort();
        req.once('aborted', abort);
        res.once('close', abort);
        try {
          if (req.aborted || res.destroyed) abort();
          const body = await commandBody(req);
          if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled', 'unknown');
          const requestId = res.getHeader('x-request-id');
          const result = await deployed.submitPublicPlacement!(form, selection, body, {
            signal: controller.signal,
            ...(typeof requestId === 'string' ? { requestId } : {}),
          });
          active();
          send(res, 200, result);
        } finally {
          req.off('aborted', abort);
          res.off('close', abort);
        }
      } catch (error) {
        failure(res, error);
      }
      return true;
    },
  });
}
