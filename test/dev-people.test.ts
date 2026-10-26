/**
 * Who `mistri dev`'s account for a role is, where the App says who people are (`auth.me`): a row of that table,
 * so a view of `mechanic_id = me` shows that person's records. A throwaway address matched no row, and My bench
 * was empty for the one account made to look at it.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { devPeople } from '../packages/mistri/src/server/cli/devMode.ts';
import type { LoadedApp } from '../packages/mistri/src/server/app/apps.ts';
import type { Registry } from '../packages/engine/src/server/connections.ts';

const mechanic = {
  id: 'mechanic',
  name: 'mechanic',
  columns: [
    { name: 'id', type: 'INTEGER', primaryKey: true },
    { name: 'name', type: 'TEXT' },
    { name: 'email', type: 'TEXT' },
    { name: 'title', type: 'TEXT' },
  ],
};
const rows = [
  { id: 1, name: 'Rosa Delgado', email: 'rosa@spoke.test', title: 'Lead' },
  { id: 2, name: 'Sam Okafor', email: 'sam@spoke.test', title: 'Manager' },
  { id: 3, name: 'Lena Park', email: 'lena@spoke.test', title: null },
];
const registry = {
  list: () => [{ id: 'shop', name: 'shop' }],
  open: async () => ({ schema: { tables: [mechanic] }, adapter: { query: async () => ({ rows }) } }),
} as unknown as Registry;
const app = (auth: object) => ({ app: { connection: 'shop', auth } }) as unknown as LoadedApp;

test("a role's dev account is a row of auth.me's table: one naming the role, then the role named as the table, then in order", async () => {
  const people = await devPeople(app({ me: { from: 'mechanic', column: 'email' }, roles: {} }), ['owner', 'manager', 'mechanic'], registry);
  assert.deepEqual(Object.fromEntries(people), {
    manager: { email: 'sam@spoke.test', name: 'Sam Okafor' },
    mechanic: { email: 'rosa@spoke.test', name: 'Rosa Delgado' },
    owner: { email: 'lena@spoke.test', name: 'Lena Park' },
  });
});

test('no auth.me, or a tenant App, keeps the throwaway addresses; a role past the rows keeps its own', async () => {
  assert.equal((await devPeople(app({ roles: {} }), ['mechanic'], registry)).size, 0);
  assert.equal((await devPeople(app({ rows: 'tenant', me: { from: 'mechanic', column: 'email' } }), ['mechanic'], registry)).size, 0);
  const many = await devPeople(app({ me: { from: 'mechanic', column: 'email' } }), ['a', 'b', 'c', 'd'], registry);
  assert.deepEqual([...many.keys()], ['a', 'b', 'c']);
});
