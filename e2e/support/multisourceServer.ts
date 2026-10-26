import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

/** Independent data and config; never shares the main E2E or preview databases. */
export async function startMultisourceApp() {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-multisource-browser-'));
  const primary = join(directory, 'operations.db');
  const secondary = join(directory, 'inventory.db');
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
    for (const [file, name] of [
      [primary, 'Operations ticket'],
      [secondary, 'Inventory ticket'],
    ]) {
      const db = new DatabaseSync(file);
      try {
        db.exec('CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL)');
        db.prepare('INSERT INTO ticket VALUES (?, ?, ?)').run(1, name, 'open');
      } finally {
        db.close();
      }
    }
    const config = join(directory, 'connections.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          { name: 'multisource', url: primary, writable: false },
          { name: 'inventory-store', url: secondary, writable: true },
        ],
      }),
    );
    const app = join(directory, 'app.ts');
    writeFileSync(
      app,
      `import { defineApp, navGroup, page } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/schema/app.mjs')).href)};
export default defineApp({
  id: 'multisource',
  name: 'Source workspace',
  sources: { operations: { connection: 'multisource', default: true }, inventory: { connection: 'inventory-store' } },
  resources: { ticket: {}, 'inventory.ticket': { access: 'write' } },
  views: {
    operations: { kind: 'list', label: 'Operations', from: 'ticket', show: ['name', 'status', 'id'], open: 'page' },
    inventory: { kind: 'list', label: 'Inventory', from: 'inventory.ticket', show: ['name', 'status', 'id'], open: 'page' },
  },
  pages: {
    'operations-ticket': page('ticket', [{ kind: 'fields', show: ['name', 'status'], columns: 2 }]),
    'inventory-ticket': page('inventory.ticket', [{ kind: 'fields', show: ['name', 'status'], columns: 2 }]),
  },
  home: 'operations',
  nav: [navGroup('records', 'Records', ['operations', 'inventory'])],
  ui: { shell: { placement: 'top' }, theme: { preset: 'lumen' } },
});
`,
    );
    const reservation = createServer();
    await new Promise<void>((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
      {
        env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const processChild = child;
    let log = '';
    processChild.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    processChild.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Multisource startup timed out: ${log}`)), 15_000);
      const ready = () => {
        if (log.includes('Listening on ')) done();
      };
      const failed = () => done(new Error(`Multisource app exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        processChild.stdout!.off('data', ready);
        processChild.off('exit', failed);
        processChild.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      processChild.stdout!.on('data', ready);
      processChild.once('exit', failed);
      processChild.once('error', done);
      ready();
    });
    return { origin, primary, secondary, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}
