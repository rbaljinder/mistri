/**
 * One inbound message as the mail webhook delivers it, read: the
 * provider-neutral JSON below, its address routed to a tenant, and the
 * noise a desk must never answer told apart before any App sees it.
 *
 *   { "recipient": "help+acme@in.example.com",
 *     "from": "Ann Lee <ann@example.org>",
 *     "to": ["Acme Help <help@acme.com>"], "cc": [],
 *     "subject": "The printer is on fire",
 *     "messageId": "<CAF1@mail.example.org>",
 *     "inReplyTo": "<notice.12@mail.acme.com>", "references": ["<ticket.4@mail.acme.com>"],
 *     "text": "…", "html": "<p>…</p>",
 *     "headers": { "auto-submitted": "no", "precedence": "bulk" },
 *     "attachments": [{ "name": "photo.jpg", "type": "image/jpeg", "content": "<base64>" }] }
 *
 * `recipient` is the envelope's: the address the provider delivered to,
 * which routes it. `<mailbox>+<tenant>@<inbound.domain>` is the platform's
 * own registry — the tenant is in the address, so no table maps one to the
 * other and none can be stale — and a tenant's own domain (the service's
 * `domains`) routes `<mailbox>@<domain>` to its tenant. A tenant's
 * `help@acme.com` forwards to `help+acme@in.example.com`.
 */
import { addressOf, isAddress, isMessageId } from './email.js';

interface InboundRouting {
  /** The platform's routing domain: `<mailbox>+<tenant>@<domain>`. */
  domain: string;
  /** A tenant's own domains: domain → tenant id. */
  domains: Readonly<Record<string, string>>;
}

/** The message as the webhook sent it, read and routed; the words not yet cleaned. */
export interface ReadInbound {
  tenant: string;
  mailbox: string;
  recipient: string;
  from: { address: string; name?: string };
  to: { address: string; name?: string }[];
  cc: { address: string; name?: string }[];
  subject: string;
  messageId: string;
  inReplyTo: string | null;
  references: string[];
  text: string | null;
  html: string | null;
  headers: Record<string, string>;
  attachments: { name: string; type: string; content: string; size: number }[];
}

/** Why a delivery was not read, as a status: 400 unreadable, 404 no tenant's address, 413 too large. */
export class InboundRefusal extends Error {
  constructor(
    readonly status: 400 | 404 | 413,
    readonly reason: string,
  ) {
    super(reason);
  }
}

const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAILBOX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** The tenant and mailbox an address routes to, or undefined when it is no tenant's address here. */
export function routeAddress(recipient: string, routing: InboundRouting): { tenant: string; mailbox: string } | undefined {
  const at = recipient.lastIndexOf('@');
  if (at < 1) return undefined;
  const local = recipient.slice(0, at),
    domain = recipient.slice(at + 1).toLowerCase();
  if (domain === routing.domain) {
    const plus = local.indexOf('+');
    if (plus < 1) return undefined;
    const mailbox = local.slice(0, plus).toLowerCase(),
      tenant = local.slice(plus + 1);
    return MAILBOX.test(mailbox) && TENANT.test(tenant) ? { tenant, mailbox } : undefined;
  }
  const tenant = Object.hasOwn(routing.domains, domain) ? routing.domains[domain] : undefined;
  const mailbox = local.toLowerCase();
  return tenant && MAILBOX.test(mailbox) ? { tenant, mailbox } : undefined;
}

const text = (value: unknown, most: number, where: string): string | null => {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new InboundRefusal(400, `"${where}" is not text.`);
  // The words of a message past the size are a message too large; a subject past its length is not a subject.
  if (value.length > most)
    throw where === 'subject'
      ? new InboundRefusal(400, '"subject" is longer than a subject.')
      : new InboundRefusal(413, 'The message is larger than this server takes.');
  return value;
};

function address(value: unknown, where: string): { address: string; name?: string } {
  if (typeof value === 'string') {
    const read = addressOf(value);
    if (read) return { address: read.address.toLowerCase(), ...(read.name ? { name: read.name } : {}) };
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    const { address: given, name } = value as Record<string, unknown>;
    if (
      typeof given === 'string' &&
      isAddress(given) &&
      (name === undefined || name === null || (typeof name === 'string' && name.length <= 200))
    )
      return { address: given.toLowerCase(), ...(typeof name === 'string' && name.trim() ? { name: name.trim() } : {}) };
  }
  throw new InboundRefusal(400, `"${where}" is not one address.`);
}

const addresses = (value: unknown, where: string) => {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/) : [value];
  if (list.length > 100) throw new InboundRefusal(400, `"${where}" names more than 100 addresses.`);
  return list
    .filter((item) => typeof item !== 'string' || item.trim())
    .map((item) => address(typeof item === 'string' ? item.trim() : item, where));
};

const ids = (value: unknown): string[] => {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/\s+/) : null;
  if (!list || list.length > 200) throw new InboundRefusal(400, '"references" is not a list of Message-IDs.');
  return list.filter((id) => typeof id === 'string' && isMessageId(id.trim())).map((id) => (id as string).trim());
};

/**
 * The delivery read: routed, every field its type, attachments decoded and
 * counted. `maxBytes` bounds the message's words and attachments together.
 */
export function readInbound(body: unknown, routing: InboundRouting, maxBytes: number): ReadInbound {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new InboundRefusal(400, 'The delivery is not a JSON object.');
  const given = body as Record<string, unknown>;
  const recipient = typeof given.recipient === 'string' && isAddress(given.recipient) ? given.recipient : undefined;
  if (!recipient) throw new InboundRefusal(400, '"recipient" is not one address.');
  const route = routeAddress(recipient, routing);
  if (!route) throw new InboundRefusal(404, 'The recipient is no tenant address here.');
  const messageId = typeof given.messageId === 'string' ? given.messageId.trim() : '';
  if (!isMessageId(messageId)) throw new InboundRefusal(400, '"messageId" is not a Message-ID such as <id@host>.');
  const inReplyTo = typeof given.inReplyTo === 'string' && isMessageId(given.inReplyTo.trim()) ? given.inReplyTo.trim() : null;
  const headers: Record<string, string> = {};
  if (given.headers !== undefined) {
    if (!given.headers || typeof given.headers !== 'object' || Array.isArray(given.headers))
      throw new InboundRefusal(400, '"headers" is not an object.');
    for (const [name, value] of Object.entries(given.headers as Record<string, unknown>)) {
      if (Object.keys(headers).length >= 200) break;
      const said = Array.isArray(value) ? value[value.length - 1] : value;
      if (typeof said === 'string') headers[name.toLowerCase()] = said.slice(0, 2000);
    }
  }
  let bytes = 0;
  const attachments: ReadInbound['attachments'] = [];
  if (given.attachments !== undefined) {
    if (!Array.isArray(given.attachments) || given.attachments.length > 100) throw new InboundRefusal(400, '"attachments" is not a list.');
    for (const part of given.attachments) {
      const { name, type, content } = (part ?? {}) as Record<string, unknown>;
      if (typeof content !== 'string' || content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content))
        throw new InboundRefusal(400, 'An attachment\'s "content" is not base64.');
      const size = Buffer.byteLength(content, 'base64');
      bytes += size;
      if (bytes > maxBytes) throw new InboundRefusal(413, 'The message is larger than this server takes.');
      const named =
        typeof name === 'string'
          ? name
              .replace(/\p{Cc}/gu, '')
              .trim()
              .slice(0, 255)
          : '';
      attachments.push({
        name: named || 'attachment',
        type: typeof type === 'string' && /^[\w.+-]+\/[\w.+-]+$/.test(type) ? type.toLowerCase() : 'application/octet-stream',
        content,
        size,
      });
    }
  }
  const words = { text: text(given.text, maxBytes, 'text'), html: text(given.html, maxBytes, 'html') };
  bytes += Buffer.byteLength(words.text ?? '', 'utf8') + Buffer.byteLength(words.html ?? '', 'utf8');
  if (bytes > maxBytes) throw new InboundRefusal(413, 'The message is larger than this server takes.');
  return {
    ...route,
    recipient: recipient.toLowerCase(),
    from: address(given.from, 'from'),
    to: addresses(given.to, 'to'),
    cc: addresses(given.cc, 'cc'),
    subject: (text(given.subject, 2000, 'subject') ?? '').replace(/[\r\n]+/g, ' ').trim(),
    messageId,
    inReplyTo,
    references: ids(given.references),
    ...words,
    headers,
    attachments,
  };
}

/**
 * Why a message is noise a desk must not answer, or undefined: an
 * automatic message (RFC 3834's Auto-Submitted, or an auto-responder's own
 * marks), a list's or bulk mail (Precedence), a bounce, or mail from this
 * deployment's own sending addresses — a reply to a reply to a reply.
 */
export function noiseOf(mail: Pick<ReadInbound, 'from' | 'headers'>, own: (address: string) => boolean): string | undefined {
  const auto = mail.headers['auto-submitted']?.trim().toLowerCase();
  if (auto && !/^no\b/.test(auto)) return `Auto-Submitted: ${auto.slice(0, 40)}`;
  const precedence = mail.headers.precedence?.trim().toLowerCase();
  if (precedence && ['bulk', 'list', 'junk'].includes(precedence)) return `Precedence: ${precedence}`;
  if (mail.headers['x-autoreply'] || mail.headers['x-autorespond']) return 'an auto-reply';
  if (/^(mailer-daemon|postmaster)@/i.test(mail.from.address) || mail.headers['return-path']?.trim() === '<>') return 'a bounce';
  if (own(mail.from.address)) return "from this server's own sending address";
  return undefined;
}
