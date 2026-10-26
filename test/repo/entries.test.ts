/*
 * The package entry points, imported the way a consumer will (scripts/boundary/entries.json): every `@mistriwork/mistri/*` name
 * through its workspace link.
 *
 * check-boundary.mjs --entries holds what each entry imports; this holds what
 * an import of one hands back. A server entry runs here, under tsx, so its values are compared at run time; a client
 * entry (`ui`, `page`, `react`…) runs only under Vite, so test/fixtures/entries/consumer.ts compares it under tsc,
 * and this test holds that fixture to the table.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
interface Entry {
  layer: string;
  source: string;
  types: string | null;
}
const table = JSON.parse(readFileSync(join(root, 'scripts/boundary/entries.json'), 'utf8')) as {
  packages: Record<string, { dir: string }>;
  entries: Record<string, Entry>;
};
const entries = Object.entries(table.entries);
/* A module Node runs under tsx: the server's, and the App DSL's plain JavaScript. The client's import stylesheets. */
const runs = (entry: Entry) => !/^packages\/[^/]+\/src\/(?:client|embed)\//.test(entry.source);
const names = (module: object) => Object.keys(module).sort();

test('each workspace is linked under node_modules to its folder under packages/', () => {
  for (const [name, { dir }] of Object.entries(table.packages))
    assert.equal(realpathSync(join(root, 'node_modules', name)), realpathSync(join(root, dir)), `${name} is not linked; run npm ci`);
});

test('a mistri name resolves through the workspace and exports something', async () => {
  const compared: string[] = [];
  for (const [name, entry] of entries) {
    if (!name.startsWith('@mistriwork/mistri/') || !runs(entry)) continue;
    const resolved = fileURLToPath(import.meta.resolve(name));
    assert.ok(realpathSync(resolved).startsWith(realpathSync(join(root, 'packages/mistri'))), `${name} resolves through the workspace`);
    assert.ok(names(await import(name)).length, `${name} exports nothing`);
    compared.push(name);
  }
  assert.ok(compared.length >= 10, `compared ${compared.length} server entries`);
});

test('the engine and the kit import, and export what their source does', async () => {
  for (const name of ['@mistriwork/engine', '@mistriwork/kit']) {
    const entry = table.entries[name];
    assert.ok(entry, `${name} is in the table`);
    const [ours, source] = await Promise.all([import(name), import(join(root, entry.source))]);
    assert.ok(names(ours).length, `${name} exports nothing`);
    assert.deepEqual(names(ours), names(source));
  }
});

test('the consumer fixture imports every entry', () => {
  const fixture = readFileSync(join(root, 'test/fixtures/entries/consumer.ts'), 'utf8');
  for (const [name, entry] of entries) {
    /* A product's main is its bin (`types: null`), not an import. */
    if (entry.types === null) continue;
    assert.ok(fixture.includes(`from '${name}';`), `consumer.ts does not import ${name}`);
  }
});

test('the workspace root publishes nothing: each package under packages/ is published on its own', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { private?: boolean; bin?: unknown; exports?: unknown };
  assert.equal(pkg.private, true);
  assert.equal(pkg.bin, undefined);
  assert.equal(pkg.exports, undefined);
});
