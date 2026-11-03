/**
 * The browser suite.
 *
 * `npm test` covers the language, the adapters and the pure client modules.
 * None of it can see a `null` printed under a table, a row that looks
 * clickable and is not, a frozen column with a hairline gap through which the
 * scrolling content flickers, or a completion list that opens off the bottom
 * of the screen. Every one of those was found by looking at the page, and this
 * config exists so that looking at the page is something CI can do.
 *
 * It runs behind `npm run e2e` rather than in `npm test` because it needs a
 * browser download, which is not a thing to put in the default path of a tool
 * whose pitch is "one command, no setup".
 *
 *   npx playwright install chromium   once, per machine
 *   npm run e2e                       thereafter
 *
 * The server, the databases and the config file it reads are all built here.
 * Nothing outside `e2e/.tmp` is written, and `.demo/` is never read — what a
 * previous seeding left on disk is not something a test should depend
 * on.
 *
 * `npm run e2e` is `scripts/test-e2e.mjs`, which runs this config twice: once
 * for the `owned` project, several workers wide and with no shared server, and
 * once for the `shared` project, one worker as the whole suite once was.
 * `scripts/e2e-lanes.mjs` derives which project a spec belongs to and says why.
 * A bare `npx playwright test` is still the old single serial run of everything,
 * with the client served from source through Vite. `scripts/test-e2e.mjs` builds
 * the client once and sets `MISTRI_BUILT_CLIENT=1`, which the servers below
 * inherit and which makes them send the kit's `dist/client` (packages/engine/src/server/devclient.ts); a
 * spec that needs the source says `e2e-client: source` and runs unbuilt.
 */
import { defineConfig, devices } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { APP_DEMO_DB, buildFixtures, CRM_CLOCK, CRM_CONFIG, SEEN_TOUR, TMP, writeSeenTour } from './e2e/support/fixtures';
import { lanes } from './scripts/e2e-lanes.mjs';

/* Every server this config starts, and every spec's own, inherits it: the specs sign in many times from 127.0.0.1,
   so Better Auth's per-address limits are lifted on a loopback server (auth.ts authLimitsOffForTests). */
process.env.MISTRI_TEST_AUTH_LIMITS ??= 'off';

/* Which lane this invocation is: `scripts/test-e2e.mjs` runs the suite twice
   and says so here, because `webServer` is a property of the whole config and
   cannot be given per project. Unset — a bare `npx playwright test` — means
   both projects, every server, one worker: the suite as it was. */
const lane = process.env.TABLEWALK_E2E_LANE;
const { owned, shared } = lanes();

/** A lane as `testMatch`: the exact files, anchored, rather than a glob that
 * could quietly match one more. `lanes()` returns repository-relative paths. */
function laneMatch(files: string[]): RegExp {
  return new RegExp(`[\\\\/](?:${files.map((file) => file.slice('e2e/'.length).replace(/\./g, '\\.')).join('|')})$`);
}

/**
 * A port nobody is listening on, chosen once.
 *
 * Hard-coding one means the suite fights whatever the developer left running
 * on 4111, and `--port 0` is no help because the point of choosing is knowing
 * the number. A child process is the only way to ask the OS this question
 * synchronously, which is what a config body needs.
 */
function freePort(): number {
  return Number(
    execFileSync(process.execPath, [
      '-e',
      "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})",
    ])
      .toString()
      .trim(),
  );
}

/* This file is evaluated more than once: the runner reads it, and so does
   every worker process it forks. Both halves below have to happen exactly
   once, for different reasons, and the environment is what carries the answer
   across the fork.

   The ports, because a worker that picked its own would point the browser at
   a port nothing is serving — which is precisely what happened, as a `baseURL`
   of `http://127.0.0.1:NaN`.

   The fixtures, because building them starts by deleting the directory. Doing
   that on worker startup pulls the databases out from under a server that
   already has them open, mid-run.

   Built here rather than in `globalSetup` because Playwright starts
   `webServer` *before* global setup, and the server opens its first database
   at boot. */
if (!process.env.TABLEWALK_E2E_APP_PORT) {
  buildFixtures();
  process.env.TABLEWALK_E2E_APP_PORT = String(freePort());
}
/* The suite's `baseURL`: the fieldops example over the built-in demo
   database. */
const appPort = Number(process.env.TABLEWALK_E2E_APP_PORT);

/* A second server, for the CRM example — the app that uses every knob. Its
   own port, asked again until it differs: freePort closes its listener before
   answering, so two asks *can* return the same number. */
if (!process.env.TABLEWALK_E2E_CRM_PORT) {
  let picked = freePort();
  while (picked === appPort) picked = freePort();
  process.env.TABLEWALK_E2E_CRM_PORT = String(picked);
}
const crmPort = Number(process.env.TABLEWALK_E2E_CRM_PORT);

/* Written once, by whichever process built the fixtures. Every test gets it
   as `storageState`; the three that build their own context ask for it by
   name. Without it every test is a first load, and the tour would put a modal
   scrim over the whole suite. Both origins, because each server is its own
   origin and the tour would open there all over again. */
if (!existsSync(SEEN_TOUR)) {
  writeSeenTour(`http://127.0.0.1:${appPort}`, `http://127.0.0.1:${crmPort}`);
}

export default defineConfig({
  testDir: './e2e',
  /* Outside e2e/.tmp, which buildFixtures() deletes at the start of every
     run: a suite run in groups (the way it is run when memory is tight) lost
     each group's failure traces and screenshot diffs to the next group, and a
     flake that did not repeat left no record of which assertion failed. */
  outputDir: './e2e/.results',
  /* Which lane a spec was sorted into is not a property of its screenshot —
     the browser and the platform are. Playwright's default snapshot path
     carries the project name, so splitting the one `chromium` project into two
     lanes orphaned every committed `-chromium-darwin.png`: the next run wrote
     `-shared-darwin.png` baselines of its own and went green comparing against
     nothing it had ever been shown. Pinned to the browser so the committed
     baselines stay the baseline, whatever the lanes are called. */
  snapshotPathTemplate: '{snapshotDir}/{testFileDir}/{testFileName}-snapshots/{arg}-chromium{-snapshotSuffix}{ext}',
  /* One worker, and not for tidiness: the servers below are shared by every
     spec that addresses them, and two browsers saving filters, layouts and
     records into one store fail in ways that say nothing about the page.

     That binds the `shared` project below, which is why this stays the default
     for anyone who runs `npx playwright test` by hand. `scripts/test-e2e.mjs`
     raises it for the `owned` project, whose specs each start a server of
     their own and share no such store. */
  workers: 1,
  fullyParallel: false,
  /* No retries. A retried browser test is a flaky test wearing a disguise, and
     the point of this suite is to be believed when it goes red. */
  retries: 0,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  /* More time on CI, not more attempts. The repository's CI runners have two
     cores against a developer machine's many, and each shard boots every
     fixture server; a page that paints in one second here can take several
     there. A missing element still fails, only later, and a retry never hides
     it. */
  timeout: process.env.CI ? 40_000 : 20_000,
  expect: { timeout: process.env.CI ? 15_000 : 7_000 },

  use: {
    baseURL: `http://127.0.0.1:${appPort}`,
    trace: 'retain-on-failure',
    /* Wide enough that the sixteen-column fixture still overflows and the
       three-column one does not, so "this table scrolls sideways" is a
       property of the table rather than of whoever ran the suite. */
    viewport: { width: 1280, height: 900 },
    /* Figures and dates are written in the browser's locale. The specs and
       screenshots read "1,234" and "Mar 5, 2026", so the browser is told
       which locale that is instead of inheriting the machine's. */
    locale: 'en-US',
    storageState: SEEN_TOUR,
  },

  /* Two projects, because Playwright has no per-project worker count: the
     lanes are selected with `--project` and given their own `--workers` by
     `scripts/test-e2e.mjs`, which is what `npm run e2e` runs. `scripts/
     e2e-lanes.mjs` says how a spec is sorted into one. */
  projects: [
    { name: 'owned', testMatch: laneMatch(owned), use: { ...devices['Desktop Chrome'] } },
    { name: 'shared', testMatch: laneMatch(shared), use: { ...devices['Desktop Chrome'] } },
  ],

  /* The `owned` lane gets no servers at all. Not only to save the boot: a spec
     that lands in that lane while secretly wanting a shared server then fails
     at once on a refused connection, instead of quietly racing whichever other
     spec is switching the active connection. The partition is a claim, and
     this is the run checking it. */
  webServer:
    lane === 'owned'
      ? []
      : [
          /* The app server: fieldops over the demo database, which is what
       `apps.spec.ts` is about. */
          {
            command: `npx tsx packages/mistri/src/server/index.ts --demo --app test/fixtures/apps/fieldops --port ${appPort} --no-config`,
            url: `http://127.0.0.1:${appPort}/`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
            env: {
              /* Record layouts and saved filter tabs land in XDG_CONFIG_HOME.
           Without this the suite reads — and writes — the store of whoever is
           running it; and its own, not the other server's, because two
           servers writing one file is the kind of coupling a test failure
           cannot explain. */
              XDG_CONFIG_HOME: `${TMP}/xdg-app`,
              /* `--demo` builds into a directory of its own per process, so two runs
           on one machine cannot overwrite each other's database. This suite
           reads the file it served (apps.spec.ts counts rows in it), so it
           names the path — from fixtures.ts, which the spec reads too. */
              MISTRI_DEMO_DB: APP_DEMO_DB,
              /* `--demo` implies opening a browser — right for a person, wrong for
           a suite that brings forty of its own. The env var has the last
           word, so this is the one place to say no. */
              MISTRI_OPEN: '0',
            },
          },
          {
            command: `npx tsx packages/mistri/src/server/index.ts --config ${CRM_CONFIG} --app test/fixtures/apps/crm --port ${crmPort}`,
            url: `http://127.0.0.1:${crmPort}/`,
            reuseExistingServer: false,
            stdout: 'pipe',
            stderr: 'pipe',
            timeout: 30_000,
            /* The clock is pinned to the day the CRM database was seeded for, so
         its date phrases hold the same rows on every run (fixtures.ts). */
            env: { XDG_CONFIG_HOME: `${TMP}/xdg-crm`, MISTRI_OPEN: '0', MISTRI_CLOCK: CRM_CLOCK },
          },
        ],
});
