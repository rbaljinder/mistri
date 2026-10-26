import { spawn } from './spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { TypedAppConfig } from '@mistriwork/mistri/app';
import { rows } from './db.js';

export interface AutosaveRow {
  id: number;
  name: string;
  details: string;
  assignee_id: number;
  backup_id: number | null;
}

/** Each test owns its CLI, store and settings. No shared fixture builder or sample seed. */
export async function startAutosaveApp(save: 'blur' | 'explicit' = 'blur') {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-autosave-browser-'));
  const db = join(directory, 'records.db');
  let child: ReturnType<typeof spawn> | undefined;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
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
    const source = new DatabaseSync(db);
    try {
      source.exec(`
        PRAGMA foreign_keys = ON;
        CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO person VALUES (1, 'Ada North'), (2, 'Bea South'), (3, 'Cy West');
        CREATE TABLE task (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL,
          details TEXT NOT NULL CHECK (instr(details, 'reject:') = 0),
          assignee_id INTEGER NOT NULL REFERENCES person(id),
          backup_id INTEGER REFERENCES person(id)
        );
        INSERT INTO task VALUES (1, 'Review the draft', 'Original details', 1, 3),
          (2, 'Leave this task alone', 'Untouched details', 2, NULL);
        CREATE TABLE note (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO note VALUES (1, 'Generic record'), (2, 'Untouched note');
        CREATE TABLE applied_update (table_name TEXT NOT NULL, record_id INTEGER NOT NULL);
        CREATE TRIGGER task_updated AFTER UPDATE ON task BEGIN
          INSERT INTO applied_update VALUES ('task', NEW.id);
        END;
        CREATE TRIGGER note_updated AFTER UPDATE ON note BEGIN
          INSERT INTO applied_update VALUES ('note', NEW.id);
        END;
      `);
    } finally {
      source.close();
    }
    const config = join(directory, 'connections.json');
    writeFileSync(config, JSON.stringify({ connections: [{ name: 'autosave', url: db, writable: true }] }));
    // Keep SQLite/WAL/settings outside the watched manifest directory.
    const appDirectory = join(directory, 'app');
    mkdirSync(appDirectory);
    const app: TypedAppConfig<{
      task: keyof AutosaveRow;
      note: 'id' | 'name';
      person: 'id' | 'name';
    }> = {
      id: 'autosave',
      name: 'Autosave proof',
      connection: 'autosave',
      // People stay unwritten: declaring any access leaves the rest read-only.
      resources: { task: { access: 'write' }, note: { access: 'write' }, person: {} },
      views: {
        tasks: { kind: 'list', from: 'task', label: 'Tasks', open: 'modal', show: ['name', 'details', 'assignee_id', 'backup_id'] },
        notes: { kind: 'list', from: 'note', label: 'Notes', show: ['name'] },
        people: { kind: 'list', from: 'person', label: 'People', show: ['name'] },
      },
      pages: {
        task: {
          base: 'task',
          sections: [{ kind: 'fields', title: 'Task fields', show: ['name', 'details', 'assignee_id', 'backup_id'], columns: 1 }],
        },
      },
      home: 'tasks',
      nav: ['tasks', 'notes', 'people'],
      ui: { shell: { placement: 'top' }, editing: { save } },
    };
    writeFileSync(join(appDirectory, 'app.json'), JSON.stringify(app));
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
      ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port)],
      {
        cwd: resolve('.'),
        env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const server = child;
    let log = '';
    const recordLog = (chunk: Buffer) => {
      log = (log + String(chunk)).slice(-16_000);
    };
    server.stdout!.on('data', recordLog);
    server.stderr!.on('data', recordLog);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error(`Autosave fixture startup timed out: ${log}`)), 15_000);
      const ready = () => {
        if (log.includes('Listening on ')) done();
      };
      const failed = () => done(new Error(`Autosave fixture exited during startup: ${log}`));
      const done = (error?: Error) => {
        clearTimeout(timer);
        server.stdout!.off('data', ready);
        server.off('exit', failed);
        server.off('error', done);
        if (error) reject(error);
        else resolve();
      };
      server.stdout!.on('data', ready);
      server.once('exit', failed);
      server.once('error', done);
      ready();
    });
    return {
      origin,
      db,
      directory,
      pid: server.pid,
      stop,
      task: () => rows<AutosaveRow>(db, 'SELECT * FROM task WHERE id=1')[0],
      snapshot: () => ({
        tasks: rows<AutosaveRow>(db, 'SELECT * FROM task ORDER BY id'),
        notes: rows(db, 'SELECT * FROM note ORDER BY id'),
        people: rows(db, 'SELECT * FROM person ORDER BY id'),
        applied: rows(db, 'SELECT * FROM applied_update ORDER BY rowid'),
      }),
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

export type AutosaveApp = Awaited<ReturnType<typeof startAutosaveApp>>;
