import assert from 'node:assert/strict';
import { test } from 'node:test';
import { constants, mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compareOpenApiFiles } from '../packages/mistri/src/server/cli/compareOpenApi.js';

const supported = [constants.O_NOFOLLOW, constants.O_NONBLOCK].every(
  (flag) => typeof flag === 'number' && Number.isInteger(flag) && flag !== 0,
);
const supportedOnly = { skip: !supported && 'Safe file-open flags unavailable on this platform' };

test('unsupported file-open capabilities refuse before file access, including drive-letter paths', { skip: supported }, async () => {
  // No temporary files or symlinks: refusal must precede any acquisition.
  for (const path of ['missing.json', 'C:\\missing\\previous.json', 'C:/missing/previous.json']) {
    await assert.rejects(compareOpenApiFiles(path, 'current.json'), /unsupported on this platform/);
  }
});

function preview() {
  return {
    openapi: '3.1.0',
    info: { title: 'Local preview', version: '1' },
    servers: [{ url: '/api/apps/local/v1' }],
    security: [{ bearer: [] }],
    paths: {},
    components: { schemas: {}, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
    'x-mistri-document': 'app-api-reads',
    'x-mistri-integer-representation': 'decimal-string',
    'x-mistri-omitted-request-features': ['fields'],
  };
}
function files(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-spec-compare-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const previous = join(dir, 'previous.json'),
    current = join(dir, 'current.json');
  writeFileSync(previous, JSON.stringify(preview()));
  writeFileSync(current, JSON.stringify(preview()));
  return { dir, previous, current };
}

test('file comparison returns existing conservative version results without output or hosts', supportedOnly, async (t) => {
  const f = files(t);
  assert.equal((await compareOpenApiFiles(f.previous, f.current)).versionRequirementMet, true);
  const current = preview();
  current['x-mistri-integer-representation'] = 'number';
  writeFileSync(f.current, JSON.stringify(current));
  let result = await compareOpenApiFiles(f.previous, f.current);
  assert.equal(result.requiresVersionBump, true);
  assert.equal(result.versionRequirementMet, false);
  current.info.version = '2';
  current.servers[0].url = '/api/apps/local/v2';
  writeFileSync(f.current, JSON.stringify(current));
  result = await compareOpenApiFiles(f.previous, f.current);
  assert.equal(result.versionRequirementMet, true);
  assert.equal(result.compatibilityProof, 'not-established');
});

test('bounded local files reject missing paths, directories, symlinks, URLs and FIFOs', supportedOnly, async (t) => {
  const f = files(t),
    link = join(f.dir, 'link');
  symlinkSync(f.previous, link);
  for (const path of [join(f.dir, 'missing'), f.dir, link, 'https://example.test/secret.json', 'file:///tmp/test.json']) {
    await assert.rejects(compareOpenApiFiles(path, f.current), /OpenAPI comparison: previous/);
  }
  if (process.platform !== 'win32') {
    const fifo = join(f.dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    await assert.rejects(compareOpenApiFiles(fifo, f.current), /regular file/);
  }
});

test('1 MiB boundary is byte-based and malformed JSON or UTF-8 has safe contextual errors', supportedOnly, async (t) => {
  const f = files(t),
    json = JSON.stringify(preview());
  writeFileSync(f.previous, json.padEnd(1_048_576, ' '));
  assert.equal((await compareOpenApiFiles(f.previous, f.current)).versionRequirementMet, true);
  writeFileSync(f.previous, json.padEnd(1_048_577, ' '));
  await assert.rejects(compareOpenApiFiles(f.previous, f.current), /previous file exceeds the 1 MiB/);
  writeFileSync(f.previous, json);
  for (const bad of ['{"SECRET_DO_NOT_ECHO":', '', Buffer.from([0xff, 0xfe]), `"${'😀'.repeat(300000)}"`]) {
    writeFileSync(f.current, bad);
    await assert.rejects(compareOpenApiFiles(f.previous, f.current), (error) => {
      assert.match((error as Error).message, /OpenAPI comparison: current/);
      assert.doesNotMatch((error as Error).message, /SECRET_DO_NOT_ECHO|😀/);
      return true;
    });
  }
});

test('unsupported documents and remote schema references refuse without fetching', supportedOnly, async (t) => {
  const f = files(t);
  writeFileSync(f.current, JSON.stringify({ openapi: '3.0.0' }));
  await assert.rejects(compareOpenApiFiles(f.previous, f.current), /supported mistri private read previews/);
  const foreign = preview();
  Object.assign(foreign.components.schemas, { external: { $ref: 'https://example.test/SECRET' } });
  writeFileSync(f.current, JSON.stringify(foreign));
  await assert.rejects(compareOpenApiFiles(f.previous, f.current), (error) => {
    assert.match((error as Error).message, /without remote references/);
    assert.doesNotMatch((error as Error).message, /SECRET|example.test/);
    return true;
  });
});
