import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRelatedCreate, relatedCreatePlan } from '../packages/engine/src/shared/relatedCreate.js';
import { parsePagesConfig, pageConfig, validatePage } from '../packages/engine/src/shared/page.js';
import type { DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';

const table = (id: string, columns: string[], keys: string[]): TableMeta => ({
  id,
  name: id,
  schema: '',
  isView: false,
  columns: columns.map((name) => ({ name, type: 'text', nullable: false, primaryKey: keys.includes(name) })),
});
const schema: DatabaseSchema = {
  label: 'Test',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    table('parent', ['tenant', 'id'], ['tenant', 'id']),
    table('child', ['tenant_id', 'parent_id', 'name'], ['tenant_id', 'parent_id', 'name']),
  ],
  foreignKeys: [
    {
      name: 'parent_ref',
      from: { table: 'child', columns: ['tenant_id', 'parent_id'] },
      to: { table: 'parent', columns: ['tenant', 'id'] },
    },
  ],
};
test('related creation binds the full composite parent, not a guessed id or filter value', () => {
  assert.deepEqual(
    relatedCreatePlan(schema, 'parent', 'child', 'parent_ref', { label: 'Add child', show: ['tenant_id', 'parent_id', 'name'] }),
    {
      show: ['name'],
      bindings: [
        { column: 'tenant_id', parent: 'tenant' },
        { column: 'parent_id', parent: 'id' },
      ],
      otherParents: [],
      defaults: {},
      fill: {},
    },
  );
  assert.match(relatedCreatePlan(schema, 'parent', 'child', 'parent_ref.other', { label: 'Add' }).error!, /direct reference/);
  /* A wrong `whose` says what it is, and which references would do. */
  const ref = relatedCreatePlan(schema, 'parent', 'child', 'parent_ref', { label: 'Add' });
  assert.equal(ref.error, undefined);
  const named = `Its references to parent: "${schema.foreignKeys.map((fk) => fk.from.columns.join('+'))[0]}".`;
  assert.equal(
    relatedCreatePlan(schema, 'parent', 'child', 'missing', { label: 'Add' }).error,
    `"missing" is not a column of child. ${named}`,
  );
  assert.equal(
    relatedCreatePlan(schema, 'parent', 'child', 'parent_id', { label: 'Add' }).error,
    `"parent_id" is a column of child, but not a reference to parent. ${named}`,
  );
  const elsewhere: DatabaseSchema = {
    ...schema,
    tables: [...schema.tables, table('other', ['id'], ['id'])],
    foreignKeys: [
      ...schema.foreignKeys,
      { name: 'name_ref', from: { table: 'child', columns: ['name'] }, to: { table: 'other', columns: ['id'] } },
    ],
  };
  assert.equal(
    relatedCreatePlan(elsewhere, 'parent', 'child', 'name_ref', { label: 'Add' }).error,
    '"name_ref" refers to other, not to parent, so a row added here would not belong to this record.',
  );
  assert.match(relatedCreatePlan(schema, 'parent', 'child', 'parent_ref', { label: 'Add', show: [] }).error!, /required columns: name/);
  assert.match(relatedCreatePlan(schema, 'parent', 'child', 'parent_ref', { label: 'Add', show: ['bogus'] }).error!, /unknown/);
});
test('related creation refuses malformed authoring and round trips through the public emitter', () => {
  for (const value of [
    true,
    null,
    [],
    {},
    { label: ' ' },
    { label: 'Add', defaults: [] },
    { label: 'Add', defaults: { name: {} } },
    { label: 'Add', show: [1] },
    { label: 'Add', prefill: {} },
    { label: 'Add', prefill: { name: 3 } },
    { label: 'Add', onCreate: true },
  ])
    assert.throws(() => parseRelatedCreate(value, 'test'), /create/);
  const [page] = parsePagesConfig(
    {
      pages: [
        {
          label: 'Parent',
          base: 'parent',
          sections: [{ kind: 'list', from: 'child', whose: 'parent_ref', create: { label: 'Add child', show: ['name'] } }],
        },
      ],
    },
    'test',
  );
  assert.equal(validatePage(schema, page).error, undefined);
  assert.deepEqual(parsePagesConfig({ pages: [pageConfig(page)] }, 'round trip')[0], page);
  const list = page.sections[0];
  assert.equal(list.kind, 'list');
  /* A filtered list takes a create: its equalities fill the new row, so what is added is listed there. */
  assert.equal(validatePage(schema, { ...page, sections: [{ ...list, filter: 'name = sample' }] }).error, undefined);
  const withMore = parsePagesConfig(
    {
      pages: [
        {
          label: 'Parent',
          base: 'parent',
          sections: [{ kind: 'list', from: 'child', whose: 'parent_ref', create: { label: 'Add child', defaults: { name: 'Draft' } } }],
        },
      ],
    },
    'test',
  )[0];
  // A create that says more than its label keeps it through the emitter.
  assert.deepEqual(parsePagesConfig({ pages: [pageConfig(withMore)] }, 'round trip')[0], withMore);
});

test("a create fills from its list and its record: the query's equalities, defaults, and the record's own columns", () => {
  const shop: DatabaseSchema = {
    label: 'Shop',
    dialect: 'sqlite',
    readAt: '',
    foreignKeys: [{ name: 'visit_id', from: { table: 'rx', columns: ['visit_id'] }, to: { table: 'visit', columns: ['id'] } }],
    tables: [
      {
        id: 'visit',
        name: 'visit',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
          { name: 'patient_id', type: 'INTEGER', nullable: false, primaryKey: false },
        ],
      },
      {
        id: 'rx',
        name: 'rx',
        schema: '',
        isView: false,
        columns: [
          { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true, identity: 'by-default' },
          { name: 'visit_id', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'patient_id', type: 'INTEGER', nullable: false, primaryKey: false },
          { name: 'status', type: 'TEXT', nullable: false, primaryKey: false, allowed: ['active', 'ended'] },
          { name: 'kind', type: 'TEXT', nullable: true, primaryKey: false },
          { name: 'drug', type: 'TEXT', nullable: false, primaryKey: false },
        ],
      },
    ],
  };
  const plan = relatedCreatePlan(
    shop,
    'visit',
    'rx',
    'visit_id',
    { label: 'Prescribe', show: ['drug'], defaults: { status: 'ended', kind: 'oral' }, prefill: { patient_id: 'patient_id' } },
    { filter: 'status = active and kind != topical' },
  );
  // The required status and patient are given, so they need not be shown; the list's equality wins over a default.
  assert.equal(plan.error, undefined);
  assert.deepEqual(plan.defaults, { status: 'active', kind: 'oral' });
  assert.deepEqual(plan.fill, { patient_id: 'patient_id' });
  assert.match(
    relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'Prescribe', show: ['drug'] }).error!,
    /required columns: patient_id, status/,
  );
  assert.match(
    relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'P', prefill: { patient_id: 'nurse_id' } }).error!,
    /not a column of visit/,
  );
  assert.match(relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'P', prefill: { visit_id: 'id' } }).error!, /already binds/);
  assert.match(relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'P', defaults: { dose: 1 } }).error!, /not a column of rx/);
  // An `or` pins nothing: the new row cannot be placed in both.
  assert.deepEqual(
    relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'P' }, { filter: 'status = active or kind = oral' }).defaults,
    {},
  );
  // A list beside `whose` takes no `same` any more, so the record's own columns reach a new row only through `prefill`.
  assert.deepEqual(relatedCreatePlan(shop, 'visit', 'rx', 'visit_id', { label: 'P' }).fill, {});
});

test('related empty guidance is parsed, round-trips, and is unavailable on matched lists', () => {
  const [page] = parsePagesConfig(
    {
      pages: [
        {
          label: 'Parent',
          base: 'parent',
          sections: [
            {
              kind: 'list',
              from: 'child',
              whose: 'parent_ref',
              empty: {
                title: 'No children yet',
                description: 'Add the first child.',
                action: { label: 'Browse children', to: 'children' },
              },
            },
          ],
        },
      ],
    },
    'test',
  );
  assert.deepEqual(parsePagesConfig({ pages: [pageConfig(page)] }, 'round trip')[0], page);
  // A matched list says what no match means the same way: the guidance reads and spells back.
  const matched = parsePagesConfig(
    {
      pages: [
        {
          label: 'Parent',
          base: 'parent',
          sections: [{ kind: 'list', from: 'parent', same: ['id'], empty: { title: 'No peers' } }],
        },
      ],
    },
    'test',
  )[0];
  assert.deepEqual((matched.sections[0] as { empty?: unknown }).empty, { title: 'No peers' });
  assert.deepEqual(parsePagesConfig({ pages: [pageConfig(matched)] }, 'round trip')[0], matched);
  for (const empty of [true, {}, { title: ' ' }, { title: 'No children', action: { label: '', to: 'children' } }]) {
    assert.throws(
      () =>
        parsePagesConfig(
          { pages: [{ label: 'Parent', base: 'parent', sections: [{ kind: 'list', from: 'child', whose: 'parent_ref', empty }] }] },
          'test',
        ),
      /empty/,
    );
  }
});

test("a related create starts where the child resource's New form starts, under what the create says for itself", async () => {
  const { resolvePageEmbeds } = await import('../packages/mistri/src/shared/appPages.js');
  const [page] = parsePagesConfig(
    {
      pages: [
        {
          label: 'Parent',
          base: 'parent',
          sections: [{ kind: 'list', from: 'child', whose: 'parent_ref', create: { label: 'Add child', defaults: { name: 'Mine' } } }],
        },
      ],
    },
    'test',
  );
  const app = { views: {}, resources: { child: { form: { defaults: { name: 'Form', tenant_id: 't1' } } } } } as unknown as Parameters<
    typeof resolvePageEmbeds
  >[0];
  const [resolved] = resolvePageEmbeds(app, [page], 'test');
  assert.deepEqual((resolved.sections[0] as { create?: { defaults?: unknown } }).create?.defaults, { name: 'Mine', tenant_id: 't1' });
});

test("a create names the child's other required references, which the record cannot fill", () => {
  const shop: DatabaseSchema = {
    label: 'Shop',
    dialect: 'sqlite',
    readAt: '',
    tables: [
      table('mechanic', ['id', 'name'], ['id']),
      table('bike', ['id', 'name'], ['id']),
      {
        ...table('work_order', ['id', 'mechanic_id', 'bike_id', 'note'], ['id']),
        columns: [
          { name: 'id', type: 'integer', nullable: false, primaryKey: true },
          { name: 'mechanic_id', type: 'integer', nullable: true, primaryKey: false },
          { name: 'bike_id', type: 'integer', nullable: false, primaryKey: false },
          { name: 'note', type: 'text', nullable: true, primaryKey: false },
        ],
      },
    ],
    foreignKeys: [
      { name: 'mechanic', from: { table: 'work_order', columns: ['mechanic_id'] }, to: { table: 'mechanic', columns: ['id'] } },
      { name: 'bike', from: { table: 'work_order', columns: ['bike_id'] }, to: { table: 'bike', columns: ['id'] } },
    ],
  };
  // From a mechanic, a work order still needs a bike: it is another parent's to say.
  assert.deepEqual(relatedCreatePlan(shop, 'mechanic', 'work_order', 'mechanic_id', { label: 'Add' }).otherParents, ['bike_id']);
  // From a bike, the mechanic may stay empty: nothing else is needed.
  assert.deepEqual(relatedCreatePlan(shop, 'bike', 'work_order', 'bike_id', { label: 'Add' }).otherParents, []);
  // A list pinned to one bike fills it.
  assert.deepEqual(
    relatedCreatePlan(shop, 'mechanic', 'work_order', 'mechanic_id', { label: 'Add' }, { filter: 'bike_id = 4' }).otherParents,
    [],
  );
});
