import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';

test('suite-mounted tenant saved intake owns its address, draft cookie, writes and refusals', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-intake-'));
  let suite: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    try {
      await suite?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  const socket = createServer();
  await new Promise<void>((resolve) => socket.listen(0, '127.0.0.1', resolve));
  const port = (socket.address() as { port: number }).port;
  await new Promise<void>((resolve) => socket.close(() => resolve()));
  const home = join(directory, 'leads');
  mkdirSync(home);
  const database = join(home, 'business.db');
  const north = 'north-intake-AAAAAAAAAAAAAAAA',
    south = 'south-intake-BBBBBBBBBBBBBBBB';
  const db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys = ON;
    CREATE TABLE dealer(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, intake_address TEXT);
    CREATE TABLE lead(id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL REFERENCES dealer(id), reference TEXT NOT NULL,
      name TEXT NOT NULL, status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    CREATE TABLE intake_submission(id TEXT PRIMARY KEY NOT NULL, reference TEXT NOT NULL, name TEXT NOT NULL,
      status TEXT, resume_token_hash TEXT, resume_expires_at TEXT, resume_progress TEXT);
    INSERT INTO dealer VALUES ('north', 'North Motors', '${north}'), ('south', 'South Motors', '${south}');`);
  db.close();
  provisionSqliteTenantStore(database, { appId: 'leads', source: { id: 'data', connection: 'data' }, storeId: 'store' });
  migrateSqliteCommandJournal(database);
  const seed = new DatabaseSync(database);
  seed.exec(`INSERT INTO "${TENANT_TABLES.tenant}" VALUES ('north','active','1','tenant'),
    ('south','active','1','tenant'),('@platform','active','1','platform')`);
  seed.close();
  writeFileSync(
    join(home, 'app.json'),
    JSON.stringify({
      id: 'leads',
      name: 'Leads',
      sources: { data: { connection: 'data' } },
      resources: {
        dealer: { owner: 'platform' },
        lead: { access: 'write', owner: 'tenant' },
        intake_submission: { access: 'write', owner: 'platform' },
      },
      auth: {
        store: join(home, 'auth.db'),
        signUp: 'open',
        rows: 'tenant',
        tenancy: { label: 'Dealer', profile: 'dealer', platform: { label: 'Lender' } },
        roles: { staff: { realm: 'tenant', read: true }, manager: { realm: 'platform', read: true } },
      },
      views: {
        leads: { kind: 'list', from: 'lead' },
        triage: { kind: 'list', from: 'intake_submission' },
        apply: { kind: 'form', label: 'Apply now', public: true, command: 'apply' },
        draft: {
          kind: 'form',
          label: 'Apply',
          public: true,
          resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
          draft: { status: 'draft' },
          steps: [{ id: 'name', label: 'Name', command: 'draftName' }],
          command: 'draftSubmit',
        },
      },
      nav: [
        { id: 'dealer', label: 'Dealer', realm: 'tenant', children: ['leads'] },
        { id: 'lender', label: 'Lender', realm: 'platform', children: ['triage'] },
      ],
      home: [{ view: 'draft', signedOut: true }, { view: 'leads' }],
    }),
  );
  writeFileSync(
    join(home, 'commands.mjs'),
    `import {defineCommand, defineCommands, shape, literal, text} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
    import {randomUUID} from 'node:crypto';
    const root = intake => intake === 'tenant' ? 'lead' : 'intake_submission';
    export default defineCommands({
      apply: defineCommand({targets:'none',source:'data',target:'lead',write:['lead','intake_submission'],public:true,
        input:{name:{type:'text',max:80}},output:shape({reference:text()}),
        async handle({tx,intake},value){const reference='SINGLE-'+randomUUID();
          await tx.insert({table:root(intake),values:{id:randomUUID(),reference,name:value.name}});
          return {reference};}}),
      draftName: defineCommand({targets:'none',source:'data',target:'lead',read:['lead','intake_submission'],write:['lead','intake_submission'],public:true,
        input:{name:{type:'text',max:80}},output:shape({message:literal('Saved.')}),
        async handle({tx,draft,intake},value){ if(draft.root) await tx.update({table:root(intake),key:{...draft.root},values:{name:value.name}});
          else await tx.insert({table:root(intake),values:{id:randomUUID(),reference:'REF-'+randomUUID(),name:value.name,...draft.start}});
          return {message:'Saved.'}; }}),
      draftSubmit: defineCommand({targets:'none',source:'data',target:'lead',read:['lead','intake_submission'],write:['lead','intake_submission'],public:true,
        input:{},output:shape({reference:text()}),
        async handle({tx,draft,intake}){const table=root(intake);
          const [row]=(await tx.query({table,columns:['reference'],limit:1,offset:0})).rows;
          await tx.update({table,key:{...draft.root},values:{status:'submitted'}});
          return {reference:String(row.reference)}; }})});`,
  );
  const policy = `export default {kind:'tenant',appId:'leads',storeId:'store',intake:{address:'intake_address'},
    ownership:{dealer:{kind:'platform'},lead:{kind:'tenant',column:'tenant_id'},intake_submission:{kind:'platform'}},
    resolveMembershipRows:()=>({dealer:true,lead:true,intake_submission:true}),
    resolveRows:()=>({dealer:true,lead:true,intake_submission:true}),
    resolvePlatformRows:()=>({dealer:true,lead:true,intake_submission:true}),
    resultReferences:{apply:()=>[],draftName:()=>[],draftSubmit:()=>[]}}`;
  writeFileSync(join(home, 'policy.mjs'), policy);
  writeFileSync(join(home, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: database, writable: true }] }));
  const root = join(directory, 'main');
  mkdirSync(root);
  const rootDatabase = join(root, 'business.db');
  const rootDb = new DatabaseSync(rootDatabase);
  rootDb.exec('CREATE TABLE note(id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL)');
  rootDb.close();
  migrateSqliteCommandJournal(rootDatabase);
  writeFileSync(
    join(root, 'app.json'),
    JSON.stringify({
      id: 'main',
      name: 'Main',
      sources: { data: { connection: 'data' } },
      resources: { note: { access: 'write' } },
      auth: { store: join(root, 'auth.db'), roles: { user: { read: true } } },
      views: { notes: { kind: 'list', from: 'note' }, apply: { kind: 'form', public: true, label: 'Apply', command: 'apply' } },
      home: 'notes',
      nav: ['notes'],
    }),
  );
  writeFileSync(
    join(root, 'commands.mjs'),
    `import {defineCommand, defineCommands, shape, text} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
    import {randomUUID} from 'node:crypto';
    export default defineCommands({apply:defineCommand({targets:'none',source:'data',target:'note',write:['note'],public:true,
      input:{name:{type:'text',max:80}},output:shape({reference:text()}),
      async handle({tx},value){await tx.insert({table:'note',values:{id:randomUUID(),name:value.name}});
        return {reference:'ROOT-'+value.name};}})});`,
  );
  writeFileSync(join(root, 'connections.json'), JSON.stringify({ connections: [{ name: 'data', url: rootDatabase, writable: true }] }));
  const rootDeployment = {
    id: 'main',
    directory: './main',
    config: './main/connections.json',
    mount: '/',
    environment: { BETTER_AUTH_SECRET: 'SECRET' },
  };
  const leadsDeployment = {
    id: 'leads',
    directory: './leads',
    config: './leads/connections.json',
    mount: '/leads',
    policy: './leads/policy.mjs',
    environment: { BETTER_AUTH_SECRET: 'SECRET' },
  };
  const file = join(directory, 'suite.json');
  const basePath = '/tools';
  writeFileSync(file, JSON.stringify({ port, basePath, apps: [rootDeployment, leadsDeployment] }));
  suite = await startConfiguredSuite(file, { SECRET: 'suite-intake-test-secret-longer-than-thirty-two-characters' });
  const origin = suite.publicURL;
  const post = (suffix: string, address: string, body: unknown, cookie?: string, from = origin) =>
    fetch(`${origin}${basePath}/leads/api/forms/draft${suffix}?via=${address}`, {
      method: 'POST',
      headers: { origin: from, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(body),
    });
  const first = await post('/steps/name', north, { input: { name: 'Ada' }, submission: randomUUID() });
  assert.equal(first.status, 200, await first.clone().text());
  const savedCookie = first.headers.getSetCookie().find((cookie) => cookie.startsWith('tw_form_draft='));
  assert.ok(savedCookie);
  assert.match(savedCookie, /(?:^|;)\s*Path=\/tools\/leads\/api\/forms\/draft(?:;|$)/i);
  const cookie = savedCookie.split(';')[0];
  assert.deepEqual(await (await post('/resume', north, {}, cookie)).json(), { saved: ['name'] });
  assert.deepEqual(await (await post('/resume', south, {}, cookie)).json(), { saved: [] });
  assert.equal((await post('/steps/name', south, { input: { name: 'Hijacked' }, submission: randomUUID() }, cookie)).status, 404);
  assert.equal(
    (await post('/steps/name', north, { input: { name: 'Mallory' }, submission: randomUUID() }, undefined, 'http://attacker.invalid'))
      .status,
    403,
  );
  const submission = randomUUID();
  const submitted = await post('', north, { input: {}, submission }, cookie);
  assert.equal(submitted.status, 200, await submitted.clone().text());
  const result = await submitted.json();
  assert.match(result.reference, /^REF-/);
  const sharedKey = randomUUID();
  const single = await fetch(`${origin}${basePath}/leads/api/forms/apply?via=${north}`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { name: 'Bea' }, submission: sharedKey }),
  });
  assert.equal(single.status, 200, await single.clone().text());
  const tenantResult = await single.json();
  assert.match(tenantResult.reference, /^SINGLE-/);
  const ordinary = await fetch(`${origin}${basePath}/api/forms/apply`, {
    method: 'POST',
    headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { name: 'Bea' }, submission: sharedKey }),
  });
  assert.equal(ordinary.status, 200, await ordinary.clone().text());
  const ordinaryResult = await ordinary.json();
  assert.equal(ordinaryResult.reference, 'ROOT-Bea');
  assert.notEqual(tenantResult.receipt?.id, ordinaryResult.receipt?.id);
  assert.equal((await fetch(`${origin}${basePath}/api/forms/draft`)).status, 401);
  const wrongMount = await fetch(`${origin}${basePath}/api/forms/draft/steps/name`, {
    method: 'POST',
    headers: { origin, cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ input: { name: 'Hijacked' }, submission: randomUUID() }),
  });
  assert.equal(wrongMount.status, 401, 'the root App cannot resume or write the tenant App draft');
  const rootReader = new DatabaseSync(rootDatabase, { readOnly: true });
  try {
    assert.deepEqual(
      rootReader
        .prepare('SELECT name FROM note')
        .all()
        .map((row) => ({ ...row })),
      [{ name: 'Bea' }],
    );
  } finally {
    rootReader.close();
  }
  const rows = new DatabaseSync(database, { readOnly: true });
  try {
    assert.deepEqual(
      rows
        .prepare('SELECT tenant_id, name, status FROM lead ORDER BY name')
        .all()
        .map((row) => ({ ...row })),
      [
        { tenant_id: 'north', name: 'Ada', status: 'submitted' },
        { tenant_id: 'north', name: 'Bea', status: null },
      ],
    );
    assert.equal(rows.prepare('SELECT count(*) AS n FROM intake_submission').get()?.n, 0);
  } finally {
    rows.close();
  }
  assert.equal((await fetch(`${origin}${basePath}/leads/api/forms/unknown`)).status, 404);
  assert.ok((await fetch(`${origin}${basePath}/leads/api/tenant/administration`)).status >= 400);
  await suite.close();
  suite = undefined;
  writeFileSync(join(home, 'no-intake.mjs'), policy.replace("intake:{address:'intake_address'},", ''));
  writeFileSync(file, JSON.stringify({ port, basePath, apps: [rootDeployment, { ...leadsDeployment, policy: './leads/no-intake.mjs' }] }));
  await assert.rejects(
    startConfiguredSuite(file, { SECRET: 'suite-intake-test-secret-longer-than-thirty-two-characters' }),
    /public form needs the tenant policy's intake/,
  );
});
