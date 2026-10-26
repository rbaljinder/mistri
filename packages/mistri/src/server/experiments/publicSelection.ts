/** Public form selectors identify a native form/placement admission. They never
 * supply visitor identity or tenant authority, which remain with their owners. */
import type { IncomingMessage } from 'node:http';
import { EXPERIMENT_FORM_HEADER, EXPERIMENT_ADDRESS_HEADER } from '../../shared/appFlagValues.js';
import { HttpError } from '@mistriwork/engine/server/http/reply.js';
export function experimentPublicSelection(request: IncomingMessage) {
  const form = request.headers[EXPERIMENT_FORM_HEADER],
    address = request.headers[EXPERIMENT_ADDRESS_HEADER];
  const invalid = () => {
    throw new HttpError(400, 'Invalid public experiment selection.');
  };
  for (const name of [EXPERIMENT_FORM_HEADER, EXPERIMENT_ADDRESS_HEADER]) {
    if (request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length > 1) invalid();
  }
  if (
    (form !== undefined && (typeof form !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(form))) ||
    (address !== undefined && (!form || typeof address !== 'string' || address.length > 512 || /[\p{Cc}\p{Cs}]/u.test(address)))
  )
    invalid();
  return Object.freeze({ form: form as string | undefined, address: address as string | undefined });
}
