/**
 * A server that takes a person's request is made by `frontDoor`
 * (http/frontDoor.ts), which is where the baseline headers, the trusted
 * proxies and the pool's admission are applied once. A new `createServer`
 * from `node:http` or `node:https` anywhere else in a package's source
 * would be a door that forgot one of them (the tenant servers and the suite
 * each did, before). Add to the list only with the reason beside it.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** Files that may make an HTTP server, and why they are not a front door. */
const NOT_A_DOOR: Record<string, string> = {
  'packages/engine/src/server/http/frontDoor.ts': 'the door itself',
  'packages/mistri/src/server/virtualization/service.ts':
    'a test double of an outside service (virtual services), answering the App as that service would; nobody signs in to it',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === 'node_modules' ? [] : sources(path);
    return /\.(ts|tsx|js|mjs)$/.test(name) ? [path] : [];
  });
}

test('only the front door makes an HTTP server in a package’s source', () => {
  const found: string[] = [];
  for (const pkg of readdirSync(join(ROOT, 'packages'))) {
    const src = join(ROOT, 'packages', pkg, 'src');
    try {
      statSync(src);
    } catch {
      continue;
    }
    for (const file of sources(src)) {
      // Prose that names `http.createServer(` (the embed handler's doc) is not a call.
      const text = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const imported = /import\s*\{[^}]*\bcreateServer\b[^}]*\}\s*from\s*['"](?:node:)?https?['"]/.test(text);
      const namespaced = /\b(?:http|https)\.createServer\(/.test(text);
      if (imported || namespaced) found.push(relative(ROOT, file));
    }
  }
  const unexplained = found.filter((file) => !(file in NOT_A_DOOR));
  assert.deepEqual(unexplained, [], 'a server made outside the front door: use frontDoor() or list it with a reason');
  const stale = Object.keys(NOT_A_DOOR).filter((file) => !found.includes(file));
  assert.deepEqual(stale, [], 'listed as an exception but makes no server any more');
});
