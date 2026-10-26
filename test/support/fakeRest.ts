/**
 * A small REST API for the HTTP-source tests: the Desk API of
 * test/fixtures/http/openapi.json, in memory, on 127.0.0.1.
 *
 * It answers the way the spec says — offset paging, filters, search and a
 * documented sort on contacts; cursor paging on tickets; items by key — and
 * keeps every request it saw, so a test can assert exactly what tablewalk
 * asked the API rather than only what came back. A few paths misbehave on
 * purpose (a redirect, HTML, an oversized body, a response that never ends)
 * for the egress tests.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';

export interface SeenRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage['headers'];
}

const STATUSES = ['lead', 'customer', 'churned'] as const;
export const CONTACTS = Array.from({ length: 25 }, (_, i) => ({
  id: `c-${String(i + 1).padStart(2, '0')}`,
  name: `Contact ${i + 1}`,
  email: i % 5 === 0 ? null : `contact${i + 1}@example.test`,
  status: STATUSES[i % 3],
  tag: i % 2 ? 'wholesale' : 'retail',
  score: i * 1.5,
  vip: i % 4 === 0,
  created_at: `2026-08-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z`,
  address: { city: i % 2 ? 'Leith' : 'Porto' },
  // Never declared in the spec: a row carries it, and a catalog that is an allowlist drops it.
  internal_note: 'not for tablewalk',
}));
/* Past 2^53, written as the digits a JSON number would lose. */
export const BIG_ID = '9007199254740993';
export const TICKETS = Array.from({ length: 7 }, (_, i) => ({
  id: i === 6 ? BIG_ID : i + 1,
  subject: `Ticket ${i + 1}`,
  priority: (i % 3) + 1,
  labels: ['support'],
  meta: 'x',
  contact_id: CONTACTS[i % 3].id,
}));

const json = (response: ServerResponse, status: number, body: unknown, raw?: string) => {
  response.writeHead(status, { 'content-type': 'application/json' });
  // Written by hand where a big integer must reach the client as digits, not a rounded double.
  response.end(raw ?? JSON.stringify(body));
};

export async function startFakeRest(): Promise<{ origin: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://fake.test');
    const query = url.searchParams;
    seen.push({ method: request.method ?? 'GET', path: url.pathname, query, headers: request.headers });
    const path = url.pathname.replace(/^\/v1/, '');
    if (path === '/redirect') {
      response.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
      return;
    }
    if (path === '/page.html') {
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<html></html>');
      return;
    }
    if (path === '/huge') {
      json(response, 200, null, JSON.stringify({ data: 'x'.repeat(6 * 1024 * 1024) }));
      return;
    }
    if (path === '/slow') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('[');
      return;
    }

    if (path === '/contacts') {
      let rows = CONTACTS.filter(
        (row) =>
          (!query.has('status') || query.getAll('status').includes(row.status)) &&
          (!query.has('tag') || query.getAll('tag').includes(row.tag)) &&
          (!query.has('q') || row.name.toLowerCase().includes(query.get('q')!.toLowerCase())),
      );
      const sort = query.get('sort');
      if (sort === 'name') rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
      if (sort === '-created_at') rows = [...rows].sort((a, b) => b.created_at.localeCompare(a.created_at));
      const offset = Number(query.get('offset') ?? 0),
        limit = Number(query.get('limit') ?? 10);
      json(response, 200, rows.slice(offset, offset + limit));
      return;
    }
    const contact = /^\/contacts\/([^/]+)$/.exec(path);
    if (contact) {
      const row = CONTACTS.find((each) => each.id === decodeURIComponent(contact[1]));
      if (row) json(response, 200, row);
      else json(response, 404, { error: 'not found' });
      return;
    }
    if (path === '/tickets') {
      const rows = TICKETS.filter((row) => !query.has('contact_id') || query.getAll('contact_id').includes(row.contact_id));
      const start = Number(query.get('cursor') ?? 0),
        limit = Number(query.get('limit') ?? 3);
      const page = rows.slice(start, start + limit);
      const next = start + limit < rows.length ? String(start + limit) : null;
      // The big id goes out as bare digits, exactly as an API written in another language would send it.
      const body = JSON.stringify({ data: page, next_cursor: next }).replace(`"id":"${BIG_ID}"`, `"id":${BIG_ID}`);
      json(response, 200, null, body);
      return;
    }
    const ticket = /^\/tickets\/([^/]+)$/.exec(path);
    if (ticket) {
      const row = TICKETS.find((each) => String(each.id) === decodeURIComponent(ticket[1]));
      if (row) json(response, 200, null, JSON.stringify(row).replace(`"id":"${BIG_ID}"`, `"id":${BIG_ID}`));
      else json(response, 404, { error: 'not found' });
      return;
    }
    // The fixture spec, served with a relative server, as an API that publishes its own spec does.
    if (path === '/openapi-servers.json') {
      const spec = JSON.parse(readFileSync(new URL('../fixtures/http/openapi.json', import.meta.url), 'utf8'));
      json(response, 200, { ...spec, servers: [{ url: '/v1' }] });
      return;
    }
    json(response, 404, { error: 'no such path' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
