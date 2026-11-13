/**
 * Verified inbound endpoints: the one place an outside system calls back into
 * an App. `POST {mount}/api/inbound/{name}` — and `…/{name}/{tenant}` on a
 * tenant App, where each tenant gives its sender its own address and secret.
 *
 * Two declarations compile to the endpoint this host serves, and nothing
 * else answers a signed callback: a `defineInbound` in a `--jobs` module
 * (`inboundEndpoint` below), and an integration's webhooks
 * (`defineIntegration({ webhooks })`, lowered by
 * integrations/integrationInbound.ts). So the size limit, the signature and
 * its time, the replay window, who a delivery runs as and what the answer
 * says are one implementation, held once.
 *
 * In order, and answered by status alone, never a body a sender could read:
 *  - 404 for an address that names no endpoint, a tenant that is not active
 *    and a tenant that has not set the endpoint's secrets — all alike, so an
 *    address says nothing about who is set up; 405 for anything but POST;
 *    413 past 256 KB (an endpoint that takes files: past its file cap, in
 *    base64, more), the rest unread.
 *  - An endpoint that takes more than 256 KB is not buffered for anyone who
 *    asks: a Content-Length past its cap is 413, and headers that could not
 *    be a fresh signature (no signed time inside the window, no digest of the
 *    algorithm's length) are 401, both before a byte of the body is read; and
 *    at most INBOUND_LARGE_MOST such bodies are read at once, host-wide, the
 *    next told 503 and when to retry. Each closes its connection.
 *  - 401 unless the raw bytes verify under the secret (constant time on the
 *    digest) and the time the sender signed is inside the endpoint's window,
 *    on either side of now. A delivery signed for one tenant does not verify
 *    at another's address.
 *  - 400 for a body the endpoint cannot read: not its JSON, no sender's id,
 *    a file that is not base64 or not one its file resource takes; 413 for a
 *    file past that resource's cap.
 *  - The same delivery again (its sender's id and signed time, while the
 *    window is open) is a replay, and answers what the first one did: its
 *    command's receipt replays (204, nothing written twice), and a delivery
 *    that ran nothing answers its status again without recording twice. Not
 *    409: a provider that resends identical bytes after a timeout (some sign
 *    the body alone, with no time) reads 409 as a failed delivery and retries
 *    and alerts. A sender's own retry signs a new time and replays the same
 *    receipt. A first answer that told the sender to retry (5xx, 429) lets the
 *    delivery go, so the same bytes are a retry, not a replay.
 *  - 202 for a delivery that runs nothing (an integration's event the App
 *    does not map); otherwise the command runs as the endpoint's service
 *    principal, the sender's id as its receipt's idempotency key: 204 applied
 *    or replayed, 400 an input it refuses, the command's own status (and its
 *    Retry-After) for anything else.
 *
 * One span a delivery records the endpoint and how it came out, never the
 * body. The Host is checked before this host is asked (http/server.ts,
 * tenantAuthenticatedHttp.ts), as for every route under `/api/inbound/`.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { inSpan } from '@mistriwork/engine/adapters/telemetry/trace.js';
import { readBounded } from '@mistriwork/engine/server/http/reply.js';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { businessCommandHttpError } from '../commands/businessCommandHttp.js';
import { executeBusinessCommand, isBusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { FILE_MAX_BYTES_DEFAULT } from '../../shared/appModel.js';
import type { AppDef, AppFileRule } from '../../shared/app.js';
import type { CommandFile } from '../commands/businessCommands.js';
import { receivedFiles } from '../http/fileRows.js';
import { serviceActor } from './jobAuthorization.js';
import type { JobCommandBinding } from './jobCommands.js';
import type { CapturedHmac, CapturedInbound, CapturedJobModule, JobCommandReference } from './jobModule.js';

/** The most a delivery may weigh. A provider's callback is small; anything past this is not one. */
const INBOUND_MAX_BYTES = 256 * 1024;
/** The most files one delivery carries: a `field.files`' own most. */
const INBOUND_FILES_MOST = 20;
/** The most deliveries past INBOUND_MAX_BYTES read at once, host-wide: what an unverified sender can make it hold. */
const INBOUND_LARGE_MOST = 4;
const INBOUND_PREFIX = '/api/inbound/';
/** An endpoint's name, as its address carries it: a defineInbound name or an integration's. */
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const TENANT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export interface InboundHost {
  /** True when the request was this host's to answer (anything under `/api/inbound/`). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
}

/** What a delivery runs once it is known to be fresh and new. */
export interface InboundPlan {
  /** Kept before the command runs, in the delivery's tenant: an integration's opt-out or opt-in. */
  readonly record?: (tenant: string, now: number) => Promise<void>;
  /** The command, as whom, with what. Absent: nothing runs, and `status` says so. */
  readonly run?: Readonly<{
    command: JobCommandReference;
    runAs: string;
    input: unknown;
    target?: Readonly<Record<string, string | number>>;
    /** Files the delivery carried, checked: the handler's `ctx.files`, never its input or its receipt. */
    files?: readonly CommandFile[];
  }>;
  /** Without a command: 202 for a delivery nothing reads, 204 for one that was recorded. */
  readonly status?: 202 | 204;
}

/** A body the endpoint read: the sender's id for the delivery (what a retry repeats) and what it runs. */
export interface InboundReading {
  readonly key: string;
  /** Throws for a body whose input or target the endpoint cannot read (400). */
  plan(): InboundPlan;
}

/** An endpoint as this host serves it: what a defineInbound and an integration's webhooks both compile to. */
export interface InboundEndpoint {
  /** Its address under `/api/inbound/`, its span's and its requests' name. */
  readonly name: string;
  /** How far the signed time may be from now, either side. */
  readonly windowMs: number;
  /** The most a delivery may weigh, when it is not 256 KiB: an endpoint that takes files. */
  readonly maxBytes?: number;
  /**
   * Whether the headers alone could be a fresh signed delivery: asked before an endpoint past 256 KiB reads its
   * body, so a sender with no signature is not buffered. Not the verification, which still reads the body.
   */
  signed?(headers: IncomingMessage['headers'], now: number): boolean;
  /** The secrets it verifies with, for one tenant ('' without tenants); undefined while that tenant has not set them. */
  secrets(tenant: string): Promise<Readonly<Record<string, string>> | undefined>;
  /** The time the sender signed (ms), and what was signed, or undefined for a delivery that does not verify. */
  verify(
    delivery: Readonly<{ headers: IncomingMessage['headers']; body: Buffer }>,
    secrets: Readonly<Record<string, string>>,
    now: number,
  ): Readonly<{ at: number; payload: unknown }> | undefined;
  /** The verified payload, read. Throws for one it cannot read (400). */
  read(payload: unknown): InboundReading;
  /** The command receipts' namespace, per tenant: a sender's id is its own only within one endpoint and tenant. */
  receipts(tenant: string): string;
}

/** Where a delivery is remembered while its window is open: the integrations store's `seen`. */
interface InboundDeliveries {
  firstSeen(app: string, key: string, at: number, expiresAt: number): Promise<boolean>;
  forgetSeen(app: string, key: string): Promise<void>;
}

/** A tenant the host cannot act for: not one, or not active. Thrown by `bind`; answered 404. */
export class InboundNoTenant extends Error {}

/** The environment variables an endpoint names that hold nothing: each is a startup refusal at serve, a warning at check. */
export function inboundSecretProblems(module: CapturedJobModule, environment: NodeJS.ProcessEnv): string[] {
  return [...module.inbound.values()]
    .filter((endpoint) => !environment[endpoint.verify.secretEnv])
    .map(
      (endpoint) =>
        `inbound endpoint "${endpoint.name}" verifies with the secret in ${endpoint.verify.secretEnv}, and that environment variable is not set.`,
    );
}

/** The text a delivery signs, as the verifier says: its time and the raw body as sent. */
function signedBytes(verify: CapturedHmac, timestamp: string, body: Buffer): Buffer {
  return Buffer.concat(
    verify.signed.map((part) =>
      typeof part === 'string' ? Buffer.from(part, 'utf8') : part.part === 'body' ? body : Buffer.from(timestamp, 'utf8'),
    ),
  );
}

const one = (value: string | string[] | undefined): string | undefined => (typeof value === 'string' ? value : undefined);

/**
 * The time a delivery was signed at, in milliseconds, when its digest is what
 * its sender signed; undefined otherwise. Constant-time on the digest; a
 * missing or malformed header is the same refusal as a wrong one.
 */
function signedAt(verify: CapturedHmac, headers: IncomingMessage['headers'], body: Buffer, secret: string): number | undefined {
  if (!secret) return undefined;
  const claimed = claimedSignature(verify, headers);
  if (!claimed) return undefined;
  const expected = createHmac(verify.algorithm, secret)
    .update(signedBytes(verify, claimed.timestamp, body))
    .digest();
  return claimed.given.length === expected.length && timingSafeEqual(claimed.given, expected) ? claimed.at : undefined;
}

/** What the headers say was signed, and when, as read before any digest is checked; undefined for a malformed one. */
function claimedSignature(
  verify: CapturedHmac,
  headers: IncomingMessage['headers'],
): Readonly<{ timestamp: string; at: number; given: Buffer }> | undefined {
  // A signed time is required (hmac in jobModule.ts): a delivery without one is refused like a wrong signature.
  const timestamp = one(headers[verify.timestampHeader]) ?? '';
  if (!/^\d{1,16}$/.test(timestamp)) return undefined;
  // Seconds, or milliseconds: told apart by size, as no one's clock is in 1973 or 5138.
  const at = Number(timestamp) < 100_000_000_000 ? Number(timestamp) * 1000 : Number(timestamp);
  const header = one(headers[verify.signatureHeader]);
  if (header === undefined || !header.startsWith(verify.prefix)) return undefined;
  const digest = header.slice(verify.prefix.length);
  if (verify.encoding === 'hex' ? !/^(?:[0-9a-fA-F]{2})+$/.test(digest) : !/^[A-Za-z0-9+/]+={0,2}$/.test(digest)) return undefined;
  return { timestamp, at, given: Buffer.from(digest, verify.encoding) };
}

/** Whether a delivery is what its sender signed, and fresh: the verifier a tenant's mail webhook shares. */
export function verifyDelivery(
  verify: CapturedHmac,
  headers: IncomingMessage['headers'],
  body: Buffer,
  secret: string,
  now: number,
): boolean {
  const at = signedAt(verify, headers, body, secret);
  return at !== undefined && Math.abs(now - at) <= verify.windowMs;
}

/** The command's receipt key: the sender's id, namespaced by endpoint, in the shape a receipt takes. */
export const inboundCommandKey = (name: string, key: string): string =>
  `inbound-${createHash('sha256').update(`${name}\n${key}`).digest('hex')}`;

/** The delivery's id: text, or a whole number, of a sane length. */
function deliveryKey(value: unknown): string | undefined {
  const text = typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : value;
  return typeof text === 'string' && text.length > 0 && text.length <= 512 ? text : undefined;
}

function plainKey(value: unknown): Readonly<Record<string, string | number>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (!entries.length || entries.length > 16) return undefined;
  for (const [column, part] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(column) ||
      !(typeof part === 'string' ? part.length > 0 && part.length <= 1024 : Number.isSafeInteger(part))
    )
      return undefined;
  }
  return Object.freeze(Object.fromEntries(entries)) as Readonly<Record<string, string | number>>;
}

class Unreadable extends Error {}
const unreadable = (): never => {
  throw new Unreadable();
};

/** A delivery's file its resource does not take: 413 past the resource's cap, 400 for anything else. */
class FileRefused extends Error {
  constructor(readonly status: number) {
    super('A delivery carried a file its endpoint does not take.');
  }
}

/** The rule an endpoint's `files` are checked by: the App's file resource, at its own cap. Undefined for none. */
export function inboundFileRule(app: AppDef, endpoint: CapturedInbound): AppFileRule | undefined {
  const resource = endpoint.files;
  const file = resource === undefined ? undefined : app.resources?.[resource]?.file;
  return file && Object.freeze({ ...file, table: resource!, resource: resource!, maxBytes: file.maxBytes ?? FILE_MAX_BYTES_DEFAULT });
}

/**
 * A `defineInbound` declaration, compiled: an hmac over the raw bytes with
 * the secret in the environment variable it names, a JSON object body, and
 * its one command run as its principal. `files` is the rule of the file
 * resource its `files` names, as the App declares it (the host resolves it):
 * the body's `files` are checked against it and taken out of what the
 * declaration's functions read, so no file's bytes reach the input.
 */
export function inboundEndpoint(endpoint: CapturedInbound, environment: NodeJS.ProcessEnv, files?: AppFileRule): InboundEndpoint {
  const { verify } = endpoint;
  if (endpoint.files !== undefined && !files)
    throw new Error(`inbound endpoint "${endpoint.name}" takes files into "${endpoint.files}", which is not a file resource.`);
  return Object.freeze({
    name: endpoint.name,
    windowMs: verify.windowMs,
    /* One file at the resource's cap, in base64 (4 bytes for every 3), beside the usual delivery: the cap is the
       whole body's, so twenty files share it. Raised only here; every other endpoint stays at 256 KiB. */
    ...(files ? { maxBytes: Math.ceil(files.maxBytes / 3) * 4 + INBOUND_MAX_BYTES } : {}),
    signed(headers: IncomingMessage['headers'], now: number) {
      const claimed = claimedSignature(verify, headers);
      return (
        claimed !== undefined &&
        Math.abs(now - claimed.at) <= verify.windowMs &&
        claimed.given.length === createHash(verify.algorithm).digest().length
      );
    },
    // A secret nobody set verifies nothing (401); serve refuses to start on one.
    secrets: async () => Object.freeze({ secret: environment[verify.secretEnv] ?? '' }),
    verify(delivery: Readonly<{ headers: IncomingMessage['headers']; body: Buffer }>, secrets: Readonly<Record<string, string>>) {
      const at = signedAt(verify, delivery.headers, delivery.body, secrets.secret ?? '');
      return at === undefined ? undefined : Object.freeze({ at, payload: delivery.body });
    },
    read(payload: unknown): InboundReading {
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(payload as Buffer));
      } catch {
        return unreadable();
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unreadable();
      let body = parsed as Record<string, unknown>;
      let parts: unknown = [];
      if (files && Object.hasOwn(body, 'files')) ({ files: parts, ...body } = body);
      const key = deliveryKey(endpoint.key(body)) ?? unreadable();
      return Object.freeze({
        key,
        plan(): InboundPlan {
          const read = endpoint.input(body);
          const target = endpoint.target ? (plainKey(endpoint.target(body)) ?? unreadable()) : undefined;
          // Plain JSON, as a command takes it: what does not survive the trip is not input.
          const input = read === undefined ? {} : JSON.parse(JSON.stringify(read));
          const checked = files ? receivedFiles(files, parts, INBOUND_FILES_MOST) : undefined;
          if (checked && 'status' in checked) throw new FileRefused(checked.status === 413 ? 413 : 400);
          return Object.freeze({
            run: Object.freeze({
              command: endpoint.command,
              runAs: endpoint.runAs,
              input,
              ...(target ? { target } : {}),
              ...(checked ? { files: checked.files } : {}),
            }),
          });
        },
      });
    },
    receipts: () => endpoint.name,
  });
}

const status = (res: ServerResponse, code: number, headers: Record<string, string> = {}): void => {
  if (res.headersSent) return;
  // Nothing is echoed: a status, and for a refusal the code the command's own vocabulary gives it.
  res.writeHead(code, { 'cache-control': 'no-store', 'content-length': '0', ...headers });
  res.end();
};

/**
 * The host over its endpoints. `tenants` says each address carries a tenant
 * after the endpoint's name; `bind` binds one delivery's command as its
 * principal in its tenant ('' without tenants), throwing InboundNoTenant for
 * a tenant that cannot be acted for; its leases return when the delivery ends.
 */
export function createInboundHost(
  options: Readonly<{
    endpoints: readonly InboundEndpoint[];
    appId: string;
    principals: ReadonlyMap<string, readonly string[]>;
    bind: (delivery: Readonly<{ endpoint: string; runAs: string; tenant: string }>) => Promise<JobCommandBinding>;
    deliveries: InboundDeliveries;
    tenants?: boolean;
    /** Whether a tenant is one to act for, asked before its secrets are read. */
    active?: (tenant: string) => Promise<boolean>;
    now?: () => number;
    warn?: (message: string) => void;
  }>,
): InboundHost {
  const { appId, deliveries } = options;
  const now = options.now ?? Date.now;
  const warn = options.warn ?? ((message: string) => console.error(`mistri: ${message}`));
  const endpoints = new Map<string, InboundEndpoint>();
  let largeReading = 0;
  for (const endpoint of options.endpoints) {
    if (!NAME.test(endpoint.name) || endpoints.has(endpoint.name))
      throw new Error(`Inbound endpoint "${endpoint.name}" is named twice, or not as an address segment.`);
    endpoints.set(endpoint.name, endpoint);
  }

  async function deliver(
    endpoint: InboundEndpoint,
    tenant: string,
    req: IncomingMessage,
    res: ServerResponse,
    outcome: (value: string) => void,
  ): Promise<void> {
    const cap = endpoint.maxBytes ?? INBOUND_MAX_BYTES;
    if (cap <= INBOUND_MAX_BYTES) return received(endpoint, tenant, req, res, outcome, cap);
    // A large body is held only for a sender who could have signed it: refused on its headers, unread, and the
    // connection closed rather than drained, since what is left of the body is the cost being refused.
    const close = { connection: 'close' };
    const length = Number(one(req.headers['content-length']) ?? NaN);
    if (Number.isFinite(length) && length > cap) {
      outcome('too_large');
      return status(res, 413, close);
    }
    const secrets = await present(endpoint, tenant, res, outcome, close);
    if (!secrets) return;
    if (endpoint.signed && !endpoint.signed(req.headers, now())) {
      outcome('unverified');
      return status(res, 401, close);
    }
    if (largeReading >= INBOUND_LARGE_MOST) {
      outcome('busy');
      return status(res, 503, { ...close, 'retry-after': '5' });
    }
    largeReading += 1;
    try {
      await received(endpoint, tenant, req, res, outcome, cap, secrets);
    } finally {
      largeReading -= 1;
    }
  }

  /** Whether the tenant is one to act for and has set the endpoint's secrets; answered 404 when not. */
  async function present(
    endpoint: InboundEndpoint,
    tenant: string,
    res: ServerResponse,
    outcome: (value: string) => void,
    headers: Record<string, string> = {},
  ): Promise<Readonly<Record<string, string>> | undefined> {
    if (options.active && !(await options.active(tenant).catch(() => false))) {
      outcome('no_tenant');
      status(res, 404, headers);
      return undefined;
    }
    const secrets = await endpoint.secrets(tenant);
    if (!secrets) {
      outcome('not_set');
      status(res, 404, headers);
    }
    return secrets;
  }

  async function received(
    endpoint: InboundEndpoint,
    tenant: string,
    req: IncomingMessage,
    res: ServerResponse,
    outcome: (value: string) => void,
    cap: number,
    known?: Readonly<Record<string, string>>,
  ): Promise<void> {
    const body = await readBounded(req, cap);
    if (!body) {
      outcome('too_large');
      return status(res, 413);
    }
    const secrets = known ?? (await present(endpoint, tenant, res, outcome));
    if (!secrets) return;
    const at = now();
    let verified: Readonly<{ at: number; payload: unknown }> | undefined;
    try {
      verified = endpoint.verify(Object.freeze({ headers: req.headers, body }), secrets, at);
    } catch {
      verified = undefined;
    }
    if (!verified || !Number.isFinite(verified.at) || Math.abs(at - verified.at) > endpoint.windowMs) {
      outcome('unverified');
      return status(res, 401);
    }
    let reading: InboundReading;
    try {
      reading = endpoint.read(verified.payload);
    } catch {
      outcome('unreadable');
      return status(res, 400);
    }
    // The same delivery twice, while its signed time is still inside the window, is a replay: it answers what
    // the first did. What it records (consent) is not recorded again, or an old opt-out resent after a newer
    // opt-in would undo it; what it runs replays the command's receipt, keyed by the sender's id.
    const seen = createHash('sha256')
      .update(JSON.stringify(['mistri.inbound-delivery.v1', endpoint.name, tenant, reading.key, verified.at]))
      .digest('hex');
    const fresh = await deliveries.firstSeen(appId, seen, at, verified.at + 2 * endpoint.windowMs);
    let plan: InboundPlan;
    try {
      plan = reading.plan();
    } catch (error) {
      outcome(error instanceof FileRefused && error.status === 413 ? 'too_large' : 'invalid');
      return status(res, error instanceof FileRefused ? error.status : 400);
    }
    if (fresh && plan.record) {
      // At the time the sender signed, not ours: consent is newest-wins, so an old event resent late changes nothing.
      // A write that fails lets the delivery go, or the sender's retry would be taken for a replay and never kept.
      try {
        await plan.record(tenant, verified.at);
      } catch {
        await deliveries.forgetSeen(appId, seen).catch(() => {});
        outcome('unavailable');
        warn(`inbound endpoint "${endpoint.name}" could not record its delivery; the sender will retry.`);
        return status(res, 503);
      }
    }
    const run = plan.run;
    if (!run) {
      outcome(!fresh ? 'replayed' : plan.status === 204 ? 'recorded' : 'unmapped');
      return status(res, plan.status ?? 202);
    }
    const actor = serviceActor(appId, run.runAs, options.principals.get(run.runAs) ?? []);
    let bound: JobCommandBinding | undefined;
    try {
      await asBackgroundWork(async () => {
        bound = await options.bind(Object.freeze({ endpoint: endpoint.name, runAs: run.runAs, tenant }));
        bound.binding.authorize(run.command.id, actor);
        const captureFlags = bound.captureFlags;
        const flags = await commandFlagsOnce(() => captureFlags?.(actor))();
        await executeBusinessCommand(
          bound.binding,
          actor,
          {
            command: run.command.id,
            commandVersion: run.command.version,
            key: run.target ?? {},
            expectedVersion: 0,
            idempotencyKey: inboundCommandKey(endpoint.receipts(tenant), reading.key),
            input: run.input,
          },
          {
            door: 'api',
            flags,
            requestId: `inbound:${endpoint.name}`,
            now: () => new Date(now()),
            ...(run.files ? { files: run.files } : {}),
          },
        );
      });
      outcome(fresh ? 'applied' : 'replayed');
      return status(res, 204);
    } catch (error) {
      if (error instanceof InboundNoTenant) {
        outcome('no_tenant');
        return status(res, 404);
      }
      const failure = businessCommandHttpError(
        error instanceof AppAccessDenied || isBusinessCommandExecutionError(error) ? error : new Error(),
      );
      outcome(failure.body.code);
      if (failure.status >= 500 || failure.status === 429) {
        // Told to retry: the same bytes again are the retry, not a replay.
        await deliveries.forgetSeen(appId, seen).catch(() => {});
        if (failure.status >= 500)
          warn(`inbound endpoint "${endpoint.name}" could not run command "${run.command.id}"; the sender will retry.`);
      }
      return status(res, failure.status, failure.retryAfter === undefined ? {} : { 'retry-after': String(failure.retryAfter) });
    } finally {
      (bound as JobCommandBinding | undefined)?.release();
    }
  }

  return Object.freeze({
    async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith(INBOUND_PREFIX)) return false;
      const [name = '', tenant, ...rest] = url.pathname.slice(INBOUND_PREFIX.length).split('/');
      const endpoint = endpoints.get(name);
      const addressed = options.tenants ? tenant !== undefined && TENANT.test(tenant) && !rest.length : tenant === undefined;
      if (!endpoint || !addressed) {
        status(res, 404);
        return true;
      }
      if (req.method !== 'POST') {
        status(res, 405, { allow: 'POST' });
        return true;
      }
      await inSpan(`inbound ${endpoint.name}`, { attributes: { 'mistri.inbound.name': endpoint.name } }, async (span) => {
        await deliver(endpoint, tenant ?? '', req, res, (value) => span.setAttributes({ 'mistri.inbound.outcome': value }));
      });
      return true;
    },
  });
}
