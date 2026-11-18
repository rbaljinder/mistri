/*
 * A disposable server over the Command drawer fixture
 * (test/fixtures/apps/command-drawer): real commands, real authentication, a
 * fresh SQLite database per start, one signed-up account.
 */
import { execFileSync } from 'node:child_process';
import { withFreePort } from './freePort';
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const APP_ID = 'command-drawer-fixture';
const FIXTURE = resolve('test/fixtures/apps/command-drawer');

export async function startDrawerApp() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-command-drawer-'));
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
    // The seed migrates the command journal through the package's source, which only tsx resolves: its own process.
    const database = join(directory, 'clinic.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    const app = join(authoring, 'app.ts');
    writeFileSync(
      app,
      `import app from ${JSON.stringify(pathToFileURL(join(FIXTURE, 'app.ts')).href)};
      export default {...app, id: '${APP_ID}',
        auth: {...app.auth, providers:['email'],signUp:'open',defaultRole:'nurse',store:${JSON.stringify(join(directory, 'sessions.db'))}}};`,
    );
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
          app,
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
            BETTER_AUTH_SECRET: 'isolated-command-drawer-secret-at-least-thirty-two-characters',
            MISTRI_AUTH_ADMIN_EMAIL: '',
            MISTRI_AUTH_ADMIN_PASSWORD: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const running = child;
      let log = '';
      await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => reject(new Error(`Command drawer fixture startup timed out: ${log}`)), 20_000);
        const take = (chunk: unknown) => {
          log += String(chunk);
          if (log.includes('Listening on ')) {
            clearTimeout(timer);
            done();
          }
        };
        running.stdout!.on('data', take);
        running.stderr!.on('data', take);
        running.once('exit', () => {
          clearTimeout(timer);
          reject(new Error(`Command drawer fixture exited: ${log}`));
        });
      });
      return port;
    });
    const origin = `http://127.0.0.1:${port}`;
    const account = { name: 'nurse', email: 'nurse@example.test', password: 'command-drawer-nurse-password' };
    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(account),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error('Command drawer fixture could not create its account.');
    return { origin, database, account, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
