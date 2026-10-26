/**
 * DKIM signing (packages/mistri/src/server/email/dkim.ts): relaxed/relaxed, rsa-sha256, as a
 * receiving server checks it. A fixed key and a fixed message pin the exact
 * canonical text and the exact signature — RSA PKCS#1 v1.5 is deterministic,
 * so the answer is known — and a verifier written apart from the signer
 * (test/support/dkimVerify.ts) checks it the way a receiver would.
 */
import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dkimKey, dkimRecord, dkimSign, generateDkimKey, relaxedBody, relaxedHeader } from '../packages/mistri/src/server/email/dkim.js';
import { composeMail, emailConnectionOf, emailEntry } from '../packages/mistri/src/server/email/email.js';
import { mailDnsRecords } from '../packages/mistri/src/server/email/mailDns.js';
import { verifyDkim } from './support/dkimVerify.js';

/** A throwaway 1024-bit key made for this test and nothing else. */
const PEM = `-----BEGIN PRIVATE KEY-----
MIICdQIBADANBgkqhkiG9w0BAQEFAASCAl8wggJbAgEAAoGBAK4Z5Y2fYoIfTLom
DRFZ15/EXnd5bMhfYZi3jPyjO6j1ordkYnoxisM9ywNwg3cMv3viBthQHwagMI5n
r3X5w80QFGQzSZTM1bkXqJMZv1ByjDyDMGjl7nSAhyJdAFnlT8nYIHAAgfgdRoDK
Skts7WEg48igNAqrqG5F82j4gB/nAgMBAAECgYBRWzai/IUK61ducVOP9RzGwvul
9u73n2K6+6L9d8XsSYTVECrYkQgX/ms82zoDysg8Or4aHS6yaO7nzNn4VlPBXVUg
WuMAV3qtbD7+CKRmf2atL94OhlkZ4nGPyR8zKIJX4gUJpENTknyj4IfMEaog0f8T
r9InVtGKYuZejCKEkQJBANeQuqtohlgo69gWzk9mtoqvj+UbJrBdCVRYzLyr/Q83
QaQmIFyeEVCvHwNkQVyt3W4aXoYFJO0nw8stDW9cSx8CQQDOwhdahw9BFPuq4ZJN
0vY1oEQSsQ3G7dPVV5GDnal3pkrLHu99h7wNSAIpxhO/dpsT9pCn2yDz1c+VEyqW
pdo5AkBK6JpVsk7tF9tNDi/HW9QXQYbpgJPjOZFiZDFRZxrbTMJcvnsEdFFkDlbi
oNYt1KVb+4HZZLQ+TVE2q4M9rX7VAkB8nnXPBarHEmuiEnXJXIczyVZeYcMpDL3q
T+6QAt5bFKruBMZaxg4tfyJ2pUHP3CAahzmnQqd48H0+oB/CT1LZAkAKvGEdYRhv
/1LwqOKHVrOaQQwdV15m2TSHroINsBBZSlbY8UIFseHE/9KdD8LSPdCSegGqtYcq
Hjmrrfsnziah
-----END PRIVATE KEY-----
`;

const MESSAGE = [
  'From: Acme Help <help@acme.example>',
  'To: ann@example.org',
  'Subject:  Your  request\t #4 ',
  'Date: Mon, 05 Oct 2026 10:00:00 +0000',
  'Message-ID: <reply.4@acme.example>',
  'In-Reply-To: <CAF1@mail.example.org>',
  'References: <CAF1@mail.example.org>',
  '  <ticket.4@acme.example>',
  'X-Not-Signed: anything',
  '',
  'Hello  Ann, \t',
  '',
  'We are on it.',
  '',
  '',
].join('\r\n');

test('relaxed canonicalization: header names lowered, values unfolded and squeezed; trailing space and empty lines gone from the body', () => {
  assert.equal(relaxedHeader('Subject', '  Your  request\t #4 '), 'subject:Your request #4');
  assert.equal(relaxedHeader('References', ' <a@b>\r\n  <c@d>'), 'references:<a@b> <c@d>');
  assert.equal(relaxedBody('Hello  Ann, \t\r\n\r\nWe are on it.\r\n\r\n\r\n'), 'Hello Ann,\r\n\r\nWe are on it.\r\n');
  assert.equal(relaxedBody('\r\n\r\n'), '');
});

test('a known answer: the signature of a fixed message under a fixed key is pinned, and verifies apart from the signer', () => {
  const key = dkimKey('tw1', PEM);
  const signed = dkimSign(MESSAGE, key, 'Acme.Example', new Date(Date.UTC(2026, 9, 5, 10)));
  const header = signed.slice(0, signed.indexOf('\r\n'));
  const body = 'Hello Ann,\r\n\r\nWe are on it.\r\n';
  const bh = createHash('sha256').update(body).digest('base64');
  assert.equal(
    header.slice(0, header.indexOf(' b=') + 3),
    `DKIM-Signature: v=1; a=rsa-sha256; c=relaxed/relaxed; d=acme.example; s=tw1; t=1791194400; ` +
      `h=from:to:subject:date:message-id:in-reply-to:references; bh=${bh}; b=`,
  );
  assert.equal(
    header.slice(header.indexOf(' b=') + 3),
    'MNVZS8ENjzO7XJ4MdapmW4coHsew2/rkVpDcVapu5GJ3lfLO5kj1u3sjO9tujg3iLJsradP2fLPCD++5viDdOOCjOXBK07x2sDgtmWDZ7VXXObTQ6fmlzwVcOyYbhgD3CXqGx/ZONfJrtjuc/AdSiuaW2bjLeyXYIKxju/WWhIA=',
  );
  assert.equal(signed.slice(signed.indexOf('\r\n') + 2), MESSAGE, 'the message itself is unchanged under the signature');
  const record = dkimRecord(key);
  assert.match(record, /^v=DKIM1; k=rsa; p=[A-Za-z0-9+/]+=*$/);
  assert.ok(verifyDkim(signed, record).ok);
  // A changed subject or body breaks it, a header outside h= does not.
  assert.equal(verifyDkim(signed.replace('request', 'requests'), record).ok, false);
  assert.equal(verifyDkim(signed.replace('on it', 'on It'), record).bodyOk, false);
  assert.ok(verifyDkim(signed.replace('X-Not-Signed: anything', 'X-Not-Signed: else'), record).ok);
  // Whitespace a relay may add is what relaxed forgives.
  assert.ok(verifyDkim(signed.replace('We are on it.', 'We  are on it. '), record).ok);
});

test('a composed message signs and verifies; a generated key is 2048-bit and a short key is refused', () => {
  const pem = generateDkimKey();
  const key = dkimKey('tw2', pem);
  assert.equal(createPublicKey(pem).asymmetricKeyDetails?.modulusLength, 2048);
  const message = composeMail(
    {
      from: { address: 'help@acme.example', name: 'Acme Help' },
      to: ['ann@example.org'],
      subject: 'Re: printer – on fire',
      text: 'Fixed.\n\nhttps://desk.example.com/api/mail/link?token=abc',
      html: '<p>Fixed.</p>',
      messageId: '<r.9@acme.example>',
      inReplyTo: '<CAF1@mail.example.org>',
      references: ['<CAF1@mail.example.org>', '<ticket.4@acme.example>'],
    },
    new Date(Date.UTC(2026, 9, 5)),
  );
  const verdict = verifyDkim(dkimSign(message, key, 'acme.example'), dkimRecord(key));
  assert.ok(verdict.ok);
  assert.match(verdict.tags.h, /from:to:subject:date:message-id:in-reply-to:references:mime-version:content-type/);
  assert.throws(() => dkimKey('tw', 'not a key'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 512 });
  assert.throws(() => dkimKey('tw', privateKey.export({ type: 'pkcs8', format: 'pem' }) as string), /1024/);
});

test("the email service's tenant mail keys are checked when read, written back as read, and `mail-dns` prints the records", (t) => {
  const base = { name: 'mail', kind: 'email', url: 'smtp://relay.example:587', from: 'Desk <desk@tw.example>' };
  const refused = (extra: Record<string, unknown>) => () => emailConnectionOf({ ...base, ...extra }, 'mistri.json');
  assert.throws(refused({ inbound: { secret: 'written-out', domain: 'in.tw.example' } }), /environment variable/);
  assert.throws(refused({ inbound: { secret: '${X}', domain: 'In.TW.example' } }), /lower case/);
  assert.throws(refused({ inbound: { secret: '${X}', domain: 'in.tw.example', maxBytes: 10 } }), /1024/);
  assert.throws(refused({ links: { secret: '${Y}', ttl: '10 seconds' } }), /a minute to a year/);
  const full = {
    ...base,
    inbound: { secret: '${X}', domain: 'in.tw.example' },
    dkim: { selector: 'tw1', key: 'dkim.pem' },
    domains: { 'acme.example': 'acme' },
    links: { secret: '${Y}' },
    spf: '_spf.relay.example',
    returnPath: 'bounce.tw.example',
  };
  assert.deepEqual(emailEntry(emailConnectionOf(full, 'mistri.json')), full);

  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-mail-dns-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = join(directory, 'mistri.json');
  writeFileSync(config, JSON.stringify({ connections: [full] }));
  const first = mailDnsRecords(config);
  assert.equal(first.wrote, join(directory, 'dkim.pem'), 'a key is made where the config names one');
  assert.equal(statSync(first.wrote!).mode & 0o777, 0o600);
  const key = dkimKey('tw1', readFileSync(first.wrote!, 'utf8'));
  const text = first.lines.join('\n');
  assert.match(text, /bounce\.tw\.example {2}TXT {2}"v=spf1 include:_spf\.relay\.example ~all"/);
  for (const domain of ['tw.example', 'acme.example']) {
    assert.ok(text.includes(`tw1._domainkey.${domain}  TXT  "${dkimRecord(key).slice(0, 255)}"`), domain);
    assert.ok(text.includes(`_dmarc.${domain}  TXT  "v=DMARC1; p=none"`));
  }
  const second = mailDnsRecords(config);
  assert.equal(second.wrote, undefined, 'the key is kept, never replaced');
  assert.deepEqual(second.lines, first.lines);
  writeFileSync(config, JSON.stringify({ connections: [base] }));
  assert.throws(() => mailDnsRecords(config), /no "dkim"/);
});
