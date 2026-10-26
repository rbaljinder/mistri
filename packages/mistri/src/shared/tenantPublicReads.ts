/**
 * The routes a tenant App's visitor reads by (`auth.public`): the ordinary
 * App's visitor's reads (server http/gate.ts), and a file's bytes on the
 * lease's own route. The server's visitor lane serves these and no other
 * (tenantPublicReadHttp.ts); the client carries the visitor's public address
 * (`?via=`) on these and no other (requestIdentity.ts), since any other API
 * route refuses an address outright.
 */
import { PAGE_LOAD_PATH } from '@mistriwork/engine/shared/pageRoutes.js';

export const PUBLIC_READ_GETS: ReadonlySet<string> = new Set(['/api/app', '/api/schema', '/api/pages', '/api/runtime']);
export const PUBLIC_READ_POSTS: ReadonlySet<string> = new Set([
  '/api/run',
  '/api/query',
  '/api/count',
  '/api/counts',
  '/api/view/run',
  '/api/breakdown',
  '/api/breakdowns',
  '/api/references',
  '/api/pages/plan',
  '/api/pages/compose',
  PAGE_LOAD_PATH,
  '/api/file/read',
]);

/** Whether a request is a visitor's read by its method and path; what it carries is judged by the lane. */
export function isPublicReadRequest(method: string | undefined, path: string): boolean {
  if (method === 'GET' || method === 'HEAD') return PUBLIC_READ_GETS.has(path);
  return method === 'POST' && PUBLIC_READ_POSTS.has(path);
}
