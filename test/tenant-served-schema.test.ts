/**
 * rc.2: a tenant's served catalog — its tables, record names, rollups, computed
 * columns and the segments a reader may be served — was built afresh on every
 * read request, most of a large App's request CPU (a field report: 380 ms for
 * a list's first page on half a core). It is now kept per captured catalog,
 * capabilities, App and zone (tenantServedSchema.ts). These cases count the
 * builds, not the clock: the same inputs are built once, and nothing kept
 * outlives what it read — the App's day, the instant, the reader. A computed
 * column's `today`, `now` and `me` are kept as written and folded into a copy
 * per request, so an App whose columns read the instant (a field report's SLA
 * columns) is still built once, and each request writes its own instant.
 */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { readSqliteReadCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { captureTenantData } from '../packages/engine/src/server/evidence.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { replyJson } from '../packages/mistri/src/server/tenant/tenantReplyJson.js';
import { compileComputed, StatementInstantMissing } from '../packages/engine/src/shared/computed.js';
import { POSTGRES_STYLE } from '../packages/engine/src/shared/filter.js';
import type { TableMeta } from '../packages/engine/src/shared/schema.js';
import {
  forgetTenantProjections,
  projectTenantMetadata,
  tenantProjectionsBuilt,
} from '../packages/mistri/src/server/tenant/tenantMetadata.js';
import {
  servedBaseOf,
  tenantServedCopiesMade,
  tenantServedSchema,
  tenantServedSchemasBuilt,
  withRequestInstant,
} from '../packages/mistri/src/server/tenant/tenantServedSchema.js';

/* Read once: a catalog says when it was read, and each context's is its own capture of the same tables. */
const read = (() => {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE project (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE task (id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL REFERENCES project(id), subject TEXT NOT NULL,
      owner TEXT NOT NULL, due_on DATE NOT NULL, updated_at DATETIME NOT NULL);
  `);
  db.exec('BEGIN');
  const { schema } = readSqliteReadCatalog(db);
  db.exec('COMMIT');
  db.close();
  return schema;
})();
const catalog = (): DatabaseSchema => captureTenantData(structuredClone(read));

const appWith = (computed: Record<string, { type: string; value: string }>) =>
  parseAppConfig(
    {
      id: 'served',
      name: 'Served',
      connection: 'served',
      resources: {
        project: { rollups: { open: { fn: 'count', from: 'task', query: "subject != 'done'" } } },
        task: {
          computed,
          segments: {
            mine: { label: 'Mine', query: 'owner = me' },
            late: { label: 'Late', query: 'due_on < today' },
            stale: { label: 'Stale', query: 'updated_at < now' },
          },
        },
      },
      auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: true } } },
      views: { tasks: { kind: 'list', from: 'task', label: 'Tasks' } },
      home: 'tasks',
      nav: ['tasks'],
    },
    'served schema fixture',
  );

const MORNING = new Date('2026-03-02T09:00:00Z'),
  EVENING = new Date('2026-03-02T17:00:00Z'),
  NEXT_DAY = new Date('2026-03-03T09:00:00Z');
/* A computed column as the statement that reads it writes it: the constants a request folded, or a throw where none was. */
const sqlOf = (table: TableMeta, name: string) =>
  compileComputed(
    table.computed![name]!,
    POSTGRES_STYLE,
    (path) => `"${path}"`,
    () => ({ kind: 'date' }),
  );
const built = (run: () => void) => {
  const before = tenantServedSchemasBuilt();
  run();
  return tenantServedSchemasBuilt() - before;
};
const builtAsync = async (run: () => Promise<void>) => {
  const before = tenantServedSchemasBuilt();
  await run();
  return tenantServedSchemasBuilt() - before;
};

test("a catalog that reads neither the clock nor the reader is built once for a context's inputs", () => {
  const context = { schema: catalog() },
    app = appWith({ late: { type: 'boolean', value: "subject = 'late'" } });
  let first!: DatabaseSchema;
  assert.equal(
    built(() => {
      first = tenantServedSchema(context, app, MORNING, 'ann@example.test');
    }),
    1,
  );
  assert.equal(
    built(() => {
      assert.equal(tenantServedSchema(context, app, NEXT_DAY, 'bob@example.test'), first);
      assert.equal(tenantServedSchema(context, app, EVENING), first);
    }),
    0,
  );
  // What is kept is what a build from scratch says: another captured catalog is another key.
  assert.deepEqual(JSON.parse(JSON.stringify(tenantServedSchema({ schema: catalog() }, app, MORNING))), JSON.parse(JSON.stringify(first)));
  // Another App (a reload), another zone and other capabilities are each built for.
  assert.equal(
    built(() => {
      tenantServedSchema(context, appWith({ late: { type: 'boolean', value: "subject = 'late'" } }), MORNING);
      tenantServedSchema({ ...context, zone: 'America/Chicago' }, app, MORNING);
      tenantServedSchema(
        {
          ...context,
          capabilities: captureTenantData({ resources: { task: { insertable: true, deletable: false, write: ['subject'] } } }) as never,
        },
        app,
        MORNING,
      );
    }),
    3,
  );
});

test("a computed column's day and reader are folded per request into a copy of one kept catalog", () => {
  const context = { schema: catalog() },
    task = (schema: DatabaseSchema) => schema.tables.find((table) => table.id === 'task')!,
    daily = appWith({ due_now: { type: 'boolean', value: 'due_on = today' } });
  let morning!: DatabaseSchema, tomorrow!: DatabaseSchema;
  const copies = tenantServedCopiesMade();
  assert.equal(
    built(() => {
      morning = tenantServedSchema(context, daily, MORNING);
      assert.equal(tenantServedSchema(context, daily, EVENING), morning);
      tomorrow = tenantServedSchema(context, daily, NEXT_DAY);
    }),
    1,
  );
  // One copy a day, found again within it; the kept catalog is the same under both.
  assert.equal(tenantServedCopiesMade() - copies, 2);
  assert.notEqual(tomorrow, morning);
  assert.equal(servedBaseOf(morning), servedBaseOf(tomorrow));
  assert.ok(sqlOf(task(morning), 'due_now').includes('2026-03-02') && sqlOf(task(tomorrow), 'due_now').includes('2026-03-03'));
  // Only the table that says a constant is copied; every other is the kept catalog's own.
  assert.equal(
    morning.tables.find((table) => table.id === 'project'),
    servedBaseOf(morning).tables.find((table) => table.id === 'project'),
  );
});

test('a catalog whose computed columns read the instant is one object for every request, and each writes its own instant', async () => {
  const context = { schema: catalog() },
    task = (schema: DatabaseSchema) => schema.tables.find((table) => table.id === 'task')!,
    /* The field report's shapes: a state test and a deadline against the instant. The fixture's rollup over these
       rows names neither, so it does not read the instant either. */
    instant = appWith({
      fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' },
      at_risk: { type: 'boolean', value: "(subject = 'new' or subject = 'open') and updated_at <= now" },
    });
  const instants = [MORNING, EVENING, NEXT_DAY, new Date('2026-03-03T09:00:01Z')];
  const copies = tenantServedCopiesMade();
  /* Each request as tenantHttp runs one: its clock fixed as it starts, the catalog served and statements written
     after an await, and the requests overlapping, so a clock that leaked between them would be read here. */
  let served: DatabaseSchema[] = [];
  let written: Array<Record<string, string>> = [];
  assert.equal(
    await builtAsync(async () => {
      const requests = instants.map((at, index) =>
        withRequestInstant(at, async () => {
          await new Promise((resolve) => setTimeout(resolve, (instants.length - index) * 5));
          // Served with another clock than the request's: the request's is the one every statement reads.
          const schema = tenantServedSchema(context, instant, new Date(at.getTime() + 60_000));
          await Promise.resolve();
          return { schema, sql: { fresh: sqlOf(task(schema), 'fresh'), at_risk: sqlOf(task(schema), 'at_risk') } };
        }),
      );
      const answers = await Promise.all(requests);
      served = answers.map((answer) => answer.schema);
      written = answers.map((answer) => answer.sql);
    }),
    1,
  );
  // One catalog, the kept one itself: nothing was copied for the instant, so every cache keyed by it is found.
  assert.equal(new Set(served).size, 1);
  assert.equal(servedBaseOf(served[0]!), served[0]);
  assert.equal(tenantServedCopiesMade() - copies, 0);
  written.forEach((sql, index) => {
    const stamp = instants[index]!.toISOString().slice(0, 19);
    for (const name of ['fresh', 'at_risk'] as const) assert.ok(sql[name].includes(stamp), `${name} at ${stamp}: ${sql[name]}`);
    // Never another request's instant.
    for (const other of instants) if (other !== instants[index]) assert.ok(!sql.fresh.includes(other.toISOString().slice(0, 19)));
  });
  assert.equal(new Set(written.map((sql) => sql.fresh)).size, instants.length);
});

test('a catalog served outside any unit of work leaves no instant behind it', async () => {
  const context = { schema: catalog() },
    task = (schema: DatabaseSchema) => schema.tables.find((table) => table.id === 'task')!,
    instant = appWith({ fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' } });
  const morning = tenantServedSchema(context, instant, MORNING);
  assert.equal(tenantServedSchema(context, instant, EVENING), morning);
  /* Serving once said its instant into the async context with `enterWith`, where it stayed after the work it was said
     for: a statement written here, or by any timer begun after it, wrote that instant however old it was. Nobody
     scoped one here, so the statement says so instead. */
  assert.throws(() => sqlOf(task(morning), 'fresh'), StatementInstantMissing);
  await new Promise((resolve) => setTimeout(resolve, 1));
  assert.throws(() => sqlOf(task(morning), 'fresh'), StatementInstantMissing);
  // Scoped, the same catalog writes the work's own instant, and nothing of it is left once the work is done.
  assert.ok(withRequestInstant(EVENING, () => sqlOf(task(morning), 'fresh')).includes('2026-03-02T17:00:00'));
  assert.throws(() => sqlOf(task(morning), 'fresh'), StatementInstantMissing);
});

test('a unit of work inside a long request writes its own instant, and the request keeps its own around it', async () => {
  const context = { schema: catalog() },
    task = (schema: DatabaseSchema) => schema.tables.find((table) => table.id === 'task')!,
    instant = appWith({ fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' } });
  /* A live stream or an import, opened in the morning and still working in the evening: each read inside it is
     scoped at the instant it is asked (tenantHttp.ts), never at the one the request arrived at. */
  await withRequestInstant(MORNING, async () => {
    const schema = tenantServedSchema(context, instant, MORNING);
    assert.ok(sqlOf(task(schema), 'fresh').includes('2026-03-02T09:00:00'));
    const later = await withRequestInstant(EVENING, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return sqlOf(task(tenantServedSchema(context, instant, EVENING)), 'fresh');
    });
    assert.ok(later.includes('2026-03-02T17:00:00') && !later.includes('2026-03-02T09:00:00'), later);
    assert.ok(sqlOf(task(schema), 'fresh').includes('2026-03-02T09:00:00'));
  });
});

test('a catalog whose building reads the instant is built for every request, as before', () => {
  const context = { schema: catalog() },
    app = parseAppConfig(
      {
        id: 'served',
        name: 'Served',
        connection: 'served',
        resources: { project: { rollups: { late: { fn: 'count', from: 'task', query: 'updated_at < now' } } }, task: {} },
        auth: { providers: ['email'], defaultRole: 'viewer', roles: { viewer: { read: true } } },
        views: { tasks: { kind: 'list', from: 'task', label: 'Tasks' } },
        home: 'tasks',
        nav: ['tasks'],
      },
      'served schema rollup fixture',
    );
  assert.equal(
    built(() => {
      tenantServedSchema(context, app, MORNING);
      tenantServedSchema(context, app, EVENING);
      tenantServedSchema(context, app, EVENING);
    }),
    3,
  );
});

test("a catalog that reads the reader is kept once, and each reader is served their own copy, never another's", () => {
  const context = { schema: catalog() },
    task = (schema: DatabaseSchema) => schema.tables.find((table) => table.id === 'task')!,
    app = appWith({ mine: { type: 'boolean', value: 'owner = me' } });
  let ann!: DatabaseSchema, bob!: DatabaseSchema;
  assert.equal(
    built(() => {
      ann = tenantServedSchema(context, app, MORNING, 'ann@example.test');
      bob = tenantServedSchema(context, app, MORNING, 'bob@example.test');
    }),
    1,
  );
  assert.notEqual(ann, bob);
  assert.equal(servedBaseOf(ann), servedBaseOf(bob));
  assert.ok(sqlOf(task(ann), 'mine').includes('ann@example.test') && !sqlOf(task(ann), 'mine').includes('bob@example.test'));
  assert.ok(sqlOf(task(bob), 'mine').includes('bob@example.test') && !sqlOf(task(bob), 'mine').includes('ann@example.test'));
  assert.ok(!JSON.stringify(servedBaseOf(ann)).includes('@example.test'));
  assert.equal(
    built(() => {
      assert.equal(tenantServedSchema(context, app, EVENING, 'ann@example.test'), ann);
      assert.equal(tenantServedSchema(context, app, NEXT_DAY, 'bob@example.test'), bob);
    }),
    0,
  );
  // No reader is its own key, not anyone's catalog.
  const nobody = tenantServedSchema(context, app, MORNING);
  assert.ok(nobody !== ann && nobody !== bob);
  assert.ok(!JSON.stringify(nobody).includes('@example.test'));
});

test("a request's copy finds the metadata projected for the kept catalog, and says what a fresh projection says", () => {
  const context = { schema: catalog() },
    app = appWith({ fresh: { type: 'boolean', value: 'updated_at > now - 30 minutes' } });
  const morning = tenantServedSchema(context, app, MORNING),
    evening = tenantServedSchema(context, app, EVENING);
  const first = projectTenantMetadata(app, [], morning);
  const projected = tenantProjectionsBuilt();
  assert.equal(projectTenantMetadata(app, [], evening), first);
  assert.equal(tenantProjectionsBuilt(), projected);
  forgetTenantProjections();
  assert.deepEqual(projectTenantMetadata(app, [], evening), first);
});

test('a reply that holds a kept catalog says exactly what JSON.stringify says', () => {
  const schema = tenantServedSchema({ schema: catalog() }, appWith({}), MORNING);
  let deep: Record<string, unknown> = { end: true };
  for (let level = 0; level < 14; level++) deep = { level, deep };
  const replies = [
    { schema, reads: { 'a\u0000b': { rows: [{ id: 1, at: new Date(0), gone: undefined, fn: () => 1 }], more: undefined } } },
    [schema, undefined, null, 'text', 1.5, -0, Symbol('s'), Array.from({ length: 70 }, (_, index) => ({ index }))],
    Object.assign(Object.create(null) as object, { kept: schema.tables, 'quote"key': '\u2028' }),
    deep,
    'plain',
  ];
  // Twice: the second says the kept catalog from what the first remembered of it.
  for (let round = 0; round < 2; round++) for (const reply of replies) assert.equal(replyJson(reply), JSON.stringify(reply));
});
