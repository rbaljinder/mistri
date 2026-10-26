/*
 * Spellings and fallbacks that were removed, kept removed. Each was a second
 * way to say something the product already says one way — a former product
 * name, an argument alias, an old link format, an upgrade from a layout no
 * release shipped — and each is pinned here so it cannot come back quietly.
 */
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { parseFile } from '../support/tsc.js';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configLocations } from '../../packages/engine/src/server/config/locations.js';
import { credentialsPath } from '../../packages/engine/src/server/auth/credentials.js';
import { inPackages } from '../support/packages.js';

const root = fileURLToPath(new URL('../..', import.meta.url));
const read = (file: string) => readFileSync(join(root, file), 'utf8');
const sources = inPackages('src')
  .flatMap((dir) =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' }).map((file) => `${dir}/${file.split('\\').join('/')}`),
  )
  .filter((file) => /\.(ts|tsx|js|mjs|css|html)$/.test(file) && !/\.test\.(ts|tsx)$/.test(file));
const carrying = (pattern: RegExp, within = /^packages\/[^/]+\/src\//) =>
  sources.filter((file) => within.test(file) && pattern.test(read(file)));

/* An optional third entry narrows where the spelling is looked for: the sign-in
   store's version 2 is a layout a release shipped, upgraded by a store step
   (storeLayouts.ts), not the command journal's that none did. */
const REMOVED: Array<[string, RegExp, RegExp?]> = [
  ['the former product name', /datawalk/i],
  ['the former keychain service', /FORMER_SERVICE/],
  ['a second auth-secret name', /TABLEWALK_AUTH_SECRET/],
  ['an argument alias on an MCP tool', /Deprecated alias/],
  ['an App-mode `conn` owner stripped in transit', /_legacyOwner|\['app',\s*'conn'\]/],
  ['comma-joined reference segments', /columns\.join\(','\)\s*===/],
  ['a version-2 command journal', /version-2|version2\b|from\?: 2\b/, /^packages\/[^/]+\/src\/(?!adapters\/auth\/)/],
];
for (const [what, pattern, within] of REMOVED) {
  test(`src/ carries no ${what}`, () => assert.deepEqual(carrying(pattern, within), []));
}

test('client requests name their owner through ownedBy, never a `conn` field an App server refuses', () => {
  const client = sources.filter((file) => /^packages\/[^/]+\/src\/client\//.test(file) && /\.(ts|tsx|js)$/.test(file));
  // Inspect constructed objects, not destructuring that reads an incoming selector.
  const sending = client.filter((file) => {
    const source = parseFile(join(root, file));
    let found = false;
    const walk = (node: ts.Node): void => {
      if (
        ts.isObjectLiteralExpression(node) &&
        node.properties.some(
          (property) =>
            (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)) && property.name.getText(source) === 'conn',
        )
      )
        found = true;
      node.forEachChild(walk);
    };
    walk(source);
    return found;
  });
  assert.deepEqual(sending, []);
});

test('boot reads the path, never a #/ fragment', () => {
  assert.doesNotMatch(read('packages/kit/src/client/app.js'), /['"`]#\//);
});

test('config files and credentials are looked for under tablewalk only', () => {
  for (const path of [...configLocations(), credentialsPath()]) assert.doesNotMatch(path, /datawalk/i);
});

test('the package has no root export: nothing imports bare `tablewalk`', () => {
  const pkg = JSON.parse(read('packages/tablewalk/package.json')) as { exports: Record<string, unknown> };
  assert.equal(Object.hasOwn(pkg.exports, '.'), false);
});
