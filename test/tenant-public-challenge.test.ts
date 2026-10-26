/**
 * A tenant App's public forms ask the App's human check (`auth.challenge`), as an ordinary App's do, on SQLite and on
 * PostgreSQL, against the local Turnstile stand-in (packs/challenge-turnstile): the form's GET draws the widget and
 * says nothing of the verifier; a submission without a token, with a wrong one or with one already spent is refused
 * 403 before its body is read, and nothing is written in any dealer; a saved form's step asks it too; a filled decoy
 * behind a good token is answered as accepted and written nowhere. The budgets come in the ordinary host's order:
 * this visitor's first, then the check, then the ceiling every visitor shares — so tokenless requests spend their
 * own address's budget and never the one a person's submission needs.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, describe, test } from 'node:test';
import { PUBLIC_FORM_SUBMIT_TOTAL, publicFormLimiter, resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { BODY_HOLD_MS } from '../packages/mistri/src/server/commands/businessCommandHttp.js';
import { turnstile, turnstileStub, type TurnstileStub } from '../packs/challenge-turnstile/src/index.js';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import { NORTH, NORTH_HOST, openTenantPublicForms, publicFormsDatabase, SOUTH, UNKNOWN, via } from './support/tenantPublicForms.js';

const SECRET = 'stand-in-secret-never-sent';
const PEOPLE = Array.from({ length: 13 }, (_, i) => `person-${i}`);

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's public forms ask its human check (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    let stub: TurnstileStub;
    after(async () => {
      await stub?.close();
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    /* The stand-in says a person's token was solved on 127.0.0.1, the host the requests are made to. */
    const open = async (t: Parameters<typeof openTenantPublicForms>[0], extra: { trustedProxies?: readonly string[] } = {}) => {
      stub ??= await turnstileStub({ secret: SECRET, people: PEOPLE, hostname: '127.0.0.1' });
      const challenge = turnstile({ siteKey: 'yard-site-key', secret: SECRET, verifyUrl: stub.verifyUrl, scriptUrl: stub.scriptUrl });
      return openTenantPublicForms(t, dialect, database, { challenge, ...extra });
    };
    const written = async (f: Awaited<ReturnType<typeof open>>) => ({
      lead: await f.rows('SELECT tenant_id, name FROM lead ORDER BY name'),
      intake: await f.rows('SELECT name FROM intake_submission ORDER BY name'),
    });

    test('the form draws the widget, and nothing a page is sent names the verifier', async (t) => {
      const f = await open(t);
      const form = await f.call('/api/forms/apply');
      assert.equal(form.status, 200, form.text);
      assert.deepEqual(form.body.form.challenge, { script: stub.scriptUrl, api: 'turnstile', siteKey: 'yard-site-key' });
      // On a mapped host as on the shared one; the list of forms, the page and who-am-I as well.
      const mapped = await f.call('/api/forms/apply', { host: `${NORTH_HOST}:${f.port}` });
      assert.equal(mapped.status, 200, mapped.text);
      assert.equal(mapped.body.form.challenge.siteKey, 'yard-site-key');
      for (const answer of [form, mapped, await f.call('/api/forms'), await f.call('/form/apply'), await f.call('/api/whoami?app=yard')]) {
        assert.equal(answer.text.includes(SECRET), false);
        assert.equal(answer.text.includes(stub.verifyUrl), false);
      }
    });

    test('a submission with no token, a wrong one or a spent one is refused 403 and written nowhere; a good one lands', async (t) => {
      const f = await open(t);
      const submit = (query: string, token?: string, name = 'Ada') =>
        f.call(`/api/forms/apply${query}`, {
          body: { input: { name }, submission: randomUUID() },
          ...(token ? { headers: { 'x-mistri-challenge': token } } : {}),
        });
      for (const query of [via(NORTH), via(UNKNOWN), '']) {
        const bare = await submit(query);
        assert.equal(bare.status, 403, bare.text);
        assert.equal(bare.body.code, 'challenge_failed');
        const robot = await submit(query, 'robot');
        assert.equal(robot.status, 403);
        assert.equal(robot.body.code, 'challenge_failed');
        // This one address's five a minute are spent by refusals (the order is the last test's); a new minute here.
        resetPublicFormLimits();
      }
      assert.deepEqual(await written(f), { lead: [], intake: [] });
      const good = await submit(via(NORTH), 'person-1');
      assert.equal(good.status, 200, good.text);
      assert.equal(good.body.reference, 'YRD-Ada');
      // The same token again — a new submission, another dealer — is spent.
      const spent = await submit(via(SOUTH), 'person-1', 'Bea');
      assert.equal(spent.status, 403);
      assert.equal(spent.body.code, 'challenge_failed');
      assert.deepEqual(await written(f), { lead: [{ tenant_id: 'north', name: 'Ada' }], intake: [] });
      // Asked of the stand-in with the secret, the visitor's address beside it.
      assert.ok(stub.asked.length >= 5);
      assert.ok(stub.asked.every((ask) => ask.secretOk && ask.remoteip === '127.0.0.1'));
      // A token solved on another site is refused here.
      const elsewhere = await submit(via(NORTH), 'person-0~x~elsewhere.example', 'Cy');
      assert.equal(elsewhere.status, 403);
      assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Ada' }]);
    });

    test("a saved form's step asks it before a draft opens, and a filled decoy is answered as accepted and kept nowhere", async (t) => {
      const f = await open(t);
      const step = (token?: string) =>
        f.call(`/api/forms/draft/steps/name${via(NORTH)}`, {
          body: { input: { name: 'Dee' }, submission: randomUUID() },
          ...(token ? { headers: { 'x-mistri-challenge': token } } : {}),
        });
      const bare = await step();
      assert.equal(bare.status, 403);
      assert.equal(bare.body.code, 'challenge_failed');
      assert.deepEqual(await written(f), { lead: [], intake: [] });
      const proven = await step('person-3');
      assert.equal(proven.status, 200, proven.text);
      assert.deepEqual(proven.body, { saved: 'name' });
      assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Dee' }]);
      const decoy = await f.call(`/api/forms/apply${via(NORTH)}`, {
        body: { input: { name: 'Bot' }, submission: randomUUID(), trap: 'https://spam.example' },
        headers: { 'x-mistri-challenge': 'person-4' },
      });
      assert.equal(decoy.status, 200, decoy.text);
      assert.deepEqual(Object.keys(decoy.body).sort(), ['receipt', 'reference']);
      assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Dee' }]);
    });

    test("tokenless requests spend their own address's budget, never the ceiling a person's submission needs", async (t) => {
      const f = await open(t);
      const submit = (token?: string) =>
        f.call(`/api/forms/apply${via(NORTH)}`, {
          body: { input: { name: 'Eve' }, submission: randomUUID() },
          ...(token ? { headers: { 'x-mistri-challenge': token } } : {}),
        });
      // One address: its five a minute are spent by refusals, and the sixth is told so before the check is asked.
      for (let i = 0; i < 5; i++) assert.equal((await submit()).status, 403);
      const asked = stub.asked.length;
      const limited = await submit('person-5');
      assert.equal(limited.status, 429);
      assert.match(limited.body.error, /from this address/);
      assert.equal(stub.asked.length, asked, 'a request over its own budget never costs a call to the provider');
      // The ceiling every visitor shares, all but one of it spent by others' accepted submissions.
      resetPublicFormLimits();
      const total = publicFormLimiter('submit');
      for (let i = 0; i < PUBLIC_FORM_SUBMIT_TOTAL[0].limit - 1; i++) assert.equal((await total.take(`other-${i}`, 'all')).ok, true);
      // Refusals at the check leave that one alone, so a person's submission is taken; the next proven one is not.
      for (let i = 0; i < 3; i++) assert.equal((await submit()).status, 403);
      const person = await submit('person-6');
      assert.equal(person.status, 200, person.text);
      const over = await submit('person-7');
      assert.equal(over.status, 429);
      assert.match(over.body.error, /taking too many requests/);
      assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Eve' }]);
    });

    test('a chunked body past 64 KB is refused 413 before the check is asked; a chunked one inside it is read as sent', async (t) => {
      const f = await open(t);
      const asked = stub.asked.length;
      const huge = await f.call(`/api/forms/apply${via(NORTH)}`, {
        body: { input: { name: 'Hal' }, submission: randomUUID(), pad: 'x'.repeat(70_000) },
        headers: { 'x-mistri-challenge': 'person-2' },
        chunked: true,
      });
      assert.equal(huge.status, 413, huge.text);
      assert.equal(huge.body.code, 'too_large');
      assert.equal(stub.asked.length, asked, 'a body past the envelope never costs a call to the provider');
      const small = await f.call(`/api/forms/apply${via(NORTH)}`, {
        body: { input: { name: 'Ivy' }, submission: randomUUID() },
        headers: { 'x-mistri-challenge': 'person-2' },
        chunked: true,
      });
      assert.equal(small.status, 200, small.text);
      assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Ivy' }]);
    });

    test(
      'a body trickled past the hold deadline is answered 408 on the link and the mapped host, before the check is asked',
      { skip: dialect !== 'sqlite' && 'the hold reads the socket, not the database', timeout: 30_000 },
      async (t) => {
        const f = await open(t);
        const asked = stub.asked.length;
        const trickled = async (path: string, host?: string) => {
          const started = Date.now();
          const answer = await f.call(path, {
            body: { input: { name: 'Jo' }, submission: randomUUID() },
            headers: { 'x-mistri-challenge': 'person-12' },
            host,
            trickle: true,
          });
          return { answer, took: Date.now() - started };
        };
        const answers = await Promise.all([
          trickled(`/api/forms/apply${via(NORTH)}`),
          trickled('/api/forms/apply', `${NORTH_HOST}:${f.port}`),
        ]);
        for (const { answer, took } of answers) {
          assert.equal(answer.status, 408, answer.text);
          assert.equal(answer.body.code, 'too_slow');
          assert.equal(answer.headers.connection, 'close');
          assert.ok(took >= BODY_HOLD_MS - 50 && took < BODY_HOLD_MS + 2_000, `answered after ${took} ms`);
        }
        assert.equal(stub.asked.length, asked, 'a body that never finished arriving never costs a call to the provider');
        // A body sent whole is read as sent, on the same server, after the trickles were dropped.
        const whole = await f.call(`/api/forms/apply${via(NORTH)}`, {
          body: { input: { name: 'Kit' }, submission: randomUUID() },
          headers: { 'x-mistri-challenge': 'person-12' },
        });
        assert.equal(whole.status, 200, whole.text);
        assert.deepEqual((await written(f)).lead, [{ tenant_id: 'north', name: 'Kit' }]);
      },
    );

    /* The test's socket is loopback, so the proxy on another host is the last hop it appends (http-forms.test.ts). */
    const behindProxy = (f: Awaited<ReturnType<typeof open>>, client: string, token?: string) =>
      f.call(`/api/forms/apply${via(NORTH)}`, {
        body: { input: { name: 'Gil' }, submission: randomUUID() },
        headers: { 'x-forwarded-for': `198.51.100.99, ${client}, 10.0.0.5`, ...(token ? { 'x-mistri-challenge': token } : {}) },
      });

    test('without --trust-proxy, every visitor behind a proxy on another host is that proxy, and shares its budget', async (t) => {
      const f = await open(t);
      for (let i = 0; i < 5; i++) assert.equal((await behindProxy(f, `203.0.113.${i + 1}`)).status, 403);
      assert.equal((await behindProxy(f, '203.0.113.9', 'person-8')).status, 429);
    });

    test('behind a proxy --trust-proxy names, each visitor has its own budget and the check is told its address', async (t) => {
      const from = behindProxy;
      const trusting = await open(t, { trustedProxies: ['10.0.0.0/8'] });
      for (let i = 0; i < 5; i++) assert.equal((await from(trusting, '203.0.113.7')).status, 403);
      const limited = await from(trusting, '203.0.113.7', 'person-9');
      assert.equal(limited.status, 429);
      assert.match(limited.body.error, /from this address/);
      const other = await from(trusting, '203.0.113.8', 'person-10');
      assert.equal(other.status, 200, other.text);
      assert.equal(stub.asked.at(-1)?.remoteip, '203.0.113.8');
    });

    test('a key that names no form is answered 404 before the check and the shared ceiling, so it spends neither', async (t) => {
      const f = await open(t);
      const total = publicFormLimiter('submit');
      for (let i = 0; i < PUBLIC_FORM_SUBMIT_TOTAL[0].limit - 1; i++) assert.equal((await total.take(`other-${i}`, 'all')).ok, true);
      const asked = stub.asked.length;
      for (let i = 0; i < 4; i++) {
        const missing = await f.call(`/api/forms/no-such-${i}${via(NORTH)}`, {
          body: { input: { name: 'X' }, submission: randomUUID() },
          headers: { 'x-mistri-challenge': `person-${8 + i}` },
        });
        assert.equal(missing.status, 404, missing.text);
        assert.equal(missing.body.code, 'no_such_form');
      }
      assert.equal(stub.asked.length, asked, 'a key that names no form never costs a call to the provider');
      const person = await f.call(`/api/forms/apply${via(NORTH)}`, {
        body: { input: { name: 'Fay' }, submission: randomUUID() },
        headers: { 'x-mistri-challenge': 'person-11' },
      });
      assert.equal(person.status, 200, person.text);
    });
  });
}
