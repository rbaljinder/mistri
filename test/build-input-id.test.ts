/**
 * A build's id is an input fingerprint (build/fingerprint.ts): the same on every machine that builds the same tree,
 * stamped in the manifest by `mistri build`, and computed by `mistri deploy` from the working tree without building
 * identically. The three tests are those three claims.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { buildInputId } from '../packages/mistri/src/server/build/fingerprint.js';

const cwd = process.cwd();
const project = realpathSync(mkdtempSync(join(tmpdir(), 'mistri-input-id-')));
after(() => {
  process.chdir(cwd);
  rmSync(project, { recursive: true, force: true });
});
writeFileSync(join(project, 'package.json'), '{ "name": "desk", "type": "module" }\n');
writeFileSync(join(project, 'package-lock.json'), '{ "lockfileVersion": 3 }\n');
const app = join(project, 'desk');
mkdirSync(app);
writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
writeFileSync(
  join(app, 'app.json'),
  JSON.stringify({
    id: 'desk',
    name: 'Desk',
    connection: 'desk',
    resources: { item: {} },
    views: { items: { kind: 'list', from: 'item' } },
    home: 'items',
  }),
);
process.chdir(project);

test('two builds of the same inputs into different out dirs share one id, and the deploy computes the same', async () => {
  const a = await buildApp({ app, out: join(project, 'one') }, { typecheck: false });
  const b = await buildApp({ app, out: join(project, 'two') }, { typecheck: false });
  assert.match(a.manifest.id, /^[0-9a-f]{16}$/);
  assert.equal(b.manifest.id, a.manifest.id);
  assert.equal(await buildInputId({ app, out: join(project, 'elsewhere') }), a.manifest.id);
});

test('a changed source file, lockfile or mistri version is a new id; an output or a local database is not', async () => {
  const request = { app, out: join(project, 'one') };
  const before = await buildInputId(request);
  writeFileSync(join(project, 'one-note.txt'), 'outside the App');
  writeFileSync(join(app, 'local.db'), 'rows');
  mkdirSync(join(app, 'node_modules'), { recursive: true });
  writeFileSync(join(app, 'node_modules', 'x.js'), 'installed');
  assert.equal(await buildInputId(request), before);
  assert.notEqual(await buildInputId(request, project, '9.9.9'), before);
  writeFileSync(join(project, 'package-lock.json'), '{ "lockfileVersion": 3, "packages": {} }\n');
  const locked = await buildInputId(request);
  assert.notEqual(locked, before);
  writeFileSync(join(app, 'notes.md'), 'one more file');
  assert.notEqual(await buildInputId(request), locked);
});
