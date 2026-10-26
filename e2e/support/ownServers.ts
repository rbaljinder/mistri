/**
 * The three fixture servers, one set per worker.
 *
 * `playwright.config.ts` starts three servers for the whole suite — the
 * explorer over the fixture databases, Field Ops over the demo, Compass over
 * the CRM — and a tablewalk process holds one active connection, so every
 * spec that addresses them runs one at a time (scripts/e2e-lanes.mjs). A spec
 * that imports `test` from here addresses servers of its worker's own instead:
 * each on a port reserved when this module loads, over copies of the fixture
 * databases in a `mkdtemp` directory, with a config store of its own. Nothing
 * is shared with another worker, so such a spec runs in the parallel lane.
 *
 * A spec names the servers it uses (`test.use({ servers: ['explorer', 'crm'] })`;
 * the explorer alone when it says nothing). They start before its first test
 * and stop with the worker. The first named is `baseURL`, so `page.goto('/demo')`
 * and support/app's `open()` read as they did against the config's server; the
 * others are addressed by their origin below. Every one is marked as having
 * shown its tour, as the config's `seen-tour.json` marks its three.
 *
 * The paths below are this worker's copies — a spec that asks the database
 * what the page should say asks the one its server serves.
 *
 * test-package: dispatch — a spec that imports this is owned by the servers it names (scripts/test-owners.mjs):
 * the explorer is the database browser's, Field Ops and Compass are mistri's.
 */
import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './spawned';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import * as shared from './fixtures';
import { test as harness } from './harness';

export { expect } from './harness';
export type { Locator, Page } from './harness';
export { DEMO, EDGE, EDGE_LONG_LEN, SCRATCH, WIDE, CRM_CLOCK, CRM_TODAY } from './fixtures';

export type ServerKind = 'explorer' | 'fieldops' | 'crm';

/* Reserved as the module loads, in whichever process loads it: the runner
   lists the tests too, and a worker's constants must be the same ones its
   spec read at the top of the file. Closed before the server binds it, as
   the config's own `freePort` is. */
function freePort(): number {
  /* Without the worker's NODE_OPTIONS: Playwright's loader, inherited, left
     the child's answer empty. */
  const answer = Number(
    execFileSync(
      process.execPath,
      ['-e', "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"],
      { env: { PATH: process.env.PATH ?? '' } },
    )
      .toString()
      .trim(),
  );
  if (!Number.isInteger(answer) || answer <= 0) throw new Error('No free port was found for a fixture server.');
  return answer;
}
const ports = new Set<number>();
function port(): number {
  let picked = freePort();
  while (ports.has(picked)) picked = freePort();
  ports.add(picked);
  return picked;
}
const origin = (at: number) => `http://127.0.0.1:${at}`;

/* The runner loads every spec to list its tests, and starts no server: only
   a worker reserves ports and makes a directory. */
const worker = process.env.TEST_WORKER_INDEX !== undefined;
if (worker) mkdirSync(shared.TMP, { recursive: true });
const HOME = worker ? mkdtempSync(join(shared.TMP, 'own-')) : join(shared.TMP, 'own-runner');
const PORTS: Record<ServerKind, number> = worker
  ? { explorer: port(), fieldops: port(), crm: port() }
  : { explorer: 0, fieldops: 0, crm: 0 };

/** This worker's servers, by what they serve. */
export const EXPLORER = origin(PORTS.explorer);
export const FIELDOPS = origin(PORTS.fieldops);
export const CRM = origin(PORTS.crm);
/** Compass, on this worker's CRM server. */
export const COMPASS = CRM;

/* This worker's copies of the fixture databases (support/fixtures.ts says
   what each is for), made as the module loads: a spec may ask one what to
   expect while its tests are being listed, before any server starts. The
   runner, which lists them too, reads the originals — the same rows. */
const copy = (from: string) => {
  if (!worker) return from;
  const to = join(HOME, basename(from));
  cpSync(from, to);
  return to;
};
export const DEMO_DB = copy(shared.DEMO_DB);
export const WIDE_DB = copy(shared.WIDE_DB);
export const SCRATCH_DB = copy(shared.SCRATCH_DB);
export const EDGE_DB = copy(shared.EDGE_DB);
export const CRM_DB = copy(shared.CRM_DB);
/** Where Field Ops' `--demo` builds its database, which apps.spec.ts counts rows in. */
export const APP_DEMO_DB = worker ? join(HOME, 'demo-app', 'demo.db') : shared.APP_DEMO_DB;

/** Each server's own config store (XDG_CONFIG_HOME): saved filters, layouts and pages land there. */
export const configHome = (kind: ServerKind) => join(HOME, `xdg-${kind}`);

/** A browser that has seen the tour on these servers: for a context a test builds itself. */
export function seenTour(kinds: readonly ServerKind[] = ['explorer', 'fieldops', 'crm']) {
  return {
    cookies: [],
    origins: kinds.map((kind) => ({ origin: origin(PORTS[kind]), localStorage: [{ name: 'mistri.tour.v1', value: 'done' }] })),
  };
}

/** What each server is, as the config starts it (playwright.config.ts). */
function launch(kind: ServerKind): { args: string[]; env: Record<string, string> } {
  const xdg = configHome(kind);
  if (kind === 'explorer') {
    const config = join(HOME, 'mistri.json');
    writeFileSync(
      config,
      `${JSON.stringify(
        {
          connections: [
            { name: 'demo', url: DEMO_DB },
            { name: 'wide', url: WIDE_DB },
            { name: 'scratch', url: SCRATCH_DB, writable: true },
            { name: 'edge', url: EDGE_DB },
          ],
        },
        null,
        2,
      )}\n`,
    );
    return { args: ['--config', config], env: { XDG_CONFIG_HOME: xdg } };
  }
  if (kind === 'fieldops') {
    return {
      args: ['--demo', '--app', 'test/fixtures/apps/fieldops', '--no-config'],
      env: { XDG_CONFIG_HOME: xdg, MISTRI_DEMO_DB: APP_DEMO_DB },
    };
  }
  const config = join(HOME, 'crm.json');
  writeFileSync(config, `${JSON.stringify({ connections: [{ name: 'crm', url: CRM_DB, writable: true }] }, null, 2)}\n`);
  return {
    args: ['--config', config, '--app', 'test/fixtures/apps/crm'],
    env: { XDG_CONFIG_HOME: xdg, MISTRI_CLOCK: shared.CRM_CLOCK },
  };
}

async function start(kind: ServerKind): Promise<() => Promise<void>> {
  const { args, env } = launch(kind);
  const child: ChildProcess = spawn(
    process.execPath,
    /* The explorer is the database browser; fieldops and crm serve an App, which is mistri's binary. */
    [
      '--import',
      'tsx',
      resolve(`packages/${kind === 'explorer' ? 'tablewalk' : 'mistri'}/src/server/index.ts`),
      ...args,
      '--port',
      String(PORTS[kind]),
    ],
    {
      env: { ...process.env, [kind === 'explorer' ? 'TABLEWALK_OPEN' : 'MISTRI_OPEN']: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = once(child, 'close');
    child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 5000);
    try {
      await closed;
    } finally {
      clearTimeout(force);
    }
  };
  try {
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => finish(new Error(`The ${kind} server did not start: ${log}`)), 30_000);
      const ready = () => {
        if (log.includes('Listening on ')) finish();
      };
      const exited = () => finish(new Error(`The ${kind} server exited during startup: ${log}`));
      const finish = (error?: Error) => {
        clearTimeout(timer);
        child.stdout!.off('data', ready);
        child.off('exit', exited);
        if (error) fail(error);
        else done();
      };
      child.stdout!.on('data', ready);
      child.once('exit', exited);
      ready();
    });
    return stop;
  } catch (error) {
    await stop();
    throw error;
  }
}

export const test = harness.extend<object, { servers: ServerKind[]; own: void }>({
  servers: [['explorer'], { scope: 'worker', option: true }],
  own: [
    async ({ servers }, use) => {
      const stops: Array<() => Promise<void>> = [];
      try {
        for (const kind of servers) stops.push(await start(kind));
        await use();
      } finally {
        for (const stop of stops.reverse()) await stop();
      }
    },
    { scope: 'worker', auto: true, timeout: 90_000 },
  ],
  baseURL: async ({ servers }, use) => {
    await use(origin(PORTS[servers[0]]));
  },
  storageState: async ({ servers }, use) => {
    await use(seenTour(servers));
  },
});
