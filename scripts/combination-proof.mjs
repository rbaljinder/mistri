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
    id: 'a-via-target-the-role-cannot-read',
    defect:
      'A row scope that reads through a membership table (via) was zeroed with the table, because the role cannot read it: the reader saw nothing, and live sync told them of nothing.',
    file: 'packages/mistri/src/server/app/appAccess.ts',
    find: '  const kept = (resource: string) => access.readable.has(resource) || decides.has(resource);',
    // The resource ceiling drops every rule of an unreadable table again, a via target included.
    replace: '  const kept = (resource: string) => access.readable.has(resource);',
  },
  {
    id: 'a-via-live-fingerprint-ignores-the-targets-rule',
    defect:
      'Two readers whose via scopes read alike shared one live probe, because the digest left out the target rule (bench_access.who = me): one was told of rows only the other reaches.',
    file: 'packages/mistri/src/server/live/liveFilter.ts',
    find: 'JSON.stringify(closure === undefined ? [owner, table, scope] : [owner, table, scope, closure])',
    // The digest hashes the table's own filter alone again.
    replace: 'JSON.stringify([owner, table, scope])',
  },
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
    defect:
      'An App referring to a command was accepted with no registry behind it, so nothing named the missing --commands and its action bar offered a verb nothing could run.',
    // The reference check (shared/command.ts) is where the refusal lives now: it names the flag. Here it takes the
    // name on trust with no catalog, which is the shape that shipped.
    file: 'packages/mistri/src/shared/command.ts',
    find: '  if (!catalog) {\n    return fail(',
    replace: '  if (!catalog) {\n    return [raw, {} as CommandCatalogEntry];\n    return fail(',
    // And the host no longer asks for a registry because an App refers to commands: only an explicit `--commands` does.
    also: {
      file: 'packages/mistri/src/server/cli/commandHost.ts',
      find: '  if (opts.commands !== undefined || loadedCommands || commandApps.length) {',
      replace: '  if (opts.commands !== undefined || loadedCommands) {',
    },
  },
  {
    id: 'the-tenant-runtime-admitting-an-app',
    defect: 'The tenant host refused a deployment whose loaded App carried a fact its admission list did not name.',
    // The admission list moved with the package split: it is LOADED_APP_KEYS now, one list for every tenant start.
    file: 'packages/mistri/src/server/app/apps.ts',
    find: "  'origins',\n  'build',\n",
    replace: "  'origins',\n",
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
      find: '        if (proof) resolved.set(request, proof);',
      replace: '        if (proof) resolved.set(auth as never, proof);',
    },
  },
  {
    id: 'an-aggregate-read-past-its-scope',
    defect:
      "A command's aggregate compiled without the row scope its transaction carries, so it counted another tenant's rows and a policy's hidden ones that its own where never listed.",
    file: 'packages/engine/src/adapters/scoped/scopedReads.ts',
    find: '      const compiled = compileAggregate(schema, snapshotScopedData(request), style, 0, scope, schema);',
    replace: '      const compiled = compileAggregate(schema, snapshotScopedData(request), style, 0, undefined, schema);',
  },
  {
    id: 'a-rollup-testing-the-tenant-held-for-anyone',
    defect:
      "A rollup's query read `tenant.plan` as a check before any request reads it, held for anyone: the App checked, and a figure compiled once for every request counted every row whatever the tenant's plan, directly or through a segment.",
    file: 'packages/mistri/src/shared/appRollups.ts',
    // The rollup is parsed as any check before a request is, which holds `tenant.` rather than refusing it.
    find: '{ me: ANYONE_ONCE });',
    replace: '{ me: ANYONE });',
    also: {
      file: 'packages/mistri/src/shared/appRollups.ts',
      find: "import { ANYONE_ONCE, saidAt } from '@mistriwork/engine/shared/query.js';",
      replace: "import { ANYONE, saidAt } from '@mistriwork/engine/shared/query.js';",
    },
  },
];

const git = (args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
// Every package's sources. A bare `packages/*/src` matches no file — a wildcard pathspec is matched against the whole
// path, never as a leading directory — so the check passed on any tree and the restore failed, leaving a defect in.
const SOURCES = ':(glob)packages/*/src/**';
const clean = () => git(['status', '--porcelain', '--', SOURCES]).trim() === '';

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
      git(['checkout', '--', SOURCES]);
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
