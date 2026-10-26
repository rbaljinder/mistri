import { validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { profileName, type AccountProfile } from '../../shared/accountProfile.js';

/** The existing Better Auth APIs, not its internal adapter or user table. */
export interface AccountProfileApi {
  getSession(input: {
    headers: Headers;
    query: { disableCookieCache: true; disableRefresh: true };
  }): Promise<{ user?: Record<string, unknown> } | null>;
  listUserAccounts(input: { headers: Headers; query: { disableCookieCache: true; disableRefresh: true } }): Promise<unknown>;
  updateUser(input: {
    headers: Headers;
    body: { name: string };
    query: { disableCookieCache: true; disableRefresh: true };
  }): Promise<unknown>;
}

class ProfileRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
const refuse = (status: number, code: string, message: string): never => {
  throw new ProfileRefusal(status, code, message);
};
const busy = () => refuse(409, 'profile_busy', 'A profile save is still in progress. Check again shortly.');

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const finish = (error?: Error, value?: unknown) => {
      clearTimeout(timer);
      req.off('data', data);
      req.off('end', end);
      req.off('error', fail);
      req.off('aborted', aborted);
      if (error) {
        req.resume();
        reject(error);
      } else resolve(value);
    };
    const fail = () => finish(new ProfileRefusal(400, 'invalid_profile', 'The profile request could not be read.'));
    const aborted = () => fail();
    const data = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > 4096) return finish(new ProfileRefusal(413, 'invalid_profile', 'The profile request is too large.'));
      chunks.push(buffer);
    };
    const end = () => {
      try {
        finish(undefined, JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        fail();
      }
    };
    const timer = setTimeout(() => finish(new ProfileRefusal(408, 'invalid_profile', 'The profile request timed out.')), 5000);
    req.on('data', data);
    req.on('end', end);
    req.on('error', fail);
    req.on('aborted', aborted);
  });
}

/** Mounted only inside the built-in auth runtime. No generic user-table CRUD,
 * submitted identity, forwarded cookie updates, or provider-managed edits. */
export function createAccountProfileHandler(options: {
  appId: string;
  trustedOrigins: readonly string[];
  api: AccountProfileApi;
  headers: (headers: IncomingMessage['headers']) => Headers;
  /** The App sends mail, so the address can be changed by a link: the profile offers it. */
  emailChange?: boolean;
  /** An authorization server issues for the App: the profile lists the person's connected applications. */
  connectedClients?: boolean;
}) {
  const { appId } = options;
  const origins = new Set(options.trustedOrigins.map((origin) => new URL(origin).origin));
  const session = options.api.getSession.bind(options.api);
  const accounts = options.api.listUserAccounts.bind(options.api);
  const update = options.api.updateUser.bind(options.api);
  const headersFor = options.headers;
  const pending = new Set<string>();
  const query = { disableCookieCache: true, disableRefresh: true } as const;

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let dispatched = false,
      held: string | undefined;
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url ?? '', 'http://profile.invalid');
      if (
        url.pathname !== '/api/auth/profile' ||
        url.searchParams.getAll('app').length !== 1 ||
        url.searchParams.get('app') !== appId ||
        [...url.searchParams.keys()].some((key) => key !== 'app')
      ) {
        return refuse(400, 'invalid_profile', 'Invalid profile request.');
      }
      if (req.method !== 'GET' && req.method !== 'POST') return refuse(405, 'invalid_profile', 'This profile method is not supported.');
      const expected = req.headers['x-mistri-account'];
      if (typeof expected !== 'string' || !expected.length || expected.length > 1024) {
        return refuse(409, 'stale_account', 'Verify your account before continuing.');
      }
      const origin = req.headers.origin;
      if (
        req.headers['sec-fetch-site'] === 'cross-site' ||
        (origin !== undefined && !origins.has(origin)) ||
        (req.method === 'POST' && (typeof origin !== 'string' || !origins.has(origin)))
      ) {
        return refuse(403, 'invalid_profile', 'Profile requests must come from this application.');
      }
      let name: string | undefined;
      if (req.method === 'POST') {
        if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
          return refuse(415, 'invalid_profile', 'Profile requests must use JSON.');
        }
        const body = await readBody(req);
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          !Object.hasOwn(body, 'name') ||
          (name = profileName((body as Record<string, unknown>).name)) === undefined
        ) {
          return refuse(400, 'invalid_profile', 'Enter a name between 1 and 120 characters, without control characters.');
        }
      }
      // Capture the request cookie once. Subsequent calls must never adopt the
      // browser's newer session or a submitted user ID.
      const headers = headersFor(req.headers);
      const current = async () => {
        const got = await session({ headers: new Headers(headers), query });
        const user = got?.user;
        if (!user || typeof user.id !== 'string' || !user.id.length) return refuse(401, 'unauthenticated', 'Sign in to view your profile.');
        validateHeaderValue('x-mistri-account', user.id);
        res.setHeader('x-mistri-account', user.id);
        if (user.id !== expected) return refuse(409, 'stale_account', 'The signed-in account changed.');
        if (typeof user.name !== 'string' || typeof user.email !== 'string') throw new Error('Invalid profile provider data');
        return { accountId: user.id, appId, name: user.name, email: user.email };
      };
      let user = await current();
      if (pending.has(user.accountId)) return busy();
      if (req.method === 'POST') {
        held = user.accountId;
        pending.add(held);
        dispatched = true;
        const answer = await update({ headers: new Headers(headers), query, body: { name: name! } });
        if (!answer || typeof answer !== 'object' || !('status' in answer) || answer.status !== true)
          throw new Error('Unconfirmed profile update');
        user = await current();
      }
      const linked = await accounts({ headers: new Headers(headers), query });
      if (
        !Array.isArray(linked) ||
        linked.length > 100 ||
        linked.some(
          (account) =>
            !account || typeof account !== 'object' || typeof account.providerId !== 'string' || account.userId !== user.accountId,
        )
      ) {
        throw new Error('Invalid linked account data');
      }
      const providers = [...new Set<string>(linked.map((account) => (account.providerId === 'credential' ? 'email' : account.providerId)))];
      // Re-read before release, including after account enumeration. A GET must
      // not offer a stale value as recovery while an accepted save is pending.
      user = await current();
      if (!held && pending.has(user.accountId)) return busy();
      const profile: AccountProfile = {
        ...user,
        providers,
        ...(options.emailChange && providers.includes('email') ? { emailChange: true as const } : {}),
        ...(options.connectedClients ? { connectedClients: true as const } : {}),
      };
      send(200, { profile, ...(dispatched ? { outcome: 'applied' } : {}) });
    } catch (error) {
      if (dispatched) send(503, { code: 'profile_unknown', error: 'The profile save could not be confirmed.', outcome: 'unknown' });
      else if (error instanceof ProfileRefusal) send(error.status, { code: error.code, error: error.message, outcome: 'not_applied' });
      else send(503, { code: 'profile_unavailable', error: 'The profile is temporarily unavailable.', outcome: 'not_applied' });
    } finally {
      if (held) pending.delete(held);
    }
  };
}
