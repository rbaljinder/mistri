import { validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { isProxy } from 'node:util/types';
import { INVITATION_HTTP_HEADER, INVITATION_HTTP_ROOT } from '../../shared/tenantInvitations.js';
import { TENANT_HTTP_HEADERS as headers } from '../../shared/tenantContext.js';
import { doorRefusal, type Bound } from '@mistriwork/engine/server/http/trust.js';
import { clientAddress, invitationClaimLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { TenantInvitationClaimRefusal, TenantInvitationFailure, type TenantInvitations } from './tenantInvitationOperations.js';
import { captureInvitationIntent } from './tenantInvitationModel.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { tenantHttpBinding, tenantHttpHeader } from './tenantHttp.js';
import { namedTenants, type TenantNames } from './tenantNames.js';

class InvitationHttpRefusal extends Error {
  constructor(readonly status = 400) {
    super('The invitation request is unavailable.');
  }
}
const refuse = (status = 400): never => {
  throw new InvitationHttpRefusal(status);
};
const maximumBody = 65_536;

// Claim aliases before the host's business/static fallback. Only literal paths
// are accepted below; retain the original prefix even when dot segments escape it.
function routingPaths(req: IncomingMessage): string[] {
  let path = (req.url ?? '').split('?')[0];
  const paths: string[] = [];
  for (;;) {
    try {
      paths.push(new URL(path, 'http://localhost').pathname.replace(/\/+/g, '/').toLowerCase());
    } catch {
      /* Refused below. */
    }
    const normalized = path.replace(/\\/g, '/').replace(/\/+/g, '/').toLowerCase();
    paths.push(normalized);
    try {
      paths.push(new URL(normalized, 'http://localhost').pathname);
    } catch {
      /* Refused below. */
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      break;
    }
    if (decoded === path) break;
    path = decoded;
  }
  return paths;
}
export function isTenantInvitationHttpRequest(req: IncomingMessage): boolean {
  return routingPaths(req).some((path) => path.startsWith(INVITATION_HTTP_ROOT));
}

function safeFailure(error: unknown): 'not_applied' | 'unknown' | undefined {
  if (!error || typeof error !== 'object' || isProxy(error)) return undefined;
  try {
    if (Object.getPrototypeOf(error) !== TenantInvitationFailure.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(error, 'outcome');
    return descriptor && 'value' in descriptor && (descriptor.value === 'not_applied' || descriptor.value === 'unknown')
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

/* The signed-out claim's fixed answers. Every token that cannot be claimed
   now — unknown, wrong, spent, revoked, expired, its inviter no longer
   authorized — gets the one generic refusal, byte for byte what any other
   invitation refusal says. `account_exists` and `claim_incomplete` are only
   reachable with a valid token, and name nothing but what its holder needs. */
const GENERIC = 'The invitation operation could not be confirmed.';
function claimAnswer(error: unknown): { status: number; body: Record<string, string> } {
  let reason: unknown, outcome: unknown;
  try {
    if (error && typeof error === 'object' && !isProxy(error) && Object.getPrototypeOf(error) === TenantInvitationClaimRefusal.prototype) {
      reason = Object.getOwnPropertyDescriptor(error, 'reason')?.value;
      outcome = Object.getOwnPropertyDescriptor(error, 'outcome')?.value;
    }
  } catch {
    /* Unknown below. */
  }
  const settled = outcome === 'not_applied' ? 'not_applied' : 'unknown';
  if (reason === 'invalid_account')
    return {
      status: 400,
      body: { error: 'Enter a name of 1 to 120 characters and a password of 8 to 128.', code: 'invalid_account', outcome: 'not_applied' },
    };
  if (reason === 'account_exists')
    return {
      status: 409,
      body: {
        error: "This invitation's email address already has an account. Sign in and accept the invitation with the same token.",
        code: 'account_exists',
        outcome: 'not_applied',
      },
    };
  if (reason === 'incomplete')
    return {
      status: 503,
      body: {
        error: 'The account was created, but the invitation was not accepted. Sign in and accept it with the same token.',
        code: 'claim_incomplete',
        account: 'created',
        outcome: settled,
      },
    };
  if (reason === 'unavailable' && settled === 'not_applied')
    return { status: 403, body: { error: GENERIC, code: 'tenant_invitation_unavailable', outcome: 'not_applied' } };
  return { status: 503, body: { error: GENERIC, code: 'tenant_invitation_unavailable', outcome: 'unknown' } };
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  if (req.aborted || req.destroyed || req.readableEnded) return Promise.reject(new InvitationHttpRefusal());
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.off('data', data);
      req.off('end', end);
      req.off('error', error);
      req.off('aborted', aborted);
      req.off('close', aborted);
    };
    const error = (failure: unknown) => {
      cleanup();
      reject(failure);
    };
    const aborted = () => error(new InvitationHttpRefusal());
    const data = (part: Buffer | string) => {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      if ((size += chunk.length) > maximumBody) {
        error(new InvitationHttpRefusal(413));
        req.resume();
        return;
      }
      chunks.push(chunk);
    };
    const end = () => {
      cleanup();
      try {
        const json = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
        const value: unknown = captureTenantData(JSON.parse(json));
        tenantRecord(value);
        resolve(value);
      } catch {
        reject(new InvitationHttpRefusal());
      }
    };
    req.on('data', data);
    req.once('end', end);
    req.once('error', error);
    req.once('aborted', aborted);
    req.once('close', aborted);
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

/** The authenticated host tracks this entire promise, including partial body
 * readers, and interrupts/drains requests before closing borrowed service/auth. */
export function createTenantInvitationHttp(options: {
  readonly appId: string;
  readonly invitations?: TenantInvitations;
  readonly bound: Bound;
  readonly assertActive: () => void;
  /** What each target tenant is called, said beside its id (tenantNames.ts). */
  readonly names?: TenantNames;
}) {
  const { appId, invitations, assertActive, names } = options,
    binding = tenantHttpBinding(options.bound);
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const statusRequest = routingPaths(req).some((path) => path.startsWith(`${INVITATION_HTTP_ROOT}/status`));
    let dispatched = false,
      completed = false;
    try {
      assertActive();
      const target = req.url ?? '',
        rawPath = target.split('?')[0];
      const url = new URL(target, 'http://localhost'),
        path = url.pathname;
      const operation = path.slice(INVITATION_HTTP_ROOT.length + 1);
      if (
        path !== rawPath ||
        path !== `${INVITATION_HTTP_ROOT}/${operation}` ||
        !['open-issuer', 'open-recipient', 'preview', 'execute', 'status', 'targets', 'list', 'claim'].includes(operation) ||
        target.includes('#') ||
        !target.startsWith('/') ||
        target.startsWith('//')
      )
        return refuse();
      // URLSearchParams replaces malformed UTF-8; do not accept a repaired selector.
      try {
        decodeURIComponent(target);
      } catch {
        return refuse();
      }
      const seen = new Set<string>();
      const allowedHeaders = new Set<string>([headers.account, headers.app, INVITATION_HTTP_HEADER]);
      for (let index = 0; index < req.rawHeaders.length; index += 2) {
        const name = req.rawHeaders[index].toLowerCase();
        if (seen.has(name) || (name.startsWith('x-mistri-') && !allowedHeaders.has(name))) return refuse();
        seen.add(name);
      }
      const bound = binding();
      const get = operation === 'targets' || operation === 'list',
        open = operation.startsWith('open-');
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
      const queryFields = ['app', ...(get ? ['after', 'limit'] : []), ...(operation === 'list' ? ['tenantId', 'operation'] : [])];
      for (const key of url.searchParams.keys()) {
        if (!queryFields.includes(key) || url.searchParams.getAll(key).length !== 1) return refuse();
      }
      if (operation === 'claim') {
        // Signed out, as a public form is: its own origin (checked above), the
        // App in the query alone, no account, App or context header — no
        // x-mistri-* header at all — and the claims' own budget, shaped
        // like the forms' submissions, taken only after every refusal that
        // costs nothing.
        if ([...seen].some((name) => name.startsWith('x-mistri-')) || url.searchParams.get('app') !== appId) return refuse();
        if (!invitations?.claim) return refuse(403);
        const decision = await invitationClaimLimiter().take(clientAddress(req, options.bound.trustedProxies));
        if (!decision.ok) {
          res.setHeader('retry-after', String(decision.retryAfterSeconds));
          send(req, res, 429, {
            code: 'rate_limited',
            error: `Too many requests. Try again in ${decision.retryAfterSeconds} seconds.`,
            retryAfter: decision.retryAfterSeconds,
          });
          return;
        }
        const body = await readBody(req);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        tenantRecord(body, ['token', 'name', 'password']);
        dispatched = true;
        let answer: { status: number; body: unknown };
        try {
          answer = { status: 200, body: await invitations.claim!(req, body as { token: string; name: string; password: string }) };
        } catch (error) {
          answer = claimAnswer(error);
        }
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        send(req, res, answer.status, answer.body);
        return;
      }
      const account = tenantHttpHeader(req, headers.account),
        app = tenantHttpHeader(req, headers.app);
      const context = tenantHttpHeader(req, INVITATION_HTTP_HEADER);
      if (url.searchParams.get('app') !== appId || app !== appId) return refuse();
      tenantIdentifier(account, 1024);
      if (open) {
        if (context !== undefined) return refuse();
      } else tenantIdentifier(context);
      if (!invitations) return refuse(403);
      const ownership: Record<string, string> = {
        [headers.app]: appId,
        [headers.account]: account,
        ...(context === undefined ? {} : { [INVITATION_HTTP_HEADER]: context }),
      };
      let reply: unknown;
      if (get) {
        const after = url.searchParams.get('after'),
          rawLimit = url.searchParams.get('limit');
        if (after !== null) tenantIdentifier(after, 128);
        if (rawLimit !== null && (!/^[1-9][0-9]*$/.test(rawLimit) || Number(rawLimit) > 100)) return refuse();
        const input = {
          expectedAccount: account,
          context: context!,
          ...(after === null ? {} : { after }),
          ...(rawLimit === null ? {} : { limit: Number(rawLimit) }),
        };
        if (operation === 'targets') {
          const page = await invitations.targets(req, input);
          reply = { page: { ...page, items: await namedTenants(page.items, names) } };
        } else {
          const tenantId = url.searchParams.get('tenantId'),
            listOperation = url.searchParams.get('operation');
          tenantIdentifier(tenantId, 128);
          if (listOperation !== 'revokeInvitation' && listOperation !== 'reissueInvitation') return refuse();
          reply = { page: await invitations.list(req, { ...input, tenantId, operation: listOperation }) };
        }
      } else {
        const body = await readBody(req);
        assertActive();
        if (req.aborted || res.destroyed) return denyTenant();
        const required =
          operation === 'open-issuer'
            ? []
            : operation === 'open-recipient'
              ? ['invitationId']
              : operation === 'preview'
                ? ['token']
                : ['idempotencyKey', 'intent'];
        tenantRecord(body, [...required, ...(operation === 'execute' ? ['token'] : [])]);
        if (required.some((field) => !Object.hasOwn(body, field))) return refuse();
        if (open) {
          let session;
          if (operation === 'open-issuer') session = await invitations.openIssuer(req, { expectedAccount: account });
          else {
            tenantIdentifier(body.invitationId);
            session = await invitations.openRecipient(req, { expectedAccount: account, invitationId: body.invitationId });
          }
          reply = { session };
          if (session !== null) {
            if (session.appId !== appId || session.accountId !== account) return denyTenant();
            tenantIdentifier(session.context);
            ownership[INVITATION_HTTP_HEADER] = session.context;
          }
        } else if (operation === 'preview') {
          tenantIdentifier(body.token, maximumBody);
          reply = { preview: await invitations.preview(req, { expectedAccount: account, context: context!, token: body.token }) };
        } else {
          tenantIdentifier(body.idempotencyKey);
          if (Buffer.byteLength(body.idempotencyKey) > 256) return refuse();
          const intent = captureInvitationIntent(body.intent);
          const input = { expectedAccount: account, context: context!, idempotencyKey: body.idempotencyKey, intent };
          if (Object.hasOwn(body, 'token')) {
            // Both of a recipient's steps redeem the one-time token: accepting
            // an account invitation, and claiming an email one for the account
            // whose address it names. An issuer's step never carries one.
            if (intent.operation !== 'acceptInvitation' && intent.operation !== 'claimInvitation') return refuse();
            tenantIdentifier(body.token, maximumBody);
          }
          dispatched = true;
          if (operation === 'execute') {
            const result = await invitations.execute(req, {
              ...input,
              ...(Object.hasOwn(body, 'token') ? { token: body.token as string } : {}),
            });
            completed = true;
            reply = { outcome: 'applied', ...result };
          } else {
            const result = await invitations.status(req, input);
            reply =
              result === null
                ? { status: 'not_found', outcome: 'unknown', result: null }
                : { status: 'completed', outcome: 'applied', result };
          }
        }
      }
      assertActive();
      if (req.aborted || res.destroyed) return denyTenant();
      send(req, res, 200, reply, ownership);
    } catch (error) {
      const outcome = statusRequest || completed ? 'unknown' : (safeFailure(error) ?? (dispatched ? 'unknown' : 'not_applied'));
      const refusal =
        error && typeof error === 'object' && !isProxy(error) && Object.getPrototypeOf(error) === InvitationHttpRefusal.prototype
          ? Object.getOwnPropertyDescriptor(error, 'status')?.value
          : undefined;
      send(req, res, typeof refusal === 'number' ? refusal : outcome === 'unknown' ? 503 : 403, {
        error: 'The invitation operation could not be confirmed.',
        code: 'tenant_invitation_unavailable',
        outcome,
      });
    } finally {
      // Rejections before readBody still belong to the host's accepted request.
      if (!req.destroyed && !req.readableEnded) req.resume();
    }
  };
}
