/*
 * A disposable server over the Saved application fixture
 * (test/fixtures/apps/saved-application): a public form saved on every step,
 * real commands, a fresh SQLite database per start, on a port of its own.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SAVED_APP_ID = 'saved-application';
const FIXTURE = resolve('test/fixtures/apps/saved-application');

/** `flags`: more of the server's own, such as where the App is mounted (`--mount`, `--base-path`). */
export async function startSavedFormApp(flags: readonly string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-saved-form-'));
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
    const database = join(directory, 'lending.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    const app = join(authoring, 'app.ts');
    writeFileSync(
      app,
      `import app from ${JSON.stringify(pathToFileURL(join(FIXTURE, 'app.ts')).href)};
      export default { ...app, auth: { ...app.auth, store: ${JSON.stringify(join(directory, 'sessions.db'))} } };`,
    );
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
        app,
        '--commands',
        join(FIXTURE, 'commands.ts'),
        '--port',
        String(port),
        ...flags,
      ],
      {
        env: {
          ...process.env,
          DATABASE_URL: '',
          XDG_CONFIG_HOME: join(directory, 'xdg'),
          MISTRI_OPEN: '0',
          BETTER_AUTH_SECRET: 'isolated-saved-application-secret-at-least-thirty-two',
          MISTRI_AUTH_ADMIN_EMAIL: '',
          MISTRI_AUTH_ADMIN_PASSWORD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const running = child;
    let log = '';
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`Saved application fixture startup timed out: ${log}`)), 20_000);
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
        reject(new Error(`Saved application fixture exited: ${log}`));
      });
    });
    return { origin: `http://127.0.0.1:${port}`, database, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
