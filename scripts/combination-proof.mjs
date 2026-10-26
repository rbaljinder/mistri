#!/usr/bin/env node
/**
 * Does the combinations fixture actually bite?
 *
 * A fixture that has never failed proves nothing. The release plan asks for a
 * demonstration: revert a fix, watch the fixture go red. The seven fixes it
 * names are inside squashed release commits, so there is no revert to run —
 * what there is, for each defect whose mechanism is known, is the one edit
 * that puts it back. This applies each in turn, runs the fixture, and expects
 * red; then it restores the file from git and expects green again.
 *
 *   node scripts/combination-proof.mjs
 *
 * Every mutation is a *deliberate defect*. The script refuses to run with a
 * dirty working tree, because restoring is `git checkout --` and that would
 * take uncommitted work with it.
 *
 * What this does not claim: it is not the seven reverts. It is the subset
 * whose mechanism I could state exactly, each one re-introduced at the line
 * the fix lives on. Where a defect's mechanism is not known well enough to
 * put back honestly, it is listed below as unproven rather than approximated.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURE = 'test/combinations.test.ts';

/** Each: the defect, where it lived, and the edit that puts it back. */
const MUTATIONS = [
  {
    id: 'api-commands-through-a-feature',
    defect: 'A command exposed through a feature was dropped from the composed API.',
    file: 'packages/mistri/src/shared/appApi.ts',
    find: '    for (const entry of api.commands) {',
    // The App's own commands still compose; a feature's are skipped, which is
    // the shape that shipped: `api.commands` worked until composition moved it.
    replace: "    for (const entry of (by === 'the App' ? api.commands : [])) {",
  },
  {
    id: 'a-command-reference-with-no-registry',
    defect: 'An App referring to a command started without a registry behind it, and its action bar offered a verb nothing could run.',
    file: 'packages/mistri/src/server/cli/commandHost.ts',
    // An App that refers to commands no longer brings the requirement with
    // it: only an explicit `--commands` does, so the referring App starts.
    find: '  if (opts.commands !== undefined || commandApps.length) {',
    replace: '  if (opts.commands !== undefined) {',
  },
  {
    id: 'the-tenant-runtime-admitting-an-app',
    defect: 'The tenant host refused a deployment whose loaded App carried a fact its admission list did not name.',
    file: 'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
    find: "      ['path', 'dir', 'app', 'pages', 'sources', 'authority', 'origins', 'build'])) as unknown as LoadedApp;",
    replace: "      ['path', 'dir', 'app', 'pages', 'sources', 'authority', 'origins'])) as unknown as LoadedApp;",
  },
  {
    id: 'a-session-kept-wider-than-its-request',
    defect:
      "The tenant host kept a resolved session for the whole host rather than for the one request, so one login answered another's requests.",
    file: 'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
    // Keyed by the auth runtime, which every request shares, instead of the request object.
    find: '      const kept = resolved.get(request);',
    replace: '      const kept = resolved.get(auth as never);',
    also: {
      file: 'packages/mistri/src/server/tenant/tenantAuthenticatedHttp.ts',
      find: '      if (proof && !kept) resolved.set(request, proof);',
      replace: '      if (proof && !kept) resolved.set(auth as never, proof);',
    },
  },
];

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const clean = () => git(['status', '--porcelain', '--', 'packages/*/src']).trim() === '';

function runFixture() {
  const done = spawnSync('npx', ['tsx', '--test', FIXTURE], { cwd: ROOT, encoding: 'utf8', timeout: 600_000 });
  return { code: done.status, output: `${done.stdout}${done.stderr}` };
}

function main() {
  if (!clean()) {
    console.error('The working tree under packages/*/src has uncommitted changes. Restoring a mutation would take them with it.');
    process.exitCode = 1;
    return;
  }
  const before = runFixture();
  if (before.code !== 0) {
    console.error('The fixture is already failing; there is nothing to prove.');
    process.exitCode = 1;
    return;
  }
  console.log(`Green to start with: ${FIXTURE}\n`);

  const results = [];
  for (const mutation of MUTATIONS) {
    const edits = [mutation, ...(mutation.also ? [mutation.also] : [])].filter((edit) => edit.find !== edit.replace);
    try {
      for (const edit of edits) {
        const path = new URL(`../${edit.file}`, import.meta.url);
        const text = readFileSync(path, 'utf8');
        if (!text.includes(edit.find)) throw new Error(`the line this defect lived on is gone: ${edit.file}`);
        writeFileSync(path, text.replace(edit.find, edit.replace));
      }
      const { code, output } = runFixture();
      const red = code !== 0;
      results.push({
        id: mutation.id,
        red,
        defect: mutation.defect,
        caught: red ? (output.match(/✖ (combination: [^(]+)/g) ?? []).map((line) => line.slice(2).trim()) : [],
      });
    } catch (error) {
      results.push({ id: mutation.id, red: false, defect: mutation.defect, error: String(error.message) });
    } finally {
      git(['checkout', '--', 'packages/*/src']);
    }
  }

  for (const result of results) {
    console.log(`${result.red ? 'CAUGHT ' : 'MISSED '} ${result.id}`);
    console.log(`         ${result.defect}`);
    if (result.error) console.log(`         ${result.error}`);
    for (const test of result.caught ?? []) console.log(`         red: ${test}`);
  }
  const missed = results.filter((result) => !result.red);
  console.log(`\n${results.length - missed.length} of ${results.length} re-introduced defects turn the fixture red.`);
  if (!clean()) {
    console.error('The working tree did not restore cleanly. Check `git status` before doing anything else.');
    process.exitCode = 1;
    return;
  }
  const after = runFixture();
  console.log(after.code === 0 ? 'Green again after restoring.' : 'STILL RED after restoring — check the tree.');
  if (missed.length || after.code !== 0) process.exitCode = 1;
}

main();
