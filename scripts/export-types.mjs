/**
 * Whether every public export of a package has declarations it ships.
 *
 * An export is typed by its `types` condition, or, with none, by the `.d.ts` beside its `.js`; a consumer's tsc reads a
 * module with neither as `any` and refuses every declaration that imports it (TS7016). The engine shipped that way
 * once, its declarations never emitted, and only an installed typecheck saw it. This is the one rule, read by the build
 * (scripts/build-packages.mjs, on the checkout's dist/) and by the install proof (scripts/prove-exports.mjs, on the
 * unpacked tarball), and held by test/export-types.test.ts.
 *
 * A pattern (`./*`) names no file of its own, and a target that is not JavaScript (a stylesheet, a JSON schema, a
 * `.d.ts` named directly) is its own type.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/** `[condition, path]` for each file an export target names; `types` appears in the condition of a type target. */
export const targetsOf = (target) =>
  typeof target === 'string'
    ? [['default', target]]
    : Object.entries(target ?? {}).flatMap(([condition, value]) =>
        typeof value === 'string' ? [[condition, value]] : targetsOf(value).map(([inner, path]) => [`${condition}.${inner}`, path]),
      );

/** The exports of `exports` (a package's manifest, as an install reads it) whose declarations are not in `dir`, as `"<subpath> -> <file>"`. */
export function untypedExports(dir, exports = {}) {
  const missing = [];
  for (const [subpath, target] of Object.entries(exports)) {
    if (subpath.includes('*')) continue;
    const leaves = targetsOf(target);
    const typed = leaves.filter(([condition]) => condition.split('.').includes('types'));
    const runtime = leaves.filter(([condition]) => !condition.split('.').includes('types'));
    const wanted = typed.length
      ? typed.map(([, path]) => path)
      : runtime.filter(([, path]) => path.endsWith('.js')).map(([, path]) => path.replace(/\.js$/, '.d.ts'));
    for (const file of wanted) if (!existsSync(join(dir, file))) missing.push(`${subpath} -> ${file.replace(/^\.\//, '')}`);
  }
  return missing;
}
