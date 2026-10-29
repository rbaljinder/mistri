/** Disposable filesystem and SQLite fixtures with reverse-order cleanup. */
import { mkdtemp, mkdir, writeFile, rm, cp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, relative, isAbsolute, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { sqliteTargetFrom } from '@mistriwork/engine/server/configPaths.js';

/** Every test owns its directory. Register close with your runner immediately. */
export async function createTestWorkspace() {
  const directory = await mkdtemp(join(tmpdir(), 'tablewalk-test-'));
  // Authored TypeScript Apps use ESM, including when copied outside their repository.
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  const cleanups: Array<() => unknown | Promise<unknown>> = [];
  let closed = false;
  function path(name: string) {
    if (closed) throw new Error('Test workspace is closed.');
    const target = resolve(directory, name),
      rel = relative(directory, target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Test paths must stay inside the workspace.');
    return target;
  }
  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const cleanup of cleanups.reverse())
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    try {
      await rm(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(error);
    }
    if (errors.length) throw new AggregateError(errors, 'Test workspace cleanup failed.');
  }
  async function write(name: string, content: string | object) {
    const target = path(name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
    return target;
  }
  return {
    directory,
    path,
    close,
    [Symbol.asyncDispose]: close,
    own(cleanup: () => unknown | Promise<unknown>) {
      if (closed) throw new Error('Test workspace is closed.');
      cleanups.push(cleanup);
    },
    write,
    async copy(source: string, name: string) {
      const target = path(name);
      await cp(source, target, { recursive: true });
      return target;
    },
    /**
     * A copy of a mistri.json for one test: each SQLite file it names is copied into the workspace (its -wal
     * beside it), so the test's writes never reach the original, and its relative paths are made the original
     * folder's, as the server reads them. A PostgreSQL URL is kept as written: that database is shared.
     */
    async copyConfig(source: string, name = 'mistri.json') {
      const from = resolve(source);
      const config = JSON.parse(await readFile(from, 'utf8')) as {
        connections?: Array<Record<string, unknown> & { url?: unknown; migrations?: { dir?: unknown } }>;
      };
      const folder = dirname(from);
      const connections = [];
      for (const [index, connection] of (config.connections ?? []).entries()) {
        const url = connection.url;
        let copied = connection;
        /* The path as the server reads it (loadConfig): `./shop.db`, `sqlite:shop.db` and `file:./shop.db` alike. */
        const located = typeof url === 'string' && !connection.kind ? sqliteTargetFrom(url, folder) : undefined;
        if (located && located !== ':memory:' && !located.includes('$') && !located.includes('://')) {
          const file = located.replace(/^sqlite:(\/\/)?/i, '');
          const target = path(`databases/${index}-${basename(file)}`);
          await mkdir(dirname(target), { recursive: true });
          await cp(file, target);
          for (const suffix of ['-wal', '-shm'])
            if (
              await stat(file + suffix).then(
                () => true,
                () => false,
              )
            )
              await cp(file + suffix, target + suffix);
          copied = { ...connection, url: target };
        }
        const migrations = copied.migrations;
        if (migrations && typeof migrations.dir === 'string')
          copied = { ...copied, migrations: { ...migrations, dir: resolve(folder, migrations.dir) } };
        connections.push(copied);
      }
      return write(name, { ...config, connections });
    },
    async database(name: string, setup: (database: DatabaseSync) => void) {
      const target = path(name);
      await mkdir(dirname(target), { recursive: true });
      const database = new DatabaseSync(target);
      try {
        setup(database);
      } finally {
        database.close();
      }
      return target;
    },
  };
}
export type TestWorkspace = Awaited<ReturnType<typeof createTestWorkspace>>;
