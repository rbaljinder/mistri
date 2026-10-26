import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import site from '../test/fixtures/apps/keystone/site/app.ts';
import policy from '../test/fixtures/apps/keystone/site/policy.ts';
import commands from '../test/fixtures/apps/keystone/site/commands.ts';
import type { Rows } from '../test/fixtures/apps/keystone/site/mistri-schema.d.ts';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionSqlitePublicPlacementJournal } from '../packages/mistri/src/adapters/commands/publicPlacementJournal.js';
import { PUBLIC_PLACEMENT_TABLES } from '../packages/mistri/src/adapters/commands/publicPlacementSchema.js';
import { mapOpenedAppRuntimeResources } from '../packages/mistri/src/server/app/appRuntimeResourceMapping.js';
import { BusinessCommandExecutionError } from '../packages/mistri/src/server/commands/businessCommandExecution.js';
import { appCommandCatalog } from '../packages/mistri/src/server/commands/commandContracts.js';
import { createPublicPlacementBindingIssuer } from '../packages/mistri/src/server/forms/publicPlacementBinding.js';
import { createAppPolicyContext } from '../packages/mistri/src/server/policy/appPolicyContext.js';
import { createPolicyDb, type PolicyDb } from '../packages/mistri/src/server/policy/policyDb.js';
import { bindPolicyPublicIntake } from '../packages/mistri/src/server/policy/policyPublicIntake.js';
import { bindPolicyPublicPlacement } from '../packages/mistri/src/server/policy/policyPublicPlacement.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { loadAppRowPolicy, type PublicPlacementIntent } from '../packages/mistri/src/server/policy/appRowPolicy.js';

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'keystone-site-placement-'));
  const file = join(directory, 'fixture.db'),
    database = new DatabaseSync(file);
  const booleans = new Set(['published', 'show_prices', 'featured', 'active', 'advertised']);
  // Small disposable physical fixture, using the real App's complete public column ceilings.
  for (const [table, fields] of Object.entries(site.auth.public.fields)) {
    const columns = [...fields.read] as string[];
    if (table === 'dealer') columns.push('status', 'version', 'intake_address', 'email');
    if (table === 'dealer_site') columns.push('custom_domain');
    if (table === 'vehicle') columns.push('cost');
    const definition = columns.map(
      (column) =>
        `"${column}" ${booleans.has(column) ? 'BOOLEAN' : column === 'version' ? 'INTEGER' : 'TEXT'}${column === 'id' ? ' PRIMARY KEY NOT NULL' : ''}`,
    );
    if (table === 'dealer_site') definition.push('UNIQUE(dealer_id)', 'FOREIGN KEY(dealer_id) REFERENCES dealer(id)');
    if (table === 'vehicle')
      definition.push('UNIQUE(dealer_id,id)', 'UNIQUE(dealer_id,stock_number)', 'FOREIGN KEY(dealer_id) REFERENCES dealer(id)');
    if (table === 'vehicle_photo') definition.push('FOREIGN KEY(dealer_id,vehicle_id) REFERENCES vehicle(dealer_id,id)');
    database.exec(`CREATE TABLE "${table}" (${definition.join(',')})`);
  }
  // Same ownership and unique application constraints as Keystone schema.sql.
  database.exec(`CREATE TABLE lead(id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    dealer_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT, source TEXT NOT NULL, status TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, phone TEXT, vehicle_id TEXT, message TEXT,
    created_at TEXT NOT NULL, next_follow_up_on TEXT, version INTEGER NOT NULL DEFAULT 0,
    UNIQUE(dealer_id,id), UNIQUE(dealer_id,reference), FOREIGN KEY(dealer_id,vehicle_id) REFERENCES vehicle(dealer_id,id));
    CREATE TABLE lead_activity(id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    dealer_id TEXT NOT NULL REFERENCES dealer(id), lead_id TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(dealer_id,lead_id) REFERENCES lead(dealer_id,id));
    CREATE TABLE applicant(id TEXT PRIMARY KEY NOT NULL DEFAULT (lower(hex(randomblob(16)))),
    dealer_id TEXT NOT NULL REFERENCES dealer(id), lead_id TEXT NOT NULL, role TEXT NOT NULL,
    first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL,
    date_of_birth TEXT NOT NULL, ssn_last4 TEXT NOT NULL, street TEXT NOT NULL, city TEXT NOT NULL, state TEXT NOT NULL, zip TEXT NOT NULL,
    housing TEXT NOT NULL, monthly_housing TEXT NOT NULL, years_at_address TEXT NOT NULL, employer TEXT, job_title TEXT,
    employment_type TEXT NOT NULL, years_employed TEXT NOT NULL, monthly_income TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(dealer_id,lead_id,role), FOREIGN KEY(dealer_id,lead_id) REFERENCES lead(dealer_id,id));`);
  database.exec(`PRAGMA foreign_keys=ON;
    INSERT INTO dealer(id,name,status,version,intake_address,email) VALUES
      ('north','North Motors','active',3,'private-north','private@example.test'),
      ('south','South Motors','active',4,'private-south','other@example.test'),
      ('held','Held Motors','on_hold',1,NULL,NULL),('draft','Draft Motors','active',1,NULL,NULL);
    INSERT INTO dealer_site(id,dealer_id,published,version,headline,brand_color,custom_domain) VALUES
      ('site-north','north',1,7,'North headline','#1d3f8c','private-domain.example'),
      ('site-south','south',1,8,'South headline','#1d3f8c',NULL),
      ('site-held','held',1,1,'Held headline','#1d3f8c',NULL),
      ('site-draft','draft',0,1,'Draft headline','#1d3f8c',NULL);
    INSERT INTO vehicle(id,dealer_id,stock_number,status,version,cost) VALUES
      ('north-car','north','NM1001','listed',2,'private-cost'),
      ('north-unlisted','north','NM1002','in_stock',0,'private-cost'),
      ('south-car','south','SM1001','listed',3,'private-cost');
    INSERT INTO vehicle_photo(id,dealer_id,vehicle_id,caption,data) VALUES
      ('north-photo','north','north-car','North photo','north bytes'),
      ('south-photo','south','south-car','South photo','south bytes');
    INSERT INTO program(id,name,active,advertised) VALUES ('rate','Shared rate',1,1),('unadvertised','Unadvertised',0,0);`);
  migrateSqliteCommandJournal(file);
  provisionSqlitePublicPlacementJournal(file);
  const adapter = new SqliteAdapter(file);
  const bindings: Array<{ retire(): Promise<void> }> = [];
  t.after(async () => {
    await Promise.all(bindings.map((binding) => binding.retire()));
    await adapter.close();
    database.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const app = parseAppConfig(
    {
      id: 'site',
      name: site.name,
      sources: site.sources,
      resources: site.resources,
      auth: site.auth,
      views: {
        inventory: { kind: 'list', from: 'vehicle' },
        ask: site.views.ask,
        apply: site.views.apply,
        'test-drive': site.views['test-drive'],
      },
      home: 'inventory',
    },
    'Site policy fixture',
    { commands: appCommandCatalog(commands, site as never) },
  );
  const sourceConnections = new Map([['keystone', 'keystone']]);
  const resources = mapOpenedAppRuntimeResources(
    app,
    'keystone',
    new Map([
      [
        'keystone',
        {
          adapter,
          schema: await adapter.introspect(),
          writable: true,
          resources: Object.fromEntries(Object.keys(site.resources).map((name) => [name, name])),
        },
      ],
    ]),
    sourceConnections,
  );
  const context = { db: createPolicyDb(resources) as PolicyDb<Rows> };
  const issuer = createAppPolicyContext<PublicPlacementIntent | null>({
    app,
    resources,
    sourceConnections,
    verifySession: async () => null,
    resolveRows: (principal) => policy.resolveRows(principal, context),
    resolvePublicRows: (intent) => policy.resolvePublicRows!(intent, context),
  });
  t.after(() => issuer.retire());
  const bindingIssuer = createPublicPlacementBindingIssuer({
    issuerId: 'site-test',
    activeKey: 'one',
    keys: [{ id: 'one', secret: randomBytes(32).toString('base64url'), issueFrom: 0 }],
  });
  const deployedPolicy = await loadAppRowPolicy(fileURLToPath(new URL('../test/fixtures/apps/keystone/site/policy.ts', import.meta.url)));
  const bind = (form: string) => {
    const bound = bindPolicyPublicPlacement({
      app,
      policy: deployedPolicy,
      resources,
      registry: commands,
      form,
      sourceConnections,
      sourceIdentity: 'disposable-keystone',
      epoch: 'fixture-1',
      formRevision: 'site-1',
      issuer: bindingIssuer,
      policyContext: { db: createPolicyDb(resources) },
      writableConnection: () => true,
    });
    bindings.push(bound);
    return bound;
  };
  const bindFixed = async (form: string) => {
    const enrollment = policy.publicForms![form];
    assert.ok('kind' in enrollment);
    const { rows } = await enrollment.resolvePlacement({ appId: 'site', tenant: 'north' }, context);
    // A legacy ordinary binder has no placement capability, even with the same footprint.
    const bound = bindPolicyPublicIntake({
      app,
      resources,
      registry: commands,
      form,
      rows: Object.fromEntries(Object.entries(rows).filter(([table]) => table !== 'dealer_site')),
      resultReferences: () => [],
      writableConnection: () => true,
    });
    bindings.push(bound);
    return bound;
  };
  return { database, context, issuer, bind, bindFixed };
}

test('Site public reads isolate exact dealer rows, joins, files and counts while hiding policy-only columns', async (t) => {
  const { issuer } = await fixture(t);
  for (const tenant of ['north', 'south'])
    await issuer.withPublicContext({ appId: 'site', tenant }, async ({ data, schema }) => {
      const own = await data.query({ table: 'dealer', limit: 10, offset: 0 });
      assert.deepEqual(
        own.rows.map((row) => row.id),
        [tenant],
      );
      assert.equal('status' in own.rows[0], false);
      assert.equal('intake_address' in own.rows[0], false);
      assert.equal(
        schema.tables.find((table) => table.id === 'dealer')!.columns.some((column) => column.name === 'status'),
        false,
      );
      assert.equal(await data.count('vehicle'), tenant === 'north' ? 2 : 1);
      const joined = await data.runView({
        id: 'inventory-join',
        name: 'Inventory',
        base: 'vehicle',
        columns: [{ path: 'id' }, { path: 'dealer_id.name' }],
      });
      assert.equal(joined.rows.length, tenant === 'north' ? 2 : 1);
      assert.doesNotMatch(JSON.stringify(joined.rows), tenant === 'north' ? /South Motors/ : /North Motors/);
      assert.deepEqual((await data.query({ table: 'vehicle_photo', columns: ['id', 'data'], limit: 10, offset: 0 })).rows, [
        { id: `${tenant}-photo`, data: `${tenant} bytes` },
      ]);
      assert.deepEqual(
        (
          await data.query({
            table: 'vehicle',
            limit: 10,
            offset: 0,
            filter: { groups: [[{ column: 'id', op: '=', value: tenant === 'north' ? 'south-car' : 'north-car' }]] },
          })
        ).rows,
        [],
      );
      assert.equal(await data.count('program'), 2, 'advertised/active remain merchandising, not implicit row restrictions');
      const sites = await data.query({ table: 'dealer_site', limit: 10, offset: 0 });
      assert.deepEqual(
        sites.rows.map((row) => row.id),
        [`site-${tenant}`],
      );
      assert.equal('custom_domain' in sites.rows[0], false);
    });
  await assert.rejects(
    issuer.withPublicContext({ appId: 'site', tenant: 'north' }, async ({ data }) => data.query({ table: 'lead', limit: 10, offset: 0 })),
  );
});

test('Site missing, invalid, wrong-App, inactive and unpublished placements never fall back to a dealer', async (t) => {
  const { issuer, context } = await fixture(t);
  for (const intent of [
    null,
    { appId: 'other', tenant: 'north' },
    ...['missing', 'held', 'draft', 'north" or id = "south'].map((tenant) => ({ appId: 'site', tenant })),
  ]) {
    await issuer.withPublicContext(intent, async ({ data }) => {
      for (const table of ['dealer', 'dealer_site', 'vehicle', 'vehicle_photo']) assert.equal(await data.count(table), 0);
    });
    if (intent)
      for (const definition of Object.values(policy.publicForms!)) {
        assert.equal('kind' in definition && definition.kind, 'placement');
        if ('kind' in definition) await assert.rejects(async () => definition.resolvePlacement(intent, context));
      }
  }
});

test('Site prepare and submit share exact versioned eligibility anchors and physical storefront uniqueness', async (t) => {
  const { database, context } = await fixture(t);
  assert.throws(() => database.exec("INSERT INTO dealer_site(id,dealer_id,published,version) VALUES('duplicate','north',1,0)"), /UNIQUE/);
  for (const [form, definition] of Object.entries(policy.publicForms!)) {
    assert.ok('kind' in definition);
    assert.equal(definition.source, 'keystone');
    const admission = await definition.resolvePlacement({ appId: 'site', tenant: 'north' }, context);
    assert.deepEqual(admission.anchors, [
      { table: 'dealer', key: { id: 'north' }, expected: { status: 'active', version: 3 } },
      { table: 'dealer_site', key: { id: 'site-north' }, expected: { dealer_id: 'north', published: true, version: 7 } },
    ]);
    assert.deepEqual(
      Object.keys(admission.rows).sort(),
      ['dealer', 'dealer_site', 'vehicle', 'lead', 'lead_activity', ...(form === 'apply' ? ['applicant'] : [])].sort(),
    );
    assert.deepEqual(definition.resultReferences({ reference: 'opaque' }), []);
  }
  database.exec("UPDATE dealer_site SET published=0,version=version+1 WHERE dealer_id='north'");
  assert.deepEqual(await policy.resolvePublicRows!({ appId: 'site', tenant: 'north' }, context), { program: true });
  const apply = policy.publicForms!.apply;
  assert.ok('kind' in apply);
  await assert.rejects(async () => apply.resolvePlacement({ appId: 'site', tenant: 'north' }, context));
});

test('Site manifest is neutral, uses published record branding, and preserves merchandising', () => {
  assert.equal(site.name, 'Dealership website');
  assert.equal(site.auth.rows, 'policy');
  assert.equal(site.ui.theme.kind, 'fromRecord');
  assert.equal(site.ui.theme.from, 'dealer_site');
  assert.equal(site.ui.theme.publishedField, 'published');
  assert.doesNotMatch(JSON.stringify(site), /liberty|LF1041|Harrisburg|2026-ford-f-150-xl-lf1023/i);
  assert.equal(site.views.inventory.query, 'status in (listed, pending)');
  assert.equal(site.views.financing.query, 'advertised = true and active = true');
  assert.equal(site.views.visit.query, undefined);
});

test('Site canonical private policy depends only on its declared staff role, not public placement', async (t) => {
  const { context } = await fixture(t);
  assert.deepEqual(await policy.resolveRows({ id: 'staff', appId: 'site', roles: ['other'] }, context), {});
  const rows = await policy.resolveRows({ id: 'staff', appId: 'site', roles: ['web_admin'] }, context);
  assert.equal(rows.dealer, true);
  assert.equal(rows.lead, true);
});

const selection = (tenant = 'north') => ({
  appId: 'site',
  tenant,
  host: `${tenant}.example.test`,
  origin: `https://${tenant}.example.test`,
});
const contact = { first_name: 'Alex', last_name: 'Shopper', email: 'alex@example.test', phone: '+17175550139' };
const answers = (form: string, stock_number: string | undefined = 'NM1001') => ({
  ...contact,
  ...(stock_number === undefined ? {} : { stock_number }),
  ...(form === 'ask'
    ? { message: 'Is this car available?' }
    : form === 'test-drive'
      ? { preferred_on: '2026-10-15', time_of_day: 'morning' }
      : {
          down_payment: 1000,
          date_of_birth: '1990-01-01',
          ssn_last4: '1234',
          street: '100 Example St',
          city: 'Example',
          state: 'PA',
          zip: '17109',
          housing: 'rent',
          monthly_housing: 1000,
          years_at_address: 2,
          employment_type: 'full_time',
          employer: 'Example',
          job_title: 'Engineer',
          years_employed: 3,
          monthly_income: 5000,
          consent: true,
        }),
});
const envelope = (prepared: { submission: string; binding: string }, input: unknown) => ({
  input,
  submission: prepared.submission,
  placement: { version: 1, binding: prepared.binding },
});
const refusal =
  (code: string, field?: string, outcome = 'not_applied') =>
  (error: unknown) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.code, code);
    assert.equal(error.outcome, outcome);
    if (field) assert.equal(error.field, field);
    return true;
  };
const count = (database: DatabaseSync, table: string) => database.prepare(`SELECT count(*) AS n FROM "${table}"`).get()!.n;

test('actual Site commands use binder placement for both dealers, atomically replaying one lead and primary applicant', async (t) => {
  const { database, bind } = await fixture(t);
  for (const form of ['ask', 'test-drive', 'apply']) {
    const intake = bind(form);
    for (const tenant of ['north', 'south']) {
      const host = selection(tenant),
        prepared = await intake.prepare(host);
      const body = envelope(prepared, answers(form, tenant === 'north' ? 'nm1001' : 'sm1001'));
      const first = await intake.submit(host, body);
      assert.deepEqual(Object.keys(first).sort(), ['receipt', 'reference']);
      assert.deepEqual(await intake.submit(host, body), first);
      const lead = database.prepare('SELECT * FROM lead WHERE reference=?').get(first.reference)!;
      assert.equal(lead.dealer_id, tenant);
      assert.equal(lead.vehicle_id, `${tenant}-car`);
      assert.equal(lead.version, 0);
      assert.equal(database.prepare('SELECT dealer_id FROM lead_activity WHERE lead_id=?').get(lead.id)!.dealer_id, tenant);
      if (form === 'apply') {
        const applicant = database.prepare('SELECT * FROM applicant WHERE lead_id=?').get(lead.id)!;
        assert.equal(applicant.dealer_id, tenant);
        assert.equal(applicant.role, 'primary');
        assert.throws(
          () =>
            database
              .prepare(`INSERT INTO applicant SELECT 'duplicate',dealer_id,lead_id,role,first_name,last_name,email,phone,
            date_of_birth,ssn_last4,street,city,state,zip,housing,monthly_housing,years_at_address,employer,job_title,
            employment_type,years_employed,monthly_income,created_at FROM applicant WHERE lead_id=?`)
              .run(lead.id),
          /UNIQUE/,
        );
      }
    }
  }
  assert.equal(count(database, 'lead'), 6);
  assert.equal(count(database, 'lead_activity'), 6);
  assert.equal(count(database, 'applicant'), 2);
  assert.equal(count(database, PUBLIC_PLACEMENT_TABLES.receipt), 6);
  const audits = database.prepare(`SELECT r.changes_json FROM ${PUBLIC_PLACEMENT_TABLES.receipt} r WHERE r.form='apply'`).all();
  assert.ok(audits.length > 0);
  assert.doesNotMatch(JSON.stringify(audits), /alex@example|1234|100 Example St/);
  assert.deepEqual(
    database
      .prepare('SELECT id,version,status FROM vehicle ORDER BY id')
      .all()
      .map((row) => [row.id, row.version, row.status]),
    [
      ['north-car', 2, 'listed'],
      ['north-unlisted', 0, 'in_stock'],
      ['south-car', 3, 'listed'],
    ],
  );
});

test('all Site commands refuse unknown/foreign stock and forged ownership without creating applications or receipts', async (t) => {
  const { database, bind } = await fixture(t);
  for (const form of ['ask', 'test-drive', 'apply']) {
    const intake = bind(form),
      host = selection();
    for (const stock of ['SM1001', 'XX9999']) {
      const prepared = await intake.prepare(host);
      await assert.rejects(intake.submit(host, envelope(prepared, answers(form, stock))), refusal('invalid_input', 'stock_number'));
    }
    for (const forged of [{ dealer_id: 'south' }, { tenantId: 'south' }, { placement: { tenantId: 'south' } }]) {
      const prepared = await intake.prepare(host);
      await assert.rejects(
        intake.submit(host, envelope(prepared, { ...answers(form), ...forged })),
        refusal('invalid_input', undefined, 'unknown'),
      );
    }
  }
  for (const table of ['lead', 'lead_activity', 'applicant', PUBLIC_PLACEMENT_TABLES.receipt]) assert.equal(count(database, table), 0);
});

test('Site financing requires consent, while general questions and applications may omit stock', async (t) => {
  const { database, bind } = await fixture(t),
    host = selection();
  const apply = bind('apply'),
    prepared = await apply.prepare(host);
  await assert.rejects(apply.submit(host, envelope(prepared, { ...answers('apply'), consent: false })), (error) => {
    assert.ok(error instanceof BusinessCommandExecutionError);
    assert.equal(error.outcome, 'not_applied');
    assert.match(error.message, /consent/);
    return true;
  });
  assert.equal(count(database, 'lead'), 0);
  assert.equal(count(database, PUBLIC_PLACEMENT_TABLES.receipt), 0);
  for (const form of ['ask', 'apply']) {
    const intake = bind(form),
      prepared = await intake.prepare(host);
    const input = answers(form);
    delete input.stock_number;
    await intake.submit(host, envelope(prepared, input));
  }
  assert.deepEqual(
    database
      .prepare('SELECT dealer_id,vehicle_id FROM lead')
      .all()
      .map((row) => [row.dealer_id, row.vehicle_id]),
    [
      ['north', null],
      ['north', null],
    ],
  );
  const testDrive = bind('test-drive'),
    drive = await testDrive.prepare(host),
    input = answers('test-drive');
  delete input.stock_number;
  await assert.rejects(testDrive.submit(host, envelope(drive, input)), refusal('invalid_input', 'stock_number', 'unknown'));
});

test('legacy fixed public intake cannot execute any Site handler without trusted placement', async (t) => {
  const { database, bindFixed } = await fixture(t);
  for (const form of ['ask', 'test-drive', 'apply']) {
    const fixed = await bindFixed(form);
    await assert.rejects(fixed.submit({ input: answers(form), submission: `legacy-${form}-submission` }), refusal('forbidden'));
  }
  for (const table of ['lead', 'lead_activity', 'applicant', '__mistri_command_receipt']) assert.equal(count(database, table), 0);
  for (const command of Object.values(commands)) {
    assert.ok(command.read.includes('dealer'));
    assert.doesNotMatch(JSON.stringify(command.fields), /liberty|LF1041|Harrisburg/);
  }
});
