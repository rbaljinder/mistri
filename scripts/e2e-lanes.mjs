/**
 * The browser suite in two lanes, because `workers: 1` was set for a reason
 * that binds only part of it.
 *
 * A tablewalk server holds *one* active connection for the whole process
 * (`registry.setActive`, packages/tablewalk/src/server/http/connectionRoutes.ts), and the client
 * never names a connection per request. Two browsers on the three servers
 * `playwright.config.ts` starts therefore fight over one global, which is why
 * the whole suite ran one worker at a time.
 *
 * But most of the tenant, session, sample and Ignition specs never touch those
 * servers: each starts its own on a `listen(0)` port over a `mkdtemp`
 * database, and shares nothing with any other spec. Those were being serialised
 * for somebody else's global.
 *
 * So: a spec that addresses one of the config-file, app or CRM servers runs in
 * the `shared` lane, one worker at a time, exactly as before. Everything else
 * runs in the `owned` lane, several at once. The rule is read off the spec's
 * own source rather than kept as a list, so a new spec that reaches a shared
 * server lands in the serial lane by default rather than by somebody
 * remembering — and the failure mode of the rule is slowness, not a race.
 *
 * A spec can own the three servers too: support/ownServers.ts starts a set per
 * worker, on ports of its own over copies of the fixture databases, and a
 * spec whose `test` comes from there is in the `owned` lane however it
 * navigates — unless it still names a shared port or a shared fixture path.
 *
 * The `owned` lane is run with no `webServer` at all (the runner sets
 * `TABLEWALK_E2E_LANE`), so a spec that slips into it while secretly wanting a
 * shared server fails at once with a refused connection instead of quietly
 * racing. The partition is a claim the run itself checks.
 *
 * A spec that needs the serial lane for a reason this rule cannot see says so
 * in its own text with an `e2e-lane: shared` comment. Two kinds of reason turn
 * up: something shared the rule cannot name — a fixed port, a machine-wide
 * path, a global the runner cannot isolate — and, less obviously, an assertion
 * that is *about* timing rather than about state. A spec measuring layout after
 * a ResizeObserver, or waiting on a first paint, collides with nothing and
 * still gets a different answer when another browser is running; the rule below
 * cannot see that from the imports, so the spec has to say it. Each one says
 * why in its own header, because the next reader's question is whether it still
 * needs to be there.
 */
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** The three servers `playwright.config.ts` starts, as a spec names their ports. */
const SHARED_PORTS = ['TABLEWALK_E2E_PORT', 'TABLEWALK_E2E_APP_PORT', 'TABLEWALK_E2E_CRM_PORT'];

/* The two disposable *paths* under e2e/.tmp. Every other name `fixtures.ts`
   exports is one of the shared fixture databases or the connection names the
   config server serves them under, so importing one is addressing that server
   even when no port is spelled out. */
const DISPOSABLE_FIXTURES = new Set(['TMP', 'SEEN_TOUR']);

/** A file's own escape hatch, for a collision this rule cannot see. */
const DECLARED_SHARED = 'e2e-lane: shared';

/* A spec whose `test` is support/ownServers' addresses its worker's own
   explorer, Field Ops and Compass: `baseURL` is one of them, so a path, and
   `open()`, go there rather than to the config's server. */
const OWN_SERVERS = /import\s*\{[^}]*\btest\b[^}]*\}\s*from\s*'\.\/support\/ownServers'/;

/** Does this spec address one of the servers the config starts? */
function reachesShared(text) {
  if (text.includes(DECLARED_SHARED)) return true;
  if (SHARED_PORTS.some((name) => text.includes(name))) return true;
  const own = OWN_SERVERS.test(text);
  /* A navigation or an API call written as a path is resolved against
     `use.baseURL`, which is the config server. An own-server spec always has
     an origin to put in front. */
  if (!own && /\.(goto|get|post|put|patch|delete|fetch|head)\(\s*[`'"]\//.test(text)) return true;
  /* `open()` from support/app is such a navigation one call deep, and it is
     how most of the explorer specs reach the config server. */
  if (!own && /import\s*\{[^}]*\bopen\b[^}]*\}\s*from\s*'\.\/support\/app'/.test(text)) return true;
  for (const [, names] of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/support\/fixtures'/g))
    if (
      names
        .split(',')
        .map((name) => name.trim().split(/\s+as\s+/)[0])
        .filter(Boolean)
        .some((name) => !DISPOSABLE_FIXTURES.has(name))
    )
      return true;
  return false;
}

/** Every spec, split into the two lanes. Exported so the repository's own
 * structure test can assert the partition covers the suite exactly: a glob can
 * only be misspelled, but a partition can silently drop a spec. */
export function lanes() {
  const files = globSync('e2e/**/*.spec.ts', { cwd: ROOT })
    .map((file) => file.split('\\').join('/'))
    .sort();
  const shared = [],
    owned = [];
  for (const file of files) (reachesShared(readFileSync(resolve(ROOT, file), 'utf8')) ? shared : owned).push(file);
  return { shared, owned };
}

/** A spec's own declaration that it needs the client served from source, through
 * Vite: it imports a client module by its source name (`import('/prefs.js')`) or
 * rewrites one on its way to the page (mutations), and the build has neither.
 * Every other spec runs against the kit's `dist/client` (scripts/test-e2e.mjs). */
export const SOURCE_CLIENT = 'e2e-client: source';

/** The specs that declare it, among `files` (repository-relative). */
export function sourceClientSpecs(files) {
  return files.filter((file) => readFileSync(resolve(ROOT, file), 'utf8').includes(SOURCE_CLIENT));
}
