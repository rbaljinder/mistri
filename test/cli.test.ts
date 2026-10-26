/**
 * The command line, run as a command.
 *
 * Every other suite imports a function. That leaves the one property a CLI
 * has to get right — that it *stops* — asserted nowhere, and it is exactly
 * what broke: `--help` and `--version` were never handled at all. They were
 * ignored, fell through to the "nothing to open" gate, and that gate printed
 * the usage and exited 1. The right text, the wrong exit code, and only by
 * accident.
 *
 * When the server learned to start with no connection, the accident became
 * `tablewalk --help` listening on port 4111 and waiting for a browser. No
 * unit test could have caught it, because the failure is a process that does
 * not exit.
 *
 * So these spawn the real thing. Every case has a timeout: a regression here
 * is a hang, and a suite that hangs is worse than one that fails.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { makeDemoDatabase } from './make-demo-db.js';
import { entryFor } from './support/bins.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

interface Ran {
  code: number;
  out: string;
  err: string;
}

/** Run the CLI and wait for it to finish. Never longer than the timeout. */
function run(args: string[], timeout = 20_000): Promise<Ran> {
  return new Promise((resolve, reject) => {
    execFile('npx', ['tsx', entryFor(args), ...args], { cwd: ROOT, timeout, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      /* A timeout means it did not exit, which is the failure this file
           exists for — reported as itself rather than as an empty stdout. */
      if (err && (err as { killed?: boolean }).killed) {
        reject(new Error(`\`tablewalk ${args.join(' ')}\` did not exit within ${timeout}ms`));
        return;
      }
      resolve({
        code: (err as { code?: number } | null)?.code ?? 0,
        out: stdout,
        err: stderr,
      });
    });
  });
}

describe('the command line', () => {
  test('api-token help exits without starting an App or server', async () => {
    const { code, out, err } = await run(['api-token', '--help']);
    assert.equal(code, 0);
    assert.match(out, /Local operator maintenance/);
    assert.doesNotMatch(out + err, /Listening on/);
  });

  test('api-token rejects mixed server flags without echoing values or starting a server', async () => {
    const { code, out, err } = await run(['api-token', 'inspect', '--port', 'PRIVATE_ARGUMENT']);
    assert.equal(code, 2);
    assert.equal(out, '');
    assert.match(err, /API token maintenance failed/);
    assert.doesNotMatch(err, /PRIVATE_ARGUMENT|Listening on/);
  });

  test('--help prints the usage and succeeds', async () => {
    const { code, out } = await run(['--help']);
    /* Zero. Help was asked for and given; that is not an error, and a CI step
       or a shell completion that checks the exit code should not be told it
       was. */
    assert.equal(code, 0);
    assert.match(out, /browse a relational database as a graph you walk/);
    assert.match(out, /--mcp/);
  });

  test('-h is the same', async () => {
    const { code, out } = await run(['-h']);
    assert.equal(code, 0);
    assert.match(out, /browse a relational database/);
  });

  test('--version prints a version and succeeds', async () => {
    const { code, out } = await run(['--version']);
    assert.equal(code, 0);
    assert.match(out.trim(), /^\d+\.\d+\.\d+/);
  });

  test('an unknown option is named, and refused', async () => {
    /* Ignored, once. Survivable only because the gate below it printed the
       usage — so a typo looked like it had been told something. With a server
       that starts on nothing, the same typo silently starts one on the
       default port and waits. */
    const { code, err } = await run(['--prot', '9999']);
    assert.equal(code, 1);
    assert.match(err, /unknown option "--prot"\. Did you mean --port\? tablewalk --help lists the options\./);
    // The one line that says what was wrong is not buried under seven hundred of usage (UX-17).
    assert.doesNotMatch(err, /browse a relational database/);
  });

  test('--help fits one screen, and --help all is the whole usage (UX-17)', async () => {
    const short = await run(['--help']);
    assert.equal(short.code, 0);
    assert.ok(short.out.trim().split('\n').length <= 40, `--help is ${short.out.trim().split('\n').length} lines`);
    assert.match(short.out, /tablewalk --help all/);
    const all = await run(['--help', 'all']);
    assert.equal(all.code, 0);
    assert.match(all.out, /Changing the schema/);
    assert.ok(all.out.split('\n').length > short.out.split('\n').length * 5);
  });

  test('a word one slip from a command, with no file of that name, is told the command (UX-17)', async () => {
    const { code, err } = await run(['chek', '--app', 'examples/apps/tick']);
    assert.equal(code, 1);
    assert.match(err, /"chek" is not a command, and no file of that name is here\. Did you mean mistri check\?/);
    assert.doesNotMatch(err, /unable to open database file/);
  });

  test('a mode that needs a database still refuses without one', async () => {
    /* The other half of the same decision: `--export` has nothing to print
       with no database, so it stops where it always did. */
    const { code, err } = await run(['--no-config', '--export', 'md']);
    assert.equal(code, 1);
    assert.match(err, /Looked for a config file in/);
  });

  test('--demo builds a sample database on the fly', async () => {
    /* `--demo` writes a throwaway database and, in a print-and-exit mode like
       --export, that is all it needs to do before printing its schema. It is
       the flag that gives a fresh install something to walk without a database
       of its own, so it must actually produce one. */
    const { code, out } = await run(['--demo', '--export', 'md', '--no-config']);
    assert.equal(code, 0);
    // The demo's shape: the tables the walk is built around.
    assert.match(out, /customer/);
    assert.match(out, /invoice/);
    assert.match(out, /work_order/);
  });

  test('--export prints the schema and exits', async () => {
    /* Its own database, built in a temp dir. This used to read `.demo/demo.db`,
       which exists on a machine where `npm run demo` has been run and does not
       exist in CI — the demo database is generated, not committed. The test
       passed locally and failed the moment it ran anywhere clean. */
    const dir = mkdtempSync(join(tmpdir(), 'tablewalk-cli-'));
    const db = join(dir, 'demo.db');
    makeDemoDatabase(db);
    try {
      const { code, out } = await run([db, '--export', 'md', '--no-config']);
      assert.equal(code, 0);
      /* Stdout carries the document and nothing else — `--export md >> CLAUDE.md`
       must append a brief, not a brief with a startup banner on it. */
      assert.match(out, /^#/m);
      assert.doesNotMatch(out, /Listening on/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
