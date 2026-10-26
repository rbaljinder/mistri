/**
 * Email, as a service a config file names: the one way the platform sends
 * mail — a notification (`notify` with `email: true`, a mention), a status
 * check's one-time code, an account's verification and reset links.
 *
 *   { "name": "mail", "kind": "email", "url": "smtps://smtp.example.com:465",
 *     "from": "Compass <no-reply@example.com>",
 *     "auth": { "username": "${SMTP_USER}", "password": "${SMTP_PASSWORD}" } }
 *   { "name": "mail", "kind": "email", "url": "log:.mistri/mail.log", "from": "Compass <no-reply@example.test>" }
 *
 * The URL is the transport. `smtps://` is TLS from the first byte and
 * `smtp://` must offer STARTTLS (`"insecure": true` allows a plain relay on a
 * trusted network); both go through the shared network policy, so the host
 * checked is the host connected. `log:` writes each message as one JSON line
 * to a file (`log:<path>`, relative to the config file) or to stdout (`log:`)
 * and sends nothing: development and tests. Credentials are `${VAR}`
 * references expanded when the transport opens, never logged, and written
 * back on save as they were read. A deployment has one email service, and
 * an App definition never names a credential or an address to send from.
 */
import { errorCode, inSpan, tracing } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DEFAULT_POLICY, type EgressPolicy } from '@mistriwork/engine/adapters/http/egress.js';
import { SmtpError, sendSmtp } from '../../adapters/email/smtp.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import { dkimSign, type DkimKey } from './dkim.js';

export interface EmailServiceConfig {
  kind: 'email';
  name: string;
  /** `smtps://host:465`, `smtp://host:587`, `log:` or `log:<path>`. `${VAR}` references intact. */
  url: string;
  /** Who the mail is from: `Name <address>` or an address. */
  from: string;
  auth?: { username: string; password: string };
  insecure?: boolean;
  allowLinkLocal?: boolean;
  /** Where the config file is, for a relative `log:` path. Not written back. */
  base?: string;
  /** A tenant App's inbound mail: the webhook's secret, the routing domain (`<mailbox>+<tenant>@<domain>`) and the largest message. */
  inbound?: { secret: string; domain: string; maxBytes?: number };
  /** Signing: the selector the public key is published under and the PEM file of the private key, relative to the config file. */
  dkim?: { selector: string; key: string };
  /** A tenant's own sending domains: domain → tenant id. Mail From any other domain goes out From the service's own address. */
  domains?: Record<string, string>;
  /** Signed links: in a tenant's mail, and the unsubscribe link in mail to an address a record holds (`notify.via`
      email). The secret they are signed with, and how long a tenant's link lasts (default 30 days). */
  links?: { secret: string; ttl?: string };
  /** What `mistri mail-dns` prints: the relay's SPF include, and the domain bounces return to. */
  spf?: string;
  returnPath?: string;
}

export const EMAIL_KEYS = [
  'name',
  'kind',
  'url',
  'from',
  'auth',
  'insecure',
  'allowLinkLocal',
  'inbound',
  'dkim',
  'domains',
  'links',
  'spf',
  'returnPath',
] as const;

/** One message: plain text, to one person. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  /** Bearer secrets: omit observer detail and sanitize transport errors. An operator's `log:` transport still records the mail. */
  sensitive?: boolean;
  /** Where the recipient stops this mail in one click: the List-Unsubscribe and List-Unsubscribe-Post headers (RFC 8058),
      the only headers a caller adds. The server builds the URL; one that could break a header is refused. */
  unsubscribe?: string;
}

/* An http(s) URL with nothing a header line could be split or closed on. */
const HEADER_URL = /^https?:\/\/[\x21-\x3b\x3d\x3f-\x7e]+$/;

/** Where messages go. `send` resolves once the message is accepted, or rejects with an EmailFailure. */
export interface EmailTransport {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Why a message was not accepted: `permanent` when asking again cannot help. The message is for the operator. */
export class EmailFailure extends Error {
  constructor(
    message: string,
    readonly permanent = false,
  ) {
    super(message);
    this.name = 'EmailFailure';
  }
}

const ADDRESS = /^[^\s<>@",]+@[^\s<>@",]+\.[^\s<>@",]+$/;
/** The address inside a `from`: `Compass <no-reply@example.com>` or the bare address. */
function fromAddress(from: string): { address: string; name?: string } | undefined {
  const named = /^\s*([^<>\r\n]*?)\s*<([^<>\s]+)>\s*$/.exec(from);
  if (named)
    return ADDRESS.test(named[2]) ? { address: named[2], ...(named[1] ? { name: named[1].replace(/^"|"$/g, '') } : {}) } : undefined;
  return ADDRESS.test(from.trim()) ? { address: from.trim() } : undefined;
}

/** An entry of kind "email", checked. Throws naming the field. */
export function emailConnectionOf(entry: Record<string, unknown>, where: string, base?: string): EmailServiceConfig {
  const stray = Object.keys(entry).find((key) => !(EMAIL_KEYS as readonly string[]).includes(key));
  if (stray) throw new Error(`${where} is an email connection, which takes no "${stray}". It takes: ${EMAIL_KEYS.join(', ')}.`);
  const url = String(entry.url);
  if (!url.includes('${')) transportOf(url, where);
  if (typeof entry.from !== 'string' || !fromAddress(entry.from)) {
    throw new Error(`${where} needs a "from": the address mail is sent from, like "Compass <no-reply@example.com>".`);
  }
  for (const flag of ['insecure', 'allowLinkLocal'] as const) {
    if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean')
      throw new Error(`${where} has "${flag}": it must be true or false, without quotes.`);
  }
  let auth: EmailServiceConfig['auth'];
  if (entry.auth !== undefined) {
    const given = entry.auth as Record<string, unknown>;
    const keys = given && typeof given === 'object' && !Array.isArray(given) ? Object.keys(given).sort().join(',') : '';
    if (
      keys !== 'password,username' ||
      typeof given.username !== 'string' ||
      !given.username ||
      typeof given.password !== 'string' ||
      !given.password
    ) {
      throw new Error(`${where} has an "auth" mistri cannot read. Write { "username": "\${SMTP_USER}", "password": "\${SMTP_PASSWORD}" }.`);
    }
    auth = { username: given.username, password: given.password };
  }
  return {
    kind: 'email',
    name: String(entry.name),
    url,
    from: entry.from,
    ...(auth ? { auth } : {}),
    ...(entry.insecure === true ? { insecure: true } : {}),
    ...(entry.allowLinkLocal === true ? { allowLinkLocal: true } : {}),
    ...(base ? { base } : {}),
    ...tenantMailOf(entry, where),
  };
}

const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SECRET_REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/** The tenant mail settings of an email entry, checked: each a shape mistri can read, and every secret a `${VAR}` reference. */
function tenantMailOf(entry: Record<string, unknown>, where: string): Partial<EmailServiceConfig> {
  const out: Partial<EmailServiceConfig> = {};
  const object = (key: string, keys: readonly string[], optional: readonly string[] = []) => {
    const value = entry[key];
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where} has an "${key}" that is not an object.`);
    for (const name of Object.keys(value)) {
      if (!keys.includes(name) && !optional.includes(name))
        throw new Error(`${where} has "${key}.${name}"; "${key}" takes ${[...keys, ...optional].join(', ')}.`);
    }
    for (const name of keys) if (!Object.hasOwn(value, name)) throw new Error(`${where} has an "${key}" without its "${name}".`);
    return value as Record<string, unknown>;
  };
  const secret = (value: unknown, at: string) => {
    if (typeof value !== 'string' || !SECRET_REFERENCE.test(value))
      throw new Error(`${where} has "${at}" written out; it is a reference to an environment variable, like "\${MAIL_INBOUND_SECRET}".`);
    return value;
  };
  if (entry.inbound !== undefined) {
    const inbound = object('inbound', ['secret', 'domain'], ['maxBytes']);
    if (typeof inbound.domain !== 'string' || !DOMAIN.test(inbound.domain))
      throw new Error(`${where} has an "inbound.domain" that is not a domain name in lower case, like "in.example.com".`);
    if (
      inbound.maxBytes !== undefined &&
      (!Number.isSafeInteger(inbound.maxBytes) || (inbound.maxBytes as number) < 1024 || (inbound.maxBytes as number) > 50 * 1024 * 1024)
    )
      throw new Error(`${where} has an "inbound.maxBytes" that is not a whole number of bytes from 1024 to 52428800.`);
    out.inbound = {
      secret: secret(inbound.secret, 'inbound.secret'),
      domain: inbound.domain,
      ...(inbound.maxBytes === undefined ? {} : { maxBytes: inbound.maxBytes as number }),
    };
  }
  if (entry.dkim !== undefined) {
    const dkim = object('dkim', ['selector', 'key']);
    if (typeof dkim.selector !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(dkim.selector))
      throw new Error(`${where} has a "dkim.selector" that is not one DNS label in lower case, like "tw1".`);
    if (typeof dkim.key !== 'string' || !dkim.key.trim()) throw new Error(`${where} has a "dkim.key" that is not the path of a PEM file.`);
    out.dkim = { selector: dkim.selector, key: dkim.key };
  }
  if (entry.domains !== undefined) {
    const domains = entry.domains;
    if (!domains || typeof domains !== 'object' || Array.isArray(domains))
      throw new Error(`${where} has "domains" that is not an object of domain → tenant id.`);
    const kept: Record<string, string> = {};
    for (const [domain, tenant] of Object.entries(domains)) {
      if (!DOMAIN.test(domain)) throw new Error(`${where} has "domains.${domain}", which is not a domain name in lower case.`);
      if (typeof tenant !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(tenant))
        throw new Error(`${where} has "domains.${domain}" that is not a tenant id.`);
      kept[domain] = tenant;
    }
    out.domains = kept;
  }
  if (entry.links !== undefined) {
    const links = object('links', ['secret'], ['ttl']);
    if (links.ttl !== undefined) {
      const ms = parseDuration(links.ttl);
      if (!ms || ms < 60_000 || ms > 366 * 86_400_000)
        throw new Error(`${where} has a "links.ttl" that is not a duration from a minute to a year, like "30 days".`);
    }
    out.links = { secret: secret(links.secret, 'links.secret'), ...(links.ttl === undefined ? {} : { ttl: links.ttl as string }) };
  }
  for (const key of ['spf', 'returnPath'] as const) {
    if (entry[key] === undefined) continue;
    // An SPF include is a DNS name, and relays' often start with a label like "_spf".
    const named = key === 'spf' && typeof entry[key] === 'string' ? (entry[key] as string).replace(/^_[a-z0-9-]+\./, 'x.') : entry[key];
    if (typeof named !== 'string' || !DOMAIN.test(named))
      throw new Error(`${where} has a "${key}" that is not a domain name in lower case.`);
    out[key] = entry[key] as string;
  }
  return out;
}

type TransportSpec = { kind: 'log'; file?: string } | { kind: 'smtp'; host: string; port: number; secure: boolean };

function transportOf(text: string, where: string): TransportSpec {
  if (text === 'log:') return { kind: 'log' };
  if (text.startsWith('log:')) return { kind: 'log', file: text.slice(4) };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${where} has a "url" that is not smtps://, smtp:// or log:.`);
  }
  if (url.protocol !== 'smtps:' && url.protocol !== 'smtp:') {
    throw new Error(
      `${where} has a ${url.protocol}// "url". Email is smtps:// (TLS), smtp:// (STARTTLS), or log: to write messages instead of sending them.`,
    );
  }
  if (url.username || url.password) throw new Error(`${where} has a credential in its "url"; it belongs in "auth".`);
  if (url.search || url.hash || (url.pathname && url.pathname !== '/'))
    throw new Error(`${where} has a path, query or fragment in its "url"; it is a host and port.`);
  const secure = url.protocol === 'smtps:';
  return { kind: 'smtp', host: url.hostname.replace(/^\[|\]$/g, ''), port: url.port ? Number(url.port) : secure ? 465 : 587, secure };
}

/** The config entry as written, for saving: the references stay references. */
export function emailEntry(service: EmailServiceConfig): Record<string, unknown> {
  const { name, kind, url, from, auth } = service;
  return {
    name,
    kind,
    url,
    from,
    ...(auth ? { auth } : {}),
    ...(service.insecure ? { insecure: true } : {}),
    ...(service.allowLinkLocal ? { allowLinkLocal: true } : {}),
    ...(service.inbound ? { inbound: service.inbound } : {}),
    ...(service.dkim ? { dkim: service.dkim } : {}),
    ...(service.domains ? { domains: service.domains } : {}),
    ...(service.links ? { links: service.links } : {}),
    ...(service.spf ? { spf: service.spf } : {}),
    ...(service.returnPath ? { returnPath: service.returnPath } : {}),
  };
}

/* A header value on one line; a non-ASCII one as an RFC 2047 encoded word. */
const headerText = (value: string) => {
  const line = value.replace(/[\r\n]+/g, ' ').trim();
  return /^[\x20-\x7e]*$/.test(line) ? line : `=?UTF-8?B?${Buffer.from(line, 'utf8').toString('base64')}?=`;
};

/** One message as RFC 5322 text: plain UTF-8, base64 in lines of 76. */
export function composeMessage(from: string, message: EmailMessage, now = new Date()): string {
  const sender = fromAddress(from)!;
  /* The transport checks the recipient too; this is here so no caller can
     carry a line break into the headers (a typed address on a public form). */
  if (!ADDRESS.test(message.to)) throw new EmailFailure('The recipient is not one address.', true);
  if (message.unsubscribe !== undefined && !HEADER_URL.test(message.unsubscribe))
    throw new EmailFailure('The unsubscribe link is not one URL.', true);
  const domain = sender.address.split('@')[1];
  const body = Buffer.from(message.text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, (line) => `${line}\r\n`);
  return [
    `From: ${sender.name ? `${headerText(sender.name)} <${sender.address}>` : sender.address}`,
    `To: ${message.to}`,
    `Subject: ${headerText(message.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${domain}>`,
    ...(message.unsubscribe
      ? [
          `List-Unsubscribe: <${message.unsubscribe}>`,
          'List-Unsubscribe-Post: List-Unsubscribe=One-Click',
          'Auto-Submitted: auto-generated',
        ]
      : []),
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

interface EmailTransportOptions {
  /** Expanded immediately when opened. An explicit empty object never falls back to process.env. */
  environment?: NodeJS.ProcessEnv;
  /** Test-only network and TLS overrides. */
  resolver?: EgressPolicy['resolver'];
  tls?: { rejectUnauthorized?: boolean };
}

/** Open the deployment's transport: its URL and credentials expanded now. */
export function openEmailTransport(service: EmailServiceConfig, options: EmailTransportOptions = {}): EmailTransport {
  const transport = openUntraced(service, options);
  const send = async (message: EmailMessage): Promise<void> => {
    try {
      await transport.send(message);
    } catch (error) {
      // Sanitize before inSpan can retain the error in observer detail. A relay
      // may echo any part of the message or credentials in its refusal.
      if (message.sensitive)
        throw new EmailFailure('The email message could not be sent.', error instanceof EmailFailure && error.permanent);
      throw error;
    }
  };
  /* A message's span says that one was sent and how it went; who it went to,
     its subject and its text stay local, for the dev observer. */
  return Object.freeze({
    name: transport.name,
    send: (message: EmailMessage) =>
      tracing()
        ? inSpan(
            'email send',
            { kind: 'client', attributes: { 'mistri.outbound.kind': 'email' } },
            (span) => {
              if (!message.sensitive)
                span.detail(() => ({
                  email: { service: service.name, to: message.to, subject: message.subject, text: message.text.slice(0, 8000) },
                }));
              return send(message);
            },
            (error) => (error instanceof EmailFailure ? (error.permanent ? 'permanent' : 'temporary') : errorCode(error)),
          )
        : send(message),
  });
}

/** How a raw message leaves: through the relay, or written as a JSON line (`log:`). `logged` is what the log line says of it. */
type RawSend = (envelope: { from: string; to: readonly string[] }, raw: string, logged: Record<string, unknown>) => Promise<void>;

function rawSender(service: EmailServiceConfig, options: EmailTransportOptions): RawSend {
  const where = `connection "${service.name}"`;
  const spec = transportOf(expandEnvReferences(service.url, options.environment), where);
  if (spec.kind === 'log') {
    const file = spec.file ? (isAbsolute(spec.file) ? spec.file : resolve(service.base ?? process.cwd(), spec.file)) : undefined;
    if (file) mkdirSync(dirname(file), { recursive: true });
    return async (_envelope, _raw, logged) => {
      const line = `${JSON.stringify({ at: new Date().toISOString(), ...logged })}\n`;
      if (file) appendFileSync(file, line, { mode: 0o600 });
      else process.stdout.write(line);
    };
  }
  const username = service.auth ? expandEnvReferences(service.auth.username, options.environment) : undefined;
  const password = service.auth ? expandEnvReferences(service.auth.password, options.environment) : undefined;
  const policy = {
    ...DEFAULT_POLICY,
    allowLinkLocal: service.allowLinkLocal === true,
    ...(options.resolver ? { resolver: options.resolver } : {}),
  };
  return async (envelope, raw) => {
    try {
      await sendSmtp(
        {
          host: spec.host,
          port: spec.port,
          secure: spec.secure,
          insecure: service.insecure === true,
          policy,
          ...(username !== undefined ? { username, password } : {}),
          ...(options.tls ? { tls: options.tls } : {}),
        },
        envelope,
        raw,
      );
    } catch (error) {
      if (error instanceof SmtpError) throw new EmailFailure(`email "${service.name}": ${error.message}`, error.permanent);
      throw new EmailFailure(`email "${service.name}": the message could not be sent.`);
    }
  };
}

function openUntraced(service: EmailServiceConfig, options: EmailTransportOptions): EmailTransport {
  const send = rawSender(service, options);
  const sender = fromAddress(service.from)!;
  return Object.freeze({
    name: service.name,
    async send(message: EmailMessage) {
      if (!ADDRESS.test(message.to)) throw new EmailFailure('The recipient is not one address.', true);
      await send({ from: sender.address, to: [message.to] }, composeMessage(service.from, message), {
        from: service.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
        ...(message.unsubscribe ? { unsubscribe: message.unsubscribe } : {}),
      });
    },
  });
}

/* ---------- a tenant App's mail ---------- */

/** One message a tenant App sends: its own sender, its thread's headers, text and, if it has one, HTML. */
export interface OutboundMail {
  from: { address: string; name?: string };
  replyTo?: string;
  to: readonly string[];
  cc?: readonly string[];
  subject: string;
  text: string;
  html?: string;
  /** `<id@domain>`: the App's own, kept so a reply's In-Reply-To finds its thread. */
  messageId: string;
  inReplyTo?: string;
  references?: readonly string[];
}

/** An address as given: `Name <a@b>`, or the bare address. Undefined when it is not one address. */
export function addressOf(text: string): { address: string; name?: string } | undefined {
  return fromAddress(text);
}
/** Whether text is one plain address. */
export const isAddress = (text: string): boolean => ADDRESS.test(text);
/** A Message-ID as a header holds it: `<local@domain>`, printable, of a sane length. */
export const isMessageId = (text: string): boolean => /^<[\x21-\x3b\x3d\x3f-\x7e]{1,250}@[\x21-\x3b\x3d\x3f-\x7e]{1,250}>$/.test(text);

const base64Lines = (text: string) =>
  Buffer.from(text.replace(/\r?\n/g, '\r\n'), 'utf8')
    .toString('base64')
    .replace(/.{1,76}/g, (line) => `${line}\r\n`);

const named = (address: { address: string; name?: string }) =>
  address.name ? `${headerText(address.name.replace(/["\\]/g, ''))} <${address.address}>` : address.address;

/** A tenant message as RFC 5322 text: text alone, or text and HTML as multipart/alternative, each in base64. */
export function composeMail(mail: OutboundMail, now = new Date()): string {
  for (const address of [mail.from.address, ...(mail.replyTo ? [mail.replyTo] : []), ...mail.to, ...(mail.cc ?? [])])
    if (!ADDRESS.test(address)) throw new EmailFailure('An address of the message is not one address.', true);
  for (const id of [mail.messageId, ...(mail.inReplyTo ? [mail.inReplyTo] : []), ...(mail.references ?? [])])
    if (!isMessageId(id)) throw new EmailFailure('A Message-ID of the message is not one.', true);
  const head = [
    `From: ${named(mail.from)}`,
    `To: ${mail.to.join(', ')}`,
    ...(mail.cc?.length ? [`Cc: ${mail.cc.join(', ')}`] : []),
    ...(mail.replyTo ? [`Reply-To: ${mail.replyTo}`] : []),
    `Subject: ${headerText(mail.subject)}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo ? [`In-Reply-To: ${mail.inReplyTo}`] : []),
    // One id a line, folded: a long thread's References stays within a line's limit.
    ...(mail.references?.length ? [`References: ${mail.references.join('\r\n ')}`] : []),
    // A notice from a desk is automatic: an auto-responder that honors this does not answer it (RFC 3834).
    'Auto-Submitted: auto-generated',
    'MIME-Version: 1.0',
  ];
  if (!mail.html) {
    return [...head, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', base64Lines(mail.text)].join(
      '\r\n',
    );
  }
  const boundary = `tw-${randomBytes(12).toString('hex')}`;
  return [
    ...head,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.text),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(mail.html),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/**
 * The deployment's sender of tenant mail: composes, signs with DKIM when a
 * key is given (`d=` the From address's domain) and sends with the envelope
 * sender asked for — the return path bounces come back to.
 */
export function openMailSender(
  service: EmailServiceConfig,
  options: EmailTransportOptions & { dkim?: DkimKey; now?: () => number } = {},
): { send(mail: OutboundMail, envelopeFrom: string): Promise<void> } {
  const send = rawSender(service, options);
  return Object.freeze({
    async send(mail: OutboundMail, envelopeFrom: string) {
      const now = new Date(options.now?.() ?? Date.now());
      let raw = composeMail(mail, now);
      if (options.dkim) raw = dkimSign(raw, options.dkim, mail.from.address.split('@')[1], now);
      await send({ from: envelopeFrom, to: [...mail.to, ...(mail.cc ?? [])] }, raw, {
        from: named(mail.from),
        to: mail.to.join(', '),
        subject: mail.subject,
        messageId: mail.messageId,
        ...(mail.inReplyTo ? { inReplyTo: mail.inReplyTo } : {}),
        text: mail.text,
      });
    },
  });
}
