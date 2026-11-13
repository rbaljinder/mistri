import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/* A public principal's id is made in one place (shared/publicActor.ts), so a
   check that asks "is this the door" also accepts the token that calls the
   door's verb. An id spelled by hand elsewhere would answer for the visitor
   alone and refuse the token without anyone noticing. */
const root = fileURLToPath(new URL('..', import.meta.url));
const home = join('packages', 'mistri', 'src', 'shared', 'publicActor.ts');

function* sources(dir: string): Generator<string> {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(entry.name)) yield path;
  }
}

test('a public actor id is spelled only in shared/publicActor.ts', () => {
  const found: string[] = [];
  for (const pkg of readdirSync(join(root, 'packages'), { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const src = join(root, 'packages', pkg.name, 'src');
    let files: string[];
    try {
      files = [...sources(src)];
    } catch {
      continue;
    }
    for (const file of files) {
      const path = relative(root, file);
      if (path === home) continue;
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, index) => {
          if (line.includes('`public:${')) found.push(`${path}:${index + 1}`);
        });
    }
  }
  assert.deepEqual(found, [], 'use publicActorId() from shared/publicActor.ts');
  assert.match(readFileSync(join(root, home), 'utf8'), /`public:\$\{/);
});
