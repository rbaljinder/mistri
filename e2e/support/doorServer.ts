/*
 * A disposable server over the Door fixture (test/fixtures/apps/door): a
 * landing with hero blocks, a public form behind a human check (Turnstile's
 * local stand-in), its input component and its choices from a table, and a
 * public page with a door of its own — a fresh SQLite database per start, on
 * a port of its own.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from './spawned.js';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const FIXTURE = resolve('test/fixtures/apps/door');

export async function startDoorApp() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-door-'));
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
    const database = join(directory, 'shop.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const reservation = createServer();
    await new Promise<void>((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
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
        '--commands',
        join(FIXTURE, 'commands.ts'),
        '--port',
        String(port),
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: '',
          XDG_CONFIG_HOME: join(directory, 'xdg'),
          MISTRI_OPEN: '0',
          BETTER_AUTH_SECRET: 'isolated-door-fixture-secret-at-least-thirty-two-chars',
          MISTRI_AUTH_ADMIN_EMAIL: '',
          MISTRI_AUTH_ADMIN_PASSWORD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const running = child;
    let log = '';
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Door fixture startup timed out: ${log}`)), 30_000);
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
        reject(new Error(`Door fixture exited: ${log}`));
      });
    });
    return { origin: `http://127.0.0.1:${port}`, database, stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}
