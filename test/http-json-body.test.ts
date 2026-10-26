import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { readJson } from '../packages/engine/src/server/http/reply.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';

const request = (body: string) => Readable.from(body ? [Buffer.from(body)] : []) as IncomingMessage;

test('JSON protocol bodies reject null, arrays and scalar roots as client errors', async () => {
  for (const body of ['null', '[]', '[{}]', 'true', '42', '"value"']) {
    await assert.rejects(readJson(request(body)), { status: 400, message: 'Request body must be a JSON object.' });
  }
});

test('JSON protocol bodies preserve object envelopes, nested arrays and empty requests', async () => {
  assert.deepEqual(await readJson(request('')), {});
  assert.deepEqual(await readJson(request('{"values":[null,1,{"name":"ok"}]}')), { values: [null, 1, { name: 'ok' }] });
  await assert.rejects(readJson(request('{')), { status: 400, message: 'Request body was not valid JSON.' });
  await assert.rejects(readJson(request('{"name":"too long"}'), 2), { status: 413 });
});

test('JSON protocol bodies refuse reserved literal keys without returning a partial write', async () => {
  const before = Object.getOwnPropertyDescriptors(Object.prototype);
  for (const name of ['__proto__', 'constructor', 'prototype']) {
    for (const value of ['"literal"', 'null', 'false', '0', '{"polluted":true}', '[{"polluted":true}]']) {
      const member = `${JSON.stringify(name)}:${value}`;
      for (const body of [
        `{${member}}`,
        `{"values":{"ordinary":"keep",${member}}}`,
        `{"steps":[{"values":{"ordinary":"keep",${member}}}]}`,
      ]) {
        let delivered = false;
        await assert.rejects(
          readJson(request(body)).then(() => {
            delivered = true;
          }),
          {
            status: 400,
            message: `Request body property "${name}" is not supported.`,
          },
        );
        assert.equal(delivered, false, 'No partial body may reach a write consumer.');
      }
    }
  }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), before);
  assert.equal(Object.hasOwn({}, 'polluted'), false);
});

test('JSON protocol bodies recognize escaped keys but leave ordinary literal values untouched', async () => {
  await assert.rejects(readJson(request('{"values":{"\\u005f_proto__":"literal"}}')), {
    status: 400,
    message: 'Request body property "__proto__" is not supported.',
  });
  const body =
    '{"values":{"name":"__proto__","description":"constructor","kind":"prototype","constructor_id":4,"Prototype":"kept"},"nested":[null,{"value":false}]}';
  assert.deepEqual(await readJson(request(body)), JSON.parse(body));
});

test('HTTP rejects invalid protocol bodies before connection dispatch', async (t) => {
  const registry = new Registry(),
    bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await registry.closeAll();
  });
  await new Promise<void>((resolve) => server.listen(0, bound.host, resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  bound.port = address.port;
  const origin = `http://127.0.0.1:${bound.port}`;
  for (const body of ['null', '[]', '42', 'true', '"value"']) {
    const response = await fetch(`${origin}/api/query`, { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Request body must be a JSON object.' });
  }
  for (const key of ['__proto__', 'constructor', 'prototype']) {
    const response = await fetch(`${origin}/api/insert`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: `{"table":"items","values":{"name":"must not be written",${JSON.stringify(key)}:"literal"}}`,
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: `Request body property "${key}" is not supported.` });
  }
});
