/**
 * The deployment's OAuth 2.1 authorization server for its Apps' network API
 * and HTTP MCP: the config file names it beside the databases and the
 * identity providers.
 *
 *   { "name": "agents", "kind": "oauth", "apps": ["compass"], "roles": ["sales"] }
 *
 * A person signed in to an App may then give an agent (an MCP client) a token
 * of their own, through the browser, instead of asking the operator for one:
 * the client registers itself, sends the person to a consent page, and is
 * handed an ordinary twa1 API token for the roles the person chose
 * (auth/oauthServer.ts). That is self-service issuance, so it is opt-in here
 * and nowhere else, and `roles` caps it: a role the operator keeps off this
 * list is never on a token a person gave out, whatever that person holds.
 * In a tenant App the person also picks one of their tenants, and the token
 * is that membership's, as `mistri api-token issue --tenant` makes one.
 *
 * Every lifetime is fixed, not configuration: an access token lives an hour,
 * a grant thirty days from consent, a code a minute.
 */
import type { AppDef } from '../../shared/appModel.js';
import type { OAuthServerConfig } from '../auth/identityConfig.js';

/* The entry itself is read with the identity providers' (auth/identityConfig.ts): reading the config file is on every
   startup path, `--mcp` included, and this module is only for a server that issues. */
export type { OAuthServerConfig };

/** An access token's life: the next request after it is a refresh. */
export const OAUTH_ACCESS_SECONDS = 3600;
/** A grant's life from consent, refreshes included: then the person consents again. */
export const OAUTH_GRANT_SECONDS = 30 * 24 * 3600;
/** A code's life between the redirect and its exchange. */
export const OAUTH_CODE_SECONDS = 60;

/** The authorization server that issues for this App, if the config file names one. */
function oauthFor(appId: string, services: readonly OAuthServerConfig[]): OAuthServerConfig | undefined {
  return services.find((service) => service.apps.includes(appId));
}

/** The App roles a token issued for this App may carry at most: the operator's cap within the API's roles. */
export function oauthRoleCeiling(app: AppDef, service: OAuthServerConfig): string[] {
  const declared = app.auth?.roles ?? {};
  // A tenant token acts through one membership: the platform realm, which reads across tenants, is never its role.
  const api = (app.api?.roles ?? []).filter(
    (role) => app.auth?.rows !== 'tenant' || (declared[role] as { realm?: string } | undefined)?.realm !== 'platform',
  );
  return service.roles ? api.filter((role) => service.roles!.includes(role)) : [...api];
}

/**
 * What an authorization server that names this App needs of it, said as
 * `mistri check` and startup say it: an App that signs people in (a token
 * is a person's), with a network API (an agent reaches it over the network),
 * and a ceiling of roles the API declares. Whether the token store is provisioned
 * and the server is reached over https are startup's to say: they are the
 * deployment's, not the App's.
 */
export function oauthProblems(app: AppDef, services: readonly OAuthServerConfig[]): string[] {
  const service = oauthFor(app.id, services);
  if (!service) return [];
  const named = `the config file's OAuth authorization server "${service.name}"`;
  if (!app.auth) {
    return [
      `${named} issues tokens for this App, which signs no one in [oauth-no-auth]. Give the App "auth", or take "${app.id}" off its "apps".`,
    ];
  }
  if (!app.api) {
    return [`${named} issues tokens for this App, which has no "api" [oauth-no-api]. Declare one, or take "${app.id}" off its "apps".`];
  }
  const problems: string[] = [];
  if (app.api.network !== true) {
    problems.push(
      `${named} issues tokens for this App, whose api does not declare network: true [oauth-not-network]. An agent reaches the API over the network; declare it, or take "${app.id}" off its "apps".`,
    );
  }
  for (const role of service.roles ?? []) {
    if (!app.api.roles.includes(role)) {
      problems.push(
        `${named} lets a token carry the role "${role}", which this App's api does not grant [oauth-role-unknown]. Name one of: ${app.api.roles.join(', ') || 'none'}.`,
      );
    }
  }
  return problems;
}
