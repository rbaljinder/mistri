/** Explicit suite deployment data, validated before any App opens a store. */
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { appMounts, parseBasePath, parseMountPath } from '@mistriwork/engine/shared/mount.js';
import { normalizeSuitePublicOrigin, validateTenantHosts, type TenantHostIntent } from '../http/tenantHosts.js';
import { EMAIL_KEYS, emailConnectionOf, type EmailServiceConfig } from '../email/email.js';
import { checkIdentityProviders, oidcConnectionOf, samlConnectionOf, type FederatedProviderConfig } from '../auth/identityConfig.js';
import { parseAnalyticsConfiguration, type AnalyticsConfiguration } from '../analytics/config.js';
import { suiteControlConfiguration, type SuiteExperimentConfiguration, type SuiteFlagConfiguration } from './suiteControlConfig.js';
import { suitePlacementConfiguration, type SuitePlacementConfiguration } from './suitePlacementConfig.js';
import type { SuiteLandingRule } from '../auth/suiteLanding.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';

export interface SuiteConfiguration {
  port: number;
  basePath: string;
  publicOrigin?: string;
  hosts?: readonly TenantHostIntent[];
  identity?: {
    id: string;
    name: string;
    /** A SQLite file, or a postgres:// URL with its `${NAME}` references expanded; `grants` is the same kind. */
    store: string;
    /** On PostgreSQL, the database the suite's grants, preferences and authority history keep their schemas in. */
    grants: string;
    environment: NodeJS.ProcessEnv;
    /** A single App's `auth.providers` and `auth.signUp`, for the suite's one sign-in. */
    providers?: readonly string[];
    signUp?: unknown;
    /** The identity providers `oidc:<name>` and `saml:<name>` name: entries as a config file gives them, `"kind": "oidc"` or `"saml"`. */
    services?: readonly FederatedProviderConfig[];
    /** Where a signed-in account goes from the suite's address, first rule that holds (suiteLanding.ts). */
    landing?: readonly SuiteLandingRule[];
  };
  email?: EmailServiceConfig & { environment: NodeJS.ProcessEnv };
  flags?: SuiteFlagConfiguration;
  console?: { readonly enabled: boolean };
  publicPlacement?: SuitePlacementConfiguration;
  experiments?: SuiteExperimentConfiguration;
  analytics?: AnalyticsConfiguration;
  apps: Array<{
    id: string;
    directory: string;
    config: string;
    mount: string;
    /** Its commands module, as serve's --commands: for a build, the build's own server/commands.mjs. */
    commands?: string;
    policy?: string;
    jobs?: string;
    environment: NodeJS.ProcessEnv;
    /** The App's local read API (`--api-reads` for serve): its integers and its arrival budget. */
    api?: { integers: 'decimal-string' | 'number'; requestsPerMinute: number };
  }>;
}

function record(value: unknown, keys: readonly string[] | undefined, where: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} must be an object.`);
  const object = value as Record<string, unknown>;
  const extra = keys && Object.keys(object).find((key) => !keys.includes(key));
  if (extra) throw new Error(`${where}: unsupported field "${extra}".`);
  return object;
}
function text(value: unknown, where: string): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) throw new Error(`${where} must be nonempty text.`);
  return value;
}

/** serve's `--api-integers` and `--api-requests-per-minute`, both required, by the same rules (startupOptions.ts). */
function apiOf(value: unknown, where: string): { integers: 'decimal-string' | 'number'; requestsPerMinute: number } {
  const api = record(value, ['integers', 'requestsPerMinute'], where);
  if (api.integers !== 'decimal-string' && api.integers !== 'number')
    throw new Error(`${where} needs "integers": "decimal-string" or "number".`);
  const rate = api.requestsPerMinute;
  if (typeof rate !== 'number' || !Number.isInteger(rate) || rate < 1 || rate > 1_000_000)
    throw new Error(`${where} needs "requestsPerMinute" from 1 to 1000000.`);
  return { integers: api.integers, requestsPerMinute: rate };
}

/** `identity.landing`: an ordered list, each rule an App and what the account
 * must hold there. A rule with neither `roles` nor `member` is the default,
 * and it must come last, since nothing after it could ever be reached. */
function landingOf(value: unknown): SuiteLandingRule[] {
  if (!Array.isArray(value) || !value.length || value.length > 64)
    throw new Error('Suite identity landing must be a list of 1 to 64 rules.');
  return value.map((entry, index) => {
    const where = `Suite identity landing rule ${index + 1}`;
    const rule = record(entry, ['app', 'roles', 'member'], where);
    const app = text(rule.app, `${where} app`);
    if (
      rule.roles !== undefined &&
      (!Array.isArray(rule.roles) ||
        !rule.roles.length ||
        rule.roles.some((role) => typeof role !== 'string' || !role) ||
        new Set(rule.roles).size !== rule.roles.length)
    )
      throw new Error(`${where}: roles must be a nonempty list of distinct role names.`);
    if (rule.member !== undefined && rule.member !== true) throw new Error(`${where}: member may only be true.`);
    if (rule.roles === undefined && rule.member === undefined && index !== value.length - 1)
      throw new Error(`${where} has no condition, so it must be the last rule.`);
    return {
      app,
      ...(rule.roles === undefined ? {} : { roles: rule.roles as string[] }),
      ...(rule.member ? { member: true as const } : {}),
    };
  });
}

export async function readSuiteConfiguration(file: string, environment: NodeJS.ProcessEnv = process.env): Promise<SuiteConfiguration> {
  const captured = { ...environment };
  const input = record(
    JSON.parse(await readFile(file, 'utf8')),
    [
      'port',
      'basePath',
      'apps',
      'identity',
      'publicOrigin',
      'hosts',
      'email',
      'flags',
      'console',
      'publicPlacement',
      'experiments',
      'analytics',
    ],
    'Suite',
  );
  const publicOrigin = input.publicOrigin === undefined ? undefined : normalizeSuitePublicOrigin(input.publicOrigin);
  const port = input.port ?? 4111;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Suite port must be an integer from 1 to 65535.');
  if (input.basePath !== undefined && typeof input.basePath !== 'string') throw new Error('Suite basePath must be text.');
  const basePath = parseBasePath((input.basePath as string | undefined) ?? '');
  if (!Array.isArray(input.apps) || !input.apps.length) throw new Error('Suite apps must be a nonempty list.');
  const home = dirname(resolve(file));
  const captureEnvironment = (input: unknown, where: string): NodeJS.ProcessEnv => {
    const aliases = input === undefined ? {} : record(input, undefined, where);
    const env: NodeJS.ProcessEnv = Object.create(null);
    for (const [name, from] of Object.entries(aliases)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || typeof from !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(from)) {
        throw new Error(`${where} maps variable names to operator environment variable names.`);
      }
      if (captured[from] === undefined) throw new Error(`${where}: environment variable ${from} is not set.`);
      env[name] = captured[from];
    }
    return Object.freeze(env);
  };
  let identity: SuiteConfiguration['identity'];
  if (input.identity !== undefined) {
    const value = record(
      input.identity,
      ['id', 'name', 'store', 'grants', 'environment', 'providers', 'signUp', 'services', 'landing'],
      'Suite identity',
    );
    const id = text(value.id, 'Suite identity id');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error('Invalid suite identity id.');
    /* A SQLite file beside the suite file, or a PostgreSQL URL that may name its password (or all of it) by
       ${NAME}, read from the operator's environment as an App's auth.store is. */
    const location = (input: unknown, setting: string) => {
      const written = text(input, `Suite ${setting}`);
      if (/^\$\{|^postgres(ql)?:\/\//i.test(written)) {
        let url: string;
        try {
          url = expandEnvReferences(written, captured);
        } catch (error) {
          throw new Error(`Suite ${setting}: ${(error as Error).message}`, { cause: error });
        }
        if (/^postgres(ql)?:\/\//i.test(url)) return { url, postgres: true };
      } else if (!written.includes('://')) return { url: resolve(home, written), postgres: false };
      throw new Error(`Suite ${setting} must be a SQLite file path or a postgres:// URL.`);
    };
    const store = location(value.store, 'identity.store'),
      grants = location(value.grants, 'identity.grants');
    /* Together or not at all: a suite on PostgreSQL is stateless, and a SQLite file beside it would put it back on a
       disk; and the projection's grant reads are synchronous on SQLite and awaited on PostgreSQL, one way per suite. */
    if (store.postgres !== grants.postgres)
      throw new Error(
        `Suite identity.store and identity.grants must both be PostgreSQL URLs or both SQLite files: identity.store is ${
          store.postgres ? 'PostgreSQL' : 'a SQLite file'
        } and identity.grants is ${grants.postgres ? 'PostgreSQL' : 'a SQLite file'}.`,
      );
    const env = captureEnvironment(value.environment, 'Suite identity environment');
    // The session secret, and what its identity providers' entries name by ${...}; never an administrator bootstrap.
    if (!env.BETTER_AUTH_SECRET || Object.keys(env).some((name) => name.startsWith('MISTRI_AUTH_ADMIN'))) {
      throw new Error(
        'Suite identity environment must map BETTER_AUTH_SECRET and no MISTRI_AUTH_ADMIN_* bootstrap; administrators are granted per App.',
      );
    }
    if (
      value.providers !== undefined &&
      (!Array.isArray(value.providers) || !value.providers.length || value.providers.some((item) => typeof item !== 'string'))
    ) {
      throw new Error("Suite identity providers must be a nonempty list, as an App's auth.providers is.");
    }
    if (value.services !== undefined && !Array.isArray(value.services))
      throw new Error('Suite identity services must be a list of "kind": "oidc" or "kind": "saml" entries.');
    const services = ((value.services ?? []) as unknown[]).map((entry, index) => {
      const where = `Suite identity service ${index + 1}`;
      const service = record(entry, undefined, where);
      if (service.kind === 'saml') return samlConnectionOf(service, where);
      if (service.kind !== 'oidc') throw new Error(`${where} must be "kind": "oidc" or "kind": "saml".`);
      return oidcConnectionOf(service, where);
    });
    if (new Set(services.map((service) => service.name)).size !== services.length)
      throw new Error('Suite identity services must have distinct names.');
    checkIdentityProviders(services, 'Suite identity services');
    identity = {
      id,
      name: value.name === undefined ? id : text(value.name, 'Suite identity name'),
      store: store.url,
      grants: grants.url,
      environment: env,
      providers: (value.providers as string[] | undefined) ?? ['email'],
      ...(value.signUp === undefined ? {} : { signUp: value.signUp }),
      services,
      ...(value.landing === undefined ? {} : { landing: landingOf(value.landing) }),
    };
    if (identity.store === identity.grants)
      throw new Error(
        store.postgres
          ? 'Suite identity.store and identity.grants must be separate PostgreSQL databases.'
          : 'Suite identity and grant stores must be separate files.',
      );
  }
  let email: SuiteConfiguration['email'];
  if (input.email !== undefined) {
    if (!identity || !publicOrigin) throw new Error('Suite email requires shared identity and an explicit publicOrigin.');
    const value = record(input.email, [...EMAIL_KEYS, 'environment'], 'Suite email');
    const { environment: aliases, ...service } = value;
    if (service.kind !== 'email' || typeof service.name !== 'string' || !service.name.trim() || typeof service.url !== 'string') {
      throw new Error('Suite email requires kind "email", a name and a transport URL.');
    }
    email = { ...emailConnectionOf(service, 'Suite email', home), environment: captureEnvironment(aliases, 'Suite email environment') };
  }
  const apps = input.apps.map((raw, index) => {
    const where = `Suite App ${index + 1}`;
    const app = record(raw, ['id', 'directory', 'config', 'mount', 'commands', 'policy', 'jobs', 'environment', 'api'], where);
    const id = text(app.id, `${where} id`);
    if (id === 'mistri-console') throw new Error('The mistri-console App id is reserved for the explicitly enabled suite Console.');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id)) throw new Error(`${where} has an invalid id.`);
    const env = captureEnvironment(app.environment, `${where} environment`);
    return {
      id,
      directory: resolve(home, text(app.directory, `${where} directory`)),
      config: resolve(home, text(app.config, `${where} config`)),
      mount: parseMountPath(text(app.mount, `${where} mount`), where),
      ...(app.commands === undefined ? {} : { commands: resolve(home, text(app.commands, `${where} commands`)) }),
      ...(app.policy === undefined ? {} : { policy: resolve(home, text(app.policy, `${where} policy`)) }),
      ...(app.jobs === undefined ? {} : { jobs: resolve(home, text(app.jobs, `${where} jobs`)) }),
      environment: Object.freeze(env),
      ...(app.api === undefined ? {} : { api: apiOf(app.api, `${where} api`) }),
    };
  });
  if (new Set(apps.map((app) => app.id)).size !== apps.length) throw new Error('Suite App ids must be unique.');
  const unknown = identity?.landing?.find((rule) => !apps.some((app) => app.id === rule.app));
  if (unknown) throw new Error(`Suite identity landing: "${unknown.app}" is not one of the suite's Apps.`);
  appMounts(
    apps.map((app) => app.id),
    { base: basePath, mounts: Object.fromEntries(apps.map((app) => [app.id, app.mount])) },
  );
  const hosts = validateTenantHosts(
    input.hosts,
    apps.map((app) => app.id),
    publicOrigin,
  );
  const identitySecrets = [identity?.environment.BETTER_AUTH_SECRET, ...apps.map((app) => app.environment.BETTER_AUTH_SECRET)].filter(
    (value): value is string => value !== undefined,
  );
  const publicPlacement = suitePlacementConfiguration(
    input.publicPlacement,
    captured,
    apps.map((app) => app.id),
    publicOrigin,
    identitySecrets,
  );
  const controls = suiteControlConfiguration(
    { flags: input.flags, console: input.console, experiments: input.experiments },
    Boolean(identity),
    {
      environment: captured,
      forbiddenSecrets: [...identitySecrets, ...(publicPlacement?.issuer.keys.map((key) => key.secret) ?? [])],
    },
  );
  const analytics = input.analytics === undefined ? undefined : parseAnalyticsConfiguration(input.analytics, 'Suite analytics', file);
  if (analytics?.app !== undefined && !apps.some((app) => app.id === analytics.app))
    throw new Error(`Suite analytics: app "${analytics.app}" is not one of the suite's Apps.`);
  if (analytics && analytics.app === undefined && apps.length > 1)
    throw new Error('Suite analytics: name the App with "app" when the suite has several.');
  return {
    port,
    basePath,
    apps,
    ...controls,
    ...(analytics ? { analytics } : {}),
    ...(publicPlacement ? { publicPlacement } : {}),
    ...(identity ? { identity } : {}),
    ...(email ? { email } : {}),
    ...(publicOrigin ? { publicOrigin } : {}),
    ...(input.hosts === undefined ? {} : { hosts }),
  };
}
