/**
 * A SCIM 2.0 directory that provisions people into an App: the config file
 * names it beside the identity provider its people sign in through.
 *
 *   { "name": "entra", "kind": "scim", "provider": "workforce",
 *     "tokens": ["${ENTRA_SCIM_TOKEN}"],
 *     "roles": { "manager": ["Sales Managers"] } }
 *
 * The directory (Microsoft Entra, Okta, …) creates, updates, deactivates and
 * deletes people at `/api/auth/scim/v2/` with one of its bearer tokens
 * (scimDirectory.ts). Everything it may touch is fixed here, never by the
 * directory or by anyone signed in:
 *
 *   - `provider` binds it to one oidc or saml entry, whose `domains` it
 *     inherits and must have: it reaches only accounts whose address is in
 *     them. When that entry is a tenant's, the directory manages that
 *     tenant's memberships and never the global account;
 *   - `tokens` are one or two `${VAR}` references (two while one rotates),
 *     each at least 32 characters once expanded: a literal is refused, since
 *     the config file is committed as often as not;
 *   - `roles` maps an App role to the directory's group names. The listed
 *     roles are the directory's: it sets them and clears them, and never
 *     touches a role it does not list;
 *   - `apps` is its audience, as a host's is (embed/issuerConfig.ts).
 */
import { rolesOf } from '../../shared/accountAdministration.js';
import { TENANT_OIDC, TENANT_SAML, type AppDef } from '../../shared/appModel.js';
import type { FederatedProviderConfig } from './identityConfig.js';

export interface ScimDirectoryConfig {
  kind: 'scim';
  name: string;
  /** One or two `${VAR}` references to the directory's bearer tokens. */
  tokens: string[];
  /** The oidc or saml entry its people sign in through, by name. */
  provider: string;
  /** The Apps (by id) it provisions. Absent: every App that signs people in through `provider`. */
  apps?: string[];
  /** App role → the directory's group display names that give it. */
  roles?: Record<string, string[]>;
}

const SCIM_KEYS = ['name', 'kind', 'tokens', 'provider', 'apps', 'roles'] as const;

/** The shortest a token may be once expanded: a bearer secret, not a password. */
export const SCIM_TOKEN_MINIMUM = 32;

const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;
const NAME = /^[a-z][a-z0-9-]{0,39}$/;

/** An entry of kind "scim", checked. Throws naming the field. */
export function scimConnectionOf(entry: Record<string, unknown>, where: string): ScimDirectoryConfig {
  const stray = Object.keys(entry).find((key) => !(SCIM_KEYS as readonly string[]).includes(key));
  if (stray) throw new Error(`${where} is a SCIM directory, which takes no "${stray}". It takes: ${SCIM_KEYS.join(', ')}.`);
  const name = String(entry.name);
  if (!NAME.test(name)) throw new Error(`${where} has a name that is not lower-case letters, digits and hyphens, starting with a letter.`);
  if (
    !Array.isArray(entry.tokens) ||
    entry.tokens.length < 1 ||
    entry.tokens.length > 2 ||
    entry.tokens.some((token) => typeof token !== 'string' || !REFERENCE.test(token))
  ) {
    throw new Error(
      `${where} needs "tokens": one or two references like "\${ENTRA_SCIM_TOKEN}" (two while one rotates). A token lives in the environment, never in this file.`,
    );
  }
  if (new Set(entry.tokens).size !== entry.tokens.length) throw new Error(`${where} names the same token twice.`);
  if (typeof entry.provider !== 'string' || !NAME.test(entry.provider)) {
    throw new Error(`${where} needs "provider": the name of the oidc or saml entry its people sign in through.`);
  }
  let apps: string[] | undefined;
  if (entry.apps !== undefined) {
    if (!Array.isArray(entry.apps) || !entry.apps.length || entry.apps.some((app) => typeof app !== 'string' || !app.trim())) {
      throw new Error(`${where} has an "apps" that is not a nonempty list of App ids.`);
    }
    apps = [...new Set(entry.apps as string[])];
  }
  let roles: Record<string, string[]> | undefined;
  if (entry.roles !== undefined) {
    const given = entry.roles as Record<string, unknown>;
    if (!given || typeof given !== 'object' || Array.isArray(given) || !Object.keys(given).length) {
      throw new Error(
        `${where} has a "roles" that is not a map from an App role to the directory's group names, like { "manager": ["Sales Managers"] }.`,
      );
    }
    roles = {};
    for (const [role, groups] of Object.entries(given)) {
      if (
        !Array.isArray(groups) ||
        !groups.length ||
        groups.some((group) => typeof group !== 'string' || !group.trim() || group.length > 256 || /\p{Cc}/u.test(group))
      ) {
        throw new Error(`${where} maps the role "${role}" from something that is not a nonempty list of group names.`);
      }
      roles[role] = [...new Set(groups as string[])];
    }
  }
  return {
    kind: 'scim',
    name,
    tokens: [...(entry.tokens as string[])],
    provider: entry.provider,
    ...(apps ? { apps } : {}),
    ...(roles ? { roles } : {}),
  };
}

/** The config entry as written, for saving: the tokens stay references. */
export function scimEntry(service: ScimDirectoryConfig): Record<string, unknown> {
  const { kind, name, ...rest } = service;
  return { name, kind, ...rest };
}

/**
 * Across the file: each directory's provider is an identity provider the file
 * names, with the domains the directory is fenced to, and one provider has at
 * most one directory, since two would each deactivate what the other keeps.
 */
export function checkScimDirectories(
  directories: readonly ScimDirectoryConfig[],
  providers: readonly FederatedProviderConfig[],
  path: string,
): void {
  const bound = new Map<string, string>();
  for (const directory of directories) {
    const provider = providers.find((entry) => entry.name === directory.provider);
    if (!provider) {
      throw new Error(
        `${path}: SCIM directory "${directory.name}" names the provider "${directory.provider}", and no oidc or saml entry has that name.`,
      );
    }
    if (!provider.domains) {
      throw new Error(
        `${path}: SCIM directory "${directory.name}" provisions through "${provider.name}", which says no "domains". A directory reaches only addresses in its provider's domains: give "${provider.name}" its "domains".`,
      );
    }
    const before = bound.get(directory.provider);
    if (before) {
      throw new Error(
        `${path}: SCIM directories "${before}" and "${directory.name}" both provision through "${directory.provider}"; a provider has one directory.`,
      );
    }
    bound.set(directory.provider, directory.name);
  }
}

/** Whether the App signs people in through this provider: by name, or as a tenant's own. */
function signsInThrough(app: AppDef, provider: FederatedProviderConfig): boolean {
  const providers: readonly string[] = app.auth?.providers ?? [];
  if (provider.tenant !== undefined) return providers.includes(provider.kind === 'saml' ? TENANT_SAML : TENANT_OIDC);
  return providers.includes(`${provider.kind}:${provider.name}`);
}

/** The directories that provision people into this App. */
function scimFor(
  app: AppDef,
  directories: readonly ScimDirectoryConfig[],
  providers: readonly FederatedProviderConfig[],
): Array<{ directory: ScimDirectoryConfig; provider: FederatedProviderConfig }> {
  return directories.flatMap((directory) => {
    const provider = providers.find((entry) => entry.name === directory.provider);
    if (!provider || (directory.apps ? !directory.apps.includes(app.id) : !signsInThrough(app, provider))) return [];
    return [{ directory, provider }];
  });
}

/** The directories that provision this App, each with its provider; the first problem refuses startup. */
export function scimEntriesFor(
  app: AppDef,
  directories: readonly ScimDirectoryConfig[],
  providers: readonly FederatedProviderConfig[],
  where: string,
): Array<{ directory: ScimDirectoryConfig; provider: FederatedProviderConfig }> {
  if (!directories.length) return [];
  const problems = scimProblems(app, directories, providers);
  if (problems.length) throw new Error(`${where}: ${problems[0]}`);
  return scimFor(app, directories, providers);
}

/**
 * What a directory that provisions this App needs of it, said as `mistri
 * check` and startup say it: the App signs people in through the directory's
 * provider (or nobody it makes could sign in), and each mapped role is one
 * the App declares for a person: never a service's, never one the provider's
 * claims give (a claim-mapped role is re-read at every sign-in, and the two
 * would take it from each other), and a tenant's own directory maps only a
 * tenant's roles, which it needs to give a member any.
 */
export function scimProblems(
  app: AppDef,
  directories: readonly ScimDirectoryConfig[],
  providers: readonly FederatedProviderConfig[],
): string[] {
  const problems: string[] = [];
  const named = (directory: ScimDirectoryConfig) => `the config file's SCIM directory "${directory.name}"`;
  for (const directory of directories.filter((entry) => entry.apps?.includes(app.id))) {
    const provider = providers.find((entry) => entry.name === directory.provider);
    if (!app.auth) {
      problems.push(
        `${named(directory)} provisions this App, which signs no one in [scim-no-auth]. Give the App "auth", or take "${app.id}" off its "apps".`,
      );
    } else if (provider && !signsInThrough(app, provider)) {
      const said = provider.tenant !== undefined ? `${provider.kind}.tenants()` : `${provider.kind}('${provider.name}')`;
      problems.push(
        `${named(directory)} provisions this App through "${provider.name}", which this App does not sign people in through [scim-provider-unused]. Add ${said} to "auth.providers", or take "${app.id}" off its "apps".`,
      );
    }
  }
  if (!app.auth) return problems;
  const declared = app.auth.roles ?? {};
  for (const { directory, provider } of scimFor(app, directories, providers)) {
    const tenant = provider.tenant !== undefined;
    if (tenant && !directory.roles) {
      problems.push(
        `${named(directory)} manages tenant "${provider.tenant}"'s members, and maps no "roles" [scim-tenant-roles]. A member holds a tenant role: map one from the directory's groups.`,
      );
    }
    for (const role of Object.keys(directory.roles ?? {})) {
      const grant = Object.hasOwn(declared, role) ? declared[role] : undefined;
      const allowed = tenant
        ? grant !== undefined && grant.realm !== 'platform'
        : (grant !== undefined || role === 'admin') && rolesOf(role).length === 1;
      if (!allowed) {
        problems.push(
          `${named(directory)} maps the role "${role}", which this App does not declare${tenant ? ' for a tenant' : ''} [scim-role-unknown]. Map one of: ${
            Object.keys(declared)
              .filter((name) => !tenant || declared[name].realm !== 'platform')
              .join(', ') || 'none'
          }.`,
        );
      } else if (grant?.service) {
        problems.push(
          `${named(directory)} maps the role "${role}", which only a service holds [scim-role-service]. A directory provisions people.`,
        );
      } else if (grant?.claims) {
        problems.push(
          `${named(directory)} maps the role "${role}", which the identity provider's claims give [scim-role-claims]. A role is the directory's or the claims', never both.`,
        );
      }
    }
  }
  return problems;
}
