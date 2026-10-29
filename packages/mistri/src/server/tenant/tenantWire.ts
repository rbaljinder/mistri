/**
 * The tenant transport's wire: the one reading of an owner's headers, the bounded JSON body, and the one JSON
 * reply that carries (or withholds) an owner's assertion. Nothing here knows a route; tenantHttp.ts decides
 * what is asked, and this decides how it is spoken, so a request is refused or answered the same way everywhere.
 */
import { validateHeaderValue, type IncomingMessage, type ServerResponse } from 'node:http';
import { isDeepStrictEqual } from 'node:util';
import type { ResourceHttpPath } from '@mistriwork/engine/shared/resourceHttp.js';
import { TENANT_HTTP_HEADERS as headers, type TenantContextReply } from '../../shared/tenantContext.js';
import type { TenantHttpResourceReply } from '../../shared/tenantHttp.js';
import { type Bound } from '@mistriwork/engine/server/http/trust.js';
import { captureTenantData, denyTenant, tenantIdentifier, tenantOptions, tenantRecord } from '@mistriwork/engine/server/evidence.js';
import { poolBusyRetryAfterSeconds } from '@mistriwork/engine/adapters/poolMetrics.js';
import { replyJson } from './tenantReplyJson.js';

export class InvalidRequest extends Error {
  constructor(readonly status = 400) {
    super('The tenant request is invalid.');
  }
}
export const invalid = (status = 400): never => {
  throw new InvalidRequest(status);
};

/** rawHeaders preserves duplicates that Node's convenience map may combine or
 * discard. Ownership has one spelling, without comma-list or legacy fallbacks. */
export function tenantHttpHeader(req: IncomingMessage, name: string): string | undefined {
  let result: string | undefined;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index].toLowerCase() !== name) continue;
    if (result !== undefined) return invalid();
    result = req.rawHeaders[index + 1];
  }
  if (result !== undefined && (!result || result !== result.trim() || result.includes(','))) return invalid();
  return result;
}
export function revisionHeader(req: IncomingMessage): number {
  const value = tenantHttpHeader(req, headers.revision);
  if (!value || !/^[1-9][0-9]*$/.test(value)) return invalid();
  const revision = Number(value);
  if (!Number.isSafeInteger(revision)) return invalid();
  return revision;
}

/** Shared restart-only host boundary for the data transport and auth host. */
export function tenantHttpBinding(value: unknown): () => Bound {
  const capture = (): Bound => {
    const bound = captureTenantData(tenantOptions(value, ['host', 'port', 'allowedHosts', 'identityHeader']));
    if (
      bound.identityHeader !== undefined ||
      typeof bound.host !== 'string' ||
      !bound.host ||
      typeof bound.port !== 'number' ||
      !Number.isInteger(bound.port) ||
      bound.port < 0 ||
      bound.port > 65535 ||
      (bound.allowedHosts !== undefined &&
        (!Array.isArray(bound.allowedHosts) || bound.allowedHosts.some((value) => typeof value !== 'string')))
    )
      return denyTenant();
    return bound as unknown as Bound;
  };
  const original = capture();
  return () => {
    const current = capture();
    if (current.host !== original.host || !isDeepStrictEqual(current.allowedHosts, original.allowedHosts)) return denyTenant();
    return current;
  };
}
export function exposed(name: string, value: string): string {
  tenantIdentifier(value, 1024);
  validateHeaderValue(name, value);
  return value;
}
export function ownerHeaders(owner: TenantContextReply): Record<string, string> {
  if (!Number.isSafeInteger(owner.revision) || owner.revision < 1) return denyTenant();
  return {
    [headers.app]: exposed(headers.app, owner.appId),
    [headers.account]: exposed(headers.account, owner.accountId),
    [headers.tenant]: exposed(headers.tenant, owner.tenantId),
    [headers.tab]: exposed(headers.tab, owner.tabId),
    [headers.context]: exposed(headers.context, owner.context),
    [headers.revision]: String(owner.revision),
    ...(owner.realm === 'platform' || owner.realm === 'support' ? { [headers.realm]: owner.realm } : {}),
  };
}
export async function body(req: IncomingMessage, maximum: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
    if ((size += chunk.length) > maximum) return invalid(413);
    chunks.push(chunk);
  }
  try {
    const value: unknown = captureTenantData(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))),
    );
    tenantRecord(value);
    return value;
  } catch {
    return invalid();
  }
}
// `cause`: the error behind a 503, so a pool held at its connection limit says how long (poolBusyRetryAfterSeconds).
export function send(req: IncomingMessage, res: ServerResponse, status: number, value: unknown, ownership = {}, cause?: unknown): void {
  // Serialize before installing ownership headers: a failed projection must not
  // release either a partial private body or a success-looking owner assertion.
  const json = replyJson(value);
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
    'content-length': Buffer.byteLength(json),
    /* Every 503 here is the database or the writer not answering for a
       moment (a busy pool, a writer reopening): said with when to come back,
       which is what an HTTP client and a load balancer retry on. */
    ...(status === 503 ? { 'retry-after': String(poolBusyRetryAfterSeconds(cause)) } : {}),
    ...ownership,
  });
  res.end(req.method === 'HEAD' ? undefined : json);
}
export function sendResource<Path extends ResourceHttpPath>(
  req: IncomingMessage,
  res: ServerResponse,
  _path: Path,
  value: TenantHttpResourceReply<NoInfer<Path>>,
  owner: TenantContextReply,
): void {
  send(req, res, 200, value, ownerHeaders(owner));
}
