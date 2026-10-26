/**
 * An inbound message's words (packages/mistri/src/server/email/mailText.ts) and its reading
 * (packages/mistri/src/server/email/inboundMail.ts): quoted history cut from a reply, HTML
 * through the rich text sanitizer, the address routed to a tenant, and the
 * noise a desk must never answer told apart.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inboundWords, trimQuoted } from '../packages/mistri/src/server/email/mailText.js';
import { InboundRefusal, noiseOf, readInbound, routeAddress } from '../packages/mistri/src/server/email/inboundMail.js';

test('a reply keeps what its sender wrote: Gmail, Outlook and > quotes cut; a quote-only message kept whole', () => {
  assert.equal(
    trimQuoted('Thanks, fixed now.\n\nOn Mon, 5 Oct 2026 at 10:00, Acme Help <help@acme.example> wrote:\n> Is it fixed?'),
    'Thanks, fixed now.',
  );
  assert.equal(
    trimQuoted('Still broken.\r\nOn Mon, 5 Oct 2026 at 10:00, Acme\r\nHelp <help@acme.example> wrote:\r\n> earlier'),
    'Still broken.',
  );
  assert.equal(
    trimQuoted(
      'See attached.\n\n________________________________\nFrom: Acme Help <help@acme.example>\nSent: Monday\nSubject: Re: x\n\nearlier',
    ),
    'See attached.',
  );
  assert.equal(trimQuoted('Yes.\n-----Original Message-----\nFrom: x'), 'Yes.');
  assert.equal(trimQuoted('Top\n> quoted line\nmore'), 'Top\nmore');
  assert.equal(trimQuoted('> only a quote\n> nothing else'), '> only a quote\n> nothing else');
  assert.equal(trimQuoted('On the whole, it works.'), 'On the whole, it works.', 'a sentence starting "On" is not a quote header');
});

test("HTML is sanitized and cut at the client's quote; text comes from it when none was sent", () => {
  const words = inboundWords({
    html: '<p onclick="x()">Fixed <b>now</b><script>alert(1)</script></p><div class="gmail_quote">On Mon … wrote:<blockquote>old</blockquote></div>',
  });
  assert.doesNotMatch(words.html, /script|onclick|gmail_quote|old/);
  assert.match(words.html, /Fixed/);
  assert.equal(words.text.trim(), 'Fixed now');
  assert.deepEqual(inboundWords({ text: 'Plain.\n\nOn x wrote:\n> y', html: null }), { text: 'Plain.', html: '' });
  // An HTML message that is only the quote is kept, not emptied.
  assert.match(inboundWords({ html: '<blockquote type="cite">all of it</blockquote>' }).html, /all of it/);
});

const routing = { domain: 'in.example.com', domains: { 'acme.example': 'acme' } };

test("addresses route by plus-address on the routing domain, or by a tenant's own domain; anything else is no one's", () => {
  assert.deepEqual(routeAddress('Help+acme@in.example.com', routing), { tenant: 'acme', mailbox: 'help' });
  assert.deepEqual(routeAddress('help@ACME.example', routing), { tenant: 'acme', mailbox: 'help' });
  assert.equal(routeAddress('help@in.example.com', routing), undefined);
  assert.equal(routeAddress('help+../x@in.example.com', routing), undefined);
  assert.equal(routeAddress('help@other.example', routing), undefined);
  assert.equal(routeAddress('help@constructor', { domain: 'in.example.com', domains: {} }), undefined);
});

test('a delivery is read field by field, its size bounded, and noise told apart', () => {
  const base = { recipient: 'help+acme@in.example.com', from: 'Ann Lee <Ann@Example.org>', messageId: '<a@b>', subject: 'Hi\r\nBcc: x' };
  const read = readInbound(
    { ...base, to: 'Acme <help@acme.example>, "Lee, B" <b@example.org>', references: '<x@y> junk <z@w>' },
    routing,
    1000,
  );
  assert.deepEqual(read.from, { address: 'ann@example.org', name: 'Ann Lee' });
  assert.equal(read.to.length, 2);
  assert.equal(read.subject, 'Hi Bcc: x');
  assert.deepEqual(read.references, ['<x@y>', '<z@w>']);
  const refusal = (body: unknown, max = 1000) => {
    try {
      readInbound(body, routing, max);
    } catch (error) {
      assert.ok(error instanceof InboundRefusal);
      return error.status;
    }
    return 0;
  };
  assert.equal(refusal({ ...base, recipient: 'help+acme@elsewhere.example' }), 404);
  assert.equal(refusal({ ...base, messageId: 'none' }), 400);
  assert.equal(refusal({ ...base, attachments: [{ name: 'a', content: 'not base64!' }] }), 400);
  assert.equal(
    refusal({ ...base, attachments: [{ name: 'a', content: Buffer.alloc(600).toString('base64') }], text: 'x'.repeat(500) }),
    413,
  );
  const own = (address: string) => address.endsWith('@in.example.com');
  assert.equal(noiseOf({ from: { address: 'a@b.c' }, headers: { 'auto-submitted': 'auto-replied' } }, own), 'Auto-Submitted: auto-replied');
  assert.equal(noiseOf({ from: { address: 'a@b.c' }, headers: { 'auto-submitted': 'no' } }, own), undefined);
  assert.equal(noiseOf({ from: { address: 'a@b.c' }, headers: { precedence: 'Bulk' } }, own), 'Precedence: bulk');
  assert.equal(noiseOf({ from: { address: 'mailer-daemon@b.c' }, headers: {} }, own), 'a bounce');
  assert.match(noiseOf({ from: { address: 'help+acme@in.example.com' }, headers: {} }, own)!, /own sending address/);
});
