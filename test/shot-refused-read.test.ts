/**
 * `mistri shot` says a page's read the server refused as written. A field report: a page asked
 * `where: { status: { in: ['a', 'b'] } }`, the server answered that read 400 (the object form has no `in`), the page
 * drew `rows.data ?? []` as an empty table, and `shot --text` printed the table with no error beside it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileWhere } from '../packages/engine/src/shared/pageWhere.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';
import { refusedRead, sayPage } from '../packages/mistri/src/server/build/shotText.js';

const booking = {
  name: 'booking',
  schema: '',
  id: 'booking',
  isView: false,
  columns: [{ name: 'status', type: 'TEXT', nullable: true, primaryKey: false }],
} as TableMeta;

test("a page read answered 400 is an error of the run, in the server's own words", () => {
  const compiled = compileWhere({ status: { in: ['a', 'b'] } }, booking);
  assert.ok('error' in compiled, 'the object form has no "in"');
  /* What resourceReadHttp.ts answers a where it cannot compile: 400 and the compiler's sentence. */
  const body = { error: compiled.error, errors: [{ message: compiled.error }] };
  const said = refusedRead(400, '/desk/api/view/run', body);
  assert.equal(said, `a read was refused: ${compiled.error}`);
  assert.match(said!, /status has no operator "in"/);
  assert.equal(refusedRead(400, '/api/breakdown', {}), 'a read was refused: the server answered 400');
  const text = sayPage(
    '/desk/bookings',
    { title: 'Bookings', headings: [], tables: [{ columns: ['Guest'], rows: 0 }], actions: [], empty: [] },
    [said!],
  );
  assert.match(text, /^ {2}error: a read was refused: status has no operator "in"/m);
});

test('a read the reader is not served, a read that worked and any other route are not this', () => {
  /* A page may ask a read its reader is refused and draw that (`optional: true`). */
  assert.equal(refusedRead(403, '/api/view/run', { error: 'Not open to your role.' }), undefined);
  assert.equal(refusedRead(401, '/api/view/run', {}), undefined);
  assert.equal(refusedRead(200, '/api/view/run', { rows: [] }), undefined);
  assert.equal(refusedRead(400, '/api/commands/run', { error: 'x' }), undefined);
  assert.equal(refusedRead(400, '/api/view/run/extra', { error: 'x' }), undefined);
});
