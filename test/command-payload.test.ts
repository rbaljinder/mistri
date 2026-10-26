import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalCommandJson,
  CommandInputError,
  parseCommandEnvelope,
  parseCommandPrepareRequest,
  parseCommandRequest,
} from '../packages/mistri/src/server/commands/commandPayload.js';

const payload = () => ({
  command: 'assignReviewer',
  commandVersion: 1,
  key: { id: 1 },
  expectedVersion: 0,
  idempotencyKey: 'request_123456789',
  input: { reviewer: 3, reason: 'Desk allocation' },
});

function rejected(work: () => unknown): void {
  assert.throws(work, (error) => {
    assert.ok(error instanceof CommandInputError);
    assert.equal(error.code, 'invalid_input');
    assert.equal(error.message, 'The command request is invalid.');
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('command payload: canonical JSON sorts every object lexically and preserves array order', () => {
  assert.equal(
    canonicalCommandJson({ z: [3, { b: 2, a: 1 }], a: true, '2': 'two', '10': 'ten' }),
    '{"10":"ten","2":"two","a":true,"z":[3,{"a":1,"b":2}]}',
  );
  assert.equal(canonicalCommandJson({ b: 2, a: 1 }), canonicalCommandJson({ a: 1, b: 2 }));
  assert.notEqual(canonicalCommandJson([1, 2]), canonicalCommandJson([2, 1]));
  for (const value of [null, false, true, 0, -0, 2.5, 1e25, '', 'quoted"\n\\', '\ud800']) {
    assert.equal(canonicalCommandJson(value), JSON.stringify(value));
  }
  assert.equal(canonicalCommandJson(Object.assign(Object.create(null), { a: null })), '{"a":null}');
  const shared = { a: 1 };
  assert.equal(canonicalCommandJson([shared, shared]), '[{"a":1},{"a":1}]', 'Repeated references are not cycles');
});

test('command payload: rejects non-JSON values rather than silently coercing or dropping them', () => {
  for (const value of [
    undefined,
    NaN,
    Infinity,
    -Infinity,
    1n,
    Symbol('private'),
    () => 1,
    new Date(),
    new Map(),
    new Set(),
    new Number(3),
    new String('private'),
    /private/,
    new Uint8Array(1),
    { a: undefined },
    [undefined],
    { a: () => 1 },
    { a: Symbol('private') },
    Object.create({ inherited: true }),
  ]) {
    rejected(() => canonicalCommandJson(value));
  }
  const cycle: { self?: unknown } = {};
  cycle.self = cycle;
  rejected(() => canonicalCommandJson(cycle));
  const array: unknown[] = [];
  array.push(array);
  rejected(() => canonicalCommandJson(array));
});

test('command payload: never invokes getters, toJSON, proxy traps or coercion hooks', () => {
  let touched = false;
  const getter = Object.defineProperty({}, 'private', {
    enumerable: true,
    get() {
      touched = true;
      throw new Error('secret');
    },
  });
  const hidden = Object.defineProperty({}, 'private', {
    get() {
      touched = true;
      throw new Error('secret');
    },
  });
  const toJSON = {
    toJSON() {
      touched = true;
      return 'secret';
    },
  };
  const proxy = new Proxy(
    {},
    {
      ownKeys() {
        touched = true;
        throw new Error('secret');
      },
      getPrototypeOf() {
        touched = true;
        throw new Error('secret');
      },
    },
  );
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  for (const value of [getter, hidden, toJSON, proxy, revoked.proxy]) rejected(() => canonicalCommandJson(value));
  assert.equal(touched, false);
  assert.equal(canonicalCommandJson({ toJSON: 'ordinary data' }), '{"toJSON":"ordinary data"}');
});

test('command payload: rejects reserved, symbol and hidden properties and non-plain arrays', () => {
  for (const name of [...Object.getOwnPropertyNames(Object.prototype), 'prototype']) {
    rejected(() => canonicalCommandJson(Object.fromEntries([[name, 'private']])));
  }
  rejected(() => canonicalCommandJson({ [Symbol('private')]: true }));
  rejected(() => canonicalCommandJson(Object.defineProperty({}, 'hidden', { value: 1 })));
  const sparse: unknown[] = [];
  sparse.length = 2;
  rejected(() => canonicalCommandJson(sparse));
  rejected(() => canonicalCommandJson(Object.assign([1], { extra: 2 })));
  rejected(() => canonicalCommandJson(Object.assign([1], { '01': 2 })));
  rejected(() => canonicalCommandJson(Object.assign([1], { [Symbol('private')]: 2 })));
  rejected(() => canonicalCommandJson(Object.defineProperty([1], '0', { enumerable: false })));
  let touched = false;
  rejected(() =>
    canonicalCommandJson(
      Object.defineProperty([1], '0', {
        get() {
          touched = true;
          return 1;
        },
      }),
    ),
  );
  assert.equal(touched, false);
  class CustomArray extends Array {}
  const custom = new CustomArray();
  custom.push(1, 2);
  rejected(() => canonicalCommandJson(custom));
});

test('command payload: depth, expanded node count and UTF-8 byte limits are exact', () => {
  let nested: unknown = 0;
  for (let index = 0; index < 16; index++) nested = [nested];
  assert.ok(canonicalCommandJson(nested));
  rejected(() => canonicalCommandJson([nested]));
  assert.ok(canonicalCommandJson(Array(9_999).fill(0)));
  rejected(() => canonicalCommandJson(Array(10_000).fill(0)));
  const shared = Array(100).fill(0);
  rejected(() => canonicalCommandJson(Array(100).fill(shared)));
  assert.equal(canonicalCommandJson('é', 4), '"é"');
  rejected(() => canonicalCommandJson('é', 3));
  assert.equal(canonicalCommandJson('\n', 4), '"\\n"');
  rejected(() => canonicalCommandJson('\n', 3));
  assert.equal(canonicalCommandJson('x'.repeat(65_534)).length, 65_536);
  rejected(() => canonicalCommandJson('x'.repeat(65_535)));
  for (const limit of [-1, Infinity, 1.5, NaN]) rejected(() => canonicalCommandJson(null, limit));
});

test('command payload: parsed requests are deeply frozen copies with stable fingerprints', () => {
  const raw = { ...payload(), input: { nested: [{ reviewer: 3 }], note: 'original' } };
  const request = parseCommandRequest(raw);
  const fingerprint = canonicalCommandJson(request);
  raw.key.id = 99;
  raw.input.nested[0].reviewer = 99;
  raw.input.note = 'changed';
  assert.equal(request.key.id, 1);
  assert.equal(canonicalCommandJson(request), fingerprint);
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.key));
  const input = request.input as { nested: Array<{ reviewer: number }>; note: string };
  assert.ok(Object.isFrozen(input));
  assert.ok(Object.isFrozen(input.nested));
  assert.ok(Object.isFrozen(input.nested[0]));
  assert.throws(() => {
    input.nested[0].reviewer = 88;
  }, TypeError);
  assert.deepEqual(Object.keys(request).sort(), ['command', 'commandVersion', 'expectedVersion', 'idempotencyKey', 'input', 'key']);
  for (const input of [null, false, true, 0, '', [], {}])
    assert.equal(canonicalCommandJson(parseCommandRequest({ ...payload(), input }).input), canonicalCommandJson(input));
});

test('command payload: envelope rejects unknown/missing keys and invalid identities', () => {
  for (const commandVersion of [0, -1, 1.5, null, '1', Number.MAX_SAFE_INTEGER + 1]) {
    rejected(() => parseCommandRequest({ ...payload(), commandVersion }));
  }
  for (const field of Object.keys(payload())) {
    const incomplete: Record<string, unknown> = payload();
    delete incomplete[field];
    rejected(() => parseCommandRequest(incomplete));
  }
  for (const field of ['app', 'actor', 'source', 'sql', 'extra']) rejected(() => parseCommandRequest({ ...payload(), [field]: 'private' }));
  for (const value of [null, [], undefined, 'private']) rejected(() => parseCommandRequest(value));
  for (const command of ['', '1assign', 'assign reviewer', 'public.assign', 'constructor', 'prototype', '__proto__']) {
    rejected(() => parseCommandRequest({ ...payload(), command }));
  }
  for (const command of ['assignReviewer', 'assign-reviewer', 'assign_reviewer'])
    assert.equal(parseCommandRequest({ ...payload(), command }).command, command);
  for (const expectedVersion of [-1, 1.5, NaN, Infinity, '1', null, Number.MAX_SAFE_INTEGER]) {
    rejected(() => parseCommandRequest({ ...payload(), expectedVersion }));
  }
  assert.equal(
    parseCommandRequest({ ...payload(), expectedVersion: Number.MAX_SAFE_INTEGER - 1 }).expectedVersion,
    Number.MAX_SAFE_INTEGER - 1,
  );
  for (const idempotencyKey of ['', 'a'.repeat(15), 'a'.repeat(129), 'a'.repeat(15) + '.', 'a'.repeat(15) + 'é', 1, null]) {
    rejected(() => parseCommandRequest({ ...payload(), idempotencyKey }));
  }
  for (const length of [16, 128])
    assert.equal(parseCommandRequest({ ...payload(), idempotencyKey: 'a'.repeat(length) }).idempotencyKey.length, length);
});

test('command prepare accepts only the pinned command version and complete authored key envelope', () => {
  const request = { command: 'assignReviewer', commandVersion: 1, key: { id: 1 } };
  assert.deepEqual(JSON.parse(JSON.stringify(parseCommandPrepareRequest(request))), request);
  for (const extra of ['versionField', 'expectedVersion', 'actor', 'source', 'input']) {
    rejected(() => parseCommandPrepareRequest({ ...request, [extra]: 'private' }));
  }
  for (const value of [null, [], {}, { ...request, commandVersion: 0 }]) rejected(() => parseCommandPrepareRequest(value));
});

test('command payload: record keys have bounded safe identifiers and scalar values', () => {
  for (const key of [
    {},
    [],
    null,
    { id: null },
    { id: true },
    { id: {} },
    { id: NaN },
    { id: Infinity },
    { 'public.id': 1 },
    { 'two words': 1 },
    { '1id': 1 },
    { constructor: 1 },
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`key${index}`, index])),
  ]) {
    rejected(() => parseCommandRequest({ ...payload(), key }));
  }
  const full = Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`key${index}`, index]));
  assert.equal(Object.keys(parseCommandRequest({ ...payload(), key: full }).key).length, 16);
  assert.equal(parseCommandRequest({ ...payload(), key: { _id: 1.5 } }).key._id, 1.5);
  assert.equal(parseCommandRequest({ ...payload(), key: { id: 'é'.repeat(512) } }).key.id, 'é'.repeat(512));
  rejected(() => parseCommandRequest({ ...payload(), key: { id: 'é'.repeat(513) } }));
});

test('command payload: total envelope bound includes input, keys and escaping overhead', () => {
  const base = { ...payload(), input: '' };
  const overhead = Buffer.byteLength(canonicalCommandJson(base));
  const full = { ...base, input: 'x'.repeat(65_536 - overhead) };
  assert.equal(Buffer.byteLength(canonicalCommandJson(parseCommandRequest(full))), 65_536);
  rejected(() => parseCommandRequest({ ...full, input: full.input + 'x' }));
  rejected(() => parseCommandRequest({ ...base, input: '\n'.repeat(40_000) }));
  let touched = false;
  const accessor = Object.defineProperty(payload(), 'input', {
    enumerable: true,
    get() {
      touched = true;
      return 'private';
    },
  });
  rejected(() => parseCommandRequest(accessor));
  assert.equal(touched, false);
});

/** The envelope member a refusal names, and the one case where it must not. */
function objectedTo(work: () => unknown): string | undefined {
  let named: string | undefined;
  assert.throws(work, (error) => {
    assert.ok(error instanceof CommandInputError);
    named = error.field;
    return true;
  });
  return named;
}

test('command payload: a refusal names the envelope member it objected to', () => {
  const base = payload();
  for (const [field, request] of [
    ['command', { ...base, command: 'drop tables' }],
    ['command', { ...base, command: 3 }],
    ['commandVersion', { ...base, commandVersion: 0 }],
    ['key', { ...base, key: { 'two words': 1 } }],
    ['key', { ...base, key: null }],
    ['expectedVersion', { ...base, expectedVersion: -1 }],
    ['idempotencyKey', { ...base, idempotencyKey: 'short' }],
  ] as const) {
    assert.equal(
      objectedTo(() => parseCommandRequest(request)),
      field,
      JSON.stringify(request),
    );
  }
  // A member the envelope wanted and did not get is named, because the name is ours.
  const { idempotencyKey: _dropped, ...missing } = base;
  assert.equal(
    objectedTo(() => parseCommandRequest(missing)),
    'idempotencyKey',
  );
  // One it did not want is not: that text is the sender's, and a refusal never repeats it.
  assert.equal(
    objectedTo(() => parseCommandRequest({ ...base, '<script>': 1 })),
    undefined,
  );
  assert.equal(
    objectedTo(() => parseCommandRequest({ ...base, key: { "'; DROP TABLE loans--": 1 } })),
    'key',
  );
});

test('command payload: a listed target is named by the position the platform counted', () => {
  const many = {
    command: 'assignReviewer',
    commandVersion: 1,
    keys: [{ id: 1 }, { id: 2 }],
    expectedVersions: [0, 0],
    idempotencyKey: 'request_123456789',
    input: null,
  };
  assert.equal(
    objectedTo(() => parseCommandEnvelope({ ...many, keys: [{ id: 1 }, { id: null }] })),
    'keys[1]',
  );
  assert.equal(
    objectedTo(() => parseCommandEnvelope({ ...many, expectedVersions: [0, -1] })),
    'expectedVersions[1]',
  );
  assert.equal(
    objectedTo(() => parseCommandEnvelope({ ...many, expectedVersions: [0] })),
    'expectedVersions',
  );
  assert.equal(
    objectedTo(() => parseCommandEnvelope({ ...many, keys: [{ id: 1 }, { id: 1 }] })),
    'keys',
  );
  assert.equal(
    objectedTo(() => parseCommandRequest(many)),
    'keys',
  );
  // Every name a refusal carries is one a handler's refusal could carry too.
  for (const name of ['command', 'keys[1]', 'expectedVersions[12]', 'key.tenant_id', 'checks[0].keys']) {
    assert.equal(new CommandInputError(name).field, name);
  }
  for (const name of ['', ' ', 'two words', '<script>', 'a'.repeat(300), "'; DROP TABLE loans--"]) {
    assert.equal(new CommandInputError(name).field, undefined, name);
  }
});
