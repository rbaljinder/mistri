/**
 * Inbound mail for a tenant App: Cloudflare Email Routing hands a message to the Worker's `email()`; this signs it
 * and posts it to the App's inbound endpoint through the Durable Object, never over the public Internet.
 * The message is parsed by a function the project supplies (postal-mime's `PostalMime.parse` is the usual one), so
 * this package carries no parser.
 */
import { instanceOf } from './instance.js';

export interface ParsedMail {
  from?: unknown;
  to?: unknown[];
  cc?: unknown[];
  subject?: string;
  messageId?: string;
  inReplyTo?: string;
  references?: string;
  text?: string;
  html?: string;
  headers: Array<{ key: string; value: string }>;
  attachments: Array<{ filename?: string | null; mimeType: string; content: unknown }>;
}

/** The part of an email message the forwarder reads (Cloudflare's ForwardableEmailMessage). */
export interface InboundMessage {
  to: string;
  raw: ReadableStream<Uint8Array>;
  setReject(reason: string): void;
}

export interface ForwardEmailOptions {
  /** The Durable Object binding, and the instance and location hint the Worker's `fetch` uses (mistriWorker). */
  binding: string;
  instance: string;
  location?: string;
  /** The Worker secret holding the signing key (the App's mail secret). */
  secretEnv: string;
  /** Parses the raw message. */
  parse(raw: ReadableStream<Uint8Array>): Promise<ParsedMail>;
  /** The App's inbound endpoint. Default `/api/mail/inbound`. */
  path?: string;
  /** The public address, so the Host header passes MISTRI_ALLOWED_HOSTS. Default the Worker's MISTRI_PUBLIC_URL. */
  publicUrl?: string;
  /** The signature headers are `x-<header>-timestamp` and `x-<header>-signature`. Default `mistri`. */
  header?: string;
}

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** `v1=<hex>`: HMAC-SHA-256 over `<timestamp>.<body>`. */
export async function signMail(secret: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `v1=${hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${body}`)))}`;
}

function mailBody(message: Pick<InboundMessage, 'to'>, mail: ParsedMail): string {
  return JSON.stringify({
    recipient: message.to,
    from: mail.from,
    to: mail.to ?? [],
    cc: mail.cc ?? [],
    subject: mail.subject ?? '',
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
    text: mail.text,
    html: mail.html,
    headers: Object.fromEntries(mail.headers.map((h) => [h.key, h.value])),
    attachments: mail.attachments.map((a) => ({ name: a.filename ?? 'attachment', type: a.mimeType, content: a.content })),
  });
}

/**
 * Forward one message, and let nothing finish quietly that the App did not take. A 2xx (204 taken, 202 dropped and
 * logged) and the replay 409 are done. A 404 rejects it ("No such mailbox"), a 413 as too large, and a 400 or 422 as
 * unreadable: those are the message's own fault and a retry cannot change them. Everything else — 401 or 403 (the
 * signature or the Worker's clock or secret), 429, a 5xx, a redirect — is the deployment's problem, not the sender's, so
 * it throws, for Email Routing to retry and for the Worker's logs to show. The error names the status, never the message.
 */
export async function forwardEmail(message: InboundMessage, env: Record<string, unknown>, options: ForwardEmailOptions): Promise<void> {
  const secret = env[options.secretEnv];
  if (typeof secret !== 'string' || !secret) throw new Error(`${options.secretEnv} is not set on the Worker`);
  const base = options.publicUrl ?? (env.MISTRI_PUBLIC_URL as string | undefined);
  if (!base) throw new Error('forwardEmail needs publicUrl or MISTRI_PUBLIC_URL');
  const body = mailBody(message, await options.parse(message.raw));
  const timestamp = String(Math.floor(Date.now() / 1000));
  const name = options.header ?? 'mistri';
  const answer = await instanceOf(env, options.binding, options.instance, options.location).fetch(
    new Request(new URL(options.path ?? '/api/mail/inbound', base), {
      method: 'POST',
      body,
      headers: {
        'content-type': 'application/json',
        [`x-${name}-timestamp`]: timestamp,
        [`x-${name}-signature`]: await signMail(secret, timestamp, body),
      },
    }),
  );
  if (answer.ok || answer.status === 409) return;
  if (answer.status === 404) message.setReject('No such mailbox');
  else if (answer.status === 413) message.setReject('Message too large');
  else if (answer.status === 400 || answer.status === 422) message.setReject('Message could not be processed');
  else
    throw new Error(`the App answered ${answer.status}${answer.status === 401 ? ' (check the signing secret and the Worker clock)' : ''}`);
}
