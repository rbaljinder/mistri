/**
 * The browser suite, run as the two lanes `scripts/e2e-lanes.mjs` derives.
 *
 * Playwright has no per-project worker count — `workers` is one number for the
 * whole run — so the two lanes cannot be one invocation. They are two, behind
 * this script, which is what `npm run e2e` runs.
 *
 * `shared` runs one spec at a time, exactly as the whole suite ran before:
 * those specs address the three servers `playwright.config.ts` starts, and one
 * tablewalk process has one active connection (`registry.setActive`). `owned`
 * runs several at once — each of its specs starts its own server on a
 * `listen(0)` port over a `mkdtemp` database and shares nothing.
 *
 * The browser runs against the BUILT client. Every server here is a tsx process
 * and used to mount its own Vite — a transform of the whole client per worker,
 * on the cores the browsers and Better Auth's password hashing were also using.
 * Now `npm run e2e` builds the client once per product (`vite build -c
 * vite.<product>.config.ts`, a few seconds each; skipped when both products'
 * `dist/client` are newer than every package's `src/client` and `src/shared`
 * and the configs) and the servers are started with `MISTRI_BUILT_CLIENT=1`
 * (`packages/engine/src/server/devclient.ts`), which sends each product's own
 * dist/client the way its package does. A spec that needs the source — it imports a client module by its source
 * name, or rewrites one on its way to the page — says `e2e-client: source` in
 * its own text (`scripts/e2e-lanes.mjs`) and runs in its lane's second pass,
 * unbuilt, with Vite. `npm run smoke` and a bare `npx playwright test` are
 * unbuilt too: the smoke run exists to catch an unbuilt client that throws.
 *
 * `shared` goes first because its fixtures share three servers and one active
 * connection. Every source Vite generation owns a temporary optimizer cache
 * (`packages/engine/src/server/devclient.ts`), so the owned workers can start independently
 * without replacing dependencies a browser is still importing.
 *
 *   npm run e2e                          the whole suite, both lanes
 *   npm run e2e -- --shard=2/3           one third of each lane, packed by recorded time
 *   npm run e2e -- --lanes               print the partition, run nothing
 *   npm run e2e -- --record-timings      run, and record each spec's seconds
 *   npm run e2e -- e2e/grid.spec.ts      a filter, applied to both lanes
 *   npm run e2e -- --no-build            use each product's dist/client that is there
 *   npm run e2e -- --package=mistri      one package's specs and the shared ones (scripts/test-owners.mjs)
 *   TABLEWALK_E2E_WORKERS=2 …            override the owned lane's width
 *
 * `--shard` is applied to each lane separately rather than to one run of
 * everything, so a shard gets its share of both rather than one shard
 * inheriting every slow serial spec — the same reason `scripts/test-node.mjs`
 * shards its lanes apart. It is not Playwright's `--shard`, which splits by
 * test count: each lane's spec files are packed by recorded time
 * (`test/e2e-timings.json`, `scripts/e2e-shards.mjs`) and handed to Playwright
 * by name. A lane's spec still runs with that lane's worker count.
 *
 * Every pass runs even if an earlier one fails: a red shared lane should not hide
 * what the owned lane would have said. The exit code is the first failure's.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lanes, sourceClientSpecs } from './e2e-lanes.mjs';
import { ownedBy, packageArg } from './test-owners.mjs';
import { STARTUP_SECONDS, TIMINGS, parseHeadStart, readTimings, shardSpecs } from './e2e-shards.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/* Three, and not a number derived from the core count.

   An owned worker is a browser, a tsx server, and — for most of this lane —
   Better Auth hashing real passwords. The servers no longer each own a Vite
   (the client is built once, above), which was the largest part of what a worker
   cost, so the lane has room it did not have at two. Measured on an eight-core,
   16 GB machine, the whole suite (0.8.6):
     2 workers  18.8 min, the first run against the build (49 specs failed:
                the ones that import client source, since marked)
     3 workers  13.7 min on each of three clean runs, at least 5.2 GiB free
                (vm_stat free + inactive + speculative) and no swapping
     4 workers  12.3 min, and a spec starved past its two-minute budget
                (app-mounts), which is a timeout that says nothing about the code
   Three is the widest that ran clean. Before the build, three held the memory
   but starved a sign-up past its own 60-second budget, and four ran it out.

   A fixed number also keeps the gate the same shape everywhere: CI's two-core
   runners and a developer's laptop run the same lane the same way, so a
   timeout reproduces instead of being somebody's core count. CI sets the
   variable itself (.github/workflows/ci.yml), because two cores and 7 GB are not
   this machine. Raise it with the variable on a quiet machine with memory to
   spare. */
const width = Number(process.env.TABLEWALK_E2E_WORKERS) || 3;

const argv = process.argv.slice(2);
const kept = packageArg(argv);
const partition = lanes();
let owned, shared;
try {
  owned = kept ? ownedBy(partition.owned, kept) : partition.owned;
  shared = kept ? ownedBy(partition.shared, kept) : partition.shared;
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

const shardArg = argv.find((arg) => arg.startsWith('--shard='));
const record = argv.includes('--record-timings');
const noBuild = argv.includes('--no-build');
const rest = argv.filter(
  (arg) =>
    arg !== shardArg &&
    arg !== '--record-timings' &&
    arg !== '--no-build' &&
    !arg.startsWith('--head-start=') &&
    !arg.startsWith('--package='),
);
const [index, total] = shardArg ? shardArg.slice('--shard='.length).split('/').map(Number) : [1, 1];
if (!Number.isInteger(index) || !Number.isInteger(total) || index < 1 || total < 1 || index > total) {
  console.error(`--shard must be i/N with 1 <= i <= N; got ${shardArg}`);
  process.exit(2);
}
/* Work a shard does besides the browser suite, in average shards of it
   (`parseHeadStart` in scripts/test-node.mjs): CI's legs also run the
   visual-matrix smoke, unevenly. */
let headStart;
try {
  headStart = parseHeadStart(argv, total);
} catch (error) {
  console.error(error.message);
  process.exit(2);
}

if (argv.includes('--lanes')) {
  console.log(`shared (${shared.length} specs, 1 worker):`);
  for (const file of shared) console.log(`  ${file}`);
  console.log(`owned (${owned.length} specs, ${width} workers):`);
  for (const file of owned) console.log(`  ${file}`);
  if (shardArg) {
    const timings = readTimings();
    for (const [name, files, workers] of [
      ['shared', shared, 1],
      ['owned', owned, width],
    ]) {
      const mine = shardSpecs(files, index, total, readTimings(), headStart);
      const seconds = mine.reduce((sum, file) => sum + (timings[file] ?? 0), 0) / workers;
      console.log(`shard ${index}/${total} ${name}: ${mine.length} specs, ~${(seconds / 60).toFixed(1)} min`);
      for (const file of mine) console.log(`  ${file}`);
    }
  }
  process.exit(0);
}

/* Neither lane is ever legitimately empty, and an empty one is how a broken
   `testMatch` would look: `--pass-with-no-tests` below is there for a filter
   or a shard that lands entirely in the other lane, and it would hide that. One package's run may leave a lane
   empty, and is not the whole suite. */
if (!kept && (!owned.length || !shared.length)) {
  console.error(`A lane is empty (owned ${owned.length}, shared ${shared.length}); scripts/e2e-lanes.mjs is wrong.`);
  process.exit(2);
}

/** The newest modification time under these paths (files, or directories walked). */
function newest(paths) {
  let latest = 0;
  for (const path of paths) {
    const stat = statSync(join(ROOT, path));
    if (!stat.isDirectory()) {
      latest = Math.max(latest, stat.mtimeMs);
      continue;
    }
    for (const file of globSync('**/*', { cwd: join(ROOT, path) })) {
      try {
        const at = statSync(join(ROOT, path, file));
        if (at.isFile()) latest = Math.max(latest, at.mtimeMs);
      } catch {
        /* removed while walking */
      }
    }
  }
  return latest;
}

/** `vite build`, unless `dist/client` is newer than everything the client is made from.
 * Any file newer than the build — an edit, a checkout — rebuilds; the cost of a wrong
 * guess is five seconds, never a stale page. The public pages' server renderer
 * (vite.ssr.config.ts) is built with it: without dist/ssr a public page is sent
 * undrawn, and the specs that read the drawn HTML fail. @mistriwork/mistri/react (vite.embed.config.ts)
 * is built with them too: e2e/embed-built.spec.ts starts the built library in a host's page,
 * which is the only run of what a host installs. */
function buildClient() {
  /* Each product's client, the older of the two: the database browser's and the App framework's. */
  let stamp = 0;
  try {
    stamp = Math.min(
      ...['tablewalk', 'mistri'].map((product) => statSync(join(ROOT, `packages/${product}/dist/client/index.html`)).mtimeMs),
    );
  } catch {
    /* never built */
  }
  if (
    stamp &&
    existsSync(join(ROOT, 'packages/mistri/dist/ssr/render.js')) &&
    existsSync(join(ROOT, 'packages/mistri/dist/embed/react/index.js')) &&
    stamp >
      newest([
        ...globSync('packages/*/src/{client,shared,embed}', { cwd: ROOT }),
        'packages/kit/package.json',
        'packages/mistri/package.json',
        'vite.config.ts',
        'vite.tablewalk.config.ts',
        'vite.mistri.config.ts',
        'vite.ssr.config.ts',
        'vite.embed.config.ts',
        'scripts/embed-css.mjs',
        'package.json',
        'scripts/generate-icons.mjs',
      ])
  ) {
    console.log("# client: each product's dist/client is current");
    return;
  }
  console.log('# client: vite build');
  for (const config of [
    ['-c', 'vite.tablewalk.config.ts'],
    ['-c', 'vite.mistri.config.ts'],
    ['-c', 'vite.ssr.config.ts'],
    ['-c', 'vite.embed.config.ts'],
  ]) {
    const result = spawnSync('npx', ['vite', 'build', ...config, '--logLevel', 'warn'], { cwd: ROOT, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('# client: the build failed');
      process.exit(result.status ?? 1);
    }
  }
}

/** One lane. `TABLEWALK_E2E_LANE` is how the config knows whether to start the
 * three shared servers; the `owned` lane runs without them on purpose. */
function run(project, workers, files, source) {
  /* A lane's built pass and its source pass are two runs of the same project,
     each handed its specs by name. A spec named on the command line narrows
     them, as it narrowed the single run; the flags go through untouched. */
  const flags = rest.filter((arg) => arg.startsWith('-')),
    filters = rest.filter((arg) => !arg.startsWith('-'));
  const declared = new Set(sourceClientSpecs(files));
  const mine = (shardArg ? shardSpecs(files, index, total, readTimings(), headStart) : files).filter(
    (file) => declared.has(file) === source && (!filters.length || filters.some((filter) => file.includes(filter))),
  );
  const label = `${project} lane${source ? ' (source client)' : ''}`;
  if (!mine.length) {
    console.log(`\n# ${label}: nothing to run${shardArg ? ' in this shard' : ''}`);
    return 0;
  }
  console.log(`\n# ${label}: ${workers} worker${workers === 1 ? '' : 's'}, ${mine.length} specs`);
  /* Recording reads Playwright's JSON report, written beside the list output. */
  const report = record ? join(mkdtempSync(join(tmpdir(), 'tablewalk-e2e-timings-')), `${project}.json`) : undefined;
  /* Each pass writes its failures under its own folder. Playwright empties
     its output folder when a run starts, so with one folder the owned built
     pass's trace and error context were deleted by the source pass after it,
     and CI uploaded only the last pass's `.last-run.json`. */
  const output = flags.some((arg) => arg.startsWith('--output'))
    ? []
    : [`--output=${join('e2e', '.results', `${project}${source ? '-source' : ''}`)}`];
  const result = spawnSync(
    'npx',
    [
      'playwright',
      'test',
      `--project=${project}`,
      `--workers=${workers}`,
      ...output,
      ...(record ? ['--reporter=list,json'] : []),
      '--pass-with-no-tests',
      ...flags,
      ...mine,
    ],
    {
      cwd: ROOT,
      stdio: 'inherit',
      env: {
        ...process.env,
        TABLEWALK_E2E_LANE: project,
        ...(source ? {} : { MISTRI_BUILT_CLIENT: '1' }),
        ...(report ? { PLAYWRIGHT_JSON_OUTPUT_NAME: report } : {}),
      },
    },
  );
  if (report) {
    try {
      collect(JSON.parse(readFileSync(report, 'utf8')));
    } catch {
      /* the lane wrote none */
    }
    rmSync(join(report, '..'), { recursive: true, force: true });
  }
  if (result.error) {
    console.error(`# ${project} lane: ${result.error.message}`);
    return 1;
  }
  /* A signal is not a status. A lane the OOM killer took reports `null`, and
     `?? 0` would have called that green. */
  return result.signal ? 1 : (result.status ?? 1);
}

/* Every pass runs even if an earlier one fails. */
const timings = {};

/** A Playwright JSON report folded into per-spec seconds: the sum of its tests'
 * durations (retries included) plus the startup a spec costs on top. */
function collect(report) {
  const seconds = {};
  const walk = (suite) => {
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests)
        seconds[`e2e/${spec.file}`] =
          (seconds[`e2e/${spec.file}`] ?? 0) + test.results.reduce((sum, result) => sum + result.duration, 0) / 1000;
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of report.suites ?? []) walk(suite);
  for (const [file, time] of Object.entries(seconds)) timings[file] = Math.round((time + STARTUP_SECONDS) * 10) / 10;
}

const needsBuild = [shared, owned].some((files) => files.some((file) => !sourceClientSpecs([file]).length));
if (!noBuild && needsBuild) buildClient();
const results = [
  run('shared', 1, shared, false),
  run('shared', 1, shared, true),
  run('owned', width, owned, false),
  run('owned', width, owned, true),
];
if (record) {
  /* Merged over the last record, so one shard's run refreshes its specs and keeps the others'. */
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
  console.log(`# timings: ${Object.keys(timings).length} specs recorded in ${relative(ROOT, TIMINGS)}`);
}
process.exit(results.find((code) => code) ?? 0);
