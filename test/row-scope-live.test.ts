import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { PostgresAdapter } from '../packages/engine/src/adapters/postgres.js';
import type { Filter } from '../packages/engine/src/adapters/adapter.js';
import type { ViewDef } from '../packages/engine/src/shared/view.js';
import type { BreakdownDef } from '../packages/engine/src/shared/breakdown.js';

const filter = (value: string): Filter => ({ groups: [[{ column: 'tenant', op: '=', value }]] });

// Deliberately independent of TABLEWALK_TEST_PG and its shared seeded fixtures.
const LIVE_ROW_PG = process.env.TABLEWALK_TEST_ROW_PG;
test(
  'live PostgreSQL private scoped readers execute all six methods with isolated row predicates',
  {
    skip: !LIVE_ROW_PG && 'Set TABLEWALK_TEST_ROW_PG to an explicitly disposable PostgreSQL database.',
    timeout: 30_000,
  },
  async () => {
    const specifier = 'pg';
    type SetupClient = {
      connect(): Promise<void>;
      query(text: string, params?: unknown[]): Promise<unknown>;
      end(): Promise<void>;
    };
    type ClientConstructor = new (options: {
      connectionString: string;
      connectionTimeoutMillis: number;
      statement_timeout: number;
    }) => SetupClient;
    const pg = (await import(specifier)) as { Client?: ClientConstructor; default?: { Client?: ClientConstructor } };
    const Client = pg.Client ?? pg.default?.Client;
    assert.ok(Client, 'PostgreSQL driver must expose Client for fixture setup');
    const setup = new Client({ connectionString: LIVE_ROW_PG!, connectionTimeoutMillis: 5_000, statement_timeout: 5_000 });
    const schema = `tw_row_${randomUUID().replaceAll('-', '')}`;
    const quoted = `"${schema}"`;
    const item = `${schema}.item`;
    const team = `${schema}.team`;
    const adapter = new PostgresAdapter(LIVE_ROW_PG!, 'isolated scoped-read proof', [schema]);
    let created = false;
    try {
      await setup.connect();
      // Never pre-drop: cleanup is authorized only after this test created it.
      await setup.query(`CREATE SCHEMA ${quoted}`);
      created = true;
      await setup.query(`CREATE TABLE ${quoted}.team (id integer PRIMARY KEY, tenant text NOT NULL, name text NOT NULL)`);
      await setup.query(`CREATE TABLE ${quoted}.item (
      id integer PRIMARY KEY, tenant text NOT NULL, status text NOT NULL,
      amount integer NOT NULL, team_id integer REFERENCES ${quoted}.team(id)
    )`);
      await setup.query(
        `INSERT INTO ${quoted}.team (id, tenant, name) VALUES
      (1, $1, 'North desk'), (2, $2, 'South desk')`,
        ['north', 'south'],
      );
      await setup.query(
        `INSERT INTO ${quoted}.item (id, tenant, status, amount, team_id) VALUES
      (1, $1, 'pending', 10, 1), (2, $1, 'approved', 20, 1),
      (3, $2, 'pending', 30, 2), (4, $1, 'pending', 40, 2)`,
        ['north', 'south'],
      );

      const north = await adapter.scopeReads({ [item]: filter('north'), [team]: filter('north') });
      const pending: Filter = { groups: [[{ column: 'status', op: '=', value: 'pending' }]] };
      const query = await north.query({
        table: item,
        columns: ['id'],
        filter: pending,
        orderBy: [{ column: 'id', direction: 'asc' }],
        limit: 1,
        offset: 1,
      });
      assert.deepEqual(query.rows, [{ id: 4 }]);
      assert.deepEqual(query.sql.params, ['north', 'pending', 1, 1]);
      assert.match(query.sql.text, /LIMIT \$3 OFFSET \$4$/);
      assert.equal(await north.count(item, pending), 2);

      const definition: ViewDef = {
        id: 'scoped-items',
        name: 'Scoped items',
        base: item,
        columns: [{ path: 'id' }, { path: 'team_id.name', alias: 'desk' }],
        filter: { groups: [[{ path: 'status', op: '=', value: 'pending' }]] },
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 1,
      };
      const page = await north.runView(definition, 1);
      assert.deepEqual(page.columns, ['id', 'desk']);
      assert.deepEqual(page.rows, [{ id: 4, desk: null }], 'denied joined team must not hide the allowed parent or disclose its desk');
      assert.deepEqual(page.sql.params, ['north', 'north', 'pending', 1, 1]);
      assert.match(page.sql.text, /LIMIT \$4 OFFSET \$5$/);
      assert.equal(await north.countView(definition), 2, 'view counts ignore pagination and projection-only joins');

      const grouped: BreakdownDef = {
        base: item,
        by: [{ path: 'status' }],
        measures: [
          { fn: 'count', alias: 'n' },
          { fn: 'sum', path: 'amount', alias: 'total' },
        ],
        filter: definition.filter,
        limit: 1,
      };
      const summary = await north.runBreakdown(grouped);
      assert.equal(summary.rows.length, 1);
      assert.equal(summary.rows[0].status, 'pending');
      assert.equal(Number(summary.rows[0].n), 2);
      assert.equal(Number(summary.rows[0].total), 50);
      assert.deepEqual(summary.columns, ['status', 'n', 'total']);
      assert.deepEqual(summary.sql.params, ['north', 'pending', 1, 0]);
      assert.equal(await north.countBreakdown(grouped), 1);

      const south = await adapter.scopeReads({ [item]: filter('south') });
      const [northCount, southCount] = await Promise.all([north.count(item), south.count(item)]);
      assert.deepEqual([northCount, southCount], [3, 1]);
      assert.equal(await north.count(item, filter('south')), 0, 'a caller filter cannot replace the bound scope');
      assert.equal(await south.count(team), 0, 'an omitted resource denies rows');
      const denied = await adapter.scopeReads({});
      assert.equal(await denied.count(item), 0);
      const empty = await denied.query({ table: item, columns: ['id', 'status'], limit: 1, offset: 0 });
      assert.deepEqual(empty.rows, []);
      assert.deepEqual(empty.columns, ['id', 'status']);
      const emptyView = await denied.runView(definition);
      assert.deepEqual(emptyView.rows, []);
      assert.deepEqual(emptyView.columns, ['id', 'desk']);
      assert.equal(await denied.countView(definition), 0);
      assert.equal(await denied.countBreakdown(grouped), 0);
      const ungrouped: BreakdownDef = { ...grouped, by: [] };
      const emptySummary = await denied.runBreakdown(ungrouped);
      assert.equal(emptySummary.rows.length, 1, 'ungrouped aggregates retain their one empty-input result');
      assert.equal(Number(emptySummary.rows[0].n), 0);
      assert.equal(emptySummary.rows[0].total, null);
      assert.equal(await denied.countBreakdown(ungrouped), 1);
      assert.equal(await adapter.count(item), 4, 'private capabilities do not rebind ordinary readers');

      // A foreign key alone is not authorization: this child belongs to another
      // scope even though it points at an allowed parent.
      await setup.query(
        `INSERT INTO ${quoted}.item (id, tenant, status, amount, team_id)
      VALUES (5, $1, 'pending', 900, 1)`,
        ['south'],
      );
      const catalog = await adapter.introspect();
      const relationship = catalog.foreignKeys.find((key) => key.from.table === item && key.to.table === team);
      assert.ok(relationship, 'fixture foreign key must be discovered from PostgreSQL');
      const teamSummary: ViewDef = {
        id: 'scoped-team-summary',
        name: 'Scoped team summary',
        base: team,
        columns: [{ path: 'id' }, { path: 'name' }],
        aggregates: [
          { fn: 'count', via: relationship.name, alias: 'items' },
          { fn: 'sum', via: relationship.name, column: 'amount', alias: 'total' },
        ],
        orderBy: [{ path: 'id', direction: 'asc' }],
        limit: 5,
      };
      const teams = await north.runView(teamSummary);
      assert.deepEqual(teams.columns, ['id', 'name', 'items', 'total']);
      assert.deepEqual(
        teams.rows.map((row) => ({ ...row, items: Number(row.items), total: Number(row.total) })),
        [{ id: 1, name: 'North desk', items: 2, total: 30 }],
        'correlated count and sum must exclude the other-tenant child',
      );
      assert.deepEqual(teams.sql.params, ['north', 'north', 5, 0]);
      assert.equal(await north.countView(teamSummary), 1, 'reverse aggregates preserve parent cardinality');
      const visibleTeamsOnly = await adapter.scopeReads({ [team]: filter('north') });
      const noChildren = await visibleTeamsOnly.runView(teamSummary);
      assert.equal(noChildren.rows.length, 1);
      assert.equal(Number(noChildren.rows[0].items), 0);
      assert.equal(noChildren.rows[0].total, null);
      assert.equal(await visibleTeamsOnly.countView(teamSummary), 1, 'denied children do not deny an allowed parent');
    } finally {
      try {
        await adapter.close();
      } finally {
        try {
          if (created) await setup.query(`DROP SCHEMA ${quoted} CASCADE`);
        } finally {
          await setup.end();
        }
      }
    }
  },
);
