import { validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import {
  ADMINISTRATION_HTTP_HEADER,
  ADMINISTRATION_HTTP_ROOT,
  type AdministrationAttempt,
  type AdministrationExecuteReply,
  type AdministrationOpenReply,
  type AdministrationStatusReply,
  type AdministrationImportPlanReply,
} from '../../shared/tenantAdministration.js';
import { TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { TenantAdministrationFailure, type TenantAdministration } from './tenantAdministration.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { tenantHttpBinding, tenantHttpHeader } from './tenantHttp.js';
import { namedTenants, type TenantNames } from './tenantNames.js';

class AdministrationHttpRefusal extends Error {
  constructor(readonly status = 400) {
    super('The administration request is unavailable.');
  }
}
const refuse = (status = 400): never => {
  throw new AdministrationHttpRefusal(status);
};
const maximumBody = 65_536;

// Recognize disguised routes before the business/static fallback, but accept
// only the literal canonical route in the handler below.
function routingPath(req: IncomingMessage): string {
  let path = (req.url ?? '').split('?')[0];
  try {
    path = decodeURIComponent(path);
  } catch {
    /* The handler will refuse it. */
  }
  path = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
  try {
    return new URL(path, 'http://localhost').pathname;
  } catch {
    return path;
  }
}
export function isTenantAdministrationHttpRequest(req: IncomingMessage): boolean {
  return routingPath(req).startsWith(ADMINISTRATION_HTTP_ROOT);
}

function safeTenantAdministrationFailure(error: unknown): 'not_applied' | 'unknown' | undefined {
  if (!error || typeof error !== 'object' || isProxy(error)) return undefined;
  try {
    if (Object.getPrototypeOf(error) !== TenantAdministrationFailure.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'outcome');
    return descriptor && 'value' in descriptor && (descriptor.value === 'not_applied' || descriptor.value === 'unknown')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.aborted || req.destroyed) return Promise.reject(new AdministrationHttpRefusal());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', aborted);
    };
    const error = (failure: unknown) => {
      cleanup();
      reject(failure);
    };
    const aborted = () => error(new AdministrationHttpRefusal());
    const data = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      if ((size += chunk.length) > maximumBody) {
        error(new AdministrationHttpRefusal(413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const value: unknown = captureTenantData(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        tenantRecord(value);
        resolve(value);
      } catch {
        reject(new AdministrationHttpRefusal());
      }
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    req.once('aborted', aborted);
  });
}

function send(req: IncomingMessage, res: ServerResponse, status: number, body: unknown, ownership: Record<string, string> = {}) {
  const json = JSON.stringify(body);
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }
  for (const [name, value] of Object.entries(ownership)) validateHeaderValue(name, value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(json),
    ...ownership,
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}

/** The authenticated host owns accepted requests (including body readers) and
 * drains this borrowed service alongside data before closing native auth. */
export function createTenantAdministrationHttp(options: {
  readonly appId: string;
  readonly administration?: TenantAdministration;
  readonly bound: Bound;
  readonly assertActive: () => void;
  /** What each target tenant is called, said beside its id (tenantNames.ts). */
  readonly names?: TenantNames;
}) {
  const { appId, administration, assertActive, names } = options,
    binding = tenantHttpBinding(options.bound);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const statusRequest = routingPath(req).replace(/\/+$/, '') === `${ADMINISTRATION_HTTP_ROOT}/status`;
    let dispatched = false;
    try {
      assertActive();
      const target = req.url ?? '',
        rawPath = target.split('?')[0];
      const url = new URL(target, 'http://localhost'),
        path = url.pathname;
      const operation = path.slice(ADMINISTRATION_HTTP_ROOT.length + 1);
      if (
        path !== rawPath ||
        path !== `${ADMINISTRATION_HTTP_ROOT}/${operation}` ||
        !['open', 'tenants', 'memberships', 'execute', 'status', 'assistant-usage', 'decision-usage', 'import-plan'].includes(operation)
      )
        return refuse();
      if (target.includes('#') || !target.startsWith('/') || target.startsWith('//')) return refuse();
      const seen = new Set<string>();
      const allowedHeaders = new Set<string>([headers.account, headers.app, ADMINISTRATION_HTTP_HEADER]);
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index].toLowerCase();
        if (seen.has(name) || (name.startsWith('x-mistri-') && !allowedHeaders.has(name))) return refuse();
        seen.add(name);
      }
      const bound = binding();
      const get =
        operation === 'tenants' ||
        operation === 'memberships' ||
        operation === 'assistant-usage' ||
        operation === 'decision-usage' ||
        operation === 'import-plan';
      const usage = operation === 'assistant-usage' || operation === 'decision-usage',
        importing = operation === 'import-plan';
      /* An administrator's reads are as much theirs as the writes: the fetch site and the Origin are checked on a
         GET too, and no host's bearer stands for either. A write is a POST to a writing operation; any other method
         is the 405 below, after the Host and the Origin as before. */
      if (doorRefusal(req, bound, { writing: !get && req.method === 'POST', origin: 'always', sameSite: true })) return refuse(403);
      if (req.method !== (get ? 'GET' : 'POST')) return refuse(405);
      if (req.headers['content-encoding'] !== undefined) return refuse();
      if (
        get &&
        (req.headers['transfer-encoding'] !== undefined ||
          (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0'))
      )
        return refuse();
      if (!get && Number(req.headers['content-length'] ?? 0) > maximumBody) return refuse(413);
      const queryFields = [
        'app',
        ...(usage ? ['since'] : importing ? ['tenantId', 'sandboxTenantId'] : get ? ['after', 'limit'] : []),
        ...(operation === 'memberships' ? ['tenantId', 'operation'] : []),
      ];
      for (const key of url.searchParams.keys()) {
        if (!queryFields.includes(key) || url.searchParams.getAll(key).length !== 1) return refuse();
      }
      const account = tenantHttpHeader(req, headers.account),
        app = tenantHttpHeader(req, headers.app);
      const context = tenantHttpHeader(req, ADMINISTRATION_HTTP_HEADER);
      if (url.searchParams.get('app') !== appId || app !== appId) return refuse();
      tenantIdentifier(account, 1024);
      if (operation === 'open') {
        if (context !== undefined) return refuse();
      } else tenantIdentifier(context);
      if (!administration) return refuse(403);
      const ownership = {
        [headers.app]: appId,
        [headers.account]: account,
        ...(context === undefined ? {} : { [ADMINISTRATION_HTTP_HEADER]: context }),
      };
      let reply: unknown;
      if (importing) {
        const tenantId = url.searchParams.get('tenantId'),
          sandboxTenantId = url.searchParams.get('sandboxTenantId');
        tenantIdentifier(tenantId, 128);
        tenantIdentifier(sandboxTenantId, 128);
        reply = {
          plan: await administration.importPlan(req, { expectedAccount: account, context: context!, tenantId, sandboxTenantId }),
        } satisfies AdministrationImportPlanReply;
      } else if (usage) {
        const since = url.searchParams.get('since');
        const asked = { expectedAccount: account, context: context!, ...(since === null ? {} : { since }) };
        reply = {
          usage: operation === 'decision-usage' ? await administration.decisionUsage(req, asked) : await administration.usage(req, asked),
        };
      } else if (get) {
        const after = url.searchParams.get('after'),
          rawLimit = url.searchParams.get('limit');
        if (after !== null) tenantIdentifier(after, operation === 'tenants' ? 128 : 1024);
        if (rawLimit !== null && (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 100)) return refuse();
        const input = {
          expectedAccount: account,
          context: context!,
          ...(after === null ? {} : { after }),
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        };
        if (operation === 'tenants') {
          const page = await administration.tenants(req, input);
          reply = { page: { ...page, items: await namedTenants(page.items, names) } };
        } else {
          const tenantId = url.searchParams.get('tenantId'),
            membershipOperation = url.searchParams.get('operation');
          tenantIdentifier(tenantId, 128);
          if (membershipOperation !== 'replaceMembership' && membershipOperation !== 'revokeMembership') return refuse();
          reply = { page: await administration.memberships(req, { ...input, tenantId, operation: membershipOperation }) };
        }
      } else {
        const body = await readBody(req);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const fields = operation === 'open' ? [] : ['idempotencyKey', 'intent'];
        tenantRecord(body, fields);
        if (fields.some((field) => !Object.hasOwn(body, field))) return refuse();
        if (operation === 'open') {
          const session = await administration.open(req, { expectedAccount: account });
          reply = { session } satisfies AdministrationOpenReply;
          if (session !== null) ownership[ADMINISTRATION_HTTP_HEADER] = session.context;
        } else {
          const input = { ...(body as unknown as AdministrationAttempt), expectedAccount: account, context: context! };
          dispatched = true;
          if (operation === 'execute')
            reply = { outcome: 'applied', result: await administration.execute(req, input) } satisfies AdministrationExecuteReply;
          else {
            const result = await administration.status(req, input);
            reply = (
              result === null
                ? { status: 'not_found', outcome: 'unknown', result: null }
                : { status: 'completed', outcome: 'applied', result }
            ) satisfies AdministrationStatusReply;
          }
        }
      }
      assertActive();
      if (req.aborted || res.destroyed) return denyTenant();
      send(req, res, 200, reply, ownership);
    } catch (error) {
      const outcome = statusRequest ? 'unknown' : (safeTenantAdministrationFailure(error) ?? (dispatched ? 'unknown' : 'not_applied'));
      const refusal =
        error && typeof error === 'object' && !isProxy(error) && Object.getPrototypeOf(error) === AdministrationHttpRefusal.prototype
          ? Object.getOwnPropertyDescriptor(error, 'status')?.value
          : undefined;
      send(req, res, typeof refusal === 'number' ? refusal : outcome === 'unknown' ? 503 : 403, {
        error: 'The administration operation could not be confirmed.',
        code: 'tenant_administration_unavailable',
        outcome,
      });
    }
  };
}
