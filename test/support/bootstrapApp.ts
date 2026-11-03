/**
 * The App the bootstrap plan was reproduced on (docs/bootstrap-plan.md): one command that records an event, one job
 * on that event, two roles, a versioned migration and a fresh SQLite file, its `mistri.json` beside it. Shared by the
 * plan's, check's and the profile's tests, so each reads the same App the field report's setup script was written for.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { installMistri } from './installedMistri.js';

export const ENTRY = resolve('packages/mistri/src/server/index.ts');
const ROOT = resolve('.');

export interface BootstrapApp {
  /** The project folder: the App is `app/` inside it. */
  readonly dir: string;
  readonly app: string;
  /** `app/mistri.json`. */
  readonly config: string;
  readonly jobs: string;
  readonly db: string;
}

export interface BootstrapOptions {
  /** Give a command both an action and an edit grant of the same resource: the `command-and-edit` fault a store refusal hid. */
  readonly fault?: boolean;
  /** The `app` block written into `app/mistri.json`. */
  readonly profile?: Record<string, unknown>;
  /** Leave the jobs module out. */
  readonly noJobs?: boolean;
}

export function bootstrapApp(t: { after(fn: () => void): void }, options: BootstrapOptions = {}): BootstrapApp {
  const dir = mkdtempSync(join(tmpdir(), 'mistri-bootstrap-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // An App's modules import the package, as one beside an installed mistri does.
  installMistri(join(dir, 'node_modules'));
  const app = join(dir, 'app');
  mkdirSync(join(app, 'migrations'), { recursive: true });
  const db = join(app, 'desk.db');
  const config = join(app, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      ...(options.profile ? { app: options.profile } : {}),
      connections: [{ name: 'desk', url: 'desk.db', writable: true, migrations: { dir: 'migrations' } }],
    }),
  );
  writeFileSync(join(app, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(
    join(app, 'migrations', 'V1__item.sql'),
    `CREATE TABLE item (id INTEGER PRIMARY KEY, title TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', version INTEGER NOT NULL DEFAULT 0);\n`,
  );
  writeFileSync(
    join(app, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: {
        item: {
          access: 'write',
          ...(options.fault ? { actions: { close: { label: 'Close', command: 'close' } } } : {}),
        },
      },
      auth: {
        roles: {
          agent: { read: true, ...(options.fault ? { write: true } : {}), commands: ['close'] },
          clock: { read: true, commands: ['archive'] },
        },
      },
      views: { items: { kind: 'list', from: 'item', show: ['title', 'status'] } },
      home: 'items',
      nav: ['items'],
    }),
  );
  writeFileSync(
    join(app, 'events.mjs'),
    `import { defineEvent, int, shape } from '@mistriwork/mistri/commands';
export const closed = defineEvent('item.closed', shape({ id: int() }));
`,
  );
  writeFileSync(
    join(app, 'commands.ts'),
    `import { defineCommand, defineCommands, defineEventProjection, int, shape } from '@mistriwork/mistri/commands';
import { closed } from './events.mjs';
export default defineCommands({
  close: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'], output: shape({ id: int() }),
    events: { closed: defineEventProjection(closed, ({ id }) => ({ id })) },
    async handle({ db, record }) { await db.item.update(record, { status: 'closed' }); return { id: Number(record.id) }; } }),
  archive: defineCommand({ source: 'desk', target: 'item', read: ['item'], write: ['item'],
    async handle({ db, record }) { await db.item.update(record, { status: 'archived' }); } }),
});
`,
  );
  const jobs = join(app, 'jobs.mjs');
  if (!options.noJobs)
    writeFileSync(
      jobs,
      `import { defineJob, defineJobs } from '@mistriwork/mistri/jobs';
import { closed } from './events.mjs';
export default defineJobs({
  archiveClosed: defineJob({ on: { event: closed, command: 'close' }, runAs: 'clock', command: 'archive', schedule: (event) => ({ key: { id: event.id } }) }),
}, { principals: { clock: { roles: ['clock'] } } });
`,
    );
  return { dir, app, config, jobs, db };
}

/** `mistri <args>` from `cwd`, as a person runs it: the checkout's own CLI under tsx. */
export function mistri(args: readonly string[], cwd: string = ROOT, env: NodeJS.ProcessEnv = {}) {
  const run = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, NODE_TEST_CONTEXT: '', TSX_TSCONFIG_PATH: join(ROOT, 'tsconfig.json'), ...env },
  });
  return { code: run.status, stdout: run.stdout, stderr: run.stderr, said: `${run.stdout}\n${run.stderr}` };
}
