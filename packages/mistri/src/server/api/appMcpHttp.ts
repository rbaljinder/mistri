/**
 * The App MCP over HTTP: `POST /api/apps/<app>/v<n>/$mcp`, the stateless
 * JSON form of MCP's Streamable HTTP transport, beside the App API it speaks.
 *
 * Each POST is one JSON-RPC message, answered by one JSON body (a
 * notification by `202` and nothing). The bearer token is read from the
 * request's Authorization header on every POST, never from a session: the
 * session (appMcpSession.ts) is made for that one message and discarded, and
 * its owner observes the token natively for each discovery and each call, as
 * the stdio session's does. So revoking a token, or changing the membership it
 * binds, refuses the next POST, and nothing a client keeps — an
 * `Mcp-Session-Id`, a protocol version — is ever authentication.
 *
 * It is admitted as the API is, by the same admission (apiHttpAdmission.ts):
 * loopback unless the App declares `api.network`, the same Host/Origin trust,
 * and the same budgets — the token's own, and its address's for refusals. A
 * token the owner refuses is answered `401` with `WWW-Authenticate: Bearer`,
 * the handshake included, as MCP's authorization expects — naming where an
 * OAuth token is had when the deployment's authorization server issues for
 * this App (auth/oauthResource.ts), whose tokens the same check reads. Like
 * the read and command transports, it holds at most `API_PENDING_LIMIT`
 * requests at once, counted before the body, the session or the owner is
 * awaited: the budgets above are per credential, so it is this bound that
 * limits the work many forged credentials can queue. There is no event stream:
 * a GET is 405, which the transport allows, and every answer is in the reply.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { Bound } from '@mistriwork/engine/server/http/trust.js';
import { admitApiRequest, API_PENDING_LIMIT, ApiAdmission, apiTransportBound } from './apiHttpAdmission.js';
import { readApiBearerHeader } from './apiBearerHeader.js';
import { createAppMcpSession } from './appMcpSession.js';

/** A message past this is not one an agent sends to a tool. */
const MCP_BODY_LIMIT = 1024 * 1024;

type SessionOptions = Omit<Parameters<typeof createAppMcpSession>[0], 'input' | 'output' | 'credential'>;

const answer = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}) => {
  if (res.headersSent || res.destroyed) return;
  const text = body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...(text ? { 'content-type': 'application/json; charset=utf-8' } : {}),
    'content-length': String(Buffer.byteLength(text)),
    ...headers,
  });
  res.end(text);
};
const rpcError = (code: number, message: string) => ({ jsonrpc: '2.0', id: null, error: { code, message } });

async function readBody(req: IncomingMessage): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > MCP_BODY_LIMIT) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    size += chunk.length;
    if (size > MCP_BODY_LIMIT) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export function createAppMcpHttp(
  options: Readonly<{
    appId: string;
    version: number;
    bound: Bound;
    admission: ApiAdmission;
    /** The App, for its `api.network` declaration. */
    app: { api?: { network?: true } };
    /** The `WWW-Authenticate` a 401 carries: where an OAuth token is had, when one is (auth/oauthResource.ts). Plain `Bearer` otherwise. */
    challenge?: (presented: boolean) => string;
    /** Everything the session needs but the credential: made once (lazily, on
     * the first admitted POST, when it is a function), used for every POST. */
    session: SessionOptions | (() => Promise<SessionOptions>);
  }>,
) {
  if (!(options.admission instanceof ApiAdmission) || !apiTransportBound(options.bound, options.admission, options.app))
    throw new Error('API transport configuration is unavailable.');
  let made: Promise<SessionOptions> | undefined;
  const sessionOptions = () => {
    const session = options.session;
    if (typeof session !== 'function') return Promise.resolve(session);
    // One composition; a failed one stays failed rather than retrying per POST.
    made ??= session();
    return made;
  };
  // Charged to the address; one over its budget is told to wait rather than to sign in.
  const unauthenticated = (res: ServerResponse, client: string, presented: boolean) => {
    const charged = options.admission.charge(client);
    if (!charged.ok) answer(res, 429, rpcError(-32600, 'rate_limited'), { 'retry-after': String(charged.retryAfterSeconds) });
    else
      answer(res, 401, rpcError(-32001, 'A valid bearer API token is required.'), {
        'www-authenticate': options.challenge?.(presented) ?? 'Bearer',
      });
  };
  const path = `/api/apps/${options.appId}/v${options.version}/$mcp`;
  let pending = 0;
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const admitted = admitApiRequest(req, options.bound, options.admission);
    if (!admitted.ok) {
      answer(res, admitted.status, rpcError(-32600, admitted.code));
      return true;
    }
    if (req.method !== 'POST') {
      answer(res, 405, undefined, { allow: 'POST' });
      return true;
    }
    let credential: string;
    try {
      credential = readApiBearerHeader(req.rawHeaders).credential;
    } catch {
      unauthenticated(res, admitted.client, req.headers.authorization !== undefined);
      return true;
    }
    const spent = options.admission.spend(credential);
    if (!spent.ok) {
      answer(res, 429, rpcError(-32600, 'rate_limited'), { 'retry-after': String(spent.retryAfterSeconds) });
      return true;
    }
    if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) {
      answer(res, 415, rpcError(-32600, 'The body is one JSON-RPC message, application/json.'));
      return true;
    }
    const body = await readBody(req);
    if (!body) {
      answer(res, 413, rpcError(-32600, 'The message is too large.'));
      return true;
    }
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    } catch {
      answer(res, 400, rpcError(-32700, 'The body is not JSON.'));
      return true;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      answer(res, 400, rpcError(-32600, 'The body is one JSON-RPC message, not a batch.'));
      return true;
    }
    let composed: SessionOptions;
    try {
      composed = await sessionOptions();
    } catch {
      answer(res, 503, rpcError(-32603, 'The App MCP is unavailable.'));
      return true;
    }
    const lines: string[] = [];
    let refused = false;
    const session = createAppMcpSession({
      ...composed,
      credential,
      input: Readable.from([`${JSON.stringify(message)}\n`]),
      output: { write: (chunk: string) => lines.push(chunk) },
      unauthenticated: () => {
        refused = true;
      },
      verifyHandshake: true,
    });
    await session.done;
    // The owner refused the token itself: no result, a 401 the client can act on.
    if (refused) {
      unauthenticated(res, admitted.client, true);
      return true;
    }
    const reply = lines.join('').trim();
    // A notification, or a client's response, has nothing to answer.
    if (!reply) answer(res, 202);
    else answer(res, 200, reply);
    return true;
  };
  return Object.freeze({
    path,
    /** True when the request was this transport's to answer. */
    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
      if ((req.url ?? '').split('?')[0] !== path) return false;
      if (pending >= API_PENDING_LIMIT) {
        answer(res, 503, rpcError(-32603, 'temporarily_unavailable'), { 'retry-after': '1' });
        return true;
      }
      // Released however the request ends: an answer, an error, or a client that went away mid-body.
      pending += 1;
      try {
        return await serve(req, res);
      } finally {
        pending -= 1;
      }
    },
  });
}
