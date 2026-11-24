/**
 * A free-form page is typechecked whether or not the App's tsconfig names it. A tsconfig whose `include` is the .ts
 * files alone (what the scaffold wrote until rc.85) left every `pages/*.page.tsx` unread: a page's type error, and a
 * `where` operator the read does not have, passed `mistri check` and failed in the browser.
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { typecheckApp } from '../packages/mistri/src/server/build/typecheck.js';

/* Under the checkout's node_modules, so the App's project resolves the TypeScript and React types this repository installs. */
const cache = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
mkdirSync(cache, { recursive: true });
const made: string[] = [];
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const OPTIONS = {
  target: 'ES2023',
  module: 'NodeNext',
  moduleResolution: 'NodeNext',
  strict: true,
  noEmit: true,
  skipLibCheck: true,
};
const WRONG = "const guests: number = 'many';\nexport default function Page() {\n  return <p>{guests}</p>;\n}\n";
const RIGHT = 'const guests: number = 12;\nexport default function Page() {\n  return <p>{guests}</p>;\n}\n';

function project(tsconfig: object, page: string) {
  const dir = mkdtempSync(join(cache, 'typecheck-pages-'));
  made.push(dir);
  mkdirSync(join(dir, 'pages'));
  writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  writeFileSync(join(dir, 'app.ts'), 'export const name: string = "Marquee";\n');
  writeFileSync(join(dir, 'pages', 'run-sheet.page.tsx'), page);
  return { dir, files: [join(dir, 'app.ts'), join(dir, 'pages', 'run-sheet.page.tsx')] };
}

describe('a free-form page under a tsconfig', () => {
  test('one its include leaves out is checked beside it, and its type error fails the check', async () => {
    const { dir, files } = project({ compilerOptions: OPTIONS, include: ['**/*.ts'] }, WRONG);
    const result = await typecheckApp(dir, files);
    assert.equal(result.status, 'failed', result.output);
    assert.match(result.detail, /and 1 page its include leaves out$/);
    assert.match(result.output ?? '', /pages[\\/]run-sheet\.page\.tsx\(1,\d+\): error TS2322/);
    assert.doesNotMatch(result.output ?? '', /app\.ts/, 'what the tsconfig read is not listed among the errors');
  });

  test('one its include leaves out passes when it is right, and the detail says it was read', async () => {
    const { dir, files } = project({ compilerOptions: OPTIONS, include: ['**/*.ts'] }, RIGHT);
    const result = await typecheckApp(dir, files);
    assert.equal(result.status, 'passed', result.output);
    assert.match(result.detail, /and 1 page its include leaves out$/);
  });

  test('one its include names is checked once, by the tsconfig', async () => {
    const tsconfig = { compilerOptions: { ...OPTIONS, lib: ['ES2023', 'DOM'], jsx: 'react-jsx' }, include: ['**/*.ts', '**/*.tsx'] };
    const { dir, files } = project(tsconfig, WRONG);
    const result = await typecheckApp(dir, files);
    assert.equal(result.status, 'failed', result.output);
    assert.doesNotMatch(result.detail, /leaves out/);
    assert.equal((result.output ?? '').match(/error TS2322/g)?.length, 1, result.output);
  });
});
