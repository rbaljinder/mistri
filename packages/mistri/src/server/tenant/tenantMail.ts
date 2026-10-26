/**
 * A tenant App's email, in and out (the jobs module's `mail`).
 *
 * In: `POST /api/mail/inbound` takes one message as provider-neutral JSON
 * (email/inboundMail.ts), signed like a verified inbound endpoint — an
 * HMAC-SHA256 of `<timestamp>.<raw body>` under the email service's
 * `inbound.secret`, in `x-mistri-signature: v1=<hex>` beside
 * `x-mistri-timestamp` — and verified on the raw bytes before anything
 * parses them. The same signed delivery twice is refused (409): a captured
 * request is not a second message. The address routes it to its tenant;
 * noise (an auto-reply, a list, a bounce, our own mail come back, a sender
 * past its rate) is dropped and logged, never shown to the App; the rest
 * runs `receive.command` as its principal in that tenant, through the same
 * fenced binding a job's attempt has (tenantJobs.ts `deliver`). The
 * Message-ID is the command receipt's idempotency key, so a provider's
 * retry of the same message replays the receipt and writes nothing twice.
 *
 * Out: every `send.every`, in each active tenant, `send.claim` returns the
 * messages the App holds; each is signed with DKIM and sent through the
 * email service with the Message-ID, In-Reply-To and References the App
 * stored, and `send.record` is told what became of it. The From a tenant
 * names goes out as it is only from a domain the service gives that tenant
 * (`domains`); any other is sent From the service's own address, under the
 * tenant's name, with the tenant's address as Reply-To — a tenant cannot
 * sign as another's domain.
 *
 * Links: a held message's `link` names a record; the platform signs a link
 * to it (email/mailLinks.ts) and puts it where the words say `{link}`.
 * `GET /api/mail/link?token=` opens it: the `links.command` run on that
 * record in that tenant, its result the answer.
 *
 * Every answer of the webhook is a status and nothing else, as an inbound
 * endpoint's is: 204 taken (or the same message again), 202 dropped, 400
 * unreadable, 401 unsigned, 404 no tenant's address, 409 a replayed
 * delivery, 413 too large, or the command's own refusal.
 */
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isAbsolute, resolve } from 'node:path';
import { MemoryCacheStore, type CacheStore } from '@mistriwork/engine/adapters/cache/cacheStore.js';
import { openMailStore, type MailLogEntry, type MailStore } from '../../adapters/mail/mailStore.js';
import { inSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { expandEnvReferences } from '@mistriwork/engine/server/auth/credentials.js';
import { businessCommandHttpError } from '../commands/businessCommandHttp.js';
import {
  executeBusinessCommand,
  isBusinessCommandExecutionError,
  type BusinessCommandResult,
} from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import type { CommandFile } from '../commands/businessCommands.js';
import { dkimKey, type DkimKey } from '../email/dkim.js';
import {
  addressOf,
  EmailFailure,
  isAddress,
  isMessageId,
  openMailSender,
  type EmailServiceConfig,
  type OutboundMail,
} from '../email/email.js';
import { InboundRefusal, noiseOf, readInbound, type ReadInbound } from '../email/inboundMail.js';
import { issueMailLink, mailLinkKey, readMailLink } from '../email/mailLinks.js';
import { inboundWords } from '../email/mailText.js';
import { fillMailBrand, mailLinkPage, mailLinkPolicy, type MailLinkPage } from '../email/mailLinkPage.js';
import type { TenantBrandingService } from './tenantBranding.js';
import { fieldLabel } from '../../shared/command.js';
import { uploadValues } from '../http/fileRows.js';
import { TENANT_FILE_MOST } from '@mistriwork/engine/server/http/reply.js';
import { FILE_MAX_BYTES_DEFAULT } from '../../shared/appModel.js';
import { inboundCommandKey, verifyDelivery } from '../jobs/inboundHost.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import type { CapturedHmac, InboundMail, JobCommandReference } from '../jobs/jobModule.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';
import type { TenantMailRuntime } from './tenantJobs.js';

export const MAIL_INBOUND_PATH = '/api/mail/inbound';
const MAIL_LINK_PATH = '/api/mail/link';

/** The webhook's signature: what a provider's forwarder signs, the same for every provider. */
const MAIL_SIGNATURE = Object.freeze<CapturedHmac>({
  kind: 'hmac',
  secretEnv: 'inbound.secret',
  algorithm: 'sha256',
  signatureHeader: 'x-mistri-signature',
  encoding: 'hex',
  prefix: 'v1=',
  timestampHeader: 'x-mistri-timestamp',
  windowMs: 300_000,
  signed: Object.freeze([{ part: 'timestamp' as const }, '.', { part: 'body' as const }]),
});

/** The largest message, words and attachments together, unless the service says otherwise. */
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
/** Messages one sender may have taken in by one tenant in an hour; past it they are dropped. */
const PER_SENDER_HOUR = 30;
const HOUR = 3_600_000;
const BATCH = 50;
const DEFAULT_LINK_TTL = 30 * 86_400_000;

interface TenantMailOptions {
  readonly runtime: TenantMailRuntime;
  readonly service: EmailServiceConfig;
  /** The public origin and base path a signed link starts with: `https://desk.example.com/tools`. */
  readonly baseURL: string;
  /** The deployment's cache, for the replay and per-sender counts; this process's own without one. */
  readonly cache?: CacheStore;
  readonly environment?: NodeJS.ProcessEnv;
  readonly now?: () => number;
  /** Where the loop's own failures are said; never a message's words. */
  readonly warn?: (message: string) => void;
  /** Each tenant's branding, where the App declares it: the link page and a message's `{brand.*}` wear it. */
  readonly branding?: TenantBrandingService;
  /** Tests: the relay's TLS and name resolution. */
  readonly transport?: Readonly<{ tls?: { rejectUnauthorized?: boolean }; resolver?: unknown }>;
}

export interface TenantMail {
  /** True when the request was this module's to answer. */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  /** One pass of the send loop over every active tenant. */
  sendOnce(): Promise<{ sent: number; failed: number }>;
  start(): void;
  stop(): Promise<void>;
}

class NoTenant extends Error {}

const status = (res: ServerResponse, code: number, headers: Record<string, string> = {}): void => {
  if (res.headersSent) return;
  res.writeHead(code, { 'cache-control': 'no-store', 'content-length': '0', ...headers });
  res.end();
};

const json = (res: ServerResponse, code: number, body: unknown): void => {
  if (res.headersSent) return;
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    // The token is in the address: it never leaves in a Referer.
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
};

async function readBody(req: IncomingMessage, most: number): Promise<Buffer | null> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > most) return null;
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    bytes += chunk.length;
    if (bytes > most) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const toList = (value: unknown): string[] | undefined =>
  value === undefined || value === null
    ? []
    : typeof value === 'string'
      ? value
          .split(',')
          .map((part) => part.trim())
          .filter(Boolean)
      : Array.isArray(value) && value.every((part) => typeof part === 'string')
        ? (value as string[])
        : undefined;

/** The App's input from a message, unless it says otherwise: the shape a receive-an-email command takes. */
export function defaultMailInput(mail: InboundMail, routing: { domain: string }) {
  const to = mail.recipient.endsWith(`@${routing.domain}`)
    ? (mail.to.find((each) => !each.address.endsWith(`@${routing.domain}`))?.address ?? mail.recipient)
    : mail.recipient;
  return {
    to,
    from: mail.from.address,
    ...(mail.from.name ? { from_name: mail.from.name } : {}),
    subject: mail.subject || '(no subject)',
    body: mail.text || mail.subject || '(no text)',
    message_id: mail.messageId,
    ...(mail.inReplyTo ? { in_reply_to: mail.inReplyTo } : {}),
    ...(mail.references.length ? { references: mail.references.join(' ') } : {}),
  };
}

export async function openTenantMail(options: TenantMailOptions): Promise<TenantMail> {
  const { runtime, service } = options;
  const { mail: declared, app } = runtime;
  const environment = options.environment ?? process.env;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.error(`mistri: ${message}`));
  const where = `email connection "${service.name}"`;
  if (declared.receive && !service.inbound)
    throw new Error(
      `The jobs module receives mail, and the ${where} has no "inbound": { "secret": "\${MAIL_INBOUND_SECRET}", "domain": "in.example.com" }.`,
    );
  if (declared.links && !service.links)
    throw new Error(`The jobs module opens signed links, and the ${where} has no "links": { "secret": "\${MAIL_LINK_SECRET}" }.`);
  const inboundSecret = service.inbound ? expandEnvReferences(service.inbound.secret, environment) : '';
  const linkSecret = service.links ? expandEnvReferences(service.links.secret, environment) : '';
  if ((declared.receive && !inboundSecret) || (declared.links && !linkSecret))
    throw new Error(`The ${where} names a secret that is empty.`);
  const linkTtl = service.links?.ttl ? parseDuration(service.links.ttl)! : DEFAULT_LINK_TTL;
  let dkim: DkimKey | undefined;
  if (service.dkim) {
    const path = expandEnvReferences(service.dkim.key, environment);
    const file = isAbsolute(path) ? path : resolve(service.base ?? process.cwd(), path);
    let pem: string;
    try {
      pem = readFileSync(file, 'utf8');
    } catch {
      throw new Error(`The ${where} signs with the DKIM key in ${service.dkim.key}, which cannot be read. \`mistri mail-dns\` makes one.`);
    }
    dkim = dkimKey(service.dkim.selector, pem);
  }
  const platform = addressOf(service.from)!;
  const maxBytes = service.inbound?.maxBytes ?? DEFAULT_MAX_BYTES;
  const routing = { domain: service.inbound?.domain ?? '', domains: service.domains ?? {} };
  const sender = declared.send
    ? openMailSender(service, {
        environment,
        now,
        ...(dkim ? { dkim } : {}),
        ...(options.transport?.tls ? { tls: options.transport.tls } : {}),
        ...(options.transport?.resolver ? { resolver: options.transport.resolver as never } : {}),
      })
    : undefined;
  const store: MailStore = await openMailStore(runtime.target);
  const cache = options.cache ?? new MemoryCacheStore();
  const fallback = new MemoryCacheStore();
  /* A count the cache cannot keep is kept here: a rate is still a rate on one instance. */
  const count = async (key: string, ttlMs: number) => {
    try {
      return (await cache.incr(key, ttlMs)).count;
    } catch {
      return (await fallback.incr(key, ttlMs)).count;
    }
  };
  /* Our own sending addresses: the service's, the routing domain's, the return path's, and every From sent lately. */
  const sentFrom = new Set<string>();
  const own = (address: string) =>
    address === platform.address.toLowerCase() ||
    (!!routing.domain && address.endsWith(`@${routing.domain}`)) ||
    (!!service.returnPath && address.endsWith(`@${service.returnPath}`)) ||
    sentFrom.has(address);
  const log = async (entry: Omit<MailLogEntry, 'at'>) => {
    try {
      await store.log({ at: now(), ...entry });
    } catch {
      warn('the mail store could not record an inbound message.');
    }
  };
  const linksResource = declared.links ? runtime.commands[declared.links.command.id]?.target : undefined;

  /** One mail command, as its part's principal, in one tenant. */
  async function run(
    part: 'receive' | 'send' | 'links',
    tenant: string,
    reference: JobCommandReference,
    input: unknown,
    idempotencyKey: string,
    key: Readonly<Record<string, string | number>> = {},
    files?: readonly CommandFile[],
  ): Promise<BusinessCommandResult> {
    const runAs = part === 'receive' ? declared.receive!.runAs : part === 'send' ? declared.send!.runAs : declared.links!.runAs;
    const actor = serviceActor(app.id, runAs, runtime.principals.get(runAs)!);
    return asBackgroundWork(async () => {
      let bound: Awaited<ReturnType<TenantMailRuntime['deliver']>>;
      try {
        bound = await runtime.deliver(part, tenant);
      } catch {
        throw new NoTenant();
      }
      try {
        bound.binding.authorize(reference.id, actor);
        const captureFlags = bound.captureFlags;
        const flags = await commandFlagsOnce(() => captureFlags?.(actor))();
        return await executeBusinessCommand(
          bound.binding,
          actor,
          { command: reference.id, commandVersion: reference.version, key, expectedVersion: 0, idempotencyKey, input },
          { door: 'job', flags, requestId: `mail:${part}`, now: () => new Date(now()), ...(files ? { files } : {}) },
        );
      } finally {
        bound.release();
      }
    });
  }

  const refusal = (error: unknown) =>
    businessCommandHttpError(error instanceof AppAccessDenied || isBusinessCommandExecutionError(error) ? error : new Error());

  /* ---------- in ---------- */

  async function receive(req: IncomingMessage, res: ServerResponse, outcome: (value: string) => void): Promise<void> {
    // Base64 is four bytes for three, and the JSON around it is small.
    const body = await readBody(req, Math.ceil((maxBytes * 4) / 3) + 256 * 1024);
    if (!body) {
      outcome('too_large');
      return status(res, 413);
    }
    if (!verifyDelivery(MAIL_SIGNATURE, req.headers, body, inboundSecret, now())) {
      outcome('unverified');
      return status(res, 401);
    }
    // The same signed delivery twice is a replay, whatever it carries: counted for twice its window.
    const signature = createHash('sha256').update(String(req.headers[MAIL_SIGNATURE.signatureHeader])).digest('hex');
    if ((await count(`mail:seen:${signature}`, MAIL_SIGNATURE.windowMs * 2)) > 1) {
      outcome('replayed_delivery');
      return status(res, 409);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(body));
    } catch {
      outcome('unreadable');
      return status(res, 400);
    }
    let mail: ReadInbound;
    try {
      mail = readInbound(parsed, routing, maxBytes);
    } catch (error) {
      if (!(error instanceof InboundRefusal)) throw error;
      const recipient = (parsed as { recipient?: unknown } | null)?.recipient;
      if (error.status === 404 && typeof recipient === 'string' && isAddress(recipient))
        await log({ tenantId: null, recipient, sender: null, messageId: null, outcome: 'unrouted', reason: error.reason });
      outcome(error.status === 404 ? 'unrouted' : error.status === 413 ? 'too_large' : 'unreadable');
      return status(res, error.status);
    }
    const entry = { tenantId: mail.tenant, recipient: mail.recipient, sender: mail.from.address, messageId: mail.messageId };
    const noise = noiseOf(mail, own);
    if (noise) {
      await log({ ...entry, outcome: 'dropped', reason: noise });
      outcome('dropped');
      return status(res, 202);
    }
    if ((await count(`mail:rate:${mail.tenant}:${mail.from.address}`, HOUR)) > PER_SENDER_HOUR) {
      await log({ ...entry, outcome: 'dropped', reason: `more than ${PER_SENDER_HOUR} messages from this sender in an hour` });
      outcome('dropped');
      return status(res, 202);
    }
    // Each attachment as the App's file resource would take it as an upload: its size and name rules.
    const files = declared.receive!.attachments;
    const file = files ? app.resources?.[files]?.file : undefined;
    // The tenant host's own cap on a file too, as its upload route holds one (tenantHttp.ts).
    const rule = file && {
      ...file,
      table: files!,
      resource: files!,
      maxBytes: Math.min(file.maxBytes ?? FILE_MAX_BYTES_DEFAULT, TENANT_FILE_MOST),
    };
    if (rule) {
      for (const part of mail.attachments) {
        const checked = uploadValues(rule, { file: { name: part.name, type: part.type, data: part.content } });
        if ('status' in checked) {
          await log({ ...entry, outcome: 'refused', reason: checked.error });
          outcome(checked.status === 413 ? 'too_large' : 'invalid');
          return status(res, checked.status === 413 ? 413 : 400);
        }
      }
    }
    const words = inboundWords(mail);
    const message: InboundMail = Object.freeze({
      tenant: mail.tenant,
      mailbox: mail.mailbox,
      recipient: mail.recipient,
      from: mail.from,
      to: mail.to,
      cc: mail.cc,
      subject: mail.subject,
      messageId: mail.messageId,
      inReplyTo: mail.inReplyTo,
      references: mail.references,
      text: words.text,
      html: words.html,
      attachments: rule ? mail.attachments : [],
    });
    let input: unknown;
    try {
      const made = declared.receive!.input ? declared.receive!.input(message) : defaultMailInput(message, routing);
      // Plain JSON, as a command takes it: what does not survive the trip is not input.
      input = made === undefined ? {} : JSON.parse(JSON.stringify(made));
    } catch {
      outcome('invalid');
      return status(res, 400);
    }
    try {
      const done = await run(
        'receive',
        mail.tenant,
        declared.receive!.command,
        input,
        inboundCommandKey(`mail:${mail.tenant}`, mail.messageId),
        {},
        /* The attachments' bytes reach the handler beside its input, never in it: the receipt keeps the input, and
           a handler stores each with db.<file resource>.insertFile(file, { … }) — checked again there, audited by
           name, type and size. */
        rule
          ? mail.attachments.map((part) =>
              Object.freeze({ name: part.name, type: part.type, size: part.size, data: Buffer.from(part.content, 'base64') }),
            )
          : undefined,
      );
      await log({ ...entry, outcome: done.replayed ? 'replayed' : 'applied', reason: null });
      outcome(done.replayed ? 'replayed' : 'applied');
      return status(res, 204);
    } catch (error) {
      if (error instanceof NoTenant) {
        await log({ ...entry, outcome: 'unrouted', reason: 'no active tenant by that id' });
        outcome('unrouted');
        return status(res, 404);
      }
      const failure = refusal(error);
      await log({ ...entry, outcome: 'refused', reason: failure.body.code });
      outcome(failure.body.code);
      return status(res, failure.status, failure.retryAfter === undefined ? {} : { 'retry-after': String(failure.retryAfter) });
    }
  }

  /* ---------- links ---------- */

  /* A link opens a page for a person, its answer as JSON for a program that asks for one (Accept: application/json). */
  const linkWhat = linksResource ? fieldLabel(app.resources?.[linksResource]?.noun?.one ?? linksResource) : '';
  async function linkAnswer(
    req: IncomingMessage,
    res: ServerResponse,
    code: number,
    body: Record<string, unknown>,
    { tenant, ...page }: Omit<MailLinkPage, 'app' | 'what' | 'nonce' | 'brand' | 'root'> & { tenant?: string },
  ) {
    if (/\bapplication\/json\b/.test(String(req.headers.accept ?? ''))) return json(res, code, body);
    if (res.headersSent) return;
    const nonce = randomBytes(16).toString('base64');
    /* Only a proved link wears its tenant's brand: an unproved token says nothing of whose it is. */
    const brand = tenant && options.branding ? await options.branding.mail(tenant) : undefined;
    const html = mailLinkPage({ ...page, app: app.name, what: linkWhat, nonce, ...(brand ? { brand, root: '../..' } : {}) });
    res.writeHead(code, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The token is in the address: it never leaves in a Referer, and nothing on the page could carry it elsewhere.
      'referrer-policy': 'no-referrer',
      'content-security-policy': mailLinkPolicy(nonce, brand),
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'content-length': String(Buffer.byteLength(html)),
    });
    res.end(req.method === 'HEAD' ? undefined : html);
  }
  const NOTHING = { code: 'not_found', error: 'This link opens nothing.' };
  const EXPIRED = { code: 'expired', error: 'This link has expired.' };

  type Refused = { readonly refused: number; readonly body: Record<string, unknown> };
  type Claim = Exclude<ReturnType<typeof readMailLink>, 'expired' | null | undefined>;
  /** The link's claim, proved against its row: the tenant, record and principal it may act as, or why not. */
  async function linkClaim(url: URL): Promise<Refused | { readonly claim: Claim }> {
    const token = url.searchParams.get('token') ?? '';
    const claim = readMailLink(linkSecret, token, now());
    if (claim === 'expired') return { refused: 410, body: EXPIRED } as const;
    if (!claim || claim.resource !== linksResource) return { refused: 404, body: NOTHING } as const;
    const row = await store.link(claim.nonce);
    if (!row || row.tenantId !== claim.tenant || row.resource !== claim.resource || row.keyJson !== mailLinkKey(claim.key))
      return { refused: 404, body: NOTHING } as const;
    if (row.revokedAt !== null || row.expiresAt <= now()) return { refused: 410, body: EXPIRED } as const;
    return { claim } as const;
  }

  /** A command a link runs, its refusal folded so a hidden record and a missing one look alike. */
  async function linkRun(
    claim: Claim,
    command: JobCommandReference,
    input: Record<string, unknown>,
  ): Promise<Refused | { readonly done: Awaited<ReturnType<typeof run>> }> {
    try {
      return { done: await run('links', claim.tenant, command, input, `mail-link-${randomBytes(16).toString('hex')}`, claim.key) } as const;
    } catch (error) {
      // A tenant no longer active, or a record its service cannot see: the link opens nothing, whichever it was.
      if (error instanceof NoTenant) return { refused: 404, body: NOTHING } as const;
      const failure = refusal(error);
      return failure.status === 403 || failure.body.code === 'not_found'
        ? ({ refused: 404, body: NOTHING } as const)
        : ({ refused: failure.status, body: failure.body as Record<string, unknown> } as const);
    }
  }

  async function openLink(
    req: IncomingMessage,
    url: URL,
    res: ServerResponse,
    after?: { sent?: boolean; problem?: string },
  ): Promise<void> {
    const proved = await linkClaim(url);
    if ('refused' in proved) return linkAnswer(req, res, proved.refused, proved.body, { problem: String(proved.body.error) });
    const { claim } = proved;
    const opened = await linkRun(claim, declared.links!.command, {});
    if ('refused' in opened)
      return linkAnswer(req, res, opened.refused, opened.body, {
        tenant: claim.tenant,
        problem: String(opened.body.error ?? 'This link cannot open now.'),
      });
    const view = opened.done.result;
    return linkAnswer(
      req,
      res,
      after?.problem ? 422 : 200,
      { resource: claim.resource, key: claim.key, view, ...(declared.links!.reply ? { reply: true } : {}) },
      {
        tenant: claim.tenant,
        view,
        ...(declared.links!.reply ? { reply: true } : {}),
        ...(after?.sent ? { sent: true } : {}),
        ...(after?.problem ? { replyProblem: after.problem } : {}),
      },
    );
  }

  /* The reply box: a form post of `body` to the link's own address, run as the link's principal on its record. */
  async function replyLink(req: IncomingMessage, url: URL, res: ServerResponse): Promise<void> {
    const raw = await readBody(req, 64 * 1024);
    if (raw === null) return status(res, 413);
    const type = String(req.headers['content-type'] ?? '')
      .split(';')[0]
      .trim()
      .toLowerCase();
    const words =
      type === 'application/json'
        ? (() => {
            try {
              const parsed = JSON.parse(raw.toString('utf8')) as unknown;
              return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).body : undefined;
            } catch {
              return undefined;
            }
          })()
        : type === 'application/x-www-form-urlencoded'
          ? new URLSearchParams(raw.toString('utf8')).get('body')
          : undefined;
    const body = typeof words === 'string' ? words.replace(/\r\n/g, '\n').trim() : '';
    const proved = await linkClaim(url);
    if ('refused' in proved) return linkAnswer(req, res, proved.refused, proved.body, { problem: String(proved.body.error) });
    if (!body) return openLink(req, url, res, { problem: 'Write a reply first.' });
    const answered = await linkRun(proved.claim, declared.links!.reply!, { body });
    if ('refused' in answered) {
      if (answered.refused === 404) return linkAnswer(req, res, 404, answered.body, { problem: String(answered.body.error) });
      return /\bapplication\/json\b/.test(String(req.headers.accept ?? ''))
        ? json(res, answered.refused, answered.body)
        : openLink(req, url, res, { problem: String(answered.body.error ?? 'The reply could not be sent.') });
    }
    if (/\bapplication\/json\b/.test(String(req.headers.accept ?? ''))) return json(res, 200, { sent: true });
    // Post, then get: a reload does not send the reply twice. The address keeps its token, on this origin only.
    const back = new URLSearchParams(url.searchParams);
    back.set('sent', '1');
    return status(res, 303, { location: `${url.pathname.split('/').pop()}?${back.toString()}`, 'referrer-policy': 'no-referrer' });
  }

  /* ---------- out ---------- */

  /** A held message as it is sent: checked, its sender the tenant's own domain or the service's, its link signed. */
  async function outbound(given: unknown, tenant: string): Promise<{ id: string; mail: OutboundMail; envelope: string }> {
    const fail = (why: string): never => {
      throw new EmailFailure(`The message is not one this server sends: ${why}`, true);
    };
    if (!given || typeof given !== 'object' || Array.isArray(given)) fail('it is not an object.');
    const m = given as Record<string, unknown>;
    if (typeof m.id !== 'string' || !m.id || m.id.length > 200) fail('its id is not text.');
    const to = toList(m.to),
      cc = toList(m.cc);
    if (!to?.length || to.length > 50 || !to.every(isAddress)) fail('"to" is not one to fifty addresses.');
    if (!cc || cc.length > 50 || !cc.every(isAddress)) fail('"cc" is not a list of addresses.');
    const from = typeof m.from === 'string' ? addressOf(m.from) : undefined;
    if (!from) fail('"from" is not one address.');
    if (m.replyTo !== undefined && (typeof m.replyTo !== 'string' || !isAddress(m.replyTo))) fail('"replyTo" is not one address.');
    if (typeof m.subject !== 'string' || m.subject.length > 998) fail('"subject" is not text.');
    if (typeof m.text !== 'string' || m.text.length > 1_000_000) fail('"text" is not text.');
    if (m.html !== undefined && (typeof m.html !== 'string' || m.html.length > 2_000_000)) fail('"html" is not text.');
    for (const name of ['messageId', 'inReplyTo'] as const)
      if (m[name] !== undefined && (typeof m[name] !== 'string' || !isMessageId(m[name] as string))) fail(`"${name}" is not a Message-ID.`);
    const references = toList(typeof m.references === 'string' ? m.references.split(/\s+/).join(',') : m.references);
    if (!references || references.length > 100 || !references.every(isMessageId)) fail('"references" is not a list of Message-IDs.');
    const domain = from!.address.split('@')[1].toLowerCase();
    /* Only a domain the service gives this tenant is sent as itself; the rest from the service's own address. */
    const sendsAs = service.domains?.[domain] === tenant;
    const sentFromAddress = sendsAs
      ? from!
      : { address: platform.address, ...(from!.name || platform.name ? { name: from!.name ?? platform.name } : {}) };
    const messageId =
      (m.messageId as string | undefined) ?? `<${randomBytes(12).toString('hex')}@${sentFromAddress.address.split('@')[1]}>`;
    let text = m.text as string,
      html = m.html as string | undefined;
    if (m.link !== undefined) {
      if (!declared.links || !linksResource) fail('it names a link, and the jobs module declares no links.');
      const key = m.link as Record<string, unknown>;
      if (!key || typeof key !== 'object' || Array.isArray(key) || !Object.keys(key).length) fail('"link" is not a record key.');
      if (!Object.values(key).every((part) => typeof part === 'string' || Number.isSafeInteger(part))) fail('"link" is not a record key.');
      const issued = issueMailLink(linkSecret, {
        tenant,
        resource: linksResource!,
        key: key as Record<string, string | number>,
        expires: now() + linkTtl,
      });
      await store.issueLink({
        nonce: issued.claim.nonce,
        tenantId: tenant,
        resource: linksResource!,
        keyJson: mailLinkKey(issued.claim.key),
        createdAt: now(),
        expiresAt: issued.claim.expires,
      });
      const address = `${options.baseURL.replace(/\/+$/, '')}${MAIL_LINK_PATH}?token=${issued.token}`;
      text = text.split('{link}').join(address);
      if (html) html = html.split('{link}').join(address.replace(/&/g, '&amp;'));
    }
    /* The tenant's own name, logo and accent, where the App's message asks for them; validated values only. */
    if (options.branding && (text.includes('{brand.') || html?.includes('{brand.'))) {
      const brand = await options.branding.mail(tenant);
      text = fillMailBrand(text, brand, options.baseURL, false);
      if (html) html = fillMailBrand(html, brand, options.baseURL, true);
    }
    return {
      id: m.id as string,
      envelope: service.returnPath ? `bounce+${tenant}@${service.returnPath}` : platform.address,
      mail: {
        from: sentFromAddress,
        ...(sendsAs
          ? m.replyTo
            ? { replyTo: m.replyTo as string }
            : {}
          : { replyTo: (m.replyTo as string | undefined) ?? from!.address }),
        to: to!,
        ...(cc!.length ? { cc } : {}),
        subject: m.subject as string,
        text,
        ...(html ? { html } : {}),
        messageId,
        ...(m.inReplyTo ? { inReplyTo: m.inReplyTo as string } : {}),
        ...(references!.length ? { references } : {}),
      },
    };
  }

  async function sendTenant(tenant: string, tally: { sent: number; failed: number }): Promise<void> {
    const send = declared.send!;
    const claimed = await run('send', tenant, send.claim, {}, `mail-claim-${randomBytes(16).toString('hex')}`);
    const messages = (claimed.result as { messages?: unknown } | null)?.messages;
    if (!Array.isArray(messages)) {
      if (messages !== undefined) warn(`mail send.claim "${send.claim.id}" answered something other than { messages: [...] }.`);
      return;
    }
    for (const given of messages.slice(0, BATCH)) {
      const id = typeof (given as { id?: unknown })?.id === 'string' ? (given as { id: string }).id : undefined;
      if (!id) {
        warn(`mail send.claim "${send.claim.id}" returned a message without an id; it is not sent.`);
        continue;
      }
      let result: { status: 'sent' | 'bounced' | 'failed'; messageId?: string; error?: string };
      try {
        const made = await outbound(given, tenant);
        result = { status: 'sent', messageId: made.mail.messageId };
        try {
          await sender!.send(made.mail, made.envelope);
          sentFrom.add(made.mail.from.address.toLowerCase());
          if (sentFrom.size > 1000) sentFrom.delete(sentFrom.values().next().value!);
          tally.sent += 1;
        } catch (error) {
          const permanent = error instanceof EmailFailure && error.permanent;
          result = { status: permanent ? 'bounced' : 'failed', messageId: made.mail.messageId, error: (error as Error).message };
          tally.failed += 1;
        }
      } catch (error) {
        result = { status: 'failed', error: error instanceof EmailFailure ? error.message : 'The message could not be read.' };
        tally.failed += 1;
      }
      const key = createHash('sha256')
        .update(`${tenant}\n${id}\n${result.messageId ?? ''}\n${result.status}`)
        .digest('hex');
      try {
        await run('send', tenant, send.record, { id, ...result }, `mail-record-${key}`);
      } catch (error) {
        warn(`mail send.record "${send.record.id}" refused what became of message "${id}": ${refusal(error).body.code}.`);
      }
    }
  }

  async function sendOnce(): Promise<{ sent: number; failed: number }> {
    const tally = { sent: 0, failed: 0 };
    if (!declared.send) return tally;
    for (const tenant of await runtime.tenants()) {
      try {
        await sendTenant(tenant, tally);
      } catch (error) {
        warn(`mail for a tenant was not sent this time: ${error instanceof NoTenant ? 'it is not active' : refusal(error).body.code}.`);
      }
    }
    return tally;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<unknown> | undefined;
  let stopping = false;
  const schedule = () => {
    if (stopping || !declared.send) return;
    timer = setTimeout(() => {
      timer = undefined;
      active = sendOnce()
        .catch((error) => warn(`the mail send loop: ${(error as Error).message}`))
        .finally(() => {
          active = undefined;
          schedule();
        });
    }, declared.send.everyMs);
    timer.unref?.();
  };

  return Object.freeze({
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (url.pathname === MAIL_INBOUND_PATH && declared.receive) {
        if (req.method !== 'POST') {
          status(res, 405, { allow: 'POST' });
          return true;
        }
        await inSpan('mail inbound', {}, async (span) => {
          await receive(req, res, (value) => span.setAttributes({ 'mistri.mail.outcome': value }));
        });
        return true;
      }
      if (url.pathname === MAIL_LINK_PATH && declared.links) {
        if (req.method === 'POST' && declared.links.reply) await replyLink(req, url, res);
        else if (req.method !== 'GET' && req.method !== 'HEAD') status(res, 405, { allow: declared.links.reply ? 'GET, POST' : 'GET' });
        else await openLink(req, url, res, url.searchParams.get('sent') === '1' ? { sent: true } : undefined);
        return true;
      }
      return false;
    },
    sendOnce,
    start() {
      if (!timer && !stopping) schedule();
    },
    async stop() {
      stopping = true;
      if (timer) clearTimeout(timer);
      await active;
      await store.close();
    },
  });
}
