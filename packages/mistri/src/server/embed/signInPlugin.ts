/**
 * The Better Auth side of an embed sign-in: two endpoints that only trusted
 * server code can call (`auth.api.*`), never registered on the HTTP router.
 * exchange.ts verifies the host's assertion first; by the time these run,
 * who the person is has been settled, and what is left is the account and
 * the session, made exactly as any other sign-in makes them — Better Auth's
 * own adapter, its hooks (the admin plugin's default role and its refusal of
 * a banned account among them) and its session cookie.
 *
 * A person is the issuer's subject: an account row of provider
 * `embed:<issuer name>` and the host's `sub`. The first sign-in links it to
 * an account by email only where the issuer says `link-verified-email`, the
 * host says the address is verified and mistri verified it too; otherwise
 * an address that already has an account is refused, never taken over.
 */

interface EmbedSignInBody {
  /** The issuer's name in the config file: its accounts are provider `embed:<name>`. */
  issuer: string;
  /** Its `iss`, kept as the account's issuer under `embed:`, apart from the identity providers' and Better Auth's own. */
  iss: string;
  subject: string;
  email?: string;
  emailVerified: boolean;
  /** The person's name; the caller words one from the email when the host gives none. */
  name?: string;
  /** Link an existing account by a verified email. */
  link: boolean;
  /** Make an account at the first sign-in. */
  create: boolean;
  /** Make a session that lasts this many milliseconds, not the default lifetime: a cross-origin bearer's. */
  lifetimeMs?: number;
}

export type EmbedSignInAnswer =
  | { accountId: string; sessionId: string; expiresAt: number }
  | { refused: { status: number; code: string; message: string } };

/** The slice of `auth.api` the embed exchange calls. */
export interface EmbedApi {
  mistriEmbedSignIn(a: {
    body: EmbedSignInBody;
    headers: Headers;
    returnHeaders: true;
  }): Promise<{ headers: Headers; response: EmbedSignInAnswer }>;
  mistriEmbedEnd(a: { body: { token: string } }): Promise<unknown>;
  signOut(a: { headers: Headers; returnHeaders: true }): Promise<{ headers: Headers }>;
}

interface Ctx {
  body: unknown;
  json(value: unknown): unknown;
  context: {
    adapter: { findOne(a: { model: string; where: Array<{ field: string; value: unknown }> }): Promise<Record<string, unknown> | null> };
    internalAdapter: {
      findUserById(id: string): Promise<Record<string, unknown> | null>;
      findUserByEmail(email: string): Promise<{ user: Record<string, unknown> } | null>;
      createUser(user: Record<string, unknown>): Promise<Record<string, unknown>>;
      linkAccount(account: Record<string, unknown>): Promise<unknown>;
      createSession(
        userId: string,
        dontRememberMe?: boolean,
        override?: Record<string, unknown>,
        overrideAll?: boolean,
      ): Promise<Record<string, unknown>>;
      deleteSession(token: string): Promise<unknown>;
    };
  };
}
type Endpoint = (options: Record<string, unknown>, handler: (ctx: Ctx) => Promise<unknown>) => unknown;

const verified = (user: Record<string, unknown>) => user.emailVerified === true || user.emailVerified === 1;

export async function embedSignInPlugin(load: (name: string) => Promise<Record<string, unknown>>) {
  const { createAuthEndpoint } = (await load('better-auth/api')) as unknown as { createAuthEndpoint: { serverOnly: Endpoint } };
  const { setSessionCookie } = (await load('better-auth/cookies')) as unknown as {
    setSessionCookie(ctx: Ctx, session: { session: Record<string, unknown>; user: Record<string, unknown> }): Promise<void>;
  };
  const refused = (ctx: Ctx, status: number, code: string, message: string) => ctx.json({ refused: { status, code, message } });
  return {
    id: 'mistri-embed',
    endpoints: {
      mistriEmbedSignIn: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        const body = ctx.body as EmbedSignInBody;
        const { adapter, internalAdapter } = ctx.context;
        const providerId = `embed:${body.issuer}`;
        const linked = await adapter.findOne({
          model: 'account',
          where: [
            { field: 'providerId', value: providerId },
            { field: 'accountId', value: body.subject },
          ],
        });
        let user = typeof linked?.userId === 'string' ? await internalAdapter.findUserById(linked.userId) : null;
        if (!user) {
          const existing = body.email ? await internalAdapter.findUserByEmail(body.email) : null;
          if (existing) {
            if (!body.link) {
              return refused(
                ctx,
                409,
                'account_exists',
                'An account here already has that address, and this host signs people in as accounts of their own. The operator may link them ("accounts": "link-verified-email").',
              );
            }
            if (!body.emailVerified || !verified(existing.user)) {
              return refused(ctx, 409, 'account_unverified', 'That address is not verified on both sides, so it links to no account here.');
            }
            await internalAdapter.linkAccount({
              userId: existing.user.id,
              providerId,
              accountId: body.subject,
              issuer: `embed:${body.iss}`,
            });
            user = existing.user;
          } else {
            if (!body.create) return refused(ctx, 403, 'no_account', 'You have no account here. Ask an administrator for one.');
            if (!body.email) return refused(ctx, 400, 'assertion_claims', 'The assertion needs "email" to make an account.');
            user = await internalAdapter.createUser({
              email: body.email,
              name: body.name ?? body.email,
              emailVerified: body.emailVerified,
            });
            await internalAdapter.linkAccount({ userId: user.id, providerId, accountId: body.subject, issuer: `embed:${body.iss}` });
          }
        }
        const session = body.lifetimeMs
          ? await internalAdapter.createSession(String(user.id), false, { expiresAt: new Date(Date.now() + body.lifetimeMs) }, true)
          : await internalAdapter.createSession(String(user.id));
        await setSessionCookie(ctx, { session, user });
        return ctx.json({
          accountId: String(user.id),
          sessionId: String(session.id),
          expiresAt: new Date(session.expiresAt as Date).getTime(),
        });
      }),
      mistriEmbedEnd: createAuthEndpoint.serverOnly({ method: 'POST' }, async (ctx) => {
        /* The bearer is the signed cookie value: the session's token, a dot and its signature. */
        const value = decodeURIComponent((ctx.body as { token: string }).token);
        const token = value.slice(0, value.lastIndexOf('.'));
        if (token) await ctx.context.internalAdapter.deleteSession(token);
        return ctx.json({ ended: true });
      }),
    },
  };
}
