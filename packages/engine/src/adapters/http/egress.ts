/**
 * The one place a request to an API leaves the process.
 *
 * Every HTTP connection's traffic goes through `request`, so the rules that
 * make it safe to point tablewalk at someone else's server live here once:
 *
 *   - the address a name resolves to is checked, and that exact address is
 *     the one connected to (the shared network policy, networkPolicy.ts);
 *   - a redirect is refused, not followed — following one is how a trusted
 *     name hands the request to an address nobody checked;
 *   - a response is JSON, arrives within a deadline, and is read under a byte
 *     cap — and a webhook's (`discard`) is not read at all: its status is the
 *     whole reply, and its body is drained unread;
 *   - a failure is an `HttpSourceError` carrying a reason, never the response
 *     body, a header or the credential.
 *
 * Private networks are reachable by default: internal APIs are the common
 * case, and an HTTP connection only ever comes from the operator's config,
 * never from a browser. Cloud metadata and link-local addresses are not,
 * unless the connection says so, because they hand out credentials to
 * whoever asks.
 */
import { errorCode, inSpan, injectTrace, tracing } from '../telemetry/trace.js';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { checkedLookup, refusedLiteral, type NetworkPolicy, type Resolver } from '../net/networkPolicy.js';

export type { Resolver } from '../net/networkPolicy.js';

export interface EgressPolicy extends NetworkPolicy {
  /** Plain `http:`; for an API on a trusted network or a test, never the default. */
  insecure: boolean;
  connectTimeoutMs: number;
  /** The whole request, from the first byte sent to the last one read. */
  timeoutMs: number;
  maxBytes: number;
  resolver?: Resolver;
}

export const DEFAULT_POLICY: EgressPolicy = Object.freeze({
  allowPrivate: true,
  allowLinkLocal: false,
  insecure: false,
  connectTimeoutMs: 5_000,
  timeoutMs: 15_000,
  maxBytes: 5 * 1024 * 1024,
});

/** Why a request failed, as a reason the App's error mapping can rely on; the message is for the operator. */
export class HttpSourceError extends Error {
  constructor(
    readonly reason: 'refused' | 'timeout' | 'redirect' | 'too_large' | 'not_json' | 'status' | 'shape' | 'network',
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'HttpSourceError';
  }
}

const refused = (host: string, addresses: string[]) =>
  new HttpSourceError('refused', `${host} resolves only to addresses this connection may not reach (${addresses.join(', ')}).`);

/* JSON with its big integers kept: a number past 2^53 comes back as the digits
   it arrived with, which every display path keeps whole, rather than as the
   nearest double. The reviver's third argument is the value's source text. */
function parseJson(text: string): unknown {
  const reviver = (_key: string, value: unknown, context?: { source?: string }) =>
    typeof value === 'number' && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source) ? context.source : value;
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

export interface EgressReply {
  status: number;
  json: unknown;
}

interface EgressRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers: Record<string, string>;
  /** Sent as JSON. A service's own client builds it; never anything a browser sent verbatim. */
  body?: unknown;
  /** Sent as it is, with its own media type, in place of a JSON body: a warehouse's NDJSON. */
  text?: { readonly type: string; readonly body: string };
  /** The answer's body is never read, whatever its status: the reply is the status alone. A webhook's POST. */
  discard?: true;
  /** What the call is, for its span: a webhook, an HTTP source, a search service. */
  kind?: 'webhook' | 'http' | 'search' | 'analytics';
}

/**
 * One GET. A 2xx answers its parsed JSON; any other status answers the status
 * alone — its body is never read into anything a caller could forward.
 */
export function send(url: URL, headers: Record<string, string>, policy: EgressPolicy): Promise<EgressReply> {
  return request(url, { method: 'GET', headers }, policy);
}

/**
 * One request of any method, under the same rules as a GET: a JSON body out,
 * a JSON body back from a 2xx and nothing read from anything else. For the
 * services a config names (search), which write as well as read.
 */
export function request(url: URL, asked: EgressRequest, policy: EgressPolicy): Promise<EgressReply> {
  if (!tracing()) return requestUntraced(url, asked, policy);
  /* An outbound call's span: its method, host and status travel, and the
     caller's trace goes with it as `traceparent`. The URL's path and query,
     the headers and the bodies stay local (adapters/telemetry/trace.ts). */
  return inSpan(
    asked.method,
    {
      kind: 'client',
      attributes: {
        'http.request.method': asked.method,
        'server.address': url.hostname,
        'server.port': url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80,
        'mistri.outbound.kind': asked.kind ?? 'http',
      },
    },
    async (span) => {
      span.detail(() => ({
        request: {
          method: asked.method,
          url: url.href,
          headers: asked.headers,
          ...(asked.text !== undefined ? { body: asked.text.body } : asked.body !== undefined ? { body: JSON.stringify(asked.body) } : {}),
        },
      }));
      const reply = await requestUntraced(url, { ...asked, headers: injectTrace(asked.headers) }, policy);
      span.setAttribute('http.response.status_code', reply.status);
      if (reply.status >= 400) span.fail(String(reply.status));
      span.detail(() => ({
        response: { status: reply.status, ...(reply.json !== undefined ? { body: JSON.stringify(reply.json).slice(0, 64 * 1024) } : {}) },
      }));
      return reply;
    },
    (error) => (error instanceof HttpSourceError ? error.reason : errorCode(error)),
  );
}

function requestUntraced(url: URL, asked: EgressRequest, policy: EgressPolicy): Promise<EgressReply> {
  const host = url.host;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && policy.insecure)) {
    return Promise.reject(
      new HttpSourceError(
        'refused',
        `${url.protocol}// is not allowed; use https, or set "insecure": true for an API on a trusted network.`,
      ),
    );
  }
  if (url.username || url.password) {
    return Promise.reject(new HttpSourceError('refused', 'A credential belongs in the connection\'s "auth", not in its URL.'));
  }
  // An address written into the URL is never looked up, so it is checked here, before any socket opens.
  const literal = refusedLiteral(url.hostname, policy);
  if (literal) return Promise.reject(refused(host, [literal]));
  const payload =
    asked.text !== undefined
      ? Buffer.from(asked.text.body, 'utf8')
      : asked.body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(asked.body), 'utf8');
  const headers = payload
    ? { ...asked.headers, 'content-type': asked.text?.type ?? 'application/json', 'content-length': String(payload.byteLength) }
    : asked.headers;

  return new Promise<EgressReply>((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, reply?: EgressReply) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) {
        outgoing.destroy();
        reject(error);
      } else resolve(reply!);
    };
    const deadline = setTimeout(
      () => finish(new HttpSourceError('timeout', `${host} did not answer within ${policy.timeoutMs / 1000} s.`)),
      policy.timeoutMs,
    );
    const open = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const outgoing = open(
      url,
      {
        method: asked.method,
        headers,
        lookup: checkedLookup(policy, refused) as never,
        timeout: policy.connectTimeoutMs,
      },
      (response: IncomingMessage) => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          return finish(
            new HttpSourceError(
              'redirect',
              `${host} redirected (${status}); redirects are not followed. Point the connection at the final address.`,
              status,
            ),
          );
        }
        if (asked.discard || status < 200 || status > 299) {
          response.resume();
          return finish(null, { status, json: undefined });
        }
        const type = String(response.headers['content-type'] ?? '');
        if (!/^application\/([\w.+-]*\+)?json\b/i.test(type)) {
          return finish(new HttpSourceError('not_json', `${host} answered ${type || 'without a content type'}, not JSON.`));
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > policy.maxBytes)
            return finish(new HttpSourceError('too_large', `${host} answered more than ${Math.round(policy.maxBytes / 1024 / 1024)} MB.`));
          chunks.push(chunk);
        });
        response.on('end', () => {
          try {
            finish(null, { status, json: parseJson(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            finish(new HttpSourceError('not_json', `${host} answered text that is not JSON.`));
          }
        });
        response.on('error', () => finish(new HttpSourceError('network', `${host} closed the connection mid-answer.`)));
      },
    );
    outgoing.on('timeout', () =>
      finish(new HttpSourceError('timeout', `${host} did not accept a connection within ${policy.connectTimeoutMs / 1000} s.`)),
    );
    outgoing.on('error', (error: NodeJS.ErrnoException) =>
      finish(
        error instanceof HttpSourceError ? error : new HttpSourceError('network', `${host}: ${error.code ?? 'the connection failed'}.`),
      ),
    );
    outgoing.end(payload);
  });
}
