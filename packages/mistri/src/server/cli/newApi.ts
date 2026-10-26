/** `mistri new --api <name> [<dir>]`: an App that is only an API. A
 * table of tasks in a SQLite file of its own, the resource that reads and
 * writes it, one command that emits an event, and the App API and its MCP
 * tools declared over them — no views, no pages. The command journal and the
 * event store are provisioned beside the data, and one list is home; the README carries the token
 * recipe and a curl walk-through. It passes `mistri check` as written.
 *
 * The schema starts the way it is meant to go on: `db/schema.sql` is the
 * schema the team wants, `db/migrations/V1__task.sql` is how a database gets
 * there, and the database is made by applying it, so its history is there
 * from the first start. `npm run schema:diff` and `schema:check` are the loop
 * (`mistri migrate diff | check`). */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { formatScripts, oxfmtConfigText, oxfmtRange } from '../formatterConfig.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { shownPath } from '../scaffold.js';

const TABLES = `-- The schema this App wants. Change it here, then: npm run schema:diff -- <name>
CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  version INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  notes TEXT,
  due_on TEXT CHECK (due_on IS NULL OR due_on = date(due_on)),
  done INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0, 1))
);
`;

export const slug = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

/* The Node types the tsconfig names (`types: ['node']`): the range mistri itself builds against. */
export function nodeTypesRange(): string {
  try {
    const own = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      devDependencies?: Record<string, string>;
    };
    return own.devDependencies?.['@types/node'] ?? '*';
  } catch {
    return '*';
  }
}

export function typescriptRange(): string {
  try {
    /* The peer range first: it is the TypeScript an App's check needs (7 or later), whatever the checkout's own compiler is. */
    const own = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')) as {
      peerDependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return own.peerDependencies?.typescript ?? own.devDependencies?.typescript ?? '>=7';
  } catch {
    return '>=7';
  }
}

/** Whether a directory sits inside the mistri checkout, where `@mistriwork/mistri/app` resolves to the workspace's package. */
export function insideCheckout(dir: string): boolean {
  for (let at = resolve(dir); ; at = resolve(at, '..')) {
    const manifest = join(at, 'package.json');
    if (existsSync(manifest)) {
      try {
        const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
        return name === 'tablewalk-workspace' || name === 'tablewalk' || name === '@mistriwork/mistri';
      } catch {
        return false;
      }
    }
    if (resolve(at, '..') === at) return false;
  }
}

function apiAppFiles(name: string, id: string, database: string): Record<string, string> {
  const files: Record<string, string> = {};
  files['app.ts'] = `/* ${name}: an App that is only an API. Its one resource, \`task\`, is read and
   written over HTTP and as MCP tools with scoped tokens; nothing here draws a
   page. See README.md for the token and the first request. */
import { defineApp, expose, listView } from '@mistriwork/mistri/app';
import type { App } from './mistri-schema.d.ts';

/* A client edits a task's words and dates; only \`complete\` marks it done,
   so the event a subscriber reads says what happened. */
const client = {
  read: ['task'],
  write: ['task'],
  commands: ['complete'],
  fields: { task: { read: ['id', 'version', 'title', 'notes', 'due_on', 'done'], write: ['title', 'notes', 'due_on'] } },
} as const;

export default defineApp({
  id: '${id}',
  name: ${JSON.stringify(name)},
  sources: { main: { connection: '${id}' } },
  resources: { task: { access: 'write' } },
  // Where a signed-in account lands: the one list, to see what the API holds. No pages.
  views: { tasks: listView('Tasks', 'task', { show: ['title', 'due_on', 'done'] }) },
  home: 'tasks',
  auth: {
    providers: ['email'],
    defaultRole: 'client',
    roles: {
      client: { ...client, label: 'API client' },
      // The account a first start bootstraps (MISTRI_AUTH_ADMIN_EMAIL).
      admin: { ...client, label: 'Admin' },
    },
  },
  api: {
    version: 1,
    roles: ['client', 'admin'],
    description: ${JSON.stringify(`${name}'s tasks.`)},
    resources: {
      // Read, created and edited through the API; each write is a command with a receipt.
      task: expose(['id', 'version', 'title', 'notes', 'due_on', 'done'], {
        filters: ['done', 'due_on'],
        sorts: ['id'],
        create: true,
        update: true,
      }),
    },
    commands: ['complete'],
    // The feed a subscriber polls: GET /api/apps/${id}/v1/$events.
    events: ['task.completed'],
  },
} satisfies App);
`;
  files['commands.ts'] = `/* ${name}'s commands: where a rule lives that a plain edit cannot keep. */
import { defineCommand, defineCommands, defineEvent, defineSource, int, refuse, shape, text } from '@mistriwork/mistri/commands';
import type { Rows } from './mistri-schema.d.ts';

const source = defineSource<Rows>('main');

const done = shape({ id: int(), title: text() });
/* What the feed says when a task is done: its id and title, nothing of who. */
const taskCompleted = defineEvent('task.completed', done);

export const complete = defineCommand({
  source,
  target: 'task',
  input: {},
  output: done,
  events: { completed: taskCompleted },
  async handle({ db, record }) {
    if (Number(record.done)) refuse('This task is already done.');
    await db.task.update(record, { done: 1 });
    return { id: Number(record.id), title: String(record.title) };
  },
});

export default defineCommands({ complete });
`;
  files['tsconfig.json'] = `${JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        /* TypeScript 7 loads no @types package unless one is named: a command's, a job's or a test's `node:` import
           read "Cannot find module 'node:test'" in check's typecheck and `tsc`, about thirty errors after test init. */
        types: ['node'],
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`;
  files['mistri.json'] = `${JSON.stringify(
    { connections: [{ name: id, url: database, writable: true, migrations: { dir: 'db/migrations' } }] },
    null,
    2,
  )}\n`;
  files['db/schema.sql'] = TABLES;
  files['db/migrations/V1__task.sql'] =
    `-- Runs once, in version order. Written with db/schema.sql; the next one comes from npm run schema:diff.\n${TABLES.replace(/^--.*\n/, '')}`;
  files['.oxfmtrc.json'] = oxfmtConfigText;
  files['package.json'] = `${JSON.stringify(
    {
      name: id,
      private: true,
      type: 'module',
      scripts: {
        check: 'mistri check --app . --config mistri.json',
        migrate: 'mistri migrate up --app . --config mistri.json',
        'schema:diff': 'mistri migrate diff --config mistri.json',
        'schema:check': 'mistri migrate check --config mistri.json',
        ...formatScripts,
      },
      // mistri for its bin and the `mistri/*` the modules import; the database browser (`tablewalk`) is not needed.
      dependencies: { '@mistriwork/mistri': `^${runtimeVersion()}` },
      devDependencies: { '@types/node': nodeTypesRange(), oxfmt: oxfmtRange(), typescript: typescriptRange() },
    },
    null,
    2,
  )}\n`;
  // .mistri/ holds the pinned Atlas that schema:diff fetches, and nothing worth committing.
  files['.gitignore'] = '*.db\n*.db-*\n.mistri/\n';
  const base = `http://127.0.0.1:4111/api/apps/${id}/v1`;
  files['README.md'] = [
    `# ${name}`,
    '',
    'An App that is only an API: a `task` resource read and written over loopback HTTP and as MCP',
    'tools, with scoped bearer tokens. Drafted by `mistri new --api`. Its data is the SQLite file',
    `\`${basename(database)}\` beside this README, with the command journal and the event store already in it.`,
    '',
    '```sh',
    "npm install                                   # mistri, TypeScript and Node's types (not inside a mistri checkout)",
    'npx @mistriwork/mistri check --app . --config mistri.json',
    '```',
    '',
    '- `app.ts` — the resource, the roles and the `api` block: what a token may read, create, edit, run and subscribe to.',
    '- `commands.ts` — `complete`, the one command, and the `task.completed` event it emits.',
    '- `db/schema.sql` — the schema the App wants; `db/migrations/` — how a database gets there.',
    '',
    '## Change the schema',
    '',
    'Edit `db/schema.sql`, then write the migration from it, read it, and apply it:',
    '',
    '```sh',
    'npm run schema:diff -- add_priority   # writes db/migrations/V2__add_priority.sql (fetches a pinned Atlas once)',
    'npm run migrate                       # applies it, regenerates the types, checks the App',
    'npm run schema:check                  # the migrations build db/schema.sql; exit 2 if not',
    '```',
    '',
    'A diff cannot tell a rename from a drop and an add: rewrite one as `RENAME` by hand.',
    '',
    '## A token',
    '',
    "Tokens live in the App's own sign-in store. Create the first account by starting once with",
    '`MISTRI_AUTH_ADMIN_EMAIL` and `MISTRI_AUTH_ADMIN_PASSWORD` set (it holds the `admin` role),',
    'stop the server, then provision the token store once and issue a token for that account. Give the',
    'token the fewest operations it needs and a near expiry; `--operation` repeats.',
    '',
    '```sh',
    'STORE=$(node -e "console.log(crypto.randomUUID())")   # keep it: every api-token command names it',
    'npx @mistriwork/mistri check --app . --config mistri.json --write-authority',
    'npx @mistriwork/mistri api-token provision --app . --config mistri.json --store-id $STORE',
    'npx @mistriwork/mistri api-token issue --app . --config mistri.json --store-id $STORE --commands commands.ts \\',
    '  --subject <account-id> --actor <account-id> --role admin --label "First client" \\',
    '  --expires-at 2030-01-01T00:00:00Z --operation list:task --operation item:task \\',
    '  --operation command:create-task --operation command:update-task --operation command:complete \\',
    '  --operation event:task.completed',
    '```',
    '',
    "The secret is printed once. `<account-id>` is the account's id in the sign-in store (`user.id`).",
    '',
    '## Serve it, and call it',
    '',
    '```sh',
    'npx @mistriwork/mistri --app . --config mistri.json --commands commands.ts \\',
    '  --api-reads --api-integers decimal-string --api-requests-per-minute 120',
    '```',
    '',
    '```sh',
    'TOKEN=…   # the secret issue printed',
    `curl -s ${base}/task -H "Authorization: Bearer $TOKEN"`,
    `curl -s -X POST ${base}/task/commands/create-task/v1 -H "Authorization: Bearer $TOKEN" \\`,
    '  -H "Idempotency-Key: create-task-000001" -H "Content-Type: application/json" -d \'{"title":"Call the bank"}\'',
    `curl -si ${base}/task/1/commands/complete/v1/prepare -H "Authorization: Bearer $TOKEN"   # its ETag`,
    `curl -s -X POST ${base}/task/1/commands/complete/v1 -H "Authorization: Bearer $TOKEN" \\`,
    '  -H \'If-Match: "<etag>"\' -H "Idempotency-Key: complete-task-00001" -d \'{}\'',
    `curl -s ${base}/\\$events -H "Authorization: Bearer $TOKEN"                      # task.completed, oldest first`,
    `curl -s ${base}/\\$openapi -H "Authorization: Bearer $TOKEN"                     # what this token may do`,
    '```',
    '',
    'An `Idempotency-Key` is 16 to 128 letters, digits, `-` or `_`, new for each change; sending the',
    'same one again replays the first answer instead of writing twice.',
    '',
    'For a coding agent, the same API as MCP tools: `--app-mcp` in place of `--api-reads`, with the',
    'token in `MISTRI_API_TOKEN`. `npx @mistriwork/mistri docs` lists the reference; the App API page says the rest.',
    '',
  ].join('\n');
  return files;
}

/** Writes the App and its database; refuses a directory that already holds anything. */
export async function runNewApi(args: readonly string[]): Promise<number> {
  const usage = 'Usage: mistri new --api <name> [<dir>]';
  if (args[0] !== '--api' || !args[1] || args[1].startsWith('-') || args.length > 3 || args[2]?.startsWith('-')) {
    console.error(`mistri: ${usage}. An App drafted from an existing database is --scaffold-app.`);
    return 1;
  }
  const name = args[1].trim(),
    id = slug(name);
  if (!id || !/^[a-z]/.test(id)) {
    console.error('mistri: the name needs a letter to start an id from.');
    return 1;
  }
  const dir = resolve(args[2] ?? id);
  if (existsSync(dir) && readdirSync(dir).length) {
    console.error(`mistri: ${shownPath(dir)} is not empty — new refuses to write over anything. Choose a new directory.`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  const database = join(dir, `${id}.db`);
  const files = apiAppFiles(name, id, database);
  /* The checkout's own formatter config governs a project inside it, as its package.json does. */
  if (insideCheckout(dir)) {
    delete files['package.json'];
    delete files['.oxfmtrc.json'];
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  /* The database is the migrations applied, so its history starts at V1 rather than at a baseline. */
  const [{ migrateUp }, { DEFAULT_HISTORY_TABLE }] = await Promise.all([
    import('@mistriwork/engine/server/migrate/runner.js'),
    import('@mistriwork/engine/server/migrate/history.js'),
  ]);
  const made = await migrateUp({ url: database, schemas: [], dir: join(dir, 'db', 'migrations'), table: DEFAULT_HISTORY_TABLE });
  if (made.failure || made.refused) throw new Error(made.failure?.message ?? made.refused);
  const db = new DatabaseSync(database);
  try {
    db.exec(`INSERT INTO task (title, due_on) VALUES ('Write the first client', date('now', '+3 days'))`);
  } finally {
    db.close();
  }
  const [{ migrateSqliteCommandJournal }, { provisionStores }] = await Promise.all([
    import('../../adapters/commands/commandJournal.js'),
    import('../maintenance.js'),
  ]);
  migrateSqliteCommandJournal(database);
  await provisionStores({ sqlite: database }, { app: { id, source: 'main' } });
  console.log(`mistri: wrote ${name} to ${shownPath(dir)} — ${Object.keys(files).sort().join(', ')} and ${basename(database)}.`);
  console.log(`Next: cd ${shownPath(dir)} && npx @mistriwork/mistri check --app . --config mistri.json, then README.md for a token.`);
  return 0;
}
