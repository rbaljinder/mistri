/** `mistri new --template intake [<name>] [<dir>]`: a starter App that is a public multi-step intake, built from the
 * stock blocks alone — no custom page, no component, no CSS. A visitor answers one question at a time under a
 * progress bar (icon cards, a Yes and a No, two names in a row, a consent), reviews the answers and sends them; staff
 * sign in to a list of what arrived. The one command is public, writes one row and answers a random reference, never
 * what was typed. It passes `mistri check` as written, and its README says how to walk it.
 *
 * The same machinery as `mistri new` (newApp.ts): a SQLite file of its own made from `db/migrations/V1__inquiry.sql`,
 * and a `mistri.json` that `mistri dev` reads; the command journal a command needs is provisioned beside the data. */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { basename, dirname, join, resolve } from 'node:path';
import { formatScripts, oxfmtConfigText, oxfmtRange } from '../formatterConfig.js';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { shownPath } from '../scaffold.js';
import { insideCheckout, nodeTypesRange, slug, typescriptRange } from './newApi.js';

const TABLES = `-- The schema this App wants. Change it here, then write the migration that gets a database there.
CREATE TABLE inquiry (
  id INTEGER PRIMARY KEY,
  reference TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT,
  topic TEXT NOT NULL CHECK (topic IN ('sales', 'support', 'billing', 'other')),
  urgent INTEGER NOT NULL CHECK (urgent IN (0, 1)),
  message TEXT NOT NULL,
  received_at TEXT NOT NULL
);
`;

function intakeFiles(name: string, id: string, database: string): Record<string, string> {
  const files: Record<string, string> = {};
  files['app.ts'] = `/**
 * ${name} — a public multi-step intake, authored with the typed DSL and nothing else: the stock form, no page of its
 * own and no CSS. A visitor answers one question at a time at /form/apply; staff sign in to read what arrived.
 * \`mistri dev\` serves it and reloads it on every save; README.md says where to go next.
 */
import { commandForm, defineApp, listView, step } from '@mistriwork/mistri/app';

export default defineApp({
  id: '${id}',
  name: ${JSON.stringify(name)},
  sources: { main: { connection: '${id}' } },
  /* The ceiling the command writes under, not a grant: no role holds generic write. */
  resources: { inquiry: { access: 'write', recordLabel: 'reference' } },
  auth: {
    providers: ['email'],
    defaultRole: 'staff',
    /* \`admin\` is the role the first account (MISTRI_AUTH_ADMIN_EMAIL) holds: it reads what arrived as staff do. */
    roles: {
      staff: { label: 'Staff', read: true, write: false },
      admin: { label: 'Administrator', read: true, write: false },
    },
  },
  views: {
    inquiries: listView('Inquiries', 'inquiry', {
      icon: 'tray',
      show: ['reference', 'first_name', 'last_name', 'topic', 'urgent', 'received_at'],
      sort: 'received_at desc',
    }),
    /* Public: anyone can open it, signed out, and it runs a public command. The style, the steps' titles and the
       review before sending are all the stock form's. */
    apply: commandForm(
      'Contact us',
      'submitInquiry',
      [
        step('Email', ['email', 'confirm_email'], { title: 'Let’s start with your email.', lead: 'We write only about this inquiry.' }),
        step('You', [['first_name', 'last_name'], 'phone'], { title: 'What’s your name?', lead: 'So we know who we are writing to.' }),
        step('Inquiry', ['topic', 'urgent', 'message'], { title: 'What can we help with?', next: 'Review' }),
        step('Consent', ['consent'], { title: 'One last step' }),
      ],
      {
        public: true,
        style: 'intake',
        note: { icon: 'shield-check', text: 'Your answers go to our team and no one else' },
        submitLabel: 'Send',
        done: { title: 'Thank you', description: 'Keep this reference; we quote it when we write back.' },
      },
    ),
  },
  home: 'inquiries',
  nav: ['inquiries'],
});
`;
  files['commands.ts'] =
    `/* ${name}'s one command, run by the public form. It reads nothing, writes one inquiry and answers a random reference:
   a public submission is unverified input from anyone, so what comes back never depends on the database or repeats
   what was typed. */
import { defineCommand, defineCommands, defineSource, field, literal, publicReference, publicReferencePattern, shape, text } from '@mistriwork/mistri/commands';

const source = defineSource('main');

const TOPICS = [
  { value: 'sales', label: 'Buying', icon: 'shopping-bag' },
  { value: 'support', label: 'Support', icon: 'headset' },
  { value: 'billing', label: 'Billing', icon: 'receipt' },
  { value: 'other', label: 'Something else', icon: 'chat-circle' },
] as const;

export const submitInquiry = defineCommand({
  source,
  target: 'inquiry',
  public: true,
  read: [],
  write: ['inquiry'],
  input: {
    email: field.email({ case: 'lower' }),
    confirm_email: field.email({ case: 'lower', label: 'Confirm email address' }),
    first_name: field.text({ max: 60 }),
    last_name: field.text({ max: 60 }),
    phone: field.phone({ optional: true }),
    topic: field.choice(TOPICS, { label: 'What is it about?', as: 'cards' }),
    urgent: field.bool({ label: 'Is it urgent?', as: 'buttons' }),
    message: field.textarea({ label: 'Tell us more', max: 2000 }),
    consent: field.bool({ label: 'I agree to be contacted about this inquiry', accept: true }),
  },
  /* Said at the step that asks the last of the fields it names, and checked again here for every other door. */
  rules: [{ must: 'confirm_email = email', message: 'The email addresses do not match.' }],
  output: shape({ reference: text({ pattern: publicReferencePattern('INQ') }), message: literal('Your request is in.') }),
  async handle({ db, now }, input) {
    const reference = publicReference('INQ');
    await db.inquiry.insert({
      reference,
      email: input.email,
      first_name: input.first_name,
      last_name: input.last_name,
      phone: input.phone ?? null,
      topic: input.topic,
      urgent: input.urgent ? 1 : 0,
      message: input.message,
      received_at: now().toISOString(),
    });
    return { reference, message: 'Your request is in.' as const };
  },
});

export default defineCommands({ submitInquiry });
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
  files['db/migrations/V1__inquiry.sql'] = `-- Runs once, in version order.\n${TABLES.replace(/^--.*\n/, '')}`;
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
    `A public multi-step intake, drafted by \`mistri new --template intake\`. Its data is the SQLite file \`${basename(database)}\``,
    'beside this README, made from `db/migrations/`.',
    '',
    '```sh',
    'npm install       # mistri, TypeScript and Node’s types',
    'npm run dev       # serve it; open /form/apply signed out, and sign in as staff to read the inquiries',
    'npm run check     # types, typecheck and validation, the one command of the loop',
    '```',
    '',
    "- `app.ts` — the whole App: the public form (`commandForm` with `style: 'intake'`, four steps and a review) and the staff list.",
    '- `commands.ts` — `submitInquiry`, the one command: its fields and their kinds, the rule that the two emails match, and the row it writes.',
    '- `db/schema.sql` — the schema the App wants; `db/migrations/` — how a database gets there.',
    '',
    'There is no page or stylesheet of its own: the steps, the progress bar, the cards, the review and the sentence on a refusal are the stock form’s.',
    'Add a question by naming a field in `commands.ts` and a step for it in `app.ts`; add a column by writing `db/migrations/V2__<what>.sql`.',
    '`npx @mistriwork/mistri docs` lists the reference, `npx @mistriwork/mistri docs examples` the sample Apps.',
    '',
  ].join('\n');
  return files;
}

/** Writes the intake and its database; refuses a directory that already holds anything. */
export async function runNewIntake(args: readonly string[]): Promise<number> {
  const name = (args[0] ?? 'Inquiries').trim(),
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
  const files = intakeFiles(name, id, database);
  /* The checkout's own formatter config governs a project inside it, as its package.json does. */
  if (insideCheckout(dir)) {
    delete files['package.json'];
    delete files['.oxfmtrc.json'];
  }
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const [{ migrateUp }, { DEFAULT_HISTORY_TABLE }, { migrateSqliteCommandJournal }] = await Promise.all([
    import('@mistriwork/engine/server/migrate/runner.js'),
    import('@mistriwork/engine/server/migrate/history.js'),
    import('../../adapters/commands/commandJournal.js'),
  ]);
  const made = await migrateUp({ url: database, schemas: [], dir: join(dir, 'db', 'migrations'), table: DEFAULT_HISTORY_TABLE });
  if (made.failure || made.refused) throw new Error(made.failure?.message ?? made.refused);
  /* The command journal a command writes through, beside the data. */
  migrateSqliteCommandJournal(database);
  const db = new DatabaseSync(database);
  try {
    db.exec(
      `INSERT INTO inquiry (reference, email, first_name, last_name, topic, urgent, message, received_at) VALUES
         ('INQ-SAMPLE0001', 'sam@example.com', 'Sam', 'Rivera', 'support', 0, 'A sample inquiry, so the list has a row.', datetime('now'))`,
    );
  } finally {
    db.close();
  }
  console.log(`mistri: wrote ${name} to ${shownPath(dir)} — ${Object.keys(files).sort().join(', ')} and ${basename(database)}.`);
  console.log(`Next: cd ${shownPath(dir)} && npm install && npm run dev, then open /form/apply.`);
  return 0;
}
