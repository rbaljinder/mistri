import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_PENDING_LIMIT, apiAdmission } from '../packages/mistri/src/server/api/apiHttpAdmission.js';
import { mintApiTokenSecret } from '../packages/mistri/src/server/api/apiTokenSecret.js';
import { createAppMcpHttp } from '../packages/mistri/src/server/api/appMcpHttp.js';

// Admission-only doubles: the body is held open, so no session or owner work can start.
function response() {
  const value = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    headersSent: false,
    status: 0,
    body: '',
    writeHead(status: number) {
      value.status = status;
    },
    end(body: string) {
      value.body = body;
      value.writableEnded = true;
    },
  });
  return { value, res: value as unknown as ServerResponse };
}

/** A POST with its own well-formed, never-issued token, whose body stays open until `finish`. */
function post() {
  const body = new Readable({ read() {} });
  const headers = {
    host: '127.0.0.1:4111',
    'content-type': 'application/json',
    authorization: `Bearer ${mintApiTokenSecret('app', randomUUID()).token}`,
  };
  const req = Object.assign(body, {
    url: '/api/apps/app/v1/$mcp',
    method: 'POST',
    socket: { remoteAddress: '127.0.0.1' },
    headers,
    rawHeaders: Object.entries(headers).flat(),
  }) as unknown as IncomingMessage & Readable;
  return {
    req,
    send: () => {
      req.push('{"jsonrpc":"2.0","id":1,"method":"ping"}');
      req.push(null);
    },
  };
}

test('MCP over HTTP bounds outstanding requests before any async work, and releases every slot', async () => {
  let owned = 0;
  const transport = createAppMcpHttp({
    appId: 'app',
    version: 1,
    bound: { host: '127.0.0.1', port: 4111 },
    admission: apiAdmission(1000000),
    app: {},
    session: async () => {
      owned += 1;
      throw new Error('composition unavailable');
    },
  });
  const held = Array.from({ length: API_PENDING_LIMIT }, () => {
    const request = post();
    const reply = response();
    return { request, reply, work: transport.handle(request.req, reply.res) };
  });

  const over = response();
  const refusing = transport.handle(post().req, over.res);
  // Refused at once: no body was read, and the owner was never reached.
  assert.equal(over.value.status, 503);
  assert.deepEqual(JSON.parse(over.value.body), { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'temporarily_unavailable' } });
  assert.equal(await refusing, true);
  assert.equal(owned, 0);

  // Other paths are not this transport's, and cost no slot.
  assert.equal(await transport.handle({ url: '/api/app', method: 'POST' } as IncomingMessage, response().res), false);

  for (const item of held) item.request.send();
  await Promise.all(held.map((item) => item.work));
  for (const item of held) assert.equal(item.reply.value.status, 503);
  assert.equal(owned, 1, 'one composition, shared; the held requests all reached it only after the bound was lifted');

  // Slots released: a request is admitted again and gets as far as the owner.
  const again = post();
  const recovered = response();
  const work = transport.handle(again.req, recovered.res);
  again.send();
  assert.equal(await work, true);
  assert.deepEqual(JSON.parse(recovered.value.body).error, { code: -32603, message: 'The App MCP is unavailable.' });
});

test('a client that goes away mid-body releases its slot', async () => {
  const transport = createAppMcpHttp({
    appId: 'app',
    version: 1,
    bound: { host: '127.0.0.1', port: 4111 },
    admission: apiAdmission(1000000),
    app: {},
    session: async () => {
      throw new Error('unavailable');
    },
  });
  for (let round = 0; round < 2; round += 1) {
    const dropped = Array.from({ length: API_PENDING_LIMIT }, () => {
      const request = post();
      const work = transport.handle(request.req, response().res).catch(() => true);
      request.req.destroy();
      return work;
    });
    await Promise.all(dropped);
  }
  const live = post();
  const reply = response();
  const work = transport.handle(live.req, reply.res);
  live.send();
  await work;
  assert.equal(reply.value.status, 503);
  assert.match(reply.value.body, /unavailable/);
});
