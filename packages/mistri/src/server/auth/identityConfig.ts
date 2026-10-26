/**
 * An OpenID Connect identity provider, as the config file names it beside
 * the databases and the other services:
 *
 *   { "name": "workforce", "kind": "oidc",
 *     "issuer": "https://login.microsoftonline.com/<tenant id>/v2.0",
 *     "clientId": "…", "clientSecret": "${WORKFORCE_CLIENT_SECRET}" }
 *
 * An App names it (`auth.providers: [oidc('workforce')]`) and never holds any
 * of it: the issuer, the client and its secret are the deployment's, as a
 * connection URL is. The secret is only ever a `${VAR}` reference, expanded
 * when the provider is first used and never written anywhere else; a literal
 * one is refused, since the config file is committed as often as not.
 *
 * `tenant` and `domains` make it one tenant's own provider in a tenant App
 * (`oidc.tenants()`): a person whose email is in one of its domains is sent
 * there to sign in, and it may assert only addresses in those domains. The
 * platform sets it here, in the deployment's configuration, and nothing a
 * tenant member can reach reads or changes it (mistri docs
 * identity-providers).
 *
 * A SAML 2.0 identity provider is an entry of kind "saml", said one way only:
 * its entity id, its sign-in URL and its signing certificates, written in the
 * file (they are public). No metadata URL and no metadata XML: unsigned
 * metadata fetched at runtime would be a trust hole.
 *
 *   { "name": "okta", "kind": "saml", "entityId": "http://www.okta.com/exk…",
 *     "ssoUrl": "https://acme.okta.com/app/…/sso/saml",
 *     "certificates": ["-----BEGIN CERTIFICATE-----\n…"] }
 *
 * The service provider's side is derived, never configured: its entity id
 * and its assertion consumer service are under the App's address, one per
 * provider (samlServiceProvider), and startup prints both for the provider's
 * administrator to register.
 */
import { X509Certificate } from 'node:crypto';
import { EMAIL_DOMAIN } from '../../shared/appAuthGrants.js';
import { OIDC_PROVIDER, SAML_PROVIDER, type AppDef } from '../../shared/appModel.js';

export interface IdentityProviderConfig {
  kind: 'oidc';
  name: string;
  /** Exactly the `iss` of the provider's tokens. `${VAR}` references intact. */
  issuer: string;
  /** Where the discovery document is, when it is not `<issuer>/.well-known/openid-configuration` (Azure AD B2C). */
  discovery?: string;
  clientId: string;
  /** A `${VAR}` reference, never the secret. Absent: a public client, which PKCE alone protects. */
  clientSecret?: string;
  /** Asked for besides `openid`. Default: email, profile. */
  scopes?: string[];
  /** The button's words: "Continue with <label>". Default: the name. */
  label?: string;
  /** The provider only ever asserts addresses it has verified, whether or not it says `email_verified`. */
  verifiedEmails?: true;
  /** The `acr` values that mean the person used more than one factor: asked for when mistri steps up. */
  mfa?: string[];
  /** A tenant App's tenant this provider belongs to; it says the email domains it may assert too. */
  tenant?: string;
  /** The only email domains it may assert: a tenant's own provider's, or an App-wide one fenced to them. */
  domains?: string[];
  /** An issuer on plain http: a provider on this machine or a trusted network, never the internet. */
  insecure?: true;
  /** The provider may end its sessions here by OpenID Connect Back-Channel Logout (backchannelLogout.ts). */
  backchannelLogout?: true;
}

/** A SAML 2.0 identity provider (kind "saml"), signed in through at its `ssoUrl` (samlSignIn.ts). */
export interface SamlProviderConfig {
  kind: 'saml';
  name: string;
  /** The provider's entity id: every response's Issuer is exactly this, and it keys the accounts it signs in. */
  entityId: string;
  /** Where the sign-in request goes (HTTP-Redirect binding). */
  ssoUrl: string;
  /** One or two PEM certificates the provider signs assertions with: two while it rolls one over. */
  certificates: string[];
  label?: string;
  /** The provider only ever asserts addresses it has verified. Without it, no address it asserts is. */
  verifiedEmails?: true;
  /** The `AuthnContextClassRef` values that mean the person used more than one factor. */
  mfa?: string[];
  tenant?: string;
  domains?: string[];
  /** Which attributes say the address and the name. Absent `email`: the NameID, in emailAddress format. */
  attributes?: { email?: string; name?: string };
  insecure?: true;
}

/** An identity provider the config file names, either kind. One namespace: their names are provider ids. */
export type FederatedProviderConfig = IdentityProviderConfig | SamlProviderConfig;

const OIDC_KEYS = [
  'name',
  'kind',
  'issuer',
  'discovery',
  'clientId',
  'clientSecret',
  'scopes',
  'label',
  'verifiedEmails',
  'mfa',
  'tenant',
  'domains',
  'insecure',
  'backchannelLogout',
] as const;
const SAML_KEYS = [
  'name',
  'kind',
  'entityId',
  'ssoUrl',
  'certificates',
  'label',
  'verifiedEmails',
  'mfa',
  'tenant',
  'domains',
  'attributes',
  'insecure',
] as const;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** An http(s) URL, https unless the entry says `insecure`; a reference is checked once the environment says it. */
function address(value: unknown, key: string, insecure: boolean, where: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${where} needs "${key}", a URL.`);
  if (value.includes('${')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where} has a "${key}" that is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && insecure)) {
    throw new Error(
      `${where} has a ${url.protocol}// "${key}". An identity provider is https; "insecure": true allows http on this machine or a trusted network.`,
    );
  }
  if (url.username || url.password || url.hash) throw new Error(`${where} has a credential or a fragment in its "${key}".`);
  return value;
}

const words = (value: unknown, key: string, where: string, pattern?: RegExp): string[] => {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.some((item) => typeof item !== 'string' || !item.trim() || (pattern && !pattern.test(item)))
  ) {
    throw new Error(
      `${where} has a "${key}" that is not a nonempty list${pattern ? ' of domains in lower case, like "example.com"' : ' of words'}.`,
    );
  }
  if (new Set(value).size !== value.length) throw new Error(`${where} names the same "${key}" twice.`);
  return [...value] as string[];
};

/** What both kinds check alike: the keys, the name, the flags, the label, `mfa` and the tenant's domains. */
function commonOf(entry: Record<string, unknown>, where: string, keys: readonly string[], kind: 'oidc' | 'saml') {
  const stray = Object.keys(entry).find((key) => !keys.includes(key));
  if (stray) throw new Error(`${where} is an identity provider, which takes no "${stray}". It takes: ${keys.join(', ')}.`);
  const name = String(entry.name);
  if (!NAME.test(name) || ['email', 'github', 'google', 'credential'].includes(name)) {
    throw new Error(
      `${where} has a name an App cannot say in ${kind}('…'): lower-case letters, digits and hyphens, starting with a letter, and not email, github, google or credential.`,
    );
  }
  for (const flag of ['insecure', 'verifiedEmails', 'backchannelLogout'] as const) {
    if (entry[flag] !== undefined && entry[flag] !== true) throw new Error(`${where} has "${flag}": it is true, or absent.`);
  }
  if (
    entry.label !== undefined &&
    (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 60 || /\p{Cc}/u.test(entry.label))
  ) {
    throw new Error(`${where} has a "label" that is not a name of 1 to 60 characters.`);
  }
  const mfa = entry.mfa === undefined ? undefined : words(entry.mfa, 'mfa', where);
  /* `domains` alone fences an App-wide provider to its domains, which a SCIM
     directory provisioning through it needs (scimConfig.ts). */
  if (entry.tenant !== undefined && entry.domains === undefined) {
    throw new Error(
      `${where} has "tenant" and no "domains": a tenant's own provider says both, the tenant and the email domains it may assert.`,
    );
  }
  if (entry.tenant !== undefined && (typeof entry.tenant !== 'string' || !entry.tenant.trim() || entry.tenant.length > 1024)) {
    throw new Error(`${where} has a "tenant" that is not a tenant's id.`);
  }
  const domains = entry.domains === undefined ? undefined : words(entry.domains, 'domains', where, EMAIL_DOMAIN);
  return {
    name,
    insecure: entry.insecure === true,
    tail: {
      ...(entry.label ? { label: (entry.label as string).trim() } : {}),
      ...(entry.verifiedEmails ? { verifiedEmails: true as const } : {}),
      ...(mfa ? { mfa } : {}),
      ...(entry.tenant !== undefined ? { tenant: (entry.tenant as string).trim() } : {}),
      ...(domains ? { domains } : {}),
      ...(entry.insecure === true ? { insecure: true as const } : {}),
    },
  };
}

/** An entry of kind "oidc", checked. Throws naming the field. */
export function oidcConnectionOf(entry: Record<string, unknown>, where: string): IdentityProviderConfig {
  const { name, insecure, tail } = commonOf(entry, where, OIDC_KEYS, 'oidc');
  const issuer = address(entry.issuer, 'issuer', insecure, where);
  const discovery = entry.discovery === undefined ? undefined : address(entry.discovery, 'discovery', insecure, where);
  if (typeof entry.clientId !== 'string' || !entry.clientId.trim())
    throw new Error(`${where} needs "clientId": the client (application) id the provider gave this App.`);
  if (entry.clientSecret !== undefined && (typeof entry.clientSecret !== 'string' || !REFERENCE.test(entry.clientSecret))) {
    throw new Error(
      `${where} has a "clientSecret" that is not a reference like "\${WORKFORCE_CLIENT_SECRET}". The secret lives in the environment, never in this file.`,
    );
  }
  const scopes = entry.scopes === undefined ? undefined : words(entry.scopes, 'scopes', where);
  if (scopes?.some((scope) => /\s/.test(scope))) throw new Error(`${where} has a scope with a space in it; list each scope on its own.`);
  const { label, verifiedEmails, mfa, tenant, domains } = tail as SamlProviderConfig;
  return {
    kind: 'oidc',
    name,
    issuer,
    ...(discovery ? { discovery } : {}),
    clientId: entry.clientId.trim(),
    ...(entry.clientSecret ? { clientSecret: entry.clientSecret as string } : {}),
    ...(scopes ? { scopes } : {}),
    ...(label ? { label } : {}),
    ...(verifiedEmails ? { verifiedEmails } : {}),
    ...(mfa ? { mfa } : {}),
    ...(tenant !== undefined ? { tenant } : {}),
    ...(domains ? { domains } : {}),
    ...(insecure ? { insecure: true as const } : {}),
    ...(entry.backchannelLogout === true ? { backchannelLogout: true as const } : {}),
  };
}

/** A PEM certificate, read: an RSA or EC key that has not expired. Throws naming the entry. */
function certificateOf(value: unknown, where: string, index: number): string {
  const said = `${where} has a certificate (${index + 1})`;
  if (typeof value !== 'string' || !/^-----BEGIN CERTIFICATE-----[\s\S]+-----END CERTIFICATE-----\s*$/.test(value.trim())) {
    throw new Error(
      `${said} that is not a PEM certificate ("-----BEGIN CERTIFICATE-----…"). It is public: write it here, not a reference.`,
    );
  }
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(value.trim());
  } catch {
    throw new Error(`${said} that cannot be read.`);
  }
  if (Date.parse(cert.validTo) < Date.now()) throw new Error(`${said} that expired on ${cert.validTo}.`);
  const type = cert.publicKey.asymmetricKeyType;
  if (type !== 'rsa' && type !== 'ec') throw new Error(`${said} with a ${String(type)} key; a SAML provider signs with RSA or EC.`);
  return value.trim();
}

/** An entry of kind "saml", checked. Throws naming the field. */
export function samlConnectionOf(entry: Record<string, unknown>, where: string): SamlProviderConfig {
  const { name, insecure, tail } = commonOf(entry, where, SAML_KEYS, 'saml');
  if (typeof entry.entityId !== 'string' || !entry.entityId.trim() || entry.entityId.length > 1024 || /\s/.test(entry.entityId)) {
    throw new Error(`${where} needs "entityId": the provider's entity id, exactly as its responses' Issuer says it.`);
  }
  const ssoUrl = address(entry.ssoUrl, 'ssoUrl', insecure, where);
  if (ssoUrl.includes('${')) throw new Error(`${where} has an "ssoUrl" with a reference in it; a SAML provider's addresses are public.`);
  if (!Array.isArray(entry.certificates) || entry.certificates.length < 1 || entry.certificates.length > 2) {
    throw new Error(`${where} needs "certificates": one or two PEM certificates the provider signs with (two while it rolls one over).`);
  }
  const certificates = entry.certificates.map((cert, index) => certificateOf(cert, where, index));
  if (new Set(certificates).size !== certificates.length) throw new Error(`${where} names the same certificate twice.`);
  let attributes: SamlProviderConfig['attributes'];
  if (entry.attributes !== undefined) {
    const given = entry.attributes as Record<string, unknown>;
    if (
      !given ||
      typeof given !== 'object' ||
      Array.isArray(given) ||
      !Object.keys(given).length ||
      Object.keys(given).some((key) => key !== 'email' && key !== 'name') ||
      Object.values(given).some((value) => typeof value !== 'string' || !value.trim() || value.length > 256)
    ) {
      throw new Error(
        `${where} has "attributes" that are not { "email": "<attribute name>", "name": "<attribute name>" } (either or both).`,
      );
    }
    attributes = { ...(given.email ? { email: String(given.email) } : {}), ...(given.name ? { name: String(given.name) } : {}) };
  }
  return { kind: 'saml', name, entityId: entry.entityId, ssoUrl, certificates, ...(attributes ? { attributes } : {}), ...tail };
}

/** The config entry as written, for saving. */
export function samlEntry(service: SamlProviderConfig): Record<string, unknown> {
  const { kind, name, ...rest } = service;
  return { name, kind, ...rest };
}

/**
 * This server's side of a SAML provider, under the App's address (`baseURL`,
 * a reverse proxy's path included): its entity id, one per provider so an
 * assertion's audience never fits another, and where responses are posted.
 */
export function samlServiceProvider(baseURL: string, name: string): { entityId: string; acs: string } {
  const auth = `${baseURL.replace(/\/+$/, '')}/api/auth`;
  return { entityId: `${auth}/sso/saml2/sp/metadata?providerId=${name}`, acs: `${auth}/sso/saml2/sp/acs/${name}` };
}

/** Where an OpenID Connect provider posts its logout tokens, for its administrator to register. */
export const backchannelLogoutUrl = (baseURL: string, name: string) => `${baseURL.replace(/\/+$/, '')}/api/auth/backchannel-logout/${name}`;

/** The config entry as written, for saving: the secret stays a reference. */
export function oidcEntry(service: IdentityProviderConfig): Record<string, unknown> {
  const { kind, name, ...rest } = service;
  return { name, kind, ...rest };
}

/**
 * Across both kinds: a name is one provider's (it is the provider id), a SAML
 * entity id is one entry's (it keys the accounts it signs in), and an email
 * domain is one tenant's: two tenants claiming one domain would each sign in
 * the other's people.
 */
export function checkIdentityProviders(services: readonly FederatedProviderConfig[], path: string): void {
  const names = new Set<string>();
  const entities = new Map<string, string>();
  for (const service of services) {
    if (names.has(service.name)) throw new Error(`${path}: two identity providers are named "${service.name}"; a name is one provider's.`);
    names.add(service.name);
    if (service.kind !== 'saml') continue;
    const before = entities.get(service.entityId);
    if (before) {
      throw new Error(
        `${path}: SAML providers "${before}" and "${service.name}" have the same entityId; an entity id is one provider's, and keys the accounts it signs in.`,
      );
    }
    entities.set(service.entityId, service.name);
  }
  const owner = new Map<string, FederatedProviderConfig>();
  for (const service of services) {
    for (const domain of service.domains ?? []) {
      const before = owner.get(domain);
      if (before) {
        throw new Error(
          `${path}: identity providers "${before.name}" and "${service.name}" both claim the domain "${domain}"; an email domain is one tenant's.`,
        );
      }
      owner.set(domain, service);
    }
  }
}

/**
 * What an App's `oidc(...)` providers need of this server's config, said as
 * `mistri check` and startup say it: each one configured, and a tenant's
 * own provider never standing in for an App-wide one.
 */
export function identityProblems(app: AppDef, services: readonly FederatedProviderConfig[]): string[] {
  const problems: string[] = [];
  for (const provider of app.auth?.providers ?? []) {
    const kind = OIDC_PROVIDER.test(provider) ? 'oidc' : SAML_PROVIDER.test(provider) ? 'saml' : undefined;
    if (!kind) continue;
    const name = provider.slice(kind.length + 1);
    const found = services.find((service) => service.name === name);
    if (!found) {
      problems.push(
        `"auth" lists ${kind}('${name}'), and the config file names no identity provider "${name}" [identity-provider-unknown]. ` +
          (kind === 'oidc'
            ? `Add { "name": "${name}", "kind": "oidc", "issuer": "…", "clientId": "…", "clientSecret": "\${…}" } to its "connections".`
            : `Add { "name": "${name}", "kind": "saml", "entityId": "…", "ssoUrl": "…", "certificates": ["…"] } to its "connections".`),
      );
    } else if (found.kind !== kind) {
      problems.push(
        `"auth" lists ${kind}('${name}'), and the config file's "${name}" is of kind "${found.kind}" [identity-provider-kind]. Say ${found.kind}('${name}').`,
      );
    } else if (found.tenant !== undefined) {
      problems.push(
        `"auth" lists ${kind}('${name}'), which the config file gives to tenant "${found.tenant}" [identity-provider-tenant]. ` +
          `A tenant's own provider signs in through ${kind}.tenants(), by the email's domain; name an App-wide provider here.`,
      );
    }
  }
  return problems;
}

/* The OAuth authorization server's entry (api/oauthConfig.ts says what it is for) is read here, beside the identity
   providers', so that reading the config file loads nothing of the server that issues. */

export interface OAuthServerConfig {
  kind: 'oauth';
  name: string;
  /** The Apps whose network API and HTTP MCP take tokens issued here, by id. */
  apps: string[];
  /** The App roles a token issued here may carry at most. Absent: the App's `api.roles`. */
  roles?: string[];
  /** The hosts a registered client may send people back to. Absent: any https host, loopback, or a private-use scheme. */
  redirectHosts?: string[];
}

const OAUTH_KEYS = ['name', 'kind', 'apps', 'roles', 'redirectHosts'] as const;

/** A host name as a URL spells it: letters, digits, dots and hyphens, or a bracketed IPv6 literal. */
const OAUTH_HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;

const oauthNames = (value: unknown, where: string, field: string, what: string): string[] => {
  if (!Array.isArray(value) || !value.length || value.some((item) => typeof item !== 'string' || !item.trim() || item !== item.trim())) {
    throw new Error(`${where} has a "${field}" that is not a nonempty list of ${what}.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${where} names the same entry twice in "${field}".`);
  return [...(value as string[])];
};

/** An entry of kind "oauth", checked. Throws naming the field. */
export function oauthConnectionOf(entry: Record<string, unknown>, where: string): OAuthServerConfig {
  const stray = Object.keys(entry).find((key) => !(OAUTH_KEYS as readonly string[]).includes(key));
  if (stray) throw new Error(`${where} is an OAuth authorization server, which takes no "${stray}". It takes: ${OAUTH_KEYS.join(', ')}.`);
  const name = String(entry.name);
  if (!NAME.test(name)) throw new Error(`${where} has a name that is not lower-case letters, digits and hyphens, starting with a letter.`);
  if (entry.apps === undefined) throw new Error(`${where} needs "apps": the Apps (by id) whose network API takes the tokens it issues.`);
  const apps = oauthNames(entry.apps, where, 'apps', 'App ids');
  const roles = entry.roles === undefined ? undefined : oauthNames(entry.roles, where, 'roles', 'App roles');
  let redirectHosts: string[] | undefined;
  if (entry.redirectHosts !== undefined) {
    redirectHosts = oauthNames(entry.redirectHosts, where, 'redirectHosts', 'host names');
    const bad = redirectHosts.find((host) => !OAUTH_HOST.test(host) || host.length > 253);
    if (bad !== undefined) {
      throw new Error(
        `${where} has the redirect host "${bad}": a host is a lower-case name like "app.example.com", with no scheme, port or path.`,
      );
    }
  }
  return {
    kind: 'oauth',
    name,
    apps,
    ...(roles ? { roles } : {}),
    ...(redirectHosts ? { redirectHosts } : {}),
  };
}

/** The config entry as written, for saving. */
export function oauthEntry(service: OAuthServerConfig): Record<string, unknown> {
  const { kind, name, ...rest } = service;
  return { name, kind, ...rest };
}

/** One authorization server: two would issue for the same App under two sets of rules. */
export function checkOAuthServers(services: readonly OAuthServerConfig[], path: string): void {
  if (services.length > 1) {
    throw new Error(
      `${path} names ${services.length} OAuth authorization servers (${services.map((s) => `"${s.name}"`).join(', ')}); a deployment has one.`,
    );
  }
}
