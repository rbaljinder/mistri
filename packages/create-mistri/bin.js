#!/usr/bin/env node
/*
 * `npm create mistri <args>` runs this as `create-mistri <args>`: it is `mistri new <args>`, run by the mistri this
 * package depends on at its own version. Nothing is parsed here, so a flag the App framework learns works the
 * day it ships (`npm create mistri my-app -- --brief BRIEF.md`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const manifestPath = createRequire(import.meta.url).resolve('@mistriwork/mistri/package.json');
const { bin } = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entry = join(dirname(manifestPath), typeof bin === 'string' ? bin : bin.mistri);

const run = spawnSync(process.execPath, [entry, 'new', ...process.argv.slice(2)], { stdio: 'inherit' });
if (run.error) {
  console.error(`create-mistri: could not run ${entry}: ${run.error.message}`);
  process.exit(1);
}
/* A child ended by a signal has no status: say it failed, as a shell would. */
process.exit(run.status ?? 1);
