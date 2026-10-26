/**
 * Mail to an address a record holds (`notify.via` email) in a tenant App: a
 * tenant's write queues it under that tenant, saying why the recipient gets
 * it, and a visitor's write mails only the address they proved; the sender
 * then asks that tenant's opt-out, consent and caps, never another's, and the
 * link at its foot names the tenant. The store is proved on SQLite and, when
 * `TABLEWALK_TEST_PG` names a server, on a PostgreSQL database of its own.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, test, type TestContext } from 'node:test';
import {
  openIntegrationStore,
  provisionPostgresIntegrations,
  provisionSqliteIntegrations,
  type IntegrationStore,
  type MessageRow,
} from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import { bindNotices } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { readSqliteScopeCatalog } from '../packages/engine/src/adapters/scoped/sqliteScopeCatalog.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { issueUnsubscribeToken, readUnsubscribeToken } from '../packages/mistri/src/server/email/unsubscribe.js';
import { channelHolder, EMAIL_LIMITS, emailChannelSender } from '../packages/mistri/src/server/integrations/integrationChannels.js';
import { tenantNoticeBinding } from '../packages/mistri/src/server/tenant/tenantInbox.js';
import { captureTenantOwnership } from '../packages/mistri/src/server/tenant/tenantOwnership.js';
import { parseAppConfig, type AppDef } from '../packages/mistri/src/shared/app.js';
import { liveSkip } from './live.js';
import { uuidPostgresDatabase } from './support/tenantDialects.js';

const LIVE = process.env.TABLEWALK_TEST_PG;
const SECRET = 'a-links-secret-for-the-tenant-contact-email-test';

class Recorder implements EmailTransport {
  readonly name = 'test';
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
}

/* What a tenant's write queued: held until the sender decides it. */
const queued = (app: string, tenant: string, key: string, recipient: string, at: number): MessageRow => ({
  app,
  key,
  tenant,
  channel: 'email',
  recipient,
  text: `Your repair is ready.`,
  state: 'held',
  reason: 'queued',
  providerId: null,
  dueAt: at,
  consent: true,
  timezone: null,
  actorKind: 'account',
  attempts: 0,
  at,
});

function isolation(name: string, open: (t: TestContext) => Promise<{ store: IntegrationStore; app: string }>) {
  test(`${name}: each tenant's opt-out and caps are its own, and the link names the tenant`, async (t) => {
    const { store, app } = await open(t);
    const now = Date.now();
    const mail = new Recorder();
    const sender = emailChannelSender({
      appId: app,
      store,
      transport: mail,
      unsubscribe: (claim) => `https://lintel.example.test/api/mail/unsubscribe?token=${issueUnsubscribeToken(SECRET, claim)}`,
      now: () => now,
    });
    // North's resident unsubscribed from North's mail; North already sent the busy address its five today.
    await store.setConsent({
      app,
      tenant: 'north',
      channel: 'email',
      holder: channelHolder('ann@example.test', 'email'),
      state: 'out',
      source: 'unsubscribe',
      at: now,
    });
    for (let i = 0; i < EMAIL_LIMITS.perAddress; i++)
      await store.putMessage({
        ...queued(app, 'north', `earlier-${i}`, 'busy@example.test', now - 3_600_000),
        state: 'sent',
        reason: null,
        dueAt: null,
      });
    for (const [tenant, recipient] of [
      ['north', 'ann@example.test'],
      ['south', 'ann@example.test'],
      ['north', 'busy@example.test'],
      ['south', 'busy@example.test'],
    ])
      await store.putMessage(queued(app, tenant, `${tenant}-${recipient}`, recipient, now - 1));
    assert.equal(await sender.sendDue(), true);
    const settled = Object.fromEntries(
      await Promise.all(
        ['north', 'south'].flatMap((tenant) =>
          ['ann@example.test', 'busy@example.test'].map(async (recipient) => {
            const row = await store.message(app, `${tenant}-${recipient}`);
            return [`${tenant} ${recipient}`, `${row?.state}:${row?.reason}`];
          }),
        ),
      ),
    );
    assert.deepEqual(settled, {
      'north ann@example.test': 'suppressed:opted_out',
      'south ann@example.test': 'sent:null',
      'north busy@example.test': 'suppressed:rate_limited',
      'south busy@example.test': 'sent:null',
    });
    assert.deepEqual(
      mail.sent.map((message) => message.to),
      ['ann@example.test', 'busy@example.test'],
    );
    for (const message of mail.sent)
      assert.equal(
        readUnsubscribeToken(SECRET, message.unsubscribe!.split('token=')[1])?.tenant,
        'south',
        "the link stops South's mail, not North's",
      );
  });
}

isolation('SQLite', async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-contact-'));
  const path = join(directory, 'lintel.db');
  new DatabaseSync(path).close();
  provisionSqliteIntegrations(path);
  const store = await openIntegrationStore({ sqlite: path });
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { store, app: 'lintel' };
});

describe('on PostgreSQL', { skip: liveSkip('postgres', LIVE) }, () => {
  isolation('PostgreSQL', async (t) => {
    const database = await uuidPostgresDatabase('tw_tenant_contact');
    let store: IntegrationStore | undefined;
    t.after(async () => {
      await store?.close();
      await database.drop();
    });
    await provisionPostgresIntegrations(database.url);
    store = await openIntegrationStore({ postgres: database.url });
    return { store, app: 'lintel' };
  });
});

test("a tenant's write queues its mail under that tenant, says why, and a visitor's write mails only the address they proved", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-tenant-contact-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE contact (id INTEGER PRIMARY KEY, tenant_id TEXT NOT NULL, status TEXT, email TEXT, email_ok INTEGER, proved TEXT);
    INSERT INTO contact VALUES (1, 'north', 'open', 'ann@example.test', 1, NULL), (2, 'south', 'open', 'pia@example.test', 1, 'pia@example.test'),
      (3, 'south', 'open', 'pat@example.test', 1, NULL);`);
  db.exec('BEGIN IMMEDIATE');
  const schema = readSqliteScopeCatalog(db).schema;
  db.exec('COMMIT');
  provisionSqliteIntegrations(path);
  const adapter = new SqliteAdapter(path);
  t.after(async () => {
    await adapter.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const parsed = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
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
      views: {
        contacts: { kind: 'list', from: 'contact', show: ['status', 'email'] },
      },
      home: 'contacts',
    },
    'desk',
  );
  // A saved form that proves the address a visitor gives, and the sign-in a tenant App has: what the binding reads.
  const app = {
    ...parsed,
    auth: { roles: ['clerk'] },
    views: {
      ...parsed.views,
      apply: {
        kind: 'form',
        link: { email: { column: 'email', verified: 'proved' } },
      },
    },
  } as unknown as AppDef;
  const ownership = captureTenantOwnership({
    appId: 'desk',
    source: { id: 'business', connection: 'desk' },
    schema,
    physicalSchema: structuredClone(schema),
    resources: { contact: 'contact' },
    ownership: { contact: { kind: 'tenant', column: 'tenant_id' } },
  });
  bindNotices(adapter, tenantNoticeBinding(app, ownership));
  const ready = (id: number, by: 'clerk' | 'visitor') =>
    attributeWrites(by === 'clerk' ? { actor: 'clerk@example.org', name: 'Clerk', via: 'app' } : { via: 'form' }, () =>
      adapter.update({
        table: 'contact',
        key: { id },
        values: { status: 'ready' },
      }),
    );
  await ready(1, 'clerk');
  await ready(2, 'visitor');
  await ready(3, 'visitor');
  assert.deepEqual(
    db
      .prepare('SELECT tenant, recipient, actor_kind, text FROM "__mistri_integration_message" ORDER BY recipient')
      .all()
      .map((row) => ({ ...row })),
    [
      {
        tenant: 'north',
        recipient: 'ann@example.test',
        actor_kind: 'account',
        text: 'Contact 1 is ready.\n\nYou get this because Desk has your address on file for a contact.',
      },
      {
        tenant: 'south',
        recipient: 'pat@example.test',
        actor_kind: 'public',
        text: 'Contact 3 is ready.\n\nYou get this because Desk has your address on file for a contact.',
      },
      {
        tenant: 'south',
        recipient: 'pia@example.test',
        actor_kind: 'proven',
        text: 'Contact 2 is ready.\n\nYou get this because Desk has your address on file for a contact.',
      },
    ],
  );
});
