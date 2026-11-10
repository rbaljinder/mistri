/**
 * What an App's project needs before mistri can load and check it: a
 * package.json that says `"type": "module"` (an App's modules are ES modules,
 * and `npm init` writes "commonjs"), and TypeScript 7 or later. Said where a project is set up — `agent init`, `--scaffold-app` into
 * a project that already has a package.json — and refused where it is
 * checked, each with the one command that fixes it.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { meetsMinimum, nearestPackage, TYPESCRIPT_FIX } from '../build/typecheck.js';

const MODULE_FIX = 'npm pkg set type=module';

/** One sentence when the package.json over `dir` does not make its modules ES modules. */
export function moduleTypeProblem(dir: string, name: (path: string) => string = (path) => path): string | undefined {
  const found = nearestPackage(dir);
  if (!found || found.type === 'module') return undefined;
  const says = found.type === undefined ? 'has no "type"' : `says "type": ${JSON.stringify(found.type)}`;
  return `${name(found.path)} ${says}, so Node reads the App's modules as CommonJS; they are ES modules. Set "type": "module" (${MODULE_FIX}).`;
}

/**
 * Why Node reads this module as CommonJS, said as the clause after "loaded as CommonJS": its extension, or the
 * package.json over it. Undefined where it is read as an ES module (`.mts`, `.mjs`, or under `"type": "module"`).
 */
export function commonJsReason(file: string, name: (path: string) => string = (path) => path): string | undefined {
  if (/\.m[jt]s$/.test(file)) return undefined;
  const extension = /\.c[jt]s$/.exec(file)?.[0];
  if (extension) return `it is a ${extension} file`;
  const found = nearestPackage(dirname(resolve(file)));
  if (!found) return 'no package.json above it says "type": "module"';
  if (found.type === 'module') return undefined;
  return `${name(found.path)} ${found.type === undefined ? 'has no "type"' : `says "type": ${JSON.stringify(found.type)}`}`;
}

/** One sentence when the TypeScript a project resolves is missing or older than 7. */
export function typescriptProblem(dir: string): string | undefined {
  let version: string;
  try {
    version = (
      JSON.parse(readFileSync(createRequire(join(resolve(dir), 'package.json')).resolve('typescript/package.json'), 'utf8')) as {
        version: string;
      }
    ).version;
  } catch {
    return `TypeScript is not installed here; mistri check typechecks the App with it (${TYPESCRIPT_FIX}).`;
  }
  return meetsMinimum(version) ? undefined : `TypeScript ${version} is older than 7, which mistri check needs (${TYPESCRIPT_FIX}).`;
}
