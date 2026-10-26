import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { draftFromOpenapi } from '../packages/engine/src/server/openapiDraft.js';

/* `--from-openapi` is a redirect away from a working description: stdout
   must be the description and nothing else, and everything a person should
   read before trusting it goes to stderr. */
const SPEC = fileURLToPath(new URL('./fixtures/http/openapi.json', import.meta.url));
const capture = () => {
  let text = '';
  return {
    write: (chunk: string) => {
      text += chunk;
    },
    get text() {
      return text;
    },
  };
};

test('stdout is exactly the description, hashed from the bytes read; notes go to stderr', async () => {
  const out = capture(),
    err = capture();
  assert.equal(await draftFromOpenapi(SPEC, out, err), 0);
  const description = readDescription(JSON.parse(out.text), 'stdout');
  assert.deepEqual(
    description.resources.map((resource) => resource.name),
    ['contacts', 'tickets'],
  );
  assert.deepEqual(description.spec, { file: 'openapi.json', sha256: createHash('sha256').update(readFileSync(SPEC)).digest('hex') });
  assert.match(err.text, /^guessed {2}contacts: paging: offset/m);
  assert.match(err.text, /^skipped {2}GET \/partners: the remote \$ref/m);
  assert.match(err.text, /2 resources drafted from Desk API 1\.2\.0/);
});

test('a spec it cannot read is refused with the reason and exit 1, and stdout stays empty', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-openapi-'));
  try {
    const cases: Array<[string, string, RegExp]> = [
      ['spec.yaml', 'openapi: 3.1.0\npaths: {}\n', /is not JSON .*convert a YAML one first/],
      ['swagger.json', JSON.stringify({ swagger: '2.0', paths: {} }), /Swagger 2\.0 document/],
      [
        'empty.json',
        JSON.stringify({ openapi: '3.1.0', info: { title: 'Empty', version: '1' }, paths: {} }),
        /No resource could be drafted/,
      ],
    ];
    for (const [name, text, message] of cases) {
      writeFileSync(join(dir, name), text);
      const out = capture(),
        err = capture();
      assert.equal(await draftFromOpenapi(join(dir, name), out, err), 1, name);
      assert.match(err.text, message, name);
      assert.equal(out.text, '', `${name}: nothing a connection could read reaches stdout`);
    }
    const out = capture(),
      err = capture();
    assert.equal(await draftFromOpenapi(join(dir, 'missing.json'), out, err), 1);
    assert.match(err.text, /no spec file at/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
