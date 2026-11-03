/**
 * The databases these tests are about.
 *
 * Built here rather than pointed at `.demo/`, because `.demo/` is whatever the
 * last seeding left behind — a 130k-row database on one machine
 * and a five-row one on another. A browser test that asserts "the Related
 * panel says 3" against a directory anybody can regenerate is a test that
 * fails for reasons that have nothing to do with the browser.
 *
 * Two App servers' databases: the Field Ops demo `--demo` builds, and the
 * CRM's, which its own seeder builds from a fixed day.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything this suite writes lives here, and nothing else does. */
export const TMP = resolve(HERE, '..', '.tmp');

/* Where `--demo` builds the App server's database. `--demo` picks a directory
   of its own per process, so that two runs on one machine cannot overwrite
   each other's; the suite names it instead, because `apps.spec.ts` counts rows
   in the very database the server served. Declared here rather than in the
   config so the server's env and the spec reading it cannot drift: the config
   sets this for the process it spawns, and a spec runs in a *different*
   process that never sees that variable. */
export const APP_DEMO_DB = join(TMP, 'demo-app', 'demo.db');
/* The CRM demo's "today", and the instant its server believes it is: the
   seeder dates everything from this day and the server's date phrases are
   read against the same clock (MISTRI_CLOCK), so "last 90 days" holds
   the same rows on every run and the visual baselines do not drift with
   the calendar. Noon in New York, the app's own zone. */
export const CRM_TODAY = '2026-09-04';
export const CRM_CLOCK = `${CRM_TODAY}T16:00:00.000Z`;

/**
 * A browser that has already been shown the tour.
 *
 * The config hands this to every test as `use.storageState`, which covers the
 * `page` fixture and nothing else — a context a test builds for itself with
 * `browser.newContext()` starts genuinely empty, so the tour opens over it
 * and its scrim eats the first click. Those tests pass this explicitly.
 *
 * It does not weaken what they are testing. "A browser that has never seen
 * this app" is about saved views, pages and layouts, none of which this
 * touches; the tour is chrome, and no deep-link test is about the tour.
 */
export const SEEN_TOUR = join(TMP, 'seen-tour.json');

/** Written by the config, which is the only place that knows the ports.
    One origin per server: localStorage is per-origin, so a tour marked seen
    on the fixture server says nothing to a browser opening the app server. */
export function writeSeenTour(...origins: string[]): void {
  mkdirSync(TMP, { recursive: true });
  writeFileSync(
    SEEN_TOUR,
    `${JSON.stringify({
      cookies: [],
      origins: origins.map((origin) => ({ origin, localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] })),
    })}\n`,
  );
}

/** The CRM example's database and the config that serves it writable, for crm.spec.ts. */
export const CRM_DB = join(TMP, 'crm.db');
export const CRM_CONFIG = join(TMP, 'crm.json');

export function buildFixtures(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  /* The CRM fixture (Compass, once the showcase example) — dashboards, display rules, actions,
     the curated form, section `when` — over the deterministic database its
     own seeder builds. Built where the seeder writes it and copied in, so
     the fixture directory is left exactly as the repo has it. Writable,
     because the write affordances are half of what the spec is about. */
  execFileSync(process.execPath, [join(process.cwd(), 'test', 'fixtures', 'databases', 'crm', 'make-crm-db.mjs'), CRM_DB], {
    stdio: 'ignore',
    env: { ...process.env, MISTRI_CRM_TODAY: CRM_TODAY },
  });
  writeFileSync(CRM_CONFIG, `${JSON.stringify({ connections: [{ name: 'crm', url: CRM_DB, writable: true }] }, null, 2)}\n`);
}
