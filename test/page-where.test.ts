/**
 * A page's object condition is written out as the query language's own text (shared/pageWhere.ts), so it is held
 * to what the same condition typed as text would be. These pin the text it writes and every refusal: a refused
 * key must never be dropped, since dropping it would widen the read.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileWhere } from '../packages/engine/src/shared/pageWhere.js';
import { parseQuery } from '../packages/engine/src/shared/query.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const column = (name: string, type: string) => ({ name, type, nullable: true, primaryKey: name === 'id' });
const booking: TableMeta = {
  name: 'booking',
  schema: '',
  id: 'booking',
  isView: false,
  columns: [
    column('id', 'INTEGER'),
    column('guest_name', 'TEXT'),
    column('status', 'TEXT'),
    column('party_size', 'INTEGER'),
    column('booked_on', 'DATE'),
    column('paid', 'BOOLEAN'),
  ],
};
const text = (where: unknown) => {
  const got = compileWhere(where, booking);
  assert.ok('text' in got, `refused: ${'error' in got ? got.error : ''}`);
  return got.text;
};
const refusal = (where: unknown) => {
  const got = compileWhere(where, booking);
  assert.ok('error' in got, `accepted as: ${'text' in got ? got.text : ''}`);
  return got.error;
};

test('a value is quoted as text, except digits on a number column and an ISO day on a date column', () => {
  assert.equal(text({ status: 'booked' }), 'status = "booked"');
  // Quoted, a word the language would read as a date or a person is those letters.
  assert.equal(text({ guest_name: 'me' }), 'guest_name = "me"');
  assert.equal(text({ guest_name: 'Ana "Sky" O\\Neil' }), 'guest_name = "Ana \\"Sky\\" O\\\\Neil"');
  assert.equal(text({ party_size: 2, id: '7' }), 'party_size = 2 and id = 7');
  // An id past 2^53 stays its digits: never a Number, which would round it.
  assert.equal(text({ id: '9007199254740993' }), 'id = 9007199254740993');
  assert.equal(text({ booked_on: '2026-11-08' }), 'booked_on = 2026-11-08');
  assert.equal(text({ booked_on: 'today' }), 'booked_on = "today"');
  assert.equal(text({ paid: true }), 'paid = true');
});

test('lists, not, empty, ranges and matches', () => {
  assert.equal(text({ status: ['booked', 'waiting'] }), '(status = "booked" or status = "waiting")');
  assert.equal(text({ status: ['booked'] }), 'status = "booked"');
  assert.equal(text({ status: { not: ['cancelled', 'no_show'] } }), 'status != "cancelled" and status != "no_show"');
  assert.equal(text({ status: { not: 'cancelled' } }), 'status != "cancelled"');
  assert.equal(text({ guest_name: null, status: { not: null } }), 'guest_name is empty and status is not empty');
  assert.equal(text({ party_size: { gt: 1, lte: 6 } }), 'party_size > 1 and party_size <= 6');
  assert.equal(text({ booked_on: { gte: '2026-11-01', lt: '2026-12-01' } }), 'booked_on >= 2026-11-01 and booked_on < 2026-12-01');
  assert.equal(
    text({ guest_name: { contains: 'an', startsWith: 'A', endsWith: 'z' } }),
    'guest_name contains "an" and guest_name startswith "A" and guest_name endswith "z"',
  );
});

test('a list of objects is each joined by and; an undefined value asks nothing', () => {
  assert.equal(text([{ status: 'booked' }, { party_size: { gt: 2 } }]), 'status = "booked" and party_size > 2');
  assert.equal(text({ status: undefined, party_size: 3 }), 'party_size = 3');
  assert.equal(text({ party_size: { gt: undefined, lt: 4 } }), 'party_size < 4');
  assert.equal(text(undefined), '');
  assert.equal(text({}), '');
});

test('everything it cannot ask is refused with a sentence, never dropped', () => {
  assert.equal(refusal({ colour: 'red' }), 'booking has no column "colour".');
  assert.match(
    refusal({ party_size: { over: 2 } }),
    /^party_size has no operator "over": the object form has not, gt, gte, lt, lte, contains, startsWith, endsWith\.$/,
  );
  assert.match(refusal({ paid: { gt: false } }), /paid holds yes or no, which has no gt/);
  assert.match(refusal({ party_size: { contains: '2' } }), /party_size does not hold text/);
  assert.match(refusal({ guest_name: { contains: 2 } }), /contains takes text/);
  assert.match(refusal({ status: [] }), /one of no values/);
  assert.match(refusal({ status: {} }), /no operator in it/);
  assert.match(refusal({ party_size: 'two' }), /party_size holds numbers/);
  assert.match(refusal({ paid: 'yes' }), /compare it with true or false/);
  assert.match(refusal({ status: 2 }), /status cannot be compared with the number 2/);
  assert.match(refusal({ party_size: Number.NaN }), /cannot be compared with the number NaN/);
  assert.match(refusal('status = booked'), /A where is an object/);
  assert.match(refusal([{ status: 'booked' }, 'party_size > 2']), /A where list holds objects/);
  // A refusal anywhere in a list refuses the whole of it.
  assert.equal(refusal([{ status: 'booked' }, { colour: 'red' }]), 'booking has no column "colour".');
});

test('the text it writes parses as the condition typed by hand would', () => {
  const schema: DatabaseSchema = { label: 'page-where', dialect: 'sqlite', foreignKeys: [], readAt: '', tables: [booking] };
  const filter = (query: string) => parseQuery(`booking ${query}`, { schema }).query!.filter;
  assert.deepEqual(filter(text({ status: 'booked', party_size: { gt: 1 } })), filter('status = booked and party_size > 1'));
  assert.deepEqual(filter(text({ status: ['booked', 'waiting'] })), filter('(status = booked or status = waiting)'));
});
