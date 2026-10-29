import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import {
  createTenantMembershipIssuer,
  parseTenantSelector,
  type TenantMembershipEvidence,
  type TenantMembershipOptions,
  type TenantMembershipRecord,
} from '../packages/mistri/src/server/tenant/tenantMembership.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { TenantContextError } from '../packages/engine/src/server/evidence.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';

type Request = { cookie?: string; tenant?: string; role?: string };
type Options = TenantMembershipOptions<Request>;
const schema: DatabaseSchema = {
  label: 'Tenant test',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'item',
      name: 'item',
      schema: '',
      isView: false,
      columns: [
        { name: 'id', type: 'TEXT', nullable: false, primaryKey: true },
        { name: 'tenant_id', type: 'TEXT', nullable: false, primaryKey: false },
      ],
    },
  ],
};
const ownership = () =>
  captureTenantOwnership({
    appId: 'app',
    source: { id: 'business', connection: 'owned-business' },
    schema,
    physicalSchema: schema,
    resources: { item: 'item' },
    ownership: { item: { kind: 'tenant', column: 'tenant_id' } },
  });
function fixture() {
  let time = 1000;
  const record = {
    appId: 'app',
    accountId: 'alice',
    tenantId: 'north',
    tenantStatus: 'active' as const,
    tenantVersion: '9007199254740993',
    membershipId: 'membership-1',
    membershipVersion: '1',
    status: 'active' as const,
    roles: ['reviewer'],
    validUntil: 20_000,
  };
  const options = {
    ownership: ownership(),
    deployment: 'generation-1',
    roles: ['reviewer', 'manager'],
    maxLifetimeMs: 5000,
    verifySession: (_request: Request) => ({ id: 'alice', who: 'Alice', role: 'platform_admin,manager' }),
    membership: { source: { id: 'business', connection: 'owned-business' }, read: (_lookup: unknown) => record },
    now: () => time,
  } satisfies Options;
  return {
    options,
    record,
    advance: (next: number) => {
      time = next;
    },
  };
}
const denied = (work: () => unknown) =>
  assert.rejects(
    async () => work(),
    (error: unknown) => {
      assert.ok(error instanceof TenantContextError);
      assert.equal(error.message, 'The tenant context could not be verified.');
      assert.equal('cause' in error, false);
      return true;
    },
  );
function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}
function frozen(value: unknown) {
  if (!value || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) frozen(child);
}
function capabilityTypes(evidence: TenantMembershipEvidence) {
  // @ts-expect-error Admission evidence cannot query records.
  void evidence.data;
  // @ts-expect-error Admission evidence cannot open a writer.
  void evidence.transaction;
  // @ts-expect-error Evidence cannot grant itself another membership.
  evidence.tenantId = 'south';
}
void capabilityTypes;

test('membership evidence binds verified identity/source/deployment and excludes global login roles', async () => {
  const f = fixture(),
    issuer = createTenantMembershipIssuer(f.options);
  const result = await issuer.withMembership({ tenant: 'south', role: 'manager' }, ['north'], (evidence) => {
    frozen(evidence);
    assert.deepEqual([...evidence.roles], ['reviewer']);
    assert.equal(evidence.accountId, 'alice');
    assert.equal(evidence.tenantId, 'north');
    assert.equal(evidence.tenantVersion, '9007199254740993');
    assert.equal(evidence.source.connection, 'owned-business');
    assert.equal(evidence.deployment, 'generation-1');
    assert.equal(evidence.validUntil, 6000);
    assert.equal(evidence.verifiedAt, 1000);
    assert.equal('data' in evidence || 'transaction' in evidence || 'commands' in evidence, false);
    return 42;
  });
  assert.equal(result, 42);
  await issuer.retire();
});

test('selectors require one canonical opaque value; duplicates never pick a winner', () => {
  for (const value of [
    undefined,
    null,
    [],
    ['north', 'north'],
    ['north', 'south'],
    [''],
    [' north'],
    ['North'],
    ['north '],
    ['a/b'],
    ['x\0'],
    ['é'],
    ['a'.repeat(129)],
    [1],
    { 0: 'north', length: 1 },
    // Read without a copy now: a proxy or a getter is still refused, never asked.
    new Proxy(['north'], {}),
    Object.defineProperty([''], '0', { get: () => 'north', enumerable: true }),
  ]) {
    assert.throws(() => parseTenantSelector(value as string[]), TenantContextError);
  }
  assert.equal(parseTenantSelector(['north-01_a']), 'north-01_a');
});

test('authentication precedes selector interpretation and membership lookup', async () => {
  const f = fixture();
  let verified = 0,
    lookedUp = 0;
  const issuer = createTenantMembershipIssuer({
    ...f.options,
    verifySession: () => {
      verified++;
      return null;
    },
    membership: {
      ...f.options.membership,
      read: () => {
        lookedUp++;
        return f.record;
      },
    },
  });
  await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
  assert.equal(verified, 1);
  assert.equal(lookedUp, 0);
});

for (const patch of [
  { appId: 'other' },
  { accountId: 'bob' },
  { tenantId: 'south' },
  { status: 'revoked' },
  { status: 'invited' },
  { tenantStatus: 'suspended' },
  { tenantStatus: 'closed' },
  { membershipId: '' },
  { membershipVersion: 1 },
  { membershipVersion: '01' },
  { tenantVersion: '-1' },
  { tenantVersion: '1e3' },
  { roles: ['admin'] },
  { roles: ['reviewer', 'reviewer'] },
  { roles: [null] },
  { roles: undefined },
  { validUntil: 1000 },
  { validUntil: NaN },
  { validUntil: Infinity },
  { validUntil: '10000' },
  { principal: { roles: ['manager'] } },
])
  test(`membership rejects invalid evidence ${JSON.stringify(patch)}`, async () => {
    const f = fixture();
    const issuer = createTenantMembershipIssuer({
      ...f.options,
      membership: { ...f.options.membership, read: () => ({ ...f.record, ...patch }) as TenantMembershipRecord },
    });
    await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
  });

test('unknown membership and provider failures use the same safe refusal', async () => {
  for (const read of [
    () => null,
    () => {
      throw new Error('/private/db secret=north');
    },
    async () => {
      throw new Error('SELECT secret FROM membership');
    },
  ]) {
    const f = fixture();
    const issuer = createTenantMembershipIssuer({ ...f.options, membership: { ...f.options.membership, read } });
    await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
  }
});

test('callbacks, options and synchronous result data are captured before microtasks mutate them', async () => {
  const f = fixture();
  const session = { id: 'alice', who: 'Alice', role: 'manager' };
  const options: Options = {
    ...f.options,
    verifySession: () => {
      queueMicrotask(() => {
        session.id = 'bob';
      });
      return session;
    },
    membership: {
      ...f.options.membership,
      read: (lookup) => {
        assert.equal(lookup.accountId, 'alice');
        frozen(lookup);
        queueMicrotask(() => {
          f.record.roles.push('manager');
          f.record.membershipVersion = '2';
        });
        return f.record;
      },
    },
  };
  const issuer = createTenantMembershipIssuer(options);
  Reflect.set(options, 'verifySession', () => assert.fail('replaced verifier'));
  Reflect.set(options.membership, 'read', () => assert.fail('replaced reader'));
  await issuer.withMembership({}, ['north'], async (evidence) => {
    await Promise.resolve();
    assert.deepEqual([...evidence.roles], ['reviewer']);
    assert.equal(evidence.membershipVersion, '1');
    assert.equal(evidence.accountId, 'alice');
  });
});

test('selectors are detached while authentication waits', async () => {
  const f = fixture(),
    auth = gate(),
    selectors = ['north'];
  const issuer = createTenantMembershipIssuer({
    ...f.options,
    verifySession: async () => {
      await auth.wait;
      return f.options.verifySession({});
    },
  });
  const accepted = issuer.withMembership({}, selectors, (evidence) => evidence.tenantId);
  selectors[0] = 'south';
  auth.release();
  assert.equal(await accepted, 'north');
});

test('configuration, session and membership getters/proxies/thenables never execute', async () => {
  let touched = 0;
  const f = fixture();
  const getter = Object.defineProperty({ ...f.options.membership }, 'read', {
    enumerable: true,
    get() {
      touched++;
      return f.options.membership.read;
    },
  });
  assert.throws(() => createTenantMembershipIssuer({ ...f.options, membership: getter }), TenantContextError);
  for (const hostile of [
    Object.defineProperty({ ...f.record }, 'roles', {
      enumerable: true,
      get() {
        touched++;
        return ['manager'];
      },
    }),
    new Proxy(f.record, {
      ownKeys() {
        touched++;
        return [];
      },
    }),
    // Deliberately hostile provider data: the issuer must never assimilate it.
    {
      // eslint-disable-next-line unicorn/no-thenable
      then() {
        touched++;
      },
    },
  ]) {
    const issuer = createTenantMembershipIssuer({
      ...f.options,
      membership: { ...f.options.membership, read: () => hostile as TenantMembershipRecord },
    });
    await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
    const login = createTenantMembershipIssuer({
      ...f.options,
      verifySession: () => hostile as unknown as ReturnType<typeof f.options.verifySession>,
    });
    await denied(() => login.withMembership({}, ['north'], () => assert.fail('no callback')));
  }
  assert.equal(touched, 0);
});

test('source substitution and malformed deployment lifetime/role ceilings refuse at construction', () => {
  const f = fixture();
  for (const patch of [
    { deployment: '' },
    { maxLifetimeMs: 0 },
    { maxLifetimeMs: 300001 },
    { maxLifetimeMs: NaN },
    { roles: ['reviewer', 'reviewer'] },
    { roles: [''] },
    { now: 1 },
    { membership: { ...f.options.membership, source: { id: 'business', connection: 'other' } } },
  ]) {
    assert.throws(() => createTenantMembershipIssuer({ ...f.options, ...patch } as Options), TenantContextError);
  }
});

test('expiry and a backwards clock reject buffered callback results', async () => {
  for (const next of [999, 6000, NaN]) {
    const f = fixture(),
      issuer = createTenantMembershipIssuer(f.options);
    await denied(() =>
      issuer.withMembership({}, ['north'], () => {
        f.advance(next);
        return 'not released';
      }),
    );
  }
  const f = fixture();
  f.record.validUntil = 1500;
  const issuer = createTenantMembershipIssuer(f.options);
  await denied(() =>
    issuer.withMembership({}, ['north'], (evidence) => {
      assert.equal(evidence.validUntil, 1500);
      f.advance(1500);
      return 'expired';
    }),
  );
});

test('slow authentication or membership cannot restart the admission lifetime', async () => {
  const f = fixture();
  let read = 0;
  const issuer = createTenantMembershipIssuer({
    ...f.options,
    verifySession: async () => {
      f.advance(6000);
      return f.options.verifySession({});
    },
    membership: {
      ...f.options.membership,
      read: () => {
        read++;
        return f.record;
      },
    },
  });
  await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
  assert.equal(read, 0);
  const second = fixture();
  const slow = createTenantMembershipIssuer({
    ...second.options,
    membership: {
      ...second.options.membership,
      read: async () => {
        second.advance(6000);
        return second.record;
      },
    },
  });
  await denied(() => slow.withMembership({}, ['north'], () => assert.fail('no callback')));
});

test('an async clock is refused safely without an unhandled provider rejection', async () => {
  const f = fixture();
  const issuer = createTenantMembershipIssuer({
    ...f.options,
    now: (() => Promise.reject(new Error('private clock provider failed'))) as unknown as () => number,
  });
  await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no callback')));
  await new Promise((resolve) => setImmediate(resolve));
});

test('retirement stops new admissions and drains accepted callbacks without releasing their results', async () => {
  const f = fixture(),
    entered = gate(),
    finish = gate(),
    issuer = createTenantMembershipIssuer(f.options);
  const accepted = issuer.withMembership({}, ['north'], async () => {
    entered.release();
    await finish.wait;
    return 'private';
  });
  const rejected = denied(() => accepted);
  await entered.wait;
  let retired = false;
  const retirement = issuer.retire().then(() => {
    retired = true;
  });
  await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('no new callback')));
  assert.equal(retired, false);
  finish.release();
  await rejected;
  await retirement;
  assert.equal(retired, true);
  await issuer.retire();
});

test('a verifier can retire reentrantly without escaping the retirement drain', async () => {
  const f = fixture();
  let retirement: Promise<void> | undefined;
  const issuer = createTenantMembershipIssuer({
    ...f.options,
    verifySession: () => {
      retirement = issuer.retire();
      return f.options.verifySession({});
    },
  });
  await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('retired callback')));
  await retirement;
});

for (const at of [1, 2, 3, 4])
  test(`clock reentrancy at read ${at} cannot enter a retired callback or release its result`, async () => {
    const f = fixture();
    let clocks = 0,
      callbacks = 0,
      retirement: Promise<void> | undefined;
    const issuer = createTenantMembershipIssuer({
      ...f.options,
      now: () => {
        if (++clocks === at) retirement = issuer.retire();
        return 1000;
      },
    });
    await denied(() =>
      issuer.withMembership({}, ['north'], () => {
        callbacks++;
        return 'not released';
      }),
    );
    assert.equal(callbacks, at === 4 ? 1 : 0);
    await retirement;
  });

test('fresh SQLite membership admission observes revocation and a new invitation identity', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(`CREATE TABLE membership(tenant TEXT NOT NULL, account TEXT NOT NULL, id TEXT NOT NULL,
      version TEXT NOT NULL, status TEXT NOT NULL, roles TEXT NOT NULL, PRIMARY KEY(tenant,account));
      INSERT INTO membership VALUES('north','alice','membership-1','1','active','["reviewer"]');
      INSERT INTO membership VALUES('south','alice','membership-2','1','active','["manager"]');`);
    const f = fixture();
    const issuer = createTenantMembershipIssuer({
      ...f.options,
      membership: {
        ...f.options.membership,
        read: (lookup) => {
          const row = db.prepare('SELECT * FROM membership WHERE tenant=? AND account=?').get(lookup.tenantId, lookup.accountId);
          return row
            ? ({
                ...f.record,
                tenantId: row.tenant,
                accountId: row.account,
                membershipId: row.id,
                membershipVersion: row.version,
                status: row.status,
                roles: JSON.parse(String(row.roles)),
              } as TenantMembershipRecord)
            : null;
        },
      },
    });
    assert.equal(await issuer.withMembership({}, ['north'], (value) => value.membershipId), 'membership-1');
    assert.deepEqual(await issuer.withMembership({}, ['south'], (value) => [...value.roles]), ['manager']);
    db.exec("UPDATE membership SET status='revoked',version='2' WHERE tenant='north'");
    await denied(() => issuer.withMembership({}, ['north'], () => assert.fail('revoked')));
    db.exec("UPDATE membership SET status='active',version='1',id='membership-3' WHERE tenant='north'");
    assert.equal(await issuer.withMembership({}, ['north'], (value) => value.membershipId), 'membership-3');
    await issuer.retire();
  } finally {
    db.close();
  }
});
