/**
 * A host application that signs its own people in, and may sign them into an
 * App without a second login: the config file names it beside the databases
 * and the identity providers.
 *
 *   { "name": "portal", "kind": "embed", "issuer": "https://portal.example.com",
 *     "secret": "${PORTAL_EMBED_SECRET}", "origins": ["https://portal.example.com"] }
 *
 * The host signs a short-lived assertion (a JWT) of who is there; the App
 * exchanges it for its ordinary session (exchange.ts). The issuer, the key and
 * the origins are the deployment's, as an identity provider's are: an App
 * never names one, and nothing a signed-in person can reach reads or changes
 * them. The key is a `${VAR}` reference to an HS256 secret, or the address of
 * the host's JWKS (ES256 or EdDSA); a literal secret is refused, since the
 * config file is committed as often as not.
 *
 * Roles come from the mistri account. An assertion's `roles` claim counts
 * only where the issuer maps it (`roles: { "<App role>": ["<host role>"] }`),
 * so a host cannot grant what the operator did not say it may.
 */
import { rolesOf } from '../../shared/accountAdministration.js';
import type { AppDef } from '../../shared/appModel.js';

/** The longest an assertion may live, `iat` to `exp`. */
export const MAX_ASSERTION_LIFETIME_S = 300;

export interface EmbedIssuerConfig {
  kind: 'embed';
  name: string;
  /** Exactly the `iss` of the host's assertions. */
  issuer: string;
  /** A `${VAR}` reference to the HS256 secret (at least 32 bytes). Exactly one of `secret` and `jwks`. */
  secret?: string;
  /** Where the host publishes its public keys (ES256 or EdDSA). */
  jwks?: string;
  /** The browser origins its people use: an assertion names one, and is taken only from there. */
  origins: string[];
  /** The Apps (by id) it may sign people into, its assertions' `aud`. Absent: every App this server signs people in to. */
  apps?: string[];
  /** `separate` (default): a person is the issuer's subject, never linked by email. `link-verified-email`: an
   *  existing account whose address mistri verified is linked when the host says the address is verified too. */
  accounts?: 'separate' | 'link-verified-email';
  /** `false`: only people who already have an account here sign in. Default: an account is made at the first sign-in. */
  createAccounts?: false;
  /** App role → the host's role values that give it. Absent: the assertion's `roles` claim is ignored. */
  roles?: Record<string, string[]>;
  /** A JWKS on plain http: a host on this machine or a trusted network, never the internet. */
  insecure?: true;
}

const EMBED_KEYS = [
  'name',
  'kind',
  'issuer',
  'secret',
  'jwks',
  'origins',
  'apps',
  'accounts',
  'createAccounts',
  'roles',
  'insecure',
] as const;

const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;
const LOCAL = /^(localhost|127\.0\.0\.1|\[::1\])$/;

/**
 * One browser origin, exactly: a scheme, a host and a port, nothing else. No
 * wildcard, and http only for this machine, since an assertion is taken from
 * whatever page claims the origin and a plain-http page can be anyone's.
 */
export function embedOrigin(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value)
    throw new Error(`${where} has an origin that is not a string like "https://portal.example.com".`);
  if (value.includes('*')) throw new Error(`${where} has the origin "${value}": origins are exact, with no wildcard.`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${where} has the origin "${value}", which is not one.`);
  }
  if (url.origin !== value) {
    throw new Error(
      `${where} has the origin "${value}": write it as ${url.origin === 'null' ? 'https://host' : `"${url.origin}"`}, with no path or trailing slash.`,
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL.test(url.hostname))) {
    throw new Error(`${where} has the origin "${value}": an origin is https, or http on localhost.`);
  }
  return value;
}

/** An entry of kind "embed", checked. Throws naming the field. */
export function embedConnectionOf(entry: Record<string, unknown>, where: string): EmbedIssuerConfig {
  const stray = Object.keys(entry).find((key) => !(EMBED_KEYS as readonly string[]).includes(key));
  if (stray) throw new Error(`${where} is a host that signs people in, which takes no "${stray}". It takes: ${EMBED_KEYS.join(', ')}.`);
  const name = String(entry.name);
  if (!NAME.test(name)) throw new Error(`${where} has a name that is not lower-case letters, digits and hyphens, starting with a letter.`);
  if (typeof entry.issuer !== 'string' || !entry.issuer.trim() || entry.issuer.length > 512 || /\p{Cc}/u.test(entry.issuer)) {
    throw new Error(`${where} needs "issuer": exactly the "iss" its assertions carry.`);
  }
  if (entry.insecure !== undefined && entry.insecure !== true) throw new Error(`${where} has "insecure": it is true, or absent.`);
  if ((entry.secret === undefined) === (entry.jwks === undefined)) {
    throw new Error(
      `${where} needs exactly one key: "secret", a reference like "\${PORTAL_EMBED_SECRET}", or "jwks", the address of its public keys.`,
    );
  }
  if (entry.secret !== undefined && (typeof entry.secret !== 'string' || !REFERENCE.test(entry.secret))) {
    throw new Error(
      `${where} has a "secret" that is not a reference like "\${PORTAL_EMBED_SECRET}". The secret lives in the environment, never in this file.`,
    );
  }
  if (entry.jwks !== undefined) {
    let url: URL | undefined;
    try {
      url = typeof entry.jwks === 'string' ? new URL(entry.jwks) : undefined;
    } catch {
      /* said below */
    }
    if (!url) throw new Error(`${where} has a "jwks" that is not a URL.`);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && entry.insecure === true)) {
      throw new Error(
        `${where} has a ${url.protocol}// "jwks". Keys are fetched over https; "insecure": true allows http on a trusted network.`,
      );
    }
    if (url.username || url.password || url.hash) throw new Error(`${where} has a credential or a fragment in its "jwks".`);
  }
  if (!Array.isArray(entry.origins) || !entry.origins.length) {
    throw new Error(`${where} needs "origins": the browser origins its people use, like ["https://portal.example.com"].`);
  }
  const origins = entry.origins.map((origin) => embedOrigin(origin, where));
  if (new Set(origins).size !== origins.length) throw new Error(`${where} names the same origin twice.`);
  let apps: string[] | undefined;
  if (entry.apps !== undefined) {
    if (!Array.isArray(entry.apps) || !entry.apps.length || entry.apps.some((app) => typeof app !== 'string' || !app.trim())) {
      throw new Error(`${where} has an "apps" that is not a nonempty list of App ids.`);
    }
    apps = [...new Set(entry.apps as string[])];
  }
  if (entry.accounts !== undefined && entry.accounts !== 'separate' && entry.accounts !== 'link-verified-email') {
    throw new Error(`${where} has "accounts": ${JSON.stringify(entry.accounts)}. It is "separate" (the default) or "link-verified-email".`);
  }
  if (entry.createAccounts !== undefined && entry.createAccounts !== false) {
    throw new Error(`${where} has "createAccounts": it is false, or absent (an account is made at the first sign-in).`);
  }
  let roles: Record<string, string[]> | undefined;
  if (entry.roles !== undefined) {
    const given = entry.roles as Record<string, unknown>;
    if (!given || typeof given !== 'object' || Array.isArray(given) || !Object.keys(given).length) {
      throw new Error(
        `${where} has a "roles" that is not a map from an App role to the host's role values, like { "manager": ["sales-lead"] }.`,
      );
    }
    roles = {};
    for (const [role, values] of Object.entries(given)) {
      if (!Array.isArray(values) || !values.length || values.some((value) => typeof value !== 'string' || !value)) {
        throw new Error(`${where} maps the role "${role}" from something that is not a nonempty list of the host's role values.`);
      }
      roles[role] = [...new Set(values as string[])];
    }
  }
  return {
    kind: 'embed',
    name,
    issuer: entry.issuer,
    ...(entry.secret !== undefined ? { secret: entry.secret as string } : {}),
    ...(entry.jwks !== undefined ? { jwks: entry.jwks as string } : {}),
    origins,
    ...(apps ? { apps } : {}),
    ...(entry.accounts ? { accounts: entry.accounts as EmbedIssuerConfig['accounts'] } : {}),
    ...(entry.createAccounts === false ? { createAccounts: false as const } : {}),
    ...(roles ? { roles } : {}),
    ...(entry.insecure === true ? { insecure: true as const } : {}),
  };
}

/** The config entry as written, for saving: the secret stays a reference. */
export function embedEntry(service: EmbedIssuerConfig): Record<string, unknown> {
  const { kind, name, ...rest } = service;
  return { name, kind, ...rest };
}

/** One issuer, one entry: two entries trusting the same `iss` with different keys would make either key good for both. */
export function checkEmbedIssuers(services: readonly EmbedIssuerConfig[], path: string): void {
  const seen = new Map<string, string>();
  for (const service of services) {
    const before = seen.get(service.issuer);
    if (before)
      throw new Error(`${path}: "${before}" and "${service.name}" both trust the issuer "${service.issuer}"; an issuer is one entry.`);
    seen.set(service.issuer, service.name);
  }
}

/** The issuers that may sign people into this App. */
export function issuersFor(appId: string, services: readonly EmbedIssuerConfig[]): EmbedIssuerConfig[] {
  return services.filter((service) => !service.apps || service.apps.includes(appId));
}

/**
 * What an issuer that names this App needs of it, said as `mistri check`
 * and startup say it: the App signs people in, and a mapped role is one the
 * App declares (or admin), since a mapping to a role nobody declared would
 * give nothing and say nothing.
 */
export function embedProblems(app: AppDef, services: readonly EmbedIssuerConfig[]): string[] {
  const problems: string[] = [];
  const named = services.filter((service) => service.apps?.includes(app.id));
  if (!app.auth) {
    for (const service of named) {
      problems.push(
        `the config file's host "${service.name}" signs people into this App, which signs no one in [embed-issuer-no-auth]. Give the App "auth", or take "${app.id}" off the host's "apps".`,
      );
    }
    return problems;
  }
  const declared = new Set([...Object.keys(app.auth.roles ?? {}), 'admin']);
  for (const service of issuersFor(app.id, services)) {
    for (const role of Object.keys(service.roles ?? {})) {
      if (rolesOf(role).length !== 1 || !declared.has(role)) {
        problems.push(
          `the config file's host "${service.name}" maps the role "${role}", which this App does not declare [embed-issuer-role-unknown]. Declare it in "auth.roles", or map one it does: ${[...declared].join(', ')}.`,
        );
      }
    }
  }
  return problems;
}
