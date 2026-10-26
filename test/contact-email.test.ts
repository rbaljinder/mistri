/**
 * Mail to an address a record holds (`notify.send: { channel: 'email' }`):
 * queued with the write that tells it, one address or nothing; decided after
 * the commit — the opt-out, consent, a visitor's unproven address and the
 * caps, in that order — and sent as plain text with its unsubscribe link and
 * List-Unsubscribe headers; the link's route; and what `mistri check` and
 * startup say about it, by code.
 */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import {
  openIntegrationStore,
  provisionSqliteIntegrations,
  type IntegrationStore,
} from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { SqliteAdapter } from '../packages/engine/src/adapters/sqlite.js';
import { attributeWrites } from '../packages/engine/src/adapters/writeAttribution.js';
import type { NoticeRule } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { bindNotices } from '../packages/mistri/src/server/stores/writeCaptures.js';
import { composeMessage, type EmailMessage, type EmailTransport } from '../packages/mistri/src/server/email/email.js';
import {
  createUnsubscribeRoute,
  issueUnsubscribeToken,
  readUnsubscribeToken,
  UNSUBSCRIBE_PATH,
} from '../packages/mistri/src/server/email/unsubscribe.js';
import { channelHolder, EMAIL_LIMITS, emailChannelSender } from '../packages/mistri/src/server/integrations/integrationChannels.js';
import { contactEmailFindings, integrationNotifyProblems } from '../packages/mistri/src/server/integrations/integrationChecks.js';

const SECRET = 'a-links-secret-for-the-contact-email-test';
const LINK = 'https://desk.example.test/api/mail/unsubscribe';

class Recorder implements EmailTransport {
  readonly name = 'test';
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-contact-email-'));
  const path = join(directory, 'desk.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE contact (id INTEGER PRIMARY KEY, status TEXT, email TEXT, email_ok INTEGER, proved TEXT);
    INSERT INTO contact VALUES
      (1, 'open', ' Ann@Example.TEST ', 1, NULL),
      (2, 'open', 'bob@example.test', 0, NULL),
      (3, 'open', 'eve@example.test, mal@example.test', 1, NULL),
      (4, 'open', 'x@example.test' || char(13) || char(10) || 'Bcc: y@example.test', 1, NULL),
      (5, 'open', 'pat@example.test', 1, NULL),
      (6, 'open', 'pia@example.test', 1, 'PIA@example.test'),
      (7, 'open', 'opt@example.test', 1, NULL),
      (8, 'open', 'busy@example.test', 1, NULL);`);
  provisionSqliteIntegrations(path);
  const adapter = new SqliteAdapter(path);
  const store = await openIntegrationStore({ sqlite: path });
  t.after(async () => {
    await adapter.close();
    await store.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const column = (name: string) => ({ column: name, hops: [] });
  const rule: NoticeRule = {
    app: 'desk',
    on: { kind: 'update', columns: ['status'] },
    when: [[{ column: 'status', values: ['ready'] }]],
    to: [],
    title: ['Contact ', column('id'), ' is ready.'],
    open: { resource: 'contact' },
    uses: [],
    send: {
      channel: 'email',
      to: column('email'),
      consent: column('email_ok'),
      proof: ['proved'],
      because: 'You get this because Desk has your address on file for a contact.',
    },
  };
  bindNotices(adapter, new Map([['contact', [rule]]]));
  const ready = (id: number, by: 'clerk' | 'visitor' = 'clerk') =>
    attributeWrites(by === 'clerk' ? { actor: 'clerk@example.org', name: 'Clerk', via: 'app' } : { via: 'form' }, () =>
      adapter.update({
        table: 'contact',
        key: { id },
        values: { status: 'ready' },
      }),
    );
  const queued = () =>
    db
      .prepare('SELECT recipient, state, reason, actor_kind FROM "__mistri_integration_message" ORDER BY recipient')
      .all()
      .map((row) => ({ ...row }));
  const mail = new Recorder();
  const clock = { now: Date.now() + 1000 };
  const sender = emailChannelSender({
    appId: 'desk',
    store,
    transport: mail,
    unsubscribe: (claim) => `${LINK}?token=${issueUnsubscribeToken(SECRET, claim)}`,
    now: () => clock.now,
  });
  return { adapter, db, store, ready, queued, mail, sender, clock };
}

test('an email rule queues one address with its write, and the channel decides opt-out, consent, proof and caps in turn', async (t) => {
  const desk = await fixture(t);
  await assert.rejects(
    desk.adapter.transaction(async (tx) => {
      await tx.update({
        table: 'contact',
        key: { id: 1 },
        values: { status: 'ready' },
      });
      throw new Error('handler failed');
    }),
    /handler failed/,
  );
  assert.deepEqual(desk.queued(), [], 'a write that rolled back queued nothing');

  await desk.store.setConsent({
    app: 'desk',
    tenant: '',
    channel: 'email',
    holder: channelHolder('opt@example.test', 'email'),
    state: 'out',
    source: 'unsubscribe',
    at: Date.now(),
  });
  for (const id of [1, 2, 3, 4, 7]) await desk.ready(id);
  for (const id of [5, 6]) await desk.ready(id, 'visitor');
  assert.deepEqual(
    desk.queued(),
    [
      {
        recipient: 'ann@example.test',
        state: 'held',
        reason: 'queued',
        actor_kind: 'account',
      },
      {
        recipient: 'bob@example.test',
        state: 'held',
        reason: 'queued',
        actor_kind: 'account',
      },
      {
        recipient: 'opt@example.test',
        state: 'held',
        reason: 'queued',
        actor_kind: 'account',
      },
      {
        recipient: 'pat@example.test',
        state: 'held',
        reason: 'queued',
        actor_kind: 'public',
      },
      {
        recipient: 'pia@example.test',
        state: 'held',
        reason: 'queued',
        actor_kind: 'proven',
      },
    ],
    'two addresses in one value, or a line break, queue nothing; an address is trimmed and lowercased',
  );

  assert.equal(await desk.sender.sendDue(), true);
  const state = () => Object.fromEntries(desk.queued().map((row) => [row.recipient, `${row.state}:${row.reason}`]));
  assert.deepEqual(state(), {
    'ann@example.test': 'sent:null',
    'bob@example.test': 'suppressed:no_consent',
    'opt@example.test': 'suppressed:opted_out',
    'pat@example.test': 'suppressed:unproven',
    'pia@example.test': 'sent:null',
  });
  const [ann] = desk.mail.sent;
  assert.deepEqual(
    desk.mail.sent.map((message) => [message.to, message.subject]),
    [
      ['ann@example.test', 'Contact 1 is ready.'],
      ['pia@example.test', 'Contact 6 is ready.'],
    ],
  );
  assert.match(
    ann.text,
    /^Contact 1 is ready\.\n\nYou get this because Desk has your address on file for a contact\.\n\nTo stop these emails: https:\/\/desk\.example\.test\/api\/mail\/unsubscribe\?token=/,
  );
  assert.equal(ann.text.match(/token=([\w.-]+)/)![1], ann.unsubscribe!.split('token=')[1]);
  const claim = readUnsubscribeToken(SECRET, ann.unsubscribe!.split('token=')[1]);
  assert.deepEqual(claim, {
    app: 'desk',
    tenant: '',
    channel: 'email',
    holder: channelHolder('ann@example.test', 'email'),
  });
  assert.doesNotMatch(JSON.stringify(claim), /ann@/, 'the token names a digest, never the address');
  const raw = composeMessage('Desk <no-reply@example.test>', ann);
  assert.match(raw, new RegExp(`\r\nList-Unsubscribe: <${ann.unsubscribe!.replace(/[.?]/g, '\\$&')}>\r\n`));
  assert.match(raw, /\r\nList-Unsubscribe-Post: List-Unsubscribe=One-Click\r\n/);
  assert.match(raw, /\r\nSubject: Contact 1 is ready\.\r\n/);
  assert.throws(
    () =>
      composeMessage('Desk <no-reply@example.test>', {
        ...ann,
        unsubscribe: 'https://x.test/a\r\nBcc: y@z.test',
      }),
    /unsubscribe link/,
  );

  // The caps count what was sent: an address that had its five today gets no sixth.
  for (let i = 0; i < EMAIL_LIMITS.perAddress; i++)
    await desk.store.putMessage({
      app: 'desk',
      key: `earlier-${i}`,
      tenant: '',
      channel: 'email',
      recipient: 'busy@example.test',
      text: 'Earlier',
      state: 'sent',
      reason: null,
      providerId: null,
      dueAt: null,
      attempts: 1,
      at: desk.clock.now - 3_600_000,
    });
  await desk.ready(8);
  await desk.sender.sendDue();
  assert.equal(state()['busy@example.test'], 'suppressed:rate_limited');
  assert.equal(desk.mail.sent.length, 2);
  assert.equal(await desk.sender.sendDue(), false, 'nothing is left to decide');
});

test('an email address is one holder as written, a phone number one however it is spaced', () => {
  assert.notEqual(channelHolder('john.doe@example.test', 'email'), channelHolder('johndoe@example.test', 'email'));
  assert.equal(channelHolder(' John.Doe@Example.test ', 'email'), channelHolder('john.doe@example.test', 'email'));
  assert.equal(channelHolder('+1 (555) 010-0100', 'sms'), channelHolder('+15550100100', 'sms'));
  assert.notEqual(channelHolder('a@example.test', 'email'), channelHolder('a@example.test', 'sms'));
});

async function route(t: TestContext, store: IntegrationStore) {
  const unsubscribe = createUnsubscribeRoute({
    secret: SECRET,
    apps: (id) => (id === 'desk' ? { name: 'Desk', store } : undefined),
  });
  const server = createServer((req, res) => {
    void unsubscribe.handle(req, res, new URL(req.url!, 'http://localhost')).then((handled) => {
      if (!handled) res.writeHead(418).end();
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((done) => server.close(() => done())));
  const { port } = server.address() as { port: number };
  return (token: string, init?: RequestInit) =>
    fetch(`http://127.0.0.1:${port}${UNSUBSCRIBE_PATH}?token=${encodeURIComponent(token)}`, init);
}

test('the unsubscribe link asks on GET, stops the mail on POST, starts it again on resubscribe, and is a 404 when it is not genuine', async (t) => {
  const desk = await fixture(t);
  const open = await route(t, desk.store);
  const holder = channelHolder('ann@example.test', 'email');
  const token = issueUnsubscribeToken(SECRET, {
    app: 'desk',
    tenant: '',
    channel: 'email',
    holder,
  });
  const consent = async () => (await desk.store.consent('desk', '', 'email', holder))?.state;

  const asked = await open(token);
  assert.equal(asked.status, 200);
  assert.match(await asked.text(), /Stop these emails\?/);
  assert.equal(await consent(), undefined, 'a GET (a scanner following the link) changes nothing');

  const [payload, signature] = token.split('.');
  const forged = `${payload}.${signature.slice(0, -2)}${signature.endsWith('AA') ? 'AB' : 'AA'}`;
  for (const wrong of [
    forged,
    issueUnsubscribeToken('another-secret-entirely', {
      app: 'desk',
      tenant: '',
      channel: 'email',
      holder,
    }),
    issueUnsubscribeToken(SECRET, {
      app: 'elsewhere',
      tenant: '',
      channel: 'email',
      holder,
    }),
    'not-a-token',
  ]) {
    const refused = await open(wrong, {
      method: 'POST',
      body: 'List-Unsubscribe=One-Click',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    assert.equal(refused.status, 404);
  }
  assert.equal(await consent(), undefined);

  const oneClick = await open(token, {
    method: 'POST',
    body: 'List-Unsubscribe=One-Click',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(oneClick.status, 200);
  assert.equal(await consent(), 'out');
  await desk.ready(1);
  await desk.sender.sendDue();
  assert.deepEqual(desk.mail.sent, [], 'an unsubscribed address is mailed nothing');

  const again = await open(token, {
    method: 'POST',
    body: 'action=resubscribe',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(again.status, 200);
  assert.match(await again.text(), /subscribed again/);
  assert.equal(await consent(), 'in');
});

test('what startup and mistri check say about an App that emails an address a record holds, by code', () => {
  const rule = (send: Record<string, unknown>) => ({
    on: 'update',
    title: 'Ready',
    send: { channel: 'email', to: 'email', ...send },
  });
  const app = (via: Record<string, unknown> = { consent: 'email_ok' }, more: Record<string, unknown> = {}) =>
    ({
      id: 'desk',
      name: 'Desk',
      sources: { main: { connection: 'desk', default: true } },
      resources: { contact: { notify: [rule(via)] } },
      views: {},
      ...more,
    }) as never;
  const codes = (findings: { problems: string[]; warnings: string[] }) =>
    [...findings.problems, ...findings.warnings].map((line) => /^\[([a-z-]+)\]/.exec(line)?.[1]);

  assert.deepEqual(codes(contactEmailFindings(app(), { email: { links: true } })), []);
  assert.deepEqual(codes(contactEmailFindings(app(), { email: undefined })), ['notify-send-transport']);
  assert.deepEqual(codes(contactEmailFindings(app(), { email: { links: false } })), ['notify-send-links-secret']);
  assert.deepEqual(
    codes(
      contactEmailFindings(app({ consent: 'email_ok', timezone: 'tz' }), {
        email: { links: true },
      }),
    ),
    ['notify-send-timezone'],
  );
  // A tenant App queues each tenant's mail beside its records, in its one source (test/tenant-contact-email.test.ts).
  assert.deepEqual(
    codes(
      contactEmailFindings(app({ consent: 'email_ok' }, { auth: { rows: 'tenant' } }), {
        email: { links: true },
        connectionOf: (resource) => ({ id: resource, dialect: 'postgres' }),
      }),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      contactEmailFindings(app(), {
        email: { links: true },
        connectionOf: () => ({ id: 'shop', dialect: 'MySQL' }),
      }),
    ),
    ['notify-send-source'],
  );
  assert.deepEqual(codes(contactEmailFindings(app({}), { email: { links: true } })), ['notify-send-consent']);
  const commands = {
    book: { public: true, source: 'main', write: ['contact'] },
  } as never;
  assert.deepEqual(codes(contactEmailFindings(app(), { email: { links: true }, commands })), ['notify-send-unproven']);
  const proving = app(undefined, {
    views: {
      apply: {
        kind: 'form',
        link: { email: { column: 'email', verified: 'proved' } },
      },
    },
  });
  assert.deepEqual(codes(contactEmailFindings(proving, { email: { links: true }, commands })), [], 'a form that proves the address');

  // Email is the platform's channel: a rule needs no integration for it (and defineIntegration refuses one named so).
  assert.deepEqual(integrationNotifyProblems(undefined, app()), []);
});
