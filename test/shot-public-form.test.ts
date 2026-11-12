/**
 * `shot` and `grade` open a public form's page, `/{app}/form/{view}` (a field report): no route of the App's book
 * names it, so it was refused as "names no route". It is a visitor's page, so it is opened signed out.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { appRoutes } from '../packages/mistri/src/server/app/apps.js';
import { addresses } from '../packages/mistri/src/server/build/shot.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

const schema = {
  tables: [{ id: 'job', name: 'job', kind: 'table', columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }] }],
} as unknown as DatabaseSchema;

const app = parseAppConfig(
  { id: 'shop', name: 'Shop', resources: { job: {} }, views: { board: { kind: 'list', from: 'job' } }, nav: ['board'], home: 'board' },
  'shop App',
);
// A command form needs its command registered to parse, so the book is read first and the forms added after: the
// address check reads only which views are public forms.
const book = appRoutes({ path: 'shop.ts', sources: {}, pages: [], app } as never, schema);
(app.views as Record<string, unknown>).apply = { kind: 'form', label: 'Apply', public: true, command: 'apply' };
(app.views as Record<string, unknown>).intake = { kind: 'form', label: 'Intake', command: 'intake' };
const loaded = { path: 'shop.ts', sources: {}, pages: [], app } as never;
const mount = { base: '', apps: {} } as never;
const run = (asked: string) => addresses([asked], loaded, book, async () => '1', undefined, mount, [], []);

test("a public form's page opens, signed out", async () => {
  for (const asked of ['/shop/form/apply', 'form/apply', '/shop/form/apply?utm=x', 'apply', '/shop/apply']) {
    const [shot] = await run(asked);
    assert.equal(shot.path, '/shop/form/apply', asked);
    assert.equal(shot.signedOut, true, asked);
    assert.equal(shot.view, 'apply');
  }
  assert.equal((await run('/shop/board'))[0].signedOut, undefined, 'an ordinary room is shot as the run signs in');
});

test('a form that is not public, or no form at all, is refused with the public forms there are', async () => {
  for (const asked of ['/shop/form/intake', '/shop/form/nope', '/shop/form']) {
    await assert.rejects(run(asked), /names no public form of "shop": its public forms are apply, at \/form\/\{form\}/, asked);
  }
});
