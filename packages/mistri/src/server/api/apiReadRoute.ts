/** Private origin-form read-route grammar; no mounting, exposure or principal
 * authority. Never use WHATWG URL normalization before this raw-path check. */
import { RESERVED_NAMES, VIEW_KEY } from '@mistriwork/engine/shared/model.js';
import { apiResourceSegment, decodeApiSegment, refuseRoute, splitApiRoute } from './apiRoutePath.js';

const MESSAGE = 'Invalid App API read route.';
const refuse = (): never => refuseRoute(MESSAGE);
const decode = (value: string) => decodeApiSegment(value, MESSAGE);

export function parseApiReadRoute(raw: unknown): Readonly<{
  appId: string;
  version: number;
  operationId: string;
  rawQuery: string;
  rawKey?: string;
}> {
  const { appId, version, parts, hasQuery, rawQuery } = splitApiRoute(raw, MESSAGE);
  if (Buffer.byteLength(rawQuery) > 16384) return refuse();
  if (parts.length !== 6 && parts.length !== 7) return refuse();
  const resource = parts[5];
  // Metadata occupies a spelling no resource identifier can claim. It remains
  // bearer-only; publicSpec does not enable anonymous discovery here.
  if (resource === '$openapi') {
    if (parts.length !== 6 || hasQuery) return refuse();
    return Object.freeze({ appId, version, operationId: '$openapi', rawQuery: '' });
  }
  if (resource === '$asyncapi') {
    if (parts.length !== 6 || hasQuery) return refuse();
    return Object.freeze({ appId, version, operationId: '$asyncapi', rawQuery: '' });
  }
  // The feed's own parameters (`after`, `limit`) are judged by the feed (apiEventFeed.ts).
  if (resource === '$events') {
    if (parts.length !== 6) return refuse();
    return Object.freeze({ appId, version, operationId: '$events', rawQuery });
  }
  if (!apiResourceSegment(resource) || resource === 'commands') return refuse();
  let operationId: string, rawKey: string | undefined;
  if (resource === 'views') {
    if (parts.length !== 7 || !VIEW_KEY.test(parts[6]) || parts[6].length > 128 || RESERVED_NAMES.has(parts[6])) return refuse();
    operationId = `view:${parts[6]}`;
  } else if (parts.length === 7) {
    rawKey = parts[6];
    const decoded = decode(rawKey);
    if (!rawKey || Buffer.byteLength(rawKey) > 8192 || decoded === '.' || decoded === '..' || rawQuery) return refuse();
    // Delimiters in composite keys must reach the key codec unchanged. A
    // percent-encoded slash/backslash is key data, not a structural separator.
    operationId = `item:${resource}`;
  } else operationId = `list:${resource}`;
  const seen = new Set<string>();
  const parameters = rawQuery ? rawQuery.split('&') : [];
  if (parameters.length > 64) return refuse();
  for (const parameter of parameters) {
    const equals = parameter.indexOf('=');
    if (equals <= 0) return refuse();
    const name = decode(parameter.slice(0, equals).replace(/\+/g, ' '));
    decode(parameter.slice(equals + 1).replace(/\+/g, ' '));
    if (seen.has(name)) return refuse();
    seen.add(name);
  }
  return Object.freeze({ appId, version, operationId, rawQuery, ...(rawKey === undefined ? {} : { rawKey }) });
}
