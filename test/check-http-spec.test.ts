import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { after, test } from 'node:test';
import { readOpenApi } from '../packages/engine/src/adapters/http/openapi.js';
import { draftDescription } from '../packages/engine/src/adapters/http/httpDescription.js';
import { httpSpecFindings } from '../packages/mistri/src/server/build/checkHttpSpec.js';

/* `mistri check` holds an HTTP description to the spec it pins: the file it was drafted from and the columns that
   spec's response schemas give. */
const FIXTURE = new URL('./fixtures/http/openapi.json', import.meta.url);

const made: string[] = [];
after(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** A folder with the spec and the description drafted from it, and the connection that names the description. */
function folder(edit: (description: any) => void = () => {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-http-spec-'));
  made.push(dir);
  const spec = join(dir, 'openapi.json');
  copyFileSync(FIXTURE, spec);
  const bytes = readFileSync(spec);
  const description: any = JSON.parse(
    JSON.stringify(
      draftDescription(readOpenApi(JSON.parse(bytes.toString('utf8'))), {
        file: 'openapi.json',
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }),
    ),
  );
  edit(description);
  const descriptionPath = join(dir, 'desk.http.json');
  writeFileSync(descriptionPath, JSON.stringify(description));
  return { spec, connection: { name: 'desk', http: { description: 'desk.http.json', descriptionPath } } };
}
const codes = async (made: ReturnType<typeof folder>) => (await httpSpecFindings([made.connection])).map((found) => found.code);

test('an unchanged spec passes', async () => {
  assert.deepEqual(await codes(folder()), []);
});

test('a spec edited after the description was drafted fails on its hash, with the fix', async () => {
  const made = folder();
  writeFileSync(made.spec, readFileSync(made.spec, 'utf8').replace('"title"', '"title" '));
  const found = await httpSpecFindings([made.connection]);
  assert.deepEqual(
    found.map((each) => [each.code, each.severity]),
    [['http-spec-changed', 'error']],
  );
  assert.match(found[0]!.fix, /--from-openapi/);
});

/** Rewrite the spec's Contact schema, so the spec moves on from the one the description pins. */
function editContact(made: ReturnType<typeof folder>, edit: (properties: any) => void) {
  const spec = JSON.parse(readFileSync(made.spec, 'utf8'));
  edit(spec.components.schemas.Contact.properties);
  writeFileSync(made.spec, JSON.stringify(spec));
}

test('columns corrected by hand against an unchanged spec pass: the reviewed description owns them', async () => {
  const made = folder((description) => {
    const contacts = description.resources.find((each: any) => each.columns.some((column: any) => column.name === 'score'));
    contacts.columns.find((column: any) => column.name === 'score').type = 'integer';
    contacts.columns.push({ name: 'nickname', type: 'string', nullable: true, readOnly: false });
  });
  assert.deepEqual(await codes(made), []);
});

test('a spec that drops a declared column fails on it, beside the hash', async () => {
  const made = folder();
  editContact(made, (properties) => delete properties.tag);
  const found = await httpSpecFindings([made.connection]);
  assert.deepEqual(
    found.map((each) => each.code),
    ['http-spec-changed', 'http-column-missing'],
  );
  assert.match(found[1]!.message, /\.tag is not in the response schema/);
});

test('a spec that retypes a declared column fails on it, beside the hash', async () => {
  const made = folder();
  editContact(made, (properties) => (properties.vip = { type: 'string' }));
  const found = await httpSpecFindings([made.connection]);
  assert.deepEqual(
    found.map((each) => each.code),
    ['http-spec-changed', 'http-column-type'],
  );
  assert.match(found[1]!.message, /\.vip is "boolean" in the description and "string"/);
});

test('a spec that is gone is a warning, and a description with no file has nothing to check', async () => {
  const made = folder();
  const gone = { name: 'desk', http: { description: 'x', descriptionPath: join(tmpdir(), 'no-such', 'desk.http.json') } };
  assert.deepEqual(await httpSpecFindings([gone]), []);
  writeFileSync(
    made.spec.replace('openapi.json', 'desk.http.json'),
    JSON.stringify({
      ...JSON.parse(readFileSync(made.spec.replace('openapi.json', 'desk.http.json'), 'utf8')),
      spec: { file: 'missing.json', sha256: 'a'.repeat(64) },
    }),
  );
  const found = await httpSpecFindings([made.connection]);
  assert.deepEqual(
    found.map((each) => [each.code, each.severity]),
    [['http-spec-missing', 'warning']],
  );
});
