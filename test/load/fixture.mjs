import { spawn, execFileSync } from 'node:child_process';
import { statfsSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir, platform, release, arch, cpus, totalmem, freemem, loadavg } from 'node:os';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { serverLaunch } from './launch.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const MIN_FREE_BYTES = 1024 ** 3;

export function assertDiskSpace(directory = tmpdir()) {
  const stat = statfsSync(directory);
  const freeBytes = stat.bavail * stat.bsize;
  if (freeBytes < MIN_FREE_BYTES) throw new Error(`Need at least 1 GiB available in ${directory}; found ${freeBytes} bytes`);
  return freeBytes;
}

export function machineInfo() {
  const cpu = cpus();
  return {
    node: process.version,
    os: platform(),
    release: release(),
    arch: arch(),
    cpu: cpu[0]?.model,
    logicalCpus: cpu.length,
    memoryBytes: totalmem(),
    freeMemoryBytes: freemem(),
    loadAverage: loadavg(),
  };
}

export function gitInfo() {
  try {
    const git = (args) =>
      execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    return { head: git(['rev-parse', 'HEAD']), dirty: git(['status', '--porcelain']).length > 0 };
  } catch {
    return { head: null, dirty: null };
  }
}

export function createRunDirectory() {
  const freeBytesBefore = assertDiskSpace();
  return { directory: mkdtempSync(join(tmpdir(), 'tablewalk-load-')), freeBytesBefore };
}

export async function seedFixture(directory, rows) {
  if (!Number.isInteger(rows) || rows < 24 || rows > 10000) throw new Error('Invalid fixture row count');
  const { seed } = await import('../../test/fixtures/databases/thread/seed.mjs');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(directory, 'thread.db');
  seed(file);
  const marker = `Owned load fixture ${randomUUID()}`;
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA foreign_keys=ON; BEGIN');
    db.prepare('UPDATE issue SET description=? WHERE id=1').run(marker);
    const insert = db.prepare(
      'INSERT INTO issue(id,name,description,status,priority,assignee_id,project_id,cycle_id,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
    );
    for (let id = 25; id <= rows; id++)
      insert.run(
        id,
        `Synthetic issue ${id}`,
        `Local load fixture issue ${id}.`,
        ['backlog', 'ready', 'in_progress', 'in_review', 'done', 'canceled'][id % 6],
        ['urgent', 'high', 'normal', 'low'][id % 4],
        (id % 5) + 1,
        (id % 3) + 1,
        (id % 3) + 1,
        '2026-09-01 09:00:00',
      );
    db.exec('COMMIT');
    const issues = db
      .prepare('SELECT id,name,status,priority FROM issue ORDER BY id')
      .all()
      .map((row) => ({ ...row }));
    return { file, marker, issues, title: issues[0].name, backlogTitle: issues.find((issue) => issue.status === 'backlog').name };
  } finally {
    db.close();
  }
}

async function freePort() {
  const reservation = createServer();
  try {
    await new Promise((resolve, reject) => {
      reservation.once('error', reject);
      reservation.listen(0, '127.0.0.1', resolve);
    });
    return reservation.address().port;
  } finally {
    if (reservation.listening) await new Promise((resolve, reject) => reservation.close((error) => (error ? reject(error) : resolve())));
  }
}

export async function startOwnedServer(directory, fixture, signal, production = false) {
  signal.throwIfAborted();
  const launch = serverLaunch(production);
  const port = await freePort();
  signal.throwIfAborted();
  // An allowlist prevents inherited DB/auth/Node/proxy settings from selecting
  // a real resource or preloading arbitrary code into the owned child.
  const env = Object.fromEntries(
    ['PATH', 'SystemRoot', 'WINDIR', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'TEMP', 'TMP']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  for (const [key, folder] of [
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_DATA_HOME', 'data'],
    ['XDG_CACHE_HOME', 'cache'],
    ['XDG_STATE_HOME', 'state'],
  ]) {
    env[key] = join(directory, folder);
    mkdirSync(env[key], { recursive: true });
  }
  env.MISTRI_OPEN = '0';
  env.MISTRI_CLOCK = '2026-09-08T12:00:00Z';
  const args = [
    ...launch.entry,
    '--config',
    fixture.configFile ?? `${fixture.file}.json`,
    '--app',
    join(ROOT, 'test/fixtures/apps/thread'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
  ];
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '',
    spawnError,
    closed = false;
  const capture = (chunk) => {
    log = (log + String(chunk)).slice(-64 * 1024);
  };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  child.on('error', (error) => {
    spawnError = error;
  });
  const closePromise = new Promise((resolve) =>
    child.once('close', () => {
      closed = true;
      resolve();
    }),
  );
  let stopping;
  const stop = () =>
    (stopping ??= (async () => {
      if (closed) return;
      child.kill('SIGTERM');
      const force = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, 3000);
      try {
        await closePromise;
      } finally {
        clearTimeout(force);
      }
    })());
  const server = {
    origin: `http://127.0.0.1:${port}`,
    pid: child.pid,
    args,
    mode: launch.mode,
    logs: () => log,
    alive: () => !closed && child.exitCode === null && child.signalCode === null,
    stop,
  };
  try {
    const deadline = performance.now() + 30000;
    while (!log.includes(`Listening on http://localhost:${port}`)) {
      signal.throwIfAborted();
      if (spawnError) throw spawnError;
      if (!server.alive()) throw new Error(`Owned server exited during startup: ${log}`);
      if (performance.now() >= deadline) throw new Error(`Owned server startup timed out: ${log}`);
      await delay(50, undefined, { signal });
    }
    return server;
  } catch (error) {
    await stop();
    throw error;
  }
}
