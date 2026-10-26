import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Adapter, ScopedReads } from '../packages/engine/src/adapters/adapter.js';
import { authorizeResources } from '../packages/mistri/src/server/app/appAccess.js';
import { createAppResources } from '../packages/mistri/src/server/app/appResources.js';
import { createAppSourceAdapter } from '../packages/mistri/src/server/app/appSourceAdapter.js';
import type { RuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResources.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';

const schema: DatabaseSchema = {
  label: 'Mock',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'physical',
      name: 'physical',
      schema: '',
      isView: false,
      columns: [{ name: 'id', type: 'INTEGER', nullable: false, primaryKey: true }],
    },
  ],
};
for (const multi of [false, true])
  for (const scoped of [false, true]) {
    test(`countView preserves exact optional bound through ${multi ? 'source' : 'resource'} mapping and ${scoped ? 'scoped' : 'ordinary'} authorization`, async () => {
      const calls: Array<{ view: ViewDef; limit?: number }> = [];
      const unused = async (): Promise<never> => {
        throw new Error('Unexpected adapter method');
      };
      const countView = async (view: ViewDef, limit?: number) => {
        calls.push({ view, limit });
        return 7;
      };
      const reads: ScopedReads = { query: unused, count: unused, runView: unused, countView, runBreakdown: unused, countBreakdown: unused };
      const physical: Adapter = {
        dialect: 'sqlite',
        introspect: async () => schema,
        close: async () => {},
        query: unused,
        count: unused,
        countView,
        scopeReads: async () => reads,
      };
      const source = multi
        ? createAppSourceAdapter({ main: { adapter: physical, schema, resources: { person: 'physical' } } }, 'main')
        : undefined;
      const mapped = source ?? createAppResources(physical, schema, { person: 'physical' });
      const resources: RuntimeResources = {
        ...mapped,
        connections: ['owned'],
        toPhysical: (name) => (name === 'person' ? 'physical' : name),
        toLogical: (name) => (name === 'physical' ? 'person' : name),
        connectionFor: () => 'owned',
        toLogicalAt: (name) => name,
        forConnection: () => mapped.adapter,
      };
      const access = { readable: new Set(['person']), writable: new Set<string>(), ...(scoped ? { rows: { person: true as const } } : {}) };
      const authorized = authorizeResources(resources, access);
      const view: ViewDef = {
        id: 'fixture',
        name: 'Fixture',
        base: 'person',
        columns: [{ path: 'id' }],
        filter: { groups: [[{ path: 'id', op: '>', value: 3 }]] },
      };
      for (const adapter of [authorized.adapter, authorized.forConnection('owned')]) {
        assert.equal(await adapter.countView!(view), 7);
        for (const limit of [1, 10001, 0, -1, NaN]) assert.equal(await adapter.countView!(view, limit), 7);
        // Wrappers forward, never clamp or substitute. Concrete adapters retain
        // responsibility for rejecting invalid limits; access checks still run.
        const before = calls.length;
        await assert.rejects(async () => adapter.countView!({ ...view, base: 'hidden' }, 10001));
        assert.equal(calls.length, before);
      }
      assert.deepEqual(
        calls.map((call) => call.limit),
        [undefined, 1, 10001, 0, -1, NaN, undefined, 1, 10001, 0, -1, NaN],
      );
      assert.ok(calls.every((call) => call.view.base === 'physical'));
      assert.ok(calls.every((call) => JSON.stringify(call.view.filter) === JSON.stringify(view.filter)));
    });
  }
