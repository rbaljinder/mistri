/**
 * A stand-in for Cloudflare's Turnstile in tests: a local server with a siteverify that says yes to the tokens it
 * was told are people's, and a widget script that registers `window.turnstile` and hands the form a person's token
 * at once. Point the verifier at it — `turnstile({ siteKey, secret, verifyUrl: stub.verifyUrl, scriptUrl:
 * stub.scriptUrl })` — and neither a node test nor a browser test calls Cloudflare.
 *
 * As Cloudflare's, a token is good once: siteverify answers a token it has already seen `timeout-or-duplicate`. The
 * widget hands out a fresh one on each render and each `reset(id)` (the person's token, a random part and the page's
 * host name, which siteverify answers as the token's `hostname`), so a form that retries must ask for a new one.
 */
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface TurnstileStubOptions {
  /** The secret siteverify accepts; any other is answered `invalid-input-secret`. Default `stub-secret`. */
  secret?: string;
  /** The tokens that are people's. Default: `person`. */
  people?: readonly string[];
  /** The person the stub widget's tokens are issued to: each token it hands out is this, a random part and the page's
      host name. Default: the first of `people`. */
  widgetToken?: string;
  /** The host name siteverify says one of `people` was issued on. Default `localhost`. A widget's token says its own. */
  hostname?: string;
  /** The action siteverify says a token was issued for. */
  action?: string;
}

export interface TurnstileStub {
  verifyUrl: string;
  scriptUrl: string;
  /** What siteverify was asked, in order: the token, the address and whether the secret was right. */
  asked: Array<{ response: unknown; remoteip: unknown; secretOk: boolean }>;
  close(): Promise<void>;
}

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').startsWith('application/json')) return JSON.parse(text || '{}') as Record<string, unknown>;
  return Object.fromEntries(new URLSearchParams(text));
}

export async function turnstileStub(options: TurnstileStubOptions = {}): Promise<TurnstileStub> {
  const secret = options.secret ?? 'stub-secret';
  const people = new Set(options.people ?? ['person']);
  const widgetToken = options.widgetToken ?? [...people][0] ?? 'person';
  const asked: TurnstileStub['asked'] = [];
  const spent = new Set<string>();
  const script = `(() => {
  let next = 0;
  const widgets = new Map();
  const issue = (options) => {
    const token = ${JSON.stringify(widgetToken)} + '~' + Math.random().toString(36).slice(2) + '~' + location.hostname;
    setTimeout(() => options.callback && options.callback(token), 0);
  };
  window.turnstile = {
    render(element, options) {
      const id = 'stub-' + next++;
      const box = document.createElement('div');
      box.setAttribute('data-turnstile-stub', options.sitekey);
      if (options.action) box.setAttribute('data-action', options.action);
      box.textContent = 'Verified';
      element.append(box);
      widgets.set(id, options);
      issue(options);
      return id;
    },
    reset(id) {
      const options = widgets.get(id);
      if (options) issue(options);
    },
    remove(id) {
      widgets.delete(id);
    },
  };
})();`;
  /* One of `people`, or one a widget issued to the person: its host name, or undefined for any other token. */
  const issuedOn = (token: unknown): string | undefined => {
    if (typeof token !== 'string') return undefined;
    if (people.has(token)) return options.hostname ?? 'localhost';
    const [who, nonce, host] = token.split('~');
    return who === widgetToken && nonce && host ? host : undefined;
  };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://stub').pathname;
    if (req.method === 'GET' && path === '/turnstile/v0/api.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store', 'access-control-allow-origin': '*' });
      res.end(script);
      return;
    }
    if (req.method === 'POST' && path === '/turnstile/v0/siteverify') {
      let body: Record<string, unknown> = {};
      try {
        body = await bodyOf(req);
      } catch {
        /* an unreadable body is a missing token */
      }
      const secretOk = body.secret === secret;
      asked.push({ response: body.response, remoteip: body.remoteip, secretOk });
      const host = issuedOn(body.response);
      const duplicate = typeof body.response === 'string' && spent.has(body.response);
      const success = secretOk && host !== undefined && !duplicate;
      if (secretOk && typeof body.response === 'string') spent.add(body.response);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          success,
          'error-codes': success
            ? []
            : [!secretOk ? 'invalid-input-secret' : duplicate ? 'timeout-or-duplicate' : 'invalid-input-response'],
          ...(success
            ? {
                hostname: host,
                challenge_ts: new Date().toISOString(),
                ...(options.action ? { action: options.action } : {}),
              }
            : {}),
        }),
      );
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  // A stand-in never keeps a process alive by itself: a test that forgot close(), or a module that only loads it.
  server.unref();
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}`;
  return {
    verifyUrl: `${base}/turnstile/v0/siteverify`,
    scriptUrl: `${base}/turnstile/v0/api.js`,
    asked,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
