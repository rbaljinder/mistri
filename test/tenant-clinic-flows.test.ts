/**
 * The clinic fixture's flows past a member's own reads, end to end over HTTP as a deployment serves them: a visitor's
 * request placed by its clinic's intake address and the price list read by its public address; Manage tenants, where
 * the operator creates a clinic, grants a member and suspends it; an owner's invitation claimed by someone signed
 * out; and an owner's sandbox, cloned, changed and imported back. Each flow beside what it must refuse, on SQLite
 * and on PostgreSQL.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { liveSkip } from './live.js';
import { createTestClient } from '../packages/mistri/src/server/testing/client.ts';
import { tenantTestClient } from '../packages/mistri/src/server/testing/tenant.ts';
import { ADMINISTRATION_HTTP_HEADER, ADMINISTRATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantAdministration.ts';
import { INVITATION_HTTP_HEADER, INVITATION_HTTP_ROOT } from '../packages/mistri/src/shared/tenantInvitations.ts';
import { TENANT_HTTP_HEADERS } from '../packages/mistri/src/shared/tenantContext.ts';
import { ADDRESSES, startClinic, type Engine } from './support/clinicFixture.ts';

const LIVE = process.env.TABLEWALK_TEST_PG;
const DAY = 24 * 60 * 60 * 1000;
const ids = (rows: readonly Record<string, unknown>[]) => rows.map((row) => String(row.id)).sort();

type Session = ReturnType<typeof createTestClient>;
type Answer = { status: number; body: any; text: string };

async function answer(response: Response): Promise<Answer> {
  const text = await response.text();
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    /* Not JSON: the text says what it is. */
  }
  return { status: response.status, body, text };
}

/** A signed-in session's account id, as the sign-in answers it. */
async function signedIn(origin: string, email: string, password: string) {
  const session = createTestClient(origin, { app: 'clinic' });
  const reply = (await (await session.signIn(email, password)).json()) as { user: { id: string } };
  return { session, account: { accountId: reply.user.id, email, password } };
}

/** A person who signed up, as anyone may: a member of nothing until a grant or an invitation says so. */
async function signUp(origin: string, email: string, name: string) {
  const password = `${name.replace(/\W/g, '')}-Pw-${randomUUID().slice(0, 8)}`;
  const session = createTestClient(origin, { app: 'clinic' });
  const reply = (await (await session.signUp({ email, password, name })).json()) as { user: { id: string } };
  return { accountId: reply.user.id, email, password };
}

/** One person's administration or invitation surface: opened once, then each call carries its context. */
async function surface(session: Session, accountId: string, root: string, header: string, opener: string) {
  const identity = { [TENANT_HTTP_HEADERS.app]: 'clinic', [TENANT_HTTP_HEADERS.account]: accountId };
  const opened = await answer(await session.request(`${root}/${opener}?app=clinic`, { method: 'POST', json: {}, headers: identity }));
  assert.equal(opened.status, 200, opened.text);
  const owned = { ...identity, [header]: opened.body.session?.context ?? '' };
  return {
    session: opened.body.session,
    get: async (operation: string, query = '') =>
      answer(await session.request(`${root}/${operation}?app=clinic${query}`, { headers: owned })),
    post: async (operation: string, body: unknown) =>
      answer(await session.request(`${root}/${operation}?app=clinic`, { method: 'POST', json: body, headers: owned })),
    execute: async (intent: Record<string, unknown>) =>
      answer(
        await session.request(`${root}/execute?app=clinic`, {
          method: 'POST',
          json: { idempotencyKey: randomUUID(), intent },
          headers: owned,
        }),
      ),
  };
}
const administration = (session: Session, accountId: string) =>
  surface(session, accountId, ADMINISTRATION_HTTP_ROOT, ADMINISTRATION_HTTP_HEADER, 'open');
const invitations = (session: Session, accountId: string) =>
  surface(session, accountId, INVITATION_HTTP_ROOT, INVITATION_HTTP_HEADER, 'open-issuer');

/** A tenant's version, as Manage tenants lists it to this person. */
async function versionOf(admin: Awaited<ReturnType<typeof administration>>, tenantId: string): Promise<string> {
  const page = await admin.get('tenants');
  assert.equal(page.status, 200, page.text);
  const item = (page.body.page.items as Array<{ tenantId: string; tenant: { version: string } }>).find(
    (each) => each.tenantId === tenantId,
  );
  assert.ok(item, `${tenantId} is listed: ${page.text}`);
  return item.tenant.version;
}

const applied = (reply: Answer) => {
  assert.equal(reply.status, 200, reply.text);
  assert.equal(reply.body.outcome, 'applied', reply.text);
  return reply.body.result;
};
/* Refused before anything is written, in the same words whatever the reason: no grant, another clinic, a role
   beyond the grant. */
const refused = (reply: Answer, what: string) => {
  assert.equal(reply.status, 403, `${what}: ${reply.text}`);
  assert.equal(reply.body.outcome, 'not_applied', `${what}: ${reply.text}`);
};

async function flows(t: TestContext, engine: Engine) {
  const { host, operator } = await startClinic(t, engine);
  const origin = host.url;
  const north = await host.tenant('north', { roles: ['owner'] });
  const south = await host.tenant('south', { roles: ['owner'] });
  const platform = await host.platform({ roles: ['operator'] });
  const visitor = createTestClient(origin);

  await t.test("a visitor's request lands in the clinic its intake address names, and an unknown one in triage", async () => {
    const submit = (query: string, input: Record<string, string>, submission = randomUUID()) =>
      visitor.request(`/api/forms/request-visit${query}`, { method: 'POST', json: { input, submission } });
    const placed = await answer(await submit(`?via=${ADDRESSES.north.intake}`, { name: 'Dee Visitor', phone: '555-0303' }));
    assert.equal(placed.status, 200, placed.text);
    assert.match(placed.body.reference, /^VISIT-/);
    const requests = await north.rows('visit_request');
    assert.ok(requests.ok, requests.ok ? '' : requests.message);
    assert.deepEqual(
      requests.value.map((row) => row.name),
      ['Dee Visitor'],
    );
    const theirs = await south.rows('visit_request');
    assert.ok(theirs.ok);
    assert.deepEqual(theirs.value, []);

    // No address, or one no clinic holds: the platform's triage, never a clinic's.
    for (const [query, name] of [
      ['', 'No address'],
      [`?via=${'x'.repeat(28)}`, 'Unknown address'],
    ]) {
      const reply = await answer(await submit(query, { name, phone: '555-0404' }));
      assert.equal(reply.status, 200, reply.text);
    }
    const triage = await platform.rows('triage');
    assert.ok(triage.ok, triage.ok ? '' : triage.message);
    assert.deepEqual(triage.value.map((row) => row.name).sort(), ['No address', 'Unknown address']);
    const after = await north.rows('visit_request');
    assert.ok(after.ok && after.value.length === 1);

    // A visitor names no tenant: a selector beside the address, or a second address, is refused and lands nowhere.
    for (const query of [`?via=${ADDRESSES.north.intake}&tenant=south`, `?via=${ADDRESSES.north.intake}&via=${ADDRESSES.south.intake}`]) {
      const reply = await submit(query, { name: 'Mallory', phone: '555-0505' });
      assert.equal(reply.status, 400, query);
    }
    const header = await visitor.request(`/api/forms/request-visit?via=${ADDRESSES.north.intake}`, {
      method: 'POST',
      json: { input: { name: 'Mallory', phone: '555-0505' }, submission: randomUUID() },
      headers: { [TENANT_HTTP_HEADERS.tenant]: 'south' },
    });
    assert.equal(header.status, 400);
    const southAfter = await south.rows('visit_request');
    assert.ok(southAfter.ok);
    assert.deepEqual(southAfter.value, []);
  });

  await t.test("a visitor reads a clinic's published price list by its public address, and no other column or clinic", async () => {
    const list = await answer(
      await visitor.request(`/api/query?via=${ADDRESSES.north.public}`, { method: 'POST', json: { table: 'service' } }),
    );
    assert.equal(list.status, 200, list.text);
    assert.deepEqual(ids(list.body.rows), ['sv-north-checkup']);
    for (const row of list.body.rows) assert.deepEqual(Object.keys(row).sort(), ['id', 'name', 'price_cents']);
    const southList = await answer(
      await visitor.request(`/api/query?via=${ADDRESSES.south.public}`, { method: 'POST', json: { table: 'service' } }),
    );
    assert.deepEqual(ids(southList.body.rows), ['sv-south-checkup']);
    // A table the public grant leaves out, a column it leaves out, an intake address used as a public one: refused.
    for (const [query, body] of [
      [`?via=${ADDRESSES.north.public}`, { table: 'patient' }],
      [`?via=${ADDRESSES.north.public}`, { table: 'service', filter: { groups: [[{ column: 'published', op: '=', value: 0 }]] } }],
      [`?via=${ADDRESSES.north.intake}`, { table: 'service' }],
      ['', { table: 'service' }],
    ] as const) {
      const reply = await answer(await visitor.request(`/api/query${query}`, { method: 'POST', json: body }));
      assert.ok(reply.status !== 200 || !reply.body.rows?.length, `${query} ${JSON.stringify(body)}: ${reply.text}`);
      assert.doesNotMatch(reply.text, /Ada North|staff screening/);
    }
  });

  await t.test('the operator creates a clinic in Manage tenants, grants its first member, and suspends it', async () => {
    const signed = createTestClient(origin, { app: 'clinic' });
    await signed.signIn(operator.email, operator.password);
    const admin = await administration(signed, operator.accountId);
    // A clinic beyond the operator's list is refused, and so is a role it was not given.
    refused(await admin.execute({ operation: 'createTenant', tenantId: 'west' }), 'createTenant west');
    const created = applied(await admin.execute({ operation: 'createTenant', tenantId: 'east' }));
    const version = created.change.after.tenant.version as string;

    const account = await signUp(origin, 'eve@clinic.example.test', 'Eve East');
    // Signed up, Eve is a member of nothing.
    await assert.rejects(tenantTestClient(origin, 'clinic', account, 'east'));
    const granted = applied(
      await admin.execute({
        operation: 'grantMembership',
        tenantId: 'east',
        expectedTenantVersion: version,
        accountId: account.accountId,
        roles: ['reception'],
        validUntil: Date.now() + 30 * DAY,
      }),
    );
    const member = await tenantTestClient(origin, 'clinic', account, 'east');
    const rows = await member.rows('appointment');
    assert.ok(rows.ok, rows.ok ? '' : rows.message);
    assert.deepEqual(rows.value, []);
    assert.equal((await member.enter('north')).ok, false);

    // Suspended, the clinic opens to no one: a new lease is refused, and the one Eve held reads nothing more.
    applied(
      await admin.execute({
        operation: 'setTenantStatus',
        tenantId: 'east',
        expectedTenantVersion: granted.change.after.tenant.version,
        status: 'suspended',
      }),
    );
    await assert.rejects(tenantTestClient(origin, 'clinic', account, 'east'));
    assert.equal((await member.rows('appointment')).ok, false);
    // A member of a clinic opens no administration of the operator's operations.
    const owner = await administration(north, north.account.accountId);
    refused(await owner.execute({ operation: 'createTenant', tenantId: 'east-2' }), "an owner's createTenant");
    refused(
      await owner.execute({ operation: 'setTenantStatus', tenantId: 'south', expectedTenantVersion: '1', status: 'suspended' }),
      "an owner's suspension of another clinic",
    );
    assert.ok((await south.rows('appointment')).ok, 'south still opens');
  });

  await t.test("a clinic's owner grants reception in its own clinic only, and no owner", async () => {
    const admin = await administration(north, north.account.accountId);
    const version = await versionOf(admin, 'north');
    const account = await signUp(origin, 'fay@clinic.example.test', 'Fay North');
    const grant = (tenantId: string, expected: string, roles: string[]) =>
      admin.execute({
        operation: 'grantMembership',
        tenantId,
        expectedTenantVersion: expected,
        accountId: account.accountId,
        roles,
        validUntil: Date.now() + 30 * DAY,
      });
    refused(await grant('north', version, ['owner']), 'a delegate granting owner');
    refused(await grant('south', '1', ['reception']), 'a delegate granting in another clinic');
    applied(await grant('north', version, ['reception']));
    const fay = await tenantTestClient(origin, 'clinic', account, 'north');
    assert.ok((await fay.rows('patient')).ok);
    assert.equal((await fay.enter('south')).ok, false);
    // Reception holds no administration operation: what it asks is refused.
    const reception = await administration(fay, account.accountId);
    refused(
      await reception.execute({
        operation: 'grantMembership',
        tenantId: 'north',
        expectedTenantVersion: version,
        accountId: south.account.accountId,
        roles: ['reception'],
        validUntil: Date.now() + DAY,
      }),
      'reception granting',
    );
  });

  await t.test("an owner's invitation is claimed by someone signed out, who then works in that clinic alone", async () => {
    const issuer = await invitations(north, north.account.accountId);
    const admin = await administration(north, north.account.accountId);
    const version = await versionOf(admin, 'north');
    const issue = (intent: Record<string, unknown>) =>
      issuer.execute({
        operation: 'issueInvitation',
        tenantId: 'north',
        expectedTenantVersion: version,
        roles: ['reception'],
        redeemUntil: Date.now() + DAY,
        validUntil: Date.now() + 30 * DAY,
        ...intent,
      });
    refused(await issue({ email: 'gus@clinic.example.test', roles: ['owner'] }), 'an owner invitation from a delegate');
    refused(await issue({ email: 'gus@clinic.example.test', tenantId: 'south' }), 'an invitation into another clinic');
    const issued = await issue({ email: 'gus@clinic.example.test' });
    applied(issued);
    const token = issued.body.token as string;
    assert.equal(typeof token, 'string');

    const claim = (body: Record<string, unknown>, headers: Record<string, string> = {}) =>
      createTestClient(origin).request(`${INVITATION_HTTP_ROOT}/claim?app=clinic`, { method: 'POST', json: body, headers });
    const password = 'north-claimed-Pw-2026';
    // A claim carries no tenant or account header, and a token it was not issued is refused.
    assert.notEqual((await claim({ token, name: 'Gus North', password }, { [TENANT_HTTP_HEADERS.account]: 'someone' })).status, 200);
    assert.notEqual((await claim({ token: `${token.slice(0, -2)}xx`, name: 'Gus North', password })).status, 200);
    const claimed = await answer(await claim({ token, name: 'Gus North', password }));
    assert.equal(claimed.status, 200, claimed.text);
    assert.equal(claimed.body.account, 'created');
    // Claimed once: again, it is refused.
    assert.notEqual((await claim({ token, name: 'Gus Again', password })).status, 200);

    const { account } = await signedIn(origin, 'gus@clinic.example.test', password);
    const gus = await tenantTestClient(origin, 'clinic', account, 'north');
    const rows = await gus.rows('appointment');
    assert.ok(rows.ok, rows.ok ? '' : rows.message);
    assert.ok(ids(rows.value).every((id) => id.startsWith('ap-north-')));
    assert.equal((await gus.enter('south')).ok, false);
    // Reception, as invited: no price-list edit, which only an owner writes.
    const edit = await gus.update('service', { id: 'sv-north-checkup' }, { price_cents: 1 });
    assert.equal(edit.ok, false);
  });

  await t.test("an owner's sandbox copies the price list, and its change is imported back into its own clinic only", async () => {
    const admin = await administration(north, north.account.accountId);
    const version = await versionOf(admin, 'north');
    // Another clinic is not the owner's to clone; reception clones nothing.
    refused(
      await admin.execute({
        operation: 'cloneTenant',
        tenantId: 'south-sandbox',
        sourceTenantId: 'south',
        expectedSourceVersion: '1',
        samples: false,
      }),
      'clone of another clinic',
    );
    const made = applied(
      await admin.execute({
        operation: 'cloneTenant',
        tenantId: 'north-sandbox',
        sourceTenantId: 'north',
        expectedSourceVersion: version,
        samples: false,
      }),
    );
    assert.deepEqual(made.change.after.membership?.roles, ['owner']);

    const sandbox = await tenantTestClient(origin, 'clinic', north.account, 'north-sandbox');
    const copied = await sandbox.rows('service');
    assert.ok(copied.ok, copied.ok ? '' : copied.message);
    assert.deepEqual(copied.value.map((row) => row.name).sort(), ['North check-up', 'North staff screening']);
    // Configuration only: no patient, appointment or payment leaves the clinic.
    for (const table of ['patient', 'appointment', 'payment']) {
      const rows = await sandbox.rows(table);
      assert.ok(rows.ok);
      assert.deepEqual(rows.value, [], table);
    }
    const checkup = copied.value.find((row) => row.name === 'North check-up')!;
    const changed = await sandbox.update('service', await sandbox.key('service', checkup), { price_cents: 13500 });
    assert.ok(changed.ok, changed.ok ? '' : changed.message);

    const sandboxVersion = await versionOf(admin, 'north-sandbox').catch(() => '1');
    const plan = await admin.get('import-plan', '&tenantId=north&sandboxTenantId=north-sandbox');
    assert.equal(plan.status, 200, plan.text);
    // An import names its own source only: into south, refused.
    refused(
      await admin.execute({
        operation: 'importTenant',
        tenantId: 'south',
        expectedTenantVersion: '1',
        sandboxTenantId: 'north-sandbox',
        expectedSandboxVersion: sandboxVersion,
      }),
      'import into another clinic',
    );
    const southBefore = await south.rows('service');
    applied(
      await admin.execute({
        operation: 'importTenant',
        tenantId: 'north',
        expectedTenantVersion: await versionOf(admin, 'north'),
        sandboxTenantId: 'north-sandbox',
        expectedSandboxVersion: sandboxVersion,
      }),
    );
    const live = await north.rows('service');
    assert.ok(live.ok);
    assert.equal(live.value.find((row) => row.id === 'sv-north-checkup')?.price_cents, 13500);
    assert.deepEqual(await south.rows('service'), southBefore);
  });
}

test('the clinic fixture on SQLite: intake, public reads, Manage tenants, invitations and a sandbox', { timeout: 240000 }, (t) =>
  flows(t, 'sqlite'),
);
test(
  'the clinic fixture on PostgreSQL: intake, public reads, Manage tenants, invitations and a sandbox',
  { skip: liveSkip('postgres', LIVE), timeout: 240000 },
  (t) => flows(t, 'postgres'),
);
