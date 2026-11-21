/*
 * A disposable server over the Layers fixture (test/fixtures/apps/layers): a local App with free-form pages, a fresh
 * SQLite database per start, on a port of its own. Modeled on doorServer.
 */
import { execFileSync } from 'node:child_process';
import { withFreePort } from './freePort';
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** A fixture App of this shape (a local App with free-form pages over a SQLite seed): Layers unless another is named.
 * `writable` opens its connection to writes, which is what gives a related list its Add; `env` is read by a fixture's
 * app.ts, for a second shape of the one App (page-kit's header as a bar). */
export async function startLayersApp(fixture = 'layers', options: { writable?: boolean; env?: Record<string, string> } = {}) {
  const FIXTURE = resolve('test/fixtures/apps', fixture);
  const directory = mkdtempSync(join(tmpdir(), 'mistri-layers-'));
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const database = join(directory, `${fixture}.db`);
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    if (options.writable || options.env) {
      const config = JSON.parse(readFileSync(`${database}.json`, 'utf8')) as {
        connections: Array<Record<string, unknown>>;
        apps?: unknown;
      };
      if (options.writable) for (const connection of config.connections) connection.writable = true;
      /* A definition reads only what the config passes it (apps.ts): the --app below is this same entry, not a
         second App. */
      if (options.env) config.apps = [{ dir: FIXTURE, env: Object.keys(options.env) }];
      writeFileSync(`${database}.json`, JSON.stringify(config, null, 2));
    }
    let log = '';
    const port = await withFreePort(async (port) => {
      child = spawn(
        process.execPath,
        [
          '--import',
          'tsx',
          'packages/mistri/src/server/index.ts',
          '--config',
          `${database}.json`,
          '--app',
          FIXTURE,
          '--port',
          String(port),
        ],
        {
          env: { ...process.env, ...options.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const running = child;
      log = '';
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`Layers fixture startup timed out: ${log}`)), 60_000);
        const read = (chunk: unknown) => {
          log += String(chunk);
          if (log.includes('Listening on ')) {
            clearTimeout(timer);
            done();
          }
        };
        running.stdout!.on('data', read);
        running.stderr!.on('data', read);
        running.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Layers fixture exited: ${log}`));
        });
      });
      return port;
    });
    return { origin: `http://127.0.0.1:${port}`, database, stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}
