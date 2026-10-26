import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import {
  AppRowPolicyDefinitionError,
  defineAppRowPolicy,
  loadAppRowPolicy,
  type AppRowPolicy,
} from '../packages/mistri/src/server/policy/appRowPolicy.js';
import { MAX_COMMAND_IDS } from '../packages/mistri/src/server/commands/commandLimits.js';
import type { RowScope } from '../packages/engine/src/shared/rowScope.js';

const definition = () => ({ appId: 'app-desk', resolveRows: (): RowScope => ({ ticket: false }) });
const message = new AppRowPolicyDefinitionError().message;
const sanitized = (error: unknown): boolean => {
  assert.ok(error instanceof AppRowPolicyDefinitionError);
  assert.equal(error.name, 'AppRowPolicyDefinitionError');
  assert.equal(error.code, 'invalid-app-row-policy-definition');
  assert.equal(error.message, message);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  return true;
};
const rejects = (value: unknown) => assert.throws(() => defineAppRowPolicy(value as AppRowPolicy), sanitized);

test('row policy: captures and freezes functions and maps without invoking application code', () => {
  let calls = 0;
  const resolveRows = () => {
    calls++;
    return { ticket: false as const };
  };
  const extract = () => {
    calls++;
    return [];
  };
  const references = { assignReviewer: extract };
  const input = { appId: 'app-desk', resolveRows, resultReferences: references };
  const policy = defineAppRowPolicy(input);
  input.appId = 'replacement';
  input.resolveRows = () => ({ ticket: false });
  references.assignReviewer = () => [];
  assert.equal(calls, 0);
  assert.equal(policy.appId, 'app-desk');
  assert.equal(policy.resolveRows, resolveRows);
  assert.equal(policy.resultReferences!.assignReviewer, extract);
  assert.notEqual(policy, input);
  assert.notEqual(policy.resultReferences, references);
  assert.equal(Object.getPrototypeOf(policy.resultReferences), null);
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.resultReferences));
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(references), false);
  assert.equal(Object.isFrozen(resolveRows), false);
  assert.throws(() => Object.assign(policy, { appId: 'changed' }), TypeError);
  assert.throws(() => Object.assign(policy.resultReferences!, { assignReviewer: () => [] }), TypeError);
});

test('row policy: accepts null prototypes and an omitted or empty reference map', () => {
  const policy = defineAppRowPolicy(Object.assign(Object.create(null), definition()));
  assert.equal(Object.hasOwn(policy, 'resultReferences'), false);
  const withReferences = defineAppRowPolicy({ ...definition(), resultReferences: Object.create(null) });
  assert.deepEqual(Object.keys(withReferences.resultReferences!), []);
  assert.ok(Object.isFrozen(withReferences.resultReferences));
});

test('row policy: preserves sync/async resolver identity and defers result validation', async () => {
  const principal = Object.freeze({ id: 'reviewer', appId: 'app-desk', roles: Object.freeze(['staff']) });
  const rows: RowScope = { ticket: false };
  const sync = defineAppRowPolicy({
    ...definition(),
    resolveRows: (actual) => {
      assert.equal(actual, principal);
      return rows;
    },
  });
  const context = { db: {} };
  assert.equal(sync.resolveRows(principal, context), rows);
  const resolveRows = async () => rows;
  const asynchronous = defineAppRowPolicy({ ...definition(), resolveRows });
  assert.equal(await asynchronous.resolveRows(principal, context), rows);
  assert.equal(asynchronous.resolveRows, resolveRows);
  const malformed = () => null as unknown as RowScope;
  assert.equal(defineAppRowPolicy({ ...definition(), resolveRows: malformed }).resolveRows, malformed);
  const throwing = () => {
    throw new Error('private resolver data');
  };
  assert.equal(defineAppRowPolicy({ ...definition(), resolveRows: throwing }).resolveRows, throwing);
});

for (const [name, value] of Object.entries({
  null: null,
  undefined,
  array: [],
  function: () => {},
  string: 'private-value',
  'missing app': { resolveRows: definition().resolveRows },
  'missing resolver': { appId: 'app-desk' },
  'nonfunction resolver': { ...definition(), resolveRows: {} },
  'nonfunction public resolver': { ...definition(), resolvePublicRows: {} },
  'extra property': { ...definition(), privateSecret: 'private-value' },
  'custom prototype': Object.assign(Object.create({ privateSecret: 'private-value' }), definition()),
  'inherited fields': Object.create(definition()),
  'symbol property': { ...definition(), [Symbol('private-value')]: true },
  'nonenumerable field': Object.defineProperty(definition(), 'appId', { enumerable: false }),
  'nonenumerable extra': Object.defineProperty(definition(), 'privateSecret', { value: true }),
}))
  test(`row policy: rejects ${name}`, () => rejects(value));

for (const appId of [
  '',
  ' ',
  ' app-desk',
  'app-desk ',
  'desk\nsecret',
  'desk\0secret',
  'desk\u007f',
  'desk\u0085',
  'a'.repeat(257),
  1,
  null,
]) {
  test(`row policy: rejects invalid app ID ${JSON.stringify(appId)}`, () => rejects({ ...definition(), appId }));
}

test("row policy: services names the jobs module's principals, each once, frozen", () => {
  const listed = ['rent-poster', 'payments'];
  const policy = defineAppRowPolicy({ ...definition(), services: listed });
  listed.push('later');
  assert.deepEqual(policy.services, ['rent-poster', 'payments']);
  assert.ok(Object.isFrozen(policy.services));
  assert.equal('services' in defineAppRowPolicy(definition()), false);
  for (const services of [
    'rent-poster',
    ['Rent'],
    ['rent poster'],
    ['a'.repeat(64)],
    ['payments', 'payments'],
    [1],
    Array.from({ length: 65 }, (_, index) => `service-${index}`),
    new Proxy(['payments'], {}),
  ])
    rejects({ ...definition(), services });
});

test('row policy: accepts bounded authored App IDs without narrowing to command spelling', () => {
  for (const appId of ['a'.repeat(256), 'desk.v1:staff', 'Desk Operations']) {
    assert.equal(defineAppRowPolicy({ ...definition(), appId }).appId, appId);
  }
});

for (const field of ['appId', 'resolveRows', 'resolvePublicRows', 'resultReferences', 'privateSecret']) {
  test(`row policy: refuses ${field} accessors without invoking them`, () => {
    let calls = 0;
    const input = Object.defineProperty(definition(), field, {
      enumerable: true,
      get() {
        calls++;
        throw new Error('private accessor');
      },
    });
    rejects(input);
    assert.equal(calls, 0);
  });
}

test('row policy: captures each fixed public form scope and its attestation without invoking it', () => {
  let calls = 0;
  const rows: RowScope = { inbox: { groups: [[{ column: 'desk_id', op: '=', value: 1 }]] } };
  const resultReferences = () => {
    calls++;
    return [];
  };
  const policy = defineAppRowPolicy({ ...definition(), publicForms: { apply: { rows, resultReferences } } });
  (rows as { inbox: RowScope['inbox'] }).inbox = false;
  assert.equal(calls, 0);
  const captured = policy.publicForms!.apply;
  assert.ok('rows' in captured, 'fixed enrollment keeps its captured row scope');
  assert.equal(captured.resultReferences, resultReferences);
  assert.deepEqual(JSON.parse(JSON.stringify(captured.rows)), { inbox: { groups: [[{ column: 'desk_id', op: '=', value: 1 }]] } });
  assert.notEqual(captured.rows, rows);
  assert.ok(Object.isFrozen(policy.publicForms));
  assert.ok(Object.isFrozen(policy.publicForms!.apply));
  assert.ok(Object.isFrozen(captured.rows));
});

for (const [name, publicForms] of Object.entries({
  'missing attestation': { apply: { rows: { inbox: true } } },
  'missing rows': { apply: { resultReferences: () => [] } },
  'nonfunction attestation': { apply: { rows: { inbox: true }, resultReferences: [] } },
  'extra entry property': { apply: { rows: { inbox: true }, resultReferences: () => [], privateSecret: true } },
  'invalid form key': { 'Apply now': { rows: { inbox: true }, resultReferences: () => [] } },
  'reserved form key': { constructor: { rows: { inbox: true }, resultReferences: () => [] } },
  'invalid rows': { apply: { rows: null, resultReferences: () => [] } },
  'too many forms': Object.fromEntries(
    Array.from({ length: 65 }, (_, index) => [`form-${index}`, { rows: { inbox: true }, resultReferences: () => [] }]),
  ),
}))
  test(`row policy: rejects public forms with ${name}`, () => rejects({ ...definition(), publicForms }));

for (const [name, publicForms] of Object.entries({
  'public forms accessor': Object.defineProperty({}, 'apply', {
    enumerable: true,
    get() {
      throw new Error('private getter');
    },
  }),
  'entry rows accessor': {
    apply: Object.defineProperty({ resultReferences: () => [] }, 'rows', {
      enumerable: true,
      get() {
        throw new Error('private getter');
      },
    }),
  },
  'entry attestation accessor': {
    apply: Object.defineProperty({ rows: { inbox: true } }, 'resultReferences', {
      enumerable: true,
      get() {
        throw new Error('private getter');
      },
    }),
  },
}))
  test(`row policy: refuses ${name} without invoking it`, () => rejects({ ...definition(), publicForms }));

for (const [name, resultReferences] of Object.entries({
  null: null,
  undefined,
  array: [],
  function: () => {},
  'custom prototype': Object.create({ assign: () => [] }),
  'nonfunction value': { assign: [] },
  'symbol key': { [Symbol('private')]: () => [] },
  'nonenumerable key': Object.defineProperty({}, 'assign', { value: () => [] }),
  'too many keys': Object.fromEntries(Array.from({ length: MAX_COMMAND_IDS + 1 }, (_, index) => [`command${index}`, () => []])),
}))
  test(`row policy: rejects reference map ${name}`, () => rejects({ ...definition(), resultReferences }));

for (const id of [
  '',
  '1assign',
  '_assign',
  'assign.reviewer',
  'assign reviewer',
  'assign\n',
  'a'.repeat(257),
  ...Object.getOwnPropertyNames(Object.prototype),
  'prototype',
]) {
  test(`row policy: rejects reference command ID ${JSON.stringify(id)}`, () => {
    rejects({ ...definition(), resultReferences: { [id]: () => [] } });
  });
}

test('row policy: accepts a reference key per command an App registers and bounded command spelling, and refuses one more', () => {
  const resultReferences = Object.fromEntries(Array.from({ length: MAX_COMMAND_IDS - 2 }, (_, index) => [`command${index}`, () => []]));
  resultReferences['a'.repeat(256)] = () => [];
  resultReferences['Assign_reviewer-2'] = () => [];
  assert.equal(Object.keys(defineAppRowPolicy({ ...definition(), resultReferences }).resultReferences!).length, MAX_COMMAND_IDS);
  resultReferences.one_more = () => [];
  rejects({ ...definition(), resultReferences });
});

test('row policy: never invokes extractor accessors or proxy reflection traps', () => {
  let calls = 0;
  const trap = () => {
    calls++;
    throw new Error('private proxy/accessor data');
  };
  rejects({ ...definition(), resultReferences: Object.defineProperty({}, 'assign', { enumerable: true, get: trap }) });
  const proxy = new Proxy(definition(), { get: trap, getPrototypeOf: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
  rejects(proxy);
  rejects({ ...definition(), resultReferences: proxy });
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  rejects(revoked.proxy);
  assert.equal(calls, 0);
});

for (const extension of ['ts', 'mjs', 'js']) {
  test(`row policy loader: loads a default .${extension} declaration from an explicit local path`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
    const file = join(directory, `private policy #?.${extension}`);
    writeFileSync(
      file,
      `export default { appId: 'app-desk', resolveRows: () => ({ ticket: false }), resultReferences: { assign: () => [] } };`,
    );
    const policy = await loadAppRowPolicy(relative(process.cwd(), file));
    assert.equal(policy.appId, 'app-desk');
    assert.ok(Object.isFrozen(policy));
    assert.ok(Object.isFrozen(policy.resultReferences));
  });
}

test('row policy loader: uses Node module cache and snapshots mutable defaults', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-cache-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'policy.mjs');
  writeFileSync(
    file,
    `
    const policy = { appId: 'app-desk', resolveRows: () => ({ ticket: false }), resultReferences: { assign: () => [] } };
    export default policy;
    export function mutate() { policy.appId = 'changed'; policy.resolveRows = () => ({}); policy.resultReferences.assign = () => [{ table: 'private', key: { id: 1 } }]; }
  `,
  );
  const [first, second] = await Promise.all([loadAppRowPolicy(file), loadAppRowPolicy(file)]);
  assert.equal(first.resolveRows, second.resolveRows);
  assert.equal(first.resultReferences!.assign, second.resultReferences!.assign);
  // Replacing the file would break a fresh evaluation; the same module stays cached.
  writeFileSync(file, `throw new Error('private replacement');`);
  assert.equal((await loadAppRowPolicy(file)).resolveRows, first.resolveRows);
  const { pathToFileURL } = await import('node:url');
  const module = await import(pathToFileURL(file).href);
  module.mutate();
  assert.equal(first.appId, 'app-desk');
  assert.equal(first.resolveRows, second.resolveRows);
  assert.deepEqual(first.resultReferences!.assign({}), []);
});

test('row policy loader: accepts defineAppRowPolicy defaults without invoking callbacks', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-defined-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'policy.mjs');
  const api = new URL('../packages/mistri/src/server/policy/appRowPolicy.ts', import.meta.url).href;
  writeFileSync(
    file,
    `
    import { defineAppRowPolicy } from ${JSON.stringify(api)};
    export default defineAppRowPolicy({ appId: 'app-desk',
      resolveRows() { throw new Error('private resolver'); },
      resultReferences: { assign() { throw new Error('private extractor'); } }
    });
  `,
  );
  const policy = await loadAppRowPolicy(file);
  assert.equal(policy.appId, 'app-desk');
  assert.ok(Object.isFrozen(policy));
  assert.ok(Object.isFrozen(policy.resultReferences));
});

for (const [name, source] of Object.entries({
  'missing default': 'export const policy = {};',
  'invalid default': `export default { appId: 'private-value' };`,
  'throwing import': `throw new Error('private filename/environment data');`,
  'syntax error': 'export default ???',
  'getter default field': `export default { get appId() { throw new Error('private getter'); }, resolveRows() { return {}; } };`,
})) {
  test(`row policy loader: sanitizes ${name}`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-errors-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'private-filename.mjs');
    writeFileSync(file, source);
    await assert.rejects(loadAppRowPolicy(file), (error) => {
      sanitized(error);
      assert.doesNotMatch((error as Error).stack ?? '', /private-filename|private getter|private filename\/environment/);
      return true;
    });
  });
}

test('row policy loader: sanitizes missing files and invalid paths', async () => {
  for (const file of ['', ' ', '\0.mjs', 'https://example.invalid/policy.mjs', '/missing/private-policy.mjs', 'policy.json', null]) {
    await assert.rejects(loadAppRowPolicy(file as string), sanitized);
  }
});

/* The error stays one sentence; the operator's console hears why, and where
   (KS-OBSERVE #13): a package missing beside the module, the line that threw
   — never "run it on its own". A credential in a URL is masked on the way. */
test("row policy loader: records the loader's own reason and the module's line for the operator", async (t) => {
  const { refusalReasons } = await import('../packages/engine/src/server/evidence.js');
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-reason-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const missing = join(directory, 'missing.mjs'),
    throwing = join(directory, 'throwing.mjs');
  writeFileSync(missing, `// the policy\nimport pg from 'not-a-package-installed-here';\nexport default {};\n`);
  writeFileSync(throwing, `const url = 'postgres://app:hunter2@db/app';\n\nthrow new Error('no pool for ' + url);\n`);
  const reasons = async (file: string) => {
    try {
      await loadAppRowPolicy(file);
    } catch (error) {
      sanitized(error);
      return refusalReasons(error).join('\n');
    }
    throw new Error('loaded');
  };
  const said = await reasons(missing);
  assert.match(
    said,
    /The policy module "missing\.mjs" did not load: Cannot find package 'not-a-package-installed-here' imported from .*missing\.mjs \(missing\.mjs:2\)/,
  );
  assert.doesNotMatch(said, /on its own/);
  const threw = await reasons(throwing);
  assert.match(threw, /did not load: no pool for postgres:\/\/app:••••••@db\/app \(throwing\.mjs:3\)/);
  assert.doesNotMatch(threw, /hunter2/);
});
