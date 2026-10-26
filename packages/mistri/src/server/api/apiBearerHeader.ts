/** Private transport extraction only, never credential verification. Consume
 * Node rawHeaders so duplicate Authorization fields cannot disappear in its
 * normalized header map. Cookies and query parameters are not inputs. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { apiTokenSecretId } from './apiTokenSecret.js';

export function readApiBearerHeader(rawHeaders: unknown): Readonly<{ tokenId: string; credential: string }> {
  try {
    const headers = snapshot(rawHeaders, 65536).value;
    if (!Array.isArray(headers) || headers.length % 2 || headers.length > 512) throw new Error();
    let authorization: string | undefined;
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
      if (name.toLowerCase() !== 'authorization') continue;
      if (authorization !== undefined) throw new Error();
      authorization = value;
    }
    // Scheme is case-insensitive; the supported credential spelling is exact.
    // No trimming, tab separators, comma lists or alternate token locations.
    if (authorization === undefined || !/^Bearer /i.test(authorization)) throw new Error();
    const credential = authorization.slice(7);
    return Object.freeze({ tokenId: apiTokenSecretId(credential), credential });
  } catch {
    throw new TypeError('An unambiguous API bearer credential is required.');
  }
}
