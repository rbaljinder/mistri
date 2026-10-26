import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseAppConfig, resolveResources, resolveValidation, resolveViews } from '../packages/mistri/src/shared/app.js';
import {
  evaluateFormCondition,
  evaluateFormRules,
  FORM_UNRESOLVED_MESSAGE,
  MAX_FORM_CONDITION,
  MAX_FORM_FIELDS,
  MAX_FORM_GROUPS,
  MAX_FORM_PREDICATES,
  MAX_FORM_RULES,
  MAX_FORM_CHILDREN,
  MAX_FORM_CHILD_ROWS,
  MAX_FORM_STEPS,
  MAX_FORM_STEP_FIELDS,
  evaluateFormChildren,
  parseAppForm,
  parseAppValidation,
  parseFormCondition,
  parseFormRules,
  referencedConditionFields,
  referencedRuleFields,
  validateAppForm,
  validateFormRules,
  validateFormChildren,
  type FormChildGroup,
  type FormCondition,
  type FormRule,
  type FormStep,
} from '../packages/mistri/src/shared/formRules.js';
import type { ColumnMeta, DatabaseSchema, TableMeta } from '../packages/engine/src/shared/schema.js';
import { quoteValue } from '../packages/engine/src/shared/query.js';

const column = (name: string, type: string): ColumnMeta => ({ name, type, nullable: true, primaryKey: false });
const columns = [
  column('id', 'BIGINT'),
  column('other_id', 'integer'),
  column('amount', 'numeric(30,9)'),
  column('cap', 'DECIMAL(30,9)'),
  column('enabled', 'boolean'),
  column('name', 'text'),
  column('status', 'varchar(20)'),
  column('day', 'date'),
  column('end_day', 'DATE'),
  column('local', 'timestamp without time zone'),
  column('instant', 'timestamp with time zone'),
  column('json', 'jsonb'),
];
const table: TableMeta = { id: 'items', name: 'items', schema: '', isView: false, columns };
const schema: DatabaseSchema = { label: 'Forms', dialect: 'sqlite', readAt: '2026-09-08', tables: [table], foreignKeys: [] };
/* A rule is a condition the record must meet, in the query language; so is a `when`. These write one comparison in it, so
   the evaluation tables below read by operator. */
type Operator = 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
const OPERATORS: readonly Operator[] = ['eq', 'ne', 'lt', 'lte', 'gt', 'gte'];
const SYMBOL: Record<Operator, string> = { eq: '=', ne: '!=', lt: '<', lte: '<=', gt: '>', gte: '>=' };
const required: FormRule = { must: 'name is not empty', message: 'Enter a name.' };
const requiredOf = (field: string): FormRule => ({ ...required, must: `${field} is not empty` });
const comparison: FormRule = { must: 'amount <= cap', message: 'Amount exceeds the cap.' };
const comparisonWith = (operator: Operator): FormRule => ({ ...comparison, must: `amount ${SYMBOL[operator]} cap` });
const enabled: FormCondition = 'enabled = true';
const cond = (field: string, operator: Operator, value: string | number | boolean | null): FormCondition =>
  value === null
    ? `${field} ${operator === 'eq' ? 'is empty' : operator === 'ne' ? 'is not empty' : `${SYMBOL[operator]} null`}`
    : `${field} ${SYMBOL[operator]} ${typeof value === 'string' ? quoteValue(value) : String(value)}`;
const rules: FormRule[] = [{ ...required, when: enabled }, comparison];

test('strict capture copies and freezes the complete contract without changing author data', () => {
  const raw = { items: rules.map((r) => ({ ...r })) };
  const captured = parseAppValidation(raw);
  assert.deepEqual(captured, raw);
  assert.notEqual(captured.items, raw.items);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured.items) && Object.isFrozen(captured.items[0].when));
  raw.items[0].message = 'Changed';
  assert.equal(captured.items[0].message, 'Enter a name.');
  const input = { defaults: { enabled: false }, groups: [{ label: 'Details', fields: ['name'] }], when: { name: enabled } };
  const form = parseAppForm(input);
  input.groups[0].fields.push('enabled');
  input.when.name = 'enabled != false';
  assert.deepEqual(form.groups?.[0].fields, ['name']);
  assert.deepEqual(form.when?.name, enabled);
  assert.ok(Object.isFrozen(form.defaults) && Object.isFrozen(form.groups?.[0].fields));
});

test('repeatable child groups are strict, bounded, copied, and never nest', () => {
  const input = {
    show: ['id'],
    children: [
      {
        id: 'contacts',
        label: 'Contacts',
        table: 'contact',
        relation: { from: 'item_id', to: 'id' },
        min: 1,
        max: 3,
        form: { groups: [{ label: 'Contact', fields: ['name'] }] },
      },
    ],
  };
  const captured = parseAppForm(input);
  assert.deepEqual(captured.children?.[0], { ...input.children[0], form: { ...input.children[0].form, show: ['name'] } });
  assert.ok(Object.isFrozen(captured.children) && Object.isFrozen(captured.children?.[0]));
  input.children[0].form.groups[0].fields.push('email');
  assert.deepEqual(captured.children?.[0].form?.show, ['name']);
  const valid = input.children[0];
  for (const bad of [
    { ...valid, id: 'Contacts' },
    { ...valid, max: 0 },
    { ...valid, min: 4 },
    { ...valid, max: MAX_FORM_CHILD_ROWS + 1 },
    { ...valid, form: { children: [valid] } },
    { ...valid, relation: { from: 'item.id', to: 'id' } },
    { ...valid, extra: true },
  ])
    assert.throws(() => parseAppForm({ children: [bad] }), /invalid form declaration|has no "(children|extra)"/);
  assert.throws(() => parseAppForm({ children: [valid, { ...valid }] }), /invalid form declaration/);
  assert.throws(
    () => parseAppForm({ children: Array.from({ length: MAX_FORM_CHILDREN + 1 }, (_, i) => ({ ...valid, id: `child-${i}` })) }),
    /invalid form declaration/,
  );
});

test('repeatable children validate declared FK, cardinality, parent linkage, and child rules', () => {
  const child: TableMeta = {
    id: 'contact',
    name: 'contact',
    schema: '',
    isView: false,
    columns: [column('id', 'BIGINT'), column('item_id', 'BIGINT'), column('name', 'text')],
  };
  const catalog: DatabaseSchema = {
    ...schema,
    tables: [table, child],
    foreignKeys: [
      {
        name: 'contact_item',
        from: { table: 'contact', columns: ['item_id'] },
        to: { table: 'items', columns: ['id'] },
      },
    ],
  };
  const group: FormChildGroup = {
    id: 'contacts',
    label: 'Contacts',
    table: 'contact',
    relation: { from: 'item_id', to: 'id' },
    min: 1,
    max: 2,
    form: { show: ['name'] },
  };
  assert.deepEqual(validateFormChildren([group], table, catalog), []);
  assert.match(validateFormChildren([{ ...group, relation: { from: 'name', to: 'id' } }], table, catalog).join('\n'), /foreign-key/);
  const validation = new Map([['contact', [{ must: 'name is not empty', message: 'Name is required.' }]]]);
  const good = evaluateFormChildren([group], { id: 7 }, { contacts: { rows: [{ item_id: 7, name: 'Ada' }] } }, catalog, validation);
  assert.deepEqual(good, { valid: true, errors: {}, unresolved: [] });
  const bad = evaluateFormChildren([group], { id: 7 }, { contacts: { rows: [{ item_id: 8, name: '' }] } }, catalog, validation);
  assert.equal(bad.valid, false);
  assert.deepEqual(bad.errors, {
    'contacts[0].item_id': ['This item belongs to a different parent.'],
    'contacts[0].name': ['Name is required.'],
  });
  const missing = evaluateFormChildren([group], { id: 7 }, { contacts: { rows: [] } }, catalog, validation);
  assert.deepEqual(missing.errors, { contacts: ['Add between 1 and 2 items.'] });
  const unresolved = evaluateFormChildren([group], {}, { contacts: { rows: [{ name: 'Ada' }] } }, catalog, validation);
  assert.equal(unresolved.valid, false);
  assert.ok(unresolved.unresolved.includes('contacts'));
});

test('multi-step forms are strict, finite, copied, and field-owned by stable step IDs', () => {
  const input = {
    steps: [
      { id: 'identity', label: 'Identity', fields: ['name'] },
      { id: 'state', label: 'State', fields: ['status', 'enabled'] },
    ],
  };
  const captured = parseAppForm(input);
  assert.deepEqual(captured.steps, input.steps);
  assert.ok(Object.isFrozen(captured.steps) && Object.isFrozen(captured.steps?.[0]) && Object.isFrozen(captured.steps?.[0].fields));
  input.steps[0].fields.push('status');
  assert.deepEqual(captured.steps?.[0].fields, ['name']);
  const valid: FormStep = { id: 'identity', label: 'Identity', fields: ['name'] };
  for (const bad of [
    { ...valid, id: 'Identity' },
    { ...valid, id: 'identity.step' },
    { ...valid, label: '' },
    { ...valid, fields: [] },
    { ...valid, fields: ['name', 'name'] },
    { ...valid, onNext: () => true },
    { ...valid, fields: ['customer.name'] },
  ])
    assert.throws(() => parseAppForm({ steps: [bad] }), /invalid form declaration|has no "onNext"|names "name" twice/);
  assert.throws(() => parseAppForm({ steps: [valid, { ...valid, id: 'second' }] }), /invalid form declaration/);
  assert.throws(() => parseAppForm({ steps: [valid, { ...valid, fields: ['status'] }] }), /two steps are "identity"/);
  assert.throws(
    () =>
      parseAppForm({ steps: Array.from({ length: MAX_FORM_STEPS + 1 }, (_, i) => ({ id: `step-${i}`, label: 'Step', fields: ['name'] })) }),
    /invalid form declaration/,
  );
  assert.throws(
    () => parseAppForm({ steps: [{ ...valid, fields: Array.from({ length: MAX_FORM_STEP_FIELDS + 1 }, (_, i) => `field-${i}`) }] }),
    /invalid form declaration/,
  );
});

test('multi-step structural validation requires exact ownership, readable fields, and step-local groups', () => {
  const steps = [
    { id: 'identity', label: 'Identity', fields: ['name'] },
    { id: 'state', label: 'State', fields: ['status', 'enabled'] },
  ] satisfies FormStep[];
  assert.deepEqual(validateAppForm({ steps }, table), []);
  assert.match(validateAppForm({ steps: [{ ...steps[0], fields: ['missing'] }, steps[1]] }, table).join('\n'), /unknown or hidden/);
  assert.match(
    validateAppForm({ steps, groups: [{ label: 'Cross-step', fields: ['name', 'status'] }] }, table).join('\n'),
    /span multiple steps/,
  );
  assert.match(validateAppForm({ steps, groups: [{ label: 'Outside', fields: ['amount'] }] }, table).join('\n'), /outside the form steps/);
  assert.deepEqual(validateAppForm({ steps, when: { name: enabled } }, table), []);
});

test('steps without show must supply required columns or defaults just like an explicit selection', () => {
  const requiredTable = {
    ...table,
    columns: table.columns.map((column) => (column.name === 'name' ? { ...column, nullable: false } : column)),
  };
  const steps = [{ id: 'state', label: 'State', fields: ['status'] }];
  const expected = validateAppForm({ steps }, requiredTable);
  assert.match(expected.join('\n'), /requires "name"/);
  assert.deepEqual(validateAppForm({ steps }, requiredTable), expected);
  assert.deepEqual(validateAppForm({ steps, defaults: { name: 'Draft' } }, requiredTable), []);
});

test('a condition is query-language text: comparisons of local columns, nothing a record cannot answer', () => {
  const comparisons = (n: number) => Array.from({ length: n }, () => enabled).join(' and ');
  const bad: unknown[] = [
    null,
    [],
    () => true,
    new Date(),
    {},
    1,
    true,
    new String(enabled),
    { field: 'enabled', operator: 'eq', value: true },
    { all: [enabled] },
    '',
    '   ',
    'enabled',
    'enabled = ',
    'customer.name = Ada',
    'name contains Ada',
    'name like A%',
    'name startswith A',
    'enabled = true sort name',
    'enabled = true limit 3',
    'enabled = true show name',
    comparisons(MAX_FORM_PREDICATES + 1),
    `name = ${'x'.repeat(MAX_FORM_CONDITION)}`,
  ];
  for (const declaration of bad) assert.throws(() => parseFormCondition(declaration), /Condition: /);
  for (const good of [
    enabled,
    comparisons(MAX_FORM_PREDICATES),
    'status in (open, held) and (amount > 10 or name is empty)',
    'day >= 2026-01-01',
    'name is not empty',
    '  enabled = true  ',
  ])
    assert.equal(parseFormCondition(good), good.trim());
  // `or` multiplies out before it is counted: two branches of nine are eighteen comparisons.
  assert.throws(() => parseFormCondition(`(${comparisons(9)}) or (${comparisons(9)})`), /at most 16/);
});

test('captures do not invoke getters, coercion hooks or inherited properties', () => {
  let reads = 0;
  for (const value of [
    {
      toString() {
        reads++;
        return enabled;
      },
    },
    Object.create({ enabled }),
    [enabled],
  ]) {
    assert.throws(() => parseFormCondition(value));
  }
  const visible = Object.defineProperty({}, 'name', {
    enumerable: true,
    get() {
      reads++;
      return enabled;
    },
  });
  assert.throws(() => parseAppForm({ when: visible }));
  assert.throws(() => parseAppValidation(JSON.parse('{"__proto__":[]}')));
  assert.throws(() => parseAppForm({ defaults: JSON.parse('{"constructor":0}') }));
  // Through the App: a resource block's rules reach the strict capture, which refuses an accessor unread.
  const rule = Object.defineProperty({ ...required }, 'message', {
    enumerable: true,
    get() {
      reads++;
      return 'secret';
    },
  });
  assert.throws(() => parseAppConfig({ name: 'Bad', resources: { items: { validation: [rule] } } }, 'App'));
  assert.equal(reads, 0);
});

test('rules enforce their discriminants, static messages, local references and limits', () => {
  for (const rule of [
    { ...required, operator: 'eq' },
    { ...required, other: 'id' },
    { ...required, when: undefined },
    { ...required, kind: 'script' },
    { ...comparison, other: 'account.id' },
    { ...comparison, other: undefined },
    { ...required, message: '' },
    { ...required, message: 'secret\nvalue' },
    { ...required, message: 'x'.repeat(257) },
  ]) {
    assert.throws(() => parseFormRules([rule]));
  }
  assert.throws(() => parseFormRules(Array.from({ length: 129 }, () => required)));
  assert.doesNotThrow(() => parseFormRules(Array.from({ length: 128 }, () => required)));
  assert.throws(() => parseAppValidation({ ' items ': [] }));
  assert.deepEqual(referencedRuleFields(rules), ['name', 'enabled', 'amount']);
  assert.deepEqual(referencedConditionFields('enabled = true or enabled = false'), ['enabled']);
  assert.deepEqual(referencedConditionFields('name is empty and (amount > 1 or status in (open, held))'), ['name', 'amount', 'status']);
});

test('numeric conditions compare DB and UI representations exactly using actual column metadata', () => {
  const check = (field: string, value: string | number, raw: unknown, operator: Operator = 'eq') =>
    evaluateFormCondition(cond(field, operator, value), { [field]: raw }, columns);
  assert.equal(check('id', '9007199254740993', '9007199254740993'), true);
  assert.equal(check('id', '9007199254740992', '9007199254740993'), false);
  assert.equal(check('id', '9007199254740992', '9007199254740993', 'gt'), true);
  assert.equal(check('id', '9007199254740993', Number(9007199254740993n)), 'unknown');
  assert.equal(check('id', '9007199254740993', 9007199254740993n), true);
  assert.equal(check('id', 3, '  +3.000e0 '), true);
  assert.equal(check('id', '3.1', '3.1'), 'unknown');
  assert.equal(check('amount', '1.0000000000000000001', '1.0000000000000000002', 'gt'), true);
  assert.equal(check('amount', '1e-100', '0.1e-99'), true);
  assert.equal(check('amount', '-2', '-10', 'lt'), true);
  assert.equal(check('amount', '0', '-0.000'), true);
  assert.equal(check('amount', '0.5', '.5'), true);
  assert.equal(check('name', '001', '1'), false, 'numeric-looking text remains text');
  assert.equal(check('name', '1', 1), 'unknown');
  for (const raw of ['', ' ', '0x10', 'Infinity', '1e99999', '1e4097', NaN, Infinity, {}, [], undefined]) {
    assert.equal(check('amount', 1, raw, 'ne'), 'unknown');
  }
});

test('all six numeric operators preserve comparison direction and equality', () => {
  const expected = { eq: false, ne: true, lt: true, lte: true, gt: false, gte: false };
  for (const operator of OPERATORS) {
    assert.equal(evaluateFormCondition(cond('amount', operator, '10'), { amount: '2' }, columns), expected[operator]);
    assert.equal(evaluateFormCondition(cond('amount', operator, '2.0'), { amount: 2 }, columns), ['eq', 'lte', 'gte'].includes(operator));
  }
});

test('boolean and temporal representations normalize without locale, clock or precision loss', () => {
  for (const value of [true, 1, 1n, 'true', 'TRUE', 't', 'yes', ' 1 '])
    assert.equal(evaluateFormCondition(enabled, { enabled: value }, columns), true);
  for (const value of [false, 0, 0n, 'false', 'f', 'no', '0'])
    assert.equal(evaluateFormCondition(enabled, { enabled: value }, columns), false);
  assert.equal(evaluateFormCondition(enabled, { enabled: 2 }, columns), 'unknown');
  const matches = (field: string, value: string, raw: unknown) =>
    evaluateFormCondition(cond(field, 'eq', value), { [field]: raw }, columns);
  assert.equal(matches('day', '2024-02-29', '2024-02-29'), true);
  assert.equal(matches('day', '2023-02-29', '2023-02-29'), 'unknown');
  assert.equal(matches('day', '2026-01-01', '01/01/2026'), 'unknown');
  assert.equal(matches('local', '2026-09-08T09:01', '2026-09-08 09:01:00.000000000'), true);
  assert.equal(matches('local', '2026-09-08T09:01', '2026-09-08T09:01:00Z'), 'unknown');
  assert.equal(matches('instant', '2026-09-08T13:01:00Z', '2026-09-08 09:01:00-04'), true);
  assert.equal(matches('instant', '2026-09-08T13:01:00.123456789Z', '2026-09-08 09:01:00.123456788-04:00'), false);
  assert.equal(matches('instant', '2026-09-08T13:01:00Z', new Date('2026-09-08T13:01:00Z')), true);
  for (const value of ['2026-09-08T24:00:00Z', '2026-09-08T09:00:60Z', '2026-09-08T09:00:00+14:01', '2026-09-08T09:00:00']) {
    assert.equal(matches('instant', '2026-09-08T13:01:00Z', value), 'unknown');
  }
});

test('missing, inherited, accessor, unsupported and uncomparable fields remain unknown, including ne', () => {
  assert.equal(evaluateFormCondition(cond('missing', 'ne', 1), {}, columns), 'unknown');
  assert.equal(evaluateFormCondition(enabled, Object.create({ enabled: true }), columns), 'unknown');
  assert.equal(
    evaluateFormCondition(
      enabled,
      Object.defineProperty({}, 'enabled', {
        get() {
          throw new Error('Do not execute');
        },
      }),
      columns,
    ),
    'unknown',
  );
  assert.equal(evaluateFormCondition(enabled, { enabled: true }, [...columns, column('enabled', 'boolean')]), 'unknown');
  assert.equal(evaluateFormCondition(cond('json', 'eq', '{}'), { json: '{}' }, columns), 'unknown');
  assert.equal(evaluateFormCondition(cond('name', 'lt', 'b'), { name: 'a' }, columns), 'unknown');
  assert.equal(evaluateFormCondition(cond('enabled', 'gt', false), { enabled: true }, columns), 'unknown');
  assert.equal(evaluateFormCondition(cond('name', 'eq', null), { name: null }, columns), true);
  assert.equal(evaluateFormCondition(cond('name', 'ne', null), {}, columns), 'unknown');
  assert.equal(evaluateFormCondition('status in (open, held)', { status: 'held' }, columns), true);
  assert.equal(evaluateFormCondition('status in (open, held)', { status: 'closed' }, columns), false);
  assert.equal(evaluateFormCondition('status in (open, held)', {}, columns), 'unknown');
});

test('and / or keep unknown dependencies visible instead of short-circuiting them away', () => {
  assert.equal(evaluateFormCondition('enabled = true and name = Ready', { enabled: true, name: 'Ready' }, columns), true);
  assert.equal(evaluateFormCondition('enabled = true or name = Ready', { enabled: false, name: 'Ready' }, columns), true);
  assert.equal(evaluateFormCondition('enabled = true and name = Ready', { enabled: false }, columns), 'unknown');
  assert.equal(evaluateFormCondition('enabled = true or name = Ready', { enabled: true }, columns), 'unknown');
  assert.equal(
    evaluateFormCondition('enabled = true and (name = Ready or amount > 5)', { enabled: true, name: 'No', amount: 6 }, columns),
    true,
  );
  assert.equal(
    evaluateFormCondition('enabled = true and (name = Ready or amount > 5)', { enabled: true, name: 'No', amount: 4 }, columns),
    false,
  );
});

test('full-row rules return static per-field errors and accept zero/false as required values', () => {
  assert.deepEqual(evaluateFormRules(rules, { name: 'Ready', enabled: 1, amount: '2.00', cap: 3 }, columns), {
    valid: true,
    errors: {},
    unresolved: [],
  });
  const invalid = evaluateFormRules(rules, { name: ' ', enabled: 'true', amount: '4', cap: '3' }, columns);
  assert.deepEqual(invalid, { valid: false, errors: { name: ['Enter a name.'], amount: ['Amount exceeds the cap.'] }, unresolved: [] });
  for (const [field, value] of [
    ['enabled', false],
    ['amount', 0],
    ['amount', '0'],
  ] as const) {
    assert.equal(evaluateFormRules([requiredOf(field)], { [field]: value }, columns).valid, true);
  }
  assert.equal(evaluateFormRules([{ ...required, when: enabled }], { enabled: false }, columns).valid, true);
  assert.deepEqual(evaluateFormRules([required, required], { name: null }, columns).errors, { name: ['Enter a name.'] });
});

test('authoritative missing values reject; preview is explicitly unresolved and never claims validity', () => {
  const authoritative = evaluateFormRules(rules, {}, columns);
  assert.deepEqual(authoritative, {
    valid: false,
    errors: { name: [FORM_UNRESOLVED_MESSAGE], amount: [FORM_UNRESOLVED_MESSAGE] },
    unresolved: ['name', 'amount'],
  });
  assert.deepEqual(evaluateFormRules(rules, {}, columns, { mode: 'preview' }), {
    valid: false,
    errors: {},
    unresolved: ['name', 'amount'],
  });
  assert.equal(evaluateFormRules(rules, {}, columns, { mode: 'authoritative' }).valid, false);
  assert.deepEqual(evaluateFormRules([required], { name: '' }, columns, { mode: 'preview' }).errors, { name: ['Enter a name.'] });
  assert.equal(evaluateFormRules([requiredOf('day')], { day: 'secret-invalid-date' }, columns).valid, false);
  for (const operator of OPERATORS.filter((o) => o !== 'eq' && o !== 'ne')) {
    assert.equal(evaluateFormRules([comparisonWith(operator)], { amount: null, cap: null }, columns).valid, false);
  }
  const secret = 'private-row-value-7e25';
  assert.doesNotMatch(JSON.stringify(evaluateFormRules([comparison], { amount: secret, cap: 0 }, columns)), new RegExp(secret));
  assert.equal(evaluateFormRules([comparison], { amount: '2' }, columns).valid, false, 'no invented default or update merge');
});

test('schema validation checks local dependencies, compatible metadata and scalar literals', () => {
  assert.deepEqual(validateFormRules(rules, table), []);
  for (const rule of [
    requiredOf('missing'),
    requiredOf('json'),
    { ...comparison, must: 'amount <= name' },
    { ...comparison, must: 'amount <= missing' },
  ] as FormRule[]) {
    const problems = validateFormRules([rule], table);
    assert.ok(problems.length);
  }
  /* A condition is the author's own text, so its problems may quote it — the
     query parser says where it stopped reading. */
  for (const condition of ['amount = private-invalid-literal', 'name < z', 'missing = 1', 'day = 2023-02-29']) {
    assert.ok(validateFormRules([{ ...required, when: condition }], table).length, condition);
  }
});

/** A comparison with a constant is said the way every comparison is: in `must`. */
const constantOf = (field: string, operator: Operator, value: string | number | boolean | null): FormRule => ({
  must: cond(field, operator, value),
  when: enabled,
  message: 'An enabled amount is 100.',
});
const constant = constantOf('amount', 'eq', 100);

test('a rule is must, when and message, and nothing else', () => {
  const captured = parseFormRules([constant]);
  assert.deepEqual(captured, [constant]);
  assert.ok(Object.isFrozen(captured[0]));
  for (const bad of [
    { ...constant, other: 'cap' },
    { ...comparison, value: 1 },
    { ...required, field: 'name' },
    { ...constant, kind: 'compare' },
    { ...constant, must: 100 },
    { ...constant, must: '' },
    { when: enabled, message: 'Neither side.' },
  ]) {
    assert.throws(() => parseFormRules([bad]));
  }
  assert.deepEqual(referencedRuleFields([constant]), ['amount', 'enabled']);
});

test('a constant is typed against its column like a when literal', () => {
  assert.deepEqual(
    validateFormRules(
      [
        constant,
        constantOf('status', 'ne', 'closed'),
        constantOf('day', 'gte', '2026-01-01'),
        constantOf('enabled', 'eq', false),
        constantOf('id', 'eq', '9007199254740993'),
      ],
      table,
    ),
    [],
  );
  for (const rule of [
    constantOf('amount', 'eq', 'private-invalid-literal'),
    constantOf('id', 'eq', 1.5),
    constantOf('name', 'lt', 'b'),
    constantOf('enabled', 'gt', false),
    constantOf('day', 'eq', '2023-02-29'),
    constantOf('json', 'eq', '{}'),
    constantOf('missing', 'eq', 100),
  ]) {
    const problems = validateFormRules([rule], table);
    assert.ok(problems.length, JSON.stringify(rule));
    assert.doesNotMatch(problems.join(' '), /private-invalid-literal/);
  }
});

test('a constant comparison evaluates like a predicate; a null field gives no ordering, in either mode', () => {
  const row = (amount: unknown, on: unknown = true) => ({ amount, enabled: on });
  assert.deepEqual(evaluateFormRules([constant], row('100.00'), columns), { valid: true, errors: {}, unresolved: [] });
  assert.deepEqual(evaluateFormRules([constant], row(55), columns), {
    valid: false,
    errors: { amount: ['An enabled amount is 100.'] },
    unresolved: [],
  });
  assert.deepEqual(evaluateFormRules([constant], row(55), columns, { mode: 'preview' }), {
    valid: false,
    errors: { amount: ['An enabled amount is 100.'] },
    unresolved: [],
  });
  assert.equal(evaluateFormRules([constant], row(55, false), columns).valid, true, 'a false when skips the rule');
  assert.deepEqual(
    evaluateFormRules([constant], { amount: 55 }, columns, { mode: 'preview' }).unresolved,
    ['amount'],
    'an unknown when cannot disable it',
  );
  const expected = { eq: false, ne: true, lt: true, lte: true, gt: false, gte: false };
  for (const operator of OPERATORS) {
    const rule = constantOf('amount', operator, 100);
    assert.equal(evaluateFormRules([rule], row('2'), columns).valid, expected[operator]);
    assert.equal(
      evaluateFormRules([rule], row('2'), columns).valid,
      evaluateFormCondition(cond('amount', operator, 100), { amount: '2' }, columns),
    );
    // Equality against a null is decided (not equal); an ordering has no answer for it.
    if (operator === 'eq' || operator === 'ne') continue;
    assert.deepEqual(evaluateFormRules([rule], row(null), columns), {
      valid: false,
      errors: { amount: [FORM_UNRESOLVED_MESSAGE] },
      unresolved: ['amount'],
    });
    assert.deepEqual(evaluateFormRules([rule], row(null), columns, { mode: 'preview' }), {
      valid: false,
      errors: {},
      unresolved: ['amount'],
    });
  }
  const open: FormRule = { must: 'status = open', message: 'Stays open.' };
  assert.equal(evaluateFormRules([open], { status: 'open' }, columns).valid, true);
  assert.deepEqual(evaluateFormRules([open], { status: 'closed' }, columns).errors, { status: ['Stays open.'] });
  const secret = 'private-row-value-4b1c';
  assert.doesNotMatch(JSON.stringify(evaluateFormRules([constant], row(secret), columns)), new RegExp(secret));
});

test('form groups cannot duplicate, add unknown/hidden fields or override show and access', () => {
  assert.throws(() => parseAppForm({ show: ['name', 'name'] }));
  assert.throws(() =>
    parseAppForm({
      groups: [
        { label: 'One', fields: ['name'] },
        { label: 'Two', fields: ['name'] },
      ],
    }),
  );
  assert.throws(() => parseAppForm({ groups: [{ label: 'Empty', fields: [] }] }));
  assert.throws(() => parseAppForm({ show: ['name'], groups: [{ label: 'Hidden', fields: ['amount'] }] }), /Keep one/);
  assert.throws(() => parseAppForm({ show: ['name'], when: { amount: enabled } }));
  assert.ok(validateAppForm({ groups: [{ label: 'Unknown', fields: ['ghost'] }] }, table).length);
  assert.ok(validateAppForm({ groups: [{ label: 'Hidden', fields: ['amount'] }] }, table, ['name']).length);
  assert.deepEqual(validateAppForm({ show: ['name'], when: { name: enabled } }, table), []);
  assert.ok(validateAppForm({ when: { name: enabled } }, table, ['name']).includes('Form visibility depends on an unreadable field.'));
  const form = parseAppForm({
    groups: [
      { label: 'Details', fields: ['name'] },
      { label: 'More', fields: ['enabled'] },
    ],
  });
  assert.deepEqual(form.show, ['name', 'enabled'], 'the groups are what the form asks');
});

test('normalized App carries resource validation independently of forms and catalog-checks resources without nav', () => {
  const app = parseAppConfig(
    {
      name: 'Forms',
      resources: { items: { validation: rules, form: { groups: [{ label: 'Details', fields: ['name'] }], when: { name: enabled } } } },
      views: {
        items: { kind: 'list', from: 'items' },
        amounts: { kind: 'list', from: 'items', label: 'Amounts', show: ['amount', 'cap'] },
      },
      home: 'items',
      nav: ['items', 'amounts'],
    },
    'App',
  );
  assert.deepEqual(app.resources?.items.validation, rules);
  assert.deepEqual(resolveValidation(app, schema), { validation: { items: rules }, warnings: [] });
  assert.ok(Object.values(resolveViews(app, schema)).every((view) => !view.error));
  assert.deepEqual(resolveResources(app, schema).problems, []);
  const invalid = parseAppConfig(
    {
      name: 'No navigation',
      resources: { items: { validation: [requiredOf('ghost')] } },
      views: { items: { kind: 'list', from: 'items' } },
      home: 'items',
    },
    'App',
  );
  assert.equal(resolveValidation(invalid, schema).warnings.length, 1);
  /* A resource the catalog lacks is refused like every other unknown name,
     not carried as a warning a caller could forget to read. */
  const unknown = parseAppConfig(
    {
      name: 'No navigation',
      resources: { items: {}, missing: { validation: [] } },
      views: { items: { kind: 'list', from: 'items' } },
      home: 'items',
    },
    'App',
  );
  assert.throws(() => resolveValidation(unknown, schema), /validation: unknown or ambiguous resource "missing"/);
  const view = { views: { items: { kind: 'list', from: 'items' } }, home: 'items', nav: ['items'] };
  assert.throws(() =>
    parseAppConfig(
      { name: 'Bad', views: { items: { kind: 'list', from: 'items', validation: rules } }, home: 'items', nav: ['items'] },
      'App',
    ),
  );
  assert.throws(() => parseAppConfig({ name: 'Bad', resources: { items: { form: { validation: rules } } }, ...view }, 'App'));
  const invalidForm = parseAppConfig(
    { name: 'Bad', resources: { items: { form: { groups: [{ label: 'Ghost', fields: ['ghost'] }] } } }, ...view },
    'App',
  );
  assert.match(resolveResources(invalidForm, schema).problems.join('\n'), /has no column "ghost"/);
});

test('root resolution rejects aliases that would overwrite a resource rule list', () => {
  const qualified = { ...schema, tables: [{ ...table, id: 'public.items', schema: 'public' }] };
  /* Two names for one table: the second would overwrite the first's rule
     list. Authored keys are unique logical names, so this is the
     resolve-time guard read directly, on an internal AppDef whose rules name
     the table twice — a bare name and its qualified id. */
  const app = {
    ...parseAppConfig(
      { name: 'Duplicate', resources: { items: {} }, views: { items: { kind: 'list', from: 'items' } }, home: 'items' },
      'App',
    ),
    resources: { items: { validation: [required] }, 'public.items': { validation: [comparison] } },
  };
  assert.match(resolveValidation(app, qualified).warnings.join(' '), /duplicate resource identity/);
});

test('richer form checks preserve manual keys, required omissions, NOT NULL defaults and ALWAYS identities', () => {
  const manual: TableMeta = {
    ...table,
    columns: [
      { ...column('id', 'integer'), primaryKey: true, nullable: false },
      { ...column('name', 'text'), nullable: false },
    ],
  };
  const form = { groups: [{ label: 'Details', fields: ['name'] }] };
  const app = parseAppConfig(
    { name: 'Required', resources: { items: { form } }, views: { items: { kind: 'list', from: 'items' } }, home: 'items', nav: ['items'] },
    'App',
  );
  const check = (resource: TableMeta) => resolveResources(app, { ...schema, tables: [resource] }).problems[0];
  assert.match(check(manual) ?? '', /requires "id"/);
  assert.deepEqual(validateAppForm({ ...form, defaults: { id: 1 } }, manual), []);
  assert.match(validateAppForm({ defaults: { name: null } }, manual).join(' '), /cannot default to null \(NOT NULL\)/);
  const automatic: TableMeta = { ...manual, columns: [{ ...manual.columns[0], identity: 'always' }, manual.columns[1]] };
  assert.equal(check(automatic), undefined);
  assert.match(validateAppForm({ ...form, defaults: { id: 1 } }, automatic).join(' '), /always assigned by the database/);
  const defaulted = { ...manual, columns: [{ ...manual.columns[0], default: '1' }, manual.columns[1]] };
  assert.equal(check(defaulted), undefined);
});

// Dependency-free JSON Schema checks for the exact subset used by form defs.
// Semantic catalog/access and cross-group membership checks remain App checks.
type JsonSchema = { [key: string]: any };
const publicSchema: JsonSchema = JSON.parse(readFileSync(new URL('../packages/mistri/schema/app.schema.json', import.meta.url), 'utf8'));
function schemaAccepts(value: unknown, s: JsonSchema): boolean {
  if (s.$ref) return schemaAccepts(value, publicSchema.$defs[s.$ref.split('/').at(-1)]);
  if (s.allOf && !s.allOf.every((part: JsonSchema) => schemaAccepts(value, part))) return false;
  if (s.oneOf && s.oneOf.filter((part: JsonSchema) => schemaAccepts(value, part)).length !== 1) return false;
  if (s.not && schemaAccepts(value, s.not)) return false;
  if (s.enum && !s.enum.includes(value)) return false;
  if (Object.hasOwn(s, 'const') && s.const !== value) return false;
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (s.type && !(Array.isArray(s.type) ? s.type : [s.type]).includes(type)) return false;
  if (typeof value === 'number' && (!Number.isFinite(value) || value < (s.minimum ?? -Infinity) || value > (s.maximum ?? Infinity)))
    return false;
  if (
    typeof value === 'string' &&
    (value.length < (s.minLength ?? 0) ||
      value.length > (s.maxLength ?? Infinity) ||
      (s.pattern && !new RegExp(s.pattern, 'u').test(value)))
  )
    return false;
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? Infinity)) return false;
    if (s.uniqueItems && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) return false;
    if (s.items && !value.every((v) => schemaAccepts(v, s.items))) return false;
  } else if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length > (s.maxProperties ?? Infinity) || s.required?.some((key: string) => !Object.hasOwn(value, key))) return false;
    for (const [key, item] of Object.entries(value)) {
      if (s.propertyNames && !schemaAccepts(key, s.propertyNames)) return false;
      if (s.properties?.[key]) {
        if (!schemaAccepts(item, s.properties[key])) return false;
      } else if (s.additionalProperties === false) return false;
      else if (s.additionalProperties && !schemaAccepts(item, s.additionalProperties)) return false;
    }
  }
  return true;
}

test('public JSON Schema pins operator/bounds and agrees with strict form shape parsing', () => {
  const defs = publicSchema.$defs;
  // Validation is a resource block's list of rules; the root has no resource-keyed map.
  assert.equal(publicSchema.properties.validation, undefined);
  assert.equal(defs.resource.properties.validation.$ref, '#/$defs/formRules');
  assert.equal(defs.formCondition.type, 'string');
  assert.equal(defs.formCondition.maxLength, MAX_FORM_CONDITION);
  assert.equal(defs.formRules.maxItems, MAX_FORM_RULES);
  assert.equal(defs.formRowFieldList.maxItems, MAX_FORM_FIELDS);
  assert.equal(defs.formGroups.maxItems, MAX_FORM_GROUPS);
  const cases: [JsonSchema, (raw: unknown) => unknown, unknown[]][] = [
    [
      defs.formCondition,
      parseFormCondition,
      [enabled, '', null, { field: 'enabled', operator: 'eq', value: true }, { all: [] }, `name = ${'x'.repeat(MAX_FORM_CONDITION)}`],
    ],
    [
      defs.formRules,
      parseFormRules,
      [
        [],
        rules,
        [{ ...required, other: 'id' }],
        [{ ...required, when: null }],
        [{ ...comparison, other: undefined }],
        [{ ...required, message: '\n' }],
        [constant],
        [{ ...constant, value: null }],
        [{ ...constant, other: 'cap' }],
        [{ ...comparison, value: 1 }],
        [{ ...required, value: 1 }],
        [{ ...constant, value: {} }],
      ],
    ],
    [
      defs.resource.properties.form,
      parseAppForm,
      [
        {},
        { defaults: { name: 'Draft' }, groups: [{ label: 'Details', fields: ['name'] }], when: { name: enabled } },
        { steps: [{ id: 'identity', label: 'Identity', fields: ['name'] }] },
        { show: ['name', 'name'] },
        { show: [['name', 'status'], 'amount'] },
        { show: [['name', 'status', 'amount', 'cap']] },
        { show: [[]] },
        { groups: [{ label: 'Pair', fields: [['name', 'status']] }] },
        { when: [] },
        { groups: [{ label: 'Empty', fields: [] }] },
        { validation: rules },
      ],
    ],
  ];
  for (const [declaration, parse, examples] of cases) {
    for (const raw of examples) {
      let parsed = true;
      try {
        parse(raw);
      } catch {
        parsed = false;
      }
      assert.equal(schemaAccepts(raw, declaration), parsed);
    }
  }
});

test('a form dresses its fields: captions, help, placeholders, lines, a narrowed reference, its own sentence and frame', () => {
  const form = parseAppForm({
    description: 'One sentence.',
    open: 'page',
    groups: [
      { label: 'About', description: 'What it is.', fields: ['name', 'status'] },
      { label: 'Link', fields: ['other_id'] },
    ],
    fields: {
      name: { label: 'Title', help: 'Start with a verb.', placeholder: 'Write…', multiline: true },
      other_id: { where: { owner_id: 'status' } },
    },
  });
  assert.equal(form.description, 'One sentence.');
  assert.equal(form.open, 'page');
  assert.deepEqual(form.groups, [
    { label: 'About', description: 'What it is.', fields: ['name', 'status'] },
    { label: 'Link', fields: ['other_id'] },
  ]);
  assert.deepEqual(form.fields?.other_id, { where: { owner_id: 'status' } });
  assert.ok(Object.isFrozen(form.fields) && Object.isFrozen(form.fields?.name));
  for (const [bad, said] of [
    [{ open: 'modal' }, /"open" is 'drawer' or 'page'/],
    [{ description: '' }, /"description" is not plain text/],
    [{ fields: { name: { multiline: 'yes' } } }, /"multiline" is true or false/],
    [{ fields: { name: { where: {} } } }, /"where" names one to 4 columns/],
    [{ fields: { name: { where: { a: 'a', b: 'b', c: 'c', d: 'd', e: 'e' } } } }, /"where" names one to 4/],
    [{ fields: { name: { tooltip: 'x' } } }, /has no "tooltip"/],
    [{ groups: [{ label: 'A', description: 'x'.repeat(300), fields: ['name'] }] }, /"description" is not plain text of at most 256/],
  ] as const)
    assert.throws(() => parseAppForm(bad), said);
});

test("a field's `as` is cards, buttons, radios or select, and only a vocabulary or a flag may take one", () => {
  assert.deepEqual(parseAppForm({ fields: { status: { as: 'cards' } } }).fields?.status, { as: 'cards' });
  assert.throws(() => parseAppForm({ fields: { status: { as: 'slider' } } }), /"as" is one of "cards", "buttons", "radios", "select"/);
  const vocabulary: TableMeta = {
    ...table,
    columns: [...columns, { ...column('kind', 'text'), allowed: ['a', 'b'] }, column('done', 'boolean')],
  };
  const judged = (form: Parameters<typeof validateAppForm>[0]) =>
    validateAppForm(
      form,
      vocabulary,
      vocabulary.columns.map((c) => c.name),
      { schema: { ...schema, tables: [vocabulary] }, person: null },
    ).join('\n');
  assert.equal(judged({ fields: { kind: { as: 'cards' }, done: { as: 'buttons' } } }), '');
  assert.match(judged({ fields: { name: { as: 'cards' } } }), /"as" draws a column with a vocabulary/);
  assert.match(judged({ fields: { done: { as: 'cards' } } }), /a flag is drawn as "buttons" or "select"/);
});

test("a step may leave its id out: the label's slug, as step() makes it, and a label with no slug says to write one", () => {
  assert.deepEqual(parseAppForm({ steps: [{ label: 'Care and coverage', fields: ['name'] }] }).steps, [
    { id: 'care-and-coverage', label: 'Care and coverage', fields: ['name'] },
  ]);
  assert.throws(() => parseAppForm({ steps: [{ label: '1. Basics', fields: ['name'] }] }), /step "1\. Basics" needs an "id"/);
  assert.throws(
    () =>
      parseAppForm({
        steps: [
          { label: 'Basics', fields: ['name'] },
          { label: 'basics', fields: ['status'] },
        ],
      }),
    /two steps are "basics"/,
  );
});

test("a form's dress and words are judged against the catalog and who me can be", () => {
  const people: TableMeta = {
    id: 'person',
    name: 'person',
    schema: '',
    isView: false,
    columns: [{ ...column('id', 'integer'), primaryKey: true }, column('team', 'text')],
  };
  const owned: TableMeta = {
    ...table,
    columns: [
      ...columns,
      { ...column('owner_id', 'integer'), references: { table: 'person', column: 'id' } },
      { ...column('other_ref', 'integer'), references: { table: 'items', column: 'id' } },
    ],
  };
  const catalog: DatabaseSchema = { ...schema, tables: [owned, people] };
  const judged = (form: Parameters<typeof validateAppForm>[0], person: { table?: string } | null = { table: 'person' }) =>
    validateAppForm(
      form,
      owned,
      owned.columns.map((c) => c.name),
      { schema: catalog, person },
    ).join('\n');
  assert.equal(
    judged({
      show: ['name', 'day', 'local', 'owner_id'],
      defaults: { day: 'today', local: 'now', owner_id: 'me', name: 'me' },
      fields: { owner_id: { where: { team: 'name' } }, name: { multiline: true } },
    }),
    '',
  );
  assert.match(judged({ show: ['name'], fields: { status: { help: 'x' } } }), /fields "status" is not a field this form asks for/);
  assert.match(judged({ fields: { amount: { multiline: true } } }), /only a text field is drawn on one line or several/);
  assert.match(judged({ fields: { name: { where: { id: 'status' } } } }), /only a reference takes/);
  assert.match(judged({ fields: { owner_id: { where: { squad: 'status' } } } }), /"squad", which is not a column of person/);
  assert.match(judged({ fields: { owner_id: { where: { team: 'nothing' } } } }), /"nothing", which is not a column of items/);
  assert.match(judged({ defaults: { name: 'today' } }), /is today, which fills a date column/);
  assert.match(judged({ defaults: { amount: 'me' } }), /is me, the signed-in person/);
  assert.match(judged({ defaults: { owner_id: 'me' } }, null), /no sign-in/);
  assert.match(judged({ defaults: { other_ref: 'me' } }), /refers to items, not to the table people are rows of/);
});

test('a step takes rows of at most three fields, its own words, and a form its style', () => {
  const parsed = parseAppForm({
    style: 'intake',
    steps: [
      {
        id: 'name',
        label: 'Name',
        fields: [['first', 'last'], 'dob'],
        title: 'What is your name?',
        lead: 'As on your ID.',
        next: 'Review',
        skip: 'Skip',
      },
      { id: 'plain', label: 'Plain', fields: [['one'], 'two'] },
    ],
  });
  assert.equal(parsed.style, 'intake');
  // The fields read through, in order; `rows` stays only where a row holds more than one.
  assert.deepEqual(parsed.steps?.[0].fields, ['first', 'last', 'dob']);
  assert.deepEqual(parsed.steps?.[0].rows, [['first', 'last'], ['dob']]);
  assert.deepEqual(
    { title: parsed.steps?.[0].title, lead: parsed.steps?.[0].lead, next: parsed.steps?.[0].next, skip: parsed.steps?.[0].skip },
    { title: 'What is your name?', lead: 'As on your ID.', next: 'Review', skip: 'Skip' },
  );
  assert.deepEqual(parsed.steps?.[1].fields, ['one', 'two']);
  assert.equal(parsed.steps?.[1].rows, undefined);
  const step = (fields: unknown, extra: object = {}) => ({ steps: [{ id: 's', label: 'S', fields, ...extra }] });
  assert.throws(() => parseAppForm(step([[]])), /empty row/);
  assert.throws(() => parseAppForm(step([['a', 'b', 'c', 'd']])), /at most 3/);
  assert.throws(() => parseAppForm(step([[['a'], 'b']])), /nests a row inside a row/);
  assert.throws(() => parseAppForm(step([['a', 'b'], 'a'])), /names "a" twice/);
  assert.throws(() => parseAppForm(step(['a'], { title: 'x'.repeat(161) })), /"title" is not plain text of at most 160/);
  assert.throws(() => parseAppForm(step(['a'], { next: 'x'.repeat(41) })), /"next" is not plain text of at most 40/);
  assert.throws(() => parseAppForm({ style: 'wizard', ...step(['a']) }), /'stepper' or 'intake'/);
  assert.throws(() => parseAppForm({ style: 'intake' }), /draws steps/);
  // Read again as a parsed model (validateAppForm, a served payload), a step keeps its rows rather than refusing them.
  assert.deepEqual(parseAppForm(parsed, 'Form', true).steps, parsed.steps);
  assert.throws(() => parseAppForm(step(['a'], { rows: [['a']] })), /has no "rows"/);
});

test("a record form's show and each group take the steps' rows, kept beside the flat list everything reads", () => {
  const shown = parseAppForm({ show: [['name', 'status'], 'amount'] });
  assert.deepEqual(shown.show, ['name', 'status', 'amount']);
  assert.deepEqual(shown.showRows, [['name', 'status'], ['amount']]);
  assert.equal(parseAppForm({ show: ['name', ['status']] }).showRows, undefined);
  const grouped = parseAppForm({
    groups: [
      { label: 'Who', fields: ['name', ['status', 'enabled']] },
      { label: 'What', fields: ['amount', 'cap'] },
    ],
  });
  assert.deepEqual(grouped.show, ['name', 'status', 'enabled', 'amount', 'cap']);
  assert.deepEqual(grouped.groups?.[0].fields, ['name', 'status', 'enabled']);
  assert.deepEqual(grouped.groups?.[0].rows, [['name'], ['status', 'enabled']]);
  assert.equal(grouped.groups?.[1].rows, undefined);
  // The form's rows are its groups' in their order, a group without rows one field to a row.
  assert.deepEqual(grouped.showRows, [['name'], ['status', 'enabled'], ['amount'], ['cap']]);
  assert.ok(Object.isFrozen(grouped.showRows) && Object.isFrozen(grouped.groups?.[0].rows?.[1]));
  // A parsed model reads again as itself, rows and all; rows that disagree with the flat list are refused.
  assert.deepEqual(parseAppForm(shown, 'Form', true), shown);
  assert.deepEqual(parseAppForm(grouped, 'Form', true), grouped);
  assert.throws(() => parseAppForm({ ...shown, showRows: [['status', 'name'], ['amount']] }, 'Form', true), /invalid form declaration/);
  assert.throws(() => parseAppForm({ show: ['name'], showRows: [['name']] }), /has no "showRows"/);
  // The same refusals as a step's: four to a row, a field twice, a row inside a row, an empty row.
  assert.throws(() => parseAppForm({ show: [['name', 'status', 'amount', 'cap']] }), /a row of 4 fields; a row holds at most 3/);
  assert.throws(() => parseAppForm({ show: [['name', 'status'], 'name'] }), /names "name" twice/);
  assert.throws(() => parseAppForm({ groups: [{ label: 'G', fields: [['name', ['status']]] }] }), /nests a row inside a row/);
  assert.throws(() => parseAppForm({ groups: [{ label: 'G', fields: [[]] }] }), /empty row/);
  assert.throws(
    () =>
      parseAppForm({
        groups: [
          { label: 'A', fields: [['name', 'status']] },
          { label: 'B', fields: ['status'] },
        ],
      }),
    /invalid form declaration/,
  );
  // A step's row stands inside one group: a row across two, or out of a group into the fields left after them, is refused.
  const stepped = (row: string[]) => ({
    groups: [
      { label: 'Who', fields: ['name', 'status'] },
      { label: 'What', fields: ['amount'] },
    ],
    steps: [{ id: 'one', label: 'One', fields: [row, 'enabled'] }],
  });
  assert.doesNotThrow(() => parseAppForm(stepped(['name', 'status'])));
  assert.throws(() => parseAppForm(stepped(['status', 'amount'])), /step "one" puts "status", "amount" in one row across groups/);
  assert.throws(
    () => parseAppForm({ ...stepped(['name']), steps: [{ id: 'one', label: 'One', fields: [['name', 'enabled']] }] }),
    /across groups/,
  );
  // And the checker reads a form with rows as it reads one without.
  assert.deepEqual(validateAppForm({ show: [['name', 'status'], 'amount'] } as never, table), []);
  assert.deepEqual(validateAppForm(grouped, table), []);
});
