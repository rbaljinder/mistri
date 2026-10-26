/**
 * The fixed-window limiter behind the public forms: windows roll over,
 * addresses are independent, the wait is told in whole seconds, and the
 * address is the socket's peer unless that peer is a proxy on this machine,
 * whose appended X-Forwarded-For hop then names the client. And bounded:
 * a hard cap on tracked clients at a flat cost per new one, an IPv6 client
 * counted as its /64, and a ceiling across every client together.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  clientAddress,
  FixedWindowLimiter,
  INVITATION_CLAIM_TOTAL,
  INVITATION_CLAIM_WINDOWS,
  invitationClaimLimiter,
  limitKey,
  PUBLIC_FORM_READ_WINDOWS,
  PUBLIC_FORM_SUBMIT_TOTAL,
  PUBLIC_FORM_SUBMIT_WINDOWS,
  publicFormLimiter,
  resetPublicFormLimits,
} from '../packages/engine/src/server/http/rateLimit.js';

describe('FixedWindowLimiter', () => {
  test('admits up to the limit in a window, then refuses with the seconds until it rolls over', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter([{ limit: 3, ms: 60_000 }], () => now);
    assert.deepEqual(limiter.take('a'), { ok: true, remaining: 2 });
    assert.deepEqual(limiter.take('a'), { ok: true, remaining: 1 });
    assert.deepEqual(limiter.take('a'), { ok: true, remaining: 0 });
    now += 15_000;
    assert.deepEqual(limiter.take('a'), { ok: false, retryAfterSeconds: 45, scope: 'client' });
    // A refused request does not count against the window.
    now += 44_500;
    assert.deepEqual(limiter.take('a'), { ok: false, retryAfterSeconds: 1, scope: 'client' });
    now += 500;
    assert.deepEqual(limiter.take('a'), { ok: true, remaining: 2 });
  });

  test('addresses are independent', () => {
    const limiter = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => 5_000);
    assert.equal(limiter.take('a').ok, true);
    assert.equal(limiter.take('a').ok, false);
    assert.equal(limiter.take('b').ok, true);
    limiter.reset();
    assert.equal(limiter.take('a').ok, true);
  });

  test('the longest exceeded window decides the wait', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(
      [
        { limit: 2, ms: 60_000 },
        { limit: 3, ms: 3_600_000 },
      ],
      () => now,
    );
    limiter.take('a');
    limiter.take('a');
    assert.deepEqual(limiter.take('a'), { ok: false, retryAfterSeconds: 60, scope: 'client' });
    now = 60_000;
    assert.deepEqual(limiter.take('a'), { ok: true, remaining: 0 });
    now = 120_000;
    assert.deepEqual(limiter.take('a'), { ok: false, retryAfterSeconds: 3_480, scope: 'client' });
  });

  test('the public form defaults are five a minute and thirty an hour, three hundred an hour in all, and sixty reads a minute', () => {
    assert.deepEqual(PUBLIC_FORM_SUBMIT_WINDOWS, [
      { limit: 5, ms: 60_000 },
      { limit: 30, ms: 3_600_000 },
    ]);
    assert.deepEqual(PUBLIC_FORM_SUBMIT_TOTAL, [{ limit: 300, ms: 3_600_000 }]);
    assert.deepEqual(PUBLIC_FORM_READ_WINDOWS, [{ limit: 60, ms: 60_000 }]);
  });

  test('an invitation claim is shaped like a submission and counted in a budget of its own', async () => {
    /* One busy public form must not spend the claims a tenant's new staff can
       make, nor the other way about: same windows, separate buckets. */
    resetPublicFormLimits();
    try {
      assert.deepEqual(INVITATION_CLAIM_WINDOWS, PUBLIC_FORM_SUBMIT_WINDOWS);
      assert.deepEqual(INVITATION_CLAIM_TOTAL, PUBLIC_FORM_SUBMIT_TOTAL);
      const forms = publicFormLimiter('submit'),
        claims = invitationClaimLimiter();
      assert.notEqual(forms, claims);
      for (let spent = 0; spent < 5; spent++) assert.equal((await forms.take('198.51.100.20')).ok, true);
      assert.equal((await forms.take('198.51.100.20')).ok, false, 'the form budget is spent');
      for (let spent = 0; spent < 5; spent++) {
        assert.equal((await claims.take('198.51.100.20')).ok, true, 'the claim budget is untouched');
      }
      assert.equal((await claims.take('198.51.100.20')).ok, false);
      assert.equal((await publicFormLimiter('read').take('198.51.100.20')).ok, true, 'reads keep their own budget too');
      // And a spent claim budget leaves the form's next submission alone.
      resetPublicFormLimits();
      for (let spent = 0; spent < 5; spent++) assert.equal((await claims.take('198.51.100.21')).ok, true);
      assert.equal((await claims.take('198.51.100.21')).ok, false);
      assert.equal((await forms.take('198.51.100.21')).ok, true);
    } finally {
      resetPublicFormLimits();
    }
  });

  const via = (peer: string, forwarded?: string | string[]) =>
    clientAddress({ socket: { remoteAddress: peer }, headers: forwarded === undefined ? {} : { 'x-forwarded-for': forwarded } } as never);

  test('without a forwarded header the address is the socket peer', () => {
    assert.equal(clientAddress({ socket: { remoteAddress: '10.0.0.7' } } as never), '10.0.0.7');
    assert.equal(clientAddress({ socket: {} } as never), 'unknown');
    assert.equal(via('127.0.0.1'), '127.0.0.1');
  });

  test('behind a proxy on this machine, two forwarded clients are two buckets', () => {
    const limiter = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => 0);
    assert.equal(limiter.take(via('127.0.0.1', '203.0.113.7')).ok, true);
    assert.equal(limiter.take(via('127.0.0.1', '203.0.113.8')).ok, true);
    assert.equal(limiter.take(via('::1', '203.0.113.7')).ok, false);
    // The hop the proxy appended decides; what the client wrote to its left cannot split it.
    assert.equal(via('127.0.0.1', '198.51.100.1, 203.0.113.7'), '203.0.113.7');
    assert.equal(via('::ffff:127.0.0.1', '203.0.113.7, 127.0.0.1'), '203.0.113.7', 'a second local hop is skipped');
    assert.equal(via('127.0.0.1', ['198.51.100.1', '2001:DB8::1']), '2001:db8::1');
    assert.equal(via('127.0.0.1', '127.0.0.1, ::1'), '127.0.0.1', 'every hop local: the peer');
  });

  test('from an untrusted peer a forwarded header is not read: one bucket, keyed by the peer', () => {
    const limiter = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => 0);
    assert.equal(via('10.0.0.7', '203.0.113.7'), '10.0.0.7');
    assert.equal(limiter.take(via('10.0.0.7', '203.0.113.7')).ok, true);
    assert.equal(limiter.take(via('10.0.0.7', '203.0.113.8')).ok, false);
    assert.equal(via('192.0.2.1', '127.0.0.1'), '192.0.2.1');
  });

  test('a malformed forwarded header is ignored whole: the peer', () => {
    for (const header of [
      '',
      ' ',
      'unknown',
      'not-an-address',
      '203.0.113.7:4431',
      '[2001:db8::1]',
      '203.0.113.7,,198.51.100.1',
      '198.51.100.1, 203.0.113.7 extra',
      '203.0.113.7, <script>',
      Array.from({ length: 33 }, () => '203.0.113.7').join(','),
    ]) {
      assert.equal(via('127.0.0.1', header), '127.0.0.1', JSON.stringify(header));
    }
  });

  test('an IPv6 client is its /64; an IPv4-mapped address is the IPv4 address', () => {
    assert.equal(limitKey('2001:db8:1:1::1'), '2001:db8:1:1::/64');
    assert.equal(limitKey('2001:0DB8:0001:0001:ffff:0:0:9'), '2001:db8:1:1::/64');
    assert.equal(limitKey('2001:db8::1'), '2001:db8:0:0::/64');
    assert.equal(limitKey('fe80::1%eth0'), 'fe80:0:0:0::/64');
    assert.equal(limitKey('::ffff:192.0.2.1'), '192.0.2.1');
    assert.equal(limitKey('::FFFF:c000:0201'), '192.0.2.1');
    assert.equal(limitKey('192.0.2.1'), '192.0.2.1');
    assert.equal(limitKey('unknown'), 'unknown');
    assert.equal(limitKey('not:an:address'), 'not:an:address');
    const limiter = new FixedWindowLimiter([{ limit: 5, ms: 60_000 }], () => 0);
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (limiter.take(`2001:db8:1:1::${i.toString(16)}`).ok) admitted++;
    assert.equal(admitted, 5, 'a hundred addresses in one /64 share five');
    assert.equal(limiter.take('2001:db8:1:2::1').ok, true, 'the next /64 is another client');
    // A dual-stack socket reports an IPv4 peer mapped; it is the same client as the bare address.
    const mapped = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => 0);
    assert.equal(mapped.take('::ffff:198.51.100.4').ok, true);
    assert.equal(mapped.take('198.51.100.4').ok, false);
  });

  test('the tracked clients never exceed the cap, at a flat cost per new client', () => {
    let now = 1_000_000;
    const limiter = new FixedWindowLimiter(PUBLIC_FORM_SUBMIT_WINDOWS, () => now, { maxClients: 10_000 });
    const started = performance.now();
    let largest = 0;
    for (let i = 0; i < 50_000; i++) {
      limiter.take(`2001:db8:${(i >> 16).toString(16)}:${(i & 0xffff).toString(16)}::1`);
      now += 1;
      largest = Math.max(largest, limiter.size);
    }
    const elapsed = performance.now() - started;
    assert.equal(largest, 10_000);
    // The first version scanned every client per new one past its cap: 21 s at 40,000.
    assert.ok(elapsed < 2_000, `50,000 new clients took ${Math.round(elapsed)} ms`);
  });

  test('full of live budgets, a submit limiter refuses a newcomer rather than forget what a client spent', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => now, { maxClients: 2 });
    assert.equal(limiter.take('a').ok, true);
    now = 10_000;
    assert.equal(limiter.take('b').ok, true);
    now = 20_000;
    // 'a' was seen at 0 and is live until 60 s: the newcomer waits for that slot.
    assert.deepEqual(limiter.take('c'), { ok: false, retryAfterSeconds: 40, scope: 'all' });
    assert.equal(limiter.size, 2);
    assert.equal(limiter.take('a').ok, false, "'a' keeps its spent budget");
    // Seen again at 20 s, 'a' is now the freshest; 'b' is the stalest and expires at 70 s.
    now = 70_000;
    assert.equal(limiter.take('c').ok, true, "'b' expired on its own, and 'c' takes its slot");
    assert.deepEqual(
      limiter.take('b'),
      { ok: false, retryAfterSeconds: 10, scope: 'all' },
      "'b' is a newcomer now; 'a' is live until 80 s",
    );
  });

  test('a read limiter evicts the least recently seen client instead', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter([{ limit: 1, ms: 60_000 }], () => now, { maxClients: 2, whenFull: 'evict' });
    limiter.take('a');
    now = 1;
    limiter.take('b');
    now = 2;
    assert.equal(limiter.take('a').ok, false, "touching 'a' makes 'b' the stalest");
    assert.equal(limiter.take('c').ok, true);
    assert.equal(limiter.size, 2);
    assert.equal(limiter.take('a').ok, false, "'a' was kept");
    assert.equal(limiter.take('b').ok, true, "'b' was evicted, and forgotten");
  });

  test('expiry still works: a client idle past the longest window is forgotten, a live one is not', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter(
      [
        { limit: 1, ms: 60_000 },
        { limit: 2, ms: 3_600_000 },
      ],
      () => now,
    );
    limiter.take('a');
    now = 1_000;
    limiter.take('b');
    now = 3_600_000;
    limiter.take('c');
    assert.equal(limiter.size, 2, "'a', last seen an hour ago, is swept; 'b' is not yet");
    now = 3_601_000;
    limiter.take('c');
    assert.equal(limiter.size, 1);
    assert.equal(limiter.take('b').ok, true);
  });

  test('a ceiling across every client holds however many addresses take turns', () => {
    let now = 0;
    const limiter = new FixedWindowLimiter([{ limit: 5, ms: 60_000 }], () => now, { total: [{ limit: 10, ms: 3_600_000 }] });
    let admitted = 0;
    for (let i = 0; i < 100; i++) if (limiter.take(`198.51.100.${i}`).ok) admitted++;
    assert.equal(admitted, 10);
    assert.deepEqual(limiter.take('203.0.113.1'), { ok: false, retryAfterSeconds: 3_600, scope: 'all' });
    // A refusal by the client's own window spends nothing of the shared one.
    limiter.reset();
    for (let i = 0; i < 7; i++) limiter.take('192.0.2.1');
    for (let i = 0; i < 5; i++) assert.equal(limiter.take(`198.51.100.${i}`).ok, true);
    assert.equal(limiter.take('198.51.100.9').ok, false);
    now = 3_600_000;
    assert.equal(limiter.take('198.51.100.9').ok, true, 'the shared window rolls over');
    assert.equal(publicFormLimiter('submit') instanceof FixedWindowLimiter, true);
  });

  test("a door that proves its caller spends the client's part first and the ceiling only once the proof passes", () => {
    const limiter = new FixedWindowLimiter([{ limit: 2, ms: 60_000 }], () => 0, { total: [{ limit: 3, ms: 3_600_000 }] });
    // Many addresses that never prove anything: each spends its own window, none the shared one.
    for (let i = 0; i < 50; i++) assert.equal(limiter.take(`198.51.100.${i}`, 'client').ok, true);
    for (let i = 0; i < 3; i++) assert.equal(limiter.take(`203.0.113.${i}`, 'all').ok, true);
    assert.deepEqual(limiter.take('203.0.113.9', 'all'), { ok: false, retryAfterSeconds: 3_600, scope: 'all' });
    // The client's part still refuses past its own window, whatever the ceiling says.
    limiter.reset();
    limiter.take('192.0.2.1', 'client');
    limiter.take('192.0.2.1', 'client');
    assert.equal(limiter.take('192.0.2.1', 'client').ok, false);
    assert.equal(limiter.take('192.0.2.1', 'all').ok, true, 'the ceiling is its own part');
  });

  test('refuses a window without a positive limit and span', () => {
    assert.throws(() => new FixedWindowLimiter([]));
    assert.throws(() => new FixedWindowLimiter([{ limit: 0, ms: 1 }]));
    assert.throws(() => new FixedWindowLimiter([{ limit: 1, ms: 1 }], Date.now, { total: [] }));
    assert.throws(() => new FixedWindowLimiter([{ limit: 1, ms: 1 }], Date.now, { maxClients: 0 }));
  });
});
