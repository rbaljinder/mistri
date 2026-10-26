/**
 * The email service as a config file names it, and its SMTP transport
 * against a small server on this machine: what the envelope and the message
 * say, that a credential never crosses in the clear unless the connection
 * says `insecure`, and that a 5xx is a refusal for good and a 4xx one to
 * try again.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkServices, serviceConnectionOf, serviceEntry } from '../packages/engine/src/server/configSections.js';
import { CONFIG_SECTIONS } from '../packages/mistri/src/server/serviceConnections.js';
import { EmailFailure, composeMessage, emailConnectionOf, openEmailTransport } from '../packages/mistri/src/server/email/email.js';
import { dataOf } from '../packages/mistri/src/adapters/email/smtp.js';
import { addSink, type SpanRecord } from '../packages/engine/src/adapters/telemetry/trace.js';
import { sendSuiteInvitationEmail } from '../packages/mistri/src/server/auth/suiteEmail.js';
import { smtpRelay as relay } from './support/smtpRelay.js';

const entry = (fields: Record<string, unknown>) => ({
  name: 'mail',
  kind: 'email',
  url: 'smtps://smtp.example.com:465',
  from: 'Compass <no-reply@example.com>',
  ...fields,
});

test('an email connection is checked when the file is read, and written back as it was read', () => {
  const read = serviceConnectionOf(
    CONFIG_SECTIONS,
    entry({ auth: { username: '${SMTP_USER}', password: '${SMTP_PASSWORD}' } }),
    'mistri.json',
  );
  assert.deepEqual(serviceEntry(CONFIG_SECTIONS, read), entry({ auth: { username: '${SMTP_USER}', password: '${SMTP_PASSWORD}' } }));
  assert.throws(
    () => serviceConnectionOf(CONFIG_SECTIONS, entry({ url: 'https://smtp.example.com' }), 'mistri.json'),
    /smtps:\/\/ \(TLS\), smtp:\/\/ \(STARTTLS\), or log:/,
  );
  assert.throws(
    () => serviceConnectionOf(CONFIG_SECTIONS, entry({ url: 'smtps://me:secret@smtp.example.com' }), 'mistri.json'),
    /credential in its "url"/,
  );
  assert.throws(() => serviceConnectionOf(CONFIG_SECTIONS, entry({ from: 'nobody' }), 'mistri.json'), /needs a "from"/);
  assert.throws(() => serviceConnectionOf(CONFIG_SECTIONS, entry({ auth: { password: 'x' } }), 'mistri.json'), /"auth" mistri cannot read/);
  assert.throws(() => serviceConnectionOf(CONFIG_SECTIONS, entry({ port: 25 }), 'mistri.json'), /takes no "port"/);
  // A reference is checked once it opens.
  assert.equal((serviceConnectionOf(CONFIG_SECTIONS, entry({ url: '${SMTP_URL}' }), 'mistri.json') as { url: string }).url, '${SMTP_URL}');
  assert.throws(() => checkServices(CONFIG_SECTIONS, [read, { ...read, name: 'second' }], 'mistri.json'), /one email service/);
});

test('a message is plain UTF-8 in base64, its subject one line, and DATA doubles a leading dot', () => {
  const text = composeMessage(
    'Compass <no-reply@example.com>',
    { to: 'ann@example.test', subject: 'Café\r\nBcc: mallory@example.test', text: 'Hi.\n.hidden' },
    new Date('2026-09-25T12:00:00Z'),
  );
  assert.match(text, /^From: Compass <no-reply@example\.com>\r\nTo: ann@example\.test\r\nSubject: =\?UTF-8\?B\?/);
  assert.doesNotMatch(text, /\r\nBcc:/);
  assert.match(text, /Content-Transfer-Encoding: base64/);
  assert.equal(dataOf('a\n.b'), 'a\r\n..b\r\n.\r\n');
});

test('SMTP: a plain relay only when insecure, the envelope from the config, and 5xx for good while 4xx may pass', async () => {
  process.env.TW_TEST_SMTP_PASSWORD = 'hunter22';
  const plain = await relay();
  try {
    const refusing = openEmailTransport(
      emailConnectionOf(
        entry({ url: `smtp://127.0.0.1:${plain.port}`, auth: { username: 'mailer', password: '${TW_TEST_SMTP_PASSWORD}' } }),
        'test',
      ),
    );
    await assert.rejects(refusing.send({ to: 'ann@example.test', subject: 'Hi', text: 'Hello' }), (error: unknown) => {
      assert.ok(error instanceof EmailFailure);
      assert.equal(error.permanent, true);
      assert.match(error.message, /does not offer STARTTLS/);
      assert.doesNotMatch(error.message, /hunter22/);
      return true;
    });
    assert.ok(!plain.seen.some((line) => line.startsWith('AUTH')), 'no credential in the clear');

    const insecure = openEmailTransport(
      emailConnectionOf(
        entry({
          url: `smtp://127.0.0.1:${plain.port}`,
          insecure: true,
          auth: { username: 'mailer', password: '${TW_TEST_SMTP_PASSWORD}' },
        }),
        'test',
      ),
    );
    await insecure.send({ to: 'ann@example.test', subject: 'New reply', text: 'Hello.' });
    assert.ok(plain.seen.includes('MAIL FROM:<no-reply@example.com>'));
    assert.ok(plain.seen.includes('RCPT TO:<ann@example.test>'));
    assert.equal(
      plain.seen.find((line) => line.startsWith('AUTH')),
      `AUTH PLAIN ${Buffer.from('\u0000mailer\u0000hunter22').toString('base64')}`,
    );
    assert.match(plain.data(), /Subject: New reply/);
  } finally {
    await plain.close();
    delete process.env.TW_TEST_SMTP_PASSWORD;
  }

  for (const [rcpt, permanent] of [
    ['550 no such mailbox', true],
    ['451 try later', false],
  ] as const) {
    const busy = await relay({ rcpt });
    try {
      const transport = openEmailTransport(emailConnectionOf(entry({ url: `smtp://127.0.0.1:${busy.port}`, insecure: true }), 'test'));
      await assert.rejects(
        transport.send({ to: 'ann@example.test', subject: 'Hi', text: 'Hello' }),
        (error: unknown) => error instanceof EmailFailure && error.permanent === permanent,
      );
    } finally {
      await busy.close();
    }
  }
});

test('a recipient carrying a line break never reaches the headers, whoever composes the message', () => {
  for (const to of [
    'ann@example.test\r\nBcc: mallory@example.test',
    'ann@example.test\nBcc: x@y.z',
    'ann@example.test, eve@example.test',
  ]) {
    assert.throws(() => composeMessage('Compass <no-reply@example.com>', { to, subject: 'Hi', text: 'Hi.' }), EmailFailure);
  }
});

test('SMTP explicit environment captures URL and credentials at open without ambient fallback, retaining resolver and TLS options', async () => {
  const plain = await relay();
  const keys = ['TW_SUITE_SMTP_URL', 'TW_SUITE_SMTP_USER', 'TW_SUITE_SMTP_PASSWORD'] as const;
  const before = keys.map((key) => process.env[key]);
  try {
    process.env.TW_SUITE_SMTP_URL = 'smtp://wrong.example.test:1';
    process.env.TW_SUITE_SMTP_USER = 'ambient-user';
    process.env.TW_SUITE_SMTP_PASSWORD = 'ambient-secret';
    const service = emailConnectionOf(
      entry({
        url: '${TW_SUITE_SMTP_URL}',
        insecure: true,
        auth: { username: '${TW_SUITE_SMTP_USER}', password: '${TW_SUITE_SMTP_PASSWORD}' },
      }),
      'test',
    );
    const environment = {
      TW_SUITE_SMTP_URL: `smtp://relay.example.test:${plain.port}`,
      TW_SUITE_SMTP_USER: 'isolated-user',
      TW_SUITE_SMTP_PASSWORD: 'isolated-secret',
    };
    let resolved = '';
    const transport = openEmailTransport(service, {
      environment,
      tls: { rejectUnauthorized: false },
      resolver: (host, _options, callback) => {
        resolved = host;
        callback(null, [{ address: '127.0.0.1', family: 4 }]);
      },
    });
    environment.TW_SUITE_SMTP_URL = 'bad-after-open';
    environment.TW_SUITE_SMTP_USER = 'changed-user';
    environment.TW_SUITE_SMTP_PASSWORD = 'changed-secret';
    await transport.send({ to: 'ann@example.test', subject: 'Captured', text: 'Hello.' });
    assert.equal(resolved, 'relay.example.test');
    assert.equal(
      plain.seen.find((line) => line.startsWith('AUTH')),
      `AUTH PLAIN ${Buffer.from('\0isolated-user\0isolated-secret').toString('base64')}`,
    );
    for (const missing of keys) {
      const partial: NodeJS.ProcessEnv = { ...environment };
      partial.TW_SUITE_SMTP_URL = `smtp://relay.example.test:${plain.port}`;
      delete partial[missing];
      assert.throws(() => openEmailTransport(service, { environment: partial }), /not set/);
    }
  } finally {
    keys.forEach((key, index) => {
      if (before[index] === undefined) delete process.env[key];
      else process.env[key] = before[index];
    });
    await plain.close();
  }
});

test('suite SMTP failures return unknown once and redact even relay-echoed secrets from local tracing', async () => {
  const token = 'b'.repeat(43);
  const plain = await relay({ rcpt: `550 secret-password ${token}` });
  const spans: SpanRecord[] = [];
  const remove = addSink({ local: true, onEnd: (span) => spans.push(span) });
  try {
    const transport = openEmailTransport(emailConnectionOf(entry({ url: `smtp://127.0.0.1:${plain.port}`, insecure: true }), 'test'), {
      environment: {},
    });
    assert.deepEqual(
      await sendSuiteInvitationEmail(transport, {
        subjectEmail: 'ann@example.test',
        appName: 'Accounts',
        publicOrigin: 'https://suite.example.test',
        basePath: '/suite',
        invitation: { appId: 'accounts', token },
      }),
      { status: 'unknown', error: 'email-send-failed' },
    );
    assert.equal(plain.seen.filter((line) => line.startsWith('RCPT')).length, 1);
    assert.equal(spans.length, 1);
    assert.doesNotMatch(JSON.stringify(spans), /secret-password/);
    assert.ok(!JSON.stringify(spans).includes(token));
    assert.equal(spans[0].detail.email, undefined);
  } finally {
    remove();
    await plain.close();
  }
});
