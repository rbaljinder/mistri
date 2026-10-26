/**
 * The databases these tests are about.
 *
 * Built here rather than pointed at `.demo/`, because `.demo/` is whatever the
 * last `npm run demo` left behind — a seeded 130k-row database on one machine
 * and a five-row one on another. A browser test that asserts "the Related
 * panel says 3" against a directory anybody can regenerate is a test that
 * fails for reasons that have nothing to do with the browser.
 *
 * Three connections, because the suite needs three different things:
 *
 *   demo    the small hand-written fixture, and the one every walk test uses.
 *           Read-only, so it is also the connection that proves the server
 *           refuses a write the client was willing to send.
 *   wide    66 tables, for the pinned-column and palette tests. `ticket` has
 *           sixteen columns, which is what makes freezing worth testing.
 *   scratch a copy of demo, marked writable. Writes land here and nowhere
 *           else, so a test that edits a row cannot change what another test
 *           reads.
 *
 * test-package: dispatch — a spec that imports this is owned by the names it takes (scripts/test-owners.mjs):
 * the App's and the CRM's databases are mistri's, the rest the database browser's.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDemoDatabase } from '../../test/make-demo-db.js';
import { makeWideDatabase } from '../../test/make-wide-db.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Everything this suite writes lives here, and nothing else does. */
export const TMP = resolve(HERE, '..', '.tmp');

export const DEMO_DB = join(TMP, 'demo.db');
export const WIDE_DB = join(TMP, 'wide.db');
export const SCRATCH_DB = join(TMP, 'scratch.db');
/** Values a normal fixture does not have: a document-length text, a 64-bit id. */
export const EDGE_DB = join(TMP, 'edge.db');
export const CONFIG = join(TMP, 'mistri.json');
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

/** Connection ids, as the server slugs them from the names below. */
export const DEMO = 'demo';
export const WIDE = 'wide';
export const SCRATCH = 'scratch';
export const EDGE = 'edge';
/** The length of the long text the edge fixture holds, so the test can assert against it. */
export const EDGE_LONG_LEN = 5000;
/** The CRM example's database and the config that serves it writable, for crm.spec.ts. */
export const CRM_DB = join(TMP, 'crm.db');
export const CRM_CONFIG = join(TMP, 'crm.json');

export function buildFixtures(): void {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });

  makeDemoDatabase(DEMO_DB);
  makeWideDatabase(WIDE_DB);
  /* A copy rather than a second build: the write tests assert that a value
     they changed came back, and starting from the same rows the read tests
     use keeps "what should this row hold" answerable in one place. */
  cpSync(DEMO_DB, SCRATCH_DB);

  /* A database of awkward values, for the tests that are about awkward values
     rather than about the walk. A text column long enough to prove the grid
     caps it, and an id past 2^53 to prove the driver reads it. */
  const edge = new DatabaseSync(EDGE_DB);
  edge.exec('CREATE TABLE document (id INTEGER PRIMARY KEY, title TEXT, body TEXT)');
  const insert = edge.prepare('INSERT INTO document VALUES (?, ?, ?)');
  insert.run(1, 'short', 'a brief note');
  insert.run(2, 'long', 'x'.repeat(EDGE_LONG_LEN));
  edge.exec('CREATE TABLE bigid (id INTEGER PRIMARY KEY, note TEXT)');
  edge.exec("INSERT INTO bigid VALUES (9223372036854775807, 'int64 max'), (1, 'ordinary')");
  edge.close();

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

  writeFileSync(
    CONFIG,
    `${JSON.stringify(
      {
        connections: [
          // First is the one the server opens; every test that does not say
          // otherwise is looking at this database.
          { name: 'demo', url: DEMO_DB },
          { name: 'wide', url: WIDE_DB },
          /* The only writable connection in the suite. Opt-in per connection
             is the server's rule, not the browser's, and the read-only pair
             above are what make that assertable. */
          { name: 'scratch', url: SCRATCH_DB, writable: true },
          { name: 'edge', url: EDGE_DB },
        ],
      },
      null,
      2,
    )}\n`,
  );
}
