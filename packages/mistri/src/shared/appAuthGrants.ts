/**
 * `auth`: who may do what. Present means sign-in is required (the one
 * meaning `auth` may never loosen). Its grants are made within the resource
 * ceilings the resource blocks declare (`resources.<r>.access` and
 * `fields`, kept on each ResourceDef), and `auth` keeps what was authored:
 * the sign-in settings, `rows` — the one row-scoping word — and `roles`.
 *
 * Without `auth`, a resource's `access` is the App's whole ceiling: a
 * declared ceiling leaves the undeclared resources unwritten, and reads are
 * not restricted — a reader without sign-in is the connection's.
 *
 * `checkedGrants` re-reads the ceilings and the grants for the resolve-time
 * readers, which judge an identity only after the whole policy, inactive
 * roles included, checks out: a hand-built or mutated AppDef fails closed.
 */
import {
  AUTH_PROVIDERS,
  NAMED_PROVIDER,
  OPERATIONS_GRANT_ACTIONS,
  ROW_SCOPES,
  SIGN_UP_MODES,
  TENANT_OIDC,
  TENANT_SAML,
  parseRealm,
  type AppAuth,
  type AppClaimRule,
  type AppDef,
  type AppFieldAccess,
  type AppRoleFieldAccess,
  type AppProvider,
  type AppPublicGrant,
  type AppRoleGrant,
  type AppRows,
  type AppSignUp,
  type OperationsGrantAction,
} from './appModel.js';
import { RESERVED_NAMES, allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import { AppProblems, gather } from './appProblems.js';

/** The authored operations vocabulary: `bundle` is the sanitized support bundle (the internal `support`). */
import { checkFlagCapabilityReferences, normalizeFlagCapabilities } from './appFlagCapabilities.js';
import { normalizeFlagCatalog } from './appFlags.js';
import { normalizeExperimentDeclarations } from './appExperiments.js';

export const AUTHORED_OPERATIONS = ['readiness', 'bundle', 'workflows', 'jobs', 'deliveries', 'stores', 'analytics', 'support'] as const;

/** A whole-ceiling grant excludes platform resources outside the platform realm.
 * Shared by runtime access and its lock report; explicit grants validate separately. */
export function realmResources(app: AppDef, realm: AppRoleGrant['realm'], names: Iterable<string>): string[] {
  return [...names].filter((id) => realm === 'platform' || app.resources?.[id]?.owner !== 'platform');
}

/**
 * `ceiling` is what the resources declare (resourceCeiling): every declared
 * resource, the ones whose access is 'write', and the column ceilings.
 */
export function parseAuthGrants(
  raw: unknown,
  where: string,
  ceiling: { read: string[]; write: string[]; fields?: Record<string, AppFieldAccess> },
  namedSources: number,
): AppAuth | undefined {
  const { read, write } = ceiling;
  const fielded = Object.keys(ceiling.fields ?? {});
  if (raw === undefined) {
    if (fielded.length) {
      throw new Error(
        `${where}: resources "${fielded[0]}" has "fields", a column ceiling for signed-in roles; it needs "auth" and "auth.roles". Without sign-in, keep a column from every reader with "hidden": ['column']. See \`mistri docs secrets\`.`,
      );
    }
    return undefined;
  }
  const at = `${where}: "auth"`;
  if (!isRecord(raw)) throw new Error(`${at} is not an object.`);
  allowKeys(raw, ['providers', 'signUp', 'store', 'defaultRole', 'rows', 'roles', 'public', 'challenge', 'tenancy', 'me'], at);
  const providers = raw.providers === undefined ? ['email'] : raw.providers;
  if (!Array.isArray(providers) || !providers.length || providers.some((p) => !isAuthProvider(p))) {
    throw new Error(
      `${at} has "providers" that are not a list from: ${AUTH_PROVIDERS.join(', ')}, oidc('<name>') or saml('<name>') for an identity provider ` +
        "the config file names, and oidc.tenants() or saml.tenants() for each tenant's own.",
    );
  }
  if (new Set(providers).size !== providers.length) throw new Error(`${at} names a provider twice in "providers".`);
  const signUp = parseSignUp(raw.signUp, at, providers as AppProvider[]);
  if (raw.store !== undefined && (typeof raw.store !== 'string' || !raw.store.trim())) {
    throw new Error(`${at} has a "store" that is not a file path or a postgres:// URL.`);
  }
  if (raw.defaultRole !== undefined && (typeof raw.defaultRole !== 'string' || !/^[a-z][a-z0-9_-]*$/i.test(raw.defaultRole))) {
    throw new Error(`${at} has a "defaultRole" that is not a role name like "user".`);
  }
  if (raw.rows !== undefined && !(ROW_SCOPES as readonly unknown[]).includes(raw.rows)) {
    throw new Error(`${at} has a "rows" of "${String(raw.rows)}". Use "all", "policy" or "tenant".`);
  }
  const rows = (raw.rows ?? 'all') as AppRows;
  for (const [tenants, said] of [
    [TENANT_OIDC, 'oidc.tenants()'],
    [TENANT_SAML, 'saml.tenants()'],
  ] as const) {
    if (providers.includes(tenants) && rows !== 'tenant') {
      throw new Error(`${at} has ${said} in "providers", each tenant's own identity provider, which a tenant App has ("rows": "tenant").`);
    }
  }
  let tenancy: { label?: string; profile?: string; platform?: { label: string; me?: { from: string; column: string } } } | undefined;
  if (raw.tenancy !== undefined) {
    const here = `${at}, "tenancy"`;
    if (rows !== 'tenant') throw new Error(`${here} describes a tenant App's tenants; it needs "rows": "tenant".`);
    if (!isRecord(raw.tenancy)) throw new Error(`${here} is not an object { label?, profile?, platform? }.`);
    allowKeys(raw.tenancy, ['label', 'profile', 'platform'], here);
    const name = (value: unknown, key: string): string => {
      if (typeof value !== 'string' || !value.trim() || value.trim().length > 60)
        throw new Error(`${here} has a "${key}" that is not a name of 1 to 60 characters.`);
      return value.trim();
    };
    const given = raw.tenancy;
    tenancy = {
      ...(given.label === undefined ? {} : { label: name(given.label, 'label') }),
      ...(given.profile === undefined ? {} : { profile: name(given.profile, 'profile') }),
    };
    if (given.platform !== undefined) {
      if (!isRecord(given.platform)) throw new Error(`${here} has a "platform" that is not an object { label, me? }.`);
      allowKeys(given.platform, ['label', 'me'], `${here}, "platform"`);
      tenancy.platform = { label: name(given.platform.label, 'platform.label') };
      /* Who `me` is in the platform realm, as auth.me says it in a tenant's: the platform's own table of its staff
         and the column holding each one's account id. Shape only; the catalog says the rest
         (appMe.personTable, judged in the platform realm's projection, appTenancy.ts appForRealm). */
      const staff = given.platform.me;
      if (staff !== undefined) {
        const at = `${here}, "platform", "me"`;
        const shape = `${at} is { from, column }: the platform resource its staff are rows of, and its column holding their account id, like { from: 'staff', column: 'account_id' }.`;
        if (!isRecord(staff)) throw new Error(shape);
        allowKeys(staff, ['from', 'column'], at);
        if (typeof staff.from !== 'string' || !staff.from.trim() || typeof staff.column !== 'string' || !staff.column.trim())
          throw new Error(shape);
        tenancy.platform.me = { from: staff.from.trim(), column: staff.column.trim() };
      }
    }
  }
  /* Shape only; whether the table and column exist, and hold an email, is the
     catalog's to say (appMe.personTable). */
  let me: { from: string; column: string; create?: { name?: string } } | undefined;
  if (raw.me !== undefined) {
    const here = `${at}, "me"`;
    if (!isRecord(raw.me))
      throw new Error(
        `${here} is not an object { from, column }: the resource people are rows of, and its column holding their sign-in email.`,
      );
    allowKeys(raw.me, ['from', 'column', 'create'], here, { table: 'is now "from": the resource people are rows of' });
    const word = (value: unknown, key: string): string => {
      if (typeof value !== 'string' || !value.trim())
        throw new Error(`${here} needs a "${key}", like { from: 'employee', column: 'email' }.`);
      return value.trim();
    };
    me = { from: word(raw.me.from, 'from'), column: word(raw.me.column, 'column') };
    /* A new account's row, made by the server as the account is (server
       appPersonRows.ts). Whether the table can take it is the catalog's to say
       (appMe.personTable). */
    if (raw.me.create !== undefined) {
      const create = raw.me.create;
      const shape = `${here}, "create" is { name? }: the column a new account's name goes in, like create: { name: 'full_name' }.`;
      if (!isRecord(create)) throw new Error(shape);
      allowKeys(create, ['name'], `${here}, "create"`);
      if (create.name !== undefined && (typeof create.name !== 'string' || !create.name.trim())) throw new Error(shape);
      /* A tenant App's people are each tenant's, made where a membership is
         accepted inside the tenant's own fenced transaction; that door does
         not write App rows yet. */
      if (rows === 'tenant')
        throw new Error(
          `${here}, "create" makes a person row as an account is made, which a tenant App (rows: "tenant") does not do yet. Add the row in the tenant's onboarding command.`,
        );
      me.create = create.name === undefined ? {} : { name: (create.name as string).trim() };
    }
  }
  const signIn = {
    providers: providers as AppAuth['providers'],
    signUp,
    ...(raw.store === undefined ? {} : { store: (raw.store as string).trim() }),
    defaultRole: (raw.defaultRole as string | undefined) ?? 'user',
  };
  if (raw.roles === undefined) {
    if (raw.public !== undefined) {
      throw new Error(`${at} has "public", which opens resources within the ceilings to signed-out visitors; it needs "auth.roles".`);
    }
    if (write.length) {
      throw new Error(
        `${where}: resources "${write[0]}" declares access 'write', and this App signs people in, so its ceilings are granted through "auth.roles" — which it does not declare. ` +
          'Give each role its reads and writes within the ceilings, or drop "access" from the resources for a signed-in App with no grants.',
      );
    }
    if (rows !== 'all')
      throw new Error(`${at} has "rows": "${rows}", which scopes rows within role grants; it needs "auth.roles" and resource ceilings.`);
    return { ...signIn, rows, ...(me ? { me } : {}) };
  }
  if (!read.length) {
    throw new Error(
      `${at} has "roles", which grant within resource ceilings, and the App declares no resources. Declare each resource the App reads: resources: { <name>: {} }.`,
    );
  }
  if (!isRecord(raw.roles) || !Object.keys(raw.roles).length)
    throw new Error(`${at} has "roles" that are not a non-empty object of role grants.`);
  const readable = new Set(read);
  const writable = new Set(write);
  const roles: Record<string, AppRoleGrant> = {};
  const inherited = inheritedGrants(raw.roles, at, ceiling);
  /* Every role's refusals are said in one run: a role's grants are judged on their own, so fixing one role's
     create/write/fields and reloading to meet the next role's was one run a role. */
  const roleProblems: string[] = [];
  for (const [name, rawGrant] of Object.entries(inherited))
    gather(roleProblems, () => {
      const here = `${at}, role "${name}"`;
      assertRoleName(name, here);
      if (!isRecord(rawGrant)) throw new Error(`${here} is not an object.`);
      allowKeys(
        rawGrant,
        [
          'label',
          'extends',
          'read',
          'write',
          'create',
          'export',
          'commands',
          'actions',
          'operations',
          'fields',
          'realm',
          'claims',
          'service',
          'flags',
          'experiments',
        ],
        here,
        ROLE_RENAMED,
      );
      // Whether a realm is required, and what a tenant role may name, is judged once the App is whole (appTenancy.ts).
      const realm = rawGrant.realm === undefined ? undefined : parseRealm(rawGrant.realm, here);
      const scope = (key: 'read' | 'write', ceiling: ReadonlySet<string>, word: string): boolean | string[] => {
        const value = rawGrant[key];
        if (value === undefined) return false;
        if (typeof value === 'boolean') return value;
        const names = accessResources(value, `${here}, "${key}"`);
        for (const resource of names) {
          if (ceiling.has(resource)) continue;
          /* The role is rarely what is wrong: a role grants within what the
           resource declares, and a resource with no access declares nothing. */
          const declared = readable.has(resource)
            ? `resources "${resource}" is not written (it has no access 'write')`
            : `the App declares no resource "${resource}"`;
          throw new Error(
            `${here}, "${key}" names "${resource}", and ${declared} [outside-ceiling]: a role ${word === 'read' ? 'reads' : 'writes'} only ` +
              `a resource whose own access allows it, whatever the role says. ` +
              `${word === 'read' ? `Declare it under resources.` : `Give it resources.${resource}.access: 'write' (a command's target needs it too).`} ` +
              `Resources the App ${word === 'read' ? 'reads' : 'writes'}: ${[...ceiling].join(', ') || 'none'}.`,
          );
        }
        return names;
      };
      const mine: string[] = [];
      const roleRead = gather(mine, () => scope('read', readable, 'read')) ?? false;
      const roleWrite = gather(mine, () => scope('write', writable, 'write')) ?? false;
      const reads = new Set(roleRead === true ? read : roleRead === false ? [] : roleRead);
      for (const resource of roleWrite === true ? write : roleWrite === false ? [] : roleWrite) {
        if (!reads.has(resource)) mine.push(`${here}, "write" names "${resource}", which the role does not read.`);
      }
      /* What the role makes new rows in, of what it writes: every one unless
       it says. `false` is a role that edits and never creates; a list names
       the few it creates. Said here, New, quick add, related create and the
       generic insert all answer to it. */
      let create: false | string[] | undefined;
      if (rawGrant.create !== undefined)
        gather(mine, () => {
          const writes = new Set(roleWrite === true ? write : roleWrite === false ? [] : roleWrite);
          if (rawGrant.create === true)
            throw new Error(`${here}, "create": true is what a role that writes already does; drop it, or say false or a list.`);
          if (!writes.size) throw new Error(`${here}, "create" limits what the role creates of what it writes, and it writes nothing.`);
          create = rawGrant.create === false ? false : accessResources(rawGrant.create, `${here}, "create"`);
          for (const resource of create === false ? [] : create) {
            if (!writes.has(resource)) throw new Error(`${here}, "create" names "${resource}", which the role does not write.`);
          }
        });
      /* What the role may export beyond what it writes (which it always may): of what it reads. */
      let exports: string[] | undefined;
      if (rawGrant.export !== undefined)
        gather(mine, () => {
          exports = accessResources(rawGrant.export, `${here}, "export"`);
          for (const resource of exports) {
            if (!reads.has(resource)) throw new Error(`${here}, "export" names "${resource}", which the role does not read.`);
          }
        });
      let operations: OperationsGrantAction[] | undefined;
      if (rawGrant.operations !== undefined)
        gather(mine, () => {
          const value = rawGrant.operations;
          if (
            !Array.isArray(value) ||
            !value.length ||
            value.some((action) => !(AUTHORED_OPERATIONS as readonly unknown[]).includes(action))
          ) {
            throw new Error(
              `${here}, "operations" must be a nonempty list from "readiness", "bundle", "workflows", "jobs", "deliveries", "stores", "analytics" and "support".`,
            );
          }
          if (new Set(value).size !== value.length) throw new Error(`${here}, "operations" contains duplicate operations.`);
          /* 'support' is the support sessions' history, which the realm splits: a tenant role reads its own tenant's, a
         platform role every tenant's (supportSessions). The other words are operator reads; 'bundle' is the support
         bundle, held internally as 'support'. */
          const reads = value.filter((action) => action !== 'support');
          operations = reads.length
            ? reads.map((action) => (action === 'bundle' ? 'support' : action) as OperationsGrantAction)
            : undefined;
        });
      const roleFields =
        rawGrant.fields === undefined ? undefined : gather(mine, () => parseFieldAccess(rawGrant.fields, `${here}, "fields"`, true));
      for (const resource of Object.keys(roleFields ?? {})) {
        if (!reads.has(resource)) mine.push(`${here}, "fields" names "${resource}", which the role does not read.`);
      }
      if (mine.length) throw new AppProblems(mine);
      const sessions = supportSessions(rawGrant.operations, realm);
      let actions: Record<string, string[]> | undefined;
      if (rawGrant.actions !== undefined) {
        /* Judged inside the write against the one row being written. A row
         policy's writer judges it there too, under the policy's rows; a
         tenant's context writes through its own owner, which holds no fixed
         action's grant yet, so a tenant App is refused. */
        if (rows === 'tenant') {
          throw new Error(
            `${here}, "actions" grants fixed actions without write, which is not supported with "rows": "${rows}" yet. ` +
              'Grant the command the action runs instead, or write on the resource.',
          );
        }
        actions = actionGrants(
          rawGrant.actions,
          `${here}, "actions"`,
          reads,
          new Set(roleWrite === true ? write : roleWrite === false ? [] : roleWrite),
          writable,
        );
      }
      const claims = rawGrant.claims === undefined ? undefined : claimRule(rawGrant.claims, `${here}, "claims"`);
      const service = serviceRole(rawGrant, here);
      if (service && claims)
        throw new Error(`${here} is a service role and has "claims": a claim gives a role to a person, and no person holds this one.`);
      if (service && name === raw.defaultRole)
        throw new Error(`${at} has "defaultRole": "${name}", a service role: a new account is a person, and no person holds it.`);
      roles[name] = {
        ...roleLabelOf(rawGrant, here),
        ...(typeof rawGrant.extends === 'string' ? { extends: rawGrant.extends } : {}),
        read: roleRead,
        write: roleWrite,
        ...(create === undefined ? {} : { create }),
        ...(exports === undefined ? {} : { export: exports }),
        ...(realm === undefined ? {} : { realm }),
        ...(rawGrant.commands === undefined ? {} : { commands: commandGrants(rawGrant.commands, `${here}, "commands"`) }),
        ...(actions === undefined ? {} : { actions }),
        ...(operations === undefined ? {} : { operations }),
        ...controlCapabilities(rawGrant),
        ...(roleFields === undefined ? {} : { fields: roleFields }),
        ...sessions,
        ...(claims === undefined ? {} : { claims }),
        ...(service ? { service } : {}),
      };
    });
  if (roleProblems.length) throw new AppProblems(roleProblems);
  claimMappingProblems(roles, providers as AppProvider[], rows, at);
  if (rows === 'policy' && !namedSources) {
    throw new Error(`${at} has "rows": "policy", which requires named "sources" (one of them the default).`);
  }
  if (rows === 'tenant' && namedSources !== 1) {
    throw new Error(`${at} has "rows": "tenant", which requires exactly one named source.`);
  }
  const open = raw.public === undefined ? undefined : parsePublicGrant(raw.public, `${at}, "public"`, readable);
  /* The verifier every public door asks before it reads a submission (commands/challenges.ts): a name in the commands
     module's `challenges`, which the App's load checks is there. */
  if (raw.challenge !== undefined && (typeof raw.challenge !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(raw.challenge)))
    throw new Error(`${at}, "challenge" names a verifier of the commands module's "challenges": a word like "verifyHuman".`);
  const challenge = raw.challenge as string | undefined;
  return {
    ...signIn,
    rows,
    roles,
    ...(open ? { public: open } : {}),
    ...(challenge ? { challenge } : {}),
    ...(tenancy ? { tenancy } : {}),
    ...(me ? { me } : {}),
  };
}

/** One of the built-in providers, a named identity provider (`oidc:<name>`, `saml:<name>`), or each tenant's own (`oidc:*`, `saml:*`). */
export function isAuthProvider(value: unknown): value is AppProvider {
  if (typeof value !== 'string') return false;
  if ((AUTH_PROVIDERS as readonly string[]).includes(value) || value === TENANT_OIDC || value === TENANT_SAML) return true;
  const named = NAMED_PROVIDER.exec(value);
  // A config entry's name becomes Better Auth's provider id: never one of its own.
  return named !== null && !['email', 'github', 'google', 'credential'].includes(named[1]);
}

/** A domain as a DNS name, in lower case: what an email's part after the "@" is compared with. */
export const EMAIL_DOMAIN = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * `signUp`: 'invite', 'open', or just in time: `{ providers, domains }`,
 * where an account is made at its first sign-in through an identity provider.
 * Never email and password: an address a person types is not proven by the
 * typing, and a domain is only as good as the proof of the address in it.
 */
function parseSignUp(raw: unknown, at: string, providers: AppProvider[]): AppSignUp {
  if (raw === undefined) return 'invite';
  if ((SIGN_UP_MODES as readonly unknown[]).includes(raw)) return raw as AppSignUp;
  if (!isRecord(raw))
    throw new Error(
      `${at} has a "signUp" of ${JSON.stringify(raw)}. Use "open", "invite", or { providers, domains } for sign-up at a first sign-in through an identity provider.`,
    );
  const here = `${at}, "signUp"`;
  allowKeys(raw, ['providers', 'domains'], here);
  if (raw.providers === undefined && raw.domains === undefined) {
    throw new Error(
      `${here} names neither "providers" nor "domains": say which identity providers, or which email domains, may make an account at a first sign-in.`,
    );
  }
  const federated = providers.filter((provider) => provider !== 'email');
  if (!federated.length)
    throw new Error(
      `${here} makes accounts at a first sign-in through an identity provider, and "providers" lists none. Email sign-up is "open".`,
    );
  const out: { providers?: AppProvider[]; domains?: string[] } = {};
  if (raw.providers !== undefined) {
    if (!Array.isArray(raw.providers) || !raw.providers.length) throw new Error(`${here} has "providers" that are not a nonempty list.`);
    for (const provider of raw.providers) {
      if (provider === 'email')
        throw new Error(
          `${here}, "providers" names email; email sign-up is "open", and just-in-time sign-up is through an identity provider.`,
        );
      if (!federated.includes(provider))
        throw new Error(
          `${here}, "providers" names ${JSON.stringify(provider)}, which "auth.providers" does not list. It lists: ${federated.join(', ')}.`,
        );
    }
    if (new Set(raw.providers).size !== raw.providers.length) throw new Error(`${here}, "providers" names a provider twice.`);
    out.providers = [...raw.providers] as AppProvider[];
  }
  if (raw.domains !== undefined) {
    if (!Array.isArray(raw.domains) || !raw.domains.length) throw new Error(`${here} has "domains" that are not a nonempty list.`);
    for (const domain of raw.domains) {
      if (typeof domain !== 'string' || !EMAIL_DOMAIN.test(domain))
        throw new Error(`${here}, "domains" has ${JSON.stringify(domain)}, which is not a domain in lower case like "example.com".`);
    }
    if (new Set(raw.domains).size !== raw.domains.length) throw new Error(`${here}, "domains" names a domain twice.`);
    out.domains = [...raw.domains];
  }
  return out;
}

/** `claims`: `{ <claim>: [values] }`, the claim a name or a dotted path into one (`realm_access.roles`), and
    `provider`, the one named identity provider whose claims these are (0.8.5 I1). */
function claimRule(raw: unknown, here: string): AppClaimRule {
  if (!isRecord(raw) || !Object.keys(raw).some((key) => key !== 'provider')) {
    throw new Error(`${here} must be an object of claim → values, like { groups: ['underwriters'] } or { roles: ['Underwriter'] }.`);
  }
  const { provider, ...claims } = raw;
  if (provider !== undefined && (typeof provider !== 'string' || !NAMED_PROVIDER.test(provider))) {
    throw new Error(
      `${here} has a "provider" that is not a named identity provider: say the one whose claims these are, like oidc('workforce') or saml('corp').`,
    );
  }
  const match = Object.fromEntries(
    Object.entries(claims).map(([claim, values]) => {
      if (!claim.trim() || claim.trim() !== claim || claim.length > 200 || /\p{Cc}/u.test(claim) || RESERVED_NAMES.has(claim)) {
        throw new Error(`${here} names a claim ${JSON.stringify(claim)} that is not a claim name or a dotted path into one.`);
      }
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.some((value) => typeof value !== 'string' || !value || value.length > 256 || /\p{Cc}/u.test(value))
      ) {
        throw new Error(`${here}, "${claim}" must be a nonempty list of the claim's values that give the role.`);
      }
      if (new Set(values).size !== values.length) throw new Error(`${here}, "${claim}" names a value twice.`);
      return [claim, [...values] as string[]];
    }),
  );
  return provider === undefined ? { match } : { provider: provider as AppProvider, match };
}

/**
 * A mapping from claims is identity authority, judged where the whole policy
 * is known: only an App that signs in through a named identity provider has
 * claims to read, a tenant App's roles are its members' memberships and
 * never a claim, and a role the claims give must grant something.
 */
function claimMappingProblems(roles: Record<string, AppRoleGrant>, providers: readonly AppProvider[], rows: AppRows, at: string): void {
  const mapped = Object.entries(roles).filter(([, grant]) => grant.claims !== undefined);
  if (!mapped.length) return;
  const [first] = mapped[0];
  if (rows === 'tenant') {
    throw new Error(
      `${at}, role "${first}" has "claims" [claim-in-tenant-app]: a tenant App's roles are its members' memberships in the tenant store, never a claim. ` +
        'Grant the membership instead (`mistri docs identity-providers`).',
    );
  }
  if (!providers.some((provider) => NAMED_PROVIDER.test(provider))) {
    throw new Error(
      `${at}, role "${first}" has "claims" [claim-without-provider]: roles from claims need an identity provider in "providers", like oidc('workforce') or saml('corp').`,
    );
  }
  for (const [name, grant] of mapped) {
    const from = grant.claims!.provider;
    if (from !== undefined && !providers.includes(from)) {
      throw new Error(
        `${at}, role "${name}" reads its claims from "${from}" [claim-provider-unknown], which "providers" does not name. ` +
          `Name one of: ${providers.filter((provider) => NAMED_PROVIDER.test(provider)).join(', ')}.`,
      );
    }
    const some = (scope: boolean | string[]) => scope === true || (Array.isArray(scope) && scope.length > 0);
    const grants =
      some(grant.read) ||
      some(grant.write) ||
      grant.commands?.length ||
      grant.actions ||
      grant.operations?.length ||
      grant.flags?.length ||
      grant.experiments?.length;
    if (!grants) {
      throw new Error(
        `${at}, role "${name}" has "claims" and grants nothing [claim-grants-nothing]: the claims would sign people in to an App they can do nothing in. ` +
          'Give the role its reads, writes or commands, or drop "claims".',
      );
    }
  }
}

/* `supportLog` and `supportAudit` disclose a support session's history, so
   they are declared and never defaulted: present means exactly true. A `false`
   would read as "declared and denied", which is the same as absent and invites
   the reader to think one of the two spellings grants something. */
/** `service: true`: a role only a service principal holds; anything else said there is refused. */
function serviceRole(rawGrant: Record<string, unknown>, here: string): true | undefined {
  if (rawGrant.service === undefined) return undefined;
  if (rawGrant.service !== true)
    throw new Error(`${here} has a "service" that is not true: say it on a role no person holds, or leave it out.`);
  return true;
}

/* `operations: ['support']`: the support sessions' history, read from the role's own realm. A dealer's role reads its
   own sessions (supportLog), the platform's every dealer's (supportAudit); one word, because the realm already says
   which half. Without the platform realm there are no sessions, which appTenancy refuses with the word as authored. */
function supportSessions(operations: unknown, realm: AppRoleGrant['realm']): { supportLog?: true; supportAudit?: true } {
  if (!Array.isArray(operations) || !operations.includes('support')) return {};
  return realm === 'platform' ? { supportAudit: true } : { supportLog: true };
}

/* Spellings renamed before 1.0, refused with the word that replaced them (allowKeys' `refused`). */
const ROLE_RENAMED = {
  from: 'is now "claims": the identity-provider claim that gives a person this role',
  supportLog: 'is now "operations": ["support"], which reads the support sessions of the role\'s own realm',
  supportAudit: 'is now "operations": ["support"], which reads the support sessions of the role\'s own realm',
} as const;

/**
 * `auth.public`: the resources a signed-out visitor reads, each one named —
 * never `true`, so nothing is public by accident — and none written.
 *
 * With `rows: 'policy'` the two answer different readers and do not meet: a
 * visitor is scoped by this grant, which names its resources and narrows
 * their columns, and a signed-in account is scoped by the policy. The policy
 * is never asked about a visitor — there is no principal to ask it about —
 * so a resource a visitor may read is read whole, which is what "public"
 * means. That is the shape a marketplace has: a catalogue anyone may browse
 * and a shortlist that is one account's.
 *
 * With `rows: 'tenant'` a visitor is a visitor *to one tenant*, which the
 * address says and this grant does not: the tenant's public address (`?via=`)
 * or an operator's mapped host names the tenant, and the tenant policy's
 * `resolvePublicRows` picks that tenant's public rows (tenantPublicRead.ts).
 * This grant still names the resources and their columns; a platform-owned
 * one is refused where ownership is read (appTenancy.ts).
 */
function parsePublicGrant(raw: unknown, here: string, readable: ReadonlySet<string>): AppPublicGrant {
  if (!isRecord(raw)) throw new Error(`${here} is not an object { read, fields? }.`);
  allowKeys(raw, ['read', 'fields'], here);
  if (raw.read === true)
    throw new Error(`${here}, "read" is true; name each resource a signed-out visitor reads, so none is public by accident.`);
  const read = accessResources(raw.read, `${here}, "read"`);
  if (!read.length) throw new Error(`${here}, "read" names no resource.`);
  for (const resource of read) {
    if (!readable.has(resource)) {
      throw new Error(
        `${here}, "read" names "${resource}", which is outside the read ceiling. Resources the App declares: ${[...readable].join(', ') || 'none'}.`,
      );
    }
  }
  const fields = raw.fields === undefined ? undefined : parseFieldAccess(raw.fields, `${here}, "fields"`);
  for (const [resource, rule] of Object.entries(fields ?? {})) {
    if (!read.includes(resource)) throw new Error(`${here}, "fields" names "${resource}", which "read" does not.`);
    if (rule.write?.length) throw new Error(`${here}, "fields" for "${resource}" writes; a signed-out visitor writes nothing.`);
  }
  return { read, ...(fields ? { fields } : {}) };
}

/* ---------- the policy, as the resolve-time readers re-read it ---------- */

function assertRoleName(role: string, where: string): void {
  if (!/^[a-z][a-z0-9_-]*$/i.test(role) || RESERVED_NAMES.has(role)) {
    throw new Error(`${where}: role names must be safe identifiers like "agent".`);
  }
}

function accessResources(raw: unknown, where: string): string[] {
  if (!Array.isArray(raw) || raw.some((name) => typeof name !== 'string' || !name.trim())) {
    throw new Error(`${where} must be a list of logical resource names.`);
  }
  const names = (raw as string[]).map((name) => name.trim());
  if (new Set(names).size !== names.length) throw new Error(`${where} contains duplicate resources.`);
  return names;
}

function assertAccessSubset(scope: Iterable<string>, ceiling: ReadonlySet<string>, where: string): void {
  for (const resource of scope) {
    if (!ceiling.has(resource)) throw new Error(`${where}: resource "${resource}" is outside its access ceiling.`);
  }
}

function commandGrants(raw: unknown, where: string): string[] {
  if (
    !Array.isArray(raw) ||
    Array.from(raw).some((id) => typeof id !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(id) || RESERVED_NAMES.has(id))
  ) {
    throw new Error(`${where} must be a list of non-reserved command identifiers like "approve-loan".`);
  }
  if (new Set(raw).size !== raw.length) throw new Error(`${where} contains duplicate commands.`);
  return [...raw];
}

/**
 * `actions`: fixed actions a role runs on a resource it reads and does not
 * write, each by its id. Shape and scope only; whether each id is one of the
 * resource's fixed actions is fixedActionProblem's, once the App is whole. A role that writes the resource already runs its actions, so naming
 * one there says nothing and is refused rather than read as a narrowing.
 */
function actionGrants(
  raw: unknown,
  where: string,
  reads: ReadonlySet<string>,
  writes: ReadonlySet<string>,
  ceiling: ReadonlySet<string>,
): Record<string, string[]> {
  if (!isRecord(raw) || !Object.keys(raw).length) {
    throw new Error(`${where} must be an object of resource → action ids, like { pay_run: ['submit'] }.`);
  }
  return Object.fromEntries(
    Object.entries(raw).map(([resource, labels]) => {
      const at = `${where}, "${resource}"`;
      if (!reads.has(resource)) throw new Error(`${at}: the role does not read "${resource}"; an action runs on a record its role reads.`);
      if (!ceiling.has(resource))
        throw new Error(`${at}: "${resource}" is outside the write ceiling, and an action writes. Give it access 'write'.`);
      if (writes.has(resource)) {
        throw new Error(
          `${at}: the role already writes "${resource}", which runs every action on it. Drop the resource from "write" or from "actions".`,
        );
      }
      if (!Array.isArray(labels) || !labels.length || labels.some((label) => typeof label !== 'string' || !label.trim())) {
        throw new Error(`${at} must be a nonempty list of the resource's action ids.`);
      }
      const named = labels.map((label) => (label as string).trim());
      if (new Set(named).size !== named.length) throw new Error(`${at} names an action twice.`);
      return [resource, named];
    }),
  );
}

/**
 * Why a granted id is not one of the resource's fixed actions, or undefined.
 * A command action is granted by its command, never by its action's id: the
 * two grants stay two words.
 */
export function fixedActionProblem(app: Pick<AppDef, 'resources'>, resource: string, id: string, where: string): string | undefined {
  const actions = app.resources?.[resource]?.actions ?? [];
  const match = actions.find((action) => action.id === id);
  if (match && match.command === undefined) return undefined;
  if (match) {
    return `${where} names "${id}", which runs the command "${match.command!.id}"; grant a command through "commands", not "actions".`;
  }
  const fixed = actions.filter((action) => action.command === undefined).map((action) => `"${action.id}"`);
  return `${where} names "${id}", which is not an action of "${resource}". Its fixed actions: ${fixed.join(', ') || 'none'}.`;
}

function checkedActionGrants(
  app: Pick<AppDef, 'resources'>,
  raw: unknown,
  here: string,
  readable: readonly string[],
  writable: readonly string[],
  ceiling: ReadonlySet<string>,
): Record<string, string[]> {
  const grants = actionGrants(raw, `${here}, "actions"`, new Set(readable), new Set(writable), ceiling);
  for (const [resource, ids] of Object.entries(grants)) {
    for (const id of ids) {
      const problem = fixedActionProblem(app, resource, id, `${here}, "actions", "${resource}"`);
      if (problem) throw new Error(problem);
    }
  }
  return grants;
}

/** Operator reads are named, not implied by any data grant; these words are the whole vocabulary. */
function operationsGrants(raw: unknown, where: string): OperationsGrantAction[] {
  if (
    !Array.isArray(raw) ||
    !raw.length ||
    Array.from(raw).some((action) => !(OPERATIONS_GRANT_ACTIONS as readonly unknown[]).includes(action))
  ) {
    throw new Error(
      `${where} must be a nonempty list from "readiness", "bundle", "workflows", "jobs", "deliveries", "stores" and "analytics".`,
    );
  }
  if (new Set(raw).size !== raw.length) throw new Error(`${where} contains duplicate operations.`);
  return [...raw] as OperationsGrantAction[];
}

/** `role`: a role's grant, whose `read` may be omitted (the resource's own read ceiling) to narrow only `write`. */
export function parseFieldAccess(raw: unknown, where: string): Record<string, AppFieldAccess>;
export function parseFieldAccess(raw: unknown, where: string, role: true): Record<string, AppRoleFieldAccess>;
export function parseFieldAccess(raw: unknown, where: string, role = false): Record<string, AppRoleFieldAccess> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)))
    throw new Error(`${where} must be an object of field grants.`);
  const columns = (value: unknown, at: string): string[] => {
    if (!Array.isArray(value) || Array.from(value).some((column) => typeof column !== 'string' || !column.trim())) {
      throw new Error(`${at} must be a list of local column names.`);
    }
    if (new Set(value).size !== value.length) throw new Error(`${at} contains duplicate columns.`);
    return [...value];
  };
  return Object.fromEntries(
    Reflect.ownKeys(raw).map((resource) => {
      const descriptor = Object.getOwnPropertyDescriptor(raw, resource)!;
      if (typeof resource !== 'string' || !resource.trim() || resource.trim() !== resource || !('value' in descriptor)) {
        throw new Error(`${where} requires canonical resource names and data-only grants.`);
      }
      const value = descriptor.value;
      if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
        throw new Error(`${where}.${resource} must be a field grant.`);
      if (
        Reflect.ownKeys(value).some(
          (key) =>
            typeof key !== 'string' || !['read', 'write'].includes(key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!),
        )
      )
        throw new Error(`${where}.${resource} accepts only read/write column lists.`);
      if (role && value.read === undefined) {
        if (value.write === undefined) throw new Error(`${where}.${resource} names read, write or both.`);
        return [resource, { write: columns(value.write, `${where}.${resource}.write`) }];
      }
      const read = columns(value.read, `${where}.${resource}.read`);
      const write = value.write === undefined ? [] : columns(value.write, `${where}.${resource}.write`);
      for (const column of write) if (!read.includes(column)) throw new Error(`${where}.${resource}.write requires readable columns.`);
      return [resource, { read, write }];
    }),
  );
}

/**
 * The ceilings (each resource's `access` and `fields`) and the role grants
 * of an App that grants by role, re-read before any identity is judged. The
 * same rules the parser applied, applied again to the AppDef as it stands.
 */
export function checkedGrants(app: Pick<AppDef, 'name' | 'resources' | 'auth' | 'flags' | 'audiences' | 'experiments'>): {
  /** Every resource with an access, in declaration order. */
  read: string[];
  /** The resources whose access is 'write'. */
  write: string[];
  /** The column ceilings, by resource. */
  fields?: Record<string, AppFieldAccess>;
  roles: Record<string, AppRoleGrant>;
  /** What a signed-out visitor reads, re-checked like the roles. */
  public?: AppPublicGrant;
} {
  const read: string[] = [];
  const write: string[] = [];
  const fields: Array<[string, AppFieldAccess]> = [];
  for (const [name, resource] of Object.entries(app.resources ?? {})) {
    const here = `${app.name}: resources "${name}"`;
    if (!isRecord(resource)) throw new Error(`${here} is not a resource block.`);
    if (resource.access !== undefined && resource.access !== 'write') throw new Error(`${here} has an "access" that is not "write".`);
    read.push(name);
    if (resource.access === 'write') write.push(name);
    if (resource.fields !== undefined) {
      const rule = parseFieldAccess({ [name]: resource.fields }, `${here}, "fields"`)[name];
      if (resource.access !== 'write' && rule.write?.length) throw new Error(`${here} has "fields.write" and no access 'write'.`);
      fields.push([name, rule]);
    }
  }
  const at = `${app.name}: "auth"`;
  if (!(ROW_SCOPES as readonly unknown[]).includes(app.auth?.rows))
    throw new Error(`${at} has a "rows" that is not "all", "policy" or "tenant".`);
  const roles = app.auth?.roles;
  if (!isRecord(roles) || !Object.keys(roles).length) throw new Error(`${at} has "roles" that are not a non-empty object of role grants.`);
  const ceiling = new Set(read);
  const writeCeiling = new Set(write);
  const checked = Object.fromEntries(
    Object.entries(roles).map(([name, rawGrant]) => {
      const here = `${at}, role "${name}"`;
      assertRoleName(name, here);
      if (!isRecord(rawGrant)) throw new Error(`${here} is not an object.`);
      allowKeys(
        rawGrant,
        [
          'label',
          'extends',
          'read',
          'write',
          'create',
          'export',
          'commands',
          'actions',
          'operations',
          'fields',
          'realm',
          'supportLog',
          'supportAudit',
          'claims',
          'service',
          'flags',
          'experiments',
        ],
        here,
      );
      const scope = (key: 'read' | 'write'): boolean | string[] =>
        rawGrant[key] === undefined
          ? false
          : typeof rawGrant[key] === 'boolean'
            ? (rawGrant[key] as boolean)
            : accessResources(rawGrant[key], `${here}, "${key}"`);
      const roleRead = scope('read');
      const roleWrite = scope('write');
      const readable = roleRead === true ? read : roleRead === false ? [] : roleRead;
      const writable = roleWrite === true ? write : roleWrite === false ? [] : roleWrite;
      assertAccessSubset(readable, ceiling, `${here}, "read"`);
      assertAccessSubset(writable, writeCeiling, `${here}, "write"`);
      assertAccessSubset(writable, new Set(readable), `${here}, "write" requires read`);
      if (rawGrant.actions !== undefined && app.auth?.rows === 'tenant')
        throw new Error(`${here}, "actions" is not supported with "rows": "tenant".`);
      let create: false | string[] | undefined;
      if (rawGrant.create !== undefined) {
        if (rawGrant.create !== false && !Array.isArray(rawGrant.create))
          throw new Error(`${here}, "create" is false or a list of resources it writes.`);
        create = rawGrant.create === false ? false : accessResources(rawGrant.create, `${here}, "create"`);
        if (create !== false) assertAccessSubset(create, new Set(writable), `${here}, "create" requires write`);
      }
      let exports: string[] | undefined;
      if (rawGrant.export !== undefined) {
        exports = accessResources(rawGrant.export, `${here}, "export"`);
        assertAccessSubset(exports, new Set(readable), `${here}, "export" requires read`);
      }
      /* Its parent's grants are already its own (inheritedGrants): the name is kept only to say where they came from. */
      if (rawGrant.extends !== undefined && (typeof rawGrant.extends !== 'string' || !Object.hasOwn(roles, rawGrant.extends)))
        throw new Error(`${here}, "extends" is not a role the App declares.`);
      const grant: AppRoleGrant = {
        ...roleLabelOf(rawGrant, here),
        ...(rawGrant.extends === undefined ? {} : { extends: rawGrant.extends as string }),
        read: roleRead,
        write: roleWrite,
        ...(create === undefined ? {} : { create }),
        ...(exports === undefined ? {} : { export: exports }),
        ...controlCapabilities(rawGrant),
        ...(rawGrant.realm === undefined ? {} : { realm: parseRealm(rawGrant.realm, here) }),
        ...(rawGrant.commands === undefined ? {} : { commands: commandGrants(rawGrant.commands, `${here}, "commands"`) }),
        ...(rawGrant.actions === undefined
          ? {}
          : { actions: checkedActionGrants(app, rawGrant.actions, here, readable, writable, writeCeiling) }),
        ...(rawGrant.operations === undefined ? {} : { operations: operationsGrants(rawGrant.operations, `${here}, "operations"`) }),
        ...(rawGrant.fields === undefined ? {} : { fields: parseFieldAccess(rawGrant.fields, `${here}, "fields"`, true) }),
        // The resolve-time re-read must carry these too, or a grant the App
        // declared would be dropped from the runtime's own copy.
        ...(rawGrant.supportLog === true ? { supportLog: true as const } : {}),
        ...(rawGrant.supportAudit === true ? { supportAudit: true as const } : {}),
        // The parsed rule, read again in the words it was authored in.
        ...(rawGrant.claims === undefined
          ? {}
          : {
              claims: claimRule(
                { ...(rawGrant.claims as AppClaimRule).match, provider: (rawGrant.claims as AppClaimRule).provider },
                `${here}, "claims"`,
              ),
            }),
        ...(serviceRole(rawGrant, here) ? { service: true as const } : {}),
      };
      return [name, grant];
    }),
  );
  claimMappingProblems(checked, app.auth!.providers, app.auth!.rows, at);
  if (
    app.flags !== undefined ||
    app.audiences !== undefined ||
    app.experiments !== undefined ||
    Object.values(checked).some((role) => role.flags !== undefined || role.experiments !== undefined)
  ) {
    const catalog = normalizeFlagCatalog({ flags: app.flags ?? {}, audiences: app.audiences ?? {}, roles: Object.keys(checked) });
    const experiments = normalizeExperimentDeclarations(app.experiments ?? {}, catalog);
    checkFlagCapabilityReferences(checked, catalog, experiments);
  }
  const open = app.auth?.public === undefined ? undefined : parsePublicGrant(app.auth.public, `${at}, "public"`, ceiling);
  return {
    read,
    write,
    roles: checked,
    ...(fields.length ? { fields: Object.fromEntries(fields) } : {}),
    ...(open ? { public: open } : {}),
  };
}

/**
 * Each role with every grant of the role it `extends` folded into its own, as
 * written, before any of it is judged: `manager: { extends: 'mechanic',
 * commands: ['approveQuote'] }` reads, writes and runs all a mechanic does, and
 * approves quotes too. A chain is followed to its end; a loop, or a role that
 * is not declared, is refused. Only grants are inherited — what, and which
 * commands, actions, operations, flags and columns — never who holds the role
 * (`label`, `claims`, `service`), and a role extends only one of its own realm.
 * The rest of the parser then judges the whole grant as if it were written out,
 * so authority.lock and every screen that explains a role say what it holds.
 */
function inheritedGrants(
  raw: Record<string, unknown>,
  at: string,
  ceiling: { read: readonly string[]; write: readonly string[] },
): Record<string, unknown> {
  const done = new Map<string, unknown>();
  const resolve = (name: string, trail: readonly string[]): unknown => {
    if (done.has(name)) return done.get(name);
    const grant = raw[name];
    if (!isRecord(grant) || grant.extends === undefined) {
      done.set(name, grant);
      return grant;
    }
    const here = `${at}, role "${name}", "extends"`;
    const parent = grant.extends;
    if (typeof parent !== 'string' || !Object.hasOwn(raw, parent))
      throw new Error(
        `${here} names ${typeof parent === 'string' ? `"${parent}"` : 'no role'}, which is not a role the App declares [role-extends]: ` +
          `name one of ${Object.keys(raw)
            .filter((role) => role !== name)
            .join(', ')}.`,
      );
    if (parent === name || trail.includes(parent))
      throw new Error(
        `${here} loops [role-extends]: ${[...trail, name, parent].slice(trail.indexOf(parent) < 0 ? trail.length : trail.indexOf(parent)).join(' → ')}. ` +
          'A role extends one that does not, in the end, extend it back.',
      );
    const base = resolve(parent, [...trail, name]);
    if (!isRecord(base)) return grant;
    if ((base.realm ?? 'tenant') !== (grant.realm ?? 'tenant'))
      throw new Error(`${here} names "${parent}", a role of another realm [role-extends]: a role extends one of its own realm.`);
    if ((base.service === true) !== (grant.service === true))
      throw new Error(
        `${here} names "${parent}", ${base.service === true ? 'a service role, and this one is a person' : "a person's role, and this one is a service role"} [role-extends]: ` +
          'a role extends one held by the same kind of principal.',
      );
    const merged = foldGrant(base, grant, ceiling);
    done.set(name, merged);
    return merged;
  };
  return Object.fromEntries(Object.keys(raw).map((name) => [name, resolve(name, [])]));
}

/* A parent's grant and its child's, as one: every list the union of both, `true` where either says it. */
function foldGrant(
  base: Record<string, unknown>,
  own: Record<string, unknown>,
  ceiling: { read: readonly string[]; write: readonly string[] },
): Record<string, unknown> {
  const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const union = (a: unknown, b: unknown) => [...new Set([...list(a), ...list(b)])];
  const scope = (key: 'read' | 'write') =>
    base[key] === true || own[key] === true
      ? true
      : base[key] === undefined && own[key] === undefined
        ? undefined
        : union(base[key], own[key]);
  const reach = (grant: Record<string, unknown>, key: 'read' | 'write'): string[] =>
    grant[key] === true ? [...ceiling[key]] : (list(grant[key]).filter((item) => typeof item === 'string') as string[]);
  const merged: Record<string, unknown> = { ...own };
  delete merged.create;
  delete merged.fields;
  for (const key of ['read', 'write'] as const) {
    const value = scope(key);
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  for (const key of ['commands', 'export', 'operations', 'flags', 'experiments'] as const) {
    if (base[key] === undefined && own[key] === undefined) continue;
    merged[key] = key === 'flags' || key === 'experiments' ? [...list(base[key]), ...list(own[key])] : union(base[key], own[key]);
  }
  if (isRecord(base.actions) || isRecord(own.actions)) {
    const actions: Record<string, unknown> = {};
    for (const side of [base.actions, own.actions])
      for (const [resource, ids] of Object.entries(isRecord(side) ? side : {})) actions[resource] = union(actions[resource], ids);
    merged.actions = actions;
  }
  /* What it creates: each side's own word, or all it writes where it says none; the whole of what the two write is
     no word at all. */
  if (base.create !== undefined || own.create !== undefined) {
    const creates = (grant: Record<string, unknown>) =>
      grant.create === undefined ? reach(grant, 'write') : grant.create === false ? [] : list(grant.create);
    const made = union(creates(base), creates(own));
    const writes = new Set([...reach(base, 'write'), ...reach(own, 'write')]);
    if (!writes.size || [...writes].every((resource) => made.includes(resource))) {
      /* all it writes: the default */
    } else merged.create = made.length ? made : false;
  }
  /* A column narrowing holds where every side that reads the resource narrows it; one that reads it whole reads it
     whole here too. */
  if (isRecord(base.fields) || isRecord(own.fields)) {
    const fields: Record<string, { read?: unknown[]; write: unknown[] }> = {};
    const sides = [base, own];
    const resources = new Set(sides.flatMap((side) => Object.keys(isRecord(side.fields) ? side.fields : {})));
    const ruleOf = (side: Record<string, unknown>, resource: string) =>
      isRecord(side.fields) && isRecord(side.fields[resource]) ? side.fields[resource] : undefined;
    for (const resource of resources) {
      const narrowed = sides.filter((side) => reach(side, 'read').includes(resource)).map((side) => ruleOf(side, resource));
      if (!narrowed.length) continue;
      /* The columns written are the writers' alone: a side that reads the resource whole and never writes it (a
         leasing role a manager extends, reading every repair) widens what is read, never what is written. */
      const writers = sides
        .filter((side) => reach(side, 'write').includes(resource) && (ruleOf(side, resource) || reach(side, 'read').includes(resource)))
        .map((side) => ruleOf(side, resource));
      if (writers.some((rule) => rule === undefined)) continue;
      const write = union(...(writers.map((rule) => rule?.write) as [unknown, unknown]));
      const rules = narrowed.filter((rule) => rule !== undefined);
      if (!writers.length && rules.length < narrowed.length) continue;
      if (rules.length < narrowed.length || rules.some((rule) => rule.read === undefined)) fields[resource] = { write };
      else fields[resource] = { read: union(...(rules.map((rule) => rule.read) as [unknown, unknown])), write };
    }
    if (Object.keys(fields).length) merged.fields = fields;
  }
  return merged;
}

/** A role's person-facing name: what the account, grant and invitation screens say for its id. Words only; no authority. */
function roleLabelOf(grant: Record<string, unknown>, here: string): { label?: string } {
  const label = grant.label;
  if (label === undefined) return {};
  if (typeof label !== 'string' || !label.trim() || label.length > 60 || label !== label.trim() || /\p{Cc}/u.test(label)) {
    throw new Error(
      `${here}, "label" is the role's name as people read it: 1 to 60 characters of text, without surrounding spaces, such as "Loan officer".`,
    );
  }
  return { label };
}

function controlCapabilities(grant: Record<string, unknown>): Pick<AppRoleGrant, 'flags' | 'experiments'> {
  const read = (key: 'flags' | 'experiments'): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(grant, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) throw new Error('Flag capabilities require own data fields.');
    return descriptor.value;
  };
  return {
    ...(Object.hasOwn(grant, 'flags') ? { flags: normalizeFlagCapabilities(read('flags'), 'flags') } : {}),
    ...(Object.hasOwn(grant, 'experiments') ? { experiments: normalizeFlagCapabilities(read('experiments'), 'experiments') } : {}),
  };
}
