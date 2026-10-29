/**
 * `mistri new --brief`: the brief's machine block read and refused, the schema it makes, and the App it scaffolds,
 * which `mistri check`'s loader accepts as written (the scaffold evaluates it, as a loaded App is).
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, test } from 'node:test';
import { BriefRefusal, columnOf, commandsModule, parseBrief, schemaSql } from '../packages/mistri/src/server/cli/brief.js';
import { runNewApp } from '../packages/mistri/src/server/cli/newApp.js';

const BLOCK = {
  app: { name: 'Wag & Wander', theme: 'sage', logo: 'heart' },
  entities: {
    client: { name: 'text!', email: 'email unique' },
    dog: { client: 'ref client!', name: 'text!' },
    booking: {
      dog: 'ref dog!',
      minutes: 'int! =30',
      price: 'money',
      scheduled_at: 'datetime!',
      status: 'choice requested|confirmed|done =requested',
    },
  },
  roles: { admin: { label: 'Admin', read: true, write: true, commands: ['confirmBooking'] } },
  commands: [
    {
      id: 'confirmBooking',
      on: 'booking',
      label: 'Confirm',
      when: 'status = requested',
      set: { status: 'confirmed' },
      refuse: ['Needs a walker.'],
    },
  ],
};
const document = (block: unknown) =>
  `# Brief\n\nProse the parser ignores.\n\n\`\`\`json mistri-brief\n${JSON.stringify(block, null, 2)}\n\`\`\`\n`;
const refused = (block: unknown, message: RegExp) =>
  assert.throws(
    () => parseBrief(document(block)),
    (error) => error instanceof BriefRefusal && message.test(error.message),
  );
const edit = (change: (copy: typeof BLOCK) => void) => {
  const copy = structuredClone(BLOCK);
  change(copy);
  return copy;
};

describe('the brief parser', () => {
  test('reads the machine block out of the document', () => {
    const brief = parseBrief(document(BLOCK));
    assert.equal(brief.name, 'Wag & Wander');
    assert.equal(brief.theme, 'sage');
    assert.deepEqual(
      brief.entities.map((entity) => entity.name),
      ['client', 'dog', 'booking'],
    );
    const booking = brief.entities[2].fields;
    assert.deepEqual(booking.map(columnOf), ['dog_id', 'minutes', 'price', 'scheduled_at', 'status']);
    assert.deepEqual(booking[4].values, ['requested', 'confirmed', 'done']);
    assert.equal(booking[4].default, 'requested');
    assert.equal(booking[1].required, true);
    assert.equal(brief.entities[0].fields[1].unique, true);
    assert.deepEqual(brief.commands[0].set, { status: 'confirmed' });
  });

  test('refuses what a scaffold could not act on, saying where', () => {
    assert.throws(() => parseBrief('# no block here'), /no ```json mistri-brief block/);
    refused(
      edit((b) => ((b.app as { theme: string }).theme = 'neon')),
      /app\.theme.*workshop, lumen, mono, sage, ledger/,
    );
    refused(
      edit((b) => ((b.app as { logo: string }).logo = 'paw-print')),
      /not one of the App icons/,
    );
    refused(
      edit((b) => ((b.entities.dog as Record<string, string>).client = 'ref nobody!')),
      /dog\.client: ref names "nobody"/,
    );
    refused(
      edit((b) => ((b.entities.dog as Record<string, string>).name = 'string!')),
      /dog\.name: "string!" is not a field type/,
    );
    refused(
      edit((b) => ((b.entities.booking as Record<string, string>).status = 'choice open')),
      /two or more values/,
    );
    refused(
      edit((b) => ((b.entities.booking as Record<string, string>).status = 'choice a|b =c')),
      /default "c" is not one of a, b/,
    );
    refused(
      edit((b) => ((b.entities.client as Record<string, string>).id = 'int')),
      /not "id"/,
    );
    refused(
      edit((b) => ((b.commands[0] as { on: string }).on = 'ghost')),
      /"on" is an entity from/,
    );
    refused(
      edit((b) => ((b.commands[0].set as Record<string, string>).colour = 'red')),
      /set names "colour"/,
    );
    refused(
      edit((b) => (b.roles.admin.commands = ['nothing'])),
      /runs "nothing"/,
    );
    refused(
      edit((b) => ((b.entities as Record<string, unknown>).order = { name: 'text' })),
      /entity "order".*not a SQL word/,
    );
  });
});

describe('the schema a brief makes', () => {
  test('puts a table after the ones it references, indexes each reference and constrains a choice', () => {
    const sql = schemaSql(parseBrief(document(BLOCK)));
    assert.ok(sql.indexOf('CREATE TABLE client') < sql.indexOf('CREATE TABLE dog'));
    assert.ok(sql.indexOf('CREATE TABLE dog') < sql.indexOf('CREATE TABLE booking'));
    assert.match(sql, /dog_id INTEGER NOT NULL REFERENCES dog\(id\)/);
    assert.match(sql, /CREATE INDEX booking_dog_id ON booking\(dog_id\);/);
    assert.match(sql, /status TEXT NOT NULL DEFAULT 'requested' CHECK \(status IN \('requested', 'confirmed', 'done'\)\)/);
    assert.match(sql, /minutes INTEGER NOT NULL DEFAULT 30/);
    assert.match(sql, /scheduled_at DATETIME NOT NULL/);
    assert.match(sql, /email TEXT UNIQUE/);
  });

  test('stubs each command as a working change with its refusals as TODO lines', () => {
    const text = commandsModule(parseBrief(document(BLOCK)), 'wag_wander');
    assert.match(text, /defineSource<Rows>\('wag_wander'\)/);
    assert.match(text, /when: "status = requested"/);
    assert.match(text, /TODO refuse\("Needs a walker\."\)/);
    assert.match(text, /await db\.booking\.update\(record, \{ status: 'confirmed' \}\)/);
    assert.match(text, /export default defineCommands\(\{ confirmBooking \}\)/);
  });
});

describe('mistri new --brief', () => {
  const root = mkdtempSync(join(tmpdir(), 'brief-'));
  after(() => rmSync(root, { recursive: true, force: true }));
  /* Outside the checkout, with mistri and TypeScript "installed" beside the App, as a project that ran npm install. */
  const checkout = resolve('.');
  mkdirSync(join(root, 'node_modules'));
  mkdirSync(join(root, 'node_modules', '@mistriwork'), { recursive: true });
  symlinkSync(join(checkout, 'packages', 'mistri'), join(root, 'node_modules', '@mistriwork', 'mistri'), 'dir');
  symlinkSync(join(checkout, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
  mkdirSync(join(root, 'node_modules', '@types'));
  symlinkSync(join(checkout, 'node_modules', '@types', 'node'), join(root, 'node_modules', '@types', 'node'), 'dir');
  const mistri = (dir: string, ...args: string[]) => {
    const ran = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        join(checkout, 'packages/mistri/src/server/index.ts'),
        ...args,
        '--app',
        dir,
        '--config',
        join(dir, 'mistri.json'),
      ],
      { cwd: checkout, encoding: 'utf8', timeout: 120_000 },
    );
    assert.equal(ran.status, 0, `mistri ${args.join(' ')}: ${ran.stdout}${ran.stderr}`);
    return ran.stdout;
  };

  test('scaffolds the App the brief describes and a database that holds its schema', async () => {
    const file = join(root, 'BRIEF.md');
    writeFileSync(file, document(BLOCK));
    const dir = join(root, 'app');
    const log = console.log;
    console.log = () => {};
    let code: number;
    try {
      code = await runNewApp(['--brief', file, dir]);
    } finally {
      console.log = log;
    }
    assert.equal(code, 0);
    for (const written of [
      'app.ts',
      'resources.ts',
      'views.ts',
      'commands.ts',
      'BRIEF.md',
      'db/schema.sql',
      'db/migrations/V1__create.sql',
      'wag-wander.db',
    ])
      assert.ok(existsSync(join(dir, written)), `${written} is written`);
    const app = readFileSync(join(dir, 'app.ts'), 'utf8');
    assert.match(app, /preset: 'sage'/);
    assert.match(app, /logo: 'heart'/);
    assert.match(app, /connection: 'wag_wander'/);
    assert.match(app, /commands: \['confirmBooking'\]/);
    /* The brief's one command moves the status its machine already draws, so it is that step's verb, not a second button. */
    assert.match(readFileSync(join(dir, 'resources.ts'), 'utf8'), /requested: \{ on: \{ confirmBooking: 'confirmed'/);
    const config = JSON.parse(readFileSync(join(dir, 'mistri.json'), 'utf8'));
    assert.deepEqual(config.connections[0], {
      name: 'wag_wander',
      url: 'wag-wander.db',
      writable: true,
      migrations: { dir: 'db/migrations' },
    });
    assert.equal(readFileSync(join(dir, 'BRIEF.md'), 'utf8'), document(BLOCK));
    /* The loop's own verdict: the command journal provisioned as the next steps say, rows seeded, and the App checked. */
    mistri(dir, 'migrate', 'stores', 'up');
    assert.match(mistri(dir, 'seed'), /Seeded wag_wander with \d+ rows/);
    assert.match(mistri(dir, 'check', '--brief'), /^ok\s*$/);
  });

  test('refuses a brief that cannot be read and a folder that is not empty, before writing anything', async () => {
    const quiet = console.error;
    console.error = () => {};
    try {
      assert.equal(await runNewApp(['--brief', join(root, 'missing.md'), join(root, 'x')]), 1);
      const bad = join(root, 'bad.md');
      writeFileSync(bad, '# nothing');
      assert.equal(await runNewApp(['--brief', bad, join(root, 'y')]), 1);
      assert.equal(existsSync(join(root, 'y')), false);
      const file = join(root, 'ok.md');
      writeFileSync(file, document(BLOCK));
      assert.equal(await runNewApp(['--brief', file, root]), 1, 'root holds files already');
      assert.ok(readdirSync(root).includes('BRIEF.md'));
    } finally {
      console.error = quiet;
    }
  });
});
