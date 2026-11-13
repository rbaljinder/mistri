/**
 * A choice from a table narrowed by another answer of the same form (`field.choice({ from, where })`), over a real
 * server, on SQLite and on PostgreSQL: a public form is served each row's `where` columns beside its label, so the
 * page narrows the options itself; a submission is judged with the `where` bound to the answers sent, in the
 * command's own transaction, so a pairing the form never offered (a forged pair) and a pick with no parent answer
 * are both refused as a key outside the choices is. The load refuses a `where` that reads its own answer back
 * (a cycle) or names no input; a column `from` lacks, or a name that is both an input and a column, holds the form
 * back with why, as a `labelColumn` naming a missing column does; on a public form a `where` column `auth.public`
 * does not open is refused by name.
 *
 * Its own file: a load holds an App's catalogs under its id, and the App here is `clinic`.
 */
import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { LIVE_PG, policyServer, refusedStart, sourceUrl, type PolicyServerOptions } from './support/policyServer.js';
import { boundChoiceMatch, choiceRowHolds, type AppCommandField } from '../packages/mistri/src/shared/command.js';

const SQL = (postgres: boolean) => {
  const integer = postgres ? 'integer' : 'INTEGER';
  const flag = postgres ? 'boolean NOT NULL' : 'INTEGER NOT NULL CHECK (active IN (0, 1))';
  const [yes, no] = postgres ? ['true', 'false'] : ['1', '0'];
  return `CREATE TABLE place(id ${integer} PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE service(id ${integer} PRIMARY KEY, name TEXT NOT NULL, location ${integer} NOT NULL, region TEXT, active ${flag});
  CREATE TABLE booking(id ${integer} PRIMARY KEY, service_id ${integer});
  INSERT INTO place VALUES (1, 'North'), (2, 'South');
  INSERT INTO service VALUES (10, 'Cleaning', 1, 'n', ${yes}), (11, 'Whitening', 1, 'n', ${no}), (20, 'Braces', 2, 's', ${yes});`;
};

interface Said {
  where?: string;
  /** A second input, for a `where` that would read it. */
  extra?: Record<string, unknown>;
  publicFields?: string[];
}

const commands = (said: Said) => `import { defineCommand, defineCommands } from ${sourceUrl(
  'packages/mistri/src/server/commands/businessCommands.ts',
)};
import { refuse } from ${sourceUrl('packages/mistri/src/server/commands/commandErrors.ts')};
import { literal, shape, text } from ${sourceUrl('packages/mistri/src/server/commands/commandShapes.ts')};
import { publicReferencePattern } from ${sourceUrl('packages/mistri/src/server/forms/publicReference.ts')};
export default defineCommands({
  book: defineCommand({ targets: 'none', source: 'main', target: 'booking', read: ['booking', 'place', 'service'], write: ['booking'], public: true,
    input: ${JSON.stringify({
      location: { label: 'Location', type: 'choice', from: 'place', labelColumn: 'name', optional: true },
      service: {
        label: 'Service',
        type: 'choice',
        from: 'service',
        labelColumn: 'name',
        where: said.where ?? 'location = location and active = true',
      },
      ...said.extra,
    })},
    output: shape({ reference: text({ pattern: publicReferencePattern('BOOK') }), message: literal('Received.') }),
    async handle() { refuse('Not taken.'); } }),
});`;

const options = (postgres: boolean, said: Said = {}): PolicyServerOptions => ({
  app: {
    id: 'clinic',
    name: 'Clinic',
    auth: {
      roles: { staff: { read: true } },
      public: {
        read: ['place', 'service'],
        ...(said.publicFields ? { fields: { service: { read: said.publicFields } } } : {}),
      },
    },
    resources: { place: {}, service: {}, booking: { access: 'write' } },
    views: {
      bookings: { kind: 'list', from: 'booking' },
      book: { kind: 'form', label: 'Book', public: true, done: { title: 'Thanks' }, command: 'book' },
    },
    home: 'bookings',
    nav: ['bookings'],
  },
  sql: SQL(postgres),
  commands: commands(said),
  live: true,
  postgres,
});

type Served = AppCommandField & { options?: Array<{ value: number; label: string; row?: Record<string, unknown> }> };

async function narrowed(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, options(postgres));
  const answer = await server.call('/api/forms/book?app=clinic');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const service = (answer.body.form.input as Served[]).find((each) => each.name === 'service')!;
  assert.ok(service.type === 'choice' && service.source?.match, 'the compiled where rides with the field');
  // The rows a where holds whatever is answered are served, place by place, each with the columns its where compares
  // and nothing else of the row: the inactive service is never offered, so it is not sent.
  assert.deepEqual(
    service.options!.map((option) => [option.value, Object.keys(option.row ?? {}).sort()]),
    [
      [10, ['active', 'location']],
      [20, ['active', 'location']],
    ],
  );
  // The page narrows them as the database would: North's active services; South's; nothing until a place is answered.
  const offered = (answers: Record<string, unknown>) => {
    const bound = boundChoiceMatch(service.source!.match!, answers);
    return bound ? service.options!.filter((option) => choiceRowHolds(bound, option.row)).map((option) => option.value) : [];
  };
  assert.deepEqual(offered({ location: 1 }), [10]);
  assert.deepEqual(offered({ location: '2' }), [20], 'a key sent as text is the same key');
  assert.deepEqual(offered({}), [], 'an empty parent answer offers nothing');
  assert.deepEqual(offered({ location: '' }), []);

  let n = 0;
  const submit = (input: Record<string, unknown>) =>
    server.call('/api/forms/book?app=clinic', { input, submission: `public-submission-${String(++n).padStart(6, '0')}` });
  const said = (reply: { status: number; body: unknown }) => `${reply.status} ${JSON.stringify(reply.body)}`;
  const choices = /This is not one of the choices/;
  // An offered pair reaches the handler.
  assert.match(said(await submit({ location: 1, service: 10 })), /Not taken/);
  assert.match(said(await submit({ location: '2', service: 20 })), /Not taken/, 'a parent key sent as text binds the same');
  // A pair the form never offered: another place's service, an inactive one, a service with no place answered (five
  // submissions in all: a visitor's sixth in the minute is rate limited).
  for (const forged of [{ location: 1, service: 20 }, { location: 1, service: 11 }, { service: 10 }]) {
    const reply = await submit(forged);
    assert.match(said(reply), choices, JSON.stringify(forged));
    assert.doesNotMatch(said(reply), /Not taken/);
  }
}

test('SQLite: a choice narrowed by another answer is served its where columns, and a forged pair is refused', { timeout: 60_000 }, (t) =>
  narrowed(t, false),
);

test(
  'PostgreSQL: a choice narrowed by another answer is served its where columns, and a forged pair is refused',
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => narrowed(t, true),
);

/* More rows than one list carries: the served read is narrowed per place, so a place whose services all sort after
   another place's first two hundred is still offered every one of them, and the full place its first two hundred. */
async function crowded(t: TestContext, postgres: boolean) {
  const yes = postgres ? 'true' : '1';
  const rows = [
    ...Array.from({ length: 250 }, (_, i) => `(${1000 + i}, 'Alpha ${1000 + i}', 1, 'n', ${yes})`),
    ...Array.from({ length: 5 }, (_, i) => `(${5000 + i}, 'Zulu ${5000 + i}', 2, 's', ${yes})`),
  ];
  const said = options(postgres);
  const server = await policyServer(t, { ...said, sql: `${said.sql}\n  INSERT INTO service VALUES ${rows.join(', ')};` });
  const answer = await server.call('/api/forms/book?app=clinic');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const service = (answer.body.form.input as Served[]).find((each) => each.name === 'service')!;
  assert.ok(service.type === 'choice' && service.options, 'the options are served with the form');
  const offered = (answers: Record<string, unknown>) =>
    service
      .options!.filter((option) => choiceRowHolds(boundChoiceMatch(service.source!.match!, answers)!, option.row))
      .map((option) => Number(option.value));
  assert.deepEqual(
    offered({ location: 2 }).sort((a, b) => a - b),
    [20, 5000, 5001, 5002, 5003, 5004],
    'every service of South is offered',
  );
  assert.equal(offered({ location: 1 }).length, 200, 'North is offered as many as one list carries');
}

test('SQLite: a where narrows the served options per answer, past one list of rows', { timeout: 60_000 }, (t) => crowded(t, false));

test(
  'PostgreSQL: a where narrows the served options per answer, past one list of rows',
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => crowded(t, true),
);

/* A boolean in a list binds as a single `= true` does: as a boolean, which PostgreSQL compares with a boolean column. */
async function booleanList(t: TestContext, postgres: boolean) {
  const server = await policyServer(t, options(postgres, { where: 'location = location and active in (true, false)' }));
  const answer = await server.call('/api/forms/book?app=clinic');
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  const service = (answer.body.form.input as Served[]).find((each) => each.name === 'service')!;
  assert.ok(service.type === 'choice' && service.source?.match, 'the compiled where rides with the field');
  const bound = boundChoiceMatch(service.source.match, { location: 1 })!;
  assert.deepEqual(
    service.options!.filter((option) => choiceRowHolds(bound, option.row)).map((option) => option.value),
    [10, 11],
    'an active and an inactive service at North are both offered',
  );
  let n = 0;
  const submit = (input: Record<string, unknown>) =>
    server.call('/api/forms/book?app=clinic', { input, submission: `public-submission-${String(++n).padStart(6, '0')}` });
  const said = (reply: { status: number; body: unknown }) => `${reply.status} ${JSON.stringify(reply.body)}`;
  assert.match(said(await submit({ location: 1, service: 10 })), /Not taken/, 'an active service holds');
  assert.match(said(await submit({ location: 1, service: 11 })), /Not taken/, 'an inactive service holds');
  assert.match(said(await submit({ location: 1, service: 20 })), /This is not one of the choices/, 'another place is still refused');
}

test('SQLite: a boolean list in a where binds as booleans', { timeout: 60_000 }, (t) => booleanList(t, false));

test(
  'PostgreSQL: a boolean list in a where binds as booleans',
  { timeout: 60_000, skip: LIVE_PG ? false : 'TABLEWALK_TEST_PG is not set' },
  (t) => booleanList(t, true),
);

test(
  'the load refuses a where that is a cycle, names no input, or reads a column the public cannot, and warns of the rest',
  { timeout: 120_000 },
  async (t) => {
    const cycle = await refusedStart(
      t,
      options(false, {
        where: 'location = location and region = second',
        extra: { second: { label: 'Second', type: 'choice', from: 'service', labelColumn: 'name', where: 'region = service' } },
      }),
    );
    assert.match(cycle, /input "service" where reads its own answer back \(service → second → service\)/);
    const itself = await refusedStart(t, options(false, { where: 'location = service' }));
    assert.match(itself, /input "service" where reads "service", its own answer/);
    const stray = await refusedStart(t, options(false, { where: 'location = elsewhere' }));
    assert.match(stray, /compares location with "elsewhere", which is no input of the form/);
    const operator = await refusedStart(t, options(false, { where: 'name ~ "Clean"' }));
    assert.match(operator, /input "service"[^\n]*where/);
    const closed = await refusedStart(t, options(false, { publicFields: ['id', 'name', 'location'] }));
    assert.match(closed, /\[public-form-picker\][^\n]*a visitor may not read its column "active"/);
    // A column the table lacks, and a name both an input and a column: the form is held back with why.
    const missing = await policyServer(t, options(false, { where: 'location = location and open = true' }));
    assert.match(missing.log(), /App warning: [^\n]*where compares "open", which is not a column of "service"/);
    const ambiguous = await policyServer(
      t,
      options(false, { where: 'location = region', extra: { region: { label: 'Region', type: 'text' } } }),
    );
    assert.match(
      ambiguous.log(),
      /App warning: [^\n]*"region", which is both an input of the form and a column of "service": rename the input/,
    );
  },
);
