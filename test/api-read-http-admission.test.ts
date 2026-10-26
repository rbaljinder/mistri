import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createSqliteApiReadHttp } from '../packages/mistri/src/server/api/sqliteApiReadHttp.js';

// Admission-only doubles: no database, native auth or claimed read authority.
function response() {
  const headers = new Map<string, unknown>();
  const value = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    status: 0,
    body: '',
    setHeader(name: string, content: unknown) {
      headers.set(name, content);
    },
    writeHead(status: number) {
      value.status = status;
    },
    end(body: string) {
      value.body = body;
      value.writableEnded = true;
    },
  });
  return { value, headers, res: value as unknown as ServerResponse };
}

test('API admission bounds outstanding work independently of arrival budget and releases slots', async () => {
  const host = { app: { app: { id: 'app', api: { version: 1 } } } } as unknown as AppHost;
  const transport = createSqliteApiReadHttp(new Registry(), host, {
    bound: { host: '127.0.0.1', port: 4111 },
    integers: 'decimal-string',
    requestsPerMinute: 1000000,
  });
  const request = {
    url: '/api/apps/app/v1/person',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' },
    headers: { host: '127.0.0.1:4111' },
    rawHeaders: ['Host', '127.0.0.1:4111'],
  };
  const message = () => Object.assign(new EventEmitter(), request) as unknown as IncomingMessage;
  try {
    const admitted = Array.from({ length: 32 }, () => {
      const reply = response();
      return { reply, work: transport.handle(message(), reply.res) };
    });
    const full = response();
    const refused = transport.handle(message(), full.res);
    // Refusal is immediate, before scheduled work can inspect credentials.
    assert.equal(full.value.status, 503);
    assert.deepEqual(JSON.parse(full.value.body), {
      error: { code: 'temporarily_unavailable', message: 'The API request could not be completed.' },
    });
    assert.equal(full.headers.get('cache-control'), 'no-store');
    assert.equal(full.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(await refused, true);
    await Promise.all(admitted.map((item) => item.work));
    for (const item of admitted) assert.equal(item.reply.value.status, 401);
    const recovered = response();
    assert.equal(await transport.handle(message(), recovered.res), true);
    assert.equal(recovered.value.status, 401);
    const unrelated = response();
    assert.equal(await transport.handle({ ...request, url: '/api/app' } as IncomingMessage, unrelated.res), false);
    assert.equal(unrelated.value.status, 0);
    const disconnected = response();
    disconnected.value.destroyed = true;
    const unread = message();
    Object.defineProperty(unread, 'rawHeaders', {
      get: () => {
        throw new Error('Read credentials after disconnect');
      },
    });
    assert.equal(await transport.handle(unread as IncomingMessage, disconnected.res), true);
    assert.equal(disconnected.value.status, 0);
    assert.equal(disconnected.headers.size, 0);
  } finally {
    await transport.retire();
  }
});
