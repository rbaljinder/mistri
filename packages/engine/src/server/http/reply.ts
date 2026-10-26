/**
 * How a reply leaves: JSON with a status, a bounded body read, and the error
 * that already knows its status. Nothing here knows what a request means.
 */
import { currentSpan } from '../../adapters/telemetry/trace.js';
import { FILE_MAX_BYTES_CEILING } from '../../shared/fileBounds.js';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { brotliCompress, brotliCompressSync, constants as zlib, gzip, gzipSync } from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ResourceReadError } from '../resourceReadOperations.js';
import type { ResourceHttpPath, ResourceHttpReply } from '../../shared/resourceHttp.js';
import { ROW_LOCKED_MESSAGE, ROW_LOCKED_RETRY_AFTER_SECONDS } from '../../adapters/writeLanes.js';
import { POOL_BUSY_MESSAGE, POOL_BUSY_RETRY_AFTER_SECONDS } from '../../adapters/poolMetrics.js';

// Policy callbacks may catch an operation failure, but the context still owns
// its outcome. Do not publish a partial success before that context settles.
export const policyResponses = new WeakMap<ServerResponse, { reply?: () => void }>();

export function sendResource<Path extends ResourceHttpPath>(
  res: ServerResponse,
  _route: Path,
  status: number,
  body: ResourceHttpReply<NoInfer<Path>>,
): void {
  send(res, status, body);
}

/**
 * A write that waited out another transaction's lock (writeLanes.ts,
 * `--lock-timeout`): its statement failed and its transaction rolled back,
 * so nothing landed, and the same request will very likely go through in a
 * moment. 503 with Retry-After, which is what an HTTP client retries; the
 * body is a write refusal's, with its own code. `extra` is the route's own
 * fields (`deleted: false`).
 */
export function sendRowLocked(res: ServerResponse, extra: Record<string, unknown> = {}): void {
  currentSpan()?.event('lock timeout', { 'mistri.write.refusal': 'row_locked' });
  if (!res.headersSent) res.setHeader('retry-after', String(ROW_LOCKED_RETRY_AFTER_SECONDS));
  send(res, 503, {
    ...extra,
    error: ROW_LOCKED_MESSAGE,
    code: 'row_locked',
    errors: [{ code: 'row_locked', message: ROW_LOCKED_MESSAGE }],
    outcome: 'not_applied',
  });
}

/**
 * A request the pool refused (poolMetrics.ts, PoolBusy): every connection was
 * in use and the queue behind them was too long or had waited too long.
 * Nothing was leased, so nothing ran: 503 with Retry-After, which is what an
 * HTTP client retries, and for a write `outcome: 'not_applied'`, since it
 * never began and the same request may be sent again. `extra` is the route's
 * own fields (`deleted: false`); `write` is for a route that writes.
 */
export function sendBusy(res: ServerResponse, extra: Record<string, unknown> = {}, write = false): void {
  currentSpan()?.event('pool busy', { 'mistri.refusal': 'server_busy' });
  if (!res.headersSent) res.setHeader('retry-after', String(POOL_BUSY_RETRY_AFTER_SECONDS));
  send(res, 503, {
    ...extra,
    error: POOL_BUSY_MESSAGE,
    code: 'server_busy',
    ...(write ? { errors: [{ code: 'server_busy', message: POOL_BUSY_MESSAGE }], outcome: 'not_applied' } : {}),
  });
}

/**
 * Where a failure's trace can be read, while something serves traces (the App
 * framework's dev observer, observe/mount.ts, sets it when it runs): a refusal
 * then says where, beside its own words. None otherwise, which is every
 * production start and every database browser start.
 */
let traceLink: ((traceId: string | undefined, req: IncomingMessage) => string | undefined) | undefined;

/** Set (or, with none, clear) where a failure's trace is read. */
export function linkTraces(link: typeof traceLink): void {
  traceLink = link;
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  const deferred = policyResponses.get(res);
  if (deferred) {
    deferred.reply = () => send(res, status, body);
    return;
  }
  if (res.destroyed || res.writableEnded) return;
  /* While the dev observer runs, a failure says where its trace is: the
     "Open in observer" link beside the refusal (observe/mount.ts). */
  const observe =
    traceLink && status >= 400 && body && typeof body === 'object' && !Array.isArray(body)
      ? traceLink(currentSpan()?.traceId, res.req)
      : undefined;
  writeJson(res, status, Buffer.from(JSON.stringify(observe ? { ...(body as object), observe } : body)));
}

/**
 * A GET whose answer changes only when the catalog, the App or the principal
 * does — the schema, the App, its pages, the runtime — sent with a strong
 * ETag so a browser that has it asks again with If-None-Match and is told
 * 304 instead of being sent the same bytes: 349 KB of schema on a wide
 * catalog, on every load.
 *
 * The answer is still computed, authorized and compared on every request —
 * `no-cache` means the browser may keep it but never use it unasked — so a
 * revoked grant or a reload is seen at once. The tag is a digest of the body
 * together with `principal`, so one person's copy never validates for
 * another even where the bytes agree, and `private` with `Vary: Cookie`
 * keeps it out of any shared cache. A reply the request already marked
 * `no-store` — every row-policy and tenant reply (handler.ts) — keeps that:
 * it gets no tag and is not stored at all.
 */
export function sendRevalidated(res: ServerResponse, body: unknown, principal: string): void {
  const deferred = policyResponses.get(res);
  if (deferred) {
    deferred.reply = () => sendRevalidated(res, body, principal);
    return;
  }
  if (res.destroyed || res.writableEnded) return;
  const json = Buffer.from(JSON.stringify(body));
  if (String(res.getHeader('cache-control') ?? '').includes('no-store')) {
    writeJson(res, 200, json);
    return;
  }
  const tag = `"${createHash('sha256').update(principal).update('\0').update(json).digest('base64url').slice(0, 32)}"`;
  const headers = { 'cache-control': 'private, no-cache', etag: tag };
  addVary(res, 'Cookie');
  const asked = res.req?.headers['if-none-match'];
  if (typeof asked === 'string' && asked.split(',').some((one) => one.trim().replace(/^W\//, '') === tag)) {
    addVary(res, 'Accept-Encoding');
    res.writeHead(304, headers);
    res.end();
    return;
  }
  writeJson(res, 200, json, headers, tag);
}

/** JSON this size or larger is compressed when the request accepts it. Below
 * it the header costs more than the saving. */
const COMPRESS_FROM = 1024;
/** Past this a body is compressed off the event loop: brotli at quality 4 is
 * about 4 ms for a wide schema's 349 KB, and a 100,000-row read is far more. */
const COMPRESS_INLINE_BELOW = 256 * 1024;
/** Compressed metadata, by tag and encoding: a revisit that is not a 304 (a
 * new tab, a cleared cache) is sent the bytes compressed the first time. */
const compressed = new Map<string, Buffer>();
const COMPRESSED_KEPT = 64;

/**
 * Brotli at quality 4 or gzip at level 6, whichever the request accepts
 * first by preference: 7–70 times fewer bytes than the JSON they carry,
 * for a few milliseconds. Static assets are precompressed at build time
 * (clientHttp.ts); a reply is compressed as it is sent.
 */
export function acceptedEncoding(res: ServerResponse): 'br' | 'gzip' | undefined {
  const accepted = String(res.req?.headers['accept-encoding'] ?? '').toLowerCase();
  const allows = (name: string) =>
    accepted.split(',').some((part) => {
      const [token, ...params] = part.trim().split(';');
      if (token.trim() !== name) return false;
      const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
      return !q || Number(q.slice(2)) > 0;
    });
  return allows('br') ? 'br' : allows('gzip') ? 'gzip' : undefined;
}

function addVary(res: ServerResponse, name: string): void {
  const current = String(res.getHeader('vary') ?? '');
  const names = current
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (!names.some((part) => part.toLowerCase() === name.toLowerCase())) res.setHeader('vary', [...names, name].join(', '));
}

function writeJson(res: ServerResponse, status: number, json: Buffer, extra: OutgoingHttpHeaders = {}, tag?: string): void {
  const headers: OutgoingHttpHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    ...extra,
  };
  const encoding = json.length >= COMPRESS_FROM ? acceptedEncoding(res) : undefined;
  if (json.length >= COMPRESS_FROM) addVary(res, 'Accept-Encoding');
  const finish = (bytes: Buffer, applied?: 'br' | 'gzip') => {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(status, { ...headers, ...(applied ? { 'content-encoding': applied } : {}), 'content-length': bytes.length });
    res.end(bytes);
  };
  if (!encoding) return finish(json);
  const key = tag && `${tag}:${encoding}`;
  const kept = key ? compressed.get(key) : undefined;
  if (kept) return finish(kept, encoding);
  const keep = (bytes: Buffer) => {
    if (!key) return;
    if (compressed.size >= COMPRESSED_KEPT) compressed.delete(compressed.keys().next().value!);
    compressed.set(key, bytes);
  };
  const options =
    encoding === 'br'
      ? {
          params: {
            [zlib.BROTLI_PARAM_QUALITY]: 4,
            [zlib.BROTLI_PARAM_SIZE_HINT]: json.length,
            [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
          },
        }
      : { level: 6 };
  if (json.length < COMPRESS_INLINE_BELOW) {
    const bytes = encoding === 'br' ? brotliCompressSync(json, options) : gzipSync(json, options);
    keep(bytes);
    return finish(bytes, encoding);
  }
  const done = (error: Error | null, bytes: Buffer) => {
    if (error) return finish(json);
    keep(bytes);
    finish(bytes, encoding);
  };
  if (encoding === 'br') brotliCompress(json, options, done);
  else gzip(json, options, done);
}

/** Files obey the same settlement boundary as JSON. Even their headers wait:
 * a failed policy context must not publish file metadata or a partial body. */
export function sendBytes(
  res: ServerResponse,
  status: number,
  bytes: Uint8Array,
  headers: Record<string, string | number>,
  head = false,
): void {
  const deferred = policyResponses.get(res);
  if (deferred) {
    const body = Buffer.from(bytes);
    const capturedHeaders = { ...headers };
    deferred.reply = () => sendBytes(res, status, body, capturedHeaders, head);
    return;
  }
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, headers);
  res.end(head ? undefined : bytes);
}

/**
 * Bytes that arrive as a stream (a file passed on from its bucket), sent as
 * they come. A reply a policy holds until its transaction ends cannot start
 * early, so there the stream is read whole first and sent like any other.
 */
export async function sendStream(
  res: ServerResponse,
  status: number,
  body: ReadableStream<Uint8Array>,
  headers: Record<string, string | number>,
  head = false,
): Promise<void> {
  if (head || res.destroyed || res.writableEnded) {
    await body.cancel().catch(() => {});
    sendBytes(res, status, new Uint8Array(0), headers, true);
    return;
  }
  if (policyResponses.get(res)) {
    sendBytes(res, status, new Uint8Array(await new Response(body).arrayBuffer()), headers);
    return;
  }
  res.writeHead(status, headers);
  await pipeline(Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>), res).catch(() => res.destroy());
}

/** Bounded, because an unbounded request body is a denial of service. */
const MAX_BODY = 1024 * 256;
/** A file upload, the one body allowed past that: base64 of the largest file an App may accept, and room for the rest. */
export const FILE_UPLOAD_PATH = '/api/file/upload';
export const FILE_UPLOAD_BODY = Math.ceil(FILE_MAX_BYTES_CEILING / 3) * 4 + 64 * 1024;
/**
 * A tenant App's read of one file (tenant/tenantHttp.ts): the bytes come back
 * as base64 in JSON, on the lease, like every other tenant read — a tenant
 * page never addresses a file by URL, so no tenant's file is ever a link.
 */
export const FILE_READ_PATH = '/api/file/read';
/**
 * The most bytes a tenant App's upload carries, whatever the resource's own
 * cap: a tenant request is captured whole before it is judged (evidence.ts
 * `captureTenantData`, 16 MiB of text), and base64 of this fits in it.
 */
export const TENANT_FILE_MOST = 10 * 1024 * 1024;
export const TENANT_FILE_UPLOAD_BODY = Math.ceil(TENANT_FILE_MOST / 3) * 4 + 64 * 1024;

/** Only diagnostics emitted by the request service are public. Provider errors
 * are stripped of ResourceReadError inside that service; failures elsewhere in
 * auth/policy startup never pass through this conversion. */
export async function httpRead<R>(work: () => Promise<R>): Promise<R> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof ResourceReadError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

/**
 * An error that already knows what status it deserves.
 *
 * Without this everything that was not a `PathError` fell out of `createApp`'s
 * catch as a 500, so a body the caller sent malformed — or one they sent too
 * much of — was reported to them as an outage on this end. The status is the
 * only part of a failure most clients branch on; getting it wrong sends
 * people to look at the wrong machine.
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * A refusal that answers to both names.
 *
 * The view endpoints report their failures as `errors: [{message}]`, because
 * a half-built view can be wrong in several places at once; every other
 * endpoint reports `error`. A client that branches on the status and then
 * reads `.error` showed a blank message on exactly the endpoints where the
 * message mattered most. Both are sent — the list stays the shape the view
 * editor reads, and `error` is the first of them.
 */
export function refuse(res: ServerResponse, status: number, messages: string[]): void {
  send(res, status, {
    error: messages[0],
    errors: messages.map((message) => ({ message })),
  });
}

export async function readJson(req: IncomingMessage, limit = MAX_BODY): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (!chunks.length) return {};
  try {
    /* JSON.parse itself preserves literal keys safely. Some downstream maps
       still use keyed assignment on ordinary objects, though, so admitting
       these names would not preserve their values end to end. Refuse the
       whole request rather than silently deleting an intended write. Literal
       column support needs those consumers hardened before this can relax. */
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'), (key, value: unknown) => {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
        throw new HttpError(400, `Request body property "${key}" is not supported.`);
      }
      return value;
    });
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new HttpError(400, 'Request body must be a JSON object.');
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'Request body was not valid JSON.');
  }
}
