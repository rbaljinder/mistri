/**
 * The App framework's sections of a config file, as a table (`CONFIG_SECTIONS`) that a main hands to the engine's
 * reader (configSections.ts, `loadConfig`): webhooks, email, identity providers, SCIM directories, embed issuers, an
 * OAuth server, and the `analytics` key. All optional — a deployment that names none runs exactly as it would
 * without this file — and none is a source of truth. The cache is the engine's (cacheService.ts); the typed
 * readers of the registry's services (`emailOf(registry)`, `identityProvidersOf(registry)`, …) are here too.
 *
 * A search engine is not a section here: search providers are packs
 * (app/searchProvider.ts), and a `"kind": "search"` entry is refused
 * (httpConnection.ts). A
 * webhook (webhooks.ts) is where a command's effects are POSTed once it has
 * committed. An email service (email/email.ts) is how the platform sends mail.
 * An identity provider (auth/identityConfig.ts) is an OpenID Connect issuer or a
 * SAML 2.0 provider an App signs people in through. An OAuth authorization
 * server (api/oauthConfig.ts) is how a person gives an agent a token for an
 * App's network API. A SCIM directory (auth/scimConfig.ts) provisions the
 * people who sign in through one of those providers.
 *
 * Checked when the file is read, opened when first used. Credentials are
 * `${VAR}` references expanded only when the connection opens, as an HTTP
 * connection's are, and never logged. Written back on save exactly as they
 * were read.
 */
import { dirname, resolve } from 'node:path';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { mergeSections, serviceWhere, type ConfigSections, type ServiceConfig } from '@mistriwork/engine/server/configSections.js';
import { CACHE_SECTIONS } from '@mistriwork/engine/server/cacheService.js';
import { parseAnalyticsConfiguration, type AnalyticsConfiguration } from './analytics/config.js';
import { webhookConnectionOf, type WebhookServiceConfig } from './webhooks.js';
import { emailConnectionOf, emailEntry, openEmailTransport, type EmailServiceConfig, type EmailTransport } from './email/email.js';
import {
  checkIdentityProviders,
  checkOAuthServers,
  oauthConnectionOf,
  oauthEntry,
  oidcConnectionOf,
  oidcEntry,
  samlConnectionOf,
  samlEntry,
  type FederatedProviderConfig,
  type IdentityProviderConfig,
  type OAuthServerConfig,
  type SamlProviderConfig,
} from './auth/identityConfig.js';
import { checkEmbedIssuers, embedConnectionOf, embedEntry, type EmbedIssuerConfig } from './embed/issuerConfig.js';
import { checkScimDirectories, scimConnectionOf, scimEntry, type ScimDirectoryConfig } from './auth/scimConfig.js';

export { cacheAddress } from '@mistriwork/engine/server/cacheService.js';

declare module '@mistriwork/engine/server/configSections.js' {
  interface ServiceKinds {
    webhook: WebhookServiceConfig;
    email: EmailServiceConfig;
    oidc: IdentityProviderConfig;
    saml: SamlProviderConfig;
    scim: ScimDirectoryConfig;
    embed: EmbedIssuerConfig;
    oauth: OAuthServerConfig;
  }
}

declare module '@mistriwork/engine/server/connections.js' {
  interface LoadedConfig {
    /** Where behavior analytics goes, when the file says (packages/mistri/src/server/analytics/config.ts). */
    analytics?: AnalyticsConfiguration;
  }
}

const checkAcross = (services: readonly ServiceConfig[], path: string): void => {
  const providers = services.filter((service): service is FederatedProviderConfig => service.kind === 'oidc' || service.kind === 'saml');
  checkIdentityProviders(providers, path);
  checkScimDirectories(
    services.filter((service): service is ScimDirectoryConfig => service.kind === 'scim'),
    providers,
    path,
  );
  checkEmbedIssuers(
    services.filter((service): service is EmbedIssuerConfig => service.kind === 'embed'),
    path,
  );
  checkOAuthServers(
    services.filter((service): service is OAuthServerConfig => service.kind === 'oauth'),
    path,
  );
};

/**
 * Every section of a config file the mistri bin reads: the engine's cache and the App framework's. A main passes
 * the sections it owns to `loadConfig`; an entry of a kind it leaves out is refused there.
 */
export const CONFIG_SECTIONS: ConfigSections = mergeSections(CACHE_SECTIONS, {
  kinds: {
    webhook: {
      parse: (entry, path) => webhookConnectionOf(entry, serviceWhere(entry, path)),
      entry: ({ kind, name, url, auth }: WebhookServiceConfig) => ({ name, kind, url, ...(auth ? { auth } : {}) }),
    },
    email: {
      singleton: 'email service',
      // A relative log: path is the config file's neighbour, as a SQLite path is.
      parse: (entry, path) => emailConnectionOf(entry, serviceWhere(entry, path), dirname(resolve(path))),
      entry: emailEntry,
    },
    oidc: { urlless: true, parse: (entry, path) => oidcConnectionOf(entry, serviceWhere(entry, path)), entry: oidcEntry },
    saml: { urlless: true, parse: (entry, path) => samlConnectionOf(entry, serviceWhere(entry, path)), entry: samlEntry },
    scim: { urlless: true, parse: (entry, path) => scimConnectionOf(entry, serviceWhere(entry, path)), entry: scimEntry },
    embed: { urlless: true, parse: (entry, path) => embedConnectionOf(entry, serviceWhere(entry, path)), entry: embedEntry },
    oauth: { urlless: true, parse: (entry, path) => oauthConnectionOf(entry, serviceWhere(entry, path)), entry: oauthEntry },
  },
  checks: [checkAcross],
  top: { analytics: (value, path) => parseAnalyticsConfiguration(value, `${path}: analytics`, path) },
});

/* ---- the registry's typed readers ---- */

/** The webhook a config names, as written: where a command's effects are POSTed. Undefined when no webhook has that name. */
export function webhookConfigOf(registry: Registry, name: string): WebhookServiceConfig | undefined {
  return registry.servicesOfKind('webhook').find((s) => s.name === name);
}

/** The identity providers the config names (kinds "oidc" and "saml"), as written: their secrets are still references. */
export function identityProvidersOf(registry: Registry): FederatedProviderConfig[] {
  return registry.serviceConfigs().filter((s): s is FederatedProviderConfig => s.kind === 'oidc' || s.kind === 'saml');
}

/** The SCIM directories that provision its Apps' people (kind "scim"), as written: their tokens are still references. */
export function scimDirectoriesOf(registry: Registry): ScimDirectoryConfig[] {
  return registry.servicesOfKind('scim');
}

/** The hosts that sign people in to its Apps (kind "embed"), as written: their secrets are still references. */
export function embedIssuersOf(registry: Registry): EmbedIssuerConfig[] {
  return registry.servicesOfKind('embed');
}

/** The deployment's OAuth authorization server (kind "oauth"), as written; undefined when the config file names none. */
export function oauthServerOf(registry: Registry): OAuthServerConfig | undefined {
  return registry.servicesOfKind('oauth')[0];
}

/** The deployment's email service, as written; undefined when the config names none, and then nothing is ever mailed. */
export function emailConfigOf(registry: Registry): EmailServiceConfig | undefined {
  return registry.servicesOfKind('email')[0];
}

/** The email transport, opened on first use; undefined without an email service. */
export function emailOf(registry: Registry): EmailTransport | undefined {
  const config = emailConfigOf(registry);
  if (!config) return undefined;
  const held = registry.serviceState('email', () => ({ transport: undefined as EmailTransport | undefined }));
  return (held.transport ??= openEmailTransport(config));
}
