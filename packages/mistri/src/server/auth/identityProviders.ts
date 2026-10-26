/**
 * Sign-in through an OpenID Connect provider: Microsoft Entra ID and External
 * ID, Okta, Auth0, Keycloak, Cognito, Google Workspace — whatever publishes a
 * discovery document. Each is a Better Auth social provider that this file
 * builds, rather than Better Auth's generic-oauth plugin, because what it
 * must refuse is mistri's to decide:
 *
 *   - the ID token is required, and verified here: its signature against the
 *     provider's published keys (never `none`, never a shared-secret HMAC),
 *     its issuer exactly, its audience and `azp`, its age and expiry with a
 *     minute of clock skew, and the nonce this sign-in sent;
 *   - the authorization code is exchanged with PKCE, and the state Better
 *     Auth keeps is single-use; an ID token a browser offers directly is
 *     refused (`disableIdTokenSignIn`): there is no nonce to bind it to;
 *   - the access and refresh tokens are never kept. Nothing here calls the
 *     provider after sign-in, so nothing that could is stored;
 *   - an email is verified only when the token says `email_verified: true`,
 *     or the config says the provider asserts verified addresses. That is
 *     what linking to an existing account and just-in-time sign-up by
 *     domain trust (identityRoles.ts, auth.ts);
 *   - a tenant's own provider may assert only addresses in its domains.
 *
 * Discovery is asked for on first use and kept for a day; an issuer that does
 * not answer fails that sign-in, not the server, and is asked again next time.
 */
import { timingSafeEqual } from 'node:crypto';
import type { AppProvider } from '../../shared/appModel.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import type { FederatedProviderConfig, IdentityProviderConfig } from './identityConfig.js';

/** The slice of jose this reads: a remote key set, and verification against it. */
export interface Jose {
  createRemoteJWKSet(url: URL, options?: { timeoutDuration?: number; cooldownDuration?: number }): unknown;
  jwtVerify(
    token: string,
    key: unknown,
    options: Record<string, unknown>,
  ): Promise<{ payload: Record<string, unknown>; protectedHeader?: Record<string, unknown> }>;
}

/** What one verified sign-in through a provider established, for the hooks that judge it (identityRoles.ts). */
export interface SignInEvidence {
  provider: FederatedProviderConfig;
  /** How `auth.providers` names it: `oidc:<name>` or `saml:<name>`, or `oidc:*` / `saml:*` for a tenant's own. */
  token: AppProvider;
  claims: Readonly<Record<string, unknown>>;
  email: string | undefined;
  emailVerified: boolean;
  /** Who the provider says this is: the token's `iss` and `sub`, or the assertion's Issuer and NameID. */
  issuer: string;
  subject: string;
  /** The provider's own session: an ID token's `sid`, a SAML SessionIndex. Back-channel logout finds sessions by it. */
  sid?: string;
  sessionIndex?: string;
  /** Set when this sign-in made the account (user.create.before). */
  created?: true;
}

/** Signing algorithms an ID token may use: asymmetric only, so the client secret can never sign one. */
const ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
/** Clock skew between this server and the provider, in seconds. */
const CLOCK_SKEW_S = 60;
/** An ID token straight from the token endpoint is minutes old at most; an older one is a replay. */
const MAX_TOKEN_AGE_S = 600;
const DISCOVERY_TTL_MS = 24 * 3600_000;
/** The event a logout token carries (OpenID Connect Back-Channel Logout 1.0, 2.4). */
const LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';
const FETCH_MS = 10_000;
/** The one parameter a browser may add to a sign-in: ask the provider to authenticate afresh (a step-up). */
const STEP_UP_PARAM = 'mistri_step_up';

interface Discovered {
  authorization: string;
  token: string;
  jwks: unknown;
  algorithms: string[];
  basic: boolean;
  at: number;
}

/** The claim values a rule names: an exact claim first (`https://example.com/roles` has dots), else a dotted path. */
export function claimValues(claims: Readonly<Record<string, unknown>>, name: string): string[] {
  let value: unknown = Object.hasOwn(claims, name) ? claims[name] : undefined;
  if (value === undefined && name.includes('.')) {
    value = name
      .split('.')
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === 'object' && !Array.isArray(node) && Object.hasOwn(node, part)
            ? (node as Record<string, unknown>)[part]
            : undefined,
        claims,
      );
  }
  if (typeof value === 'string') return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** RFC 8176 methods: `mfa` says so outright; two distinct factors say it too. */
const FACTORS: Record<string, string> = {
  pwd: 'know',
  pin: 'know',
  kba: 'know',
  otp: 'have',
  sms: 'have',
  tel: 'have',
  hwk: 'have',
  swk: 'have',
  sc: 'have',
  fpt: 'are',
  face: 'are',
  iris: 'are',
  retina: 'are',
  vbm: 'are',
};
export function showsMfa(claims: Readonly<Record<string, unknown>>, provider: Pick<IdentityProviderConfig, 'mfa'>): boolean {
  const amr = claimValues(claims, 'amr');
  if (amr.includes('mfa')) return true;
  if (new Set(amr.map((method) => FACTORS[method]).filter(Boolean)).size >= 2) return true;
  return typeof claims.acr === 'string' && (provider.mfa ?? []).includes(claims.acr);
}

/**
 * When this sign-in counts as a recent one for a step-up (the five minutes
 * opening a support session needs): the moment the provider authenticated the
 * person (`auth_time`), not the moment mistri made the session, since a
 * provider that signs someone in silently from its own session asked them
 * nothing. A provider whose config lists `mfa` counts only a sign-in that
 * shows more than one factor. Null: this sign-in does not count, and the
 * step-up asks again, at the provider, for a fresh authentication.
 */
export function stepUpInstant(claims: Readonly<Record<string, unknown>>, provider: Pick<IdentityProviderConfig, 'mfa'>): number | null {
  const authTime = claims.auth_time;
  if (typeof authTime !== 'number' || !Number.isFinite(authTime) || authTime <= 0) return null;
  if (provider.mfa?.length && !showsMfa(claims, provider)) return null;
  return Math.floor(authTime * 1000);
}

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export const domainOf = (email: string | undefined) => email?.slice(email.lastIndexOf('@') + 1).toLowerCase() ?? '';

/** A name worth showing: one short line. Anything else is left for the email to stand in for. */
const sayable = (name: unknown) =>
  typeof name === 'string' && name.trim() && name.length <= 256 && !/\p{Cc}/u.test(name) ? name.trim() : undefined;

interface ProviderOptions {
  environment?: NodeJS.ProcessEnv;
  jose: Jose;
  /** Better Auth's endpoint context of this request, where a sign-in's evidence waits for the hooks. */
  current: () => object | undefined;
  evidence: WeakMap<object, SignInEvidence>;
  /** Whether this provider may make an account at a first sign-in (the hooks judge the rest). */
  signUp: (token: AppProvider) => boolean;
  where: string;
}

/** A Better Auth social provider for one configured identity provider. */
export function oidcProvider(config: IdentityProviderConfig, options: ProviderOptions) {
  const { jose, where } = options;
  const token: AppProvider = config.tenant === undefined ? `oidc:${config.name}` : 'oidc:*';
  const said = `${where}: identity provider "${config.name}"`;
  /* References are read when the provider is first used, as a connection's
     are when it opens: an unset one fails that sign-in, naming the variable. */
  const issuer = () => expandEnvReferences(config.issuer, options.environment);
  const clientId = () => expandEnvReferences(config.clientId, options.environment);
  const secret = () => (config.clientSecret === undefined ? undefined : expandEnvReferences(config.clientSecret, options.environment));
  const scheme = (value: string, key: string) => {
    const url = new URL(value);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && config.insecure))
      throw new Error(`${said}: its discovery document gives an ${url.protocol}// ${key}.`);
    return url.href;
  };
  let discovered: Promise<Discovered> | undefined;
  const discover = (): Promise<Discovered> => {
    const cached = discovered;
    if (cached) return cached.then((found) => (Date.now() - found.at < DISCOVERY_TTL_MS ? found : ((discovered = undefined), discover())));
    const asked = (discovered = (async () => {
      const iss = issuer();
      const url = config.discovery
        ? expandEnvReferences(config.discovery, options.environment)
        : `${iss.replace(/\/+$/, '')}/.well-known/openid-configuration`;
      const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
      if (!res.ok) throw new Error(`${said}: its discovery document (${url}) answered ${res.status}.`);
      const doc = (await res.json()) as Record<string, unknown>;
      /* The issuer the document names is the one every token must carry,
         exactly: a document that names another describes another provider. */
      if (doc.issuer !== iss)
        throw new Error(
          `${said}: its discovery document names the issuer ${JSON.stringify(doc.issuer)}, and the config says "${iss}". They must be the same, exactly.`,
        );
      for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
        if (typeof doc[key] !== 'string') throw new Error(`${said}: its discovery document has no "${key}".`);
      }
      const offered = Array.isArray(doc.id_token_signing_alg_values_supported)
        ? (doc.id_token_signing_alg_values_supported as unknown[])
        : ['RS256'];
      const algorithms = ALGORITHMS.filter((alg) => offered.includes(alg));
      if (!algorithms.length)
        throw new Error(`${said}: it signs ID tokens only with ${offered.join(', ')}; mistri accepts ${ALGORITHMS.join(', ')}.`);
      const methods = Array.isArray(doc.token_endpoint_auth_methods_supported)
        ? (doc.token_endpoint_auth_methods_supported as unknown[])
        : ['client_secret_basic'];
      return {
        authorization: scheme(doc.authorization_endpoint as string, 'authorization_endpoint'),
        token: scheme(doc.token_endpoint as string, 'token_endpoint'),
        jwks: jose.createRemoteJWKSet(new URL(scheme(doc.jwks_uri as string, 'jwks_uri')), { timeoutDuration: FETCH_MS }),
        algorithms,
        basic: methods.includes('client_secret_basic') || !methods.includes('client_secret_post'),
        at: Date.now(),
      };
    })());
    // A provider that did not answer is asked again next time, not remembered as down.
    asked.catch(() => {
      if (discovered === asked) discovered = undefined;
    });
    return asked;
  };

  /** The ID token, verified in full, or a refusal naming what failed (for the server's log, never the browser). */
  const verify = async (idToken: string, nonce: string): Promise<Record<string, unknown>> => {
    const found = await discover();
    const { payload } = await jose.jwtVerify(idToken, found.jwks, {
      issuer: issuer(),
      audience: clientId(),
      algorithms: found.algorithms,
      clockTolerance: CLOCK_SKEW_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
      requiredClaims: ['sub', 'iat', 'exp'],
    });
    const aud = payload.aud;
    // OIDC Core 3.1.3.7: an authorized party, when named, is this client; several audiences must name one.
    if ((payload.azp !== undefined && payload.azp !== clientId()) || (Array.isArray(aud) && aud.length > 1 && payload.azp === undefined)) {
      throw new Error('the token was issued to another party (azp)');
    }
    if (typeof payload.nonce !== 'string' || !same(payload.nonce, nonce)) throw new Error('the nonce is not the one this sign-in sent');
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 255) throw new Error('the token names no subject');
    return payload;
  };

  /**
   * An OpenID Connect Back-Channel Logout 1.0 logout token, verified in full
   * against the same published keys and algorithms as an ID token: issuer
   * exactly, this client in its audience, minutes old at most, the logout
   * event, a subject or a session, an id, and never a nonce (an ID token is
   * not a logout token). Throws saying what failed.
   */
  const verifyLogoutToken = async (logoutToken: string): Promise<Record<string, unknown>> => {
    const found = await discover();
    const { payload, protectedHeader } = await jose.jwtVerify(logoutToken, found.jwks, {
      issuer: issuer(),
      audience: clientId(),
      algorithms: found.algorithms,
      clockTolerance: CLOCK_SKEW_S,
      maxTokenAge: MAX_TOKEN_AGE_S,
      requiredClaims: ['iat', 'jti'],
    });
    const typ = typeof protectedHeader?.typ === 'string' ? protectedHeader.typ.toLowerCase().replace(/^application\//, '') : undefined;
    if (typ !== undefined && typ !== 'logout+jwt' && typ !== 'jwt')
      throw new Error(`the token's type is ${protectedHeader!.typ}, not logout+jwt`);
    const events = payload.events;
    const event =
      events && typeof events === 'object' && !Array.isArray(events) ? (events as Record<string, unknown>)[LOGOUT_EVENT] : undefined;
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('the token carries no back-channel logout event');
    if (payload.nonce !== undefined) throw new Error('the token has a nonce, which a logout token never has');
    const named = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 255;
    if (!named(payload.jti)) throw new Error('the token has no id (jti)');
    if (payload.sub !== undefined && !named(payload.sub)) throw new Error('the token names an unreadable subject');
    if (payload.sid !== undefined && !named(payload.sid)) throw new Error('the token names an unreadable session');
    if (payload.sub === undefined && payload.sid === undefined) throw new Error('the token names neither a subject nor a session');
    return payload;
  };

  return {
    id: config.name,
    /* Back-channel logout's verifier (backchannelLogout.ts): beside the provider, so it shares its discovery and keys. */
    verifyLogoutToken,
    name: config.label ?? config.name,
    /* The callback's `iss` must be this one (RFC 9207), and an account is
       keyed by this provider and the subject (Better Auth 1.7.3 keys by
       provider id, not issuer; the issuer is pinned per provider above): a
       person is who the provider says, never who an email says. */
    get issuer() {
      return issuer();
    },
    accountSubject: ({ profile }: { profile: Record<string, unknown> }) => String(profile.sub ?? ''),
    requiresIdTokenNonce: true,
    disableSignUp: !options.signUp(token),
    options: { disableSignUp: !options.signUp(token), disableIdTokenSignIn: true, overrideUserInfoOnSignIn: false },
    async createAuthorizationURL(data: {
      state: string;
      codeVerifier: string;
      idTokenNonce?: string;
      redirectURI: string;
      loginHint?: string;
      additionalParams?: Record<string, string>;
    }) {
      const found = await discover();
      if (!data.idTokenNonce) throw new Error(`${said}: a sign-in without a nonce`);
      const url = new URL(found.authorization);
      const challenge = Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data.codeVerifier))).toString(
        'base64url',
      );
      const scopes = ['openid', ...(config.scopes ?? ['email', 'profile']).filter((scope) => scope !== 'openid')];
      for (const [key, value] of Object.entries({
        response_type: 'code',
        client_id: clientId(),
        redirect_uri: data.redirectURI,
        scope: scopes.join(' '),
        state: data.state,
        nonce: data.idTokenNonce,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      })) {
        url.searchParams.set(key, value);
      }
      if (data.loginHint && data.loginHint.length <= 320 && !/\p{Cc}/u.test(data.loginHint))
        url.searchParams.set('login_hint', data.loginHint);
      /* A step-up asks the provider to authenticate afresh, and for more
         than one factor where the config names what that is. Nothing else a
         browser adds reaches the provider. */
      if (data.additionalParams?.[STEP_UP_PARAM] === '1') {
        url.searchParams.set('prompt', 'login');
        url.searchParams.set('max_age', '0');
        if (config.mfa?.length) url.searchParams.set('acr_values', config.mfa.join(' '));
      }
      return url;
    },
    async validateAuthorizationCode(data: { code: string; codeVerifier: string; redirectURI: string }) {
      const found = await discover();
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: data.code,
        redirect_uri: data.redirectURI,
        code_verifier: data.codeVerifier,
      });
      const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
      const key = secret();
      if (key && found.basic)
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(clientId())}:${encodeURIComponent(key)}`).toString('base64')}`;
      else {
        body.set('client_id', clientId());
        if (key) body.set('client_secret', key);
      }
      const res = await fetch(found.token, { method: 'POST', headers, body, redirect: 'error', signal: AbortSignal.timeout(FETCH_MS) });
      const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || typeof answer?.id_token !== 'string') {
        throw new Error(
          `${said}: its token endpoint answered ${res.status}${typeof answer?.error === 'string' ? ` (${answer.error})` : ''} and no ID token.`,
        );
      }
      // Only the ID token: nothing calls the provider afterwards, so no access or refresh token is kept.
      return { idToken: answer.id_token, tokenType: typeof answer.token_type === 'string' ? answer.token_type : 'Bearer' };
    },
    async getUserInfo(tokens: { idToken?: string; expectedIdTokenNonce?: string }) {
      if (!tokens.idToken || !tokens.expectedIdTokenNonce) return null;
      let claims: Record<string, unknown>;
      try {
        claims = await verify(tokens.idToken, tokens.expectedIdTokenNonce);
      } catch (error) {
        console.error(`mistri: ${said} refused a sign-in: ${(error as Error).message}.`);
        return null;
      }
      // Azure AD B2C's user flows say `emails`, a list; one address in it is the address.
      const address =
        typeof claims.email === 'string'
          ? claims.email
          : Array.isArray(claims.emails) && claims.emails.length === 1 && typeof claims.emails[0] === 'string'
            ? claims.emails[0]
            : undefined;
      const email = address && address.includes('@') && address.length <= 320 ? address.trim().toLowerCase() : undefined;
      const emailVerified = Boolean(email) && (claims.email_verified === true || config.verifiedEmails === true);
      const context = options.current();
      if (context)
        options.evidence.set(context, {
          provider: config,
          token,
          claims: Object.freeze({ ...claims }),
          email,
          emailVerified,
          issuer: issuer(),
          subject: claims.sub as string,
          ...(typeof claims.sid === 'string' && claims.sid && claims.sid.length <= 255 ? { sid: claims.sid } : {}),
        });
      return {
        user: { id: claims.sub as string, email, emailVerified, name: sayable(claims.name) ?? email?.split('@')[0] ?? '' },
        // What Better Auth keeps of the profile: the subject and the address, never the token's other claims.
        data: { sub: claims.sub, ...(email ? { email } : {}) },
      };
    },
  };
}
