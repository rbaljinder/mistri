/**
 * A Typesense stand-in: collections with declared fields, upserts, deletes and
 * a search that ranks by how many of the `query_by` fields contain the phrase.
 * It checks the API key on every request and keeps each request's method and
 * path, so a test can assert what reached the engine — and that the key
 * travelled only as the header.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { once } from 'node:events';

export interface FakeTypesense {
  url: string;
  requests: Array<{ method: string; path: string; key?: string }>;
  collections: Map<string, { fields: string[]; documents: Map<string, Record<string, string>> }>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export async function startFakeTypesense(apiKey: string): Promise<FakeTypesense> {
  const collections: FakeTypesense['collections'] = new Map();
  const requests: FakeTypesense['requests'] = [];
  const reply = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const key = req.headers['x-typesense-api-key'] as string | undefined;
    requests.push({ method: req.method ?? '', path: url.pathname + url.search, key });
    if (url.pathname === '/health') return reply(res, 200, { ok: true });
    if (key !== apiKey) return reply(res, 401, { message: 'Forbidden - a valid `x-typesense-api-key` header must be sent.' });
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'collections') return reply(res, 404, { message: 'Not Found' });
    const name = parts[1];
    const found = name ? collections.get(name) : undefined;
    if (req.method === 'POST' && !name) {
      const body = (await read(req)) as { name: string; fields: Array<{ name: string }> };
      if (collections.has(body.name)) return reply(res, 409, { message: 'already exists' });
      collections.set(body.name, { fields: body.fields.map((field) => field.name), documents: new Map() });
      return reply(res, 201, body);
    }
    if (!found) return reply(res, 404, { message: 'Not Found' });
    if (parts.length === 2) {
      if (req.method === 'GET') return reply(res, 200, { name, fields: found.fields.map((field) => ({ name: field, type: 'string' })) });
      if (req.method === 'PATCH') {
        const body = (await read(req)) as { fields: Array<{ name: string }> };
        found.fields.push(...body.fields.map((field) => field.name));
        return reply(res, 200, body);
      }
    }
    if (parts[2] === 'documents' && parts[3] === 'search' && req.method === 'GET') {
      const phrase = (url.searchParams.get('q') ?? '').toLowerCase();
      const by = (url.searchParams.get('query_by') ?? '').split(',');
      const limit = Number(url.searchParams.get('per_page') ?? 10);
      // `field:=value` or `field:=\`value\``, the one filter tablewalk sends.
      const filter = /^(\w+):=`?([^`]*)`?$/.exec(url.searchParams.get('filter_by') ?? '');
      const ranked = [...found.documents.values()]
        .filter((doc) => !filter || doc[filter[1]] === filter[2])
        .map((doc) => ({ doc, score: by.filter((field) => (doc[field] ?? '').toLowerCase().includes(phrase)).length }))
        .filter((hit) => hit.score > 0)
        .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
        .slice(0, limit);
      return reply(res, 200, { found: ranked.length, hits: ranked.map((hit) => ({ document: { id: hit.doc.id } })) });
    }
    if (parts[2] === 'documents' && req.method === 'POST' && !parts[3]) {
      const doc = (await read(req)) as Record<string, string>;
      found.documents.set(doc.id, doc);
      return reply(res, 201, doc);
    }
    if (parts[2] === 'documents' && req.method === 'GET' && parts[3]) {
      const doc = found.documents.get(parts[3]);
      return doc ? reply(res, 200, doc) : reply(res, 404, { message: 'Not Found' });
    }
    if (parts[2] === 'documents' && req.method === 'DELETE' && parts[3]) {
      if (!found.documents.delete(parts[3])) return reply(res, 404, { message: 'Not Found' });
      return reply(res, 200, { id: parts[3] });
    }
    // A delete by filter: `field:=\`value\` && field:=\`value\``, every clause an exact match.
    if (parts[2] === 'documents' && req.method === 'DELETE' && !parts[3]) {
      const clauses = (url.searchParams.get('filter_by') ?? '').split(' && ').map((clause) => /^(\w+):=`([^`]*)`$/.exec(clause));
      if (!clauses.length || clauses.some((clause) => !clause)) return reply(res, 400, { message: 'Bad filter' });
      let removed = 0;
      for (const [id, doc] of found.documents) {
        if (clauses.every((clause) => doc[clause![1]] === clause![2])) removed += found.documents.delete(id) ? 1 : 0;
      }
      return reply(res, 200, { num_deleted: removed });
    }
    return reply(res, 404, { message: 'Not Found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return { url: `http://127.0.0.1:${port}/`, requests, collections, stop: close, close };
}
