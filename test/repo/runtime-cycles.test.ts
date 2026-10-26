/** File loops do not exist: no two modules reach each other, however far round. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { findCycles, runtimeGraph, runtimeSpecifiers, sourceGraph } from './runtimeCycles.js';

const cycles = (files: Record<string, string>) => findCycles(runtimeGraph(files));

test('AST runtime edges ignore declaration and named-only type syntax', () => {
  assert.deepEqual(
    runtimeSpecifiers(`
    import type X from './type1.js';
    import { type Y, type Z } from './type2.js';
    export type * from './type3.js';
    export { type T } from './type4.js';
    type Q = import('./type5.js').Q;
    import type Old = require('./type6.js');
    // import './comment.js';
    const fake = "import './string.js'";
    import Default, { type A } from './default.js';
    import { type A, B } from './mixed.js';
    export { type A, B } from './mixed-export.js';
    import './side-effect.js';
    import {} from './empty.js';
    export {} from './empty-export.js';
    import * as ns from './namespace.js';
    export * as other from './namespace-export.js';
    import Old = require('./equals.js');
    const lazy = import('./lazy.js');
    require('./common.js');
    import(variable);
  `),
    [
      './common.js',
      './default.js',
      './empty-export.js',
      './empty.js',
      './equals.js',
      './lazy.js',
      './mixed-export.js',
      './mixed.js',
      './namespace-export.js',
      './namespace.js',
      './side-effect.js',
    ],
  );
  assert.deepEqual(cycles({ 'a.ts': 'import {type B} from "./b.js"', 'b.ts': 'import "./a.js"' }).edges, []);
});

test('a mutual import, a longer loop, a lazy import and a self-import are each a cycle', () => {
  assert.deepEqual(cycles({ 'a.ts': 'import "./b.js";', 'b.ts': 'export * from "./a.js";' }).components, [['a.ts', 'b.ts']]);
  const triangle = { 'a.ts': 'import "./b.js"', 'b.ts': 'import "./c.js"', 'c.ts': 'import "./a.js"' };
  assert.deepEqual(cycles(triangle).components, [['a.ts', 'b.ts', 'c.ts']]);
  assert.equal(cycles({ 'a.ts': 'import "./b.js"', 'b.ts': 'const later = () => import("./a.js")' }).components.length, 1);
  assert.deepEqual(cycles({ 'self.ts': 'import "./self.js"' }).components, [['self.ts']]);
});

test('.js-to-TSX resolution and acyclic edges are handled', () => {
  const result = cycles({
    'a.ts': 'import "./view.js"; import "./leaf.js"',
    'view.tsx': 'import "./a.js"',
    'leaf.js': '',
    'self.ts': 'import "./self.js"',
  });
  assert.deepEqual(result.components, [['a.ts', 'view.tsx'], ['self.ts']]);
  assert.equal(result.edges.length, 3);
});

test('the source tree has no runtime import cycles', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const { components, edges } = findCycles(sourceGraph(root));
  assert.deepEqual(
    components,
    [],
    `A file loop is a module that cannot be edited or loaded alone. Break it: move what both need to a leaf, or have the caller hand the dependency in. Cyclic edges:\n${edges.map((edge) => edge.join(' -> ')).join('\n')}`,
  );
});
