/**
 * The resource side of the OAuth authorization server: what an App's API
 * tells a client that arrives without a token it accepts, and the two
 * metadata documents a client discovers the server by.
 *
 * Kept apart from the server itself (oauthServer.ts, loaded only where the
 * config file names one), so the API transports can say where to get a token
 * without loading anything of it. A runtime the config's server issues for is
 * bound here at startup (auth.ts); every other runtime answers a plain
 * `Bearer` challenge, exactly as before, and serves no metadata.
 *
 *   401  WWW-Authenticate: Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/api/apps/compass/v1/$mcp"
 *   GET  /.well-known/oauth-protected-resource/api/apps/compass/v1/$mcp       (RFC 9728)
 *   GET  /.well-known/oauth-authorization-server/api/auth                       (RFC 8414)
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OAuthTenancy } from './oauthServer.js';

interface OAuthResourceBinding {
  /** The public origin, `https://host`. */
  origin: string;
  /** The server's base path, '' or `/tools`. */
  under: string;
  appId: string;
  version: number;
}
const bindings = new WeakMap<object, Readonly<OAuthResourceBinding>>();

/** Startup only (auth.ts): this runtime's App takes tokens the deployment's authorization server issues. */
export function bindOAuthResource(runtime: object, binding: OAuthResourceBinding): void {
  bindings.set(runtime, Object.freeze({ ...binding }));
}

/* A tenant App's memberships, as its authorization server reads them: bound by the tenant host once it reads
   them (tenant/tenantAuthenticatedHttp.ts), and until then that server gives a tenant App no token. A host made
   again over the same runtime replaces the last one's, which fails closed once that host retires. */
const tenancies = new WeakMap<object, OAuthTenancy>();
export function bindOAuthTenancy(runtime: object, tenancy: OAuthTenancy): void {
  tenancies.set(runtime, Object.freeze({ tenants: tenancy.tenants, membership: tenancy.membership }));
}
export const oauthTenancyOf = (runtime: object): OAuthTenancy | undefined => tenancies.get(runtime);

const bindingOf = (auth: unknown) => (auth && typeof auth === 'object' ? bindings.get(auth) : undefined);

/** The authorization server's identifier: Better Auth's base, where its endpoints are. */
export const oauthIssuer = (origin: string, under: string): string => `${origin}${under}/api/auth`;

/** The App API's two resources, as a token is bound to them: its REST base and its MCP endpoint. */
export function oauthResources(origin: string, under: string, appId: string, version: number): Readonly<{ rest: string; mcp: string }> {
  const rest = `${origin}${under}/api/apps/${encodeURIComponent(appId)}/v${version}`;
  return Object.freeze({ rest, mcp: `${rest}/$mcp` });
}

/**
 * The challenge a 401 carries: plain `Bearer` for an App no authorization
 * server issues for; otherwise where its resource metadata is, and, when a
 * token was presented and refused, that it was the token (RFC 6750 §3.1).
 */
export function bearerChallenge(auth: unknown, transport: 'rest' | 'mcp', presented: boolean): string {
  const binding = bindingOf(auth);
  if (!binding) return 'Bearer';
  const resource = oauthResources(binding.origin, binding.under, binding.appId, binding.version)[transport];
  const path = resource.slice(binding.origin.length);
  return `Bearer resource_metadata="${binding.origin}/.well-known/oauth-protected-resource${path}"${presented ? ', error="invalid_token"' : ''}`;
}

/** Whether the request presented a credential at all: a refused one is `invalid_token`, an absent one is not. */
export const presentsAuthorization = (req: IncomingMessage): boolean => req.headers.authorization !== undefined;

/** The authorization server's metadata (RFC 8414). */
function oauthServerMetadata(origin: string, under: string): Readonly<Record<string, unknown>> {
  const issuer = oauthIssuer(origin, under);
  return Object.freeze({
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    authorization_response_iss_parameter_supported: true,
  });
}

const answer = (res: ServerResponse, status: number, body?: unknown) => {
  const text = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': status === 200 ? 'public, max-age=300' : 'no-store',
    'access-control-allow-origin': '*',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
};

/**
 * The two well-known documents, before the base path is read (server.ts):
 * the suffix is inserted after the origin, so `/.well-known/…/tools/api/auth`
 * is outside a `/tools` base. True when it answered. Any other address
 * under either prefix is a 404, bound or not: a client probing for an
 * authorization server is told there is none, never handed the App's page.
 */
export function answerOAuthWellKnown(auth: unknown, req: IncomingMessage, res: ServerResponse, pathname: string): boolean {
  if (!pathname.startsWith('/.well-known/oauth-authorization-server') && !pathname.startsWith('/.well-known/oauth-protected-resource')) {
    return false;
  }
  const binding = bindingOf(auth);
  if (!binding) {
    answer(res, 404, { error: 'not_found' });
    return true;
  }
  const { origin, under } = binding;
  const resources = oauthResources(origin, under, binding.appId, binding.version);
  const document =
    pathname === `/.well-known/oauth-authorization-server${under}/api/auth` || pathname === '/.well-known/oauth-authorization-server'
      ? oauthServerMetadata(origin, under)
      : [resources.rest, resources.mcp].includes(`${origin}${pathname.slice('/.well-known/oauth-protected-resource'.length)}`) &&
          pathname.startsWith('/.well-known/oauth-protected-resource/')
        ? {
            // Exactly the URL the suffix was inserted into (RFC 9728 §3.3).
            resource: `${origin}${pathname.slice('/.well-known/oauth-protected-resource'.length)}`,
            authorization_servers: [oauthIssuer(origin, under)],
            bearer_methods_supported: ['header'],
          }
        : undefined;
  if (!document) {
    answer(res, 404, { error: 'not_found' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET',
      'access-control-max-age': '600',
      'cache-control': 'no-store',
    });
    res.end();
    return true;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET');
    answer(res, 405, { error: 'method_not_allowed' });
    return true;
  }
  answer(res, 200, document);
  return true;
}
