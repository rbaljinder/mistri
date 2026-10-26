/**
 * The assertion a host signs for the person in front of it, verified.
 *
 * A JWT, short-lived and single-use: `iss` an issuer the config file trusts,
 * `aud` this App's id, `sub` the host's own id for the person, `jti` once
 * only, `iat` and `exp` at most five minutes apart, and `origin` the browser
 * origin the host's page is on — the exchange is refused from any other, so
 * an assertion lifted from one page cannot be spent from another. `email`,
 * `email_verified` and `name` say who the person is; `roles` counts only
 * where the issuer maps it (issuerConfig.ts).
 *
 * The signature is checked by jose, the copy Better Auth itself verifies
 * with (auth.ts), with the algorithm pinned by the key the issuer has: HS256
 * for a secret, ES256 or EdDSA for a JWKS. `none`, and an HMAC made with a
 * public key, are refused by that pin.
 */
import type { Jose } from '../auth/identityProviders.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { MAX_ASSERTION_LIFETIME_S, type EmbedIssuerConfig } from './issuerConfig.js';

/** Clock skew between the host and this server. */
const ASSERTION_CLOCK_SKEW_S = 30;
const HMAC = ['HS256'];
const ASYMMETRIC = ['ES256', 'EdDSA'];

/** A refused exchange: the status it answers, a code the client can read, and a sentence. */
export class EmbedRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** Seconds to wait, for a refusal that is a spent budget. */
    readonly retryAfter?: number,
  ) {
    super(message);
  }
}

/** One issuer, with the key it verifies by: read once, at startup. */
export interface EmbedIssuer {
  readonly config: EmbedIssuerConfig;
  readonly key: unknown;
  readonly algorithms: readonly string[];
}

/**
 * Each issuer's key, from the environment or its JWKS. A secret that is not
 * set, or shorter than 32 bytes, is refused here, at startup, as
 * BETTER_AUTH_SECRET is: an HS256 key that short can be guessed offline from
 * one assertion.
 */
export function embedIssuers(configs: readonly EmbedIssuerConfig[], jose: Jose, env: NodeJS.ProcessEnv, where: string): EmbedIssuer[] {
  return configs.map((config) => {
    if (config.jwks) {
      return Object.freeze({
        config,
        key: jose.createRemoteJWKSet(new URL(config.jwks), { timeoutDuration: 5_000, cooldownDuration: 30_000 }),
        algorithms: ASYMMETRIC,
      });
    }
    let secret: string;
    try {
      secret = expandEnvReferences(config.secret!, env);
    } catch {
      throw new Error(`${where}: the host "${config.name}" signs with ${config.secret}, which is not set. Export it, at least 32 bytes.`);
    }
    if (Buffer.byteLength(secret, 'utf8') < 32) {
      throw new Error(
        `${where}: the host "${config.name}" signs with ${config.secret}, which is shorter than 32 bytes. Generate one: \`openssl rand -base64 32\`.`,
      );
    }
    return Object.freeze({ config, key: new TextEncoder().encode(secret), algorithms: HMAC });
  });
}

/** What a verified assertion says about the person. */
export interface EmbedAssertion {
  readonly issuer: EmbedIssuer;
  readonly subject: string;
  readonly jti: string;
  readonly expiresAt: number;
  readonly email?: string;
  readonly emailVerified: boolean;
  readonly name?: string;
  /** The App roles the issuer's mapping gives: empty where it maps none, whatever the claim said. */
  readonly roles: readonly string[];
}

const refuse = (code: string, message: string): never => {
  throw new EmbedRefusal(401, code, message);
};

/** The `iss` an assertion claims, read before its signature so the right key can check it; trusted for nothing else. */
function claimedIssuer(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) refuse('assertion_malformed', 'That is not a signed assertion.');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    refuse('assertion_malformed', 'That is not a signed assertion.');
  }
  const iss = (payload as { iss?: unknown } | null)?.iss;
  return typeof iss === 'string' ? iss : refuse('assertion_issuer', 'The assertion names no issuer.');
}

const plainText = (value: unknown, max: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value);

/**
 * Verify one assertion for `appId`, presented from `origin`. Throws an
 * EmbedRefusal naming the first thing wrong. `admit` is asked as soon as the
 * claimed issuer is known, before any key work (the exchange's budget, per
 * issuer and client); `spend` only once the signature and every claim hold,
 * so a forged assertion cannot use up a real one's id.
 */
export async function verifyEmbedAssertion(
  token: string,
  input: {
    readonly appId: string;
    readonly origin: string;
    readonly issuers: readonly EmbedIssuer[];
    readonly jose: Jose;
    /** Refuse (throw) before the signature is checked: a budget. */
    readonly admit?: (issuer: EmbedIssuer) => Promise<void>;
    /** Spend `jti` for `issuer` until `until` (epoch ms): true the first time, false for a replay. */
    readonly spend: (issuer: EmbedIssuer, jti: string, until: number) => Promise<boolean>;
    readonly now?: number;
  },
): Promise<EmbedAssertion> {
  if (typeof token !== 'string' || !token || token.length > 8192) refuse('assertion_malformed', 'That is not a signed assertion.');
  const iss = claimedIssuer(token);
  const issuer = input.issuers.find((candidate) => candidate.config.issuer === iss);
  if (!issuer) refuse('assertion_issuer', 'This App trusts no host by that issuer.');
  const { config } = issuer!;
  await input.admit?.(issuer!);
  const now = input.now ?? Date.now();
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await input.jose.jwtVerify(token, issuer!.key, {
      issuer: config.issuer,
      audience: input.appId,
      algorithms: [...issuer!.algorithms],
      clockTolerance: ASSERTION_CLOCK_SKEW_S,
      maxTokenAge: MAX_ASSERTION_LIFETIME_S + ASSERTION_CLOCK_SKEW_S,
      requiredClaims: ['iss', 'aud', 'sub', 'jti', 'iat', 'exp'],
      currentDate: new Date(now),
    }));
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ERR_JWT_EXPIRED') refuse('assertion_expired', 'The assertion has expired. Ask the host for a fresh one.');
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      const claim = (error as { claim?: unknown }).claim;
      if (claim === 'aud') refuse('assertion_audience', 'The assertion is for another App.');
      if (claim === 'iss') refuse('assertion_issuer', 'This App trusts no host by that issuer.');
      if (claim === 'iat' || claim === 'nbf') refuse('assertion_expired', 'The assertion is too old, or from the future.');
      refuse('assertion_claims', `The assertion lacks "${String(claim)}".`);
    }
    if (code === 'ERR_JWKS_TIMEOUT' || code === 'ERR_JOSE_GENERIC' || code === 'ERR_JWKS_INVALID') {
      throw new EmbedRefusal(503, 'issuer_keys_unavailable', "The host's keys could not be read. Try again shortly.");
    }
    refuse('assertion_signature', 'The assertion is not signed by the host this App trusts.');
  }
  const iat = payload!.iat as number;
  const exp = payload!.exp as number;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat || exp - iat > MAX_ASSERTION_LIFETIME_S) {
    refuse('assertion_lifetime', `An assertion lives at most ${MAX_ASSERTION_LIFETIME_S} seconds, from "iat" to "exp".`);
  }
  if (iat * 1000 > now + ASSERTION_CLOCK_SKEW_S * 1000) refuse('assertion_expired', 'The assertion is from the future.');
  if (payload!.origin !== input.origin || !config.origins.includes(input.origin)) {
    refuse('assertion_origin', 'The assertion was not made for the page that presented it.');
  }
  const subject = payload!.sub;
  const jti = payload!.jti;
  if (!plainText(subject, 255)) refuse('assertion_claims', 'The assertion\'s "sub" is not an id.');
  if (!plainText(jti, 255)) refuse('assertion_claims', 'The assertion\'s "jti" is not an id.');
  const email = payload!.email;
  if (email !== undefined && (!plainText(email, 320) || !/^[^\s@]+@[^\s@]+$/.test(email))) {
    refuse('assertion_claims', 'The assertion\'s "email" is not an address.');
  }
  const name = plainText(payload!.name, 256) ? (payload!.name as string) : undefined;
  /* The roles claim is the host's word, and counts only through the mapping
     the operator wrote for this issuer: absent, it is not read at all. */
  const claimed = Array.isArray(payload!.roles) ? (payload!.roles as unknown[]).filter((role) => typeof role === 'string') : [];
  const roles = config.roles
    ? Object.keys(config.roles).filter((role) => config.roles![role].some((value) => claimed.includes(value)))
    : [];
  /* Spent last: once per assertion across every instance that shares the
     auth store (ledger.ts), kept until it would have expired anyway. */
  const spent = await input.spend(issuer!, jti as string, exp * 1000 + ASSERTION_CLOCK_SKEW_S * 1000);
  if (!spent) refuse('assertion_replayed', 'This assertion was already used. Ask the host for a fresh one.');
  return Object.freeze({
    issuer: issuer!,
    subject: subject as string,
    jti: jti as string,
    expiresAt: exp * 1000,
    ...(email !== undefined ? { email: (email as string).toLowerCase() } : {}),
    emailVerified: payload!.email_verified === true,
    ...(name ? { name } : {}),
    roles: Object.freeze(roles),
  });
}
