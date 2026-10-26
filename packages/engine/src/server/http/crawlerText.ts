/**
 * What a crawler asks a server first — `/robots.txt`, then `/sitemap.xml` —
 * and the shape of the answer: plain text a crawler may keep for an hour, or
 * a refusal it may not keep. A server with no public App answers it here
 * (`closedToCrawlers`): nothing on it is for a search engine. An App's public
 * pages are listed by its sitemap (sitemap.ts), in the same shape.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export const SITEMAP_PATH = '/sitemap.xml';
export const ROBOTS_PATH = '/robots.txt';

export function sendText(req: IncomingMessage, res: ServerResponse, status: number, type: string, body: string): true {
  res.writeHead(status, {
    'content-type': `${type}; charset=utf-8`,
    // A crawler asks again within the hour; a new car is in the next answer.
    'cache-control': status === 200 ? 'public, max-age=3600' : 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
  return true;
}

/** True when `path` is a crawler's question: answered as a GET or HEAD only. */
export function crawlerAsks(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (path !== ROBOTS_PATH && path !== SITEMAP_PATH) return false;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' }).end();
    return true;
  }
  return false;
}

/** The answer of a server with nothing public: crawl nothing, list nothing. False for any other address. */
export function closedToCrawlers(req: IncomingMessage, res: ServerResponse, path: string): boolean {
  if (path !== ROBOTS_PATH && path !== SITEMAP_PATH) return false;
  if (crawlerAsks(req, res, path)) return true;
  if (path === ROBOTS_PATH) return sendText(req, res, 200, 'text/plain', 'User-agent: *\nDisallow: /\n');
  return sendText(req, res, 404, 'text/plain', 'Nothing here is public.\n');
}
