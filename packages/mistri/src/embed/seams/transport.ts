/**
 * packages/kit/src/client/transport.ts as an embedded shell has it: every request to the
 * Provider's endpoint. Same-origin (the recommended deployments: the host
 * rewrites or mounts the handler) it is the cookie, exactly as served. On
 * another origin it carries the embed session as a bearer and no cookie at
 * all: a third-party cookie is not something to rely on, and a cross-origin
 * request that carried one would be refused as CSRF anyway.
 */
import { binding } from '../binding.js';
import { served } from './addressMount.js';

export const fetchServer = (path: string, init?: RequestInit): Promise<Response> => {
  const authorization = binding().authorization();
  if (!authorization) return fetch(served(path), init);
  const headers = new Headers(init?.headers);
  headers.set('authorization', authorization);
  return fetch(served(path), { ...init, headers, credentials: 'omit' });
};
