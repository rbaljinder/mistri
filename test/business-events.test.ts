import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BusinessEventDefinitionError,
  BusinessEventProjectionError,
  COMMAND_EVENT_LIMITS,
  captureCommandEventBatch,
  captureCommandEventManifest,
  captureCommandEvents,
  defineEvent as defineAuthoredEvent,
  defineEventProjection,
  defineOpaqueEvent,
  projectCommandEvents,
  type BusinessEvent,
  type BusinessEventOutput,
  type BusinessEventProjection,
} from '../packages/mistri/src/server/commands/businessEvents.js';
import { describeShape, int, shape, text } from '../packages/mistri/src/server/commands/commandShapes.js';
import type {
  CommandEventBatch,
  CommandEventEnvelope,
  CommandEventJson,
} from '../packages/mistri/src/adapters/events/commandEventTypes.js';
import { canonicalCommandJson } from '../packages/mistri/src/server/commands/commandPayload.js';

type Output = { applicationId: string; version: number; privateReason?: string };
type Payload = { applicationId: string; version: number };
/** The capture machinery's own spelling: a name, the listed fields and a hand-written parser. An author never writes
 * this (`defineEvent(name, shape)` derives the fields from the shape and the shape is the parser), but the platform's
 * own events do, and the bounds below are the machinery's, whoever declares the event. */
type Definition<Value extends object & { readonly [Key in keyof Value]: CommandEventJson }> = {
  name: string;
  fields: readonly Extract<keyof Value, string>[];
  payload: { parse(value: unknown): Value };
};
const defineEvent = <Value extends object & { readonly [Key in keyof Value]: CommandEventJson }>(
  spec: Definition<Value>,
): BusinessEvent<Value> => defineOpaqueEvent(spec.name, spec.fields, spec.payload);
function definition(): Definition<Payload> {
  return {
    name: 'application.reviewer_assigned',
    fields: ['applicationId', 'version'],
    payload: {
      parse(value: unknown): Payload {
        const input = value as Payload;
        if (typeof input.applicationId !== 'string' || !input.applicationId || !Number.isSafeInteger(input.version) || input.version < 1)
          throw new Error('PRIVATE_VALIDATOR_DETAIL');
        return { applicationId: input.applicationId, version: input.version };
      },
    },
  };
}
const output: Output = { applicationId: 'application-1', version: 2, privateReason: 'PRIVATE_REASON' };
const select = (value: BusinessEventOutput<Output>): Payload => ({ applicationId: value.applicationId, version: value.version });
function configured(project = select, spec = definition()) {
  return captureCommandEvents({ reviewerAssigned: defineEventProjection(defineEvent(spec), project) });
}
function projectedValue(value: unknown) {
  return () =>
    projectCommandEvents(
      configured(() => value as Payload),
      output,
    );
}
function nested(value: CommandEventJson) {
  const event = defineEvent({
    name: 'application.bulk_assigned',
    fields: ['items'],
    payload: { parse: (input: unknown) => input as { items: CommandEventJson } },
  });
  return captureCommandEvents({ bulk: defineEventProjection(event, (_value: Output) => ({ items: value })) });
}
const draft = (name = 'application.reviewer_assigned', payloadJson = '{"applicationId":"application-1","version":2}') => ({
  name,
  version: 1,
  payloadJson,
});

test('events: typed explicit projection produces only captured drafts and an ordered lookup expectation', () => {
  const declarations = configured();
  const batch: CommandEventBatch = projectCommandEvents(declarations, output);
  assert.deepEqual(declarations.expectation, [{ name: 'application.reviewer_assigned', version: 1 }]);
  assert.deepEqual(batch, [draft()]);
  assert.ok(Object.isFrozen(declarations) && Object.isFrozen(declarations.expectation) && Object.isFrozen(declarations.expectation[0]));
  assert.ok(Object.isFrozen(batch) && Object.isFrozen(batch[0]));
  assert.doesNotMatch(JSON.stringify(batch), /PRIVATE_REASON|actorId|tenantId|sourceId|eventId|receiptId|correlation|commandVersion/);
  assert.equal(output.privateReason, 'PRIVATE_REASON');
});

test('events: envelope, payload and command versions are distinct in the private DTO proposal', () => {
  const envelope: CommandEventEnvelope = {
    envelopeVersion: 2,
    version: 3,
    commandVersion: 2,
    eventId: 'runtime-event',
    ordinal: 0,
    name: 'application.reviewer_assigned',
    payloadJson: '{}',
    appId: 'app',
    storeId: 'store',
    sourceId: 'business',
    scope: 'tenant',
    tenantId: 'tenant',
    actorId: 'account',
    commandId: 'assign',
    resource: 'loan_application',
    key: { id: 'a' },
    receiptId: 'runtime-receipt',
    requestId: 'runtime-request',
    occurredAt: '2026-09-08T12:00:00.000Z',
    correlationId: 'runtime-request',
    causation: { kind: 'command', receiptId: 'runtime-receipt' },
  };
  assert.deepEqual([envelope.envelopeVersion, envelope.version, envelope.commandVersion], [2, 3, 2]);
  // This is type separation only. No envelope builder attests this test object.
  assert.throws(() => captureCommandEventBatch([envelope]), BusinessEventProjectionError);
});

test('events: declaration capture does not execute code and original mutation cannot replace captured methods/metadata', () => {
  let parses = 0,
    projects = 0;
  const spec = definition(),
    original = spec.payload.parse;
  spec.payload.parse = function (input: unknown) {
    parses++;
    assert.ok(Object.isFrozen(this), 'parser has a captured frozen receiver');
    return original(input);
  };
  const event = defineEvent(spec);
  const names = {
    assigned: defineEventProjection(event, (value: Output) => {
      projects++;
      return select(value);
    }),
  };
  const captured = captureCommandEvents(names);
  assert.equal(parses + projects, 0);
  (spec.fields as string[])[0] = 'privateReason';
  Object.assign(spec, { name: 'private.changed', version: 999 });
  spec.payload.parse = () => {
    throw new Error('Replaced');
  };
  names.assigned = defineEventProjection(defineEvent(definition()), () => {
    throw new Error('Replaced');
  });
  assert.deepEqual(projectCommandEvents(captured, output), [draft()]);
  assert.equal(parses, 1);
  assert.equal(projects, 1);
  assert.ok(Object.isFrozen(event) && Object.isFrozen(event.fields));
});

for (const name of [
  '',
  'assigned',
  'bad..name',
  'bad.name.',
  '.bad.name',
  'bad name.fact',
  'bad.__proto__',
  'bad.constructor',
  'bad.then',
  'évent.fact',
  `a.${'x'.repeat(127)}`,
]) {
  test(`events: rejects invalid name ${JSON.stringify(name)}`, () => {
    assert.throws(() => defineEvent({ ...definition(), name }), BusinessEventDefinitionError);
  });
}
test('events: an authored event is a name and a shape, its fields are the shape keys, and it is at version 1', () => {
  const event = defineAuthoredEvent('application.reviewer_assigned', shape({ applicationId: text(), version: int() }));
  assert.deepEqual([event.name, event.version, [...event.fields]], ['application.reviewer_assigned', 1, ['applicationId', 'version']]);
  const captured = captureCommandEvents({ assigned: defineEventProjection(event, select) });
  assert.deepEqual(projectCommandEvents(captured, output), [draft()]);
  // A hand-written parser has no keys to publish, and a payload that is not an object has no fields.
  assert.throws(
    () => defineAuthoredEvent('application.changed', { parse: (value: unknown) => value } as never),
    BusinessEventDefinitionError,
  );
  assert.throws(() => defineAuthoredEvent('application.changed', text() as never), BusinessEventDefinitionError);
  assert.throws(() => defineAuthoredEvent('assigned', shape({ applicationId: text() })), BusinessEventDefinitionError);
});

test('events: every proxy boundary refuses before any trap, including revoked identities and callable proxies', () => {
  let traps = 0;
  const proxy = <Value extends object>(value: Value): Value =>
    new Proxy(value, {
      get() {
        traps++;
        throw new Error();
      },
      getPrototypeOf() {
        traps++;
        throw new Error();
      },
      ownKeys() {
        traps++;
        throw new Error();
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error();
      },
      apply() {
        traps++;
        throw new Error();
      },
    });
  const event = defineEvent(definition()),
    projection = defineEventProjection(event, select),
    captured = captureCommandEvents({ assigned: projection });
  assert.throws(() => defineEvent({ ...definition(), fields: proxy(['applicationId', 'version'] as const) }), BusinessEventDefinitionError);
  assert.throws(() => defineEvent({ ...definition(), payload: proxy(definition().payload) }), BusinessEventDefinitionError);
  assert.throws(
    () => defineEvent({ ...definition(), payload: { parse: proxy(definition().payload.parse) } }),
    BusinessEventDefinitionError,
  );
  assert.throws(() => defineEventProjection(proxy(event), select), BusinessEventDefinitionError);
  assert.throws(() => defineEventProjection(event, proxy(select)), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents(proxy({ assigned: projection })), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents({ assigned: proxy(projection) }), BusinessEventDefinitionError);
  assert.throws(() => projectCommandEvents(proxy(captured), output), BusinessEventProjectionError);
  assert.throws(() => projectCommandEvents(captured, proxy(output)), BusinessEventProjectionError);
  assert.throws(projectedValue(proxy(select(output))), BusinessEventProjectionError);
  assert.throws(() => captureCommandEventBatch(proxy([draft()])), BusinessEventProjectionError);
  const revoked = Proxy.revocable(event, {});
  revoked.revoke();
  assert.throws(() => defineEventProjection(revoked.proxy, select), BusinessEventDefinitionError);
  assert.equal(traps, 0);
});

test('events: allowlists reject duplicates, holes, iterator/accessor hooks, unsafe names and provenance fields', () => {
  let calls = 0;
  const getter = ['applicationId', 'version'];
  Object.defineProperty(getter, '0', {
    enumerable: true,
    get() {
      calls++;
      return 'applicationId';
    },
  });
  const iterator = ['applicationId', 'version'];
  Object.defineProperty(iterator, Symbol.iterator, {
    value() {
      calls++;
      throw new Error();
    },
  });
  for (const invalid of [
    [],
    ['applicationId', 'applicationId'],
    // oxlint-disable-next-line unicorn/no-new-array -- Deliberately sparse input must be refused, not normalized.
    new Array(2),
    getter,
    iterator,
    ['__proto__'],
    ['constructor'],
    ['then'],
    ['actorId'],
    ['tenantId'],
    ['sourceId'],
    ['requestId'],
    ['correlationId'],
    ['causation'],
    ['bad.field'],
    ['x'.repeat(65)],
    Array.from({ length: 17 }, (_, i) => `field${i}`),
  ]) {
    assert.throws(() => defineEvent({ ...definition(), fields: invalid as never }), BusinessEventDefinitionError);
  }
  assert.equal(calls, 0);
});

test('events: nonempty bounded named declarations require genuine definitions and unique event identities', () => {
  const event = defineEvent(definition()),
    projection = defineEventProjection(event, select);
  assert.throws(() => defineEventProjection({ ...event }, select), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents({ assigned: { ...projection } }), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents({}), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents({ first: projection, second: projection }), BusinessEventDefinitionError);
  assert.throws(() => captureCommandEvents({ constructor: projection }), BusinessEventDefinitionError);
  const declarations = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `slot${i}`,
      defineEventProjection(defineEvent({ ...definition(), name: `application.event${i}` }), select),
    ]),
  );
  assert.equal(projectCommandEvents(captureCommandEvents(declarations), output).length, 32);
  declarations.extra = defineEventProjection(defineEvent({ ...definition(), name: 'application.extra' }), select);
  assert.throws(() => captureCommandEvents(declarations), BusinessEventDefinitionError);
});

test('events: manifest ordering follows sorted declaration names', () => {
  const first = defineEventProjection(defineEvent(definition()), select);
  const second = defineEventProjection(defineEvent({ ...definition(), name: 'application.second' }), select);
  const a = captureCommandEvents({ z: second, a: first }),
    b = captureCommandEvents({ a: first, z: second });
  assert.deepEqual(a.expectation, b.expectation);
  assert.deepEqual(
    a.expectation.map((value) => value.name),
    [definition().name, 'application.second'],
  );
  assert.deepEqual(projectCommandEvents(a, output), projectCommandEvents(b, output));
  assert.deepEqual(captureCommandEventManifest([...a.expectation].reverse()), [...a.expectation].reverse());
});

test('events: nested JSON and bulk arrays are preserved only through explicit projection and schema validation', () => {
  const items = [{ applicationId: 'a', nested: { flags: [true, false, null], amount: 12.5, largeId: '9007199254740993' } }];
  const declarations = nested(items);
  const batch = projectCommandEvents(declarations, output);
  assert.deepEqual(JSON.parse(batch[0].payloadJson), { items });
  items[0].nested.flags[0] = false;
  assert.equal(JSON.parse(batch[0].payloadJson).items[0].nested.flags[0], true);
  assert.deepEqual(captureCommandEventBatch(batch, declarations.expectation), batch);
});

test('events: projectors see detached deeply frozen output and parsers see detached deeply frozen projections', () => {
  type NestedOutput = { details: { items: { id: string }[] } };
  const original: NestedOutput = { details: { items: [{ id: 'original' }] } };
  const returned = { items: [{ id: 'original' }] };
  const event = defineEvent({
    name: 'application.changed',
    fields: ['items'],
    payload: {
      parse(input: unknown) {
        const value = input as typeof returned;
        assert.notEqual(value, returned);
        assert.ok(Object.isFrozen(value) && Object.isFrozen(value.items) && Object.isFrozen(value.items[0]));
        assert.throws(() => {
          value.items[0].id = 'changed';
        }, TypeError);
        return value;
      },
    },
  });
  const captured = captureCommandEvents({
    changed: defineEventProjection<NestedOutput, typeof returned>(event, (value: BusinessEventOutput<NestedOutput>) => {
      assert.notEqual(value, original);
      assert.ok(Object.isFrozen(value.details.items[0]));
      assert.throws(() => {
        // @ts-expect-error verify runtime freezing as well as the readonly type
        value.details.items[0].id = 'changed';
      }, TypeError);
      original.details.items[0].id = 'caller-changed';
      assert.equal(value.details.items[0].id, 'original');
      return returned;
    }),
  });
  const batch = projectCommandEvents(captured, original);
  returned.items[0].id = 'later';
  assert.equal(JSON.parse(batch[0].payloadJson).items[0].id, 'original');
  assert.equal(Object.isFrozen(original), false);
  assert.equal(Object.isFrozen(returned), false);
});

test('events: exact top-level allowlist applies before and after parser normalization', () => {
  let calls = 0;
  const spec = definition(),
    parse = spec.payload.parse;
  spec.payload.parse = (input) => {
    calls++;
    return parse(input);
  };
  assert.throws(
    () =>
      projectCommandEvents(
        configured((value) => ({ ...value }), spec),
        output,
      ),
    BusinessEventProjectionError,
  );
  assert.equal(calls, 0, 'unknown raw-result properties fail before the parser can silently strip them');
  assert.throws(projectedValue({ applicationId: 'a' }), BusinessEventProjectionError);
  spec.payload.parse = () => ({ ...select(output), secret: 'PRIVATE_RESULT' });
  assert.throws(() => projectCommandEvents(configured(select, spec), output), BusinessEventProjectionError);
  spec.payload.parse = () => ({ applicationId: 'normalized', version: 3 });
  assert.equal(JSON.parse(projectCommandEvents(configured(select, spec), output)[0].payloadJson).applicationId, 'normalized');
});

for (const [label, value] of [
  ['undefined', undefined],
  ['function', () => {}],
  ['symbol', Symbol('value')],
  ['bigint', 2n],
  ['NaN', NaN],
  ['infinity', Infinity],
  ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
  ['lone surrogate', '\uD800'],
  ['date', new Date(0)],
  ['map', new Map()],
  ['set', new Set()],
  // oxlint-disable-next-line unicorn/no-new-array -- Preserve holes to exercise malformed payload rejection.
  ['sparse array', new Array(2)],
] as const)
  test(`events: refuses nested ${label}`, () => {
    assert.throws(() => projectCommandEvents(nested({ child: value } as never), output), BusinessEventProjectionError);
  });

test('events: cycles, excessive depth/nodes/bytes, UTF-8 strings and escaped JSON stay bounded', () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  assert.throws(() => projectCommandEvents(nested(cycle as never), output), BusinessEventProjectionError);
  let deep: CommandEventJson = true;
  for (let i = 0; i < 18; i++) deep = { child: deep };
  assert.throws(() => projectCommandEvents(nested(deep), output), BusinessEventProjectionError);
  assert.throws(() => projectCommandEvents(nested(Array(10_001).fill(0)), output), BusinessEventProjectionError);
  assert.throws(() => projectCommandEvents(nested('é'.repeat(513)), output), BusinessEventProjectionError);
  assert.doesNotThrow(() => projectCommandEvents(nested('é'.repeat(512)), output));
  assert.throws(() => projectCommandEvents(nested(Array(17).fill('x'.repeat(1024))), output), BusinessEventProjectionError);
  assert.throws(() => projectCommandEvents(nested(Array(3).fill('\u0000'.repeat(1024))), output), BusinessEventProjectionError);
  assert.throws(() => projectCommandEvents(configured(), { ...output, privateReason: 'x'.repeat(16_384) }), BusinessEventProjectionError);
});

test('events: native async results refuse synchronously and their rejections are consumed', async () => {
  const spec = definition();
  spec.payload.parse = (async () => {
    throw new Error('PRIVATE_ASYNC');
  }) as never;
  assert.throws(() => projectCommandEvents(configured(select, spec), output), BusinessEventProjectionError);
  const projector = defineEventProjection(defineEvent(definition()), (async () => {
    throw new Error('PRIVATE_ASYNC');
  }) as never);
  assert.throws(() => projectCommandEvents(captureCommandEvents({ assigned: projector }), output), BusinessEventProjectionError);
  assert.throws(
    () => projectCommandEvents(configured(), Promise.reject(new Error('PRIVATE_ASYNC')) as never),
    BusinessEventProjectionError,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
});

test('events: thenables and nested accessors are refused without invocation or assimilation', () => {
  let hooks = 0;
  const values = [
    {
      // oxlint-disable-next-line unicorn/no-thenable -- Hostile values must never be assimilated.
      then() {
        hooks++;
      },
    },
    {
      // oxlint-disable-next-line unicorn/no-thenable -- Even reading this hostile accessor is forbidden.
      get then() {
        hooks++;
        return () => {};
      },
    },
    {
      get privateValue() {
        hooks++;
        return 'PRIVATE_GETTER';
      },
    },
    {
      toJSON() {
        hooks++;
        return {};
      },
    },
    Object.assign(Object.create({ inherited: true }), { id: 'a' }),
  ];
  for (const value of values) {
    assert.throws(projectedValue(value), BusinessEventProjectionError);
    assert.throws(() => projectCommandEvents(nested(value as never), output), BusinessEventProjectionError);
    assert.throws(() => projectCommandEvents(configured(), value as never), BusinessEventProjectionError);
  }
  assert.equal(hooks, 0);
});

test('events: runtime scalar rules also reject non-well-formed nested keys and preserve safe JSON normalization', () => {
  assert.throws(() => projectCommandEvents(nested({ ['\uD800']: 'value' }), output), BusinessEventProjectionError);
  assert.equal(JSON.parse(projectCommandEvents(nested({ amount: -0 }), output)[0].payloadJson).items.amount, 0);
  assert.equal(JSON.parse(projectCommandEvents(nested({ emoji: '🙂' }), output)[0].payloadJson).items.emoji, '🙂');
});

test('events: aggregate payload limit fails the complete batch and stops subsequent projectors', () => {
  let calls = 0;
  const eventPayload = { values: Array(10).fill('x'.repeat(1000)) as string[] };
  const declarations = Object.fromEntries(
    Array.from({ length: 8 }, (_, i) => [
      `slot${i}`,
      defineEventProjection(
        defineEvent({
          name: `application.event${i}`,
          fields: ['values'],
          payload: { parse: (value: unknown) => value as typeof eventPayload },
        }),
        (_value: Output) => {
          calls++;
          return eventPayload;
        },
      ),
    ]),
  );
  assert.throws(() => projectCommandEvents(captureCommandEvents(declarations), output), BusinessEventProjectionError);
  assert.equal(calls, 7);
  const oversized = Array.from({ length: 7 }, (_, i) => draft(`application.event${i}`, canonicalCommandJson(eventPayload)));
  assert.throws(() => captureCommandEventBatch(oversized), BusinessEventProjectionError);
});

test('events: storage capture is detached, frozen and compares exact ordered identities without application callbacks', () => {
  let calls = 0;
  const declarations = configured((value) => {
    calls++;
    return select(value);
  });
  const generated = projectCommandEvents(declarations, output);
  const supplied = [{ ...generated[0] }],
    expectation = declarations.expectation.map((value) => ({ ...value }));
  const captured = captureCommandEventBatch(supplied, expectation);
  supplied[0].payloadJson = '{}';
  expectation[0].version = 8;
  assert.deepEqual(captured, generated);
  assert.ok(Object.isFrozen(captured) && Object.isFrozen(captured[0]));
  assert.equal(calls, 1);
  const manifest = captureCommandEventManifest(declarations.expectation);
  assert.notEqual(manifest, declarations.expectation);
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest[0]));
  assert.throws(() => captureCommandEventBatch(generated, expectation), BusinessEventProjectionError);
  assert.throws(
    () => captureCommandEventBatch(generated, [...manifest, { name: 'application.extra', version: 1 }]),
    BusinessEventProjectionError,
  );
  const two = [draft(), draft('application.extra')];
  assert.throws(
    () => captureCommandEventBatch(two, two.map(({ name, version }) => ({ name, version })).reverse()),
    BusinessEventProjectionError,
  );
});

for (const payloadJson of [
  '{}',
  '[]',
  'null',
  '{',
  '{"applicationId":"a", "version":2}',
  '{"version":2,"applicationId":"a"}',
  '{"applicationId":"a","applicationId":"b","version":2}',
  '{"value":9007199254740993}',
  '{"value":1e999}',
  '{"value":"\\ud800"}',
  '{"constructor":"x"}',
  '{"actorId":"forged"}',
  '{"value":{"__proto__":{}}}',
]) {
  test(`events: stored payload JSON refuses invalid/noncanonical input ${payloadJson}`, () => {
    assert.throws(() => captureCommandEventBatch([draft('application.changed', payloadJson)]), BusinessEventProjectionError);
  });
}

test('events: replay helpers reject absent/empty/excessive/duplicate/extra-field manifests and batches', () => {
  for (const invalid of [
    undefined,
    null,
    {},
    [],
    [draft()],
    [{ name: 'application.changed', version: 1, tenantId: 'forged' }],
    [
      { name: 'application.changed', version: 1 },
      { name: 'application.changed', version: 1 },
    ],
    Array.from({ length: 33 }, (_, i) => ({ name: `application.event${i}`, version: 1 })),
  ]) {
    assert.throws(() => captureCommandEventManifest(invalid), BusinessEventProjectionError);
  }
  for (const invalid of [
    undefined,
    null,
    {},
    [],
    [draft(), draft()],
    [{ ...draft(), eventId: 'forged' }],
    [{ ...draft(), version: 0 }],
    [{ ...draft(), payloadJson: 'x'.repeat(COMMAND_EVENT_LIMITS.payloadBytes + 1) }],
    Array.from({ length: 33 }, (_, i) => draft(`application.event${i}`)),
  ]) {
    assert.throws(() => captureCommandEventBatch(invalid), BusinessEventProjectionError);
  }
});

test('events: failures redact trusted validator/projector messages and expose no cause or private data', () => {
  const captured = configured(() => {
    throw new Error('PRIVATE_SENTINEL SELECT * FROM secret');
  });
  assert.throws(
    () => projectCommandEvents(captured, output),
    (error) => {
      assert.ok(error instanceof BusinessEventProjectionError);
      assert.equal('cause' in error, false);
      assert.doesNotMatch(error.message + JSON.stringify(error), /PRIVATE|SELECT|secret/);
      return true;
    },
  );
});

test('events: compile-time payload/projector contracts retain nested types and readonly output', () => {
  const event: BusinessEvent<Payload> = defineEvent(definition());
  const projection: BusinessEventProjection<Output> = defineEventProjection(event, select);
  assert.equal(captureCommandEvents({ assigned: projection }).expectation.length, 1);
  // The function is never invoked; these are negative type assertions for tsc.
  const typeProof = () => {
    // @ts-expect-error explicit payload field names must exist in Payload
    defineEvent<Payload>({ ...definition(), fields: ['privateReason'] });
    // @ts-expect-error non-JSON schema outputs are not valid event payload types
    defineEvent<{ value: bigint }>({ name: 'application.changed', fields: ['value'], payload: { parse: () => ({ value: 1n }) } });
    // @ts-expect-error projector must return the event's typed payload
    defineEventProjection(event, (_value: Output) => ({ applicationId: 1, version: 2 }));
    defineEventProjection(event, (value: BusinessEventOutput<Output>) => {
      // @ts-expect-error validated command output is readonly
      value.version = 3;
      return select(value);
    });
  };
  assert.equal(typeof typeProof, 'function');
});

test('an event named alone carries the output fields of the same names, and one the output lacks is refused where it is declared', () => {
  const shipped = defineAuthoredEvent('order.shipped', shape({ applicationId: text(), version: int() }));
  const declared = captureCommandEvents({ shipped }, describeShape(shape({ applicationId: text(), version: int(), note: text() })));
  assert.deepEqual(projectCommandEvents(declared, output), [
    { name: 'order.shipped', version: 1, payloadJson: '{"applicationId":"application-1","version":2}' },
  ]);
  const lacking = defineAuthoredEvent('order.lost', shape({ applicationId: text(), missing: text() }));
  assert.throws(() => captureCommandEvents({ lacking }, describeShape(shape({ applicationId: text() }))), BusinessEventDefinitionError);
});
