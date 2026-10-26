#!/usr/bin/env node
/*
 * The package entry points, read from scripts/boundary/entries.json, and what the workspace root must agree with.
 *
 * Each package under packages/ owns its sources, and each entry the table names is in its package's `exports`,
 * pointed at its source. The database browser (`tablewalk`) publishes none of the App framework's names: an App
 * imports `mistri/*`, and the browser installs and runs without mistri.
 *
 *   node scripts/boundary/entries.mjs --check   exit 1 when the root's workspaces differ from the table's packages
 *
 * check-boundary.mjs --entries runs the same comparison, beside the checks of what each entry imports
 * (docs/boundary.md, "Entries").
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ENTRIES = 'scripts/boundary/entries.json';

export const readEntries = (root) => JSON.parse(readFileSync(join(root, ENTRIES), 'utf8'));

/** The package an entry name belongs to (`@mistriwork/mistri/react/next` → `mistri`), and its subpath (`./react/next`, or `.`). */
export function splitName(name) {
  const parts = name.split('/');
  const size = name.startsWith('@') ? 2 : 1;
  const pkg = parts.slice(0, size).join('/');
  const rest = parts.slice(size).join('/');
  return { pkg, subpath: rest ? `./${rest}` : '.' };
}

/** What the workspace root says that the table does not: its `workspaces` are the table's packages. */
export function workspaceProblems(root, table = readEntries(root)) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const workspaces = [...(pkg.workspaces ?? [])].sort();
  const dirs = Object.values(table.packages)
    .map((entry) => entry.dir)
    .sort();
  return JSON.stringify(workspaces) === JSON.stringify(dirs)
    ? []
    : [`package.json "workspaces" is ${JSON.stringify(workspaces)}; the table's packages are ${JSON.stringify(dirs)}.`];
}

function main() {
  const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
  const problems = workspaceProblems(root);
  for (const problem of problems) console.error(`entries: ${problem}`);
  if (!problems.length) console.log('entries: the workspaces match scripts/boundary/entries.json.');
  return problems.length ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
