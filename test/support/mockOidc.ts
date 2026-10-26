/**
 * An OpenID Connect provider in the test's own process: discovery, a key set,
 * an authorization endpoint that signs in whoever the test says is next, and
 * a token endpoint that checks the client, the code and its PKCE verifier and
 * answers with an RS256 ID token carrying the claims the test chose.
 *
 * Written here rather than taken from a package: it is a hundred lines of
 * node:http and node:crypto, it needs to issue deliberately wrong tokens (a
 * foreign issuer, another audience, a key the provider never published, an
 * expired one, a nonce from another sign-in), which a real provider will not,
 * and Docker — where a Keycloak would run — is not something every machine
 * that runs this suite has.
 */
import { createHash, createHmac, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';

export interface NextSignIn {
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  /** Any further claims: groups, roles, amr, acr, auth_time… */
  claims?: Record<string, unknown>;
  /** What to get wrong in the ID token this sign-in is answered with. */
  tamper?: { issuer?: string; audience?: string; foreignKey?: true; expired?: true; nonce?: string; alg?: 'none' | 'HS256' };
}

export interface MockOidc {
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Who the next authorization signs in. */
  next(signIn: NextSignIn): void;
  /** The query of every authorization request, in order. */
  readonly authorizations: URLSearchParams[];
  /** The ID tokens the token endpoint issued, in order. */
  readonly issued: string[];
  /**
   * A back-channel logout token: the provider's issuer, the client as its
   * audience, a fresh `jti` and the logout event, then `claims` over them (an
   * `undefined` drops one), signed as `tamper` says.
   */
  logoutToken(claims: Record<string, unknown>, tamper?: { foreignKey?: true; alg?: 'HS256'; typ?: string }): string;
  close(): Promise<void>;
}

export const LOGOUT_EVENT_URI = 'http://schemas.openid.net/event/backchannel-logout';

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
function jwt(header: Record<string, unknown>, payload: Record<string, unknown>, key: KeyObject | null): string {
  const body = `${b64(JSON.stringify(header))}.${b64(JSON.stringify(payload))}`;
  if (!key) return `${body}.`;
  return `${body}.${b64(sign('sha256', Buffer.from(body), key))}`;
}

const read = async (req: IncomingMessage) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

export async function startMockOidc(options: { clientId?: string; clientSecret?: string; path?: string } = {}): Promise<MockOidc> {
  const clientId = options.clientId ?? 'tablewalk-test';
  const clientSecret = options.clientSecret ?? 'mock-client-secret-0123456789';
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const foreign = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
  const codes = new Map<string, { redirect: string; challenge: string; nonce: string; signIn: NextSignIn }>();
  const authorizations: URLSearchParams[] = [];
  const issued: string[] = [];
  let upcoming: NextSignIn | undefined;
  let base = '';
  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', base);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = url.pathname.slice((options.path ?? '').length);
    if (path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: `${base}${options.path ?? ''}`,
        authorization_endpoint: `${base}${options.path ?? ''}/authorize`,
        token_endpoint: `${base}${options.path ?? ''}/token`,
        jwks_uri: `${base}${options.path ?? ''}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        code_challenge_methods_supported: ['S256'],
      });
    }
    if (path === '/jwks') return json(200, { keys: [jwk] });
    if (path === '/authorize') {
      authorizations.push(url.searchParams);
      const signIn = upcoming;
      upcoming = undefined;
      const q = url.searchParams;
      if (!signIn || q.get('client_id') !== clientId || q.get('response_type') !== 'code' || q.get('code_challenge_method') !== 'S256') {
        res.writeHead(400);
        return res.end('no sign-in is waiting, or the request is not one this provider takes');
      }
      const code = randomBytes(16).toString('hex');
      codes.set(code, { redirect: q.get('redirect_uri')!, challenge: q.get('code_challenge')!, nonce: q.get('nonce') ?? '', signIn });
      const back = new URL(q.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (path === '/token' && req.method === 'POST') {
      const form = new URLSearchParams(await read(req));
      const basic = req.headers.authorization?.startsWith('Basic ')
        ? Buffer.from(req.headers.authorization.slice(6), 'base64').toString('utf8').split(':').map(decodeURIComponent)
        : undefined;
      const [id, secret] = basic ?? [form.get('client_id'), form.get('client_secret')];
      if (id !== clientId || secret !== clientSecret) return json(401, { error: 'invalid_client' });
      const code = codes.get(form.get('code') ?? '');
      codes.delete(form.get('code') ?? '');
      const verifier = form.get('code_verifier') ?? '';
      if (
        !code ||
        form.get('grant_type') !== 'authorization_code' ||
        form.get('redirect_uri') !== code.redirect ||
        createHash('sha256').update(verifier).digest('base64url') !== code.challenge
      )
        return json(400, { error: 'invalid_grant' });
      const now = Math.floor(Date.now() / 1000);
      const { signIn } = code;
      const tamper = signIn.tamper ?? {};
      const payload = {
        iss: tamper.issuer ?? `${base}${options.path ?? ''}`,
        aud: tamper.audience ?? clientId,
        sub: signIn.sub,
        iat: tamper.expired ? now - 7200 : now,
        exp: tamper.expired ? now - 3600 : now + 300,
        nonce: tamper.nonce ?? code.nonce,
        auth_time: now,
        ...(signIn.email ? { email: signIn.email } : {}),
        ...(signIn.email_verified !== undefined ? { email_verified: signIn.email_verified } : {}),
        ...(signIn.name ? { name: signIn.name } : {}),
        ...signIn.claims,
      };
      const token =
        tamper.alg === 'none'
          ? jwt({ alg: 'none', typ: 'JWT' }, payload, null)
          : jwt({ alg: 'RS256', typ: 'JWT', kid: 'k1' }, payload, tamper.foreignKey ? foreign : privateKey);
      issued.push(token);
      return json(200, {
        access_token: randomBytes(16).toString('hex'),
        token_type: 'Bearer',
        expires_in: 300,
        id_token: token,
        refresh_token: randomBytes(16).toString('hex'),
      });
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    issuer: `${base}${options.path ?? ''}`,
    clientId,
    clientSecret,
    authorizations,
    issued,
    next: (signIn) => {
      upcoming = signIn;
    },
    logoutToken: (claims, tamper = {}) => {
      const payload = Object.fromEntries(
        Object.entries({
          iss: `${base}${options.path ?? ''}`,
          aud: clientId,
          iat: Math.floor(Date.now() / 1000),
          jti: randomBytes(12).toString('hex'),
          events: { [LOGOUT_EVENT_URI]: {} },
          ...claims,
        }).filter(([, value]) => value !== undefined),
      );
      const typ = tamper.typ ?? 'logout+jwt';
      if (tamper.alg === 'HS256') {
        const body = `${b64(JSON.stringify({ alg: 'HS256', typ }))}.${b64(JSON.stringify(payload))}`;
        return `${body}.${b64(createHmac('sha256', clientSecret).update(body).digest())}`;
      }
      return jwt({ alg: 'RS256', typ, kid: 'k1' }, payload, tamper.foreignKey ? foreign : privateKey);
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
