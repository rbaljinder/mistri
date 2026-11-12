/**
 * What the stylesheets of an App's own dependencies declare, for `mistri upgrade`'s token rule (upgrade.ts): a
 * `var(--border)` is the looks' renamed token unless a library the App uses sets `--border` itself.
 *
 * Only the packages the App's own package.json names are read (dependencies, devDependencies, peerDependencies), and
 * only their CSS, for declarations. Never a dependency's dependencies: the App did not choose those, and walking the
 * tree would make the answer depend on how a package manager laid it out.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, parse } from 'node:path';

/* mistri's own packages are what the tokens are renamed to: their stylesheets are not another library's. */
const OWN = /^(?:@mistriwork\/|mistri$|tablewalk$)/;
const MAX_FILES_PER_PACKAGE = 4000;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

/** The nearest package.json at or above `root`, which is the App's own. */
function appPackage(root: string): string | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, 'package.json');
    if (existsSync(file)) return file;
    if (dir === parse(dir).root) return undefined;
  }
}

/** Where `name` is installed for the package at `from`: the nearest node_modules up the tree that holds it. */
function installed(from: string, name: string): string | undefined {
  for (let dir = dirname(from); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name);
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return candidate;
    if (dir === parse(dir).root) return undefined;
  }
}

/** The css files under a package, without its own node_modules. */
function stylesheetsIn(dir: string): string[] {
  const found: string[] = [];
  const pending = [dir];
  for (let next = pending.pop(); next !== undefined && found.length < MAX_FILES_PER_PACKAGE; next = pending.pop()) {
    for (const entry of readdirSync(next, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') pending.push(join(next, entry.name));
      } else if (entry.name.endsWith('.css')) found.push(join(next, entry.name));
    }
  }
  return found;
}

/**
 * Each of `tokens` that a dependency of the App's own package.json declares in its CSS (`--border: …`), with the first
 * package that does. A package that is not installed has nothing to read.
 */
export function dependencyDeclarations(root: string, tokens: ReadonlySet<string>): Map<string, string> {
  const declaredBy = new Map<string, string>();
  const manifest = appPackage(root);
  if (!manifest) return declaredBy;
  let listed: Record<string, Record<string, string> | undefined>;
  try {
    listed = JSON.parse(readFileSync(manifest, 'utf8')) as typeof listed;
  } catch {
    return declaredBy;
  }
  const names = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies']
      .flatMap((field) => Object.keys(listed[field] ?? {}))
      .filter((name) => !OWN.test(name)),
  );
  for (const name of [...names].sort()) {
    const dir = installed(manifest, name);
    if (!dir) continue;
    for (const file of stylesheetsIn(dir)) {
      if (statSync(file).size > MAX_FILE_BYTES) continue;
      for (const match of readFileSync(file, 'utf8').matchAll(/(?:^|[\s{;])(--[A-Za-z][\w-]*)\s*:/g)) {
        const token = match[1]!;
        if (tokens.has(token) && !declaredBy.has(token)) declaredBy.set(token, name);
      }
    }
  }
  return declaredBy;
}
