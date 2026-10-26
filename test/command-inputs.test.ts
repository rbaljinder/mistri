/**
 * Command inputs, declared once, as fields keyed by name. The declaration
 * parser (labels from keys, required by default, dates, choices, groups,
 * repeats, formats, patterns, case, steps, a field below or above its
 * sibling, and the caps), the value parser the browser and the server both
 * read by (nested refusal paths, one reading on both sides), `validate` as a
 * function or a Standard Schema, parity between every Ignition command's
 * declared input and a hand-written reference parser, and prepare's `initial` — who may read
 * it, what it may read, and a prefilled form meeting a version conflict —
 * end to end over HTTP, beside a public form's caps and its audit.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { sqliteAuditRows } from './support/commandTargets.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { field as fieldHelpers } from '../packages/mistri/src/server/commands/commandFields.js';
import { COMMAND_INPUT_LIMITS, fieldLabel, parseFormCommandReference, withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { CommandInputRefusal, commandFieldAt, commandInputProblems, readCommandInput } from '../packages/mistri/src/shared/commandInput.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import type { Identity } from '../packages/mistri/src/server/auth/auth.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  parseRegisteredInput,
  type AnyBusinessCommand,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import { loadAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { validateBusinessCommandReferences } from '../packages/mistri/src/server/commands/businessCommandLoader.js';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import * as financingCommands from '../test/fixtures/apps/ignition/financing.js';
import { leadCommands } from '../test/fixtures/apps/ignition/leads.js';
import { platformCommands } from '../test/fixtures/apps/ignition/platform.js';
import { flagOverdueReview } from '../test/fixtures/apps/ignition/review.js';
import { parseTestApp } from './support/commandCatalog.js';

/* ---------- the declaration ---------- */

// Labels are read from the keys: `start` is "Start", `year` is "Year".
const declaration = {
  applicant: {
    type: 'group',
    fields: {
      name: { type: 'text', max: 40 },
      email: { type: 'text', optional: true },
      address: { type: 'group', fields: { city: { type: 'text' } } },
    },
  },
  vehicles: {
    type: 'group',
    repeat: { min: 1, max: 3 },
    fields: {
      stock: { type: 'text', max: 12 },
      year: { type: 'number', integer: true, min: 1990, max: 2030, optional: true },
    },
  },
  start: { type: 'date', min: '2026-01-01', max: '2026-12-31' },
  plan: {
    type: 'choice',
    options: [
      { value: 'basic', label: 'Basic' },
      { value: 36, label: '36 months' },
    ],
  },
  notes: { type: 'textarea', max: 200, optional: true },
} as const;

/* The list the parser leaves, which the App serves to the browser and the server reads a request by. */
const normalized = [
  {
    name: 'applicant',
    label: 'Applicant',
    type: 'group',
    fields: [
      { name: 'name', label: 'Name', required: true, type: 'text', maxLength: 40 },
      { name: 'email', label: 'Email', type: 'text' },
      { name: 'address', label: 'Address', type: 'group', fields: [{ name: 'city', label: 'City', required: true, type: 'text' }] },
    ],
  },
  {
    name: 'vehicles',
    label: 'Vehicles',
    type: 'group',
    repeat: { min: 1, max: 3 },
    fields: [
      { name: 'stock', label: 'Stock', required: true, type: 'text', maxLength: 12 },
      { name: 'year', label: 'Year', type: 'number', integer: true, min: 1990, max: 2030 },
    ],
  },
  { name: 'start', label: 'Start', required: true, type: 'date', min: '2026-01-01', max: '2026-12-31' },
  {
    name: 'plan',
    label: 'Plan',
    required: true,
    type: 'choice',
    options: [
      { value: 'basic', label: 'Basic' },
      { value: 36, label: '36 months' },
    ],
  },
  { name: 'notes', label: 'Notes', type: 'textarea', maxLength: 200 },
];
const fields = parseCommandInput(declaration, 'fixture');

const one = (spec: Record<string, unknown>) => ({ f: spec });
const group = (fieldsOf: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ type: 'group', fields: fieldsOf, ...extra });

test('a declaration is fields keyed by name: labels from keys, required unless optional, and one list on both sides', () => {
  assert.deepEqual(fields, normalized);
  // The App's reference and the server's registration parse the same declaration the same way, JSON or not.
  assert.equal(JSON.stringify(parseCommandInput(JSON.parse(JSON.stringify(declaration)), 'again')), JSON.stringify(fields));
  assert.equal(fieldLabel('applicant_email'), 'Applicant email');
  assert.equal(fieldLabel('reviewerId'), 'Reviewer id');
  for (const [raw, message] of [
    [one({ type: 'date', min: '2026-02-30' }), /ISO date/],
    [one({ type: 'date', min: '2026-05-01', max: '2026-04-01' }), /min must not be after max/],
    [one({ type: 'choice', options: [] }), /at least one option/],
    [
      one({
        type: 'choice',
        options: [
          { value: 'a', label: 'A' },
          { value: 'a', label: 'Again' },
        ],
      }),
      /duplicate choice value/,
    ],
    [one({ type: 'choice', options: [{ value: '', label: 'Empty' }] }), /choice value/],
    [one({ type: 'choice', options: [{ value: 'a', label: 'A' }], max: 3 }), /\(a choice field\) has no "max"\./],
    [one(group({})), /at least one field/],
    [one(group({ x: { type: 'text' } }, { optional: true })), /never optional/],
    [{ a: group({ b: group({ c: group({ x: { type: 'text' } }) }) }) }, /nest at most 2 deep/],
    [one(group({ x: { type: 'text' } }, { repeat: { max: 51 } })), /1 to 50/],
    [one(group({ x: { type: 'text' } }, { repeat: { min: 3, max: 2 } })), /repeat min/],
    [{ 'two words': { type: 'text' } }, /logical identifier/],
    [[{ name: 'f', label: 'F', type: 'text' }], /an object of fields keyed by name/],
    [one({ type: 'text', format: 'fax' }), /"email", "url" or "phone"/],
    [one({ type: 'textarea', format: 'email' }), /on a text field/],
    [one({ type: 'text', pattern: '[' }), /not a regular expression/],
    [one({ type: 'text', message: 'Nothing to say it about.' }), /give one/],
    [one({ type: 'text', case: 'title' }), /"upper" or "lower"/],
    [one({ type: 'text', min: 5, max: 4 }), /min must not exceed max/],
    [one({ type: 'number', step: -1 }), /step must be a positive number/],
    [one({ type: 'number', below: 'other' }), /another number field beside it/],
    [{ when: { type: 'date' }, amount: { type: 'number', above: 'when' } }, /another number field beside it/],
    [Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, { type: 'text' }])), /at most 32/],
  ] as const)
    assert.throws(() => parseCommandInput(raw, 'fixture'), message);
  // The whole declaration, groups and members at every depth, is capped too.
  const wide = (extra: number) =>
    Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        `g${i}`,
        group(Object.fromEntries(Array.from({ length: i === 0 ? 3 + extra : 3 }, (_, j) => [`f${j}`, { type: 'text' }]))),
      ]),
    );
  assert.equal(parseCommandInput(wide(0), 'fixture').length, 32);
  assert.throws(() => parseCommandInput(wide(1), 'fixture'), new RegExp(`at most ${COMMAND_INPUT_LIMITS.totalFields} fields`));
});

test('the field helpers write the plain declaration they stand for', () => {
  const written = {
    name: fieldHelpers.text({ label: 'Full name', max: 120 }),
    email: fieldHelpers.email({ optional: true }),
    code: fieldHelpers.text({ case: 'upper', pattern: /[A-Z]{2}-\d+/, message: 'Two letters and a number.' }),
    amount: fieldHelpers.money({ min: 1 }),
    deposit: fieldHelpers.money({ below: 'amount' }),
    term: fieldHelpers.choice([36, 48], { each: (months) => `${months} months` }),
    rows: fieldHelpers.group({ stock: fieldHelpers.text() }, { repeat: { max: 3 } }),
  };
  assert.deepEqual(JSON.parse(JSON.stringify(written)), written, 'plain JSON, the pattern as its source');
  assert.deepEqual(written.code, { type: 'text', case: 'upper', message: 'Two letters and a number.', pattern: '[A-Z]{2}-\\d+' });
  assert.deepEqual(written.amount, { type: 'money', min: 1 });
  assert.deepEqual(written.email, { type: 'text', format: 'email', max: 254, optional: true });
  assert.deepEqual(written.term.options, [
    { value: 36, label: '36 months' },
    { value: 48, label: '48 months' },
  ]);
  assert.throws(() => fieldHelpers.text({ pattern: /a/i }), /takes no flags/);
  assert.deepEqual(
    parseCommandInput(written, 'helpers').map((item) => [item.name, item.label, item.required ?? false]),
    [
      ['name', 'Full name', true],
      ['email', 'Email', false],
      ['code', 'Code', true],
      ['amount', 'Amount', true],
      ['deposit', 'Deposit', true],
      ['term', 'Term', true],
      ['rows', 'Rows', false],
    ],
  );
});

test('a public form takes a reference at every depth, judged against auth.public where the App is known, and repeats at most ten rows', () => {
  const reference = { type: 'reference', from: 'person', by: 'id', labelColumn: 'name' };
  const publicForm = (input: unknown) => parseCommandInput(input, 'public form', { publicForm: true });
  const signedIn = (input: unknown) => parseCommandInput(input, 'signed-in form');
  for (const input of [{ who: reference }, { g: group({ who: reference }) }, { a: group({ b: group({ who: reference }) }) }]) {
    assert.doesNotThrow(() => publicForm(input));
    assert.doesNotThrow(() => signedIn(input));
  }
  const rows = (max: number) => ({ trade_ins: group({ stock: { type: 'text' } }, { repeat: { max } }) });
  assert.doesNotThrow(() => publicForm(rows(COMMAND_INPUT_LIMITS.publicRepeatRows)));
  assert.throws(() => publicForm(rows(COMMAND_INPUT_LIMITS.publicRepeatRows + 1)), /1 to 10 on a public form/);
  assert.doesNotThrow(() => signedIn(rows(COMMAND_INPUT_LIMITS.repeatRows)));
  // The registration says the same: a public command's declaration is held to the public rules.
  const definition = (input: unknown) => ({
    source: 'main',
    target: 't',
    targets: 'none' as const,
    public: true as const,
    input: input as never,
    output: { parse: (value: unknown) => value },
    handle: (): unknown => ({}),
  });
  assert.doesNotThrow(() => defineCommand(definition({ g: group({ who: reference }) })));
  assert.throws(() => defineCommand(definition(rows(11))), BusinessCommandDefinitionError);
});

/* ---------- the values ---------- */

const valid = {
  applicant: { name: '  Ada Lovelace ', email: '', address: { city: 'London' } },
  vehicles: [{ stock: 'A-1', year: 2020 }, { stock: 'B-2' }],
  start: '2026-03-01',
  plan: 36,
};

const refusal = (raw: unknown, options?: { publicForm?: boolean }) => {
  try {
    readCommandInput(fields, raw, options);
  } catch (error) {
    assert.ok(error instanceof CommandInputRefusal);
    assert.equal(error.message, 'The command input is invalid.');
    return { path: error.path, reason: error.reason };
  }
  return assert.fail('expected a refusal');
};

test('values are read against the declaration: trimmed, optional empty absent, every group present', () => {
  assert.deepEqual(readCommandInput(fields, valid), {
    applicant: { name: 'Ada Lovelace', address: { city: 'London' } },
    vehicles: [{ stock: 'A-1', year: 2020 }, { stock: 'B-2' }],
    start: '2026-03-01',
    plan: 36,
  });
  // A group left out is still a group, so its required fields are what refuses.
  assert.deepEqual(refusal({ ...valid, applicant: undefined }), { path: 'applicant.name', reason: 'required' });
});

test('a datetime is a moment: declared with instants for bounds, read with its zone, handed over as the UTC instant', () => {
  const [at, until] = parseCommandInput(
    {
      at: fieldHelpers.datetime({ min: '2026-01-01T00:00:00-05:00', max: '2026-12-31 23:59:59Z' }),
      until: fieldHelpers.datetime({ above: 'at', optional: true }),
    },
    'moments',
  );
  // Bounds are normalized to the one spelling the reader compares as text.
  assert.deepEqual(at, {
    name: 'at',
    label: 'At',
    required: true,
    type: 'datetime',
    min: '2026-01-01T05:00:00.000Z',
    max: '2026-12-31T23:59:59.000Z',
  });
  assert.deepEqual(until, { name: 'until', label: 'Until', type: 'datetime', above: 'at' });
  for (const [raw, message] of [
    [one({ type: 'datetime', min: '2026-03-01T09:00' }), /with its zone/],
    [one({ type: 'datetime', min: '2026-02-30T09:00Z' }), /with its zone/],
    [one({ type: 'datetime', min: '2026-05-01T00:00Z', max: '2026-04-01T00:00Z' }), /min must not be after max/],
    [one({ type: 'datetime', integer: true }), /integer/],
    [{ when: { type: 'date' }, until: { type: 'datetime', above: 'when' } }, /another datetime field/],
  ] as const) {
    assert.throws(() => parseCommandInput(raw, 'case'), message);
  }
  const read = (input: unknown) => readCommandInput([at, until], input);
  // Postgres's timestamptz text, an offset, Z and a fraction all name the one instant they mean.
  assert.deepEqual(read({ at: '2026-10-12 19:16:00-04', until: '2026-10-13T01:00:00.123456+01:00' }), {
    at: '2026-10-12T23:16:00.000Z',
    until: '2026-10-13T00:00:00.123Z',
  });
  assert.deepEqual(read({ at: '2026-10-12T09:30Z' }), { at: '2026-10-12T09:30:00.000Z' });
  assert.deepEqual(read({ at: new Date('2026-10-12T09:30:00Z') }), { at: '2026-10-12T09:30:00.000Z' });
  const refused = (input: unknown) => {
    try {
      read(input);
    } catch (error) {
      assert.ok(error instanceof CommandInputRefusal);
      return `${error.path} ${error.reason}`;
    }
    return 'accepted';
  };
  // A wall time with no zone is a different moment in every zone, so it is not one.
  assert.equal(refused({ at: '2026-10-12T09:30' }), 'at type');
  assert.equal(refused({ at: '2026-10-12' }), 'at type');
  assert.equal(refused({ at: '2026-02-30T09:30Z' }), 'at type');
  assert.equal(refused({ at: '2026-10-12T24:00Z' }), 'at type');
  assert.equal(refused({ at: '2026-10-12T09:30+15:00' }), 'at type');
  assert.equal(refused({ at: 1760261400000 }), 'at type');
  assert.equal(refused({ at: '' }), 'at required');
  assert.equal(refused({ at: '2025-12-31T23:59Z' }), 'at below_min');
  assert.equal(refused({ at: '2027-01-01T00:00Z' }), 'at above_max');
  // Siblings compare as moments, whatever offsets they were sent in.
  assert.equal(refused({ at: '2026-10-12T10:00+02:00', until: '2026-10-12T08:00Z' }), 'until not_above');
  assert.equal(refused({ at: '2026-10-12T10:00+02:00', until: '2026-10-12T08:00:01Z' }), 'accepted');
});

test('a refusal names its field by path, nested and in rows, and never echoes a value', () => {
  const cases: Array<[unknown, string, string]> = [
    [{ ...valid, vehicles: [{ stock: 'A-1' }, { year: 2021 }] }, 'vehicles[1].stock', 'required'],
    [{ ...valid, vehicles: [{ stock: 'A-1', year: 2020.5 }] }, 'vehicles[0].year', 'integer'],
    [{ ...valid, vehicles: [{ stock: 'A-1', year: 1980 }] }, 'vehicles[0].year', 'below_min'],
    [{ ...valid, vehicles: [{ stock: 'A-1234567890123' }] }, 'vehicles[0].stock', 'too_long'],
    [{ ...valid, vehicles: [] }, 'vehicles', 'too_few'],
    [{ ...valid, vehicles: Array.from({ length: 4 }, () => ({ stock: 'X' })) }, 'vehicles', 'too_many'],
    [{ ...valid, vehicles: { stock: 'A-1' } }, 'vehicles', 'shape'],
    [{ ...valid, vehicles: [{ stock: 'A-1' }, 'B-2'] }, 'vehicles[1]', 'shape'],
    [{ ...valid, applicant: { name: 'Ada', address: {} } }, 'applicant.address.city', 'required'],
    [{ ...valid, applicant: { name: 'Ada', address: { city: 'London' } } }, 'applicant.name', 'text'],
    [{ ...valid, applicant: { name: 'Ada', address: { city: 'London' }, ssn: 'private' } }, '', 'shape'],
    [{ ...valid, start: '2026-02-30' }, 'start', 'type'],
    [{ ...valid, start: '2025-12-31' }, 'start', 'below_min'],
    [{ ...valid, start: '2027-01-01' }, 'start', 'above_max'],
    [{ ...valid, plan: 'gold' }, 'plan', 'choice'],
    // A choice is its option exactly: the text "36" is not the number 36.
    [{ ...valid, plan: '36' }, 'plan', 'choice'],
    [{ ...valid, notes: 'tab\tand\nline, then a bell' }, 'notes', 'text'],
    [{ ...valid, extra: 1 }, '', 'shape'],
  ];
  for (const [raw, path, reason] of cases) assert.deepEqual(refusal(raw), { path, reason }, `${path} ${reason}`);
  assert.deepEqual(readCommandInput(fields, { ...valid, notes: ' tab\tand\nline ' }).notes, 'tab\tand\nline');
  assert.deepEqual(
    commandInputProblems(fields, { vehicles: [{}, { stock: 'X', year: 1 }], plan: 'gold' }).map((problem) => problem.path),
    ['applicant.name', 'applicant.address.city', 'vehicles[0].stock', 'vehicles[1].year', 'start', 'plan'],
  );
  assert.equal(commandFieldAt(fields, 'vehicles[1].stock')?.label, 'Stock');
  assert.equal(commandFieldAt(fields, 'applicant.address.city')?.label, 'City');
  assert.equal(commandFieldAt(fields, 'vehicles[1].missing'), undefined);
  // The server's refusal carries the path, and only a well-formed one.
  assert.equal(new BusinessCommandExecutionError('invalid_input', 'not_applied', 'vehicles[1].stock').field, 'vehicles[1].stock');
  assert.equal(new BusinessCommandExecutionError('invalid_input', 'not_applied', 'a.b.c.d').field, undefined);
  assert.equal(new BusinessCommandExecutionError('invalid_input', 'not_applied', 'x[1]; drop').field, undefined);
});

test('a public submission is held to ten rows whatever a declaration says', () => {
  const rows = parseCommandInput({ rows: group({ stock: { type: 'text' } }, { repeat: { max: 50 } }) }, 'rows');
  const input = { rows: Array.from({ length: 11 }, () => ({ stock: 'X' })) };
  assert.equal((readCommandInput(rows, input).rows as unknown[]).length, 11);
  assert.throws(
    () => readCommandInput(rows, input, { publicForm: true }),
    (error: CommandInputRefusal) => error.path === 'rows' && error.reason === 'too_many',
  );
});

/* ---------- parity with a hand-written parser, command by command ---------- */

// Every Ignition command's input as hand-written code: the reference the
// declared parser and each command's `validate` are held to. It is not a museum
// piece. Where the multi-tenant reshape changed a contract — a reviewer named by
// an opaque text key rather than an integer, a financing form that asks for no
// dealer code at all, a review deadline travelling with the clock's job — the
// rule was rewritten here in plain JavaScript, because a second independent
// statement of the rule is the only thing that can catch a declaration drifting.
// oxlint-disable-next-line no-control-regex -- Matching control characters is this rule's subject: a line of text keeps none.
const CONTROL = /[\x00-\x1f\x7f]/;
// A textarea keeps the tab and the newline a person typed and no other control.
// oxlint-disable-next-line no-control-regex -- Same, minus the tab and the two newlines a textarea is allowed to hold.
const CONTROL_MULTILINE = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/;
const reference = {
  assignment(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid assignment input.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 2 || !Object.hasOwn(input, 'reviewer') || !Object.hasOwn(input, 'reason')) {
      throw new Error('Invalid assignment input.');
    }
    /* The reviewer is one of `lender_staff.id`, which is opaque text since the
       reshape, so an integer is no longer a staff key: the declared reference
       field would take one and the command's own `validate` refuses it. */
    if (typeof input.reviewer !== 'string' || typeof input.reason !== 'string') throw new Error('Invalid assignment input.');
    const reviewer = input.reviewer.trim();
    if (!reviewer || reviewer.length > 256) throw new Error('Invalid assignment reviewer.');
    const reason = input.reason.trim();
    if (!reason || reason.length > 500 || CONTROL_MULTILINE.test(reason)) throw new Error('Invalid assignment reason.');
    return { reviewer, reason };
  },
  noInput(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length) throw new Error('Invalid lead input.');
    return {};
  },
  // One required reason, kept on the record: disqualifyLead and withdrawApplication.
  reason(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid reason input.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 1 || typeof input.reason !== 'string') throw new Error('Invalid reason input.');
    const reason = input.reason.trim();
    if (!reason || reason.length > 500 || CONTROL_MULTILINE.test(reason)) throw new Error('Invalid reason.');
    return { reason };
  },
  /* The review clock's deadline, which travels with the job because at
     conversion there is no review file to read it from. A date, exactly as the
     declaration spells one: untrimmed, and a day that exists. */
  reviewDue(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid clock input.');
    const input = value as Record<string, unknown>;
    if (Object.keys(input).length !== 1 || typeof input.due_on !== 'string') throw new Error('Invalid clock input.');
    const due = input.due_on;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(due)) throw new Error('Invalid review deadline.');
    const parsed = new Date(`${due}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== due) throw new Error('Invalid review deadline.');
    return { due_on: due };
  },
};

/* The financing form, saved on every step since the reshape: each step is a
   command of its own that asks only its part, and the submit asks for consent
   and nothing else (declared `accept: true`: the parser itself refuses a
   consent left unticked). A key another step asks for is a stray key here like any other —
   there is still no `dealer_code`: which dealership a submission lands in is
   decided by the intake address the link carried, and only by the server. */
const financingInvalid = (): never => {
  throw new Error('invalid');
};
const financingInput = (value: unknown, known: string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid financing input.');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some((key) => !known.includes(key))) throw new Error('Invalid financing input.');
  return input;
};
const financingText = (input: Record<string, unknown>, name: string, max: number, required = true): string | undefined => {
  const given = input[name];
  if (given === undefined || given === null || given === '') {
    if (required) financingInvalid();
    return undefined;
  }
  if (typeof given !== 'string') financingInvalid();
  const trimmed = (given as string).trim();
  if (!trimmed) {
    if (required) financingInvalid();
    return undefined;
  }
  if (trimmed.length > max || CONTROL.test(trimmed)) financingInvalid();
  return trimmed;
};
const financingEmail = (input: Record<string, unknown>, name: string): string => {
  const email = financingText(input, name, 254)!;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) financingInvalid();
  return email;
};
// Money: a finite number, on the cent, between its floor and ten million.
const financingAmount = (input: Record<string, unknown>, name: string, min: number): number => {
  const given = input[name];
  if (typeof given !== 'number' || !Number.isFinite(given)) financingInvalid();
  const cents = Math.round((given as number) * 100) / 100;
  if (cents < min || cents > 10_000_000) financingInvalid();
  return cents;
};
const financing = {
  start(value: unknown) {
    const input = financingInput(value, ['applicant_name', 'applicant_email', 'applicant_phone']);
    const applicant_name = financingText(input, 'applicant_name', 120)!;
    const applicant_email = financingEmail(input, 'applicant_email');
    const applicant_phone = financingText(input, 'applicant_phone', 40, false);
    // A blank optional field is an absent one, so the format judges only a value.
    if (applicant_phone && (!/^\+?[0-9 ().-]{7,32}$/.test(applicant_phone) || applicant_phone.replace(/\D/g, '').length < 7))
      financingInvalid();
    return { applicant_name, applicant_email, ...(applicant_phone ? { applicant_phone } : {}) };
  },
  address(value: unknown) {
    const input = financingInput(value, ['address_line', 'city', 'state', 'postal_code']);
    const address_line = financingText(input, 'address_line', 120)!;
    const city = financingText(input, 'city', 60)!;
    const state = financingText(input, 'state', 2)!.toUpperCase();
    if (!/^[A-Z]{2}$/.test(state)) financingInvalid();
    const postal_code = financingText(input, 'postal_code', Infinity)!;
    if (!/^\d{5}$/.test(postal_code)) financingInvalid();
    return { address_line, city, state, postal_code };
  },
  income(value: unknown) {
    const input = financingInput(value, ['employer', 'annual_income']);
    return { employer: financingText(input, 'employer', 120)!, annual_income: financingAmount(input, 'annual_income', 1) };
  },
  loan(value: unknown) {
    const input = financingInput(value, ['vehicle_stock', 'requested_amount', 'down_payment', 'term_months']);
    const vehicle_stock = financingText(input, 'vehicle_stock', 40)!.toUpperCase();
    if (!/^[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?$/.test(vehicle_stock)) financingInvalid();
    const requested_amount = financingAmount(input, 'requested_amount', 1);
    const down_payment = financingAmount(input, 'down_payment', 0);
    const term = input.term_months;
    if (![36, 48, 60].includes(term as number)) financingInvalid();
    // The down payment is declared `below` the amount financed, so equal refuses.
    if (!(down_payment < requested_amount)) financingInvalid();
    return { vehicle_stock, requested_amount, down_payment, term_months: term };
  },
  // Up to two, each a name and an email; none at all is an empty list.
  coApplicants(value: unknown) {
    const input = financingInput(value, ['co_applicants']);
    const given = input.co_applicants ?? [];
    if (!Array.isArray(given) || given.length > 2) financingInvalid();
    return {
      co_applicants: (given as unknown[]).map((row) => {
        const each = financingInput(row ?? {}, ['co_name', 'co_email']);
        return { co_name: financingText(each, 'co_name', 120)!, co_email: financingEmail(each, 'co_email') };
      }),
    };
  },
  submit(value: unknown) {
    const input = financingInput(value, ['consent']);
    if (input.consent !== true) financingInvalid();
    return { consent: input.consent };
  },
};

const outcome = (run: () => unknown) => {
  try {
    return { accepted: run() };
  } catch {
    return { refused: true };
  }
};
const derived = (command: AnyBusinessCommand, id: string) => (value: unknown) =>
  parseRegisteredInput(
    command,
    value,
    { actor: { id: 'manager-account', appId: 'ignition', roles: ['manager'] }, commandId: id, version: command.version },
    { publicForm: command.public === true },
  );

test('every Ignition command accepts and refuses exactly what its reference parser does, with the same result', () => {
  const applicant = { applicant_name: 'Mara Alder', applicant_email: 'mara@example.test' };
  const address = { address_line: '12 Harbor Street', city: 'Portland', state: 'me', postal_code: '04101' };
  const income = { employer: 'Alder Marine', annual_income: 64000.005 };
  const loan = { vehicle_stock: 'demo-stock-1049', requested_amount: 21000.005, down_payment: 1500, term_months: 48 };
  const coApplicant = { co_name: 'Jon Alder', co_email: 'jon@example.test' };
  // A staff key as `lender_staff.id` is written since the reshape: opaque text.
  const staff = 'staff-reviewer-1';
  const reasons: unknown[] = [
    { reason: 'Not eligible' },
    { reason: '  padded  ' },
    { reason: 'Two\nlines' },
    { reason: 'A bell' },
    { reason: '' },
    { reason: '   ' },
    { reason: 5 },
    {},
    { reason: 'x', extra: 1 },
    { reason: 'x'.repeat(500) },
    { reason: 'x'.repeat(501) },
    null,
  ];
  const corpora: Array<[string, AnyBusinessCommand, (value: unknown) => unknown, unknown[]]> = [
    [
      'assignReviewer',
      platformCommands.assignReviewer,
      reference.assignment,
      [
        null,
        [],
        {},
        { reviewer: staff },
        { reviewer: staff, reason: 'Valid' },
        { reviewer: `  ${staff}  `, reason: `  ${'x'.repeat(500)}  ` },
        { reviewer: staff, reason: 'Two\nlines' },
        { reviewer: staff, reason: 'A bell' },
        { reviewer: staff, reason: '' },
        { reviewer: staff, reason: '   ' },
        { reviewer: staff, reason: 'x'.repeat(501) },
        { reviewer: staff, reason: 7 },
        { reviewer: staff, reason: 'Valid', assigned_by: 1 },
        { reviewer: 'x'.repeat(257), reason: 'Valid' },
        // An integer names no reviewer any more, whatever its value.
        { reviewer: 3, reason: 'Valid' },
        { reviewer: 0, reason: 'Valid' },
        { reviewer: 1.5, reason: 'Valid' },
        { reviewer: null, reason: 'Valid' },
        { reviewer: '', reason: 'Valid' },
        { reviewer: '   ', reason: 'Valid' },
      ],
    ],
    [
      'startFinancing',
      financingCommands.startFinancing,
      financing.start,
      [
        applicant,
        { ...applicant, applicant_phone: '  +1 202 555 0100 ' },
        { ...applicant, applicant_phone: '' },
        { ...applicant, applicant_phone: '   ' },
        { ...applicant, applicant_phone: null },
        { ...applicant, applicant_phone: 'x'.repeat(41) },
        { ...applicant, applicant_phone: '12-34' },
        { ...applicant, applicant_name: undefined },
        { ...applicant, applicant_name: '   ' },
        { ...applicant, applicant_name: 'x'.repeat(121) },
        { ...applicant, applicant_name: 'Mara\u0000' },
        { ...applicant, applicant_name: 42 },
        { ...applicant, applicant_email: 'not-mail' },
        { ...applicant, applicant_email: '  mara@example.test ' },
        // The form asks for no dealer code, so naming one is a stray key; so is a later step's field.
        { ...applicant, dealer_code: 'NORTH' },
        { ...applicant, vehicle_stock: 'DEMO-1' },
        { ...applicant, extra: 'private' },
        null,
        [],
      ],
    ],
    [
      'saveFinancingAddress',
      financingCommands.saveFinancingAddress,
      financing.address,
      [
        address,
        { ...address, state: ' NY ' },
        { ...address, state: 'New York' },
        { ...address, state: 'n1' },
        { ...address, postal_code: '0410' },
        { ...address, postal_code: '04101-1234' },
        { ...address, postal_code: 4101 },
        { ...address, city: 'x'.repeat(61) },
        { ...address, address_line: '' },
        { ...address, address_line: 'Line\tbreak' },
        { ...address, city: undefined },
        { ...address, extra: 1 },
        {},
        null,
      ],
    ],
    [
      'saveFinancingIncome',
      financingCommands.saveFinancingIncome,
      financing.income,
      [
        income,
        { ...income, annual_income: 0 },
        { ...income, annual_income: 0.996 },
        { ...income, annual_income: 10_000_001 },
        { ...income, annual_income: '64000' },
        { ...income, annual_income: Number.NaN },
        { ...income, employer: '   ' },
        { ...income, employer: 'x'.repeat(121) },
        { employer: 'Alder Marine' },
        { ...income, extra: 1 },
        null,
      ],
    ],
    [
      'saveFinancingLoan',
      financingCommands.saveFinancingLoan,
      financing.loan,
      [
        loan,
        { ...loan, vehicle_stock: 'no rth' },
        { ...loan, vehicle_stock: '-north' },
        { ...loan, vehicle_stock: 'x'.repeat(41) },
        { ...loan, requested_amount: 0 },
        { ...loan, requested_amount: '21000' },
        { ...loan, requested_amount: 10_000_001 },
        { ...loan, down_payment: -1 },
        { ...loan, down_payment: 0 },
        // Declared `below` the amount financed, so the same figure is refused.
        { ...loan, down_payment: 21000.005 },
        { ...loan, term_months: 36 },
        { ...loan, term_months: 60 },
        { ...loan, term_months: 50 },
        { ...loan, term_months: 48.5 },
        { ...loan, term_months: '48' },
        { ...loan, term_months: undefined },
        { ...loan, applicant_name: 'Mara Alder' },
        { ...loan, extra: 'private' },
        null,
        [],
      ],
    ],
    [
      'saveFinancingCoApplicants',
      financingCommands.saveFinancingCoApplicants,
      financing.coApplicants,
      [
        { co_applicants: [] },
        {},
        { co_applicants: null },
        { co_applicants: [coApplicant] },
        { co_applicants: [coApplicant, { co_name: ' Ada Alder ', co_email: ' ada@example.test ' }] },
        { co_applicants: [coApplicant, coApplicant, coApplicant] },
        { co_applicants: coApplicant },
        { co_applicants: [{ co_name: 'Jon Alder' }] },
        { co_applicants: [{ ...coApplicant, co_email: 'jon' }] },
        { co_applicants: [{ ...coApplicant, extra: 1 }] },
        { co_applicants: [[]] },
        { co_applicants: [], extra: 1 },
        null,
      ],
    ],
    [
      'applyForFinancing',
      financingCommands.applyForFinancing,
      financing.submit,
      [
        { consent: true },
        { consent: false },
        { consent: 'yes' },
        { consent: 1 },
        {},
        { consent: null },
        { consent: true, ...loan },
        { consent: true, dealer_code: 'NORTH' },
        null,
        [],
      ],
    ],
    ['disqualifyLead', leadCommands.disqualifyLead, reference.reason, reasons],
    ['withdrawApplication', leadCommands.withdrawApplication, reference.reason, reasons],
    ...(['qualifyLead', 'convertLead'] as const).map(
      (id) =>
        [id, leadCommands[id], reference.noInput, [{}, { reason: 'x' }, null, [], 'x']] as [
          string,
          AnyBusinessCommand,
          (value: unknown) => unknown,
          unknown[],
        ],
    ),
    // The clock's deadline travels with its job, and is read as a form's date is.
    [
      'flagOverdueReview',
      flagOverdueReview,
      reference.reviewDue,
      [
        { due_on: '2026-09-01' },
        { due_on: ' 2026-09-01' },
        { due_on: '2026-02-30' },
        { due_on: '2026-9-1' },
        { due_on: 20260901 },
        { due_on: '' },
        {},
        { due_on: '2026-09-01', extra: 1 },
        null,
        [],
      ],
    ],
  ];
  for (const [id, command, before, corpus] of corpora) {
    for (const value of corpus) {
      assert.deepEqual(
        outcome(() => derived(command, id)(value)),
        outcome(() => before(value)),
        `${id}: ${JSON.stringify(value)}`,
      );
    }
  }
});

/* ---------- the declaration's own rules, read the same in the browser and on the server ---------- */

const rules = {
  email: { type: 'text', format: 'email', max: 254 },
  site: { type: 'text', format: 'url', optional: true },
  phone: { type: 'text', format: 'phone', optional: true },
  code: { type: 'text', case: 'upper', pattern: '[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?', message: 'Letters, digits and hyphens.' },
  nickname: { type: 'text', min: 2, max: 8, case: 'lower', optional: true },
  amount: { type: 'number', min: 1, step: 0.01 },
  deposit: { type: 'number', min: 0, step: 0.01, below: 'amount' },
  opens: { type: 'date' },
  closes: { type: 'date', above: 'opens', optional: true },
} as const;

test('formats, patterns, case, lengths, steps and a field below or above its sibling: one reading, browser and server', () => {
  // The browser reads the list the App serves (JSON); the server reads the registration's. They must agree on every value.
  const served = parseCommandInput(JSON.parse(JSON.stringify(rules)), 'served');
  const registered = defineCommand({
    targets: 'none',
    source: 'main',
    target: 't',
    input: rules,
    output: { parse: (value: unknown) => value },
    handle: (): unknown => ({}),
  });
  assert.deepEqual(registered.fields, served);
  const server = (value: unknown) =>
    parseRegisteredInput(
      registered,
      value,
      { actor: { id: 'a', appId: 'x', roles: [] }, commandId: 'c', version: 1 },
      { publicForm: false },
    );
  const browser = (value: unknown) => readCommandInput(served, value);
  const reading = (read: (value: unknown) => unknown, value: unknown) => {
    try {
      return { value: read(value) };
    } catch (error) {
      assert.ok(error instanceof CommandInputRefusal);
      return { path: error.path, reason: error.reason };
    }
  };
  const base = { email: 'ada@example.test', code: ' north-1 ', amount: 1000.005, deposit: 100.004, opens: '2026-05-01' };
  const cases: Array<[Record<string, unknown>, Record<string, unknown>]> = [
    [base, { value: { email: 'ada@example.test', code: 'NORTH-1', amount: 1000.01, deposit: 100, opens: '2026-05-01' } }],
    [
      { ...base, email: 'not-mail' },
      { path: 'email', reason: 'format' },
    ],
    [
      { ...base, site: 'ftp://example.test' },
      { path: 'site', reason: 'format' },
    ],
    [
      { ...base, site: 'https://example.test/a' },
      { value: { ...base, code: 'NORTH-1', amount: 1000.01, deposit: 100, site: 'https://example.test/a' } },
    ],
    [
      { ...base, phone: '12-34' },
      { path: 'phone', reason: 'format' },
    ],
    [
      { ...base, phone: '+1 (202) 555-0100' },
      { value: { ...base, code: 'NORTH-1', amount: 1000.01, deposit: 100, phone: '+1 (202) 555-0100' } },
    ],
    [
      { ...base, code: '-north' },
      { path: 'code', reason: 'pattern' },
    ],
    [
      { ...base, nickname: 'A' },
      { path: 'nickname', reason: 'too_short' },
    ],
    [{ ...base, nickname: 'ADA' }, { value: { ...base, code: 'NORTH-1', amount: 1000.01, deposit: 100, nickname: 'ada' } }],
    [
      { ...base, nickname: 'Augusta Ada' },
      { path: 'nickname', reason: 'too_long' },
    ],
    [
      { ...base, amount: 0.004 },
      { path: 'amount', reason: 'below_min' },
    ],
    [
      { ...base, deposit: 1000.005 },
      { path: 'deposit', reason: 'not_below' },
    ],
    [
      { ...base, closes: '2026-05-01' },
      { path: 'closes', reason: 'not_above' },
    ],
    [{ ...base, closes: '2026-05-02' }, { value: { ...base, code: 'NORTH-1', amount: 1000.01, deposit: 100, closes: '2026-05-02' } }],
  ];
  for (const [value, expected] of cases) {
    assert.deepEqual(reading(server, value), expected, JSON.stringify(value));
    assert.deepEqual(reading(browser, value), expected, JSON.stringify(value));
  }
  // Every problem at once, as a form marks them: a below rule is judged only when both values were given.
  assert.deepEqual(
    commandInputProblems(served, { email: 'x', code: '-', amount: 5, deposit: 9, opens: '2026-05-01', closes: '2026-04-01' }).map(
      (problem) => `${problem.path}:${problem.reason}`,
    ),
    ['email:format', 'code:pattern', 'deposit:not_below', 'closes:not_above'],
  );
});

test('validate may be a Standard Schema: its value is the input, and its first issue refuses by path', () => {
  const schema = (validate: (value: unknown) => unknown) => ({ '~standard': { version: 1 as const, vendor: 'test', validate } }) as never;
  const command = (validate: unknown) =>
    defineCommand({
      targets: 'none',
      source: 'main',
      target: 't',
      input: { code: { type: 'text' } },
      validate: validate as never,
      output: { parse: (value: unknown) => value },
      handle: (): unknown => ({}),
    });
  const read = (target: AnyBusinessCommand, value: unknown) =>
    parseRegisteredInput(target, value, { actor: { id: 'a', appId: 'x', roles: [] }, commandId: 'c', version: 1 }, { publicForm: false });
  const upper = command(schema((value) => ({ value: { code: String((value as { code: string }).code).toUpperCase() } })));
  assert.deepEqual(read(upper, { code: 'abc' }), { code: 'ABC' });
  const refusing = command(schema(() => ({ issues: [{ message: 'Private detail', path: [{ key: 'code' }] }] })));
  assert.throws(
    () => read(refusing, { code: 'abc' }),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === 'code' && !/Private/.test(error.message),
  );
  const pathless = command(schema(() => ({ issues: [{ message: 'x', path: ['no such path', 'a', 'b', 'c'] }] })));
  assert.throws(
    () => read(pathless, { code: 'abc' }),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === '',
  );
  const later = command(schema(() => Promise.resolve({ value: {} })));
  assert.throws(() => read(later, { code: 'abc' }), /synchronously/);
  assert.throws(() => command({ '~standard': { version: 2, vendor: 'test', validate: () => ({}) } }), /function or a Standard Schema/);
});

/* ---------- prepare's initial, a public form's caps and its audit, over HTTP ---------- */

const editInput = {
  terms: {
    label: 'Terms',
    type: 'group',
    fields: {
      amount: { label: 'Amount', type: 'number', min: 1 },
      due: { label: 'Due', type: 'date' },
    },
  },
  borrower: {
    label: 'Borrower',
    type: 'group',
    fields: {
      name: { label: 'Name', type: 'text', max: 40 },
      email: { label: 'Email', type: 'text', max: 80, optional: true },
    },
  },
} as const;
const applyInput = {
  name: { label: 'Name', type: 'text', max: 60 },
  trade_ins: {
    label: 'Trade-ins',
    type: 'group',
    repeat: { max: 3 },
    fields: {
      stock: { label: 'Stock', type: 'text', max: 20 },
      note: { label: 'Note', type: 'textarea', max: 16000, optional: true },
    },
  },
} as const;

const manager: Identity = { id: 'account-manager', who: 'manager@example.test', role: 'manager' };
const viewer: Identity = { id: 'account-viewer', who: 'viewer@example.test', role: 'viewer' };

interface Fixture {
  base: string;
  db: DatabaseSync;
  registry: Registry;
  app: ReturnType<typeof parseAppConfig>;
  control: { current: Identity; initials: number; reach: boolean; malformed: boolean };
}

async function fixture(run: (f: Fixture) => Promise<void>) {
  resetPublicFormLimits();
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-command-inputs-'));
  const file = join(directory, 'inputs.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE loan(id INTEGER PRIMARY KEY, version INTEGER NOT NULL DEFAULT 0, amount REAL NOT NULL, due TEXT NOT NULL);
    CREATE TABLE borrower(id INTEGER PRIMARY KEY, loan_id INTEGER NOT NULL UNIQUE, name TEXT NOT NULL, email TEXT);
    CREATE TABLE hidden(id INTEGER PRIMARY KEY, secret TEXT NOT NULL);
    CREATE TABLE application(id INTEGER PRIMARY KEY, name TEXT NOT NULL, reference TEXT NOT NULL UNIQUE);
    CREATE TABLE trade_in(id INTEGER PRIMARY KEY, application_id INTEGER NOT NULL, stock TEXT NOT NULL, note TEXT);
    INSERT INTO loan VALUES (1, 0, 20000, '2026-10-01'); INSERT INTO borrower VALUES (1, 1, 'Ada', 'ada@example.test');
    INSERT INTO hidden VALUES (1, 'TOP-SECRET-VALUE');`);
  migrateSqliteCommandJournal(file);
  const registry = new Registry();
  registry.add({ id: 'private-db', name: 'Private', url: file, writable: true, source: 'config' });
  const app = parseTestApp(
    {
      id: 'inputs',
      name: 'Inputs',
      sources: { main: { connection: 'private-db' } },
      resources: {
        loan: {
          access: 'write',
          actions: { edit: { label: 'Edit', command: { id: 'edit', version: 1, target: 'loan', input: editInput } } },
        },
        borrower: { access: 'write' },
        hidden: {},
        application: { access: 'write' },
        trade_in: { access: 'write' },
      },
      auth: { roles: { manager: { read: true, commands: ['edit'] }, viewer: { read: true } } },
      views: {
        loans: { kind: 'list', from: 'loan' },
        apply: { kind: 'form', label: 'Apply', public: true, command: { id: 'apply', version: 1, input: applyInput } },
      },
      home: 'loans',
      nav: ['loans'],
    },
    'command inputs fixture',
  );
  const control = { current: manager, initials: 0, reach: false, malformed: false };
  const commands = defineCommands({
    edit: defineCommand({
      source: 'main',
      target: 'loan',
      write: ['borrower'],
      input: editInput,
      output: { parse: (value: unknown) => value as { version: number } },
      async initial({ db, record: loan, tx }) {
        control.initials++;
        // Outside the footprint: the read facade refuses it, and prepare with it.
        if (control.reach) await tx.query({ table: 'hidden', columns: ['secret'], limit: 1, offset: 0 });
        const borrower = await db.borrower.find({ loan_id: loan.id });
        if (control.malformed) return { terms: { amount: 'twenty thousand' as unknown as number } };
        return {
          terms: { amount: Number(loan.amount), due: String(loan.due) },
          borrower: { name: String(borrower?.name), email: String(borrower?.email) },
        };
      },
      async handle({ db, record: loan }, input) {
        // The platform read the loan at the revision the form saw; each guard names exactly the columns written.
        const { version } = await db.loan.update(loan, { amount: input.terms.amount, due: input.terms.due });
        const borrower = await db.borrower.find({ loan_id: loan.id });
        if (borrower) await db.borrower.update(borrower, { name: input.borrower.name, email: input.borrower.email ?? null });
        return { version: Number(version) };
      },
    }),
    apply: defineCommand({
      targets: 'none',
      source: 'main',
      target: 'application',
      read: ['application', 'trade_in'],
      write: ['application', 'trade_in'],
      public: true,
      input: applyInput,
      output: shape({ reference: text() }),
      async handle(context, input) {
        const reference = `APP-${Date.now().toString(36)}`;
        const created = await context.tx.insert({ table: 'application', values: { name: input.name, reference } });
        for (const row of input.trade_ins) {
          await context.tx.insert({
            table: 'trade_in',
            values: { application_id: created.key.id as number, stock: row.stock, note: row.note ?? null },
          });
        }
        return { reference };
      },
    }),
  });
  const host: AppHost = {
    app: { app, path: '/private/app.ts', pages: [], sources: {} },
    pages: [],
    auth: {
      spec: app.auth!,
      store: '/private/auth.db',
      close() {},
      handler: async () => {},
      session: async () => control.current,
    },
  };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], commands: { appId: 'inputs', registry: commands } });
  try {
    server.listen(0, bound.host);
    await once(server, 'listening');
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    bound.port = address.port;
    await run({ base: `http://${bound.host}:${bound.port}`, db, registry, app, control });
  } finally {
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    server.closeAllConnections();
    await closed;
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
    resetPublicFormLimits();
  }
}

async function post(f: Fixture, path: string, body: unknown) {
  const response = await fetch(`${f.base}${path}`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3_000),
    headers: { 'content-type': 'application/json', origin: f.base, 'x-mistri-account': f.control.current.id },
  });
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}
const prepare = (f: Fixture) => post(f, '/api/commands/prepare', { command: 'edit', commandVersion: 1, key: { id: 1 } });
const execute = (f: Fixture, expectedVersion: number, input: unknown, idempotencyKey = 'edit-request-000001') =>
  post(f, '/api/commands/execute', { command: 'edit', commandVersion: 1, key: { id: 1 }, expectedVersion, idempotencyKey, input });
const loan = (f: Fixture) => ({ ...f.db.prepare('SELECT version, amount, due FROM loan WHERE id = 1').get() });
const borrower = (f: Fixture) => ({ ...f.db.prepare('SELECT name, email FROM borrower WHERE loan_id = 1').get() });

test(
  'prepare serves initial with the revision it was read at; a principal without the grant gets forbidden and nothing else',
  { timeout: 10_000 },
  async () => {
    await fixture(async (f) => {
      const prepared = await prepare(f);
      assert.equal(prepared.status, 200, prepared.text);
      assert.deepEqual(prepared.body, {
        expectedVersion: 0,
        initial: { terms: { amount: 20000, due: '2026-10-01' }, borrower: { name: 'Ada', email: 'ada@example.test' } },
      });
      assert.equal(f.control.initials, 1);
      f.control.current = viewer;
      const refused = await prepare(f);
      assert.equal(refused.status, 403);
      assert.equal(refused.body.code, 'forbidden');
      assert.doesNotMatch(refused.text, /Ada|20000|initial/);
      assert.equal(f.control.initials, 1, 'initial never ran for a principal without the grant');
    });
  },
);

test('initial reads only within the footprint, and serves only what the declaration can hold', { timeout: 10_000 }, async () => {
  await fixture(async (f) => {
    f.control.reach = true;
    const outside = await prepare(f);
    assert.equal(outside.status, 403, outside.text);
    assert.doesNotMatch(outside.text, /TOP-SECRET|Ada|initial/);
    f.control.reach = false;
    f.control.malformed = true;
    const malformed = await prepare(f);
    assert.equal(malformed.status, 503);
    assert.equal(malformed.body.code, 'invalid_result');
    assert.doesNotMatch(malformed.text, /twenty/);
  });
});

test('a prefilled form that meets a newer revision is refused as stale; prepared again, it submits', { timeout: 10_000 }, async () => {
  await fixture(async (f) => {
    const first = (await prepare(f)).body as { expectedVersion: number; initial: { terms: object; borrower: object } };
    const edited = { ...first.initial, borrower: { ...first.initial.borrower, name: 'Ada King' } };
    // Someone else changes the loan after the form opened.
    f.db.exec(`UPDATE loan SET version = 1, amount = 21000 WHERE id = 1`);
    const stale = await execute(f, first.expectedVersion, edited);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.code, 'stale_record');
    assert.deepEqual(borrower(f), { name: 'Ada', email: 'ada@example.test' }, 'nothing of the stale form was written');
    const again = (await prepare(f)).body as { expectedVersion: number; initial: { terms: { amount: number }; borrower: object } };
    assert.equal(again.expectedVersion, 1);
    assert.equal(again.initial.terms.amount, 21000, 'the second prefill is the newer revision');
    const applied = await execute(f, again.expectedVersion, { ...again.initial, borrower: { name: '  Ada King ' } }, 'edit-request-000002');
    assert.equal(applied.status, 200, applied.text);
    assert.deepEqual(loan(f), { version: 2, amount: 21000, due: '2026-10-01' });
    assert.deepEqual(borrower(f), { name: 'Ada King', email: null });
  });
});

test('a nested refusal over HTTP names its path and echoes nothing', { timeout: 10_000 }, async () => {
  await fixture(async (f) => {
    const cases: Array<[unknown, string]> = [
      [{ terms: { amount: 1, due: '2026-10-01' }, borrower: { email: 'x@example.test' } }, 'borrower.name'],
      [{ terms: { amount: 1, due: '2026-13-01' }, borrower: { name: 'Ada' } }, 'terms.due'],
      [{ terms: { amount: 0, due: '2026-10-01' }, borrower: { name: 'Ada' } }, 'terms.amount'],
    ];
    for (const [input, path] of cases) {
      const refused = await execute(f, 0, input);
      assert.equal(refused.status, 400, refused.text);
      assert.equal(refused.body.code, 'invalid_input');
      assert.equal(refused.body.field, path);
      assert.doesNotMatch(refused.text, /2026-13-01|x@example/);
    }
    assert.deepEqual(loan(f), { version: 0, amount: 20000, due: '2026-10-01' });
  });
});

test(
  "a public form: rows beyond the repeat cap and input beyond 32 KiB are refused; the audit keeps no row's values",
  { timeout: 10_000 },
  async () => {
    await fixture(async (f) => {
      const submit = (input: unknown, n: number) =>
        post(f, '/api/forms/apply', { input, submission: `public-submission-${String(n).padStart(6, '0')}` });
      const tooMany = await submit({ name: 'Mara', trade_ins: Array.from({ length: 4 }, (_, i) => ({ stock: `S-${i}` })) }, 1);
      assert.equal(tooMany.status, 400, tooMany.text);
      assert.equal(tooMany.body.field, 'trade_ins');
      // Each note is within its 16000 characters and the rows within their three; together they are past the public bound.
      const large = await submit({ name: 'Mara', trade_ins: [1, 2, 3].map((n) => ({ stock: `S-${n}`, note: 'n'.repeat(11_000) })) }, 2);
      assert.equal(large.status, 400, large.text);
      assert.equal(large.body.code, 'invalid_input');
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM application').get()!.n, 0);
      const applied = await submit(
        { name: 'PRIVATE-NAME', trade_ins: [{ stock: 'PRIVATE-STOCK-1', note: 'PRIVATE-NOTE' }, { stock: 'PRIVATE-STOCK-2' }] },
        3,
      );
      assert.equal(applied.status, 200, applied.text);
      assert.equal(f.db.prepare('SELECT count(*) AS n FROM trade_in').get()!.n, 2);
      const audit = f.db
        .prepare(`SELECT changes_json FROM ${sqliteAuditRows} a`)
        .all()
        .map((row) => String(row.changes_json))
        .join('\n');
      assert.match(audit, /\[redacted\]/);
      assert.match(audit, /trade_in/);
      assert.doesNotMatch(audit, /PRIVATE/, 'no value of any row the public command wrote reaches the audit');
    });
  },
);

test("startup holds the App to the registration: one input, and no initial on a form's command", { timeout: 10_000 }, async () => {
  await fixture(async (f) => {
    const leases: Array<() => void> = [];
    const resources = await loadAppRuntimeResources(f.registry, f.app, 'private-db', (owner) => leases.push(f.registry.lease(owner)));
    try {
      const edit = defineCommand({
        source: 'main',
        target: 'loan',
        write: ['borrower'],
        input: editInput,
        output: { parse: (value: unknown) => value },
        handle: (): unknown => ({}),
        initial: () => ({}),
      });
      const apply = defineCommand({
        targets: 'none',
        source: 'main',
        target: 'application',
        read: ['application'],
        write: ['application'],
        public: true,
        input: applyInput,
        output: shape({ reference: text() }),
        handle: () => ({ reference: 'R-1' }),
      });
      assert.doesNotThrow(() => validateBusinessCommandReferences(f.app, defineCommands({ edit, apply }), resources));
      // The authored form is checked while its command name resolves.
      assert.throws(
        () =>
          withCommandCatalog(appCommandCatalog(defineCommands({ edit, apply }), f.app), () =>
            parseFormCommandReference('edit', 'form', false),
          ),
        /acts on an existing record/,
      );
      // `initial` prefills a signed-in form over one record or none; a public form's and a selection's prepare none.
      for (const where of [{ targets: 'none' as const, public: true as const }, { targets: 'many' as const }])
        assert.throws(
          () =>
            defineCommand({
              ...where,
              source: 'main',
              target: 'application',
              input: applyInput,
              output: { parse: (value: unknown) => value },
              handle: (): unknown => ({}),
              initial: () => ({}),
            } as never),
          /a selection's command and a public form's prepare none/,
        );
    } finally {
      for (const release of leases) release();
    }
  });
});

test('a box that must be checked: accepted only checked, in the browser and on the server alike; a plain yes-or-no takes either', () => {
  const [agree, news] = parseCommandInput(
    { agree: fieldHelpers.bool({ label: 'I have read the rules', accept: true }), news: fieldHelpers.bool() },
    'join',
  );
  assert.deepEqual(agree, { name: 'agree', label: 'I have read the rules', required: true, type: 'boolean', accept: true });
  assert.equal('accept' in news, false);
  assert.deepEqual(readCommandInput([agree, news], { agree: true, news: false }), { agree: true, news: false });
  assert.throws(
    () => readCommandInput([agree, news], { agree: false, news: true }),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === 'agree' && error.reason === 'required',
  );
  assert.deepEqual(commandInputProblems([agree, news], { agree: false, news: false }), [{ path: 'agree', reason: 'required' }]);
  // Starting values may leave it unchecked: nothing is required of a prefill.
  assert.deepEqual(readCommandInput([agree], { agree: false }, { partial: true }), { agree: false });
  assert.throws(() => parseCommandInput({ agree: { type: 'boolean', accept: false } }, 'join'), /accept must be true/);
  assert.throws(() => parseCommandInput({ agree: { type: 'boolean', accept: true, optional: true } }, 'join'), /cannot also be optional/);
  assert.throws(() => parseCommandInput({ name: { type: 'text', accept: true } }, 'join'), /accept/);
});

test('a statement stands beside a checkbox that must be checked or may be left; a yes or a no as buttons has none', () => {
  const words = 'I consent to customer care text messages at the number above. Reply STOP to end them.';
  const [texts, terms] = parseCommandInput(
    {
      texts: fieldHelpers.bool({ label: 'Text messages', optional: true, statement: words }),
      terms: fieldHelpers.bool({ label: 'Terms', accept: true, statement: words }),
    },
    'join',
  );
  assert.deepEqual(texts, { name: 'texts', label: 'Text messages', type: 'boolean', statement: words });
  assert.equal(terms.type === 'boolean' && terms.statement, words);
  // Left, the optional box is an answer; the one that must be checked is still refused unchecked.
  assert.deepEqual(readCommandInput([texts, terms], { texts: false, terms: true }), { texts: false, terms: true });
  assert.deepEqual(commandInputProblems([texts, terms], { texts: false, terms: false }), [{ path: 'terms', reason: 'required' }]);
  assert.throws(
    () => parseCommandInput({ texts: { type: 'boolean', as: 'buttons', statement: words } }, 'join'),
    /statement is the words a checkbox stands beside/,
  );
});
