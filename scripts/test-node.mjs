/**
 * The Node suite in two lanes, because one reason for running serially stopped
 * applying and the other did not.
 *
 * `--test-concurrency=1` was chosen when every live-engine test read and wrote
 * the one database `TABLEWALK_TEST_PG` names, so two files at once meant one
 * file dropping the table another was reading. 0.5.0 gave the tenant and
 * platform suites databases of their own — `uuidPostgresDatabase`,
 * `dedicatedPostgresUrl`, `openTenantEngine`'s required `database` — and those
 * files no longer share anything. Node's runner already gives every test file
 * its own process, so nothing in JavaScript is shared between files either;
 * what is left to collide over is outside the process, and for this suite that
 * is the shared live databases.
 *
 * So: a file that still works in the database `TABLEWALK_TEST_PG` names, or flushes the shared Valkey or Typesense,
 * runs in the serial lane. Everything else runs in the parallel lane. The rule
 * is read off the source rather than kept as a list, so a new file that
 * touches a shared engine lands in the serial lane by default rather than by
 * somebody remembering — and the failure mode of the rule is slowness, not a
 * race.
 *
 * A file that needs the serial lane for a reason this rule cannot see — a
 * fixed port, a fixed path, a global the runner cannot isolate — says so in
 * its own text with a `test-lane: serial` comment.
 *
 *   node scripts/test-node.mjs                   the whole suite, both lanes
 *   node scripts/test-node.mjs --shard=2/3       one third of each lane, packed by recorded time
 *   node scripts/test-node.mjs --lanes           print the partition, run nothing
 *   node scripts/test-node.mjs test/a.test.ts …  only the files named, each in its own lane
 *   node scripts/test-node.mjs --package=kit     one package's files and the shared ones (scripts/test-owners.mjs)
 *   TABLEWALK_TEST_CONCURRENCY=4 …               override the parallel width
 *   node scripts/test-node.mjs --record-timings  run, and record each file's time in test/node-timings.json
 *   TABLEWALK_TEST_LEAKS=report …                say what a lane left, and pass anyway
 *
 * Each lane runs with a temporary directory of its own as TMPDIR, and what a
 * lane leaves in it is a leak: a scratch directory no hook removed, or a
 * server some case started and never stopped (a process whose command line
 * names that directory). A run that died before its cleanup used to be found
 * weeks later, as a stray database or a gate killed hours in; this says so at
 * the end of the lane, names what is left, stops the processes, and fails
 * the lane. The runner's own caches there (Node's compile cache, tsx's) are
 * not leaks, and are not counted.
 *
 * Both lanes run even if the first fails: a red parallel lane should not hide
 * what the serial lane would have said. The exit code is the worse of the two.
 */
import { spawnSync } from 'node:child_process';
import { globSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { availableParallelism, tmpdir } from 'node:os';
import { ownedBy, packageArg } from './test-owners.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* The engines several files share one database on. Named here rather than
   inferred from `process.env`, because the partition must not change with the
   environment: a suite that shards differently with and without live engines
   would put different files in different shards on CI and locally. */
const SHARED_ENGINES = ['TABLEWALK_TEST_PG', 'TABLEWALK_TEST_VALKEY', 'TABLEWALK_TEST_TYPESENSE'];
/* The helpers that hand a file a database no other file opens. A file that
   reaches one of these — directly or through a fixture it imports — is not
   sharing, whatever it says about the environment variable. */
const OWNED_DATABASE = ['uuidPostgresDatabase', 'dedicatedPostgresUrl', 'openTenantEngine', 'ownedPostgresDatabase'];
/** A file's own escape hatch, for a collision this rule cannot see. */
const DECLARED_SERIAL = 'test-lane: serial';

/** Source without its comments. A file that names `TABLEWALK_TEST_PG` in a
 * sentence about why it does not need it — core.test.ts's header — was read as
 * sharing, and ran serially. Only `//` at a line's start or after whitespace
 * counts, so a URL in a string (`postgres://…`) is not cut. */
const code = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '$1');

/** A test file's text, plus the text of every module it imports from `test/`.
 * A fixture is where the owned-database call usually lives, so a scan that
 * stopped at the test file would read most of the tenant suites as sharing. */
function reach(file, seen = new Set()) {
  const absolute = resolve(ROOT, file);
  if (seen.has(absolute)) return '';
  seen.add(absolute);
  let text;
  try {
    text = readFileSync(absolute, 'utf8');
  } catch {
    return '';
  }
  let all = code(text);
  /* Relative specifiers only: a bare one is a package, and `src/` is the code
     under test, which never opens a fixture database. `.js` on disk is `.ts`,
     the way the suite's own imports are written. */
  for (const [, specifier] of text.matchAll(/from\s+'(\.[^']+)'/g)) {
    const target = join(dirname(absolute), specifier).replace(/\.js$/, '.ts');
    if (!relative(join(ROOT, 'test'), target).startsWith('..')) all += reach(target, seen);
  }
  return all;
}

/** Every test file, split into the two lanes. Exported so the repository's own
 * structure test can assert the partition covers the suite exactly — the gate
 * finding every test file is the property that used to be pinned by matching
 * the glob in `package.json`, and a partition can drop a file the way a glob
 * cannot. */
export function lanes() {
  // An example App's own suite (examples/apps/lintel/tests) runs in the gate as it is written for the App's repository.
  const files = globSync(['test/**/*.test.ts', 'examples/apps/*/tests/*.test.ts'], { cwd: ROOT })
    .map((file) => file.split('\\').join('/'))
    .sort();
  const serial = [],
    parallel = [];
  for (const file of files) {
    const text = reach(file);
    const shares = SHARED_ENGINES.some((name) => text.includes(name)) && !OWNED_DATABASE.some((name) => text.includes(name));
    (shares || readFileSync(resolve(ROOT, file), 'utf8').includes(DECLARED_SERIAL) ? serial : parallel).push(file);
  }
  return { serial, parallel };
}

/** The recorded seconds each file takes (`--record-timings` writes it). */
const TIMINGS = join(ROOT, 'test', 'node-timings.json');

/** `--test-shard` splits a glob; these lanes are two lists, so the split is
 * done here — over each lane separately, so a shard gets its share of both
 * rather than one shard inheriting every slow serial file. Packed by recorded
 * time, longest first onto the lightest shard: every Nth file gave shards the
 * same count and very different lengths, since a handful of files are most
 * of the suite. A file with no record weighs the median. Every shard computes
 * the same packing from the same file, so the shards still cover the lane
 * exactly once. Exported for test/repo/structure.test.ts.
 *
 * `headStart[i]` is work shard i+1 does besides this lane, counted in average
 * shards of it (see `parseHeadStart`): the packer starts that bin that full,
 * so a CI leg that also runs the static checks and the component tests takes
 * less of the lane, and the legs finish together. */
export function shard(files, index, total, timings = readTimings(), headStart = []) {
  if (total === 1) return files;
  // A skipped live-engine file records zero, not its actual cost. Treat it
  // like a new file so zero weights cannot pile onto the lightest shard.
  const measured = (time) => typeof time === 'number' && Number.isFinite(time) && time > 0;
  const known = files
    .map((file) => timings[file])
    .filter(measured)
    .sort((a, b) => a - b);
  if (!known.length) return files.filter((_, at) => at % total === index - 1);
  const median = known[Math.floor(known.length / 2)];
  const weight = (file) => (measured(timings[file]) ? timings[file] : median);
  const average = files.reduce((sum, file) => sum + weight(file), 0) / total;
  const loads = Array.from({ length: total }, (_, at) => (headStart[at] ?? 0) * average);
  const home = new Map();
  for (const file of [...files].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1))) {
    const lightest = loads.indexOf(Math.min(...loads));
    loads[lightest] += weight(file);
    home.set(file, lightest);
  }
  return files.filter((file) => home.get(file) === index - 1);
}

/** `--head-start=1:1.4,3:0.5`: shard 1 does 1.4 average shards' worth of other
 * work (in CI, the static checks, Vitest and the authored-App browser run), and
 * shard 3 half of one. In shards rather than seconds, so one number serves both
 * lanes and stays true whether the recorded timings are a laptop's or a
 * runner's. Every shard must be given the same list, as every shard computes
 * the same packing. Exported for scripts/test-e2e.mjs and the structure test. */
export function parseHeadStart(argv, total) {
  const arg = argv.find((value) => value.startsWith('--head-start='));
  if (!arg) return [];
  const starts = Array.from({ length: total }, () => 0);
  for (const part of arg.slice('--head-start='.length).split(',')) {
    const [at, amount] = part.split(':').map(Number);
    if (!Number.isInteger(at) || at < 1 || at > total || !Number.isFinite(amount) || amount < 0) {
      throw new Error(`--head-start takes shard:amount pairs, 1 <= shard <= ${total} and amount >= 0; got "${part}"`);
    }
    starts[at - 1] = amount;
  }
  return starts;
}

function readTimings() {
  try {
    return JSON.parse(readFileSync(TIMINGS, 'utf8'));
  } catch {
    return {};
  }
}

/* Tool caches the runner itself keeps under TMPDIR, not anything a case made:
   Node's module compile cache and tsx's per-user transform cache. */
const TOOL_CACHES = [/^node-compile-cache$/, /^tsx-\d+$/];

/** What a lane left in its TMPDIR, said and cleared. True when anything was left. */
export function leaks(scratch, label) {
  const found = [];
  /* Processes first: a server still running is what keeps writing into the
     directory, and stopping it is what lets the directory go. */
  const ps = spawnSync('ps', ['-Ao', 'pid=,args='], { encoding: 'utf8' });
  for (const line of (ps.stdout ?? '').split('\n')) {
    const match = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (!match || Number(match[1]) === process.pid || !match[2].includes(scratch)) continue;
    found.push(`process ${match[1]}: ${match[2].slice(0, 160)}`);
    try {
      process.kill(Number(match[1]), 'SIGKILL');
    } catch {
      /* gone already */
    }
  }
  let entries = [];
  try {
    entries = readdirSync(scratch);
  } catch {
    /* nothing was made */
  }
  /* Grouped by the prefix a test gave mkdtemp, which is how a leak is traced
     back to its file: `tablewalk-policy-cli-AbC123` → `tablewalk-policy-cli-`. */
  const byPrefix = new Map();
  for (const name of entries) {
    if (TOOL_CACHES.some((cache) => cache.test(name))) continue;
    const prefix = name.replace(/[A-Za-z0-9]{6}$/, '');
    byPrefix.set(prefix, (byPrefix.get(prefix) ?? 0) + 1);
  }
  for (const [prefix, count] of byPrefix) found.push(`${count} × ${prefix}…`);
  rmSync(scratch, { recursive: true, force: true });
  if (!found.length) return false;
  console.error(`# ${label}: left behind after the lane (a scratch directory or a server a case never stopped):`);
  for (const line of found) console.error(`#   ${line}`);
  return true;
}

/* Run only from the command line: test/repo/structure.test.ts imports this
   module for `lanes()` and must not start a suite by doing so. */
if (process.argv[1] === fileURLToPath(import.meta.url)) main();

function main() {
  const argv = process.argv.slice(2);
  const shardArg = argv.find((arg) => arg.startsWith('--shard='));
  /* Anything else is passed through to node's runner, so a one-off
     `--test-name-pattern` or `--test-only` still works through the gate. */
  const record = argv.includes('--record-timings');
  /* A test file named on the command line narrows the run to the files named, each still in the lane its source
     puts it in, so a serial file is not raced by naming it. Read as a file by its name (`*.test.ts`), not by being
     positional, so a flag's value given after a space (`--test-name-pattern foo`) still passes through. */
  const named = argv.filter((arg) => !arg.startsWith('-') && arg.endsWith('.test.ts'));
  const rest = argv.filter(
    (arg) =>
      arg !== shardArg &&
      arg !== '--lanes' &&
      arg !== '--record-timings' &&
      !arg.startsWith('--head-start=') &&
      !arg.startsWith('--package=') &&
      !named.includes(arg),
  );
  const [index, total] = shardArg ? shardArg.slice('--shard='.length).split('/').map(Number) : [1, 1];
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
    console.error(`--shard must be i/N with 1 <= i <= N; got ${shardArg}`);
    process.exit(2);
  }
  let headStart;
  try {
    headStart = parseHeadStart(argv, total);
  } catch (error) {
    console.error(error.message);
    process.exit(2);
  }

  const partition = lanes();
  const wanted = new Set(named.map((file) => relative(ROOT, resolve(file)).split('\\').join('/')));
  const unknown = [...wanted].filter((file) => !partition.serial.includes(file) && !partition.parallel.includes(file));
  if (unknown.length) {
    console.error(`Not a test file of the suite: ${unknown.join(', ')}`);
    process.exit(2);
  }
  const kept = packageArg(argv);
  const only = (files) => {
    const chosen = wanted.size ? files.filter((file) => wanted.has(file)) : files;
    if (!kept) return chosen;
    try {
      return ownedBy(chosen, kept);
    } catch (error) {
      console.error(error.message);
      process.exit(2);
    }
  };
  const serial = only(partition.serial),
    parallel = only(partition.parallel);
  const width = Number(process.env.TABLEWALK_TEST_CONCURRENCY) || Math.max(2, availableParallelism() - 1);

  if (argv.includes('--lanes')) {
    console.log(`parallel (${parallel.length} files, concurrency ${width}):`);
    for (const file of parallel) console.log(`  ${file}`);
    console.log(`serial (${serial.length} files):`);
    for (const file of serial) console.log(`  ${file}`);
    process.exit(0);
  }

  const run = (files, concurrency, label) => {
    const mine = shard(files, index, total, readTimings(), headStart);
    if (!mine.length) {
      console.log(`# ${label}: nothing in this shard`);
      return 0;
    }
    console.log(`# ${label}: ${mine.length} files, concurrency ${concurrency}`);
    const scratch = mkdtempSync(join(tmpdir(), 'tablewalk-lane-'));
    /* A config home of the lane's own, outside its TMPDIR (so the leak check
       does not read it as left behind): no case reaches the developer's
       ~/.config/tablewalk, its auth stores or its saved credentials. */
    const configHome = mkdtempSync(join(tmpdir(), 'tablewalk-lane-config-'));
    /* Recording adds a second reporter, written outside the lane's TMPDIR so
       the leak check does not read the record as something a case left. */
    const recorded = record ? join(mkdtempSync(join(tmpdir(), 'tablewalk-timings-')), 'lane.json') : undefined;
    const reporters = recorded
      ? [
          '--test-reporter=spec',
          '--test-reporter-destination=stdout',
          `--test-reporter=${join(ROOT, 'scripts', 'node-timings-reporter.mjs')}`,
          `--test-reporter-destination=${recorded}`,
        ]
      : [];
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--test', '--test-timeout=120000', `--test-concurrency=${concurrency}`, ...reporters, ...rest, ...mine],
      {
        cwd: ROOT,
        stdio: 'inherit',
        env: {
          ...process.env,
          TMPDIR: scratch,
          TMP: scratch,
          TEMP: scratch,
          XDG_CONFIG_HOME: configHome,
          /* A server that draws a picture at a width keeps the copy in a cache
             under the temp folder by default (imageVariants.ts): a cache, not
             a leak, so it lives beside the config home and goes with it. */
          MISTRI_IMAGE_CACHE: join(configHome, 'image-cache'),
          /* The suites sign in hundreds of times from 127.0.0.1: Better Auth's per-address limits are lifted on a
             loopback server (auth.ts authLimitsOffForTests); the per-account lockout stays. A file that tests the
             limits deletes it. Set to anything else to keep them. */
          MISTRI_TEST_AUTH_LIMITS: process.env.MISTRI_TEST_AUTH_LIMITS ?? 'off',
        },
      },
    );
    rmSync(configHome, { recursive: true, force: true });
    const leaked = leaks(scratch, label);
    if (recorded) {
      try {
        Object.assign(timings, JSON.parse(readFileSync(recorded, 'utf8')));
      } catch {
        /* the lane wrote none */
      }
      rmSync(dirname(recorded), { recursive: true, force: true });
    }
    if (result.error) {
      console.error(`# ${label}: ${result.error.message}`);
      return 1;
    }
    /* A signal is not a status. A lane the OOM killer took reports `null`, and
       `?? 0` would have called that green. */
    const status = result.signal ? 1 : (result.status ?? 1);
    /* A leak fails the lane: the first full gates found only the runner's own
       caches, which are not counted (TOOL_CACHES). `report` says, and passes. */
    return status || (leaked && process.env.TABLEWALK_TEST_LEAKS !== 'report' ? 1 : 0);
  };

  const timings = {};
  const first = run(parallel, width, 'parallel lane');
  const second = run(serial, 1, 'serial lane');
  if (record) {
    /* Merged over the last record, so one shard's run refreshes its files and keeps the others'. */
    const merged = { ...readTimings(), ...timings };
    writeFileSync(
      TIMINGS,
      `${JSON.stringify(
        Object.fromEntries(
          Object.keys(merged)
            .sort()
            .map((file) => [file, merged[file]]),
        ),
        null,
        1,
      )}\n`,
    );
    console.log(`# timings: ${Object.keys(timings).length} files recorded in ${relative(ROOT, TIMINGS)}`);
  }
  process.exit(first || second);
}
