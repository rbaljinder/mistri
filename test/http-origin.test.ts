import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { IncomingMessage } from 'node:http';
import { crossOriginRefusal, originRefusal } from '../packages/engine/src/server/http/trust.js';

const request = (origin?: string, host = 'localhost:4735', type = 'application/json') =>
  ({
    headers: { host, ...(origin === undefined ? {} : { origin }), 'content-type': type },
  }) as IncomingMessage;

test('Origin syntax refuses URL-shaped values that are not serialized HTTP origins', () => {
  for (const origin of [
    '',
    'null',
    'ftp://localhost:4735',
    'file://localhost:4735',
    'http://user:password@localhost:4735',
    'http://localhost:4735/',
    'http://localhost:4735/path',
    'http://localhost:4735?query',
    'http://localhost:4735#fragment',
    ' http://localhost:4735',
    'http://localhost:4735\n',
    'http://localhost:4735 https://localhost:4735',
    'http://LOCALHOST:4735',
  ]) {
    assert.match(originRefusal(request(origin))!, /not a valid origin/, origin);
  }
});

test('Origin host comparison retains missing-Origin CLI and TLS proxy behavior', () => {
  assert.equal(originRefusal(request()), null);
  assert.equal(originRefusal(request('http://localhost:4735')), null);
  // Deliberately not full scheme equality: the binding has no trusted public scheme.
  assert.equal(originRefusal(request('https://localhost:4735')), null);
  assert.equal(originRefusal(request('https://app.example', 'app.example')), null);
  assert.equal(originRefusal(request('http://[::1]:4735', '[::1]:4735')), null);
  for (const origin of ['http://localhost:4736', 'https://other.example', 'http://[::1]:4736']) {
    assert.match(originRefusal(request(origin))!, /only accepts requests from its own page/);
  }
  // URL serialization removes default ports; retain the existing exact Host policy.
  assert.equal(originRefusal(request('http://localhost', 'localhost')), null);
  assert.match(originRefusal(request('http://localhost:80', 'localhost:80'))!, /not a valid origin/);
  assert.match(originRefusal(request('http://localhost', 'localhost:80'))!, /own page/);
});

test('shared mutation guard still enforces allowed hosts and JSON independently of Origin', () => {
  const bound = { host: '127.0.0.1', port: 4735, allowedHosts: ['app.example'] };
  assert.equal(crossOriginRefusal(request('https://app.example', 'app.example'), bound), null);
  assert.equal(crossOriginRefusal(request(undefined), bound), null);
  assert.match(crossOriginRefusal(request('https://other.example', 'other.example'), bound)!, /request arrived for host/);
  assert.match(crossOriginRefusal(request('', 'localhost:4735'), bound)!, /not a valid origin/);
  assert.match(crossOriginRefusal(request('http://localhost:4735', 'localhost:4735', 'text/plain'), bound)!, /takes application\/json/);
});
