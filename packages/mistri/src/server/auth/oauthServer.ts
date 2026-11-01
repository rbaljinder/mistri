/**
 * The OAuth 2.1 authorization server an App's network API and HTTP MCP take
 * tokens from, when the config file names one (api/oauthConfig.ts). Loaded
 * only then (auth.ts), and routed under Better Auth's base beside its own
 * routes, never through it:
 *
 *   POST /api/auth/oauth/register    a public client registers (RFC 7591)
 *   GET  /api/auth/oauth/authorize   a person is sent here by the client
 *   GET  /api/auth/oauth/consent     what the consent page shows
 *   POST /api/auth/oauth/consent     the person's answer, a form of this origin
 *   POST /api/auth/oauth/token       a code, or a refresh token, for tokens
 *   POST /api/auth/oauth/revoke      a client gives a token back (RFC 7009)
 *   GET  /api/auth/oauth/grants      the person's connected clients
 *   POST /api/auth/oauth/grants/revoke
 *
 * Hand-written, deliberately small: public clients only (no client secret,
 * no client credentials, no token without a person), PKCE S256 only, codes
 * and redirect addresses matched exactly, and the access token an ordinary
 * twa1 API token (oauthGrants.ts), so everything that judges an API token
 * judges this one: its App, its roles narrowed per request, its account
 * still eligible. Its grant is judged as well: revoked or past its thirty
 * days, its tokens stop at the next request.
 *
 * The consent page is the App's own sign-in address with `?authorize=`
 * (client/components/OAuthConsent.tsx): someone signed out signs in there
 * first and comes back to it. It cannot be framed, and its answer is a form
 * of this origin carrying a nonce that is good once, for this session and this
 * request.
 *
 * A tenant App's consent also picks one of the person's active memberships,
 * and the roles it offers are that membership's: never their account's, and
 * never a platform-realm role. The membership is read where the tenant host
 * reads it (`OAuthTenancy`, bound once that host is up), again at the
 * exchange and at every refresh: one revoked or changed since ends the grant.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef } from '../../shared/appModel.js';
import { appLook } from '../../shared/appUi.js';
import { withIconGlyphs } from '../app/iconPayload.js';
import { clientAddress, limitKey } from '@mistriwork/engine/server/http/rateLimit.js';
import type { ProxyRange } from '@mistriwork/engine/server/http/trust.js';
import { OAUTH_CODE_SECONDS, oauthRoleCeiling, type OAuthServerConfig } from '../api/oauthConfig.js';
import type { VerifiedSessionInstance } from './auth.js';
import { signInState } from './signInState.js';
import {
  exchangeCode,
  issueCode,
  listGrants,
  mintOAuthCode,
  oauthDigest,
  oauthTokenRoles,
  peekBinding,
  readAccount,
  readClient,
  refreshGrant,
  registerClient,
  revokeOwnGrant,
  revokeToken,
  type OAuthIssuer,
  type OAuthMembership,
} from './oauthGrants.js';
import type { OAuthStore } from './oauthStore.js';
import { oauthIssuer, oauthResources } from './oauthResource.js';

/** How long a person has between the client sending them and their answer. */
const REQUEST_SECONDS = 600;
/** Registrations one address may make in an hour. */
const REGISTRATIONS_PER_HOUR = 10;
/** What one address may ask of the authorize, consent-view and token doors in a minute. Generous for a person and their
    client, small for a flood: each authorize writes a ten-minute record, so an unbudgeted door is a way to fill the store. */
const REQUESTS_PER_MINUTE = { authorize: 30, consent: 60, token: 120 } as const;
const BODY_LIMIT = 64 * 1024;
const CONSENT_BODY_LIMIT = 16 * 1024;
const CLIENT_NAME_LENGTH = 100;
const REDIRECT_LENGTH = 2048;
const STATE_LENGTH = 1024;
const LOOPBACK = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Tenants the consent page offers at most: each is one membership read. */
const TENANT_CHOICES = 100;

/** A tenant App's memberships, as its tenant host reads them (tenant/tenantAuthenticatedHttp.ts). */
export interface OAuthTenancy {
  /** The tenants the request's signed-in person is an active member of, named as the host's chooser names them. */
  tenants(req: IncomingMessage): Promise<readonly Readonly<{ id: string; name?: string }>[]>;
  /** One membership read now: null unless it and its tenant are active. */
  membership(accountId: string, tenantId: string): Promise<OAuthMembership | null>;
}

interface PendingRequest {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string;
  version: number;
  expiresAt: number;
}

class Refusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly description: string,
  ) {
    super(description);
  }
}

function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0,
      over = false;
    req.on('data', (part: Buffer | string) => {
      if (over) return;
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      size += chunk.length;
      if (size > limit) {
        over = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(over ? null : Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** One value per parameter (RFC 6749 §3.1): a repeated one is refused, not chosen between. */
function single(params: URLSearchParams, allowRepeated: readonly string[] = []): Map<string, string> {
  const values = new Map<string, string>();
  for (const [key, value] of params) {
    if (allowRepeated.includes(key)) continue;
    if (values.has(key)) throw new Refusal(400, 'invalid_request', `The parameter "${key}" is given twice.`);
    values.set(key, value);
  }
  return values;
}

/**
 * A redirect address a client may register (RFC 8252 for native clients):
 * https; http on this machine, any port; or a private-use scheme with a dot
 * in it (`com.example.app:/callback`). Never a fragment, a wildcard or a
 * credential. With `redirectHosts`, only the hosts the operator listed —
 * which a private-use scheme has none of.
 */
export function redirectProblem(value: unknown, hosts: readonly string[] | undefined): string | undefined {
  if (typeof value !== 'string' || !value || value.length > REDIRECT_LENGTH) return 'is not an address of at most 2048 characters';
  if (value.includes('#')) return 'has a fragment';
  if (value.includes('*')) return 'has a wildcard';
  if (/[\p{Cc}\s]/u.test(value)) return 'has a space or a control character';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'is not an absolute URL';
  }
  if (url.username || url.password) return 'carries a credential';
  const scheme = url.protocol.slice(0, -1);
  if (scheme === 'https') {
    if (!url.hostname) return 'has no host';
  } else if (scheme === 'http') {
    if (!LOOPBACK.has(url.hostname)) return 'is http on a host other than this machine (127.0.0.1, [::1] or localhost)';
  } else if (!scheme.includes('.') || !/^[a-z][a-z0-9+.-]*$/.test(scheme)) {
    return 'is neither https, http on this machine, nor a private-use scheme with a dot in it';
  } else if (url.host) return 'names a host after a private-use scheme';
  if (hosts && !hosts.includes(url.hostname)) return `is not on one of the hosts this server sends people back to (${hosts.join(', ')})`;
  return undefined;
}

/** A client's name, said on the consent page as the client's own and unverified: a line of plain text. */
function clientName(value: unknown): string | null {
  if (value === undefined) return null;
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value !== value.trim() ||
    [...value].length > CLIENT_NAME_LENGTH ||
    // Control, format (bidirectional overrides) and unassigned characters could make a name read as another.
    /[\p{C}]/u.test(value)
  )
    throw new Refusal(400, 'invalid_client_metadata', `client_name is a line of text of at most ${CLIENT_NAME_LENGTH} characters.`);
  return value;
}

export function createOAuthServer(input: {
  app: AppDef;
  config: OAuthServerConfig;
  /** The public origin and base path: where the endpoints and the App's resources are. */
  origin: string;
  under: string;
  /** The App's home as the browser shows it (shared/mount.ts appHome), its sign-in under it. */
  home: string;
  store: OAuthStore;
  sessionInstance: (req: IncomingMessage) => Promise<VerifiedSessionInstance | null>;
  /** The origins a consent form may come from: this server's own. */
  trustedOrigins: readonly string[];
  trustedProxies?: readonly ProxyRange[];
  /** A tenant App's memberships: absent until its tenant host is up, and until then it gives no token. */
  tenancy?: () => OAuthTenancy | undefined;
  now?: () => number;
}) {
  const { app, config, origin, under, store } = input;
  if (!app.api) throw new Error('The OAuth authorization server needs an App with an API.');
  const now = input.now ?? Date.now;
  const issuer = oauthIssuer(origin, under);
  const version = app.api.version;
  const resources = oauthResources(origin, under, app.id, version);
  const grantIssuer: OAuthIssuer = Object.freeze({ app, ceiling: Object.freeze(oauthRoleCeiling(app, config)) });
  const origins = new Set(input.trustedOrigins.map((value) => new URL(value).origin));
  const tenantApp = app.auth?.rows === 'tenant';
  const tenancy = (): OAuthTenancy => {
    const bound = input.tenancy?.();
    if (!bound) throw new Refusal(503, 'temporarily_unavailable', 'The authorization server is not ready yet.');
    return bound;
  };

  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'x-content-type-options': 'nosniff',
      'content-length': String(Buffer.byteLength(text)),
      ...headers,
    });
    res.end(text);
  };
  /** The endpoints a client calls from anywhere: no cookie is read, so any origin may. */
  const open = { 'access-control-allow-origin': '*' };
  const page = (res: ServerResponse, status: number, sentence: string) => {
    res.writeHead(status, {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    res.end(`${sentence}\n`);
  };
  const seeOther = (res: ServerResponse, location: string) => {
    res.writeHead(303, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    res.end();
  };
  /** Back to the client: what the person decided, with the request's state and who answered (RFC 9207). */
  const backTo = (redirectUri: string, params: Record<string, string>) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.append(key, value);
    url.searchParams.append('iss', issuer);
    return url.href;
  };
  /** A resource names this App's API, at this version: its REST base or its MCP endpoint, exactly. */
  const resourceIsOurs = (value: string | undefined) => value === resources.rest || value === resources.mcp;
  const formParams = async (req: IncomingMessage, limit: number) => {
    if (!/^application\/x-www-form-urlencoded(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new Refusal(400, 'invalid_request', 'The body is application/x-www-form-urlencoded.');
    }
    const body = await readBody(req, limit);
    if (!body) throw new Refusal(413, 'invalid_request', 'The request is too large.');
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new Refusal(400, 'invalid_request', 'The body is not UTF-8.');
    }
    return new URLSearchParams(text);
  };
  const tokenable = async (subject: string): Promise<string[] | null> => {
    const person = await store(() => readAccount(subject));
    return person ? oauthTokenRoles(grantIssuer, app.api!.roles, person.roles) : null;
  };
  /** A tenant App's: what one membership may give, read now; null when it is not an active membership. */
  const memberRoles = async (subject: string, tenantId: string): Promise<{ membership: OAuthMembership; roles: string[] } | null> => {
    if (!/^[a-z0-9][a-z0-9_-]{0,127}$/.test(tenantId)) return null;
    const membership = await tenancy().membership(subject, tenantId);
    return membership ? { membership, roles: oauthTokenRoles(grantIssuer, app.api!.roles, membership.roles) } : null;
  };
  /** The membership a token request's code or refresh token was made for, read now; undefined outside a tenant App. */
  const observed = async (peek: Readonly<{ subject: string; tenantId: string | null }> | null) => {
    if (!tenantApp) return undefined;
    if (!peek?.tenantId) return null;
    return tenancy().membership(peek.subject, peek.tenantId);
  };
  const signedIn = async (req: IncomingMessage) => {
    try {
      return await input.sessionInstance(req);
    } catch {
      // An impersonated session, or one that ended mid-request: nobody who may give a token.
      return null;
    }
  };

  /** Spend one request of `door`'s minute budget for this address before the door writes or reads anything. */
  async function spend(req: IncomingMessage, door: keyof typeof REQUESTS_PER_MINUTE) {
    const address = limitKey(clientAddress(req, input.trustedProxies));
    return signInState.consume(`oauth-${door}:${address}`, { window: 60, max: REQUESTS_PER_MINUTE[door] });
  }
  const tooMany = (res: ServerResponse, retryAfter: number | null) =>
    json(
      res,
      429,
      { error: 'too_many_requests', error_description: 'Too many requests from this address. Wait a moment and try again.' },
      { ...open, 'retry-after': String(retryAfter ?? 60) },
    );

  async function register(req: IncomingMessage, res: ServerResponse) {
    const address = limitKey(clientAddress(req, input.trustedProxies));
    const budget = await signInState.consume(`oauth-register:${address}`, { window: 3600, max: REGISTRATIONS_PER_HOUR });
    if (!budget.allowed) {
      return json(
        res,
        429,
        { error: 'too_many_requests', error_description: 'Too many registrations from this address.' },
        {
          ...open,
          'retry-after': String(budget.retryAfter ?? 3600),
        },
      );
    }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
      throw new Refusal(400, 'invalid_client_metadata', 'The registration is a JSON object.');
    }
    const body = await readBody(req, BODY_LIMIT);
    if (!body) throw new Refusal(413, 'invalid_client_metadata', 'The registration is larger than 64 KiB.');
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)) as Record<string, unknown>;
    } catch {
      throw new Refusal(400, 'invalid_client_metadata', 'The registration is not JSON.');
    }
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      throw new Refusal(400, 'invalid_client_metadata', 'The registration is a JSON object.');
    }
    const method = metadata.token_endpoint_auth_method;
    if (method !== undefined && method !== 'none') {
      throw new Refusal(400, 'invalid_client_metadata', 'Only public clients register here: token_endpoint_auth_method is "none".');
    }
    const grants = metadata.grant_types ?? ['authorization_code', 'refresh_token'];
    if (
      !Array.isArray(grants) ||
      !grants.includes('authorization_code') ||
      grants.some((grant) => grant !== 'authorization_code' && grant !== 'refresh_token') ||
      new Set(grants).size !== grants.length
    ) {
      throw new Refusal(400, 'invalid_client_metadata', 'grant_types is "authorization_code", with "refresh_token" or not.');
    }
    const responses = metadata.response_types ?? ['code'];
    if (!Array.isArray(responses) || responses.length !== 1 || responses[0] !== 'code') {
      throw new Refusal(400, 'invalid_client_metadata', 'response_types is ["code"].');
    }
    const uris = metadata.redirect_uris;
    if (!Array.isArray(uris) || uris.length < 1 || uris.length > 5) {
      throw new Refusal(400, 'invalid_redirect_uri', 'redirect_uris is a list of one to five addresses.');
    }
    for (const uri of uris) {
      const problem = redirectProblem(uri, config.redirectHosts);
      if (problem) throw new Refusal(400, 'invalid_redirect_uri', `The redirect address ${JSON.stringify(uri).slice(0, 200)} ${problem}.`);
    }
    if (new Set(uris).size !== uris.length) throw new Refusal(400, 'invalid_redirect_uri', 'redirect_uris names an address twice.');
    const name = clientName(metadata.client_name);
    const clientId = `twc1.${randomUUID()}`;
    const at = now();
    const outcome = await store((t) => registerClient(t, { clientId, name, redirectUris: uris as string[], now: at }));
    if (outcome === 'full') {
      return json(
        res,
        503,
        { error: 'temporarily_unavailable', error_description: 'Too many clients wait for consent; try again later.' },
        {
          ...open,
          'retry-after': '3600',
        },
      );
    }
    json(
      res,
      201,
      {
        client_id: clientId,
        client_id_issued_at: Math.floor(at / 1000),
        ...(name !== null ? { client_name: name } : {}),
        redirect_uris: uris,
        grant_types: grants,
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      },
      open,
    );
  }

  async function authorize(req: IncomingMessage, res: ServerResponse, url: URL) {
    const budget = await spend(req, 'authorize');
    if (!budget.allowed) return page(res, 429, 'Too many requests from this address. Wait a moment and try again.');
    let params: Map<string, string>;
    try {
      params = single(url.searchParams);
    } catch (error) {
      return page(res, 400, (error as Refusal).description);
    }
    const clientId = params.get('client_id') ?? '';
    const redirectUri = params.get('redirect_uri');
    const client = /^twc1\.[0-9a-f-]{36}$/.test(clientId) ? await store((t) => readClient(t, clientId)) : null;
    // Before the client and its address are known, nothing is sent anywhere: the person is told here.
    if (!client) return page(res, 400, 'This application is not registered with this server.');
    if (redirectUri === undefined || !client.redirectUris.includes(redirectUri)) {
      return page(res, 400, 'This application asked to send you to an address it did not register.');
    }
    const state = params.get('state');
    const fail = (error: string, description: string) =>
      seeOther(res, backTo(redirectUri, { error, error_description: description, ...(state !== undefined ? { state } : {}) }));
    if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'response_type is "code".');
    const challenge = params.get('code_challenge');
    if (challenge === undefined) return fail('invalid_request', 'code_challenge is required (PKCE).');
    if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'code_challenge_method is "S256".');
    if (!/^[A-Za-z0-9_-]{43}$/.test(challenge)) return fail('invalid_request', 'code_challenge is a SHA-256, base64url.');
    if (state === undefined || !state || state.length > STATE_LENGTH) return fail('invalid_request', 'state is required.');
    if (!resourceIsOurs(params.get('resource'))) {
      return fail('invalid_target', `resource is this App's API: ${resources.mcp} or ${resources.rest}.`);
    }
    const request = randomUUID();
    const expiresAt = now() + REQUEST_SECONDS * 1000;
    const pending: PendingRequest = { clientId, redirectUri, challenge, state, version, expiresAt };
    await signInState.put('oauth-request', request, pending, expiresAt, now());
    seeOther(res, `${input.home}/sign-in?authorize=${request}`);
  }

  const pendingRequest = async (request: string | null): Promise<PendingRequest | undefined> => {
    if (!request || !/^[0-9a-f-]{36}$/.test(request)) return undefined;
    const pending = await signInState.read<PendingRequest>('oauth-request', request);
    if (!pending || typeof pending !== 'object' || !(pending.expiresAt > now()) || pending.version !== version) return undefined;
    return pending;
  };

  /** What the consent page shows, to the person signed in: never anything the client could choose for them. */
  async function consentView(req: IncomingMessage, res: ServerResponse, url: URL) {
    const budget = await spend(req, 'consent');
    if (!budget.allowed) return tooMany(res, budget.retryAfter);
    const proof = await signedIn(req);
    if (!proof) return json(res, 401, { error: 'unauthenticated', error_description: 'Sign in to answer this request.' });
    const request = url.searchParams.get('request');
    const pending = await pendingRequest(request);
    if (!pending)
      return json(res, 410, { error: 'expired', error_description: 'This request has expired. Start again from the application.' });
    const client = await store((t) => readClient(t, pending.clientId));
    if (!client)
      return json(res, 410, { error: 'expired', error_description: 'This request has expired. Start again from the application.' });
    const subject = proof.identity.id;
    /* A tenant App's choices are its memberships, each with what it may give: the account's own roles are not
       its authority, so the top-level list is empty and the page offers a tenant first. */
    const tenants = tenantApp
      ? await (async () => {
          const listed = (await tenancy().tenants(req)).slice(0, TENANT_CHOICES);
          const choices = [];
          for (const tenant of listed) {
            const held = await memberRoles(subject, tenant.id);
            if (held) choices.push({ id: tenant.id, name: tenant.name ?? tenant.id, roles: held.roles });
          }
          return choices;
        })()
      : undefined;
    const roles = tenantApp ? [] : await tokenable(subject);
    const nonce = randomBytes(32).toString('base64url');
    await signInState.put('oauth-consent', nonce, { sessionId: proof.sessionId, request }, pending.expiresAt, now());
    const redirect = new URL(pending.redirectUri);
    json(res, 200, {
      request,
      nonce,
      client: { id: client.clientId, name: client.name },
      redirect: { scheme: redirect.protocol.slice(0, -1), host: redirect.host },
      app: { id: app.id, name: app.name, version },
      // The page is drawn in the App's own dress, as its sign-in is: the person is answering the App.
      look: withIconGlyphs(appLook(app)),
      account: proof.identity.who,
      roles: roles ?? [],
      ...(tenants ? { tenants } : {}),
      expiresAt: pending.expiresAt,
    });
  }

  /** The person's answer: a form of this origin, from this session, for this request, once. */
  async function consent(req: IncomingMessage, res: ServerResponse) {
    const origin = req.headers.origin;
    if (req.headers['sec-fetch-site'] === 'cross-site' || typeof origin !== 'string' || !origins.has(origin)) {
      return page(res, 403, 'This answer did not come from this application’s own page.');
    }
    let params: URLSearchParams;
    try {
      params = await formParams(req, CONSENT_BODY_LIMIT);
    } catch (error) {
      return page(res, (error as Refusal).status, (error as Refusal).description);
    }
    let fields: Map<string, string>;
    try {
      fields = single(params, ['role']);
    } catch (error) {
      return page(res, 400, (error as Refusal).description);
    }
    const proof = await signedIn(req);
    if (!proof) return page(res, 401, 'Sign in to answer this request.');
    const request = fields.get('request') ?? null;
    const nonce = fields.get('nonce') ?? '';
    const held = /^[A-Za-z0-9_-]{43}$/.test(nonce)
      ? await signInState.read<{ sessionId?: unknown; request?: unknown }>('oauth-consent', nonce)
      : undefined;
    if (!held || held.sessionId !== proof.sessionId || held.request !== request) {
      return page(res, 403, 'This answer is not for this request. Start again from the application.');
    }
    // Once: a second post of the same page, or a replay of it, finds it spent.
    const spent = await signInState.consume(`oauth-consent-spent:${nonce}`, { window: REQUEST_SECONDS, max: 1 });
    await signInState.remove('oauth-consent', nonce);
    if (!spent.allowed) return page(res, 403, 'This answer was already given. Start again from the application.');
    const pending = await pendingRequest(request);
    if (!pending) return page(res, 410, 'This request has expired. Start again from the application.');
    await signInState.remove('oauth-request', request!);
    const decision = fields.get('decision');
    if (decision !== 'allow') {
      return seeOther(
        res,
        backTo(pending.redirectUri, { error: 'access_denied', error_description: 'The person declined.', state: pending.state }),
      );
    }
    const chosen = [...new Set(params.getAll('role'))];
    let membership: OAuthMembership | undefined;
    let roles: string[] | null;
    if (tenantApp) {
      // The tenant named here is only a choice: the membership is read now, and must be the person's own and active.
      const held = await memberRoles(proof.identity.id, fields.get('tenant') ?? '');
      if (!held) return page(res, 403, 'You are not an active member there. Start again from the application.');
      membership = held.membership;
      roles = held.roles;
    } else roles = await tokenable(proof.identity.id);
    if (!roles) return page(res, 403, 'This account may not give a token.');
    if (!chosen.length || chosen.some((role) => !roles.includes(role))) {
      return page(res, 400, 'Choose at least one of the roles offered. Start again from the application.');
    }
    const code = mintOAuthCode();
    const at = now();
    const issued = await store((t) =>
      issueCode(t, {
        codeDigest: oauthDigest(code),
        clientId: pending.clientId,
        subject: proof.identity.id,
        redirectUri: pending.redirectUri,
        challenge: pending.challenge,
        appId: app.id,
        version,
        roles: chosen,
        ...(membership ? { tenant: membership } : {}),
        expiresAt: at + OAUTH_CODE_SECONDS * 1000,
        now: at,
      }),
    );
    if (issued !== 'issued') return page(res, 410, 'This application is no longer registered. Start again from it.');
    seeOther(res, backTo(pending.redirectUri, { code, state: pending.state }));
  }

  async function token(req: IncomingMessage, res: ServerResponse) {
    const budget = await spend(req, 'token');
    if (!budget.allowed) return tooMany(res, budget.retryAfter);
    const fields = single(await formParams(req, BODY_LIMIT));
    const clientId = fields.get('client_id') ?? '';
    const client = /^twc1\.[0-9a-f-]{36}$/.test(clientId) ? await store((t) => readClient(t, clientId)) : null;
    if (!client) throw new Refusal(401, 'invalid_client', 'The client is not registered here.');
    if (fields.has('resource') && !resourceIsOurs(fields.get('resource'))) {
      throw new Refusal(400, 'invalid_target', `resource is this App's API: ${resources.mcp} or ${resources.rest}.`);
    }
    const grantType = fields.get('grant_type');
    const at = now();
    let answer;
    if (grantType === 'authorization_code') {
      const code = fields.get('code');
      if (!code || code.length > 128) throw new Refusal(400, 'invalid_request', 'code is required.');
      const codeDigest = oauthDigest(code);
      const membership = await observed(tenantApp ? await store((t) => peekBinding(t, { codeDigest })) : null);
      answer = await store((t) =>
        exchangeCode(t, grantIssuer, {
          codeDigest,
          clientId,
          redirectUri: fields.get('redirect_uri'),
          verifier: fields.get('code_verifier'),
          ...(membership !== undefined ? { membership } : {}),
          now: at,
        }),
      );
    } else if (grantType === 'refresh_token') {
      const refresh = fields.get('refresh_token');
      if (!refresh || refresh.length > 256) throw new Refusal(400, 'invalid_request', 'refresh_token is required.');
      const membership = await observed(tenantApp ? await store((t) => peekBinding(t, { refreshToken: refresh })) : null);
      answer = await store((t) =>
        refreshGrant(t, grantIssuer, { refreshToken: refresh, clientId, ...(membership !== undefined ? { membership } : {}), now: at }),
      );
    } else throw new Refusal(400, 'unsupported_grant_type', 'grant_type is "authorization_code" or "refresh_token".');
    if ('error' in answer) throw new Refusal(answer.error === 'invalid_client' ? 401 : 400, answer.error, answer.description);
    json(
      res,
      200,
      {
        access_token: answer.accessToken,
        token_type: 'Bearer',
        expires_in: answer.expiresIn,
        refresh_token: answer.refreshToken,
      },
      open,
    );
  }

  async function revoke(req: IncomingMessage, res: ServerResponse) {
    const fields = single(await formParams(req, BODY_LIMIT));
    const clientId = fields.get('client_id') ?? '';
    const client = /^twc1\.[0-9a-f-]{36}$/.test(clientId) ? await store((t) => readClient(t, clientId)) : null;
    if (!client) throw new Refusal(401, 'invalid_client', 'The client is not registered here.');
    const given = fields.get('token');
    if (!given) throw new Refusal(400, 'invalid_request', 'token is required.');
    if (given.length <= 256) await store((t) => revokeToken(t, { token: given, clientId, appId: app.id, now: now() }));
    // Revoked, or never this client's: the same answer either way (RFC 7009 §2.2).
    json(res, 200, {}, open);
  }

  /** The person's own connected clients, as the profile page lists them: a request of this origin with their session. */
  async function grants(req: IncomingMessage, res: ServerResponse, revoking: boolean) {
    const origin = req.headers.origin;
    if (
      req.headers['sec-fetch-site'] === 'cross-site' ||
      (origin !== undefined && !origins.has(origin)) ||
      (revoking && origin === undefined)
    ) {
      return json(res, 403, { error: 'forbidden', error_description: 'Requests come from this application.' });
    }
    const proof = await signedIn(req);
    if (!proof) return json(res, 401, { error: 'unauthenticated', error_description: 'Sign in to see your connected clients.' });
    const subject = proof.identity.id;
    if (revoking) {
      if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
        return json(res, 415, { error: 'invalid_request', error_description: 'The request is JSON.' });
      }
      const body = await readBody(req, 4096);
      let grantId: unknown;
      try {
        grantId = (JSON.parse(body?.toString('utf8') ?? '') as { grantId?: unknown }).grantId;
      } catch {
        grantId = undefined;
      }
      if (typeof grantId !== 'string') return json(res, 400, { error: 'invalid_request', error_description: 'Name the grant to revoke.' });
      const revoked = await store((t) => revokeOwnGrant(t, { subject, grantId, now: now() }));
      if (!revoked) return json(res, 404, { error: 'not_found', error_description: 'That client is not connected.' });
    }
    const list = await store((t) => listGrants(t, { subject, appId: app.id, now: now() }));
    json(res, 200, { grants: list });
  }

  return Object.freeze({
    /** One request under `<base>/api/auth/oauth`; `route` is what follows it. */
    async handle(req: IncomingMessage, res: ServerResponse, route: string): Promise<void> {
      const url = new URL(req.url ?? '/', origin);
      const method = req.method ?? 'GET';
      const cross = route === '/register' || route === '/token' || route === '/revoke';
      try {
        if (cross && method === 'OPTIONS') {
          res.writeHead(204, {
            ...open,
            'access-control-allow-methods': 'POST',
            'access-control-allow-headers': 'content-type',
            'access-control-max-age': '600',
            'cache-control': 'no-store',
          });
          res.end();
          return;
        }
        if (route === '/authorize' && method === 'GET') return await authorize(req, res, url);
        if (route === '/consent' && method === 'GET') return await consentView(req, res, url);
        if (route === '/consent' && method === 'POST') return await consent(req, res);
        if (route === '/register' && method === 'POST') return await register(req, res);
        if (route === '/token' && method === 'POST') return await token(req, res);
        if (route === '/revoke' && method === 'POST') return await revoke(req, res);
        if (route === '/grants' && method === 'GET') return await grants(req, res, false);
        if (route === '/grants/revoke' && method === 'POST') return await grants(req, res, true);
        json(res, 404, { error: 'not_found' });
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        if (error instanceof Refusal) {
          return json(res, error.status, { error: error.code, error_description: error.description }, cross ? open : {});
        }
        json(
          res,
          503,
          { error: 'temporarily_unavailable', error_description: 'The authorization server could not answer.' },
          cross ? open : {},
        );
      }
    },
  });
}
