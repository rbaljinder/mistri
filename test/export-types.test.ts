/**
 * The rule the build and the install proof share (scripts/export-types.mjs): every public export of a package is typed
 * by a declaration file the package ships — its `types` condition, or the `.d.ts` beside its `.js`.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { untypedExports } from '../scripts/export-types.mjs';

function pack(files: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-export-types-'));
  for (const file of files) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), '');
  }
  return dir;
}

test('an export is typed by its types condition or by the .d.ts beside its .js', () => {
  const dir = pack(['dist/index.js', 'dist/index.d.ts', 'dist/a.js', 'dist/a.d.ts', 'dist/b.js', 'dist/b.types.d.ts', 'dist/s.css']);
  try {
    assert.deepEqual(
      untypedExports(dir, {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './a.js': './dist/a.js',
        './b': { import: { types: './dist/b.types.d.ts', default: './dist/b.js' } },
        './style.css': './dist/s.css',
        './package.json': './package.json',
        './schema/*': './schema/*',
      }),
      [],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an export with no declaration file is named, whether it names its types or leaves them to the .d.ts beside it', () => {
  const dir = pack(['dist/index.js', 'dist/a.js', 'dist/b.js', 'dist/b.d.ts']);
  try {
    assert.deepEqual(
      untypedExports(dir, {
        '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        './a.js': './dist/a.js',
        './b.js': './dist/b.js',
      }),
      ['. -> dist/index.d.ts', './a.js -> dist/a.d.ts'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
