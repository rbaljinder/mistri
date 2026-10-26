/**
 * The small request-level rules `createAppAuth` applies around Better Auth: which
 * admin paths stay closed, the loopback-only test seam that lifts the per-address
 * limits, and the work-email home-realm lookup. None needs the auth instance.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { domainOf } from './identityProviders.js';
import type { FederatedProviderConfig } from './identityConfig.js';

/** Whether a path under an App's mount reaches Better Auth's admin endpoints, however it is spelled:
 * decoded, its separators collapsed and its case folded, as a router that normalizes might read it.
 * One that will not decode is treated as one. */
export function nativeAdminPath(path: string): boolean {
  let plain: string;
  try {
    plain = decodeURIComponent(path);
  } catch {
    return true;
  }
  const folded = plain.replace(/\/+/g, '/').toLowerCase();
  return folded === '/api/auth/admin' || folded.startsWith('/api/auth/admin/');
}

/* Better Auth's admin endpoints that change an account, or sign in as one, around the App's account administration. */
const CLOSED_NATIVE_ADMIN = new Set([
  'set-role',
  'ban-user',
  'unban-user',
  'set-user-password',
  'update-user',
  'remove-user',
  'impersonate-user',
]);

/** Whether `path` (under the App's mount) is one of those endpoints, however it is spelled. */
export function closedNativeAdminPath(path: string): boolean {
  if (!nativeAdminPath(path)) return false;
  let plain: string;
  try {
    plain = decodeURIComponent(path);
  } catch {
    return true;
  }
  const folded = plain.replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase();
  return CLOSED_NATIVE_ADMIN.has(folded.slice('/api/auth/admin/'.length));
}

/** The test seam that lifts Better Auth's per-address limits (the per-account lockout stays). */
export const TEST_AUTH_LIMITS = 'MISTRI_TEST_AUTH_LIMITS';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i;

/**
 * Whether `MISTRI_TEST_AUTH_LIMITS=off` turns Better Auth's per-address
 * limits off: only for a server that listens on loopback, where every client
 * is this machine and the test suites sign in hundreds of times from one
 * address. Beyond loopback it is ignored, and said, so no deployment can carry
 * it into production by an environment file.
 */
export function authLimitsOffForTests(listenHost: string): boolean {
  if (process.env[TEST_AUTH_LIMITS] !== 'off') return false;
  if (LOOPBACK_HOST.test(listenHost)) return true;
  console.error(
    `mistri: ${TEST_AUTH_LIMITS}=off is ignored: this server listens on ${listenHost}, beyond this machine, so sign-in limits stay on.`,
  );
  return false;
}

/**
 * "Sign in with your work email" (`oidc.tenants()`, `saml.tenants()`): which
 * tenant's own provider an address belongs to, by its domain. The answer is
 * the provider's name and kind to start a sign-in with, or null, and nothing
 * else: not the tenant, not the issuer. A signed-out visitor who asks learns
 * whether a domain has one, which the redirect it leads to would say anyway.
 */
export function homeRealm(tenants: readonly FederatedProviderConfig[]) {
  const byDomain = new Map(
    tenants.flatMap((config) => (config.domains ?? []).map((domain) => [domain, { name: config.name, kind: config.kind }] as const)),
  );
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const send = (status: number, body: unknown) => {
      res.statusCode = status;
      res.setHeader('content-type', 'application/json');
      res.setHeader('cache-control', 'no-store');
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST') return send(405, { error: 'POST an email.' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > 2048) return send(413, { error: 'That is not one email.' });
      chunks.push(chunk as Buffer);
    }
    let email: unknown;
    try {
      email = (JSON.parse(Buffer.concat(chunks).toString('utf8')) as { email?: unknown }).email;
    } catch {
      /* said below */
    }
    if (typeof email !== 'string' || email.length > 320 || !/^[^\s@]+@[^\s@]+$/.test(email.trim()))
      return send(400, { error: 'Enter an email address.' });
    const found = byDomain.get(domainOf(email.trim()));
    send(200, found ? { provider: found.name, kind: found.kind } : { provider: null });
  };
}
