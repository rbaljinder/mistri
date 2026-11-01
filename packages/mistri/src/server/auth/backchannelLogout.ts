/**
 * OpenID Connect Back-Channel Logout 1.0: an identity provider whose config
 * entry says `"backchannelLogout": true` ends the mistri sessions its own
 * session opened, by POSTing a signed logout token, server to server, to
 * `<App>/api/auth/backchannel-logout/<name>`.
 *
 *   - Routed before Better Auth (auth.ts), as the work-email question is: the
 *     provider sends no cookie and no Origin, and nothing of the browser
 *     session machinery applies.
 *   - The token is verified as an ID token is, against the provider's
 *     published keys and asymmetric algorithms only (identityProviders.ts
 *     verifyLogoutToken), and each one is spent once: its `jti` is reserved
 *     in the auth store, so a replay is refused by every instance sharing it.
 *   - The sessions it names are found in the index each federated sign-in
 *     writes (identityStore.ts `idpSession`): by the provider's session id
 *     (`sid`) when the token has one, else by the subject, and only ever this
 *     provider's. Each is ended through Better Auth, so its hooks run.
 *   - API and OAuth tokens are the account's, not the session's, and are not
 *     revoked: deprovisioning an account is the directory's job.
 *
 * Answers 200 with nothing to cache, 400 with `{ error }`, or 404 for a
 * provider that does not take back-channel logout here.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { IDP_SESSION_MODEL } from './identityStore.js';

/** A logout token is a few hundred bytes; a body this size is not one. */
const MAX_BODY = 16 * 1024;
/** How long a spent `jti` is remembered: as long as its token could still be accepted (identityProviders.ts). */
const REMEMBER_S = 600 + 60;

interface Where {
  field: string;
  value: string;
}
/** The slice of Better Auth's context this reads and writes. */
export interface LogoutContext {
  adapter: {
    findMany(query: { model: string; where: Where[] }): Promise<Array<Record<string, unknown>>>;
    findOne(query: { model: string; where: Where[] }): Promise<Record<string, unknown> | null>;
    delete(query: { model: string; where: Where[] }): Promise<unknown>;
  };
  internalAdapter: {
    reserveVerificationValue(data: { identifier: string; value: string; expiresAt: Date }): Promise<unknown>;
    deleteVerificationByIdentifier(identifier: string): Promise<unknown>;
    deleteSession(token: string): Promise<unknown>;
  };
}

export function backchannelLogout(options: {
  /** The providers that take it, by name: each verifies its own tokens. */
  providers: ReadonlyMap<string, { verifyLogoutToken(token: string): Promise<Record<string, unknown>> }>;
  context: () => Promise<LogoutContext>;
  where: string;
}) {
  return async (req: IncomingMessage, res: ServerResponse, name: string): Promise<void> => {
    const send = (status: number, body?: unknown) => {
      res.statusCode = status;
      res.setHeader('cache-control', 'no-store');
      if (body === undefined) return void res.end();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body));
    };
    const provider = options.providers.get(name);
    if (!provider) return send(404, { error: 'not_found' });
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      return send(405, { error: 'invalid_request' });
    }
    if (!/^application\/x-www-form-urlencoded\s*(;|$)/i.test(String(req.headers['content-type'] ?? '')))
      return send(400, { error: 'invalid_request' });
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > MAX_BODY) return send(400, { error: 'invalid_request' });
      chunks.push(chunk as Buffer);
    }
    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
    const tokens = form.getAll('logout_token');
    if (tokens.length !== 1 || !tokens[0]) return send(400, { error: 'invalid_request' });
    let claims: Record<string, unknown>;
    try {
      claims = await provider.verifyLogoutToken(tokens[0]);
    } catch (error) {
      console.error(
        `mistri: ${options.where}: identity provider "${name}" sent a logout token that was refused: ${(error as Error).message}.`,
      );
      return send(400, { error: 'invalid_request' });
    }
    const issuer = String(claims.iss);
    const sid = typeof claims.sid === 'string' ? claims.sid : undefined;
    const sub = typeof claims.sub === 'string' ? claims.sub : undefined;
    const context = await options.context();
    const iat = typeof claims.iat === 'number' ? claims.iat : Math.floor(Date.now() / 1000);
    const reservation = `oidc-logout:${name}:${String(claims.jti)}`;
    const reserved = await context.internalAdapter.reserveVerificationValue({
      identifier: reservation,
      value: JSON.stringify({ provider: name, at: Date.now() }),
      expiresAt: new Date((iat + REMEMBER_S) * 1000),
    });
    if (!reserved) {
      console.error(`mistri: ${options.where}: identity provider "${name}" sent a logout token twice; the second was refused.`);
      return send(400, { error: 'invalid_request' });
    }
    const where: Where[] = [
      { field: 'provider', value: name },
      { field: 'issuer', value: issuer },
      ...(sid !== undefined ? [{ field: 'sid', value: sid }] : []),
      ...(sub !== undefined ? [{ field: 'subject', value: sub }] : []),
    ];
    try {
      const rows = await context.adapter.findMany({ model: IDP_SESSION_MODEL, where });
      for (const row of rows) {
        const sessionId = String(row.sessionId);
        const session = await context.adapter.findOne({ model: 'session', where: [{ field: 'id', value: sessionId }] });
        if (session && typeof session.token === 'string') await context.internalAdapter.deleteSession(session.token);
        await context.adapter.delete({ model: IDP_SESSION_MODEL, where: [{ field: 'id', value: String(row.id) }] });
      }
    } catch (error) {
      /* The token's jti was reserved before the sessions were touched, to refuse a replay. A store error part-way
         must not turn the provider's retry into "sent a logout token twice" while sessions are still open: release
         it, so the retry ends the rest. (Deleting a session twice is harmless.) */
      await context.internalAdapter.deleteVerificationByIdentifier(reservation).catch(() => undefined);
      throw error;
    }
    send(200);
  };
}
