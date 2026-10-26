/**
 * Mail to an address a record holds (`notify.via` email) in a suite: each
 * App's rule opens its channel runtime as `tablewalk serve` (or, for a tenant
 * App, `mistri tenant`) would, and the link that stops the mail is answered
 * under the App's own mount, not the suite's root. A tenant App queues each
 * tenant's mail as that tenant's, and its link stops only that tenant's.
 */
import { provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { migrateSqliteCommandJournal } from '../packages/mistri/src/adapters/commands/commandJournal.js';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { provisionStores } from '../packages/mistri/src/server/maintenance.js';
import { provisionSqliteTenantStore, TENANT_TABLES } from '../packages/mistri/src/server/tenant/tenantStore.js';
import { startConfiguredSuite } from '../packages/mistri/src/server/cli/suiteCommand.js';
import { issueUnsubscribeToken } from '../packages/mistri/src/server/email/unsubscribe.js';
import { channelHolder } from '../packages/mistri/src/server/integrations/integrationChannels.js';

const SECRET = 'a-links-secret-for-the-suite-contact-email-test';

test(
  "a suite App's email rule opens its channel, and the unsubscribe link answers under the App's mount",
  { timeout: 30_000 },
  async (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-contact-'));
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
    const database = join(home, 'desk.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE contact (id INTEGER PRIMARY KEY, status TEXT, email TEXT, email_ok INTEGER);
    INSERT INTO contact VALUES (1, 'open', 'ann@example.test', 1);`);
    db.close();
    provisionSqliteIntegrations(database);
    provisionSqliteInbox(database);
    writeFileSync(
      join(home, 'app.json'),
      JSON.stringify({
        id: 'desk',
        name: 'Desk',
        sources: { data: { connection: 'data', default: true } },
        resources: {
          contact: {
            access: 'write',
            notify: [
              {
                on: { changes: 'status' },
                when: 'status = ready',
                title: 'Contact {id} is ready.',
                send: { channel: 'email', to: 'email', consent: 'email_ok' },
              },
            ],
          },
        },
        auth: {
          store: join(home, 'auth.db'),
          providers: ['email'],
          roles: { clerk: { read: true } },
        },
        views: { contacts: { kind: 'list', from: 'contact' } },
        home: 'contacts',
      }),
    );
    writeFileSync(
      join(home, 'connections.json'),
      JSON.stringify({
        connections: [
          { name: 'data', url: '${DATABASE_URL}', writable: true },
          {
            name: 'mail',
            kind: 'email',
            url: 'log:',
            from: 'Desk <no-reply@example.test>',
            links: { secret: '${LINKS}' },
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
            config: './desk/connections.json',
            mount: '/desk',
            environment: {
              DATABASE_URL: 'DESK_DB',
              LINKS: 'DESK_LINKS',
              BETTER_AUTH_SECRET: 'SECRET',
            },
          },
        ],
      }),
    );
    active = await startConfiguredSuite(file, {
      DESK_DB: database,
      DESK_LINKS: SECRET,
      SECRET: 'test-only-suite-contact-secret-longer-than-thirty-two-characters',
    });

    const holder = channelHolder('ann@example.test', 'email');
    const token = issueUnsubscribeToken(SECRET, {
      app: 'desk',
      tenant: '',
      channel: 'email',
      holder,
    });
    const at = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`, init);
    const asked = await at('/desk/api/mail/unsubscribe');
    assert.equal(asked.status, 200);
    assert.match(await asked.text(), /Stop these emails\?/);
    assert.notEqual((await at('/api/mail/unsubscribe')).status, 200, "the suite's root does not answer an App's link");
    const stopped = await at('/desk/api/mail/unsubscribe', {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(stopped.status, 200);
    const store = await openIntegrationStore({ sqlite: database });
    try {
      assert.equal((await store.consent('desk', '', 'email', holder))?.state, 'out');
    } finally {
      await store.close();
    }
  },
);

test(
  "a suite tenant App queues a tenant's contact mail under that tenant, and its link answers under the App's mount",
  { timeout: 30_000 },
  async (t) => {
    const INBOUND = 'suite-tenant-contact-inbound-secret-0001';
    const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-tenant-contact-'));
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
    db.exec(`CREATE TABLE note (id TEXT PRIMARY KEY NOT NULL, tenant_id TEXT NOT NULL, subject TEXT NOT NULL, sender TEXT NOT NULL,
      mail_ok INTEGER NOT NULL DEFAULT 1);`);
    db.close();
    const owner = {
      appId: 'desk',
      source: { id: 'data', connection: 'data' },
      storeId: 'store',
    };
    provisionSqliteTenantStore(database, owner);
    migrateSqliteCommandJournal(database);
    provisionSqliteInbox(database);
    provisionSqliteIntegrations(database);
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
          roles: {
            member: { read: true },
            intake: { read: true, commands: ['receive'] },
          },
        },
        resources: {
          note: {
            owner: 'tenant',
            access: 'write',
            notify: [
              {
                on: 'insert',
                title: 'We have your note: {subject}',
                send: { channel: 'email', to: 'sender', consent: 'mail_ok' },
              },
            ],
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
        receive:defineCommand({source:'data',target:'note',targets:'none',write:['note'],
          input:{subject:{type:'text'},sender:{type:'text'}},output:{parse(value){return value}},
          async handle({db},input){const id='n'+(++made);await db.note.insert({id,subject:input.subject,sender:input.sender});return {id}}})});`,
    );
    writeFileSync(
      join(home, 'jobs.mjs'),
      `import {defineJobs} from ${JSON.stringify(new URL('../packages/mistri/src/server/jobs.ts', import.meta.url).href)};
      export default defineJobs({},{principals:{intake:{roles:['intake']}},store:{namespace:'desk'},
        mail:{receive:{runAs:'intake',command:'receive',input:(mail)=>({subject:mail.subject,sender:mail.from.address})}}});`,
    );
    const commands = await import(pathToFileURL(join(home, 'commands.mjs')).href);
    const jobs = (await import(pathToFileURL(join(home, 'jobs.mjs')).href)).default;
    await provisionStores({ sqlite: database }, { app: { tenant: owner, commands: commands.default }, jobs });
    writeFileSync(
      join(home, 'policy.mjs'),
      `export default {kind:'tenant',appId:'desk',storeId:'store',resultReferences:{receive:()=>[]},
        ownership:{note:{kind:'tenant',column:'tenant_id'}},
        resolveMembershipRows:()=>({note:true}),resolveRows:()=>({note:true})};`,
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
            links: { secret: '${MAIL_LINKS}' },
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
            environment: {
              BETTER_AUTH_SECRET: 'SECRET',
              DATABASE_URL: 'DESK',
              MAIL_INBOUND: 'INBOUND',
              MAIL_LINKS: 'LINKS',
            },
          },
        ],
      }),
    );
    active = await startConfiguredSuite(file, {
      SECRET: 'suite-tenant-contact-test-secret-longer-than-thirty-two-characters',
      DESK: database,
      INBOUND,
      LINKS: SECRET,
    });

    // A message arrives for North: its command writes North's note, and the rule queues mail to the sender as North's.
    const text = JSON.stringify({
      recipient: 'help+north@in.example.test',
      from: 'Ann Lee <ann@example.org>',
      to: ['help@in.example.test'],
      subject: 'The printer is on fire',
      messageId: '<suite-contact-1@mail.example.org>',
      text: 'It is on fire.',
    });
    const stamp = Math.floor(Date.now() / 1000);
    const taken = await fetch(`${active.publicURL}/desk/api/mail/inbound`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mistri-timestamp': String(stamp),
        'x-mistri-signature': `v1=${createHmac('sha256', INBOUND).update(`${stamp}.${text}`).digest('hex')}`,
      },
      body: text,
      signal: AbortSignal.timeout(10_000),
    });
    assert.equal(taken.status, 204, await taken.text());
    const check = new DatabaseSync(database, { readOnly: true });
    try {
      assert.deepEqual(
        check
          .prepare('SELECT app, tenant, recipient, state, text FROM "__mistri_integration_message"')
          .all()
          .map((row) => ({ ...row })),
        [
          {
            app: 'desk',
            tenant: 'north',
            recipient: 'ann@example.org',
            state: 'held',
            text: 'We have your note: The printer is on fire\n\nYou get this because Desk has your address on file for a note.',
          },
        ],
      );
    } finally {
      check.close();
    }

    // North's link stops North's mail to Ann, and South's is still South's to send.
    const holder = channelHolder('ann@example.org', 'email');
    const token = issueUnsubscribeToken(SECRET, {
      app: 'desk',
      tenant: 'north',
      channel: 'email',
      holder,
    });
    const stopped = await fetch(`${active.publicURL}/desk/api/mail/unsubscribe?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(stopped.status, 200, await stopped.text());
    const store = await openIntegrationStore({ sqlite: database });
    try {
      assert.equal((await store.consent('desk', 'north', 'email', holder))?.state, 'out');
      assert.equal(await store.consent('desk', 'south', 'email', holder), undefined);
    } finally {
      await store.close();
    }
  },
);
