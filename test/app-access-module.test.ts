import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isExportDeclaration, isImportDeclaration, isStringLiteral } from 'typescript/unstable/ast';
import { parseFile } from './support/tsc.js';
import * as app from '../packages/mistri/src/shared/app.js';
import * as access from '../packages/mistri/src/shared/appAccess.js';

test('App access compatibility exports retain the same function identity', () => {
  const names = [
    'resolveAppAccess',
    'appActionGrants',
    'appCommandGrants',
    'appOperationsGrants',
    'appCeilingWarnings',
    'appAllowsWrite',
    'appDeletable',
    'appExportable',
    'appMissingTables',
    'writeScopeRefusal',
    'rowPolicyAppShape',
    'tenantAppShape',
    'tenantBusinessApp',
  ] as const;
  assert.deepEqual(Object.keys(access).sort(), [...names].sort());
  for (const name of names) assert.equal(app[name], access[name], name);
});

test('catalog access depends on the grant model, not the App parser or transports', () => {
  const file = parseFile(fileURLToPath(new URL('../packages/mistri/src/shared/appAccess.ts', import.meta.url)));
  const dependencies = file.statements.flatMap((statement) => {
    if (!isImportDeclaration(statement) && !isExportDeclaration(statement)) return [];
    return statement.moduleSpecifier && isStringLiteral(statement.moduleSpecifier) ? [statement.moduleSpecifier.text] : [];
  });
  assert.deepEqual(dependencies.sort(), ['./appAuthGrants.js', './appModel.js', '@mistriwork/engine/shared/schema.js']);
});
