/** `mistri new [<name>] [<dir>]`: a starter App to serve at once with `mistri dev`. A task list in one `app.ts` (Tick's
 * shape: a checklist with tabs, a New form, two actions and a record page), its types kept inline, over a SQLite
 * file of its own made from `db/migrations/V1__task.sql` and given a few rows, with a `mistri.json` beside it that
 * `mistri dev` reads. It passes `mistri check` as written.
 *
 * The other way to begin is from a database that already exists (`mistri --scaffold-app`), and an App that is only
 * an API is `mistri new --api`. */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { formatScripts, oxfmtConfigText, oxfmtRange } from '../formatterConfig.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { shownPath } from '../scaffold.js';
import { insideCheckout, nodeTypesRange, slug, typescriptRange } from './newApi.js';

const TABLES = `-- The schema this App wants. Change it here, then write the migration that gets a database there.
CREATE TABLE task (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  completed BOOLEAN NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
  due_on DATE,
  position REAL
);
`;

/** The rows a first look finds: one due today, one overdue, one upcoming, one with no date, one done. */
const ROWS = `INSERT INTO task (name, completed, due_on, position) VALUES
  ('Plan the week', 0, date('now'), 1024),
  ('Return the library book', 0, date('now', '-2 days'), 2048),
  ('Water the plants', 0, NULL, 3072),
  ('Book the dentist', 0, date('now', '+5 days'), 4096),
  ('Clear the desk', 1, NULL, 5120);`;

function starterFiles(name: string, id: string, database: string): Record<string, string> {
  const files: Record<string, string> = {};
  files['app.ts'] = `/**
 * ${name} — a task list, authored with the typed DSL. \`mistri dev\` serves it and reloads it on every save;
 * README.md says where to go next.
 */
import { action, checklist, computed, defineApp, fields, listView, page } from '@mistriwork/mistri/app';
import type { TypedAppConfig } from '@mistriwork/mistri/app';

// The shapes \`mistri --export types\` writes, kept inline: each table's columns (and its computed one,
// \`is_overdue\`), its references (a task references nothing), and the one connection this App binds.
type Tables = { task: 'id' | 'name' | 'completed' | 'due_on' | 'position' | 'is_overdue' };
type References = {};
type App = TypedAppConfig<Tables, References, '${id}'>;

export default defineApp({
  id: '${id}',
  name: ${JSON.stringify(name)},
  connection: '${id}',
  resources: {
    task: {
      segments: {
        open: 'completed = false',
        due_today: { query: 'completed = false and due_on = today', label: 'Today' },
        overdue: 'is_overdue = true',
        upcoming: 'completed = false and due_on > today',
        done: 'completed = true',
      },
      access: 'write',
      delete: true,
      // Worked out in the statement, never stored: an open task whose day has passed.
      computed: { is_overdue: computed.boolean('due_on < today and not completed') },
      form: {
        defaults: { completed: false },
        groups: [
          { label: 'What', fields: ['name', 'completed'] },
          { label: 'When', fields: ['due_on'] },
        ],
        when: { due_on: 'completed = false' },
      },
      actions: {
        complete: action('Complete', { set: { completed: true }, when: 'completed = false' }),
        reopen: action('Reopen', { set: { completed: false }, when: 'completed = true' }),
      },
    },
  },
  views: {
    tasks: listView('Tasks', 'task', {
      open: 'modal',
      show: ['name', 'completed', 'due_on'],
      presentation: checklist('name', 'completed', { lines: ['due_on'] }),
      // Your order: drag a task into place, or press Alt+↑/↓.
      order: 'position',
      quickAdd: true,
      filterBar: 'none',
      tabs: [
        'open',
        'due_today',
        { segment: 'overdue', sort: 'due_on' },
        { segment: 'upcoming', sort: 'due_on' },
        { segment: 'done', sort: 'id' },
      ],
    }),
  },
  pages: {
    task: page('task', [fields(['name', 'completed', 'due_on'], { columns: 1 })], { layout: 'article' }),
  },
  home: 'tasks',
  ui: {
    logo: 'list-checks',
    shell: {
      placement: 'top',
      headerWidth: 'content',
      search: false,
      breadcrumbs: false,
      heading: false,
      width: 'narrow',
      gutter: 'comfortable',
    },
    editing: { save: 'blur' },
  },
} satisfies App);
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
        types: ['node'],
      },
      include: ['**/*.ts'],
    },
    null,
    2,
  )}\n`;
  /* A path in a file is from that file's folder, so the project moves as one. */
  files['mistri.json'] = `${JSON.stringify(
    { connections: [{ name: id, url: basename(database), writable: true, migrations: { dir: 'db/migrations' } }] },
    null,
    2,
  )}\n`;
  files['db/schema.sql'] = TABLES;
  files['db/migrations/V1__task.sql'] = `-- Runs once, in version order.\n${TABLES.replace(/^--.*\n/, '')}`;
  files['.oxfmtrc.json'] = oxfmtConfigText;
  files['package.json'] = `${JSON.stringify(
    {
      name: id,
      private: true,
      type: 'module',
      scripts: {
        dev: 'mistri dev .',
        check: 'mistri check --app . --config mistri.json',
        start: 'mistri --app . --config mistri.json',
        migrate: 'mistri migrate up --app . --config mistri.json',
        ...formatScripts,
      },
      // mistri for its bin and the `mistri/*` the modules import; the database browser (`tablewalk`) is not needed.
      dependencies: { '@mistriwork/mistri': `^${runtimeVersion()}` },
      devDependencies: { '@types/node': nodeTypesRange(), oxfmt: oxfmtRange(), typescript: typescriptRange() },
    },
    null,
    2,
  )}\n`;
  files['.gitignore'] = '*.db\n*.db-*\n.mistri/\nnode_modules/\n';
  files['README.md'] = [
    `# ${name}`,
    '',
    `A task list, drafted by \`mistri new\`. Its data is the SQLite file \`${basename(database)}\` beside this README,`,
    'made from `db/migrations/` and given a few rows.',
    '',
    '```sh',
    'npm install       # mistri, TypeScript and Node’s types',
    'npm run dev       # serve it with a sign-in per role; a save reloads it',
    'npm run check     # types, typecheck and validation, the one command of the loop',
    '```',
    '',
    'To feel a remote database while you build, serve with `npx @mistriwork/mistri dev . --db-latency 20`: each round trip then waits',
    '20 ms, a typical cloud distance, and the cost of every request shows in the dev log.',
    '',
    '- `app.ts` — the whole App: the `task` resource, its tabs, form and actions, the list and the record page.',
    '- `db/schema.sql` — the schema the App wants; `db/migrations/` — how a database gets there.',
    '- `mistri.json` — the connection the App binds, by its name.',
    '',
    'Add a column: write `db/migrations/V2__<what>.sql`, run `npm run migrate`, then name the column in `app.ts`.',
    '`npx @mistriwork/mistri docs` lists the reference, `npx @mistriwork/mistri docs examples` the sample Apps.',
    '',
  ].join('\n');
  return files;
}

/**
 * `mistri new --brief <BRIEF.md> [<dir>]`: the App a brief describes, drafted by the same machinery as `--scaffold-app`.
 * The brief's entities become `db/schema.sql` and the first migration, a SQLite database is made from that and seeded,
 * and the draft is scaffolded over it with the brief's look, roles and commands stubs. The brief is kept beside the
 * App as BRIEF.md: it is what the person approved.
 */
async function runNewFromBrief(file: string, rest: readonly string[]): Promise<number> {
  const { BriefRefusal, commandsModule, parseBrief, schemaSql } = await import('./brief.js');
  let text: string;
  try {
    text = readFileSync(resolve(file), 'utf8');
  } catch {
    console.error(`mistri: cannot read the brief ${file}.`);
    return 1;
  }
  let brief;
  try {
    brief = parseBrief(text);
  } catch (error) {
    if (!(error instanceof BriefRefusal)) throw error;
    console.error(`mistri: ${shownPath(resolve(file))}: ${error.message}`);
    return 1;
  }
  const id = slug(brief.name);
  if (!id || !/^[a-z]/.test(id)) {
    console.error('mistri: the App needs a name with a letter to start an id from.');
    return 1;
  }
  const dir = resolve(rest[0] ?? id);
  if (existsSync(dir) && readdirSync(dir).length) {
    console.error(`mistri: ${shownPath(dir)} is not empty — new refuses to write over anything. Choose a new directory.`);
    return 1;
  }
  mkdirSync(join(dir, 'db', 'migrations'), { recursive: true });
  const database = join(dir, `${id}.db`);
  /* The connection is named as a command's source is: an identifier, so no hyphen from the App's id. */
  const connection = id.replace(/-/g, '_');
  const sql = schemaSql(brief);
  writeFileSync(join(dir, 'db', 'schema.sql'), sql);
  writeFileSync(join(dir, 'db', 'migrations', 'V1__create.sql'), `-- Runs once, in version order.\n${sql.replace(/^--.*\n/, '')}`);
  const [{ migrateUp }, { DEFAULT_HISTORY_TABLE }, { connect }, { writeScaffold }] = await Promise.all([
    import('@mistriwork/engine/server/migrate/runner.js'),
    import('@mistriwork/engine/server/migrate/history.js'),
    import('@mistriwork/engine/adapters/connect.js'),
    import('../scaffold.js'),
  ]);
  const made = await migrateUp({ url: database, schemas: [], dir: join(dir, 'db', 'migrations'), table: DEFAULT_HISTORY_TABLE });
  if (made.failure || made.refused) {
    console.error(`mistri: the brief's schema does not apply: ${made.failure?.message ?? made.refused}`);
    return 1;
  }
  const adapter = connect(database);
  const schema = await adapter.introspect();
  await (adapter as { close?: () => Promise<void> | void }).close?.();
  let drafted;
  try {
    drafted = await writeScaffold(schema, dir, {
      name: brief.name,
      connection,
      database: { sqlite: database },
      writable: true,
      brief: {
        theme: brief.theme,
        ...(brief.logo ? { logo: brief.logo } : {}),
        roles: brief.roles,
        commands: brief.commands.map(({ id: command, on, label, set }) => ({ id: command, table: on, label, set })),
      },
    });
  } catch (error) {
    console.error(`mistri: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  /* A path in a file is from that file's folder, so the project moves as one; the connection may write and says where its migrations are. */
  writeFileSync(
    join(dir, 'mistri.json'),
    `${JSON.stringify({ connections: [{ name: connection, url: basename(database), writable: true, migrations: { dir: 'db/migrations' } }] }, null, 2)}\n`,
  );
  if (brief.commands.length) writeFileSync(join(dir, 'commands.ts'), commandsModule(brief, connection));
  writeFileSync(join(dir, 'BRIEF.md'), text);
  for (const problem of drafted.problems) console.error(`mistri: scaffold problem (a bug, not your brief): ${problem}`);
  console.log(
    `mistri: wrote ${brief.name} from the brief to ${shownPath(dir)}: ${brief.entities.length} entit${brief.entities.length === 1 ? 'y' : 'ies'}, ` +
      `${drafted.navCount} view${drafted.navCount === 1 ? '' : 's'}, ${brief.roles.length} role${brief.roles.length === 1 ? '' : 's'}, ` +
      `${brief.commands.length} command${brief.commands.length === 1 ? '' : 's'}.`,
  );
  console.log(
    `Next: cd ${shownPath(dir)} && npm install${brief.commands.length ? ' && npx @mistriwork/mistri migrate stores up --app .' : ''} && npx @mistriwork/mistri seed --app . && npx @mistriwork/mistri check --app . && npm run dev`,
  );
  return drafted.problems.length ? 1 : 0;
}

/** Writes the starter and its database; refuses a directory that already holds anything. */
export async function runNewApp(args: readonly string[]): Promise<number> {
  const usage = 'Usage: mistri new [<name>] [<dir>]';
  if (args[0] === '--template') {
    if (args[1] !== 'intake' || args.length > 4 || args.slice(2).some((arg) => arg.startsWith('-'))) {
      console.error('mistri: Usage: mistri new --template intake [<name>] [<dir>]. The one template is intake: a public multi-step form.');
      return 1;
    }
    return (await import('./newIntake.js')).runNewIntake(args.slice(2));
  }
  if (args[0] === '--brief') {
    if (!args[1] || args[1].startsWith('-') || args.length > 3 || args[2]?.startsWith('-')) {
      console.error('mistri: Usage: mistri new --brief <BRIEF.md> [<dir>].');
      return 1;
    }
    return runNewFromBrief(args[1], args.slice(2));
  }
  if (args.length > 2 || args.some((arg) => arg.startsWith('-'))) {
    console.error(
      `mistri: ${usage}. An App that is only an API is mistri new --api <name>; a public multi-step intake, mistri new --template intake; one from a database you have, mistri --scaffold-app; one from an approved brief, mistri new --brief <BRIEF.md>.`,
    );
    return 1;
  }
  const name = (args[0] ?? 'Tasks').trim(),
    id = slug(name);
  if (!id || !/^[a-z]/.test(id)) {
    console.error('mistri: the name needs a letter to start an id from.');
    return 1;
  }
  const dir = resolve(args[1] ?? id);
  if (existsSync(dir) && readdirSync(dir).length) {
    console.error(`mistri: ${shownPath(dir)} is not empty — new refuses to write over anything. Choose a new directory.`);
    return 1;
  }
  mkdirSync(dir, { recursive: true });
  const database = join(dir, `${id}.db`);
  const files = starterFiles(name, id, database);
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
    db.exec(ROWS);
  } finally {
    db.close();
  }
  console.log(`mistri: wrote ${name} to ${shownPath(dir)} — ${Object.keys(files).sort().join(', ')} and ${basename(database)}.`);
  console.log(`Next: cd ${shownPath(dir)} && npm install && npm run dev`);
  return 0;
}
