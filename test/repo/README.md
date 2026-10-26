# Runtime dependency cycles

`runtime-cycles.test.ts` runs in the ordinary Node gate. The TypeScript AST
collects runtime imports and re-exports, including side effects, literal dynamic
imports and literal `require` calls. Declaration-level `type` and named-only
type imports/exports do not contribute edges. It resolves relative source
references, including emitted `.js` names pointing at `.ts`/`.tsx` files.

There is no allowance: the test fails on any cycle, with the edges that form
it. To inspect the graph, from the repository root:

```sh
npx tsx --eval 'import { findCycles, sourceGraph } from "./test/repo/runtimeCycles.ts"; console.log(JSON.stringify(findCycles(sourceGraph(process.cwd())), null, 2))'
```

Break a cycle by moving what both files need to a leaf, or by having the
caller hand the dependency in (a store never imports the component that imports
it; the shell registers it). Run `npx tsx --test test/repo/runtime-cycles.test.ts`.

This is a conservative source graph, not an execution trace. Lazy imports count
even when not called; unmarked imports count even when used only as types.
Computed module names, package/self-reference/path aliases, loader transformations,
generated files, and dependencies outside non-test `src/` are not followed.
Literal `require` calls count even if the name is locally shadowed. Resolution
uses the repository's source-extension conventions, not a full bundler resolver.
This guard therefore keeps the visible static graph acyclic; it does not
prove the absence of runtime initialization problems or replace boundary tests.
