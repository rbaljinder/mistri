/**
 * Stopping the mail a record's address gets (`notify.via` email,
 * integrations/integrationChannels.ts): the link at the foot of each
 * message and its List-Unsubscribe header (RFC 8058).
 *
 * The token is `<payload>.<signature>`, both base64url: the payload names
 * the App, the tenant ('' for an App without tenants), the channel and the
 * holder — the digest consent is kept by, never the address — and the
 * signature is an HMAC-SHA256 of it under the email service's
 * `links.secret`. It does not expire: an old message's link still stops the
 * mail, and it opens nothing but this choice.
 *
 *   GET  /api/mail/unsubscribe?token=…   a page that asks; it changes nothing, so a mail scanner that
 *                                        follows every link unsubscribes nobody
 *   POST /api/mail/unsubscribe?token=…   records the opt-out (a mail client's one-click POST carries
 *                                        `List-Unsubscribe=One-Click`); `action=resubscribe` records the
 *                                        opt-in again, by the same token
 *
 * A token that is not the secret's, or names an App this server does not
 * send for, is a 404 and nothing else. Each client has a budget of requests
 * (60 a minute), so the route is no oracle worth asking at speed. The page
 * runs no script and loads nothing; its referrer policy is no-referrer.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IntegrationStore } from '../../adapters/integrations/integrationStore.js';
import { clientAddress, FixedWindowLimiter } from '@mistriwork/engine/server/http/rateLimit.js';
import { STYLE } from './mailLinkPage.js';

export const UNSUBSCRIBE_PATH = '/api/mail/unsubscribe';

/** What a token names: whose consent, on which channel. */
export interface UnsubscribeClaim {
  readonly app: string;
  readonly tenant: string;
  readonly channel: string;
  readonly holder: string;
}

const sign = (secret: string, payload: string) => createHmac('sha256', secret).update(`mistri.unsubscribe.v1\n${payload}`).digest();

export function issueUnsubscribeToken(secret: string, claim: UnsubscribeClaim): string {
  if (!secret) throw new Error('An unsubscribe link needs a secret.');
  const payload = Buffer.from(JSON.stringify({ v: 1, a: claim.app, t: claim.tenant, c: claim.channel, h: claim.holder }), 'utf8').toString(
    'base64url',
  );
  return `${payload}.${sign(secret, payload).toString('base64url')}`;
}

/** The claim a token makes when its signature is the secret's; undefined for anything else. */
export function readUnsubscribeToken(secret: string, token: unknown): UnsubscribeClaim | undefined {
  if (!secret || typeof token !== 'string' || token.length > 1024) return undefined;
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(payload) || !/^[A-Za-z0-9_-]+$/.test(signature))
    return undefined;
  const given = Buffer.from(signature, 'base64url'),
    expected = sign(secret, payload);
  // One spelling per signature: base64url's last character carries bits a decoder drops.
  if (given.toString('base64url') !== signature) return undefined;
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (body?.v !== 1 || ![body.a, body.t, body.c, body.h].every((part) => typeof part === 'string')) return undefined;
  return { app: body.a as string, tenant: body.t as string, channel: body.c as string, holder: body.h as string };
}

/** The App a token may name on this server: its store, and the name its page says. */
interface UnsubscribeApp {
  readonly name: string;
  readonly store: IntegrationStore;
}

interface UnsubscribeRoute {
  /** True when the request was this route's. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function page(
  res: ServerResponse,
  status: number,
  app: string,
  title: string,
  words: string,
  form?: { token: string; action?: string; button: string },
) {
  const nonce = randomBytes(16).toString('base64');
  const action = form ? `?token=${encodeURIComponent(form.token)}` : '';
  const body = form
    ? `<form method="post" action="${escape(action)}">${form.action ? `<input type="hidden" name="action" value="${escape(form.action)}">` : ''}<button type="submit">${escape(form.button)}</button></form>`
    : '';
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
  });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex, nofollow">
<title>${escape(title)}${app ? ` · ${escape(app)}` : ''}</title><style nonce="${nonce}">${STYLE}</style></head>
<body><main>${app ? `<p class="app">${escape(app)}</p>` : ''}<h1>${escape(title)}</h1><p class="prose">${escape(words)}</p>${body}</main></body></html>`);
}

const NOT_FOUND = 'This link does not stop any mail. It may have been copied wrong.';

/** Read a small form body: the one-click POST's `List-Unsubscribe=One-Click`, or the page's `action`. */
async function formBody(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 4096) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

/**
 * The route over the Apps this server sends for. `secret` is the email
 * service's `links.secret`; `apps` finds the App a token names.
 */
export function createUnsubscribeRoute(
  options: Readonly<{
    secret: string;
    apps: (app: string) => UnsubscribeApp | undefined;
    now?: () => number;
    /** Proxies whose forwarded client address is believed (`--trust-proxy`). */
    trusted?: Parameters<typeof clientAddress>[1];
  }>,
): UnsubscribeRoute {
  const now = options.now ?? Date.now;
  const limiter = new FixedWindowLimiter([{ limit: 60, ms: 60_000 }], now);
  return Object.freeze({
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname !== UNSUBSCRIBE_PATH) return false;
      if (req.method !== 'GET' && req.method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST' }).end();
        return true;
      }
      const decision = limiter.take(clientAddress(req, options.trusted));
      if (!decision.ok) {
        res
          .writeHead(429, { 'retry-after': String(decision.retryAfterSeconds), 'content-type': 'text/plain; charset=utf-8' })
          .end('Too many requests.');
        return true;
      }
      const token = url.searchParams.get('token') ?? '';
      const claim = readUnsubscribeToken(options.secret, token);
      const app = claim ? options.apps(claim.app) : undefined;
      if (!claim || !app) {
        if (req.method === 'POST') req.resume();
        page(res, 404, '', 'Link not found', NOT_FOUND);
        return true;
      }
      if (req.method === 'GET') {
        const state = (await app.store.consent(claim.app, claim.tenant, claim.channel, claim.holder))?.state;
        if (state === 'out')
          page(res, 200, app.name, 'You are unsubscribed', `${app.name} sends this address no more of these emails.`, {
            token,
            action: 'resubscribe',
            button: 'Subscribe again',
          });
        else
          page(res, 200, app.name, 'Stop these emails?', `${app.name} will send this address no more of these emails.`, {
            token,
            button: 'Unsubscribe',
          });
        return true;
      }
      const body = await formBody(req);
      if (!body) {
        res.writeHead(413, { 'content-type': 'text/plain; charset=utf-8' }).end('The request is too large.');
        return true;
      }
      const again = body.get('action') === 'resubscribe';
      await app.store.setConsent({
        app: claim.app,
        tenant: claim.tenant,
        channel: claim.channel,
        holder: claim.holder,
        state: again ? 'in' : 'out',
        source: again ? 'resubscribe' : 'unsubscribe',
        at: now(),
      });
      // A mail client's one-click POST reads the status alone (RFC 8058).
      if (body.get('List-Unsubscribe') === 'One-Click') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end('Unsubscribed.');
        return true;
      }
      if (again)
        page(res, 200, app.name, 'You are subscribed again', `${app.name} may email this address again.`, { token, button: 'Unsubscribe' });
      else
        page(res, 200, app.name, 'You are unsubscribed', `${app.name} sends this address no more of these emails.`, {
          token,
          action: 'resubscribe',
          button: 'Subscribe again',
        });
      return true;
    },
  });
}
