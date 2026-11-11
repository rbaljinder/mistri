import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { test } from 'node:test';
import { MaintenanceRefusal } from '../packages/mistri/src/server/cli/apiTokenRefusal.js';
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

test('maintenance and post-commit output failures never retry or disclose credentials', async () => {
  for (const outputFailure of [false, true]) {
    const out = sink(outputFailure),
      err = sink();
    let calls = 0;
    const code = await runApiTokenCommand(
      ['revoke'],
      async () => {
        calls++;
        if (!outputFailure) throw new Error('connect ECONNREFUSED postgres://operator:PRIVATE_PASSWORD@db.internal:5432/auth');
        return { verb: 'revoke', result: true };
      },
      out.stream,
      err.stream,
    );
    assert.equal(code, 2);
    assert.equal(calls, 1);
    assert.match(err.chunks.join(''), /outcome may be uncertain/);
    assert.doesNotMatch(err.chunks.join(''), /PRIVATE_PASSWORD|operator:/);
    // The cause is named, minus the credential: the host it could not reach is the useful half.
    if (!outputFailure) assert.match(err.chunks.join(''), /^mistri: API token maintenance failed: connect ECONNREFUSED .*db\.internal/);
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
  const secret = `twa1.${tokenId}.${'A'.repeat(43)}`;
  for (const outputFailure of [false, true]) {
    const out = sink(outputFailure),
      err = sink();
    let calls = 0;
    const code = await runApiTokenCommand(
      ['issue'],
      async (_argv, remember) => {
        calls++;
        remember(tokenId);
        if (!outputFailure) throw new Error(`could not store ${secret}`);
        return { token: secret, tokenId };
      },
      out.stream,
      err.stream,
    );
    assert.equal(code, 2);
    assert.equal(calls, 1);
    assert.ok(err.chunks.join('').includes(tokenId));
    assert.doesNotMatch(err.chunks.join(''), /AAAAAAAAAA/);
  }
  const out = sink(),
    err = sink();
  await runApiTokenCommand([], async (_argv, remember) => remember('UNTRUSTED_SECRET'), out.stream, err.stream);
  assert.doesNotMatch(err.chunks.join(''), /UNTRUSTED_SECRET/);
  assert.deepEqual(out.chunks, []);
});

// A field report: a refusal that names its precondition was printed as the generic "maintenance failed".
test('a refusal prints the precondition it names, and any other failure prints its cause', async () => {
  const refused = sink();
  const code = await runApiTokenCommand(
    ['provision'],
    async () => {
      throw new MaintenanceRefusal(
        'API token maintenance could not be completed: no mistri.json configuration could be loaded (pass --config).',
      );
    },
    sink().stream,
    refused.stream,
  );
  assert.equal(code, 2);
  assert.equal(
    refused.chunks.join(''),
    'mistri: API token maintenance could not be completed: no mistri.json configuration could be loaded (pass --config).\n',
  );
  const other = sink();
  await runApiTokenCommand(
    ['provision'],
    async () => {
      throw new Error('PRIVATE_DRIVER_DETAIL');
    },
    sink().stream,
    other.stream,
  );
  // The generic line is only for a failure with no message of its own; one that has one prints it.
  assert.match(other.chunks.join(''), /API token maintenance failed: PRIVATE_DRIVER_DETAIL\. The outcome may be uncertain/);
  const silent = sink();
  await runApiTokenCommand(['provision'], async () => Promise.reject({}), sink().stream, silent.stream);
  assert.match(silent.chunks.join(''), /^mistri: API token maintenance failed\. The outcome may be uncertain/);
});
