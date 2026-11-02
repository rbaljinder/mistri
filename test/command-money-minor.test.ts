/**
 * `field.money({ minor: true, currency? })`: an amount typed in the currency's major unit, kept as the exact whole
 * number of its minor units. Read text to text (no float on the way), at the currency's own precision, in the field's
 * own currency where it names one, and a fraction finer than the currency is refused, not rounded.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { field as fieldHelpers } from '../packages/mistri/src/server/commands/commandFields.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { CommandInputRefusal, commandInputProblems, readCommandInput } from '../packages/mistri/src/shared/commandInput.js';
import { defineCommand, parseRegisteredInput } from '../packages/mistri/src/server/commands/businessCommands.js';
import { majorToMinor, majorToMinorText } from '../packages/engine/src/shared/moneyEntry.js';

const one = (options: object, extra: object = {}) =>
  parseCommandInput({ amount: fieldHelpers.money({ ...options } as never) }, 'pay', extra);

test('a minor-unit amount is declared with a precision from its currency, not a step', () => {
  const [plain] = one({});
  assert.equal(plain.type === 'money' && plain.step, 0.01);
  const [minor] = one({ minor: true, currency: 'EUR', max: 500 });
  assert.deepEqual(minor, {
    name: 'amount',
    label: 'Amount',
    required: true,
    type: 'money',
    min: 0,
    max: 500,
    minor: true,
    currency: 'EUR',
  });
  assert.throws(() => one({ minor: true, step: 1 }), /precision from the currency/);
  assert.throws(() => one({ currency: 'euro' }), /ISO 4217/);
  assert.throws(() => one({ minor: 'yes' }), /minor must be boolean/);
  assert.throws(() => parseCommandInput({ n: { type: 'number', minor: true } }, 'pay'), /minor/);
});

test('minor units are read exactly from the typed text, at the currency precision', () => {
  const [usd] = one({ minor: true });
  const read = (value: unknown, options = {}) => readCommandInput([usd], { amount: value }, { currency: 'USD', ...options }).amount;
  assert.equal(read('19.99'), 1999);
  assert.equal(read(' 5 '), 500);
  assert.equal(read('.5'), 50);
  assert.equal(read(45.5), 4550);
  assert.equal(read('0.10'), 10);
  // 0.1 + 0.2 style floats never enter: 1.15 * 100 would be 114.99999999999999 as a float.
  assert.equal(read('1.15'), 115);
  assert.equal(read('1.150'), 115, 'trailing zeros say nothing more than the currency has');
  // Past 2^53 the whole number is a string, exact, as an id is.
  assert.equal(read('90071992547409.93'), '9007199254740993');
  // The currency's own places: none in yen, three in dinars.
  const [yen] = one({ minor: true });
  assert.equal(readCommandInput([yen], { amount: '1500' }, { currency: 'JPY' }).amount, 1500);
  assert.equal(readCommandInput([yen], { amount: '1.234' }, { currency: 'KWD' }).amount, 1234);
  // A field's own currency beats the App's.
  const [euro] = one({ minor: true, currency: 'JPY' });
  assert.equal(readCommandInput([euro], { amount: '1500' }, { currency: 'USD' }).amount, 1500);
});

test('too many decimals is refused as a precision problem, never rounded', () => {
  const [usd] = one({ minor: true });
  assert.throws(
    () => readCommandInput([usd], { amount: '19.999' }, { currency: 'USD' }),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === 'amount' && error.reason === 'precision',
  );
  assert.deepEqual(commandInputProblems([usd], { amount: '1500.5' }, { currency: 'JPY' }), [{ path: 'amount', reason: 'precision' }]);
  assert.deepEqual(commandInputProblems([usd], { amount: 'abc' }, { currency: 'USD' }), [{ path: 'amount', reason: 'type' }]);
  assert.deepEqual(commandInputProblems([usd], { amount: '1e3' }, { currency: 'USD' }), [{ path: 'amount', reason: 'type' }]);
  assert.deepEqual(commandInputProblems([usd], { amount: true }, { currency: 'USD' }), [{ path: 'amount', reason: 'type' }]);
});

test('bounds are in the typed unit, and the wire reading keeps the typed amount', () => {
  const [bounded] = one({ minor: true, min: 1, max: 100 });
  const problems = (value: string) => commandInputProblems([bounded], { amount: value }, { currency: 'USD' });
  assert.deepEqual(problems('0.99'), [{ path: 'amount', reason: 'below_min' }]);
  assert.deepEqual(problems('100.01'), [{ path: 'amount', reason: 'above_max' }]);
  assert.deepEqual(problems('100'), []);
  // What a browser sends (and a form is served as its starting value): the amount as typed, tidied, not minor units.
  assert.equal(readCommandInput([bounded], { amount: ' 5.50 ' }, { currency: 'USD', wire: true }).amount, '5.50');
  assert.equal(readCommandInput([bounded], { amount: '7' }, { currency: 'JPY', wire: true }).amount, '7');
  // With no currency known (an envelope's early shape check) only the shape and the bounds are judged.
  assert.equal(readCommandInput([bounded], { amount: '5.123' }, { wire: true }).amount, '5.123');
});

test('a minor amount below or above its sibling is compared as the number it is', () => {
  const fields = parseCommandInput(
    { total: fieldHelpers.money({ minor: true }), deposit: fieldHelpers.money({ minor: true, below: 'total' }) },
    'pay',
  );
  assert.deepEqual(readCommandInput(fields, { total: '100', deposit: '9.50' }, { currency: 'USD' }), { total: 10000, deposit: 950 });
  // As text "9.50" > "100" would hold; as amounts it is below.
  assert.deepEqual(readCommandInput(fields, { total: '100', deposit: '9.50' }, { currency: 'USD', wire: true }), {
    total: '100.00',
    deposit: '9.50',
  });
  assert.deepEqual(commandInputProblems(fields, { total: '10', deposit: '10' }, { currency: 'USD' }), [
    { path: 'deposit', reason: 'not_below' },
  ]);
});

test('majorToMinorText: exact digits, no float, refusing a finer fraction', () => {
  assert.equal(majorToMinorText('19.99', 'USD'), '1999');
  assert.equal(majorToMinorText('-0.00', 'USD'), '0');
  assert.equal(majorToMinorText('-12.5', 'USD'), '-1250');
  assert.equal(majorToMinorText('00012', 'USD'), '1200');
  assert.equal(majorToMinorText('1.005', 'USD'), undefined);
  assert.equal(majorToMinorText('12345678901234567.89', 'USD'), '1234567890123456789');
  assert.equal(majorToMinor('12345678901234567.89', 'USD'), undefined);
  assert.equal(majorToMinor('19.99', 'USD'), 1999);
});

test("the server reads a registered command's amount into minor units in the App currency, and refuses a finer fraction", () => {
  const command = defineCommand({
    targets: 'none',
    source: 'main',
    target: 't',
    input: { price: fieldHelpers.money({ minor: true }), fee: fieldHelpers.money({ minor: true, currency: 'JPY', optional: true }) },
    output: { parse: (value: unknown) => value },
    handle: (): unknown => ({}),
  });
  const context = { actor: { id: 'a', appId: 'x', roles: [] }, commandId: 'c', version: 1 };
  const read = (raw: unknown, currency?: string) =>
    parseRegisteredInput(command, raw, context, { publicForm: false, ...(currency ? { currency } : {}) });
  assert.deepEqual(read({ price: '19.99', fee: '300' }, 'USD'), { price: 1999, fee: 300 });
  assert.deepEqual(read({ price: '1.234' }, 'KWD'), { price: 1234 });
  assert.deepEqual(read({ price: '12.5' }), { price: 1250 }, 'dollars where the App names no currency');
  assert.deepEqual(read({ price: '90071992547409.93' }, 'USD'), { price: '9007199254740993' });
  assert.throws(
    () => read({ price: '19.999' }, 'USD'),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === 'price' && error.reason === 'precision',
  );
  assert.throws(
    () => read({ price: '5', fee: '1.5' }, 'USD'),
    (error: unknown) => error instanceof CommandInputRefusal && error.path === 'fee',
  );
});
