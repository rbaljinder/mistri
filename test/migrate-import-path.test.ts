import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const maintenance = readFileSync(join(root, 'packages/mistri/src/server/maintenance.ts'), 'utf8');

const files = (directory: string): string[] =>
  readdirSync(join(root, directory), { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)],
  );

/* The operator's one-time `migrate…` steps are exported from `@mistriwork/mistri/maintenance`, not from `/commands`;
   the docs, the schema and a startup refusal each sent the reader to the wrong entry. */
test('the migrate functions a document or a message names are imported from the entry that exports them', () => {
  const sources = [
    'docs',
    'site/reference-notes',
    'site/src/content/docs',
    'packages/mistri/schema',
    'packages/mistri/src/server/commands',
    'packages/mistri/src/server/auth',
  ]
    .flatMap(files)
    .filter((file) => /\.(md|ts|json)$/.test(file));
  assert.ok(sources.length > 50);
  const wrong: string[] = [];
  for (const file of sources) {
    const text = readFileSync(join(root, file), 'utf8');
    const named = [
      ...[...text.matchAll(/\b(migrate(?:Sqlite|Postgres)\w+)\b[^`]{0,120}?`?@mistriwork\/mistri\/(\w+)/g)].map((m) => [m[1], m[2]]),
      ...[...text.matchAll(/@mistriwork\/mistri\/(\w+)['"`)]*\)?\.then\(\(m\) => m\.(migrate\w+)/g)].map((m) => [m[2], m[1]]),
    ];
    for (const [name, entry] of named) {
      if (entry !== 'maintenance') wrong.push(`${file}: ${name} from /${entry}`);
      else assert.match(maintenance, new RegExp(`export \\{[^}]*\\b${name}\\b`), `${name} is exported by maintenance.ts`);
    }
  }
  assert.deepEqual(wrong, []);
});
