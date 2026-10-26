/**
 * The Keystone samples typecheck their complete module graphs.
 *
 * Split out of schema.test.ts, where one test typechecked every sample in turn
 * and was most of that file's time; the files now run side by side.
 */
import { test, describe } from 'node:test';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { appDirectory, walkedApps } from './support/exampleApps.js';

const compiler = new URL('../node_modules/typescript/bin/tsc', import.meta.url).pathname;

describe('the schemas repeat the parser, and the tests keep them honest', () => {
  test('modular public samples typecheck their complete module graphs', () => {
    for (const app of walkedApps().filter((app) => app.startsWith('keystone/'))) {
      execFileSync(process.execPath, [compiler, '-p', join(appDirectory(app), 'tsconfig.json')], { stdio: 'pipe' });
    }
  });
});
