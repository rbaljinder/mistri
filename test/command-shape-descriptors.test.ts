/** Output metadata describes built-ins without asking application parsers to run. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transpile } from './support/tsc.js';
import {
  bool,
  date,
  describeShape,
  hasOpaqueShape,
  id,
  int,
  list,
  literal,
  nullable,
  number,
  oneOf,
  optional,
  shape,
  text,
} from '../packages/mistri/src/server/commands/commandShapes.js';
import { defineCommand, defineCommands } from '../packages/mistri/src/server/commands/businessCommands.js';

test('scalar metadata preserves safe bounds, date range, UTF-16 length and effective regexp flags', () => {
  assert.deepEqual(describeShape(int()), { kind: 'integer', min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(describeShape(id()), { kind: 'integer', min: 1, max: Number.MAX_SAFE_INTEGER });
  assert.deepEqual(describeShape(number({ min: 0 })), { kind: 'number', finite: true, min: 0 });
  assert.deepEqual(describeShape(bool()), { kind: 'boolean' });
  assert.deepEqual(describeShape(date()), { kind: 'date', format: 'YYYY-MM-DD', minYear: 0, maxYear: 9999 });
  const scalar = text({ max: 2, pattern: /^a/gi });
  assert.deepEqual(describeShape(scalar), { kind: 'text', lengthUnit: 'utf16', max: 2, pattern: { source: '^a', flags: 'i' } });
  assert.equal(scalar.parse('Ab'), 'Ab');
  assert.throws(() => text({ max: 1 }).parse('😀'));
  assert.equal(date().parse('0000-02-29'), '0000-02-29');
  assert.throws(() => int().parse(Number.MAX_SAFE_INTEGER + 1));
});

test('options and field maps are snapshotted alongside immutable metadata', () => {
  const bounds = { min: 1, max: 2 };
  const integer = int(bounds),
    decimal = number(bounds),
    array = list(bool(), bounds);
  bounds.min = 10;
  bounds.max = 20;
  assert.equal(integer.parse(1), 1);
  assert.equal(decimal.parse(1.5), 1.5);
  assert.deepEqual(array.parse([true]), [true]);
  assert.throws(() => integer.parse(10));
  assert.throws(() => array.parse([]));
  assert.deepEqual(describeShape(integer), { kind: 'integer', min: 1, max: 2 });
  const pattern = /a/gi;
  const opts = { max: 2, pattern };
  const string = text(opts);
  pattern.compile('b', '');
  opts.max = 100;
  assert.equal(string.parse('A'), 'A');
  assert.throws(() => string.parse('bbb'));
  const fields = { result: integer };
  const object = shape(fields);
  fields.result = int({ min: 100 });
  assert.deepEqual(object.parse({ result: 1, extra: 'discard' }), { result: 1 });
  const descriptor = describeShape(object);
  assert.ok(Object.isFrozen(descriptor));
  assert.equal(descriptor.kind, 'object');
  if (descriptor.kind !== 'object') return;
  assert.ok(Object.isFrozen(descriptor.fields));
  assert.ok(Object.isFrozen(descriptor.fields.result));
  assert.throws(() => {
    (descriptor.fields.result as { min: number }).min = 99;
  });
});

test('optional, nullable, nested lists and overlapping alternatives remain explicit', () => {
  const output = shape({ note: optional(nullable(text())), rows: list(shape({ id: id() })) });
  const descriptor = describeShape(output);
  assert.equal(hasOpaqueShape(descriptor), false);
  assert.equal(descriptor.kind, 'object');
  if (descriptor.kind !== 'object') return;
  assert.equal(descriptor.fields.note.kind, 'optional');
  assert.deepEqual(output.parse({ rows: [{ id: 1, private: true }] }), { rows: [{ id: 1 }] });
  assert.deepEqual(output.parse({ rows: [], note: null }), { rows: [], note: null });
  const overlapping = oneOf(int(), number());
  assert.equal(overlapping.parse(1), 1);
  assert.equal(describeShape(overlapping).kind, 'anyOf');
  assert.deepEqual(oneOf(shape({ first: bool() }), shape({ second: bool() })).parse({ first: true, second: false }), { first: true });
  const union = describeShape(overlapping);
  if (union.kind === 'anyOf') {
    assert.equal(union.selection, 'first-match');
    assert.ok(Object.isFrozen(union.alternatives));
  }
});

test('opaque custom parsers and their children remain runnable but cannot supply metadata by spoofing', () => {
  let calls = 0;
  const custom = {
    parse(value: unknown) {
      calls++;
      return value;
    },
    get descriptor() {
      throw new Error('must not read');
    },
  };
  Object.defineProperty(custom, Symbol.for('mistri.commandShapes.descriptors.v1'), { value: describeShape(bool()) });
  assert.deepEqual(describeShape(custom), { kind: 'opaque', reason: 'custom-parser' });
  for (const composite of [custom, optional(custom), nullable(custom), list(custom), shape({ value: custom }), oneOf(bool(), custom)]) {
    assert.equal(hasOpaqueShape(describeShape(composite)), true);
  }
  assert.equal(calls, 0);
  assert.equal(custom.parse(4), 4);
  for (const unusual of [literal(NaN), literal(Infinity), literal(-0), number({ min: Infinity }), shape({ ['__proto__']: bool() })]) {
    assert.equal(hasOpaqueShape(describeShape(unusual)), true);
  }
});

test('registration preserves descriptors and never invokes output, validate or handler', () => {
  let calls = 0;
  const register = (output: { parse(value: unknown): unknown }) =>
    defineCommand({
      targets: 'none',
      source: 'main',
      target: 'item',
      input: {},
      output,
      validate() {
        calls++;
      },
      handle() {
        calls++;
        return null;
      },
    });
  const output = shape({ okay: bool(), note: optional(text()) });
  const registered = defineCommands({ example: register(output) }).example;
  assert.deepEqual(describeShape(registered.output), describeShape(output));
  const custom = register({
    parse(value) {
      calls++;
      return value;
    },
  });
  assert.equal(describeShape(custom.output).kind, 'opaque');
  assert.equal(calls, 0);
  assert.deepEqual(registered.output.parse({ okay: true }), { okay: true });
  assert.equal(calls, 0);
});

test('separately compiled builder copies retain metadata through source registration', async () => {
  // Compile the real builder module without filesystem output or the fixture
  // build pipeline: this is a second emitted-JS copy in the same process.
  const source = readFileSync(new URL('../packages/mistri/src/server/commands/commandShapes.ts', import.meta.url), 'utf8');
  const emitted = transpile(source, { module: 'esnext' });
  const built = (await import(
    `data:text/javascript;base64,${Buffer.from(emitted).toString('base64')}`
  )) as typeof import('../packages/mistri/src/server/commands/commandShapes.js');
  const output = built.shape({ status: built.literal('done'), nested: optional(built.bool()) });
  assert.equal(describeShape(output).kind, 'object');
  assert.deepEqual(built.describeShape(shape({ count: int() })), describeShape(shape({ count: int() })));
  const command = defineCommand({ targets: 'none', source: 'main', target: 'item', input: {}, output, handle: () => ({ status: 'done' }) });
  assert.deepEqual(describeShape(command.output), built.describeShape(output));
  assert.deepEqual(command.output.parse({ status: 'done' }), { status: 'done' });
});

/* A command whose handler returns nothing need not declare an output: the
   receipt keeps an empty body, published as an object with no fields. A
   handler that returns something anyway is refused, not projected to nothing. */
test('an omitted output is an empty receipt body, and a returned value without one is refused', () => {
  const command = defineCommand({ targets: 'none', source: 'business', target: 'ticket', input: {}, handle: () => {} });
  assert.deepEqual(command.output.parse(undefined), {});
  assert.deepEqual(command.output.parse({}), {}, 'a replay of the stored empty body');
  assert.throws(() => command.output.parse({ message: 'Resolved.' }), /declares no output, so its handler returns nothing/);
  assert.deepEqual(describeShape(command.output), { kind: 'object', projection: 'declared-keys', fields: {} });
});
