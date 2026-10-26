/**
 * The import graph `scripts/affected.mjs` walks: what a file imports at
 * runtime, resolved to files on disk. `.js` on disk is `.ts` or `.tsx`, the
 * way this repository's own imports are written.
 *
 * Type-only edges are left out. tsc already guards them, and they are not
 * edges of what runs: `import type`, `export type … from`, a brace list whose
 * every specifier is `type`, and `import('./x').T` or `typeof import('./x')`
 * written as a type. Counting them made `app/apps.ts` reach `auth/auth.ts`
 * (one `import('../auth/auth.js').AppAuthRuntime`), and with it most suites.
 *
 * A package's modules import another package's by name (`@mistriwork/engine/shared/page.js`), which is followed through
 * that package's `exports` as this checkout answers them (from src/); any other bare name is a dependency, not ours.
 */
import { readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const rel = (path) => relative(ROOT, path).split('\\').join('/');

// import/export clause: default, namespace, or a brace list, with an optional leading default.
const CLAUSE = String.raw`(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\}|[\w$]+(?:\s*,\s*(?:\*\s+as\s+[\w$]+|\{[^}]*\}))?)`;
/* A relative specifier, or a workspace package's name: what the graph follows. */
const OURS = String.raw`(\.[^'"]+|(?:@mistriwork\/[\w-]+|tablewalk)(?:\/[^'"]*)?)`;
const STATEMENT = new RegExp(String.raw`(?:^|[;{}\n])\s*(import|export)\s+(type\s+)?(${CLAUSE})\s*from\s*['"]${OURS}['"]`, 'g');
const SIDE_EFFECT = new RegExp(String.raw`^\s*import\s+['"]${OURS}['"]`, 'gm');
const DYNAMIC = new RegExp(String.raw`(typeof\s+)?import\(\s*['"]${OURS}['"]\s*\)(?:\s*\.\s*([\w$]+))?`, 'g');

/** Each workspace package by name: its folder and its exports, as this checkout's manifests write them. */
const PACKAGES = new Map(
  Object.values(JSON.parse(readFileSync(join(ROOT, 'scripts/boundary/entries.json'), 'utf8')).packages).map(({ dir }) => {
    const manifest = JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf8'));
    return [manifest.name, { dir, exports: manifest.exports ?? {} }];
  }),
);

/** The checkout's answer for an export target: its `default`, under whatever conditions wrap it. */
const sourceTarget = (target) =>
  typeof target === 'string' ? target : target && typeof target === 'object' ? sourceTarget(target.default) : undefined;

/** A workspace package's name resolved to a path on disk (before extensions), or undefined. */
function workspaceTarget(specifier) {
  const parts = specifier.split('/');
  const size = specifier.startsWith('@') ? 2 : 1;
  const pkg = PACKAGES.get(parts.slice(0, size).join('/'));
  if (!pkg) return undefined;
  const subpath = parts.length > size ? `./${parts.slice(size).join('/')}` : '.';
  let target = sourceTarget(pkg.exports[subpath]);
  if (!target)
    for (const [key, value] of Object.entries(pkg.exports)) {
      if (!key.endsWith('*') || !subpath.startsWith(key.slice(0, -1))) continue;
      target = sourceTarget(value)?.replace('*', subpath.slice(key.length - 1));
      break;
    }
  return target && join(ROOT, pkg.dir, target);
}

/** The runtime specifiers in a source text, as written. Pure, for tests. */
export function runtimeSpecifiers(text) {
  const out = [];
  for (const [, , isType, clause, specifier] of text.matchAll(STATEMENT)) {
    if (isType) continue;
    const braces = clause.match(/^(?:[\w$]+\s*,\s*)?\{([^}]*)\}$/);
    const hasDefault = /^[\w$]+\s*,/.test(clause);
    if (braces && !hasDefault) {
      const names = braces[1]
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean);
      if (names.length && names.every((name) => /^type\s/.test(name))) continue;
    }
    out.push(specifier);
  }
  for (const [, specifier] of text.matchAll(SIDE_EFFECT)) out.push(specifier);
  for (const [, isTypeof, specifier, member] of text.matchAll(DYNAMIC)) {
    if (isTypeof) continue;
    // import() returns a Promise, so a member other than then/catch/finally can only be a type: `import('./x').T`.
    if (member && !/^(then|catch|finally)$/.test(member)) continue;
    out.push(specifier);
  }
  return out;
}

const cache = new Map();
const texts = new Map();

/** A file's text, read once. */
export function textOf(file) {
  if (!texts.has(file)) {
    let text = '';
    try {
      text = readFileSync(resolve(ROOT, file), 'utf8');
    } catch {
      /* a deleted file imports nothing */
    }
    texts.set(file, text);
  }
  return texts.get(file);
}

const isFile = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** Everything a file imports at runtime, resolved to files on disk. Memoized: the graph is walked from every suite. */
export function importsOf(file) {
  if (cache.has(file)) return cache.get(file);
  const out = [];
  for (const specifier of runtimeSpecifiers(textOf(file))) {
    const base = specifier.startsWith('.') ? join(dirname(resolve(ROOT, file)), specifier) : workspaceTarget(specifier);
    if (!base) continue;
    const candidates = [
      base,
      base.replace(/\.js$/, '.ts'),
      base.replace(/\.js$/, '.tsx'),
      `${base}.ts`,
      `${base}.tsx`,
      `${base}.js`,
      join(base, 'index.ts'),
    ];
    const found = candidates.find(isFile);
    if (found) out.push(rel(found));
  }
  cache.set(file, out);
  return out;
}
