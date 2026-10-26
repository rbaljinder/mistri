import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { typecheck } from './support/tsc.js';
import { action } from '@mistriwork/mistri/app';
import { parseAppConfig, resolveResources, resolveViews } from '../packages/mistri/src/shared/app.js';
import { commandReferenceProblem, parseCommandReference, withCommandCatalog } from '../packages/mistri/src/shared/command.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { catalogOf } from './support/commandCatalog.js';

const input = {
  reviewer: { label: 'Reviewer', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name' },
  reason: { label: 'Reason', type: 'textarea', max: 500 },
} as const;
/* What loading the App reads from its commands module: each command's contract, by name. */
const commands = catalogOf({
  assignReviewer: { target: 'loan', input, when: 'version = 0' },
  closeLoans: { target: 'loan', targets: 'many' },
  logCall: {},
});
const table = (id: string): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true, nullable: false },
    { name: 'name', type: 'TEXT', primaryKey: false, nullable: false },
    { name: 'version', type: 'INTEGER', primaryKey: false, nullable: false },
  ],
});
const schema = { tables: [table('loan'), table('reviewer'), table('other')], foreignKeys: [] } as unknown as DatabaseSchema;
const app = (actions: unknown, resource = 'loan') =>
  parseAppConfig(
    {
      name: 'Loans',
      resources: { [resource]: { actions: Object.fromEntries((actions as unknown[]).map((action, index) => [`action${index}`, action])) } },
      views: { loans: { kind: 'list', from: resource } },
      home: 'loans',
      nav: ['loans'],
    },
    'app.ts',
    { commands },
  );

test("a command action names its command, and is served the registration's input and target", () => {
  const actions = [action('Assign reviewer', { command: 'assignReviewer' }), action('Rename', { set: { name: 'Example' } })];
  const parsed = app(actions);
  const { resources, problems } = resolveResources(parsed, schema);
  assert.deepEqual(problems, []);
  assert.equal(resolveViews(parsed, schema).loans.error, undefined);
  // Served, the input is the registration's list: named, labelled, required unless optional.
  assert.deepEqual(resources.loan.actions, [
    {
      id: 'action0',
      label: 'Assign reviewer',
      when: 'version = 0',
      command: {
        id: 'assignReviewer',
        version: 1,
        target: 'loan',
        input: [
          {
            name: 'reviewer',
            label: 'Reviewer',
            required: true,
            type: 'reference',
            from: 'reviewer',
            by: 'id',
            labelColumn: 'name',
          },
          { name: 'reason', label: 'Reason', required: true, type: 'textarea', maxLength: 500 },
        ],
      },
    },
    { id: 'action1', ...actions[1] },
  ]);
  // The App's literal is the name alone: nothing of the command lives in the App.
  assert.deepEqual(JSON.parse(JSON.stringify(actions[0])), { label: 'Assign reviewer', command: 'assignReviewer' });
});

test("a command action refuses a name the module does not register, an object, a form's command and a lone record in bulk", () => {
  assert.throws(() => app([{ label: 'Assign', command: 'asignReviewer' }]), /does not register.*Did you mean "assignReviewer"/);
  assert.throws(() => app([{ label: 'Assign', command: { id: 'assignReviewer', version: 1, target: 'loan', input: {} } }]), /by name/);
  assert.throws(() => app([{ label: 'Log', command: 'logCall' }]), /form's command/);
  assert.throws(() => app([{ label: 'Assign', command: 'assignReviewer', bulk: true }]), /targets: 'many'/);
  assert.doesNotThrow(() => app([{ label: 'Close', command: 'closeLoans', bulk: true }]));
  assert.throws(() => app([{ label: 'Assign', command: 'assignReviewer', set: {} }]), /cannot combine a command with set/);
  // A command with inputs asks them in its form, which is the confirmation; one that asks nothing may confirm.
  assert.throws(() => app([{ label: 'Assign', command: 'assignReviewer', confirm: true }]), /asks for input in its form/);
  assert.throws(() => app([{ label: 'Close', command: 'closeLoans', confirm: 'yes' }]), /not true or false/);
  assert.doesNotThrow(() => app([{ label: 'Close', command: 'closeLoans', confirm: true }]));
  // With no commands module loaded, a name is refused, naming how to give one.
  assert.throws(
    () =>
      parseAppConfig(
        {
          name: 'Loans',
          resources: { loan: { actions: { assign: { label: 'Assign', command: 'assignReviewer' } } } },
          views: { loans: { kind: 'list', from: 'loan' } },
          home: 'loans',
        },
        'app.ts',
      ),
    /no commands module is loaded.*--commands/,
  );
});

test('command inputs reject malformed identities, bounds, sparse inputs and duplicate fields', () => {
  const parse = (raw: unknown) => parseCommandInput(raw, 'Command input');
  for (const raw of [
    [],
    Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`a${i}`, { type: 'text' }])),
    { 'two words': input.reviewer },
    { constructor: input.reviewer },
  ]) {
    assert.throws(() => parse(raw));
  }
  const badFields = [
    { type: 'unknown' },
    { type: 'text', min: 0 },
    { type: 'text', max: 16385 },
    { type: 'text', maxLength: 20 },
    { type: 'text', required: true },
    { type: 'text', optional: 'yes' },
    { type: 'number', min: Infinity },
    { type: 'number', min: 3, max: 2 },
    { type: 'boolean', max: 20 },
    { type: 'reference', from: 'reviewer', by: 'id' },
    { type: 'textarea', format: 'email' },
    { type: 'text', pattern: '(' },
    { type: 'text', message: 'Without a rule.' },
    { type: 'number', step: 0 },
    { type: 'number', integer: true, step: 0.5 },
    { type: 'number', below: 'field' },
    { type: 'number', below: 'missing' },
    { type: 'group', optional: true, fields: { a: { type: 'text' } } },
  ];
  for (const field of badFields) assert.throws(() => parse({ field: { label: 'Field', ...field } }));
  // A field below or above another names a sibling of its own kind.
  assert.throws(
    () => parse({ when: { type: 'date' }, amount: { type: 'number', below: 'when' } }),
    /which must be another number field beside it/,
  );
});

test('command inputs refuse getters without invoking them', () => {
  let touched = false;
  const getter = {
    enumerable: true,
    get() {
      touched = true;
      return 'private';
    },
  };
  assert.throws(() => parseCommandInput(Object.defineProperty({}, 'reviewer', getter), 'Command input'), /data fields/);
  assert.equal(touched, false);
});

test('input metadata preserves bounded scalar controls without inventing validator behavior', () => {
  const scalars = {
    note: { label: 'Note', type: 'text', max: 80, help: 'Optional note', optional: true },
    count: { label: 'Count', type: 'number', min: 0, max: 10, integer: true },
    confirmed: { label: 'Confirmed', type: 'boolean', optional: true },
  };
  // Parsed into the list the form and the server read: named, labelled, required unless optional.
  assert.deepEqual(parseCommandInput(scalars, 'Command input'), [
    { name: 'note', label: 'Note', type: 'text', maxLength: 80, help: 'Optional note' },
    { name: 'count', label: 'Count', required: true, type: 'number', min: 0, max: 10, integer: true },
    { name: 'confirmed', label: 'Confirmed', type: 'boolean' },
  ]);
  assert.deepEqual(parseCommandInput({}, 'Command input'), []);
});

test('command target, reference keys and queries resolve against the catalog', () => {
  const resolve = (contracts: Parameters<typeof catalogOf>[0]) =>
    withCommandCatalog(catalogOf(contracts), () => parseCommandReference('assign', 'action'));
  assert.equal(commandReferenceProblem(resolve({ assign: { target: 'loan', input } }), 'loan', schema), undefined);
  const { reviewer } = input;
  for (const contract of [
    { target: 'other', input },
    { target: 'missing', input },
    { target: 'loan', input: { reviewer: { ...reviewer, labelColumn: 'missing' } } },
    { target: 'loan', input: { reviewer: { ...reviewer, by: 'name' } } },
    { target: 'loan', input: { reviewer: { ...reviewer, query: 'missing = 1' } } },
  ]) {
    assert.ok(commandReferenceProblem(resolve({ assign: contract }), 'loan', schema));
  }
  const secondary = { ...schema, tables: [...schema.tables, table('inventory.loan')] };
  assert.equal(commandReferenceProblem(resolve({ assign: { target: 'inventory.loan', input } }), 'inventory.loan', secondary), undefined);
  const view = structuredClone(schema);
  view.tables[0].isView = true;
  assert.match(commandReferenceProblem(resolve({ assign: { target: 'loan', input } }), 'loan', view)!, /table with a primary key/);
});

test('schema names commands, and keeps command and update actions exclusive', () => {
  const json = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
  assert.equal(json.$defs.commandName.type, 'string');
  assert.equal(json.$defs.commandReference, undefined);
  assert.equal(json.$defs.actions.additionalProperties.oneOf.length, 2);
});

test("typed command names: an unknown name, a record's command on another table and a form over a record's command fail the typecheck", () => {
  const filename = new URL('./.app-command-actions-types.ts', import.meta.url).pathname;
  /* What mistri-commands.d.ts says, for a module that registers these three. */
  const source = `import { action, commandForm, defineApp, step, type TypedAppConfig, listView } from '@mistriwork/mistri/app';
    declare module '@mistriwork/mistri/app' {
      interface Register { commands: {
        assign: { target: 'loan'; targets: 'one'; input: 'reviewer' | 'reason' };
        closeLoans: { target: 'loan'; targets: 'many'; input: never };
        logCall: { target: 'call'; targets: 'none'; input: 'account' | 'notes' };
      } }
    }
    type App = TypedAppConfig<{ loan: 'id'|'version'; other: 'id'|'version'; call: 'id' }>;
    const valid: App = {name:'Loans', views:{loans:listView('Loan', 'loan')}, home:'loans', resources:{loan:{actions:{assign:action('Assign', {command:'assign'})}}}};
    // @ts-expect-error A command for loan cannot be placed on other.
    const bad: App = {name:'Loans', views:{loans:listView('Loan', 'loan')}, home:'loans', resources:{other:{actions:{assign:action('Assign', {command:'assign'})}}}};
    // @ts-expect-error A misspelled command name.
    action('Assign', {command:'asign'});
    // @ts-expect-error Cannot combine command execution and fixed CRUD.
    action('Invalid', {command:'assign', set:{version:1}});
    // @ts-expect-error A command on one record is not offered in bulk.
    action('Assign', {command:'assign', bulk:true});
    action('Close', {command:'closeLoans', bulk:true});
    const form = commandForm('Log a call', 'logCall', [step('The call', ['account', 'notes'])]);
    // @ts-expect-error A step names only the command's inputs.
    commandForm('Log a call', 'logCall', [step('The call', ['account', 'note'])]);
    // @ts-expect-error A form runs a command that names no record.
    commandForm('Assign', 'assign');
    const roles = { manager: { read: true, commands: ['assign', 'logCall'] } } as const;
    // @ts-expect-error A grant names commands the module registers.
    const wrong: App['auth'] = { providers: ['email'], roles: { manager: { read: true, commands: ['asign'] } } };
    // Fixed actions that set different columns, in one list: TypeScript reads the second as setting version?: undefined.
    const resources = { loan: { actions: { close: action('Close', { set: { id: 1, version: 2 } }), reopen: action('Reopen', { set: { id: 0 } }) } } };
    defineApp({ name: 'Loans', views: { loans: listView('Loan', 'loan') }, home: 'loans', resources });
    void valid; void bad; void form; void roles; void wrong;
  `;
  assert.equal(typecheck(filename, { files: { [filename]: source } }), '');
});
