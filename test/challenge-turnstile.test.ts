/**
 * @mistriwork/challenge-turnstile against its local stand-in: no call leaves the machine. The verifier sends the secret,
 * the token and the visitor's address; says yes only to a success on an allowed host name and action; says no — never
 * throws — to a refusal, a wrong secret, a token past Turnstile's size, an unreachable or slow siteverify, or an answer
 * that is not JSON. And core takes it as `defineChallenges` makes it: its widget is what the stock form is served, and
 * `challengePasses` asks it with the token a door was given.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { turnstile, turnstileStub, TURNSTILE_SCRIPT_URL } from '../packs/challenge-turnstile/src/index.js';
import { challengePasses, defineChallenges } from '../packages/mistri/src/server/commands/challenges.js';

test('a person passes, anyone else does not, and siteverify is asked with the secret, token and address', async () => {
  const stub = await turnstileStub({ secret: 's3cret', people: ['person'] });
  try {
    const check = turnstile({ siteKey: 'site', secret: 's3cret', verifyUrl: stub.verifyUrl });
    assert.equal(await check.verify('person', { ip: '203.0.113.9' }), true);
    assert.equal(await check.verify('robot', { ip: '203.0.113.9' }), false);
    assert.equal(await check.verify('x'.repeat(2049), { ip: '203.0.113.9' }), false, 'past Turnstile size: not asked');
    assert.equal(await check.verify('', { ip: '203.0.113.9' }), false);
    assert.deepEqual(stub.asked, [
      { response: 'person', remoteip: '203.0.113.9', secretOk: true },
      { response: 'robot', remoteip: '203.0.113.9', secretOk: true },
    ]);
    const wrong = turnstile({ siteKey: 'site', secret: 'not it', verifyUrl: stub.verifyUrl });
    assert.equal(await wrong.verify('person', { ip: '203.0.113.9' }), false, 'a wrong secret is a no');
  } finally {
    await stub.close();
  }
});

test("a host name or an action the App did not allow is a no; by default the host is the request's own", async () => {
  const people = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'];
  const stub = await turnstileStub({ hostname: 'forms.example', action: 'apply', people });
  try {
    const base = { siteKey: 'site', secret: 'stub-secret', verifyUrl: stub.verifyUrl };
    assert.equal(await turnstile({ ...base, hostnames: ['FORMS.example'] }).verify('p1', { ip: '::1' }), true);
    assert.equal(await turnstile({ ...base, hostnames: ['other.example'] }).verify('p2', { ip: '::1' }), false);
    assert.equal(await turnstile({ ...base, action: 'apply' }).verify('p3', { ip: '::1' }), true);
    assert.equal(await turnstile({ ...base, action: 'login' }).verify('p4', { ip: '::1' }), false);
    // No host names given: the one the request was made to, so a token solved on another site is refused.
    assert.equal(await turnstile(base).verify('p5', { ip: '::1', host: 'forms.example' }), true);
    assert.equal(await turnstile(base).verify('p6', { ip: '::1', host: 'shop.example' }), false);
    // Named host names stand in for the request's: behind a proxy that rewrites the Host.
    assert.equal(await turnstile({ ...base, hostnames: ['forms.example'] }).verify('p7', { ip: '::1', host: 'app.internal' }), true);
    // The action is drawn into the stock form's widget, so the token it gives is issued for it.
    assert.equal(turnstile({ ...base, action: 'apply' }).widget?.action, 'apply');
    assert.equal(turnstile(base).widget?.action, undefined);
  } finally {
    await stub.close();
  }
});

test("a token is good once, as Cloudflare's: the stand-in answers a token it has seen timeout-or-duplicate", async () => {
  const stub = await turnstileStub();
  try {
    const check = turnstile({ siteKey: 'site', secret: 'stub-secret', verifyUrl: stub.verifyUrl });
    assert.equal(await check.verify('person', { ip: '::1' }), true);
    assert.equal(await check.verify('person', { ip: '::1' }), false, 'spent');
    // The widget's tokens are fresh each time, and carry the host name the page was on.
    assert.equal(await check.verify('person~a1~forms.example', { ip: '::1', host: 'forms.example' }), true);
    assert.equal(await check.verify('person~a1~forms.example', { ip: '::1', host: 'forms.example' }), false, 'spent');
    assert.equal(await check.verify('person~b2~elsewhere.example', { ip: '::1', host: 'forms.example' }), false, 'another site');
    assert.equal(await check.verify('robot~c3~forms.example', { ip: '::1', host: 'forms.example' }), false, 'not a person');
    const script = await (await fetch(stub.scriptUrl)).text();
    assert.match(script, /reset\(id\)/, 'the widget can be asked for a fresh token');
  } finally {
    await stub.close();
  }
});

test('unreachable, slow, failing or nonsense siteverify is a no, never a throw', async () => {
  const slow = createServer((req, res) => {
    if (req.url === '/slow') setTimeout(() => res.end('{"success":true}'), 1_000);
    else if (req.url === '/500') res.writeHead(500).end('{"success":true}');
    else res.end('<html>not json</html>');
  });
  slow.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => slow.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;
  try {
    const at = (path: string, timeoutMs = 4_000) => turnstile({ siteKey: 's', secret: 's', verifyUrl: `${base}${path}`, timeoutMs });
    assert.equal(await at('/slow', 200).verify('person', { ip: '::1' }), false);
    assert.equal(await at('/500').verify('person', { ip: '::1' }), false);
    assert.equal(await at('/html').verify('person', { ip: '::1' }), false);
    assert.equal(
      await turnstile({ siteKey: 's', secret: 's', verifyUrl: 'http://127.0.0.1:1/closed' }).verify('person', { ip: '::1' }),
      false,
    );
  } finally {
    slow.closeAllConnections();
    await new Promise<void>((resolve) => slow.close(() => resolve()));
  }
});

test('core takes it as defineChallenges makes it: the widget it serves, and the door asking it', async () => {
  assert.throws(() => turnstile({ siteKey: '', secret: 'x' }), /siteKey/);
  assert.throws(() => turnstile({ siteKey: 'x', secret: '' }), /secret/);
  const stub = await turnstileStub();
  try {
    const live = defineChallenges({ verifyHuman: turnstile({ siteKey: 'public-key', secret: 'stub-secret' }) });
    assert.deepEqual(live.verifyHuman.widget, { script: TURNSTILE_SCRIPT_URL, api: 'turnstile', siteKey: 'public-key' });
    const { verifyHuman } = defineChallenges({
      verifyHuman: turnstile({ siteKey: 'public-key', secret: 'stub-secret', verifyUrl: stub.verifyUrl, scriptUrl: stub.scriptUrl }),
    });
    assert.equal(verifyHuman.widget?.script, stub.scriptUrl, "a loopback stand-in's script is taken in a test");
    assert.equal(await challengePasses(verifyHuman, 'person', { ip: '127.0.0.1' }), true);
    assert.equal(await challengePasses(verifyHuman, 'person', { ip: '127.0.0.1' }), false, 'a token is spent once');
    assert.equal(await challengePasses(verifyHuman, 'robot', { ip: '127.0.0.1' }), false);
    assert.equal(await challengePasses(verifyHuman, undefined, { ip: '127.0.0.1' }), false);
    assert.equal(await challengePasses(verifyHuman, ['person'], { ip: '127.0.0.1' }), false, 'a repeated header is no token');
    assert.throws(
      () =>
        defineChallenges({
          x: {
            verify: async () => true,
            widget: { script: 'https://cdn.example/api.js', api: 'turnstile', siteKey: 'k', action: 'not ok!' },
          },
        }),
      /action/,
    );
    // A script anywhere but https or this machine is refused when the App loads.
    assert.throws(
      () =>
        defineChallenges({
          x: { verify: async () => true, widget: { script: 'http://cdn.example/api.js', api: 'turnstile', siteKey: 'k' } },
        }),
      /https:\/\//,
    );
    const script = await (await fetch(stub.scriptUrl)).text();
    assert.match(script, /window\.turnstile/);
  } finally {
    await stub.close();
  }
});
