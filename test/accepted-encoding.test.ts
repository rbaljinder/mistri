import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ServerResponse } from 'node:http';
import { acceptedEncoding } from '../packages/engine/src/server/http/reply.js';

const pick = (header: string | undefined) =>
  acceptedEncoding({ req: { headers: header === undefined ? {} : { 'accept-encoding': header } } } as unknown as ServerResponse);

test('the highest weight wins, and brotli wins a tie', () => {
  assert.equal(pick('gzip;q=1, br;q=0.1'), 'gzip');
  assert.equal(pick('gzip;q=0.2, br;q=0.9'), 'br');
  assert.equal(pick('gzip, br'), 'br');
  assert.equal(pick('br;q=0.5, gzip;q=0.5'), 'br');
  assert.equal(pick('GZIP;Q=0.9, BR;q=0.3'), 'gzip');
});

test('q=0 excludes an encoding', () => {
  assert.equal(pick('br;q=0, gzip;q=0.1'), 'gzip');
  assert.equal(pick('gzip;q=0, br'), 'br');
  assert.equal(pick('br;q=0, gzip;q=0'), undefined);
});

test('a wildcard weights the encodings not named', () => {
  assert.equal(pick('*'), 'br');
  assert.equal(pick('gzip;q=0.4, *;q=0.8'), 'br');
  assert.equal(pick('br;q=0.4, *;q=0.8'), 'gzip');
  assert.equal(pick('*;q=0'), undefined);
  assert.equal(pick('br;q=0, *'), 'gzip');
});

test('identity, an absent header and unknown codings choose nothing', () => {
  assert.equal(pick(undefined), undefined);
  assert.equal(pick(''), undefined);
  assert.equal(pick('identity'), undefined);
  assert.equal(pick('deflate, zstd'), undefined);
  assert.equal(pick('identity;q=1, gzip;q=0.5'), undefined);
  assert.equal(pick('gzip, identity;q=0.5'), 'gzip');
  assert.equal(pick('gzip;q=nonsense'), undefined);
});
