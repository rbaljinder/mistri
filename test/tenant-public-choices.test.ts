/**
 * A tenant App's public form served with its choices from a table, on SQLite and on PostgreSQL: the quote form's
 * `make` field offers the rows of the tenant the request places — by the intake address its link carries, or on the
 * tenant's mapped host by the address that tenant holds — read as that tenant's visitor reads them (`auth.public`), and
 * nobody's for an address that places nobody. The submission and each saved step are placed by the same rule, so a
 * form read on a mapped host lands in that host's tenant, and an address beside the host is refused. Each tenant's
 * choices are kept apart, the tenant in the entry's key: one tenant's are never served under another's address, even
 * while they are kept, and a row change in one tenant (another process's commit, heard through the change store by
 * NOTIFY or the poll) drops that tenant's entry alone. A submission still reads its chosen key in the tenant it lands
 * in, so another tenant's key is refused at its field.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { after, describe, test } from 'node:test';
import { appendPostgresLiveChange } from '../packages/mistri/src/adapters/live/postgresLiveChange.js';
import { appendSqliteLiveChange } from '../packages/mistri/src/adapters/live/sqliteLiveChange.js';
import type { LiveChangeRow } from '../packages/mistri/src/adapters/live/liveChange.js';
import { cachedTenantChoices } from '../packages/mistri/src/server/forms/choiceCache.js';
import { tenantLiveHub } from '../packages/mistri/src/server/tenant/tenantLive.js';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  APP_ID,
  binding,
  NORTH,
  NORTH_HOST,
  openTenantPublicForms,
  publicFormsDatabase,
  SOUTH,
  UNKNOWN,
  via,
  type TenantPublicForms,
} from './support/tenantPublicForms.js';

const MAKE = { resource: 'make', by: 'id', labelColumn: 'name' };

async function until(what: string, check: () => Promise<boolean> | boolean, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`timed out: ${what}`);
    await sleep(50);
  }
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's public form offers each tenant its own choices (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    const open = (t: Parameters<typeof openTenantPublicForms>[0]) => openTenantPublicForms(t, dialect, database, { publicReads: true });
    const makes = async (f: TenantPublicForms, query: string, host?: string) => {
      const answer = await f.call(`/api/forms/quote${query}`, host ? { host: `${host}:${f.port}` } : {});
      assert.equal(answer.status, 200, answer.text);
      const field = answer.body.form.input.find((each: { name: string }) => each.name === 'make');
      assert.ok(field, answer.text);
      return (field.options as Array<{ value: string; label: string }>).map((option) => `${option.value}:${option.label}`);
    };
    /* Another process's commit to one tenant's make: the row and its change row, which names the tenant. */
    const committedElsewhere = async (f: TenantPublicForms, tenant: string, id: string, name: string) => {
      const row: LiveChangeRow = {
        at: Date.now(),
        actor: '',
        tenant,
        entries: [{ table: f.engine.id('make'), kind: 'insert', tenant, keys: [{ id }] }],
      };
      if (f.engine.dialect === 'sqlite') {
        const db = f.engine.sqlite();
        db.exec('BEGIN IMMEDIATE');
        db.prepare('INSERT INTO make VALUES (?, ?, ?)').run(id, tenant, name);
        appendSqliteLiveChange(db, row);
        db.exec('COMMIT');
      } else {
        const session = await f.engine.session();
        await session.query('BEGIN');
        await session.query('INSERT INTO public.make VALUES ($1, $2, $3)', [id, tenant, name]);
        await appendPostgresLiveChange(session, row);
        await session.query('COMMIT');
        await session.query(`SELECT pg_notify('mistri_live', '')`);
      }
    };

    test('the link places the choices: a dealer’s address its own rows, a mapped host its tenant’s, any other none', async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { publicReads: true });
      assert.deepEqual(await makes(f, via(NORTH)), ['n-ford:Ford', 'n-kia:Kia']);
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat']);
      for (const query of [via(UNKNOWN), via('north'), '']) assert.deepEqual(await makes(f, query), [], query);
      assert.deepEqual(await makes(f, '', NORTH_HOST), ['n-ford:Ford', 'n-kia:Kia']);
      // The list of forms says nothing in its URL, and a form's read says its address at most once.
      assert.equal((await f.call(`/api/forms${via(NORTH)}`)).status, 400);
      assert.equal((await f.call(`/api/forms/quote${via(NORTH)}&via=${SOUTH}`)).status, 400);
      assert.equal((await f.call(`/api/forms/quote?tenant=north`)).status, 400);
    });

    test("a mapped host names its tenant: another tenant's address there is refused for the read, the submission and a step", async (t) => {
      const f = await open(t);
      const onNorth = { host: `${NORTH_HOST}:${f.port}` };
      // Under north's host and brand, south's address would draw south's makes and land the submission with south.
      const read = await f.call(`/api/forms/quote${via(SOUTH)}`, onNorth);
      assert.equal(read.status, 400, read.text);
      assert.equal(read.body.code, 'invalid_input');
      assert.equal(read.text.includes('Fiat'), false);
      const submitted = await f.call(`/api/forms/quote${via(SOUTH)}`, {
        ...onNorth,
        body: { input: { name: 'Ada', make: 's-fiat' }, submission: randomUUID() },
      });
      assert.equal(submitted.status, 400, submitted.text);
      const stock = await f.call(`/api/forms/apply${via(SOUTH)}`, {
        ...onNorth,
        body: { input: { name: 'Bea' }, submission: randomUUID() },
      });
      assert.equal(stock.status, 400, stock.text);
      const step = await f.call(`/api/forms/draft/steps/name${via(SOUTH)}`, {
        ...onNorth,
        body: { input: { name: 'Cy' }, submission: randomUUID() },
      });
      assert.equal(step.status, 400, step.text);
      // Its own address on its own host is no different: the host has named the tenant already.
      assert.equal((await f.call(`/api/forms/quote${via(NORTH)}`, onNorth)).status, 400);
      assert.deepEqual(await f.rows('SELECT tenant_id, name FROM lead ORDER BY name'), []);
      assert.deepEqual(await f.rows('SELECT name FROM intake_submission ORDER BY name'), []);
    });

    test("a mapped host places a form's read, its submission and each saved step in its own tenant, by one rule", async (t) => {
      const f = await open(t);
      const onNorth = { host: `${NORTH_HOST}:${f.port}` };
      assert.deepEqual(await makes(f, '', NORTH_HOST), ['n-ford:Ford', 'n-kia:Kia']);
      // The make it was offered is the tenant's own, so the submission is placed where the read was.
      const quoted = await f.call('/api/forms/quote', {
        ...onNorth,
        body: { input: { name: 'Ada', make: 'n-ford' }, submission: randomUUID() },
      });
      assert.equal(quoted.status, 200, quoted.text);
      const applied = await f.call('/api/forms/apply', { ...onNorth, body: { input: { name: 'Bea' }, submission: randomUUID() } });
      assert.equal(applied.status, 200, applied.text);
      const stepped = await f.call('/api/forms/draft/steps/name', {
        ...onNorth,
        body: { input: { name: 'Cy' }, submission: randomUUID() },
      });
      assert.equal(stepped.status, 200, stepped.text);
      assert.deepEqual(await f.rows('SELECT tenant_id, name, make_id FROM lead ORDER BY name'), [
        { tenant_id: 'north', name: 'Ada', make_id: 'n-ford' },
        { tenant_id: 'north', name: 'Bea', make_id: null },
        { tenant_id: 'north', name: 'Cy', make_id: null },
      ]);
      assert.deepEqual(await f.rows('SELECT name FROM intake_submission ORDER BY name'), []);
      // The shared host with no address places nobody: the read offers nothing and the submission goes to triage.
      assert.deepEqual(await makes(f, ''), []);
      const triaged = await f.call('/api/forms/apply', { body: { input: { name: 'Dee' }, submission: randomUUID() } });
      assert.equal(triaged.status, 200, triaged.text);
      assert.deepEqual(await f.rows('SELECT name FROM intake_submission ORDER BY name'), [{ name: 'Dee' }]);
    });

    test("one tenant's kept choices are never served under another's address, and a change in one drops its entry alone", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { publicReads: true });
      const hub = tenantLiveHub({ appId: APP_ID, source: binding.source });
      assert.ok(hub, 'the change store is provisioned, and the App does not ask for live sync: its choice table is still heard');
      assert.deepEqual(await makes(f, via(NORTH)), ['n-ford:Ford', 'n-kia:Kia']);
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat']);
      await until('both entries are kept', () =>
        Boolean(cachedTenantChoices(hub, APP_ID, 'north', MAKE) && cachedTenantChoices(hub, APP_ID, 'south', MAKE)),
      );
      const southKept = cachedTenantChoices(hub, APP_ID, 'south', MAKE);
      // Behind the capture's back (no change row), north's rows change: the form is drawn from north's kept entry …
      await f.engine.exec(`UPDATE ${f.engine.id('make')} SET name = 'Kia Motors' WHERE id = 'n-kia'`);
      assert.deepEqual(await makes(f, via(NORTH)), ['n-ford:Ford', 'n-kia:Kia'], 'drawn from the cache');
      // … and south's address is answered south's own entry, never north's.
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat']);
      // A commit in north, heard: north's entry goes, south's stays as it was.
      await committedElsewhere(f, 'north', 'n-vw', 'Volkswagen');
      await until('north’s change is heard', () => cachedTenantChoices(hub, APP_ID, 'north', MAKE) === undefined);
      assert.equal(cachedTenantChoices(hub, APP_ID, 'south', MAKE), southKept, "south's entry is the same one");
      assert.deepEqual(await makes(f, via(NORTH)), ['n-ford:Ford', 'n-kia:Kia Motors', 'n-vw:Volkswagen']);
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat']);
      // A commit in south drops south's alone.
      await until('north is kept again', () => cachedTenantChoices(hub, APP_ID, 'north', MAKE) !== undefined);
      const northKept = cachedTenantChoices(hub, APP_ID, 'north', MAKE);
      await committedElsewhere(f, 'south', 's-seat', 'Seat');
      await until('south’s change is heard', () => cachedTenantChoices(hub, APP_ID, 'south', MAKE) === undefined);
      assert.equal(cachedTenantChoices(hub, APP_ID, 'north', MAKE), northKept);
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat', 's-seat:Seat']);
    });

    test("a write to one tenant's choice table through the deployment's own writer drops that tenant's entry alone", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { publicReads: true });
      const hub = tenantLiveHub({ appId: APP_ID, source: binding.source })!;
      await makes(f, via(NORTH));
      await makes(f, via(SOUTH));
      await until('both entries are kept', () =>
        Boolean(cachedTenantChoices(hub, APP_ID, 'north', MAKE) && cachedTenantChoices(hub, APP_ID, 'south', MAKE)),
      );
      const southKept = cachedTenantChoices(hub, APP_ID, 'south', MAKE);
      const suggested = await f.call(`/api/forms/suggest${via(NORTH)}`, { body: { input: { name: 'Skoda' }, submission: randomUUID() } });
      assert.equal(suggested.status, 200, suggested.text);
      await until('the writer’s capture is heard', () => cachedTenantChoices(hub, APP_ID, 'north', MAKE) === undefined);
      assert.equal(cachedTenantChoices(hub, APP_ID, 'south', MAKE), southKept);
      assert.deepEqual(await makes(f, via(NORTH)), ['n-ford:Ford', 'n-kia:Kia', 'x-skoda:Skoda']);
      assert.deepEqual(await makes(f, via(SOUTH)), ['s-fiat:Fiat']);
    });

    test("a submission reads its key in the tenant it lands in: another tenant's make is refused at its field", async (t) => {
      const f = await openTenantPublicForms(t, dialect, database, { publicReads: true });
      const quote = (address: string, make: string, name: string) =>
        f.call(`/api/forms/quote${via(address)}`, { body: { input: { name, make }, submission: randomUUID() } });
      const foreign = await quote(NORTH, 's-fiat', 'Ada');
      assert.equal(foreign.status, 400, foreign.text);
      assert.equal(foreign.body.field, 'make');
      const own = await quote(NORTH, 'n-ford', 'Bea');
      assert.equal(own.status, 200, own.text);
      assert.deepEqual(await f.rows('SELECT tenant_id, name, make_id FROM lead ORDER BY name'), [
        { tenant_id: 'north', name: 'Bea', make_id: 'n-ford' },
      ]);
    });
  });
}
