/** Authored sources run directly on Node: relative runtime imports must name real files. */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { formerExamples } from './support/exampleApps.js';
import { parseFile } from './support/tsc.js';

test('public samples do not rely on tsx to resolve nonexistent runtime .js imports', () => {
  const missing: string[] = [];
  // The fixtures that were examples, and their seeds, are still run directly on Node.
  for (const root of [
    'examples/apps',
    'examples/databases',
    'test/fixtures/databases',
    ...formerExamples.map((app) => `test/fixtures/apps/${app}`),
  ]) {
    const files = readdirSync(root, { recursive: true, encoding: 'utf8' }).filter(
      (file) => /\.(ts|mjs|js)$/.test(file) && !file.endsWith('.d.ts'),
    );
    for (const file of files) {
      const path = join(root, file);
      const source = parseFile(path);
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue;
        if (ts.isImportDeclaration(statement) && statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
        if (ts.isExportDeclaration(statement) && statement.isTypeOnly) continue;
        const specifier = statement.moduleSpecifier;
        if (!specifier || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('.')) continue;
        const bindings = ts.isImportDeclaration(statement) ? statement.importClause?.namedBindings : statement.exportClause;
        if (
          ts.isImportDeclaration(statement) &&
          bindings &&
          ts.isNamedImports(bindings) &&
          !statement.importClause?.name &&
          bindings.elements.every((binding) => binding.isTypeOnly)
        )
          continue;
        if (!existsSync(resolve(dirname(path), specifier.text))) missing.push(`${path}: ${specifier.text}`);
      }
    }
  }
  assert.deepEqual(missing, [], 'Node does not substitute .ts for a .js import');
});
