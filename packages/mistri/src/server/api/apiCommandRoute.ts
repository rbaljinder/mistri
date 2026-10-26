/** Private origin-form command-route grammar: one target, many targets and
 * scope recovery, as the API design names them. Pure — no key decoding,
 * headers, body, mounting, exposure or principal authority. The raw key
 * segment reaches the key codec unchanged, exactly as on the read route. */
import { reservedKeys } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { apiResourceSegment, apiVersion, decodeApiSegment, refuseRoute, splitApiRoute } from './apiRoutePath.js';

const MESSAGE = 'Invalid App API command route.';
const refuse = (): never => refuseRoute(MESSAGE);
// Command ids and request keys have exactly one spelling: no percent-encoding.
const COMMAND = /^[A-Za-z][A-Za-z0-9_-]{0,127}(?![\s\S])/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}(?![\s\S])/;

export type ApiCommandRoute = Readonly<
  { appId: string; version: number; command: string; commandVersion: number } & (
    | { kind: 'one'; method: 'POST'; resource: string; rawKey: string }
    | { kind: 'prepare'; method: 'GET'; resource: string; rawKey: string }
    | { kind: 'many'; method: 'POST'; resource: string }
    | { kind: 'recover'; method: 'GET'; idempotencyKey: string }
  )
>;

function command(segment: string): string {
  if (!COMMAND.test(segment) || reservedKeys.has(segment)) return refuse();
  return segment;
}

export function parseApiCommandRoute(raw: unknown): ApiCommandRoute {
  const { appId, version, parts, hasQuery } = splitApiRoute(raw, MESSAGE);
  // Every input arrives in the path, the headers or the body; a query would
  // be a second channel for the same facts.
  if (hasQuery) return refuse();
  if (parts[5] === 'commands') {
    // …/commands/{command}/v{n}/receipts/{idempotencyKey}
    if (parts.length !== 10 || parts[8] !== 'receipts' || !IDEMPOTENCY_KEY.test(parts[9])) return refuse();
    return Object.freeze({
      kind: 'recover',
      method: 'GET',
      appId,
      version,
      command: command(parts[6]),
      commandVersion: apiVersion(parts[7], MESSAGE),
      idempotencyKey: parts[9],
    });
  }
  const resource = parts[5];
  if (!apiResourceSegment(resource) || resource === 'views') return refuse();
  // …/{resource}/commands/{command}/v{n}: the targets travel in the body.
  if (parts.length === 9 && parts[6] === 'commands') {
    return Object.freeze({
      kind: 'many',
      method: 'POST',
      appId,
      version,
      resource,
      command: command(parts[7]),
      commandVersion: apiVersion(parts[8], MESSAGE),
    });
  }
  // …/{resource}/{key}/commands/{command}/v{n}
  const prepare = parts.length === 11 && parts[10] === 'prepare';
  if ((!prepare && parts.length !== 10) || parts[7] !== 'commands') return refuse();
  const rawKey = parts[6],
    decoded = decodeApiSegment(rawKey, MESSAGE);
  if (!rawKey || Buffer.byteLength(rawKey) > 8192 || decoded === '.' || decoded === '..') return refuse();
  const target = { appId, version, resource, rawKey, command: command(parts[8]), commandVersion: apiVersion(parts[9], MESSAGE) };
  return prepare ? Object.freeze({ kind: 'prepare', method: 'GET', ...target }) : Object.freeze({ kind: 'one', method: 'POST', ...target });
}
