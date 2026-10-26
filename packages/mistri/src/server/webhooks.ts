/**
 * A webhook connection in the config file: where a command's effects are
 * POSTed once it has committed.
 *
 *   { "name": "dealer-hooks", "kind": "webhook", "url": "https://hooks.example/tablewalk",
 *     "auth": { "bearer": "${DEALER_HOOK_TOKEN}" } }
 *
 * The name is what `post('dealer-hooks', …)` names. The URL is https, or
 * plain http only to this machine (a local receiver, a test); a credential
 * never rides in it. Every request goes through egress: the address a name
 * resolves to is checked and is the one connected to, a redirect is refused,
 * cloud metadata and link-local addresses are never reached, and the answer's
 * body is never read — its status is the whole answer. Credentials are
 * `${VAR}` references expanded only when the connection opens, never logged,
 * and written back on save exactly as they were read.
 */
import { DEFAULT_POLICY, request, type EgressPolicy } from '@mistriwork/engine/adapters/http/egress.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { WEBHOOK_NAME, type EffectPayload, type EffectRequest, type Webhook } from './commands/commandEffects.js';

export interface WebhookServiceConfig {
  kind: 'webhook';
  name: string;
  /** https, or http to this machine only. `${VAR}` references intact. */
  url: string;
  auth?: { bearer: string } | { header: string; value: string };
}

const WEBHOOK_KEYS = ['name', 'kind', 'url', 'auth'] as const;
/* RFC 9110's token, minus the headers the request itself owns. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const OWNED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'accept',
  'connection',
  'transfer-encoding',
  'cookie',
  'idempotency-key',
]);
/* A webhook answers quickly or is asked again: well inside an effect delivery's lease. */
const TIMEOUT_MS = 10_000;

const loopback = (host: string) => host === 'localhost' || host === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

/** The URL a webhook POSTs to: https, or http to this machine; no credential, no fragment. */
function webhookUrl(text: string, where: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${where} has a "url" that is not a URL.`);
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback(url.hostname))) {
    throw new Error(`${where} has a ${url.protocol}// "url". A webhook is https; plain http reaches only this machine (localhost).`);
  }
  if (url.username || url.password || url.search)
    throw new Error(`${where} has a credential or a query in its "url"; a credential belongs in "auth".`);
  if (url.hash) throw new Error(`${where} has a fragment in its "url".`);
  return url;
}

/** An entry of kind "webhook", checked. Throws naming the field. */
export function webhookConnectionOf(entry: Record<string, unknown>, where: string): WebhookServiceConfig {
  const stray = Object.keys(entry).find((key) => !(WEBHOOK_KEYS as readonly string[]).includes(key));
  if (stray) throw new Error(`${where} is a webhook connection, which takes no "${stray}". It takes: ${WEBHOOK_KEYS.join(', ')}.`);
  const name = String(entry.name);
  if (!WEBHOOK_NAME.test(name)) {
    throw new Error(
      `${where} is a webhook, whose name is what a command's post() names: letters, digits, underscores and hyphens, starting with a letter.`,
    );
  }
  const url = String(entry.url);
  if (!url.includes('${')) webhookUrl(url, where);
  return { kind: 'webhook', name, url, ...(entry.auth !== undefined ? { auth: webhookAuth(entry.auth, where) } : {}) };
}

function webhookAuth(value: unknown, where: string): NonNullable<WebhookServiceConfig['auth']> {
  const auth = value as Record<string, unknown>;
  const keys = auth && typeof auth === 'object' && !Array.isArray(auth) ? Object.keys(auth).sort().join(',') : '';
  if (keys === 'bearer' && typeof auth.bearer === 'string' && auth.bearer) return { bearer: auth.bearer };
  if (keys === 'header,value' && typeof auth.header === 'string' && typeof auth.value === 'string' && auth.value) {
    if (!HEADER_NAME.test(auth.header) || OWNED_HEADERS.has(auth.header.toLowerCase())) {
      throw new Error(`${where} has "auth.header": ${JSON.stringify(auth.header)}, which is not a header a credential can travel in.`);
    }
    return { header: auth.header, value: auth.value };
  }
  throw new Error(
    `${where} has an "auth" mistri cannot read. Write { "bearer": "\${TOKEN}" } or { "header": "x-signature", "value": "\${SECRET}" }.`,
  );
}

/** Whether a call's path, as spelled, stays inside its connection's address: one leading "/", no climbing out, no
 * fragment. A workflow's `w.call` is checked by it before it is tried, since no retry can change the answer. */
export const callPathStaysInside = (path: string): boolean =>
  path.startsWith('/') && !path.startsWith('//') && !path.includes('\\') && !/(^|[/?])\.\.?([/?#]|$)/.test(path) && !path.includes('#');

/** Open a webhook: its URL and credential expanded now, and a POST that answers its status alone. */
export function openWebhook(service: WebhookServiceConfig, resolver?: EgressPolicy['resolver']): Webhook {
  const where = `connection "${service.name}"`;
  const url = webhookUrl(expandEnvReferences(service.url), where);
  const credential: Record<string, string> = {};
  if (service.auth) {
    if ('bearer' in service.auth) credential.authorization = `Bearer ${expandEnvReferences(service.auth.bearer)}`;
    else credential[service.auth.header.toLowerCase()] = expandEnvReferences(service.auth.value);
  }
  const credentialHeader = service.auth && 'header' in service.auth ? service.auth.header.toLowerCase() : undefined;
  /* The credential is spread last: a call's headers are checked against it before they get here (callHeaders),
     and if one ever is not, it still cannot replace the connection's own. */
  const policy: EgressPolicy = {
    ...DEFAULT_POLICY,
    insecure: url.protocol === 'http:',
    allowLinkLocal: false,
    timeoutMs: TIMEOUT_MS,
    ...(resolver ? { resolver } : {}),
  };
  return Object.freeze({
    ...(credentialHeader ? { credentialHeader } : {}),
    async post(body: EffectRequest | EffectPayload, idempotencyKey: string, perCall?: Readonly<Record<string, string>>): Promise<number> {
      // A call's own headers follow the platform's, so a provider's Idempotency-Key replaces it; only the credential is later.
      const reply = await request(
        url,
        { method: 'POST', headers: { 'idempotency-key': idempotencyKey, ...perCall, ...credential }, body, discard: true, kind: 'webhook' },
        policy,
      );
      return reply.status;
    },
    async call(asked: Parameters<NonNullable<Webhook['call']>>[0], idempotencyKey: string): Promise<{ status: number; json: unknown }> {
      // The path extends the connection's address and never leaves it: no other host, no climbing out of the base path.
      if (!callPathStaysInside(asked.path)) {
        throw new Error('A call path starts with a single "/" and stays inside the connection\'s address.');
      }
      const base = url.pathname.replace(/\/$/, '');
      const target = new URL(`${url.origin}${base}${asked.path}`);
      if (target.origin !== url.origin) throw new Error("A call stays on the connection's host.");
      /* URL parsing resolves an encoded dot segment (`%2e%2e`) as `..`, which the
         spelling check above cannot see: the parsed path must still be under the base. */
      if (base && target.pathname !== base && !target.pathname.startsWith(`${base}/`)) {
        throw new Error('A call path starts with a single "/" and stays inside the connection\'s address.');
      }
      const reply = await request(
        target,
        {
          method: asked.method,
          headers: { 'idempotency-key': idempotencyKey, ...asked.headers, ...credential },
          ...(asked.body === undefined ? {} : { body: asked.body }),
          kind: 'webhook',
        },
        policy,
      );
      return { status: reply.status, json: reply.json };
    },
  });
}
