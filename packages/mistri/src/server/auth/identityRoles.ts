/**
 * What a sign-in through an identity provider may do to mistri's own
 * accounts, judged in Better Auth's database hooks, where the account it
 * would make, link or open a session for is known:
 *
 *   - **sign-up** (`auth.signUp`): `invite` makes nothing, `open` anything,
 *     and just in time only through the listed providers, or for a verified
 *     email in the listed domains, or both;
 *   - **linking** to an account that already has the address: Better Auth
 *     links only a verified email (identityProviders.ts says what verified
 *     is). An account whose own address was never verified — made by
 *     sign-up or by an administrator — keeps nothing from before the proof:
 *     its password, its other links and its sessions end, so whoever
 *     registered someone else's address first holds nothing of theirs;
 *   - **a tenant's own provider** asserts only addresses in its domains,
 *     verified, and opens a session only for an account in them;
 *   - **roles from claims** (`from` on a role): the roles a mapping gives are
 *     recomputed at every sign-in, the others are left as an administrator
 *     set them, each change is written to the account trail in the change's
 *     transaction, and a sign-in that leaves the account no role the App
 *     declares is refused with a sentence;
 *   - **step-up**: when the provider authenticated the person, and whether
 *     it counts (identityProviders.ts stepUpInstant), kept by session.
 *
 * Every refusal is an APIError with a code: Better Auth sends the browser
 * back to the sign-in screen with it, and the screen says the sentence.
 */
import { signInState } from './signInState.js';
import {
  AUTH_PROVIDERS,
  NAMED_PROVIDER,
  TENANT_OIDC,
  TENANT_SAML,
  type AppClaimRule,
  type AppProvider,
  type AppSignUp,
} from '../../shared/appModel.js';
import { rolesOf } from '../../shared/accountAdministration.js';
import type { AccountAuditStore } from './accountAudit.js';
import type { FederatedProviderConfig } from './identityConfig.js';
import { IDP_SESSION_MODEL } from './identityStore.js';
import { claimValues, domainOf, stepUpInstant, type SignInEvidence } from './identityProviders.js';

/** The codes a refused sign-in comes back to the sign-in screen with (SignIn.tsx says each). */
const SIGN_IN_REFUSALS = {
  noRole: 'no_role',
  signUpClosed: 'sign_up_closed',
  outsideDomain: 'outside_domain',
} as const;

type ApiErrorClass = new (status: string, body: { code: string; message: string }) => Error;
interface HookContext {
  path?: unknown;
  params?: Record<string, unknown>;
  body?: Record<string, unknown>;
  context: {
    internalAdapter: {
      findUserById(id: string): Promise<Record<string, unknown> | null>;
      findAccounts(userId: string): Promise<Array<{ id: string }>>;
      deleteAccount(id: string): Promise<unknown>;
      deleteUserSessions(userId: string): Promise<unknown>;
      deleteSession(token: string): Promise<unknown>;
      updateUser(id: string, data: Record<string, unknown>): Promise<unknown>;
    };
    adapter: { create(query: { model: string; data: Record<string, unknown> }): Promise<unknown> };
  };
}

/** How a sign-in step-up is judged for sessions an identity provider opened (auth.ts, nativeSignInAge.ts). */
interface StepUps {
  /** The provider that opened this session, and its authentication instant (null where it does not count); undefined: not an IdP session this deployment saw. */
  evidence(sessionId: string): Promise<{ provider: string; at: number | null } | undefined>;
}

/** A sign-in through an identity provider, as the hooks saw it: told to trusted server code before its session is made. */
export type FederatedSignIn = (
  signIn: Readonly<{
    userId: string;
    email: string;
    provider: string;
    /** How `auth.providers` names it (`oidc:<name>`, `saml:<name>`): what a claim rule's `provider` is matched against. */
    token: string;
    providerLabel: string;
    claims: Readonly<Record<string, unknown>>;
  }>,
) => void | Promise<void>;

/** Role mappings, by role, from the App's `auth.roles.<role>.claims`. */
export function roleClaimsOf(roles: Readonly<Record<string, { claims?: AppClaimRule }>> | undefined): Record<string, AppClaimRule> {
  return Object.fromEntries(
    Object.entries(roles ?? {})
      .filter(([, grant]) => grant.claims !== undefined)
      .map(([role, grant]) => [role, grant.claims!]),
  );
}

/** The roles a sign-in's claims give, through `provider` (`oidc:<name>` or `saml:<name>`, as `auth.providers`
    says it): a rule that names another provider is not read, so a claim of the same name from another identity
    provider never gives the role (0.8.5 I1). */
export function mappedRoles(
  mapping: Readonly<Record<string, AppClaimRule>>,
  claims: Readonly<Record<string, unknown>>,
  provider: string,
): string[] {
  return Object.entries(mapping)
    .filter(
      ([, rule]) =>
        (rule.provider === undefined || rule.provider === provider) &&
        Object.entries(rule.match).some(([claim, values]) => claimValues(claims, claim).some((value) => values.includes(value))),
    )
    .map(([role]) => role);
}

/**
 * The role string a session may use. A role an App maps from claims is the
 * provider's to give and take away: it counts only for a session an identity
 * provider that maps roles opened, so a password session of the same account
 * cannot keep one the provider has since taken away (the suite's rule, in
 * suiteGrantStore.ts readForSession). A role set by hand counts for any session.
 * `opener` is the provider that opened the session, or undefined for any other sign-in.
 */
export function sessionRoles(
  role: string | null | undefined,
  mapping: Readonly<Record<string, AppClaimRule>>,
  opener: string | undefined,
  mapsRoles: (provider: string) => boolean,
): string | undefined {
  if (!role) return undefined;
  if (!Object.keys(mapping).length || (opener !== undefined && mapsRoles(opener))) return role;
  const kept = rolesOf(role).filter((held) => !Object.hasOwn(mapping, held));
  return kept.length ? kept.join(',') : undefined;
}

/** Whether a sign-in through `token` may make an account for `email`. */
export function maySignUp(signUp: AppSignUp, token: AppProvider, email: string | undefined, verified: boolean): boolean {
  if (signUp === 'open') return true;
  if (signUp === 'invite') return false;
  if (signUp.providers && !signUp.providers.includes(token)) return false;
  if (signUp.domains && !(verified && signUp.domains.includes(domainOf(email)))) return false;
  return true;
}

/** Whether Better Auth should refuse a first sign-in through `token` before any hook: sign-up cannot make one. */
export const signUpShut = (signUp: AppSignUp, token: AppProvider) =>
  signUp === 'invite' || (typeof signUp === 'object' && signUp.providers !== undefined && !signUp.providers.includes(token));

export function identityHooks(options: {
  signUp: AppSignUp;
  /** Declared role names: a sign-in that leaves none of these (or admin) is refused. */
  roles: ReadonlySet<string>;
  mapping: Readonly<Record<string, AppClaimRule>>;
  providers: ReadonlyMap<string, FederatedProviderConfig>;
  evidence: WeakMap<object, SignInEvidence>;
  audit: () => AccountAuditStore;
  APIError: ApiErrorClass;
  appName: string;
  /** Told of each sign-in through a provider (not a tenant's own) before its session is made; a throw refuses it. */
  federated?: FederatedSignIn;
}) {
  const { signUp, roles, mapping, providers, evidence, APIError } = options;
  const refuse = (code: string, message: string): never => {
    throw new APIError('FORBIDDEN', { code, message });
  };
  /* Which provider this request signs in through: the callback's, the
     social sign-in's (Google's ID token sign-in), or a SAML provider's
     assertion consumer service or sign-in. Anything else — email sign-up, an
     administrator's create — is not a federated sign-in. A provider is
     reached only through its own kind's routes. */
  const through = (ctx: HookContext | null | undefined): AppProvider | undefined => {
    if (!ctx) return undefined;
    const path = typeof ctx.path === 'string' ? ctx.path : '';
    const saml = path.startsWith('/sso/saml2/sp/acs/') || path === '/sign-in/sso';
    const id = path.startsWith('/callback/')
      ? ctx.params?.id
      : path === '/sign-in/social'
        ? ctx.body?.provider
        : path.startsWith('/sso/saml2/sp/acs/')
          ? ctx.params?.providerId
          : path === '/sign-in/sso'
            ? ctx.body?.providerId
            : undefined;
    if (typeof id !== 'string') return undefined;
    if (!saml && (AUTH_PROVIDERS as readonly string[]).includes(id)) return id as AppProvider;
    const config = providers.get(id);
    if (!config || (config.kind === 'saml') !== saml) return undefined;
    if (config.tenant !== undefined) return config.kind === 'saml' ? TENANT_SAML : TENANT_OIDC;
    return `${config.kind}:${config.name}`;
  };
  const tenantFence = (found: SignInEvidence, email: unknown) => {
    const domains = found.provider.domains;
    if (!domains) return;
    const address = typeof email === 'string' ? email : undefined;
    if (!found.emailVerified || !domains.includes(domainOf(found.email)) || !domains.includes(domainOf(address))) {
      refuse(SIGN_IN_REFUSALS.outsideDomain, "This sign-in is for another organization's addresses.");
    }
  };
  const noRole = () => refuse(SIGN_IN_REFUSALS.noRole, `Your identity provider gives you no role in ${options.appName}.`);
  /* Kept in the deployment's sign-in state (signInState.ts) for the session's
     life: with a cache configured, a session the provider opened through one
     instance is judged for a step-up on another as the provider said. */
  interface Evidence {
    provider: string;
    at: number | null;
  }

  const hooks = {
    user: {
      create: {
        before: async (user: Record<string, unknown>, ctx: HookContext | null) => {
          const token = through(ctx);
          if (!token) return;
          const found = ctx ? evidence.get(ctx) : undefined;
          const email = typeof user.email === 'string' ? user.email : undefined;
          const verified = found ? found.emailVerified : user.emailVerified === true;
          if (found) tenantFence(found, email);
          if (!maySignUp(signUp, token, email, verified)) {
            refuse(
              SIGN_IN_REFUSALS.signUpClosed,
              `${options.appName} makes accounts for people it invites${typeof signUp === 'object' ? ' or whose organization it lets in' : ''}.`,
            );
          }
          if (!found) return;
          found.created = true;
          /* A SAML provider never tells Better Auth an address is verified;
             the evidence says what is, by the config (samlSignIn.ts). */
          const proven = found.emailVerified && found.email !== undefined && found.email === email?.toLowerCase();
          // An account made under a mapping holds the roles the claims give, and none by default.
          if (Object.keys(mapping).length && found.provider.tenant === undefined) {
            const given = mappedRoles(mapping, found.claims, found.token);
            if (!given.length) noRole();
            return { data: { role: given.join(','), ...(proven ? { emailVerified: true } : {}) } };
          }
          if (proven) return { data: { emailVerified: true } };
        },
      },
    },
    account: {
      create: {
        before: async (account: Record<string, unknown>, ctx: HookContext | null) => {
          if (!ctx || !through(ctx)) return;
          const found = evidence.get(ctx);
          if (found?.created) return;
          const userId = typeof account.userId === 'string' ? account.userId : undefined;
          if (!userId) return;
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) return;
          if (found) tenantFence(found, user.email);
          /* Better Auth links only a verified address to an existing account.
         Where the account's own address was never proven, what it holds was
         never proven to be its owner's: it goes before the link is made. */
          if (user.emailVerified !== true && user.emailVerified !== 1) {
            const held = await ctx.context.internalAdapter.findAccounts(userId);
            for (const method of held) await ctx.context.internalAdapter.deleteAccount(method.id);
            await ctx.context.internalAdapter.deleteUserSessions(userId);
            if (held.length)
              console.log(
                'mistri: a verified sign-in claimed an account whose address was never verified; its earlier sign-in methods and sessions were ended.',
              );
            /* The provider proved the address: now it is. Better Auth says so
               itself for an OpenID Connect link; a SAML link is chosen for it. */
            if (found?.emailVerified && found.email !== undefined && found.email === String(user.email ?? '').toLowerCase())
              await ctx.context.internalAdapter.updateUser(userId, { emailVerified: true });
          }
        },
      },
    },
    session: {
      create: {
        before: async (session: Record<string, unknown>, ctx: HookContext | null) => {
          const found = ctx ? evidence.get(ctx) : undefined;
          if (!ctx || !found) return;
          const userId = String(session.userId);
          const user = await ctx.context.internalAdapter.findUserById(userId);
          if (!user) return;
          tenantFence(found, user.email);
          if (options.federated && found.provider.tenant === undefined) {
            await options.federated(
              Object.freeze({
                userId,
                email: String(user.email ?? ''),
                provider: found.provider.name,
                token: found.token,
                providerLabel: found.provider.label ?? found.provider.name,
                claims: found.claims,
              }),
            );
          }
          if (!Object.keys(mapping).length || found.provider.tenant !== undefined) return;
          /* The roles a mapping gives are the provider's to give and take away,
           at every sign-in; the others stay as an administrator set them. */
          const current = rolesOf(user.role);
          const next = [
            ...new Set([...current.filter((role) => !Object.hasOwn(mapping, role)), ...mappedRoles(mapping, found.claims, found.token)]),
          ];
          if (!next.some((role) => roles.has(role) || role === 'admin')) noRole();
          const changed = next.length !== current.length || next.some((role) => !current.includes(role));
          if (!changed && !found.created) return;
          const audit = options.audit();
          const by = {
            actorId: `provider:${found.provider.name}`,
            actorEmail: found.provider.label ?? found.provider.name,
            principal: `sign-in:${found.provider.name}`,
            targetId: userId,
            targetEmail: String(user.email ?? ''),
          };
          await audit.transaction(async () => {
            if (changed) await ctx.context.internalAdapter.updateUser(userId, { role: next.join(',') });
            await audit.write(
              found.created
                ? { ...by, action: 'create', before: null, after: { email: by.targetEmail, roles: next } }
                : { ...by, action: 'setRoles', before: { roles: current }, after: { roles: next } },
            );
          });
        },
        after: async (session: Record<string, unknown>, ctx: HookContext | null) => {
          const found = ctx ? evidence.get(ctx) : undefined;
          if (!ctx || !found || typeof session.id !== 'string') return;
          /* Which of the provider's sessions this one came from, so its
             back-channel logout can end it (backchannelLogout.ts). A session
             that could not be indexed could not be ended by the provider: it
             ends now instead, and the sign-in fails. */
          try {
            await ctx.context.adapter.create({
              model: IDP_SESSION_MODEL,
              data: {
                sessionId: session.id,
                provider: found.provider.name,
                issuer: found.issuer,
                subject: found.subject,
                sid: found.sid ?? null,
                sessionIndex: found.sessionIndex ?? null,
                createdAt: new Date(),
              },
            });
          } catch (error) {
            await ctx.context.internalAdapter.deleteSession(String(session.token ?? '')).catch(() => undefined);
            console.error(`mistri: a sign-in through "${found.provider.name}" was ended: its provider session could not be recorded.`);
            throw error;
          }
          const until = session.expiresAt instanceof Date ? session.expiresAt.getTime() : Date.now() + 7 * 24 * 3600_000;
          await signInState.put(
            'idp',
            session.id,
            { provider: found.provider.name, at: stepUpInstant(found.claims, found.provider) } satisfies Evidence,
            until,
          );
        },
      },
    },
  };
  const stepUp: StepUps = {
    evidence: async (id) => {
      const kept = await signInState.read<Evidence>('idp', id);
      return kept && typeof kept.provider === 'string' && (kept.at === null || Number.isSafeInteger(kept.at))
        ? { provider: kept.provider, at: kept.at }
        : undefined;
    },
  };
  return { hooks, stepUp };
}

/** The provider names an App's `auth.providers` asks for: `oidc:<name>` and `saml:<name>` each. */
export const namedProviders = (providers: readonly AppProvider[]) =>
  providers.flatMap((provider) => NAMED_PROVIDER.exec(provider)?.[1] ?? []);
