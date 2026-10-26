/** Private raw origin-form path rules shared by the App API read and command
 * routes: one rule for the prefix, decoding and resource segments. No
 * mounting, exposure or principal authority. Never normalize through WHATWG
 * URL parsing before these checks: it would accept aliases they refuse. */
import { RESERVED_NAMES } from '@mistriwork/engine/shared/model.js';

export const refuseRoute = (message: string): never => {
  throw new TypeError(message);
};
const badText = (value: string) => /[\p{Cc}\p{Cs}]/u.test(value);

/** Decode one segment exactly once; controls and unpaired surrogates refuse. */
export function decodeApiSegment(value: string, message: string): string {
  try {
    const text = decodeURIComponent(value);
    if (badText(text)) return refuseRoute(message);
    return text;
  } catch {
    return refuseRoute(message);
  }
}

/** `v1`, `v23`: a positive safe integer with no leading zero. */
export function apiVersion(segment: string, message: string): number {
  if (!/^v[1-9][0-9]*(?![\s\S])/.test(segment)) return refuseRoute(message);
  const version = Number(segment.slice(1));
  if (!Number.isSafeInteger(version)) return refuseRoute(message);
  return version;
}

/** A resource segment: an identifier, schema-qualified at most once, never a reserved name. */
export function apiResourceSegment(resource: string): boolean {
  return (
    !!resource &&
    resource.length <= 128 &&
    /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?(?![\s\S])/.test(resource) &&
    !resource.split('.').some((part) => RESERVED_NAMES.has(part))
  );
}

/** `/api/apps/{app}/v{n}/…`, split: the raw bounds, the App id's one canonical
 * spelling and a positive API version. The rest belongs to each route. */
export function splitApiRoute(raw: unknown, message: string) {
  if (
    typeof raw !== 'string' ||
    !raw.startsWith('/api/apps/') ||
    raw.startsWith('//') ||
    Buffer.byteLength(raw) > 32768 ||
    badText(raw) ||
    /[#\\ ]/.test(raw)
  )
    return refuseRoute(message);
  const question = raw.indexOf('?');
  const path = question < 0 ? raw : raw.slice(0, question),
    rawQuery = question < 0 ? '' : raw.slice(question + 1);
  const parts = path.split('/');
  if (parts.length < 6) return refuseRoute(message);
  const appId = decodeApiSegment(parts[3], message);
  if (
    !appId ||
    appId.trim() !== appId ||
    Buffer.byteLength(appId) > 256 ||
    /[/?#\\]/.test(appId) ||
    appId === '.' ||
    appId === '..' ||
    encodeURIComponent(appId) !== parts[3]
  )
    return refuseRoute(message);
  return { appId, version: apiVersion(parts[4], message), parts, hasQuery: question >= 0, rawQuery };
}
