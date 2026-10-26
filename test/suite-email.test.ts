import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { addSink, type SpanRecord } from '../packages/engine/src/adapters/telemetry/trace.js';
import { sendSuiteInvitationEmail, type SuiteInvitationEmail } from '../packages/mistri/src/server/auth/suiteEmail.js';
import { openEmailTransport, type EmailMessage, type EmailServiceConfig } from '../packages/mistri/src/server/email/email.js';

const input: SuiteInvitationEmail = {
  subjectEmail: 'ann+suite@example.test',
  appName: 'Café accounts',
  publicOrigin: 'https://suite.example.test:8443',
  basePath: '/tools/team',
  invitation: Object.freeze({ appId: 'accounts', token: 'a'.repeat(43) }),
};
const config = (url: string): EmailServiceConfig => ({ kind: 'email', name: 'mail', from: 'Suite <no-reply@example.test>', url });

test('suite invitation log mail uses only configured origin, canonical suite base and fragment; observer has no token', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'suite-email-'));
  const spans: SpanRecord[] = [];
  const remove = addSink({ local: true, onEnd: (span) => spans.push(span) });
  try {
    const file = join(directory, 'mail.log');
    const transport = openEmailTransport(config(`log:${file}`), { environment: {} });
    assert.deepEqual(await sendSuiteInvitationEmail(transport, input), { status: 'accepted' });
    const mail = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(mail.to, input.subjectEmail);
    assert.equal(mail.subject, 'Invitation to Café accounts');
    const link = mail.text.split('\n').find((line: string) => line.startsWith('https://'));
    assert.equal(link, `https://suite.example.test:8443/tools/team/_mistri/apps#invite=accounts.${input.invitation.token}`);
    const url = new URL(link);
    assert.equal(url.search, '');
    assert.ok(!url.pathname.includes(input.invitation.token));
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 1);
    assert.equal(spans.length, 1);
    assert.deepEqual(spans[0].detail, {});
    assert.ok(!JSON.stringify(spans).includes(input.invitation.token));
    assert.ok(!JSON.stringify(spans).includes(input.subjectEmail));
  } finally {
    remove();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('root chooser and local testing origins are supported', async () => {
  for (const publicOrigin of [
    'https://suite.example.test',
    'http://localhost:4801',
    'http://127.0.0.1:4801',
    'http://127.2.3.4:4801',
    'http://[::1]:4801',
  ]) {
    const sent: EmailMessage[] = [];
    const result = await sendSuiteInvitationEmail(
      {
        name: 'record',
        async send(mail) {
          sent.push(mail);
        },
      },
      { ...input, publicOrigin, basePath: '' },
    );
    assert.deepEqual(result, { status: 'accepted' });
    assert.equal(sent.length, 1);
    assert.ok(sent[0].text.includes(`${publicOrigin}/_mistri/apps#invite=accounts.${input.invitation.token}`));
    assert.equal(sent[0].sensitive, true);
  }
});

test('unknown delivery exposes no SMTP secrets or token and attempts only the committed invitation once', async () => {
  let calls = 0;
  const committed = Object.freeze({ ...input });
  const result = await sendSuiteInvitationEmail(
    {
      name: 'refusing',
      async send() {
        calls++;
        throw new Error(`SMTP secret-password ${input.invitation.token}`);
      },
    },
    committed,
  );
  assert.deepEqual(result, { status: 'unknown', error: 'email-send-failed' });
  assert.equal(calls, 1);
  assert.deepEqual(committed, input);
});

test('malformed origins, paths, app IDs, tokens, recipients and header injection are refused without sending', async () => {
  const invalid: SuiteInvitationEmail[] = [
    ...[
      'http://example.test',
      'http://localhost.evil.test',
      'http://0.0.0.0',
      'http://[::]',
      'http://192.168.1.2',
      'https://u:p@suite.example.test',
      'https://@suite.example.test',
      'https://suite.example.test/',
      'https://suite.example.test/path',
      'https://suite.example.test?',
      'https://suite.example.test#',
      'https://suite.example.test?q=1',
      'https://suite.example.test#secret',
      'https://SUITE.example.test',
      'https://suite.example.test:443',
      ' https://suite.example.test',
      'https://suite.example.test\n',
      'https://suite.example.test\\evil',
      'http://127.1',
      'ftp://suite.example.test',
      '//suite.example.test',
      'bogus',
    ].map((publicOrigin) => ({ ...input, publicOrigin })),
    ...[
      '/',
      'tools',
      '/tools/',
      '//evil',
      '/a//b',
      '/a/../b',
      '/a/./b',
      '/%2e%2e',
      '/a%2fb',
      '/a\\b',
      '/a?q=1',
      '/a#x',
      '/a\n',
      `/${'a'.repeat(65)}`,
    ].map((basePath) => ({ ...input, basePath })),
    ...['', '-app', '../app', 'app.name', 'app#x', 'app?x', 'app\n', 'app\r\nBcc:x@y.z', 'a'.repeat(65)].map((appId) => ({
      ...input,
      invitation: { ...input.invitation, appId },
    })),
    ...['', 'a'.repeat(42), 'a'.repeat(44), 'a'.repeat(43) + '\n', 'a'.repeat(42) + '/', 'a'.repeat(42) + '='].map((token) => ({
      ...input,
      invitation: { ...input.invitation, token },
    })),
    ...[
      '',
      'not-email',
      'a@b',
      'Ann <ann@example.test>',
      'ann@example.test,other@example.test',
      'ann@example.test\r\nBcc:other@example.test',
      'ann@example.test\n',
      'ann@example.test\0',
      'ann@-example.test',
      'ann@exam_ple.test',
      'ann..smith@example.test',
      '.ann@example.test',
      `${'a'.repeat(65)}@example.test`,
    ].map((subjectEmail) => ({ ...input, subjectEmail })),
    ...['', ' ', 'App\r\nBcc:other@example.test', 'App\n', 'App\0', 'App\u2028name', 'a'.repeat(257)].map((appName) => ({
      ...input,
      appName,
    })),
    { ...input, invitation: null } as unknown as SuiteInvitationEmail,
    null as unknown as SuiteInvitationEmail,
  ];
  let calls = 0;
  for (const value of invalid) {
    assert.deepEqual(
      await sendSuiteInvitationEmail(
        {
          name: 'must-not-send',
          async send() {
            calls++;
          },
        },
        value,
      ),
      { status: 'unknown', error: 'invalid-invitation-email' },
      JSON.stringify(value),
    );
  }
  assert.equal(calls, 0);
});

test('transport captures an explicit URL environment at open and an empty environment never uses ambient secrets', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'suite-email-env-'));
  const before = process.env.TW_SUITE_EMAIL_URL;
  try {
    process.env.TW_SUITE_EMAIL_URL = `log:${join(directory, 'ambient.log')}`;
    const environment = { TW_SUITE_EMAIL_URL: `log:${join(directory, 'explicit.log')}` };
    const transport = openEmailTransport(config('${TW_SUITE_EMAIL_URL}'), { environment });
    environment.TW_SUITE_EMAIL_URL = 'invalid-after-open';
    process.env.TW_SUITE_EMAIL_URL = 'also-invalid-after-open';
    assert.deepEqual(await sendSuiteInvitationEmail(transport, input), { status: 'accepted' });
    assert.equal(JSON.parse(readFileSync(join(directory, 'explicit.log'), 'utf8')).to, input.subjectEmail);
    assert.throws(() => readFileSync(join(directory, 'ambient.log')), { code: 'ENOENT' });
    assert.throws(() => openEmailTransport(config('${TW_SUITE_EMAIL_URL}'), { environment: {} }), /not set/);
    process.env.TW_SUITE_EMAIL_URL = `log:${join(directory, 'legacy.log')}`;
    const legacy = openEmailTransport(config('${TW_SUITE_EMAIL_URL}'));
    await legacy.send({ to: input.subjectEmail, subject: 'Standalone', text: 'Still uses process.env by default.' });
    assert.equal(JSON.parse(readFileSync(join(directory, 'legacy.log'), 'utf8')).subject, 'Standalone');
  } finally {
    if (before === undefined) delete process.env.TW_SUITE_EMAIL_URL;
    else process.env.TW_SUITE_EMAIL_URL = before;
    rmSync(directory, { recursive: true, force: true });
  }
});
