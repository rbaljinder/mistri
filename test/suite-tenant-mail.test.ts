/**
 * A tenant App in a suite receives mail as `mistri tenant` does: the
 * suite gives it its config's email service (suiteCommand.ts), the webhook
 * answers under the App's mount, and the message's command runs in the
 * tenant its address names, with its attachment stored through the file rule.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';

const SECRET = 'suite-tenant-mail-inbound-secret-0001';

test('a suite tenant App takes signed mail under its mount, in the tenant its address names', { timeout: 20_000 }, async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-tenant-mail-'));
  let active: Awaited<ReturnType<typeof startConfiguredSuite>> | undefined;
  t.after(async () => {
    await active?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const reservation = createServer();
  await new Promise<void>((resolve) => reservation.listen(0, '127.0.0.1', resolve));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));

  const home = join(directory, 'desk');
  mkdirSync(home);
  const database = join(home, 'business.db');
  const db = new DatabaseSync(database);
  db.exec(`CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL);
    CREATE TABLE attachment (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, note_id TEXT NOT NULL,
      file_name TEXT NOT NULL, content_type TEXT, byte_size INTEGER, data BLOB);`);
  db.close();
  const owner = { appId: 'desk', source: { id: 'data', connection: 'data' }, storeId: 'store' };
  provisionSqliteTenantStore(database, owner);
  migrateSqliteCommandJournal(database);
  const seed = new DatabaseSync(database);
  seed.exec(
    `INSERT INTO "${TENANT_TABLES.tenant}" VALUES('north','active','1','tenant'),('south','active','1','tenant'),('@platform','active','1','platform')`,
  );
  seed.close();
  writeFileSync(
    join(home, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      sources: { data: { connection: 'data' } },
      auth: {
        store: join(home, 'auth.db'),
        rows: 'tenant',
        roles: { member: { read: true }, intake: { read: true, commands: ['receive'] } },
      },
      resources: {
        note: { owner: 'tenant', access: 'write' },
        attachment: {
          owner: 'tenant',
          access: 'write',
          file: { content: 'data', name: 'file_name', type: 'content_type', size: 'byte_size' },
        },
      },
      views: { notes: { kind: 'list', from: 'note' } },
      home: 'notes',
    }),
  );
  writeFileSync(
    join(home, 'commands.mjs'),
    `import {defineCommand,defineCommands} from ${JSON.stringify(new URL('../packages/mistri/src/server/commands.ts', import.meta.url).href)};
    let made=0;
    export default defineCommands({
      receive:defineCommand({source:'data',target:'note',targets:'none',write:['note','attachment'],
        input:{subject:{type:'text'},sender:{type:'text'}},output:{parse(value){return value}},
        async handle({db,files},input){const id='n'+(++made);await db.note.insert({id,subject:input.subject,sender:input.sender});
          for(const file of files??[])await db.attachment.insertFile(file,{id:id+'-a',note_id:id});return {id}}})});`,
  );
  writeFileSync(
    join(home, 'jobs.mjs'),
    `import {defineJobs} from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
    export default defineJobs({},{principals:{intake:{roles:['intake']}},store:{namespace:'desk'},
      mail:{receive:{runAs:'intake',command:'receive',attachments:'attachment',input:(mail)=>({subject:mail.subject,sender:mail.from.address})}}});`,
  );
  const commands = await import(pathToFileURL(join(home, 'commands.mjs')).href);
  const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
  await provisionStores({ sqlite: database }, { app: { tenant: owner, commands: commands.default }, jobs });
  writeFileSync(
    join(home, 'policy.mjs'),
    `export default {kind:'tenant',appId:'desk',storeId:'store',resultReferences:{receive:()=>[]},
      ownership:{note:{kind:'tenant',column:'tenant_id'},attachment:{kind:'tenant',column:'tenant_id'}},
      resolveMembershipRows:()=>({note:true,attachment:true}),resolveRows:()=>({note:true,attachment:true})};`,
  );
  writeFileSync(
    join(home, 'connections.json'),
    JSON.stringify({
      connections: [
        { name: 'data', url: '${DATABASE_URL}', writable: true },
        {
          name: 'mail',
          kind: 'email',
          url: 'log:mail.log',
          from: 'Desk <desk@example.test>',
          inbound: { secret: '${MAIL_INBOUND}', domain: 'in.example.test' },
        },
      ],
    }),
  );
  const file = join(directory, 'suite.json');
  writeFileSync(
    file,
    JSON.stringify({
      port,
      apps: [
        {
          id: 'desk',
          directory: './desk',
          mount: '/desk',
          config: './desk/connections.json',
          policy: './desk/policy.mjs',
          jobs: './desk/jobs.mjs',
          environment: { BETTER_AUTH_SECRET: 'SECRET', DATABASE_URL: 'DESK', MAIL_INBOUND: 'INBOUND' },
        },
      ],
    }),
  );
  active = await startConfiguredSuite(file, {
    SECRET: 'suite-tenant-mail-test-secret-longer-than-thirty-two-characters',
    DESK: database,
    INBOUND: SECRET,
  });

  const post = async (body: unknown) => {
    const text = JSON.stringify(body);
    const at = Math.floor(Date.now() / 1000);
    const signature = createHmac('sha256', SECRET).update(`${at}.${text}`).digest('hex');
    const response = await fetch(`${active!.publicURL}/desk/api/mail/inbound`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mistri-timestamp': String(at), 'x-mistri-signature': `v1=${signature}` },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    return { status: response.status, text: await response.text() };
  };
  const taken = await post({
    recipient: 'help+north@in.example.test',
    from: 'Ann Lee <ann@example.org>',
    to: ['help@in.example.test'],
    subject: 'The printer is on fire',
    messageId: '<suite-1@mail.example.org>',
    text: 'It is on fire.',
    attachments: [{ name: 'smoke.txt', type: 'text/plain', content: Buffer.from('smoke').toString('base64') }],
  });
  assert.equal(taken.status, 204, taken.text);
  const unsigned = await fetch(`${active.publicURL}/desk/api/mail/inbound`, { method: 'POST', body: '{}' });
  assert.equal(unsigned.status, 401);

  const check = new DatabaseSync(database, { readOnly: true });
  try {
    assert.deepEqual(
      { ...check.prepare('SELECT tenant_id, subject, sender FROM note').get() },
      {
        tenant_id: 'north',
        subject: 'The printer is on fire',
        sender: 'ann@example.org',
      },
    );
    const stored = check.prepare('SELECT tenant_id, file_name, byte_size, data FROM attachment').get()!;
    assert.equal(stored.tenant_id, 'north');
    assert.equal(stored.file_name, 'smoke.txt');
    assert.equal(String(Buffer.from(stored.data as Uint8Array)), 'smoke');
  } finally {
    check.close();
  }
});
