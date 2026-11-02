/**
 * `shot` and `grade` name a record under any list over its table, as the browser does (a field report): the
 * address is rewritten to the table's canonical record route (shared/appAddress.ts: the resource's `view`, else the
 * first plain list in menu order) and the run says which one it shot. It used to refuse "`/jobs` has no records under it".
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

function appWith(resources: Record<string, unknown>) {
  const app = parseAppConfig(
    {
      id: 'shop',
      name: 'Shop',
      resources,
      views: { board: { kind: 'list', from: 'job' }, jobs: { kind: 'list', from: 'job' } },
      nav: ['board', 'jobs'],
      home: 'board',
    },
    'shop App',
  );
  return { path: 'shop.ts', sources: {}, pages: [], app } as never;
}
const mount = { base: '', apps: {} } as never;
const run = async (resources: Record<string, unknown>, asked: string) => {
  const loaded = appWith(resources);
  const said: string[] = [];
  const shots = await addresses([asked], loaded, appRoutes(loaded, schema), async () => '1', undefined, mount, [], said);
  return { shots, said };
};

test('a record under a list that is not its canonical address opens at the canonical one, and says so', async () => {
  const { shots, said } = await run({ job: {} }, '/shop/jobs/12');
  assert.equal(shots[0].path, '/shop/board/12');
  assert.equal(said.length, 1);
  assert.match(said[0], /"\/shop\/jobs\/12" is a record of "job", which the App addresses \/shop\/board\/12/);
});

test("the resource's view decides which list that is, and an address already canonical says nothing", async () => {
  const pinned = await run({ job: { view: 'jobs' } }, '/shop/board/12');
  assert.equal(pinned.shots[0].path, '/shop/jobs/12');
  const canonical = await run({ job: { view: 'jobs' } }, '/shop/jobs/12');
  assert.equal(canonical.shots[0].path, '/shop/jobs/12');
  assert.deepEqual(canonical.said, []);
});
