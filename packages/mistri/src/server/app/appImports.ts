/*
 * An App module that imports a name `@mistriwork/mistri/app` no longer exports fails
 * the load at the first one Node meets, and the next on the next try: a
 * field report counted four removed helpers across one App, found one
 * reload at a time. This reads every import of `@mistriwork/mistri/app` in the App's
 * own modules against what the package really exports, before anything is
 * evaluated, and says all of them at once, each with what replaces it.
 * No alias is kept for a removed name; the message is the migration.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { nearest } from '@mistriwork/engine/shared/suggest.js';

/** What a display helper that no longer exists is written as now. */
const REMOVED: Record<string, string> = {
  money: "write the rule as data: `{ format: 'money', currency: 'EUR', unit: '/mo' }`",
  number: "write the rule as data: `{ format: 'number', unit: 'mi' }`",
  percent: "write the rule as data: `{ format: 'percent', bar: true }`",
  relative: "write the rule as data: `{ format: 'relative' }`",
  items: "write the rule as data: `{ format: 'items' }`",
  tones: "write the rule as data: `{ tone: { paid: 'good', void: 'bad' } }`",
};

interface MissingImport {
  file: string;
  name: string;
  /** What to do instead, when it is known. */
  instead: string;
}

/** The names `import { … }` and `export { … } from` take from `@mistriwork/mistri/app` in a module's text, comments removed, types left out. */
export function importedFromApp(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const names: string[] = [];
  const pattern = /\b(?:import|export)\s+(?!type\b)(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]@mistriwork\/mistri\/app['"]/g;
  for (const match of code.matchAll(pattern)) {
    for (const part of match[1].split(',')) {
      const item = part.trim();
      if (!item || /^type\s/.test(item)) continue;
      names.push(item.split(/\s+as\s+/)[0].trim());
    }
  }
  return names;
}

async function moduleFiles(dir: string, found: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await moduleFiles(path, found);
    else if (/\.(?:ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

let exported: Promise<Set<string>> | undefined;
/** The runtime exports of `@mistriwork/mistri/app`: the one file the package maps it to, read from beside this one wherever it runs (src or dist). */
function appExports(): Promise<Set<string>> {
  exported ??= import(new URL('../../../schema/app.mjs', import.meta.url).href).then((mod) => new Set(Object.keys(mod)));
  return exported;
}

/** Every import of a name `@mistriwork/mistri/app` does not export, across the App's modules. */
export async function missingAppImports(dir: string, extra: readonly string[] = []): Promise<MissingImport[]> {
  const have = await appExports();
  const files = [...new Set([...(await moduleFiles(dir)), ...extra])];
  const missing: MissingImport[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8').catch(() => '');
    if (!source.includes('@mistriwork/mistri/app')) continue;
    for (const name of new Set(importedFromApp(source))) {
      if (have.has(name)) continue;
      const near = nearest(name, [...have]);
      missing.push({
        file,
        name,
        instead: REMOVED[name] ?? (near ? `did you mean "${near}"?` : 'it is not part of @mistriwork/mistri/app any more'),
      });
    }
  }
  return missing;
}

/** The refusal: one line per import, the whole App's worth. */
export function missingImportsMessage(missing: readonly MissingImport[], root: string): string {
  const lines = missing.map(
    ({ file, name, instead }) =>
      `  ${file.startsWith(root) ? file.slice(root.length).replace(/^[\\/]/, '') : file}: "${name}" — ${instead}`,
  );
  return (
    `${missing.length} import${missing.length === 1 ? '' : 's'} from "@mistriwork/mistri/app" name${missing.length === 1 ? 's' : ''} something it no longer exports:\n` +
    `${lines.join('\n')}\nRemoved helpers are not kept as aliases; replace each as shown.`
  );
}
