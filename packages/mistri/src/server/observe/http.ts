/**
 * The observer's page and its JSON, at `/_mistri/observe`.
 *
 * Loopback only, twice over: the peer must be this machine, and so must the
 * Host it asked for — a page elsewhere that rebinds a name to 127.0.0.1
 * reaches the socket but not with a loopback Host. Nothing here sends CORS
 * headers, and every write is JSON, which a cross-origin form cannot send
 * without a preflight nothing answers.
 *
 * The page is the client's React, served like the rest of the client: from
 * source through Vite's middleware under tsx, from `dist/observe` in a build
 * (vite.observe.config.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FROM_SOURCE, devClient } from '@mistriwork/engine/server/devclient.js';
import { shellPolicy } from '@mistriwork/engine/server/clientHttp.js';
import { CLIENT_FILES } from '../clientFiles.js';
import { explainStatement } from '@mistriwork/engine/adapters/telemetry/drivers.js';
import type { AddressMount } from '@mistriwork/engine/shared/mount.js';
import { RESERVED, type ObserverHttp } from './mount.js';
import { explainAccess } from './access.js';
import type { Observer } from './observer.js';
import type { PageReport } from './store.js';

/* The observer's page is this package's; from source, Vite (rooted at the kit's page) is handed its entry by path. */
const SOURCE_DIR = fileURLToPath(new URL('../../client/observe/', import.meta.url));
const BUILT_DIR = fileURLToPath(new URL('../../observe/', import.meta.url));
const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

const LOOPBACK_PEER = /^(127\.\d+\.\d+\.\d+|::1|::ffff:127\.\d+\.\d+\.\d+)$/;
const LOOPBACK_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i;

/** Whether this request came from this machine, for this machine. */
export function loopbackRequest(req: IncomingMessage): boolean {
  return LOOPBACK_PEER.test(req.socket.remoteAddress ?? '') && LOOPBACK_HOST.test(String(req.headers.host ?? ''));
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 64 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new Error('Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Too large.');
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Send an object.');
  return parsed as Record<string, unknown>;
}

const num = (value: string | null) => (value === null || value === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));
const bool = (value: string | null) => (value === null ? undefined : value === 'true' || value === '1');
const str = (value: string | null) => (value === null || value === '' ? undefined : value.slice(0, 500));

async function page(req: IncomingMessage, res: ServerResponse, mount: AddressMount) {
  let html: string;
  if (FROM_SOURCE) {
    const vite = await devClient(CLIENT_FILES);
    const source = (await readFile(join(SOURCE_DIR, 'index.html'), 'utf8')).replace(
      'src="/observe/main.tsx"',
      `src="/@fs${pathToFileURL(join(SOURCE_DIR, 'main.tsx')).pathname}"`,
    );
    html = await vite.transformIndexHtml(`${RESERVED}/`, source);
  } else {
    try {
      html = await readFile(join(BUILT_DIR, 'observe', 'index.html'), 'utf8');
    } catch {
      return json(res, 503, { error: 'The observer page was not built with this package.' });
    }
    // The build names its files from /_mistri/observe/; under a base path they are said under it.
    if (mount.base)
      html = html.replace(/(\s(?:src|href)=")\/_mistri\/observe\//g, (_, attribute: string) => `${attribute}${mount.base}${RESERVED}/`);
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': shellPolicy(html, { fromSource: FROM_SOURCE }),
    'referrer-policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

async function asset(res: ServerResponse, rest: string) {
  const file = normalize(join(BUILT_DIR, rest));
  if (!file.startsWith(BUILT_DIR.endsWith(sep) ? BUILT_DIR : BUILT_DIR + sep)) return json(res, 404, { error: 'Not found.' });
  try {
    const bytes = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    res.end(bytes);
  } catch {
    json(res, 404, { error: 'Not found.' });
  }
}

const PAGE_KINDS = new Set<PageReport['kind']>(['error', 'layout-shift', 'vital']);

export function observerHttp(observer: Observer): ObserverHttp {
  const { store } = observer;
  return (req, res, url, mount: AddressMount) => {
    void (async () => {
      if (!loopbackRequest(req)) return json(res, 403, { error: 'The dev observer answers this machine only.' });
      const rest = url.pathname.slice(RESERVED.length);
      if (rest === '') {
        res.writeHead(308, { location: `${mount.base}${RESERVED}/`, 'cache-control': 'no-store' }).end();
        return;
      }
      const q = url.searchParams;
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (rest === '/') return page(req, res, mount);
        if (rest.startsWith('/assets/') && !FROM_SOURCE) return asset(res, rest.slice(1));
        switch (rest) {
          case '/api/status':
            return json(res, 200, {
              cursor: store.cursor,
              slowMs: store.slowMs,
              apps: observer.context.apps().map((host) => ({
                id: host.app.app.id,
                name: host.app.app.name,
                roles: Object.keys(host.app.app.auth?.roles ?? {}),
                ...(host.loadError ? { loadError: host.loadError } : {}),
              })),
            });
          case '/api/traces':
            return json(
              res,
              200,
              store.list({
                route: str(q.get('route')),
                status: num(q.get('status')),
                error: bool(q.get('error')),
                slowerThanMs: num(q.get('slowerThan')),
                since: num(q.get('since')),
                limit: num(q.get('limit')),
                app: str(q.get('app')),
                text: str(q.get('text')),
              }),
            );
          case '/api/logs':
            return json(
              res,
              200,
              store.searchLogs({
                level: str(q.get('level')),
                text: str(q.get('text')),
                traceId: str(q.get('trace')),
                source: str(q.get('source')),
                since: num(q.get('since')),
                limit: num(q.get('limit')),
                outsideRequests: bool(q.get('outside')),
              }),
            );
          case '/api/errors':
            return json(res, 200, store.errors(num(q.get('limit')), num(q.get('since'))));
          case '/api/slow':
            return json(res, 200, store.slowQueries(num(q.get('limit'))));
          case '/api/n-plus-one':
            return json(res, 200, store.nPlusOne(num(q.get('limit'))));
          case '/api/pages':
            return json(
              res,
              200,
              store.pageReports(
                num(q.get('limit')),
                PAGE_KINDS.has(q.get('kind') as PageReport['kind']) ? (q.get('kind') as PageReport['kind']) : undefined,
              ),
            );
          case '/api/tail':
            return json(res, 200, store.tail(num(q.get('cursor')), num(q.get('limit'))));
          case '/api/access':
            return json(
              res,
              200,
              await explainAccess(observer.context, {
                app: str(q.get('app')),
                role: str(q.get('role')),
                table: str(q.get('table')),
                column: str(q.get('column')),
                command: str(q.get('command')),
              }),
            );
          default:
            break;
        }
        const trace = /^\/api\/traces\/([0-9a-f]{8,32})$/.exec(rest);
        if (trace) {
          const found = store.trace(trace[1], { full: bool(q.get('full')) });
          return found
            ? json(res, 200, found)
            : json(res, 404, { error: 'No such trace in memory: the observer keeps the latest few hundred.' });
        }
        return json(res, 404, { error: 'Not found.' });
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'Method not allowed.' });
      const sent = await body(req);
      switch (rest) {
        case '/api/explain': {
          const spanId = typeof sent.spanId === 'string' && /^[0-9a-f]{16}$/.test(sent.spanId) ? sent.spanId : undefined;
          if (!spanId || !store.hasStatement(spanId)) return json(res, 404, { error: 'No such statement in memory.' });
          try {
            const plan = await explainStatement(spanId);
            return plan
              ? json(res, 200, { plan })
              : json(res, 404, { error: 'This statement cannot be explained here (only reads are, on SQLite and PostgreSQL).' });
          } catch (error) {
            return json(res, 200, { error: error instanceof Error ? error.message : String(error) });
          }
        }
        case '/api/page': {
          const kind = sent.kind as PageReport['kind'];
          if (!PAGE_KINDS.has(kind) || typeof sent.path !== 'string')
            return json(res, 400, { error: 'A page report has a kind and a path.' });
          const sources = Array.isArray(sent.sources)
            ? sent.sources.slice(0, 10).map((source) => {
                const s = source as Record<string, unknown>;
                return {
                  node: String(s.node ?? '').slice(0, 300),
                  ...(typeof s.previous === 'string' ? { previous: s.previous.slice(0, 100) } : {}),
                  ...(typeof s.current === 'string' ? { current: s.current.slice(0, 100) } : {}),
                };
              })
            : undefined;
          store.addPage({
            time: Date.now(),
            kind,
            path: sent.path,
            ...(typeof sent.traceId === 'string' && /^[0-9a-f]{32}$/.test(sent.traceId) ? { traceId: sent.traceId } : {}),
            ...(typeof sent.message === 'string' ? { message: sent.message } : {}),
            ...(typeof sent.stack === 'string' ? { stack: sent.stack } : {}),
            ...(typeof sent.value === 'number' && Number.isFinite(sent.value) ? { value: sent.value } : {}),
            ...(typeof sent.name === 'string' ? { name: sent.name.slice(0, 40) } : {}),
            ...(sources ? { sources } : {}),
          });
          return json(res, 200, { ok: true });
        }
        case '/api/clear':
          store.clear();
          return json(res, 200, { ok: true });
        default:
          return json(res, 404, { error: 'Not found.' });
      }
    })().catch((error) => {
      if (!res.headersSent) json(res, 400, { error: error instanceof Error ? error.message : 'The observer could not answer.' });
      else res.destroy();
    });
  };
}
