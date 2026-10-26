#!/usr/bin/env node
/**
 * The typecheck an App's author waits for, held to a ceiling. Run by
 * `npm run build`, after the bundle budget: it needs the packages' built
 * declarations (each package's dist/), because that is what an App outside
 * this repository types against. Run with `--conditions=mistri-built`, as the
 * build runs it: the built typegen imports the engine's built modules.
 *
 * An outside review asked whether a large App's typecheck could break an
 * agent's edit loop, and the only number anyone had was misleading: Ignition's
 * tsconfig in this repository maps `@mistriwork/mistri/commands` to src/, so `tsc` there
 * checks tablewalk's own server as well (543 files, 113k types, where a user's
 * copy of the same App makes 34k). So each App is measured here the way a
 * user's project holds it: copied out of the repository, `tablewalk` resolved
 * through the packages' exports maps (schema/*.d.ts and dist's declarations),
 * `@types/node` beside it, no `paths`. The Apps are Compass, Ignition with its
 * server modules, and a generated one of 150 tables (scripts/synthetic-app.mjs),
 * which is the size the review worried about and the one the budget is for.
 *
 * What is held is what does not depend on the machine: the types and
 * instantiations tsc creates and the symbols, which grow with the work and are
 * the same on every run of one TypeScript version. They are read from the
 * installed `tsc --extendedDiagnostics`: TypeScript 7, the native compiler, has
 * no in-process program to ask, and prints these three and no others. Time is
 * reported beside them, as the wall time of the process and as that time scaled
 * to an unloaded core (`calibrate`), and held only to a ceiling generous enough
 * that a loaded CI runner passes and a blowup does not.
 *
 * What an editor pays after an edit is not measured here any more: it was a
 * new in-process program over the old one's unchanged files, which is the
 * TypeScript 5 API and has no counterpart in 7's. A cold check of the largest
 * App is now under a second, so the cold budget is what holds it.
 *
 * The ceilings sit a little above what ships today, so an ordinary change
 * passes and a type that multiplies by the schema does not. Raising one is
 * allowed; it is a decision, made in this file, with the reason beside it.
 * A TypeScript upgrade moves every count a little: re-measure (`--print`) and
 * say so here.
 *
 *   node scripts/type-budget.mjs            measure the three Apps and check them
 *   node scripts/type-budget.mjs --print    say the numbers, check nothing
 *   node scripts/type-budget.mjs --only synthetic
 */
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { installPackages } from './install-packages.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(ROOT, 'package.json'));

/* Counts, per App, with TypeScript 7.0.2: types, instantiations and symbols.
   TypeScript 7 counts differently from 5, and not by a constant: the same Apps
   measured 1.9-2.3x the types and 1.8-2.3x the instantiations, and the
   assignability relations are no longer reported, so there is no ceiling on
   them. The history below is TypeScript 5's, kept for what each change cost
   relative to the one before; the ceilings are 7's, about 3% above:
     synthetic  152,468 / 869,577 / 388,928   0.7 s wall (5.9.3: 3.9 s of CPU, 2.0 s wall)
     compass     27,949 / 129,840 /  63,742   0.2 s        (1.4 s CPU, 0.6 s wall)
     ignition    56,625 / 220,521 / 172,598   0.3 s        (2.1 s CPU, 0.9 s wall)
   Ignition's count includes `types: ["node"]`, which TypeScript 7 no longer
   loads on its own. Before 0.8.2 (the same harness,
   types / instantiations / symbols / relations):
     synthetic  102,396 / 568,445 / 314,222 / 240,190   4.2 s of an unloaded M2 core, the median of three
     compass     10,794 /  36,995 /  63,204 /   6,869   1.0 s
     ignition    33,559 / 139,075 / 133,950 /  24,620   1.8 s
   Two things were a sixth of the large App's check and more than a third of
   Ignition's types, and neither was the schema's:
     - defineApp and defineFeature intersect the App with its references, and
       tsc relates a value to an intersection of two array types member by
       member, `map` and `flatMap` included. A list that passes is now handed
       back as itself (`Same`, packages/mistri/schema/app.d.ts).
     - defineFeature handed its feature back remapped through `Authored`, so
       `satisfies App` judged every feature again from scratch. It hands back
       the type `satisfies Feature` judged, and tsc answers from its cache.
   After them:
     synthetic   80,364 / 428,389 / 258,494 / 147,311   3.4 s; an edited feature module 0.8 s
     compass      9,641 /  33,640 /  61,082 /   6,407   0.9 s; 0.2 s
     ignition    21,372 /  85,210 / 107,283 /  15,476   1.5 s; 0.3 s
   and the ceilings sit about 5% above. Named action references in 0.8.2 add
   checks of each header and role grant against its resource's action keys.
   PageRefs checks only those names on the valid path, avoiding a second
   comparison of all page sections. After that optimization, instantiations
   are 450,168 / 36,754 / 92,462 for synthetic / Compass / Ignition; all
   other counts remain inside their existing ceilings. Cold checks are
   3.4 / 1.0 / 1.6 scaled seconds and feature edits 0.82 / 0.19 / 0.30.
   Only instantiation ceilings rise, with about 2% headroom for these new
   checks; the time and other structural budgets stay fixed.
   0.8.5: the synthetic App's generator still wrote `if:` after the rename to
   `when:`, so its 148 type errors inflated its counts; fixed, it measures
   81,057 / 447,485 / 261,285 / 148,585, inside its ceilings. Compass's
   relations rose to 6,701 (one over) with the widened app.d.ts surface
   (workflows, analytics, inbound webhooks); its ceiling is now 6,800.
   0.8.5, one way per thing: the helpers became the only spelling, so every
   view, section, presentation and action that was an object literal is now
   a generic helper call, each one an instantiation and a mark (`MadeBy`) to
   relate. No App has an error; synthetic measures 79,612 / 448,144 / 267,244
   / 141,882, inside its ceilings; Compass 10,772 / 41,926 / 65,223 / 6,976
   and Ignition 22,224 / 97,119 / 114,448 / 15,241. Compass's four ceilings
   and Ignition's instantiations and symbols rise to about 3% above those,
   the price of one spelling; the time budgets stay fixed.
   0.8.5, DSL compaction: the form-rule, duration and shared-link types add
   a few hundred types to every App; Ignition measures 22,596 types, so its
   types ceiling is 22,700. Nothing else moved.
   0.8.5, typed query strings (packages/mistri/schema/query.d.ts): each `query`, `sort`, `by`
   and `when` is read word by word against its table's registered `Columns`,
   one template-literal instantiation per word. Compass measures 12,051 /
   57,871 / 66,428 / 8,305 (+12% types, +38% instantiations, as the proposal
   predicted), Ignition 23,819 / 108,792 / 115,940 / 16,484, synthetic
   instantiations 481,296. Those ceilings rise to about 3% above; symbols
   and the time budgets stay fixed.
   What is left grows with pages × tables
   and dashboards × tables: a section is judged against one union of every
   table for every section kind (TypedPageSection, TypedDashSection), made
   again for each page's base, and tsc searches it member by member. Without
   page typing the large App makes 47,639 types and 225,246 instantiations.
   Ignition types 24,500 → 25,300 (0.8.5, W13 and the leftovers): typed
   `when` on notify rules and fixed actions, and list board/split options,
   measured at 24,626; about 3% above it.
   0.8.7, query strings checked everywhere: a metric's compare and target
   (`MetricGuard`, kept off the other helpers, which have neither), a
   rollup's column, a page section's `when`, a custom section's rows and a
   resource block's action, notify and machine `when` are read like a query.
   Before, synthetic / Compass / Ignition made 870,106 / 130,177 / 221,534
   instantiations; now 894,984 / 134,055 / 227,225 (+2.9% / +3.0% / +2.6%),
   most of it the resource-block guard. Compass and Ignition were over by
   0.3% and 0.1%, and synthetic sat 0.1% under, so the three instantiation
   ceilings rise about 2% (to about 2% above the measured counts); types,
   symbols and the time budgets stay fixed.
   0.8.7, a portal's pieces: a dashboard's `find` section is one more member
   of the section union every dashboard is related to, its resources are
   checked against the App's (FindDashSection), a role-chosen top bar names
   the App's roles (ShellRefs), and a card takes a `description`. Compass,
   at 28,679 types the release before, measures 28,807 (+0.4%) and was over
   by 7; its types ceiling rises to 29,300, about 1.7% above. Nothing else
   moved past its ceiling.
   0.8.8, a command's files and the board's verbs: every written table's
   handle gains `insertFile`, a command its `files`, a machine its `entry`,
   a stream its `about`, a composer its `templates` and a tags field its
   `add`/`remove`. Ignition, with the most commands, measures 58,378 types
   (+0.13% over); its types ceiling rises to 58,900, about 1% above. Nothing
   else moved past its ceiling.
   0.8.9, the component pack's first part: a display rule gains eight
   formats (avatars, rating, color, time, month, year, json, qr) and
   `outOf`, `ring`, `slider`, `colors` and a toned `icon`; a breakdown its
   `shape` and `notes`, a chart its `curve` and `total`, a note its banner
   (`variant`, `eyebrow`, `image`, and an overload so a plain note stays a
   page's), a dashboard its `windowControl`, a board its `category` and
   `footer`, a nav entry its `color`. Every one is a fixed word or a
   column, nothing that grows with the schema; the display rule is related
   once per column, which is where most of it lands. Measured: synthetic
   157,822 / 920,660 / 395,842, Compass (which now wears a slider and the
   date-range button) 29,968 / 139,590 / 67,441, Ignition 59,177 / 232,741
   / 176,926. The ceilings that were passed rise to about 1.5% above.
   0.8.9, the Tier 2 pack: five chart shapes and a chart's `x`, the `tree`
   and `gantt` presentations, and `scan` and `signature` on a display rule,
   each a fixed word or a column. With Compass's own consumers left out it
   measures 30,080 / 139,442 / 67,491, under its ceilings; the pack's sample
   use in it (a funnel, a scatter, an account tree and a campaign gantt:
   four sections and two views, each a call checked against the schema)
   brings it to 30,496 / 142,368 / 68,429. Compass's ceilings rise to about
   1.5% above that; synthetic and Ignition stay where they were.
   1.0's App vocabulary (packages/mistri/schema/app.d.ts): money kept in minor units and a row's own currency column, a New
   form's `lines` and `live` totals, an editing related list's `edit` and `order`, the New menu's groups and
   `service` roles. Each is a fixed word or a column, nothing that grows with the schema, but Compass is typed
   against all of it: 30,702 / 142,962 / 69,484, 34 symbols past its ceiling, which moves to 69,600; its types
   and instantiations hold, as do synthetic's and Ignition's.
   0.9.0's App vocabulary: a union's branches, a document, a page's figure words, a call to action, a reader's
   locale and zone, audiences, the App's message catalog and a record's messages. Most are fixed words or a
   column; a record's messages (`TypedRecordMessages`) are one spec per table, the one part that grows with the
   schema. Ignition, with the most tables, measures 60,226 / 236,309 / 181,089, past all three ceilings (symbols
   by 1.8%). Compass measures 30,929 / 144,391 / 70,019, 419 symbols past. The ceilings that were passed rise to
   about 1% above; putting a record's messages behind a lookup is the way to take the per-table part back.
   The page DSL's split (card(), headline(), related(title, from, match), msg() beside every reader-facing
   word): a related section's `whose`, `same` and `near` are three optional keys per table rather than a
   union (a union of two branches per table cost 40,000 more types; the parser refuses both at once), and
   `same` names the listed table's columns only. Synthetic measures 165,095 / 896,012 / 452,254, Compass
   31,317 / 145,905 / 71,057, Ignition 60,880 / 233,415 / 184,246; their types and symbols ceilings rise
   to about 1.5% above. Instantiations fell, so those ceilings hold.
   Compass's own sales dashboard then gained two typed measures (`sum minutes * 60` as a duration, `sum weighted /
   sum amount * 100` as a percent), each parsed by the measure types term by term: 31,130 / 147,494, past types and
   instantiations. That is Compass's code, not the vocabulary (Ignition held), so only Compass's ceilings rise.
   0.9.1's vocabulary: `segments` (a name a tab, a metric and a rollup each check), a list filter's dotted parent
   path and its `{ has, filter | segment, via }` child entry, a line's `consumes`, and a form default `from` a
   reference. A segment name and a filter path are checked against the schema, so they grow with it: synthetic
   measures 181,613 / 976,895 / 473,111, past all three by 3 to 9%, and Compass 31,995 types. Ignition holds. The
   ceilings that were passed rise to about 1.5% above; a filter path's walk is the part to put behind a lookup.
   0.9.2: Ignition measures 61,839 types and 238,720 instantiations, 39 and 20 past; the release's theme.d.ts (one
   name per colour, the compiled palette's) and query.d.ts surface are the only declarations Ignition's typecheck
   reads that grew, a few dozen types, nothing that multiplies by the schema. Types and instantiations rise to about
   1.5% above; symbols hold.
   0.9.4: Ignition measures 186,685 symbols, 185 past: the theme vocabulary frozen for 1.0 (type roles, per-role
   weights, shadows, motion, parts) is names in theme.d.ts, read once, nothing per table. Symbols rise to about 1.5%
   above; types and instantiations hold.
   0.9.6: synthetic had 0.08% of its instantiations left (990,788) and Ignition 0.7%. The cost was a page's
   per-table section unions, rebuilt for every page's base: a reference walk carried each hop's table in its
   counter (`[...Hops, H]`), so two paths to one table were two instantiations, where only the counter's length
   is read; and a metric's, chart's and breakdown's `from` and `whose` were picked out of a second object
   (`Pick<Anchor…>`) beside the section's own. The counter now holds `0`s and the anchor carries `from` itself;
   the diagnostics on a file of 21 wrong and right page sections are byte for byte the same. Synthetic measures
   168,502 / 880,358 / 469,457 (11% instantiations left), Compass 28,124 / 117,183 / 60,729, Ignition 60,467 /
   229,758 / 185,884 (5%). The ceilings hold: the headroom is for the vocabulary still to come before 1.0. */
export const BUDGET = {
  synthetic: { types: 184_400, instantiations: 991_600, symbols: 480_200 },
  compass: { types: 32_500, instantiations: 149_000, symbols: 72_000 },
  ignition: { types: 62_800, instantiations: 242_300, symbols: 189_500 },
};

/* Seconds of an unloaded core, scaled from the process's wall time (`calibrate`): a
   ceiling for blowups, not the target. The targets are the budget's (site docs,
   performance.md): a 150-table App checks cold in under 5 s. This sits well
   above that and above what TypeScript 7 takes (under a second), because the
   scaling is an estimate and a CI runner's core is slower than a laptop's. */
export const SECONDS = { cold: 12 };

const TS_DIR = dirname(require.resolve('typescript/package.json'));
const TSC = join(TS_DIR, 'bin', 'tsc');
const TS_VERSION = require(join(TS_DIR, 'package.json')).version;

/** The Apps: where each comes from. */
const APPS = {
  synthetic: {},
  compass: { from: 'test/fixtures/apps/crm' },
  ignition: { from: 'test/fixtures/apps/ignition' },
};

/* ---------- one App, measured in a process of its own ---------- */

/** Check the project cold with the installed `tsc` and read what it counted. */
function measure(tsconfig) {
  return new Promise((done, fail) => {
    const wall0 = performance.now();
    const child = spawn(process.execPath, [TSC, '-p', tsconfig, '--noEmit', '--extendedDiagnostics', '--pretty', 'false'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk;
    });
    child.once('error', fail);
    child.once('close', () => {
      const wallMs = Math.round(performance.now() - wall0);
      const count = (label) => Number(new RegExp(`^${label}:\\s+(\\d+)`, 'm').exec(out)?.[1]);
      const errors = out.split('\n').filter((line) => / error TS\d+/.test(line));
      const result = {
        files: count('Files'),
        types: count('Types'),
        instantiations: count('Instantiations'),
        symbols: count('Symbols'),
        wallMs,
        errors: errors.slice(0, 5),
        errorCount: errors.length,
      };
      if (![result.files, result.types, result.instantiations, result.symbols].every(Number.isFinite))
        fail(new Error(`type-budget: tsc -p ${tsconfig} printed no counts:\n${out}`));
      else done(result);
    });
  });
}

const cpu = () => {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
};

/* ---------- the machine, now ---------- */

/**
 * How much a CPU-time reading taken now overstates an unloaded core: a fixed
 * workload shaped like a checker's (maps, strings, small objects) run many
 * times, its median against its best. On a machine with nothing else to do
 * that is about 1; on a laptop running a test suite beside it, 2 or more.
 */
export function calibrate() {
  const work = () => {
    const m = new Map();
    let s = 0;
    for (let i = 0; i < 60_000; i++) {
      const k = `k${i % 5000}`;
      m.set(k, { a: i, b: k, c: [i, s] });
      s += m.get(k).a & 7;
    }
    return s;
  };
  const runs = [];
  for (let i = 0; i < 300; i++) {
    const c = cpu();
    work();
    runs.push(cpu() - c);
  }
  runs.sort((a, b) => a - b);
  return Math.max(1, runs[runs.length >> 1] / runs[Math.floor(runs.length * 0.02)]);
}

/* ---------- the projects, as a user's ---------- */

/** A directory that holds `tablewalk` the way an installed package does: its exports map, its built declarations. */
async function project() {
  const dir = mkdtempSync(join(tmpdir(), 'tablewalk-type-budget-'));
  /* An App is ES modules, as `tablewalk scaffold` writes its package.json. */
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'type-budget', private: true, type: 'module' })}\n`);
  mkdirSync(join(dir, 'node_modules', '@types'), { recursive: true });
  /* The packages an install brings, each with its built declarations: what a project types against. */
  installPackages(join(dir, 'node_modules'), { filter: (file) => !/\.(?:js|map|br|gz|css|html|json)$/.test(file) });
  symlinkSync(join(ROOT, 'node_modules', '@types', 'node'), join(dir, 'node_modules', '@types', 'node'), 'dir');
  const typegen = await import(pathToFileURL(join(ROOT, 'packages', 'mistri', 'dist', 'server', 'typegen.js')).href);
  const { writeSyntheticApp } = await import(pathToFileURL(join(ROOT, 'scripts', 'synthetic-app.mjs')).href);
  writeSyntheticApp(join(dir, 'synthetic'), typegen);
  for (const [name, app] of Object.entries(APPS)) {
    if (!app.from) continue;
    cpSync(join(ROOT, app.from), join(dir, name), { recursive: true });
    /* The repository's own `paths` point server entries at src/; a user's project has none. */
    writeFileSync(
      join(dir, name, 'tsconfig.budget.json'),
      `${JSON.stringify({ extends: './tsconfig.json', compilerOptions: { paths: null } }, null, 2)}\n`,
    );
  }
  return dir;
}

async function main() {
  const argv = process.argv.slice(2);
  const dist = join(ROOT, 'packages', 'mistri', 'dist', 'server');
  if (!existsSync(join(dist, 'commands.d.ts')) || !existsSync(join(dist, 'typegen.js'))) {
    console.error('type-budget: packages/mistri/dist has no server declarations; run `npm run build` first.');
    return 1;
  }
  const print = argv.includes('--print');
  const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1].split(',') : Object.keys(APPS);
  const dir = await project();
  try {
    const slow = calibrate();
    const measured = Object.fromEntries(
      await Promise.all(
        only.map(async (name) => [name, await measure(join(dir, name, APPS[name].from ? 'tsconfig.budget.json' : 'tsconfig.json'))]),
      ),
    );
    const failures = [];
    const seconds = (ms) => ms / 1000 / slow;
    console.log(`type budget (TypeScript ${TS_VERSION}; this machine now runs ${slow.toFixed(2)}× an unloaded core's CPU time)`);
    for (const [name, m] of Object.entries(measured)) {
      const budget = BUDGET[name];
      const line = (key) => `${key} ${m[key].toLocaleString('en-US')}${budget ? `/${budget[key].toLocaleString('en-US')}` : ''}`;
      console.log(`  ${name.padEnd(10)} ${['types', 'instantiations', 'symbols'].map(line).join('  ')}`);
      console.log(`  ${''.padEnd(10)} cold ${seconds(m.wallMs).toFixed(1)} s (wall ${(m.wallMs / 1000).toFixed(1)} s, ${m.files} files)`);
      if (m.errorCount) failures.push(`${name}: ${m.errorCount} type errors, first: ${m.errors[0]}`);
      for (const key of ['types', 'instantiations', 'symbols']) {
        if (budget && m[key] > budget[key])
          failures.push(`${name}: ${m[key].toLocaleString('en-US')} ${key}, over its ceiling of ${budget[key].toLocaleString('en-US')}`);
      }
      if (seconds(m.wallMs) > SECONDS.cold)
        failures.push(`${name}: a cold check took ${seconds(m.wallMs).toFixed(1)} s of an unloaded core, over ${SECONDS.cold} s`);
    }
    if (print || !failures.length) return 0;
    console.error(`\ntype budget exceeded:\n${failures.map((f) => `  ${f}`).join('\n')}`);
    console.error(
      'A type that grows with the schema belongs behind a lookup, not in a union every App pays for; raise a ceiling only in this file, with the reason.',
    );
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await main();
