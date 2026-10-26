import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { runApiTokenCommand } from '../packages/mistri/src/server/cli/apiTokenCommand.js';

function sink(fail = false) {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback(fail ? new Error('PRIVATE_DRIVER_DETAIL') : null);
    },
  });
  return { stream, chunks };
}

test('token command help never loads or mutates a store', async () => {
  const out = sink(),
    err = sink();
  const code = await runApiTokenCommand(
    ['--help'],
    async () => {
      throw new Error('must not run');
    },
    out.stream,
    err.stream,
  );
  assert.equal(code, 0);
  assert.match(out.chunks.join(''), /existing, separate SQLite or PostgreSQL/);
  assert.deepEqual(err.chunks, []);
});

test('token command waits for maintenance before its single JSON handoff', async () => {
  const out = sink(),
    err = sink();
  let calls = 0;
  const code = await runApiTokenCommand(
    ['inspect'],
    async (argv) => {
      calls++;
      assert.deepEqual(argv, ['inspect']);
      assert.deepEqual(out.chunks, []);
      return { verb: 'inspect', result: null };
    },
    out.stream,
    err.stream,
  );
  assert.equal(code, 0);
  assert.equal(calls, 1);
  assert.deepEqual(out.chunks, ['{"verb":"inspect","result":null}\n']);
  assert.deepEqual(err.chunks, []);
});

test('maintenance and post-commit output failures never retry or disclose diagnostics', async () => {
  for (const outputFailure of [false, true]) {
    const out = sink(outputFailure),
      err = sink();
    let calls = 0;
    const code = await runApiTokenCommand(
      ['revoke'],
      async () => {
        calls++;
        if (!outputFailure) throw new Error('PRIVATE_DRIVER_DETAIL');
        return { verb: 'revoke', result: true };
      },
      out.stream,
      err.stream,
    );
    assert.equal(code, 2);
    assert.equal(calls, 1);
    assert.match(err.chunks.join(''), /outcome may be uncertain/);
    assert.doesNotMatch(err.chunks.join(''), /PRIVATE_DRIVER_DETAIL/);
    if (!outputFailure) assert.deepEqual(out.chunks, []);
  }
});

test('broken diagnostic output still returns failure', async () => {
  assert.equal(
    await runApiTokenCommand(
      [],
      async () => {
        throw new Error('private');
      },
      sink().stream,
      sink(true).stream,
    ),
    2,
  );
});

test('uncertain issuance retains only a validated non-secret locator, including broken handoff', async () => {
  const tokenId = '12345678-1234-4abc-8def-123456789abc';
  for (const outputFailure of [false, true]) {
    const out = sink(outputFailure),
      err = sink();
    let calls = 0;
    const code = await runApiTokenCommand(
      ['issue'],
      async (_argv, remember) => {
        calls++;
        remember(tokenId);
        if (!outputFailure) throw new Error('PRIVATE_SECRET');
        return { token: 'PRIVATE_SECRET', tokenId };
      },
      out.stream,
      err.stream,
    );
    assert.equal(code, 2);
    assert.equal(calls, 1);
    assert.ok(err.chunks.join('').includes(tokenId));
    assert.doesNotMatch(err.chunks.join(''), /PRIVATE_SECRET/);
  }
  const out = sink(),
    err = sink();
  await runApiTokenCommand([], async (_argv, remember) => remember('UNTRUSTED_SECRET'), out.stream, err.stream);
  assert.doesNotMatch(err.chunks.join(''), /UNTRUSTED_SECRET/);
  assert.deepEqual(out.chunks, []);
});
