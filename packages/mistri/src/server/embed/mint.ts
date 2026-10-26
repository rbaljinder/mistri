/**
 * The host's side: one short-lived signed statement of who is here, for
 * `POST <App>/api/auth/embed/exchange` (exchange.ts). Server-only — the key
 * that signs it is the host's secret, so it imports node:crypto and refuses
 * to run where there is a `window`.
 *
 * A string key signs HS256 (the issuer's "secret"); a private KeyObject
 * signs ES256 (P-256) or EdDSA (Ed25519), whose public half the host
 * publishes at its "jwks". Any JWT library makes the same token: this is the
 * few lines it takes without one.
 */
import { createHmac, randomUUID, sign, type KeyObject } from 'node:crypto';
import { MAX_ASSERTION_LIFETIME_S } from './issuerConfig.js';

export interface EmbedAssertionInput {
  /** The issuer's `issuer`, exactly as the App's config file names it. */
  readonly issuer: string;
  /** The HS256 secret, or a private P-256 / Ed25519 key. */
  readonly key: string | KeyObject;
  /** The App's id: the assertion's `aud`. */
  readonly app: string;
  /** The browser origin of the page that will present it, one of the issuer's `origins`. */
  readonly origin: string;
  /** The host's own id for the person: stable, never an email. */
  readonly subject: string;
  readonly email?: string;
  /** Say true only where the host proved the address: an account linked by email trusts it. */
  readonly emailVerified?: boolean;
  readonly name?: string;
  /** The host's roles, read only where the issuer maps them to the App's. */
  readonly roles?: readonly string[];
  /** Default 60, at most 300. */
  readonly ttlSeconds?: number;
  /** Key id, when the JWKS has several. */
  readonly kid?: string;
}

const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

export async function mintEmbedAssertion(input: EmbedAssertionInput): Promise<string> {
  if (typeof (globalThis as { window?: unknown }).window !== 'undefined') {
    throw new Error("mintEmbedAssertion runs on the host's server: its key must never reach a browser.");
  }
  const ttl = input.ttlSeconds ?? 60;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > MAX_ASSERTION_LIFETIME_S) {
    throw new Error(`ttlSeconds is a whole number of seconds from 1 to ${MAX_ASSERTION_LIFETIME_S}.`);
  }
  const alg =
    typeof input.key === 'string'
      ? 'HS256'
      : input.key.asymmetricKeyType === 'ec' && input.key.asymmetricKeyDetails?.namedCurve === 'prime256v1'
        ? 'ES256'
        : input.key.asymmetricKeyType === 'ed25519'
          ? 'EdDSA'
          : undefined;
  if (!alg || (typeof input.key !== 'string' && input.key.type !== 'private')) {
    throw new Error('The key is an HS256 secret, or a private P-256 or Ed25519 key.');
  }
  const iat = Math.floor(Date.now() / 1000);
  const header = part({ alg, typ: 'JWT', ...(input.kid ? { kid: input.kid } : {}) });
  const payload = part({
    iss: input.issuer,
    aud: input.app,
    sub: input.subject,
    origin: input.origin,
    jti: randomUUID(),
    iat,
    exp: iat + ttl,
    ...(input.email !== undefined ? { email: input.email } : {}),
    ...(input.emailVerified !== undefined ? { email_verified: input.emailVerified } : {}),
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.roles !== undefined ? { roles: [...input.roles] } : {}),
  });
  const signed = `${header}.${payload}`;
  const signature =
    typeof input.key === 'string'
      ? createHmac('sha256', input.key).update(signed).digest()
      : alg === 'ES256'
        ? sign('sha256', Buffer.from(signed), { key: input.key, dsaEncoding: 'ieee-p1363' })
        : sign(null, Buffer.from(signed), input.key);
  return `${signed}.${signature.toString('base64url')}`;
}
