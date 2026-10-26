import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  FLAG_LIMITS,
  FlagValidationError,
  normalizeFlagCatalog,
  normalizeFlagContext,
  normalizeFlagDefinition,
  normalizeFlagScope,
  normalizeFlagSnapshot,
} from '../packages/mistri/src/shared/appFlags.js';

const catalog = () =>
  normalizeFlagCatalog({
    flags: {
      enabled: { type: 'boolean', default: true, owner: 'product', tenantManaged: true },
      copy: { type: 'string', default: 'a', variants: ['a', 'b'], safeValue: 'closed', owner: 'product', tenantManaged: true },
    },
    roles: ['reader', 'staff'],
    audiences: { staff: { roles: ['staff'] }, partners: { attributes: { emailDomain: ['partner.example'] } } },
  });
const scope = { appId: 'market', environment: 'test', tenantId: null };

test('definitions cover each type, normalize boolean safety and retain immutable metadata', () => {
  assert.deepEqual(normalizeFlagDefinition({ type: 'boolean', default: true, owner: 'ops' }), {
    type: 'boolean',
    default: true,
    owner: 'ops',
    safeValue: false,
  });
  for (const [type, value] of [
    ['string', 'hello'],
    ['number', 0.5],
    ['object', { words: ['hello', null], count: 2 }],
  ]) {
    const normalized = normalizeFlagDefinition({
      type,
      default: value,
      safeValue: value,
      variants: [value],
      owner: 'ops',
      expiry: '2027-01-01T00:00:00.000Z',
      tenantManaged: false,
    });
    assert.deepEqual(normalized.default, value);
    assert.ok(Object.isFrozen(normalized));
  }
  assert.equal(normalizeFlagDefinition({ type: 'number', default: -0, owner: 'ops' }).default, 0);
  assert.equal(normalizeFlagDefinition({ type: 'string', default: 'hello', owner: 'ops' }).safeValue, undefined);
});

test('invalid definitions fail closed, including unknown fields and nonfinite or undeclared values', () => {
  const valid = { type: 'boolean', default: false, owner: 'ops' };
  const invalid = [
    null,
    [],
    {},
    { ...valid, extra: true },
    { ...valid, type: 'expression' },
    { ...valid, default: 'false' },
    { ...valid, owner: '' },
    { ...valid, owner: 'ops@example.test' },
    { ...valid, tenantManaged: 1 },
    { ...valid, safeValue: true },
    { ...valid, safeValue: undefined },
    { ...valid, variants: [] },
    { ...valid, variants: [true] },
    { ...valid, variants: [false, false] },
    { ...valid, expiry: '2027-02-30T00:00:00.000Z' },
    { ...valid, expiry: 'tomorrow' },
    { type: 'number', default: Infinity, owner: 'ops' },
    { type: 'number', default: NaN, owner: 'ops' },
    { type: 'object', default: [], owner: 'ops' },
    { type: 'object', default: null, owner: 'ops' },
    { type: 'object', default: new Date(), owner: 'ops' },
    { type: 'object', default: { a: 1 }, variants: [{ a: 1 }, { a: 1 }], owner: 'ops' },
  ];
  for (const input of invalid) assert.throws(() => normalizeFlagDefinition(input), FlagValidationError);
});

test('normalization rejects accessors without invoking them, sparse arrays, cycles and hidden data', () => {
  let invoked = false;
  const accessor = {
    type: 'boolean',
    owner: 'ops',
    get default() {
      invoked = true;
      return false;
    },
  };
  assert.throws(() => normalizeFlagDefinition(accessor), FlagValidationError);
  assert.equal(invoked, false);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  const sparse = Array(2);
  sparse[1] = true;
  const hidden = Object.defineProperty({ a: 1 }, 'secret', { value: 2 });
  for (const value of [
    cycle,
    hidden,
    { a: undefined },
    { [Symbol('x')]: 1 },
    Object.create({ inherited: true }),
    JSON.parse('{"__proto__":{"admin":true}}'),
    { values: sparse },
    { fn() {} },
  ]) {
    assert.throws(() => normalizeFlagDefinition({ type: 'object', default: value, owner: 'ops' }), FlagValidationError);
  }
});

test('declared collections and nested values are bounded', () => {
  const flags = Object.fromEntries(
    Array.from({ length: FLAG_LIMITS.flags }, (_, i) => [`f${i}`, { type: 'boolean', default: false, owner: 'ops' }]),
  );
  assert.equal(Object.keys(normalizeFlagCatalog({ flags, roles: [], audiences: {} }).flags).length, FLAG_LIMITS.flags);
  assert.throws(() => normalizeFlagCatalog({ flags: { ...flags, overflow: flags.f0 }, roles: [], audiences: {} }), FlagValidationError);
  const audiences = Object.fromEntries(Array.from({ length: FLAG_LIMITS.audiences }, (_, i) => [`a${i}`, { rollout: i }]));
  assert.equal(Object.keys(normalizeFlagCatalog({ flags: {}, roles: [], audiences }).audiences).length, FLAG_LIMITS.audiences);
  assert.throws(
    () => normalizeFlagCatalog({ flags: {}, roles: [], audiences: { ...audiences, overflow: { rollout: 1 } } }),
    FlagValidationError,
  );
  assert.throws(
    () => normalizeFlagDefinition({ type: 'string', default: 'x'.repeat(FLAG_LIMITS.string + 1), owner: 'ops' }),
    FlagValidationError,
  );
  let deep: unknown = {};
  for (let i = 0; i < FLAG_LIMITS.depth + 2; i++) deep = { next: deep };
  assert.throws(() => normalizeFlagDefinition({ type: 'object', default: deep, owner: 'ops' }), FlagValidationError);
  const leaf = Array(256).fill('x');
  assert.throws(
    () => normalizeFlagDefinition({ type: 'object', default: { values: Array(256).fill(leaf) }, owner: 'ops' }),
    FlagValidationError,
  );
});

test('definitions and audiences have no mutation channel to their author', () => {
  const value = { nested: { tags: ['a'] } };
  const input = {
    flags: { object: { type: 'object', default: value, variants: [value], owner: 'ops' } },
    roles: ['staff'],
    audiences: { team: { roles: ['staff'] } },
  };
  const normalized = normalizeFlagCatalog(input);
  value.nested.tags[0] = 'changed';
  input.roles.push('admin');
  input.audiences.team.roles.push('admin');
  assert.deepEqual(normalized.flags.object.default, { nested: { tags: ['a'] } });
  assert.deepEqual(normalized.roles, ['staff']);
  assert.deepEqual(normalized.audiences.team.roles, ['staff']);
  assert.throws(() => (normalized.flags.object.default as typeof value).nested.tags.push('leak'), TypeError);
  assert.throws(() => (normalized.audiences.team.roles as string[]).push('leak'), TypeError);
});

test('context admits only declared roles, a well-formed email domain and opaque identity fields', () => {
  const declared = catalog();
  assert.deepEqual(
    normalizeFlagContext(
      { identity: { kind: 'subject', id: 'opaque-1' }, roles: [], attributes: { emailDomain: 'partner.example' } },
      declared,
    ),
    { identity: { kind: 'subject', id: 'opaque-1' }, roles: [], attributes: { emailDomain: 'partner.example' } },
  );
  assert.deepEqual(normalizeFlagContext({ tenantId: 'north' }, declared), { tenantId: 'north' });
  for (const input of [
    { email: 'person@example.test' },
    { ip: '127.0.0.1' },
    { identity: { kind: 'subject', id: 'person@example.test' } },
    { identity: { kind: 'visitor', id: '127.0.0.1' } },
    { identity: { kind: 'subject', id: 'opaque', role: 'admin' } },
    { identity: { kind: 'header', id: 'opaque' } },
    { roles: ['admin'] },
    { roles: ['reader', 'reader'] },
    { segments: { region: 'east' } },
    { attributes: { emailDomain: 'person@partner.example' } },
    { attributes: { plan: 'enterprise' } },
    { tenantId: '' },
    { tenantId: null },
    { tenantId: 'north/south' },
  ]) {
    assert.throws(() => normalizeFlagContext(input, declared), FlagValidationError);
  }
});

test('scope and snapshot are closed, revisioned and definition checked', () => {
  const declared = catalog();
  const snapshot = { ...scope, revision: 1, overrides: { enabled: { value: true } } };
  assert.deepEqual(normalizeFlagSnapshot(snapshot, declared), snapshot);
  for (const input of [
    { ...scope, tenantId: undefined },
    { ...scope, environment: '' },
    { ...scope, root: true },
  ]) {
    assert.throws(() => normalizeFlagScope(input), FlagValidationError);
  }
  for (const input of [
    { ...snapshot, revision: -1 },
    { ...snapshot, revision: 0.5 },
    { ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
    { ...snapshot, extra: true },
    { ...snapshot, overrides: { unknown: { value: true } } },
    { ...snapshot, overrides: { enabled: { value: 'yes' } } },
    { ...snapshot, overrides: { copy: { value: 'c' } } },
    { ...snapshot, overrides: { enabled: { disabled: 'true' } } },
    { ...snapshot, overrides: { enabled: { safeValue: true } } },
  ]) {
    assert.throws(() => normalizeFlagSnapshot(input, declared), FlagValidationError);
  }
  const noKill = normalizeFlagCatalog({ flags: { text: { type: 'string', default: 'a', owner: 'ops' } }, roles: [], audiences: {} });
  assert.throws(
    () => normalizeFlagSnapshot({ ...scope, revision: 0, overrides: { text: { disabled: true } } }, noKill),
    FlagValidationError,
  );
  assert.throws(
    () => normalizeFlagSnapshot({ ...scope, tenantId: 'one', revision: 0, overrides: { text: { value: 'b' } } }, noKill),
    FlagValidationError,
  );
});

test('targeting rules and experiments reject arbitrary predicates and invalid weights', () => {
  const declared = catalog();
  const normalized = (override: unknown) => normalizeFlagSnapshot({ ...scope, revision: 1, overrides: { copy: override } }, declared);
  for (const override of [
    { rollout: -1, value: 'b' },
    { rollout: 101, value: 'b' },
    { rollout: 50 },
    { rules: [{ value: 'b' }] },
    { rules: [{ expression: 'true', value: 'b' }] },
    { rules: [{ audiences: {}, value: 'b' }] },
    { rules: [{ audiences: [], value: 'b' }] },
    { rules: [{ audiences: ['undeclared'], value: 'b' }] },
    { rules: [{ segments: { region: ['east'] }, value: 'b' }] },
    { rules: Array(FLAG_LIMITS.rules + 1).fill({ audiences: ['staff'], value: 'b' }) },
  ])
    assert.throws(() => normalized(override), FlagValidationError);
  // Who a rule reaches is said only by audiences: a direct role or tenant list points at them.
  for (const key of ['roles', 'tenants'])
    for (const rule of [
      { [key]: ['staff'], value: 'b' },
      { [key]: ['staff'], audiences: ['staff'], value: 'b' },
    ])
      assert.throws(() => normalized({ rules: [rule] }), new RegExp(`declare one with ${key} and name it in audiences`));
  assert.doesNotThrow(() => normalized({ rules: [{ audiences: ['staff', 'partners'], value: 'b' }] }));
  for (const weights of [
    [],
    [{ value: 'a', weight: 100 }],
    [
      { value: 'a', weight: 50 },
      { value: 'a', weight: 50 },
    ],
    [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 49 },
    ],
    [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 49.9999999999 },
    ],
    [
      { value: 'a', weight: -1 },
      { value: 'b', weight: 101 },
    ],
    [
      { value: 'a', weight: 50 },
      { value: 'b', weight: 50, extra: true },
    ],
  ]) {
    assert.throws(() => normalized({ experiment: { version: 'v1', weights } }), FlagValidationError);
  }
  const experiment = {
    version: 'v1',
    weights: [
      { value: 'a', weight: 0 },
      { value: 'b', weight: 100 },
    ],
  };
  assert.doesNotThrow(() => normalized({ experiment }));
  assert.throws(() => normalized({ experiment, value: 'b' }), FlagValidationError);
});
