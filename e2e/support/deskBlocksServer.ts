/*
 * A disposable server over the Desk blocks fixture (test/fixtures/apps/desk-blocks): real commands, real
 * authentication, a fresh SQLite database per start. Modeled on commandDeskServer; one account, signed up through
 * the open sign-up the override turns on.
 */
import { execFileSync } from 'node:child_process';
import { spawn } from './spawned';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const FIXTURE = resolve('test/fixtures/apps/desk-blocks');

export async function startDeskBlocks() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-desk-blocks-'));
  let child: ReturnType<typeof spawn> | undefined;
  let stopping = false;
  const stop = async () => {
    stopping = true;
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
    const database = join(directory, 'desk.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    /* A component's module lives in the App's directory, and the App served is this one: its widgets come along. */
    cpSync(join(FIXTURE, 'widgets'), join(authoring, 'widgets'), { recursive: true });
    const app = join(authoring, 'app.ts');
    writeFileSync(
      app,
      `import app from ${JSON.stringify(pathToFileURL(join(FIXTURE, 'app.ts')).href)};
      export default {...app, auth: {...app.auth, signUp:'open', store:${JSON.stringify(join(directory, 'sessions.db'))}}};`,
    );
    const reservation = createServer();
    await new Promise<void>((done, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, reject) => reservation.close((error) => (error ? reject(error) : done())));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'packages/mistri/src/server/index.ts',
        '--config',
        `${database}.json`,
        // From its directory, where the widgets live, with this manifest in place of the fixture's own.
        '--app',
        authoring,
        '--app-entry',
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
          BETTER_AUTH_SECRET: 'isolated-service-desk-secret-at-least-thirty-two-characters',
          MISTRI_AUTH_ADMIN_EMAIL: '',
          MISTRI_AUTH_ADMIN_PASSWORD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const running = child;
    let log = '';
    running.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    running.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    // A server that dies mid-test leaves the page saying only "not answering": say why, in the test's output.
    running.once('exit', (code, signal) => {
      if (!stopping) console.error(`Desk blocks server exited (${code ?? signal}) before the test stopped it:\n${log}`);
    });
    await new Promise<void>((done, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        running.stdout!.off('data', ready);
        running.off('exit', failed);
        running.off('error', finish);
        if (error) reject(error);
        else done();
      };
      const ready = () => {
        if (log.includes('Listening on ')) finish();
      };
      const failed = () => finish(new Error(`Desk blocks fixture exited: ${log}`));
      const timer = setTimeout(() => finish(new Error(`Desk blocks fixture startup timed out: ${log}`)), 20_000);
      running.stdout!.on('data', ready);
      running.once('exit', failed);
      running.once('error', finish);
      ready();
    });
    const account = { name: 'desk-agent', email: 'desk-agent@example.test', password: 'desk-blocks-agent-password' };
    const response = await fetch(`${origin}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(account),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Desk blocks fixture could not create its account: ${await response.text()}`);
    return { origin, database, account, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
