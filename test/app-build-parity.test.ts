/**
 * A built App behaves exactly like its source, because it is its source.
 *
 * Every public sample is built — with Rolldown, and with the type-stripping
 * fallback a machine without Rolldown takes — and loaded both ways. The
 * definitions must be deep-strictly equal, key order included (the parser's
 * undefined keys too, which plain JSON would have dropped), and the commands
 * and jobs the build registers must be the registrations the source makes,
 * field by field. Ignition is built with its commands and jobs, and loading it
 * needs nothing of a deployment: a platform command resolves its author through
 * `lender_staff.account_id`, so there is no private file to point at.
 */
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildApp } from '../packages/mistri/src/server/build/build.js';
import { loadRolldown } from '../packages/mistri/src/server/build/bundle.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { loadBusinessCommands } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { getCommandEvents } from '../packages/mistri/src/server/commands/businessCommands.js';
import { capturedJobModule } from '../packages/mistri/src/server/jobs/jobModule.js';

const SAMPLES: Record<string, { commands?: string; jobs?: string; dir?: string }> = {
  tick: {},
  lintel: { commands: 'commands.ts', jobs: 'jobs.ts' },
  ladle: { commands: 'commands.ts' },
  /* Public examples until 0.9.2, kept as fixtures. */
  thread: { dir: 'test/fixtures/apps/thread' },
  compass: { dir: 'test/fixtures/apps/crm' },
  commons: { dir: 'test/fixtures/apps/commons', commands: 'commands.ts' },
  /* Retired from the public examples; kept as the HTTP-source fixture. */
  parcel: { dir: 'test/fixtures/apps/parcel' },
  forecourt: { dir: 'test/fixtures/apps/forecourt', commands: 'commands.ts' },
  ignition: { dir: 'test/fixtures/apps/ignition', commands: 'commands.ts', jobs: 'jobs.ts' },
};
const BUNDLERS = { rolldown: loadRolldown, 'strip-types': async () => undefined } as const;

const work = mkdtempSync(join(tmpdir(), 'tablewalk-build-parity-'));
after(() => rmSync(work, { recursive: true, force: true }));

/** Every object as its keys in order, so a deep comparison also compares key order. */
const ordered = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(ordered)
    : value && typeof value === 'object'
      ? Object.keys(value).map((key) => [key, ordered((value as Record<string, unknown>)[key])])
      : value;

const definition = (loaded: LoadedApp) => ({
  app: loaded.app,
  pages: loaded.pages,
  origins: loaded.origins,
  authority: loaded.authority?.report,
  lock: loaded.authority?.lock,
});

/** A registration as data: functions compared by kind, since a bundle may rename them. */
const plain = (value: unknown, seen = new Set<unknown>()): unknown => {
  if (typeof value === 'function') return 'function';
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return 'cycle';
  seen.add(value);
  if (value instanceof Map) return [...value].map(([key, entry]) => [key, plain(entry, seen)]);
  if (value instanceof Set) return [...value].map((entry) => plain(entry, seen));
  if (Array.isArray(value)) return value.map((entry) => plain(entry, seen));
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, plain((value as Record<string, unknown>)[key], seen)]),
  );
};

/** Every object reachable from a value: to ask whether a job's event is the very object a command declares. */
const reachable = (value: unknown, found = new Set<unknown>(), depth = 0): Set<unknown> => {
  if (!value || typeof value !== 'object' || found.has(value) || depth > 8) return found;
  found.add(value);
  for (const entry of value instanceof Map ? value.values() : Object.values(value)) reachable(entry, found, depth + 1);
  return found;
};

async function registrations(file: string) {
  const registry = await loadBusinessCommands(file);
  return {
    registry,
    described: Object.fromEntries(
      Object.keys(registry)
        .sort()
        .map((id) => [id, plain({ command: registry[id], events: getCommandEvents(registry[id]) })]),
    ),
  };
}

for (const [name, entries] of Object.entries(SAMPLES)) {
  describe(`${name}, built`, () => {
    const dir = resolve(entries.dir ?? join('examples/apps', name));
    const entryFiles = Object.fromEntries(
      Object.entries(entries)
        .filter(([kind]) => kind !== 'dir')
        .map(([kind, file]) => [kind, join(dir, file)]),
    );
    let source: LoadedApp;
    before(async () => {
      source = await loadApp(dir);
    });

    for (const [bundler, load] of Object.entries(BUNDLERS)) {
      test(`${bundler}: the build loads as the same App, and registers the same commands and jobs`, async () => {
        const { out, manifest } = await buildApp(
          { app: dir, out: join(work, `${name}-${bundler}`), ...entryFiles },
          { bundler: load, typecheck: false },
        );
        assert.equal(manifest.bundler.name, bundler);
        const built = await loadApp(out);
        assert.ok(built.build, 'a build is loaded as one');
        assert.deepStrictEqual(definition(built), definition(source));
        assert.deepStrictEqual(ordered(definition(built)), ordered(definition(source)), 'key order, undefined keys included');
        assert.deepEqual(Object.keys(built.sources).sort(), Object.keys(source.sources).sort());

        if (entryFiles.commands) {
          const fromSource = await registrations(entryFiles.commands);
          const fromBuild = await registrations(built.build.entries.commands!);
          assert.deepStrictEqual(fromBuild.described, fromSource.described);
          if (entryFiles.jobs) {
            const sourceJobs = capturedJobModule((await import(pathToFileURL(entryFiles.jobs).href)).default);
            const builtJobs = capturedJobModule((await import(pathToFileURL(built.build.entries.jobs!).href)).default);
            assert.deepStrictEqual(plain(builtJobs), plain(sourceJobs));
            /* A module the commands and the jobs share (Ignition's events) is
               one instance from source; the build keeps it one. */
            const shared = (jobs: typeof sourceJobs, registry: Record<string, unknown>) =>
              [...jobs.jobs.values()].map((job) =>
                reachable(Object.values(registry).map((command) => getCommandEvents(command as never))).has(job.event),
              );
            assert.deepStrictEqual(shared(builtJobs, fromBuild.registry), shared(sourceJobs, fromSource.registry));
          }
        }
      });
    }
  });
}
