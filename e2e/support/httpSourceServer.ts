/**
 * An App over an HTTP connection, with its own directory, ports and config;
 * never the shared E2E config.
 *
 * `startParcel` is the Parcel sample as its README runs it:
 * test/fixtures/apps/parcel/source/api.mjs behind a bearer token, and the
 * sample App over it through the committed description.
 */
import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const PARCEL_TOKEN = 'e2e-parcel-token-71d';

type Child = ReturnType<typeof spawn>;

async function reservePort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function stopChild(child: Child | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

/* A process, started and waited on until its log says `ready`. */
async function started(what: string, args: string[], env: NodeJS.ProcessEnv, ready: string): Promise<Child> {
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`${what} startup timed out: ${log}`)), 15_000);
      const check = () => {
        if (log.includes(ready)) done();
      };
      const failed = () => done(new Error(`${what} exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        child.stdout!.off('data', check);
        child.off('exit', failed);
        child.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      child.stdout!.on('data', check);
      child.once('exit', failed);
      child.once('error', done);
      check();
    });
  } catch (error) {
    await stopChild(child);
    throw error;
  }
  return child;
}

/* mistri, serving the sample App over its HTTP source. */
const mistri = (config: string, port: number, extra: string[] = []) => [
  '--import',
  'tsx',
  'packages/mistri/src/server/index.ts',
  '--config',
  config,
  ...extra,
  '--port',
  String(port),
];

export async function startParcel() {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-parcel-browser-'));
  let api: Child | undefined;
  let server: Child | undefined;
  const stop = async () => {
    await stopChild(server);
    await stopChild(api);
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const env = { ...process.env, PARCEL_API_TOKEN: PARCEL_TOKEN, XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' };
    const apiPort = await reservePort();
    api = await started('Parcel API', ['test/fixtures/apps/parcel/source/api.mjs', '--port', String(apiPort)], env, 'listening on');
    // The sample's connection, pointed at this run's port; the description is the committed one.
    const sample = JSON.parse(readFileSync('test/fixtures/apps/parcel/source/server.example.json', 'utf8'));
    sample.connections[0].url = `http://127.0.0.1:${apiPort}/v1/`;
    sample.connections[0].description = resolve('test/fixtures/apps/parcel/source/parcel.http.json');
    const config = join(directory, 'parcel.json');
    writeFileSync(config, JSON.stringify(sample));
    const port = await reservePort();
    server = await started('Parcel server', mistri(config, port, ['--app', 'test/fixtures/apps/parcel']), env, 'Listening on ');
    return { origin: `http://127.0.0.1:${port}`, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
