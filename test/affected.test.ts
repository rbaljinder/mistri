import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runtimeSpecifiers } from '../scripts/importGraph.mjs';
import { needlesFor, select } from '../scripts/affected.mjs';

test('affected: only runtime imports are edges', () => {
  const text = [
    "import { a } from './runtime.js';",
    "import type { B } from './type-only.js';",
    "import { type C, type D } from './all-type.js';",
    "import { type E, f } from './mixed.js';",
    "import def, { type G } from './default.js';",
    "export type { H } from './export-type.js';",
    "export { i } from './reexport.js';",
    "import './side-effect.js';",
    "type J = import('./inline-type.js').J;",
    "type K = typeof import('./typeof.js');",
    "const l = await import('./dynamic.js');",
    "import('./then.js').then(() => 1);",
    "import {\n  type M,\n  type N,\n} from './multiline-type.js';",
  ].join('\n');
  assert.deepEqual(runtimeSpecifiers(text).sort(), [
    './default.js',
    './dynamic.js',
    './mixed.js',
    './reexport.js',
    './runtime.js',
    './side-effect.js',
    './then.js',
  ]);
});

test('affected: a fixture is named by its path, folder or file, never by a generic name', () => {
  const needles = needlesFor('test/fixtures/apps/ignition/assignment.ts');
  assert.ok(needles.includes('apps/ignition/assignment.ts'));
  assert.ok(needles.includes('ignition'));
  assert.ok(!needles.includes('apps'));
  assert.ok(!needlesFor('test/fixtures/apps/tick/app.ts').includes('app.ts'));
});

test('affected: selection is narrow where the graph and names allow', () => {
  const reaches = new Map([
    ['test/uses-pg.test.ts', new Set(['test/uses-pg.test.ts', 'packages/engine/src/adapters/postgres.ts'])],
    ['test/registry.test.ts', new Set(['test/registry.test.ts', 'packages/engine/src/adapters/postgres.ts'])],
  ]);
  // Both reach the adapter; only the suite whose text mentions the dialect is selected.
  const read = (file: string) => (file === 'test/uses-pg.test.ts' ? 'new PostgresAdapter(process.env.TABLEWALK_TEST_PG)' : '');
  assert.deepEqual(select(['packages/engine/src/adapters/postgres.ts'], reaches, read).chosen, ['test/uses-pg.test.ts']);
  assert.equal(select(['packages/engine/src/adapters/postgres.ts'], reaches, read).blind.length, 0);
  assert.equal(select(['packages/mistri/schema/app.d.ts'], reaches, read).chosen.length, 2);
  assert.deepEqual(select(['test/fixtures/nobody-names-this-file.json'], reaches, read).chosen, []);
});
