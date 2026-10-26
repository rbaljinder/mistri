/**
 * What an App says that parses and can never happen: a literal outside a
 * column's known values, a fixed action no role may run, a command action no
 * role is granted. Each passed `mistri check` silently; each is now a warning,
 * printed beside the verdict without changing it, naming where it was written
 * and what the column holds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestApp as parseAppConfig } from './support/commandCatalog.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { withRollups } from '../packages/mistri/src/shared/app.js';
import { appLiteralWarnings, appMenuWarnings, appReachWarnings, appRestatedWarnings } from '../packages/mistri/src/shared/appWarnings.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { columnCaption } from '../packages/engine/src/shared/columnCaption.js';
import { saidAt } from '../packages/engine/src/shared/query.js';
import { parseViewQuery } from '../packages/engine/src/shared/view.js';

const STATUS = ['new', 'open', 'resolved', 'closed'];
const schema: DatabaseSchema = {
  label: 'Helpdesk',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    {
      id: 'ticket',
      name: 'ticket',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'subject', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, allowed: STATUS },
        { name: 'priority', type: 'TEXT', nullable: false, primaryKey: false },
        { name: 'version', type: 'INTEGER', nullable: false, primaryKey: false },
      ],
    },
    {
      id: 'reply',
      name: 'reply',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
        { name: 'ticket_id', type: 'INTEGER', nullable: false, primaryKey: false, references: { table: 'ticket', column: 'id' } },
        { name: 'kind', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['note', 'answer'] },
      ],
    },
  ],
  foreignKeys: [{ name: 'reply_ticket', from: { table: 'reply', columns: ['ticket_id'] }, to: { table: 'ticket', columns: ['id'] } }],
};
const said = `is not one of ticket.status (${STATUS.join(', ')}), so it never matches.`;

test('a literal a vocabulary column never holds is named where it was written', () => {
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      resources: {
        ticket: {
          access: 'write',
          segments: { resolved: 'status = resolvd or status = closed', open: 'status = open' },
          display: { status: { tone: { resolvd: 'good', open: 'warn', '*': 'neutral' } }, priority: { tone: { urgnt: 'bad' } } },
          form: { defaults: { status: 'nwe' } },
          actions: {
            start: { label: 'Start', set: { status: 'open' }, when: 'status = nwe' },
            close: { label: 'Close', set: { status: 'closd' }, when: 'status in (open, resolved)' },
          },
        },
      },
      views: {
        tickets: {
          kind: 'list',
          from: 'ticket',
          query: 'status != archived',
          tabs: ['resolved', 'open', { label: 'All' }],
        },
        home: {
          kind: 'dashboard',
          label: 'Home',
          sections: [{ kind: 'metric', title: 'Waiting', from: 'ticket', query: 'status in (new, waiting)' }],
        },
      },
      home: 'home',
      nav: ['home', 'tickets'],
    },
    'fixture',
  );
  const pages = parsePagesConfig(
    {
      pages: [
        {
          label: 'Ticket',
          base: 'ticket',
          sections: [
            { kind: 'fields', show: ['subject'], when: 'status = opn' },
            { kind: 'metric', title: 'Answers', from: 'reply', whose: 'ticket_id', query: 'kind = anser' },
          ],
        },
      ],
    },
    'fixture',
  );
  assert.deepEqual(
    appLiteralWarnings(app, pages, withRollups(app, schema)),
    [
      `view "home", section "Waiting": "waiting" ${said}`,
      `view "tickets": "archived" ${said}`,
      `view "tickets", tab "Resolved": "resolvd" ${said}`,
      `resources "ticket", action "start": "nwe" ${said}`,
      `resources "ticket", action "close": "closd" ${said}`,
      `resources "ticket", form defaults: "nwe" ${said}`,
      `resources "ticket", display "status": "resolvd" ${said}`,
      `page "Ticket", section 1: "opn" ${said}`,
      'page "Ticket", section "Answers": "anser" is not one of reply.kind (note, answer), so it never matches.',
    ],
    'a column the catalog gives no values (priority) is never judged; "*" and the known values pass',
  );
});

test('an action no role can run, and a command no role is granted, are named', () => {
  const resolve = { id: 'resolveTicket', version: 1, target: 'ticket', input: {} };
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      sources: { desk: { connection: 'desk', default: true } },
      resources: {
        ticket: {
          access: 'write',
          actions: {
            start: { label: 'Start', set: { status: 'open' }, when: 'status = new' },
            resolve: { label: 'Resolve', command: resolve },
          },
        },
        reply: { access: 'write', actions: { markAnswer: { label: 'Mark answer', set: { kind: 'answer' } } } },
      },
      auth: { roles: { agent: { read: true, write: ['reply'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  assert.deepEqual(appReachWarnings(app, schema), [
    'resources "ticket", action "start" is never offered: no role writes "ticket" or is granted the action. Grant it by id (roles.<role>.actions), grant write, or run the change as a command.',
    'resources "ticket", action "resolve" runs command "resolveTicket", which no role is granted, so it is never offered. Add it to a role\'s "commands".',
  ]);
  const granted = parseAppConfig(
    {
      name: 'Helpdesk',
      sources: { desk: { connection: 'desk', default: true } },
      resources: { ticket: { access: 'write', actions: { resolve: { label: 'Resolve', command: resolve } } } },
      auth: { roles: { agent: { read: true, commands: ['resolveTicket'] } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  assert.deepEqual(appReachWarnings(granted, schema), []);
});

test('an App without role grants warns only where its own ceiling leaves an action unwritable', () => {
  const readOnly = parseAppConfig(
    {
      name: 'Scoped',
      resources: {
        ticket: { actions: { start: { label: 'Start', set: { status: 'open' } } } },
        reply: { access: 'write' },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  assert.deepEqual(appReachWarnings(readOnly, schema), [
    'resources "ticket", action "start" is never offered: the App does not write "ticket". Give the resource access \'write\', or drop the action.',
  ]);
});

test('an unstated id is the slug of the name, the address the docs give; /api is refused', () => {
  const at = 'fixture';
  const base = { resources: { ticket: {} }, views: { tickets: { kind: 'list', from: 'ticket' } }, home: 'tickets' };
  assert.equal(parseAppConfig({ name: 'Help Desk', ...base }, at).id, 'help-desk');
  assert.equal(parseAppConfig({ name: 'Help Desk', id: 'desk', ...base }, at).id, 'desk');
  assert.throws(
    () => parseAppConfig({ name: 'API', ...base }, at),
    /the App "API" would be served at \/api \(its id defaults to a slug of its name\), which is the server's own address\. Give it another "id"\./,
  );
  assert.throws(() => parseAppConfig({ name: 'Anything', id: 'api', ...base }, at), /has the id "api"/);
});

test('a literal a number or a word cannot be is named', () => {
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      resources: {
        ticket: { segments: { stale: 'version = none', fine: 'version >= 2 and version < 9007199254740993' } },
        reply: {},
      },
      views: {
        tickets: { kind: 'list', from: 'ticket', label: 'Tickets', tabs: ['stale', 'fine'] },
        replies: { kind: 'list', from: 'reply', label: 'Replies', query: 'ticket_id.version = soon' },
      },
      home: 'tickets',
      nav: ['tickets', 'replies'],
    },
    'app.ts',
  );
  assert.deepEqual(appLiteralWarnings(app, [], withRollups(app, schema)), [
    'view "tickets", tab "Stale": "none" is not a number, and ticket.version is INTEGER, so it never matches.',
    'view "replies": "soon" is not a number, and ticket.version is INTEGER, so it never matches.',
  ]);
});

/* `= null` bound the four letters and matched nothing: a tab always empty, a
   menu count always 0, and in a tenant App a count refused with no cause. */
test('"= null" is refused with the words to write instead, and where it stands', () => {
  const said = (text: string) => {
    const parsed = parseViewQuery(schema, 'ticket', text);
    return parsed.errors.map((error) => saidAt(error, text.trim()));
  };
  assert.deepEqual(said('status = open and priority = null'), [
    '"priority = null" compares with the word "null": write "priority is empty" for a missing value, or quote it ("null") to mean the text. (at character 19: "priority = null")',
  ]);
  assert.match(said('priority != NULL')[0], /write "priority is not empty"/);
  // Quoted, it is the text, as any quoted value is.
  assert.deepEqual(said('priority = "null"'), []);
  // A misspelled column is named with its place in the query.
  assert.deepEqual(said('status = open and priorty = high'), [
    '"priorty" is not a column on ticket. Did you mean "priority"? (at character 19: "priorty = high")',
  ]);
});

test('a settings record named like an account-menu item is said, with a name to give it instead', () => {
  const app = (settings: string, auth = true) =>
    parseAppConfig(
      {
        id: 'loans',
        name: 'Loans',
        resources: { customer: { settings } },
        views: { customers: { kind: 'list', from: 'customer' } },
        home: 'customers',
        ...(auth ? { auth: { roles: { borrower: { read: true } } } } : {}),
      },
      'menu warnings',
    );
  const [said] = appMenuWarnings(app('Your profile'));
  assert.match(
    said,
    /^resources "customer": settings "Your profile" is also an item the account menu holds .*"Your account".* → name the record by what it holds/,
  );
  assert.equal(appMenuWarnings(app('sign out')).length, 1);
  assert.deepEqual(appMenuWarnings(app('Contact details')), []);
  assert.deepEqual(appMenuWarnings(app('Your profile', false)), [], 'no sign-in, no account menu');
});

test('a caption the schema already implies is a restatement, and a column made words drops its _id', () => {
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      resources: { ticket: { labels: { ticket_id: 'Ticket', subject: 'Subject', priority: 'Urgency' } } },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  const said = appRestatedWarnings(app, schema).filter((line) => line.includes('labels'));
  assert.equal(said.length, 1, said.join('\n'));
  assert.match(said[0], /"subject"/);
  assert.equal(columnCaption(app.resources ?? {}, schema, 'reply', 'ticket_id'), 'Ticket');
});

test('a display word the declared vocabulary already says is a restatement; free text and a different word are not', () => {
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      resources: {
        ticket: {
          display: {
            status: { values: { new: 'New', open: 'Open', resolved: 'Fixed' } },
            priority: { values: { urgent: 'Urgent' } },
          },
        },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  const said = appRestatedWarnings(app, schema).filter((line) => line.includes('display'));
  assert.deepEqual(
    said.map((line) => /values "(\w+)"/.exec(line)?.[1]),
    ['new', 'open'],
    said.join('\n'),
  );
});

/* A free-text column has no vocabulary, so the keys of `values` are the order a steps breakdown reads it in: a
   restated word there is not deletable, or `check --design --fix` would reorder the steps it was told to keep. */
test('a toned free-text column keeps the values that order its steps, and a declared vocabulary does not need them', () => {
  const app = parseAppConfig(
    {
      name: 'Helpdesk',
      resources: {
        ticket: {
          display: {
            status: { tone: { new: 'info' }, values: { new: 'New' } },
            priority: { tone: { urgent: 'bad' }, values: { urgent: 'Urgent', high: 'High' } },
          },
        },
      },
      views: { tickets: { kind: 'list', from: 'ticket' } },
      home: 'tickets',
    },
    'fixture',
  );
  const said = appRestatedWarnings(app, schema).filter((line) => /display "(status|priority)" values/.test(line));
  assert.deepEqual(
    said.map((line) => /display "(\w+)" values "(\w+)"/.exec(line)?.slice(1).join('.')),
    ['status.new'],
    said.join('\n'),
  );
});
