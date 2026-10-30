/**
 * /readyz carries `{ deploy, build }` beside its status (engine http/probes.ts): `mistri deploy` verifies a roll
 * by them, so the status codes must not move and the ids must come from the environment and the served build.
 */
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { test } from 'node:test';
import { probe, setBuildIdSource } from '../packages/engine/src/server/http/probes.js';

function ask(path: string, ready?: () => boolean, method = 'GET') {
  let status = 0;
  let body = '';
  const res = {
    writeHead(code: number) {
      status = code;
      return res;
    },
    end(text?: string) {
      body = text ?? '';
    },
  } as unknown as ServerResponse;
  const handled = probe({ method } as IncomingMessage, res, path, ready);
  return { handled, status, body: body ? JSON.parse(body) : undefined };
}

test('/readyz names the deploy and the build, and keeps its status semantics', () => {
  const before = process.env.MISTRI_DEPLOY_ID;
  try {
    delete process.env.MISTRI_DEPLOY_ID;
    setBuildIdSource(() => null);
    assert.deepEqual(ask('/readyz').body, { status: 'ok', deploy: null, build: null });
    process.env.MISTRI_DEPLOY_ID = '0b1c';
    setBuildIdSource(() => 'abc123');
    assert.deepEqual(ask('/readyz').body, { status: 'ok', deploy: '0b1c', build: 'abc123' });
    const down = ask('/readyz', () => false);
    assert.equal(down.status, 503);
    assert.deepEqual(down.body, { status: 'unavailable', deploy: '0b1c', build: 'abc123' });
    assert.equal(ask('/readyz', () => assert.fail('throws')).status, 503);
  } finally {
    setBuildIdSource(() => null);
    if (before === undefined) delete process.env.MISTRI_DEPLOY_ID;
    else process.env.MISTRI_DEPLOY_ID = before;
  }
});
