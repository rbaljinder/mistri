/**
 * Notify email in a row-policy App (CX2 phase B). The outbox asks the policy
 * for the recipient's rows as a session of theirs would — their account, by
 * the address it found, never the write's — and mails a notice only while the
 * policy gives them its record. A policy that is not served yet (a reload)
 * holds the mail for a later pass rather than dropping it or reading unscoped.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { INBOX_TABLES } from '../packages/mistri/src/adapters/inbox/inbox.js';
import { appendSqliteNotice, provisionSqliteInbox } from '../packages/mistri/src/adapters/inbox/sqliteInbox.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createEmailOutbox, emailProblems, type MailAccount } from '../packages/mistri/src/server/email/outbox.js';
import type { EmailMessage, EmailTransport } from '../packages/mistri/src/server/email/email.js';
import { loadHttpAppPolicy, type HttpAppPolicy } from '../packages/mistri/src/server/policy/appPolicyHttp.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';

const definition = parseAppConfig(
  {
    id: 'desk-mail',
    name: 'Desk',
    sources: { desk: { connection: 'desk-mail', default: true } },
    resources: {
      ticket: { access: 'write', notify: [{ on: 'insert', to: 'owner', title: 'New ticket {title}', email: true }] },
    },
    auth: { rows: 'policy', roles: { agent: { read: true, write: true } } },
    views: { tickets: { kind: 'list', from: 'ticket' } },
    home: 'tickets',
    nav: ['tickets'],
  },
  'desk mail fixture',
);

const accounts = new Map<string, MailAccount>([
  ['ann@example.test', { id: 'account-ann', roles: ['agent'] }],
  ['bob@example.test', { id: 'account-bob', roles: ['agent'] }],
]);

class Recorder implements EmailTransport {
  readonly name = 'test';
  sent: EmailMessage[] = [];
  async send(message: EmailMessage) {
    this.sent.push(message);
  }
}

async function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-row-policy-mail-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  // Ann works desk 1 and Bob desk 2; the policy gives each their own desk's tickets.
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, desk INTEGER NOT NULL, title TEXT NOT NULL, owner TEXT NOT NULL);
    INSERT INTO ticket VALUES (1, 1, 'Printer', 'ann@example.test'), (2, 2, 'Badge', 'bob@example.test');`);
  provisionSqliteInbox(file);
  const policyFile = join(directory, 'policy.mjs');
  writeFileSync(
    policyFile,
    `const desks = { 'account-ann': 1, 'account-bob': 2 };
export default { appId: 'desk-mail',
  resolveRows(principal) {
    const desk = desks[principal.id];
    return desk ? { ticket: { groups: [[{ column: 'desk', op: '=', value: desk }]] } } : {};
  } };
`,
  );
  const registry = new Registry();
  registry.add({ id: 'desk-mail', name: 'desk', url: file, source: 'config', writable: true });
  const policy = await loadHttpAppPolicy({ app: definition, registry, file: policyFile, verifySession: async () => null });
  const host: AppHost = {
    app: { path: 'desk-mail.ts', app: definition, pages: [], sources: {} },
    pages: [],
    auth: { spec: definition.auth!, store: 'not-used', handler: async () => {}, close: async () => {}, session: async () => null },
  };
  let served: HttpAppPolicy | undefined = policy;
  const mail = new Recorder();
  const clock = { now: Date.now() + 60_000 };
  const outbox = createEmailOutbox({
    registry,
    hosts: () => [host],
    transport: mail,
    baseURL: 'https://desk.example.test/',
    account: async (_host, email) => accounts.get(email) ?? null,
    policy: () => served,
    now: () => clock.now,
    warn: () => {},
  });
  t.after(async () => {
    await policy.retire();
    await registry.closeAll();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  // What a committed insert queues: its notice, and the notice's place in the outbox.
  const notice = (recipient: string, key: number, title: string) =>
    appendSqliteNotice(db, {
      app: 'desk-mail',
      recipient,
      at: new Date().toISOString(),
      resource: 'ticket',
      key: JSON.stringify({ id: key }),
      title,
      uses: ['ticket.title'],
      actor: 'cat@example.test',
      actorName: 'Cat',
      action: 'insert',
      email: true,
    });
  const queued = () => db.prepare(`SELECT state, attempts FROM "${INBOX_TABLES.mail}"`).all();
  return { outbox, mail, notice, queued, clock, unserve: () => (served = undefined), serve: () => (served = policy) };
}

test('a row-policy App emails a notice only to a recipient the policy gives its record', { timeout: 60_000 }, async (t) => {
  assert.equal(emailProblems(definition, true), undefined, 'notify email is served under a row policy');
  const desk = await fixture(t);
  desk.notice('ann@example.test', 1, 'New ticket Printer');
  // Bob is an account of the App and an agent, but ticket 1 is desk 1's: the policy does not give it to him.
  desk.notice('bob@example.test', 1, 'New ticket Printer');
  desk.notice('bob@example.test', 2, 'New ticket Badge');
  // An address that is no account is never mailed, whatever the column said.
  desk.notice('dan@example.test', 2, 'New ticket Badge');
  assert.deepEqual(await desk.outbox.runOnce(), { sent: 2, skipped: 2, retried: 0, failed: 0 });
  assert.deepEqual(
    desk.mail.sent.map((message) => [message.to, message.subject]),
    [
      ['ann@example.test', 'New ticket Printer'],
      ['bob@example.test', 'New ticket Badge'],
    ],
  );
  assert.match(desk.mail.sent[0].text, /https:\/\/desk\.example\.test\/desk-mail\/tickets\/1/);
  assert.deepEqual(desk.queued(), []);
});

test('a row-policy App whose policy is not served holds its mail for a later pass, never read unscoped', { timeout: 60_000 }, async (t) => {
  const desk = await fixture(t);
  desk.notice('bob@example.test', 1, 'New ticket Printer');
  desk.unserve();
  assert.deepEqual(await desk.outbox.runOnce(), { sent: 0, skipped: 0, retried: 1, failed: 0 });
  assert.deepEqual(
    desk.queued().map((row) => ({ ...row })),
    [{ state: 'queued', attempts: 1 }],
  );
  desk.serve();
  desk.clock.now += 3_600_000;
  assert.deepEqual(await desk.outbox.runOnce(), { sent: 0, skipped: 1, retried: 0, failed: 0 });
  assert.deepEqual(desk.mail.sent, []);
});
