import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BusinessCommandDefinitionError,
  defineCommand,
  defineCommands,
  parseRegisteredInput,
  type AnyBusinessCommand,
  type BusinessCommand,
  type BusinessCommandContext,
} from '../packages/mistri/src/server/commands/businessCommands.js';
import { defineSource } from '../packages/mistri/src/server/commands/commandDb.js';
import { CommandInputRefusal } from '../packages/mistri/src/shared/commandInput.js';

/* The input is a declaration — the field list the server sends the browser
   with the App — and the server's parser is derived from it. */
const input = { reviewer: { label: 'Reviewer', type: 'number', integer: true } } as const;
const context = { actor: { id: 'account-a', appId: 'lending', roles: ['manager'] }, commandId: 'assignReviewer', version: 1 };
const parse = (command: AnyBusinessCommand, value: unknown) => parseRegisteredInput(command, value, context, { publicForm: false });
const output = {
  parse(value: unknown): { assigned: boolean } {
    if (!value || typeof value !== 'object' || !('assigned' in value) || typeof value.assigned !== 'boolean')
      throw new Error('Invalid result.');
    return { assigned: value.assigned };
  },
};
const definition = () => ({
  source: 'lending',
  target: 'loan_application',
  read: ['loan_application', 'reviewer', 'assignment_history'],
  write: ['loan_application', 'assignment_history'],
  input,
  output,
  handle: (_context: BusinessCommandContext, value: { reviewer: number }) => ({ assigned: value.reviewer > 0 }),
});

test('business commands: typed registry retains validators and handlers only on the server', async () => {
  let called = false;
  const command = defineCommand({
    ...definition(),
    handle: async (_context, value) => {
      called = true;
      return { assigned: value.reviewer > 0 };
    },
  });
  const registry = defineCommands({ assignReviewer: command });
  assert.equal(called, false, 'Registration must not execute business logic');
  assert.equal(Object.getPrototypeOf(registry), null);
  assert.ok(Object.isFrozen(registry));
  assert.ok(Object.isFrozen(command));
  assert.ok(Object.isFrozen(command.read));
  assert.ok(Object.isFrozen(command.write));
  assert.equal(registry.assignReviewer, command);
  assert.ok(Object.isFrozen(command.input));
  assert.ok(Object.isFrozen(command.input.reviewer));
  assert.ok(Object.isFrozen(command.fields));
  // The declaration is kept as written; its field list, as the parser leaves it: named, labelled, required.
  assert.deepEqual(command.input, input);
  assert.deepEqual(command.fields, [{ name: 'reviewer', label: 'Reviewer', required: true, type: 'number', integer: true }]);
  assert.deepEqual(parse(command, { reviewer: 3 }), { reviewer: 3 });
  // The derived parser refuses by path and never echoes the value.
  assert.throws(
    () => parse(command, { reviewer: '3' }),
    (error: unknown) =>
      error instanceof CommandInputRefusal && error.path === 'reviewer' && error.reason === 'type' && !/3/.test(error.message),
  );
  assert.throws(
    () => parse(command, { reviewer: 3, extra: 1 }),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === '',
  );
  const result = command.output.parse({ assigned: true });
  assert.deepEqual(result, { assigned: true });
  assert.throws(() => command.output.parse({ assigned: 'true' }), /Invalid result/);
  assert.equal(called, false, 'Validation does not execute a handler');
  const _typed: BusinessCommand<{ reviewer: number }, { assigned: boolean }, typeof input> = registry.assignReviewer;
  assert.equal(_typed, command);
});

test('business commands: definitions copy mutable footprints and declarations, and capture validate', () => {
  let validated = 0;
  const value = definition();
  const fields = { reviewer: { label: 'Reviewer', type: 'number' as const, integer: true } };
  const rules = {
    ...value,
    input: fields,
    validate(parsed: unknown) {
      validated++;
      return parsed as { reviewer: number };
    },
  };
  const command = defineCommand(rules);
  value.read.push('extra_resource');
  value.write[0] = 'extra_resource';
  fields.reviewer.label = 'Replaced';
  (fields as Record<string, unknown>).extra = { type: 'number', integer: true };
  rules.validate = () => {
    throw new Error('Replaced validate');
  };
  assert.equal(validated, 0, 'registration never runs validate');
  assert.deepEqual(parse(command, { reviewer: 3 }), { reviewer: 3 });
  assert.equal(validated, 1);
  assert.deepEqual(
    command.fields.map((field) => [field.name, field.label]),
    [['reviewer', 'Reviewer']],
  );
  assert.ok(!command.read.includes('extra_resource'));
  assert.equal(command.write[0], 'loan_application');
});

for (const [name, patch] of Object.entries({
  'missing source': { source: undefined },
  'qualified source': { source: 'lending.public' },
  'URL source': { source: 'postgres://private' },
  'reserved source': { source: 'constructor' },
  'qualified target': { target: 'public.loan_application' },
  'cross-source resource': { read: ['loan_application', 'applicants.applicant'], write: ['loan_application'] },
  'read footprint that is not a list': { read: 'loan_application' },
  'duplicate resource': { write: ['loan_application', 'loan_application'] },
  'duplicate read resource': { read: ['reviewer', 'reviewer'] },
  'target qualified by another source': { target: 'applicants.loan_application' },
  'a public command that names a record': { public: true, targets: 'one' },
  'targets that is not one, many or none': { targets: 'all' },
  'when on a command that names no record': { targets: 'none', when: 'status = submitted' },
  'when that is not text': { when: 42 },
  'empty when text': { when: '  ' },
  'an id': { id: 'assign' },
  'reserved resource': { read: ['loan_application', '__proto__'] },
  'a version': { version: 1 },
  'missing handler': { handle: undefined },
  'nonfunction handler': { handle: 'doSomething' },
  'input that is a list, not fields keyed by name': { input: [] },
  'input parser instead of a declaration': { input: { parse: () => ({}) } },
  'unknown input type': { input: { reviewer: { label: 'Reviewer', type: 'script', optional: true } } },
  'input name that is not an identifier': { input: { 'two words': input.reviewer } },
  'groups nested three deep': {
    input: {
      a: {
        label: 'A',
        type: 'group',
        fields: {
          b: {
            label: 'B',
            type: 'group',
            fields: { c: { label: 'C', type: 'group', fields: { d: { label: 'D', type: 'text', optional: true } } } },
          },
        },
      },
    },
  },
  'optional group': {
    input: { a: { label: 'A', type: 'group', optional: true, fields: { d: { label: 'D', type: 'text', optional: true } } } },
  },
  'repeat past the cap': {
    input: { a: { label: 'A', type: 'group', repeat: { max: 51 }, fields: { d: { label: 'D', type: 'text', optional: true } } } },
  },
  'public repeat past the public cap': {
    public: true,
    input: { a: { label: 'A', type: 'group', repeat: { max: 11 }, fields: { d: { label: 'D', type: 'text', optional: true } } } },
  },
  'nonfunction validate': { validate: true },
  'nonfunction initial': { initial: { reviewer: 3 } },
  'initial on a public command': { public: true, initial: () => ({}) },
  'initial on a command that targets many': { targets: 'many', initial: () => ({}) },
  'nonfunction output parser': { output: { parse: true } },
  'undeclared option': { sql: 'UPDATE anything' },
})) {
  test(`business commands: refuses ${name}`, () => {
    assert.throws(() => defineCommand({ ...definition(), ...patch } as never), BusinessCommandDefinitionError);
  });
}

test("business commands: a public command may ask a reference; whether the visitor may read its table is the App's check", () => {
  // [public-form-picker] in forms/savedFormChecks.ts, where the App's auth.public is known.
  assert.doesNotThrow(() =>
    defineCommand({
      ...definition(),
      public: true,
      input: { r: { label: 'R', type: 'reference', from: 'reviewer', by: 'id', labelColumn: 'name', optional: true } },
    } as never),
  );
});

test('business commands: registry rejects unsafe shapes without invoking accessors', () => {
  const command = defineCommand(definition());
  for (const value of [
    null,
    [],
    Object.create({ assignReviewer: command }),
    { '': command },
    { 'two words': command },
    { '1assign': command },
    { 'public.assign': command },
    JSON.parse('{"__proto__":{}}'),
    { constructor: command },
    { prototype: command },
    { [Symbol('assign')]: command },
    { assignReviewer: definition() },
  ]) {
    assert.throws(() => defineCommands(value as never), BusinessCommandDefinitionError);
  }
  let touched = false;
  const accessor = Object.defineProperty({}, 'assignReviewer', {
    enumerable: true,
    get() {
      touched = true;
      return command;
    },
  });
  assert.throws(() => defineCommands(accessor as never), /data properties/);
  assert.equal(touched, false);
  const hidden = Object.defineProperty({}, 'assignReviewer', { value: command, enumerable: false });
  assert.throws(() => defineCommands(hidden as never), /data properties/);
  const emptyPrototype = Object.assign(Object.create(null), { assignReviewer: command });
  assert.equal(defineCommands(emptyPrototype).assignReviewer, command);
});

test('business commands: definitions refuse inherited, accessor and symbol options', () => {
  const inherited = Object.assign(Object.create({ elevated: true }), definition());
  assert.throws(() => defineCommand(inherited), /inherit/);
  let touched = false;
  const accessor = Object.defineProperty(definition(), 'source', {
    enumerable: true,
    get() {
      touched = true;
      return 'lending';
    },
  });
  assert.throws(() => defineCommand(accessor), /data properties/);
  assert.equal(touched, false);
  assert.throws(() => defineCommand({ ...definition(), [Symbol('privilege')]: true }), /unsafe property/);
});

test('business commands: synchronous validate and output parse are enforced only when actually run', async () => {
  let invoked = false;
  const command = defineCommand({
    ...definition(),
    validate(): { reviewer: number } {
      invoked = true;
      return Promise.resolve({ reviewer: 3 }) as unknown as { reviewer: number };
    },
    handle: () => ({ assigned: true }),
  });
  assert.equal(invoked, false);
  assert.throws(() => parse(command, { reviewer: 3 }), /synchronously/);
  assert.equal(invoked, true);
  // Deliberate malformed validator output to verify the synchronous contract.
  // oxlint-disable-next-line unicorn/no-thenable
  const malformed = { then() {} };
  const thenable = defineCommand({ ...definition(), output: { parse: () => malformed }, handle: () => malformed });
  assert.throws(() => thenable.output.parse({}), /synchronously/);
  const rejected = defineCommand({
    ...definition(),
    validate: (): { reviewer: number } => Promise.reject(new Error('Asynchronous failure')) as unknown as { reviewer: number },
    handle: () => ({ assigned: true }),
  });
  assert.throws(() => parse(rejected, { reviewer: 3 }), /synchronously/);
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('business commands: the footprint is the target, what is read and what is written, whichever way it is spelled', () => {
  const whole = defineCommand(definition());
  assert.deepEqual(whole.read, ['loan_application', 'reviewer', 'assignment_history']);
  assert.deepEqual(whole.write, ['loan_application', 'assignment_history']);
  // The target and written tables need not be named again; naming them is redundant, never a second footprint.
  const minimal = defineCommand({ ...definition(), read: ['reviewer'], write: ['assignment_history'] });
  assert.deepEqual([minimal.read, minimal.write], [whole.read, whole.write]);
  const bare = defineCommand({ ...definition(), read: undefined, write: undefined } as never) as AnyBusinessCommand;
  assert.deepEqual([bare.read, bare.write], [['loan_application'], ['loan_application']]);
  // A reference writes a secondary source's target qualified by that source; the registration keeps it source-local.
  const secondary = defineCommand({ ...definition(), source: 'applicants', target: 'applicants.contact', read: [], write: [] });
  assert.equal(secondary.target, 'contact');
  assert.deepEqual(secondary.read, ['contact']);
  // A typed source handle names the source; a lookalike object is not one.
  const lending = defineSource<{ loan_application: { id: number }; reviewer: { id: number }; assignment_history: { id: number } }>(
    'lending',
  );
  // Typed, the footprint names only the source's own tables.
  assert.equal(defineCommand({ ...definition(), source: lending, read: ['reviewer'], write: ['assignment_history'] }).source, 'lending');
  assert.throws(() => defineCommand({ ...definition(), source: { name: 'lending' } } as never), BusinessCommandDefinitionError);
});

test('business commands: when is captured whole', () => {
  assert.equal(defineCommand({ ...definition(), when: 'status = submitted' }).when, 'status = submitted');
  assert.equal(defineCommand({ ...definition(), targets: 'many' }).targets, 'many');
  assert.equal(typeof defineCommand({ ...definition(), initial: () => ({}) }).initial, 'function');
});

test("business commands: a command writes no id and no version; its name is its key, its version the lock's", () => {
  assert.throws(() => defineCommand({ ...definition(), id: 'assignReviewer' } as never), /unknown option: id/);
  assert.throws(() => defineCommand({ ...definition(), version: 1 } as never), /unknown option: version/);
  const command = defineCommand(definition());
  assert.equal(command.version, 1);
  assert.equal(defineCommands({ reassign: command }).reassign, command);
});
