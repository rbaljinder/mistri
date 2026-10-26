/** Private raw header extraction for App API command routes: the revision
 * precondition and the request locator. It consumes Node rawHeaders, like the
 * bearer reader, so a repeated field cannot vanish in the normalized map.
 * No verification, lookup or authority. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import type { ApiCommandRoute } from './apiCommandRoute.js';

/** Value-free request errors the route answers before the owner has the request. */
export class ApiCommandRequestError extends Error {
  constructor(readonly code: 'invalid_request' | 'not_found' | 'precondition_required' | 'idempotency_key_required') {
    super('The API command request is invalid.');
    this.name = 'ApiCommandRequestError';
  }
}
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,128}(?![\s\S])/;
// One strong tag holding a canonical revision. Weak tags, `*` and lists refuse.
const REVISION_TAG = /^"(0|[1-9][0-9]{0,15})"(?![\s\S])/;

export function readApiCommandHeaders(
  rawHeaders: unknown,
  kind: ApiCommandRoute['kind'],
): Readonly<{ expectedVersion?: number; idempotencyKey?: string }> {
  let ifMatch: string | undefined, idempotency: string | undefined;
  try {
    const headers = snapshot(rawHeaders, 65536).value;
    if (!Array.isArray(headers) || headers.length % 2 || headers.length > 512) throw new Error();
    for (let index = 0; index < headers.length; index += 2) {
      const name = headers[index],
        value = headers[index + 1];
      if (
        typeof name !== 'string' ||
        !/^[!#$%&'*+.^_`|~0-9a-z-]+(?![\s\S])/i.test(name) ||
        typeof value !== 'string' ||
        /[\r\n\0]/.test(value)
      )
        throw new Error();
      const lower = name.toLowerCase();
      if (lower === 'if-match') {
        if (ifMatch !== undefined) throw new Error();
        ifMatch = value;
      } else if (lower === 'idempotency-key') {
        if (idempotency !== undefined) throw new Error();
        idempotency = value;
      }
    }
  } catch {
    throw new ApiCommandRequestError('invalid_request');
  }
  if (kind === 'recover' || kind === 'prepare') {
    // Read-only preparation/recovery take their locator from the path.
    if (ifMatch !== undefined || idempotency !== undefined) throw new ApiCommandRequestError('invalid_request');
    return Object.freeze({});
  }
  if (idempotency === undefined) throw new ApiCommandRequestError('idempotency_key_required');
  if (!IDEMPOTENCY_KEY.test(idempotency)) throw new ApiCommandRequestError('invalid_request');
  if (kind === 'many') {
    // Several revisions travel in the body; one header cannot hold them.
    if (ifMatch !== undefined) throw new ApiCommandRequestError('invalid_request');
    return Object.freeze({ idempotencyKey: idempotency });
  }
  if (ifMatch === undefined) throw new ApiCommandRequestError('precondition_required');
  const tag = REVISION_TAG.exec(ifMatch);
  const expectedVersion = tag ? Number(tag[1]) : NaN;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion >= Number.MAX_SAFE_INTEGER)
    throw new ApiCommandRequestError('invalid_request');
  return Object.freeze({ expectedVersion, idempotencyKey: idempotency });
}
