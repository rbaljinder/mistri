/**
 * A tenant App's saved form answers its status check, on SQLite and on PostgreSQL, in the place the request lands in:
 * north's intake address (`?via=`) or north's mapped host reads north's applications, south's address south's, and an
 * address that places nobody the platform's. Each place holds an application under the same reference, so an answer
 * from the wrong place would show.
 *
 * What is proved: the right details answer the right application; wrong details, a reference only another place
 * holds, and a locked receipt are one answer. A receipt's lockout is its place's: five wrong guesses at north's lock
 * north's, and south's same reference still answers. The step-up's code goes to the application's own address in its
 * place, and the session it opens is that place's alone: replayed under another dealer's address, or on north's
 * mapped host from south's, it has ended.
 *
 * On a channel (`stepUp: { sms: 'mobile', show }`): the code goes to the stored number through the
 * integration that declares the channel, under the tenant's own secrets, and nowhere else; a tenant whose channel is not
 * set up gets the same answer and nothing is sent. The session opens `show`, never the column the code went to.
 * Sends are capped, and a capped ask is told what a sent one is: five codes an hour to one number however many
 * applications name it (written any way), a tenant's texts at its hourly cap, and one client's asks at its own.
 */
import assert from 'node:assert/strict';
import { after, describe, test } from 'node:test';
import { resetPublicFormLimits } from '../packages/engine/src/server/http/rateLimit.js';
import { codeCapsForTests, resetOneTimeCodes } from '../packages/mistri/src/server/forms/oneTimeCode.js';
import { refusalReasons } from '../packages/engine/src/shared/refusal.js';
import { resetStatusLockouts } from '../packages/mistri/src/server/forms/statusCheck.js';
import { resetStepUpSessions } from '../packages/mistri/src/server/forms/statusStepUp.js';
import { integrationRuntimeOf, saveIntegrationSettings } from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { provider, resetProvider } from './fixtures/integrations/fakepay/index.js';
import { dropDedicatedPostgresDatabase, TENANT_DIALECTS } from './support/tenantDialects.js';
import {
  NORTH,
  NORTH_HOST,
  openTenantPublicForms,
  publicFormsDatabase,
  SOUTH,
  UNKNOWN,
  via,
  type Answer,
  type TenantPublicForms,
} from './support/tenantPublicForms.js';

const RECEIPT = 'YRD-1';
const codeIn = (message: { text: string } | undefined) => /\b(\d{6})\b/.exec(message?.text ?? '')?.[1];
const settled = () => new Promise((resolve) => setTimeout(resolve, 50));
/* A channel's send reads consent and secrets from the integrations store first: wait for it, or a while for nothing. */
async function texted(count: number, waitMs = 2_000) {
  for (const until = Date.now() + waitMs; provider.texts.length < count && Date.now() < until;) await settled();
  return provider.texts;
}

for (const { dialect, skip } of TENANT_DIALECTS) {
  describe(`a tenant App's status check answers in its own place (${dialect})`, { skip }, () => {
    const database = publicFormsDatabase();
    after(async () => {
      if (dialect === 'postgres') await dropDedicatedPostgresDatabase(database);
    });
    const open = async (t: Parameters<typeof openTenantPublicForms>[0], statusCheck: true | 'sms' = true) => {
      resetStatusLockouts();
      resetOneTimeCodes();
      resetStepUpSessions();
      t.after(() => {
        resetStatusLockouts();
        resetOneTimeCodes();
        resetStepUpSessions();
      });
      const f = await openTenantPublicForms(t, dialect, database, { statusCheck });
      // The same reference in each place: north's, south's and the platform's, each with its own name and address.
      await f.engine.exec(
        `INSERT INTO lead (id, tenant_id, reference, name, status, email, mobile, more) VALUES
          ('n1', 'north', '${RECEIPT}', 'Ada', 'reviewing', 'ada@example.test', '+1 (555) 010-0001', 'North detail'),
          ('s1', 'south', '${RECEIPT}', 'Bea', 'approved', 'bea@example.test', '+1 (555) 010-0002', 'South detail')`,
      );
      await f.engine.exec(
        `INSERT INTO intake_submission (id, reference, name, status, email, more)
          VALUES ('p1', '${RECEIPT}', 'Pat', 'submitted', 'pat@example.test', 'Platform detail')`,
      );
      return f;
    };
    const post = (f: TenantPublicForms, path: string, query: string, body: unknown, init: { host?: string; cookie?: string } = {}) =>
      f.call(`/api/forms/draft/${path}${query}`, {
        body,
        ...(init.host ? { host: `${init.host}:${f.port}` } : {}),
        ...(init.cookie ? { headers: { cookie: init.cookie } } : {}),
      });
    const check = (f: TenantPublicForms, query: string, name: string, host?: string) =>
      post(f, 'status', query, { receipt: RECEIPT, confirm: { name } }, host ? { host } : {});
    const cookieOf = (answer: Answer) => {
      const line = ([] as string[]).concat(answer.headers['set-cookie'] ?? []).find((value) => value.startsWith('mistri_stepup_draft='));
      return line?.split(';')[0];
    };

    test('the right details answer the application of the place the request lands in', async (t) => {
      const f = await open(t);
      const north = await check(f, via(NORTH), 'Ada');
      assert.equal(north.status, 200, north.text);
      assert.deepEqual(north.body, { status: { status: 'reviewing' } });
      resetPublicFormLimits();
      const south = await check(f, via(SOUTH), 'Bea');
      assert.equal(south.status, 200, south.text);
      assert.deepEqual(south.body, { status: { status: 'approved' } });
      const host = await check(f, '', 'Ada', NORTH_HOST);
      assert.deepEqual(host.body, { status: { status: 'reviewing' } }, "north's mapped host is north's place");
      resetPublicFormLimits();
      const platform = await check(f, via(UNKNOWN), 'Pat');
      assert.deepEqual(platform.body, { status: { status: 'submitted' } }, 'an address that places nobody reads the platform');
    });

    test("wrong details and another place's application are one answer", async (t) => {
      const f = await open(t);
      const wrong = await check(f, via(NORTH), 'Byron');
      assert.equal(wrong.status, 404, wrong.text);
      // South's own application, named at north's door: not found, word for word as the wrong guess.
      const elsewhere = await check(f, via(NORTH), 'Bea');
      assert.equal(elsewhere.status, 404);
      assert.deepEqual(elsewhere.body, wrong.body);
      const missing = await post(f, 'status', via(NORTH), { receipt: 'YRD-404', confirm: { name: 'Ada' } });
      assert.equal(missing.status, 404);
      assert.deepEqual(missing.body, wrong.body);
      assert.doesNotMatch(JSON.stringify([wrong.body, elsewhere.body, missing.body]), /Bea|approved|south/i);
    });

    test("a receipt's lockout is its place's: north's guesses do not lock south's same reference", async (t) => {
      const f = await open(t);
      for (let attempt = 0; attempt < 5; attempt++) {
        resetPublicFormLimits();
        assert.equal((await check(f, via(NORTH), 'Byron')).status, 404);
      }
      resetPublicFormLimits();
      const wrong = await check(f, via(NORTH), 'Byron');
      const locked = await check(f, via(NORTH), 'Ada');
      assert.equal(locked.status, 404, 'the right answer after the lock is refused');
      assert.deepEqual(locked.body, wrong.body, 'and refused in the same words');
      resetPublicFormLimits();
      const south = await check(f, via(SOUTH), 'Bea');
      assert.equal(south.status, 200, south.text);
      assert.deepEqual(south.body, { status: { status: 'approved' } });
      const platform = await check(f, via(UNKNOWN), 'Pat');
      assert.equal(platform.status, 200, platform.text);
    });

    test("the step-up's code and session are the place's own, and open nowhere else", async (t) => {
      const f = await open(t);
      const asked = await post(f, 'stepup', via(NORTH), { receipt: RECEIPT, confirm: { name: 'Ada' } });
      assert.equal(asked.status, 200, asked.text);
      assert.deepEqual(asked.body, { sent: true });
      await settled();
      const [message] = f.mail();
      assert.equal(message.to, 'ada@example.test', "the code goes to north's application's address");
      const code = codeIn(message);
      assert.ok(code, 'the code is in the message');
      assert.doesNotMatch(asked.text, new RegExp(code!), 'and never in the reply');

      // North's code at south's door, with south's own details: south issued no such code.
      resetPublicFormLimits();
      const crossed = await post(f, 'stepup', via(SOUTH), { receipt: RECEIPT, confirm: { name: 'Bea' }, code });
      assert.equal(crossed.status, 404);
      assert.equal(crossed.body.code, 'code_refused');

      const opened = await post(f, 'stepup', via(NORTH), { receipt: RECEIPT, confirm: { name: 'Ada' }, code });
      assert.equal(opened.status, 200, opened.text);
      assert.deepEqual(opened.body, { status: { status: 'reviewing' }, details: { more: 'North detail' } });
      const cookie = cookieOf(opened);
      assert.ok(cookie, 'a session cookie');
      const line = ([] as string[]).concat(opened.headers['set-cookie'] ?? []).find((value) => value.startsWith('mistri_stepup_draft='))!;
      assert.match(line, /Path=\/api\/forms\/draft(;|$)/, "scoped to the form's API path");

      resetPublicFormLimits();
      const details = await post(f, 'details', via(NORTH), {}, { cookie });
      assert.equal(details.status, 200, details.text);
      assert.deepEqual(details.body, { status: { status: 'reviewing' }, details: { more: 'North detail' } });
      for (const query of [via(SOUTH), via(UNKNOWN), '']) {
        const replayed = await post(f, 'details', query, {}, { cookie });
        assert.equal(replayed.status, 404, `replayed at ${query || 'no address'}`);
        assert.equal(replayed.body.code, 'not_found');
        assert.doesNotMatch(replayed.text, /North detail/);
      }
    });

    test("a session opened on north's mapped host does not open under south's address, and one from south not on north's host", async (t) => {
      const f = await open(t);
      const opened: Record<string, string> = {};
      for (const [who, query, host, name] of [
        ['north', '', NORTH_HOST, 'Ada'],
        ['south', via(SOUTH), undefined, 'Bea'],
      ] as const) {
        resetPublicFormLimits();
        const asked = await post(f, 'stepup', query, { receipt: RECEIPT, confirm: { name } }, host ? { host } : {});
        assert.equal(asked.status, 200, asked.text);
        await settled();
        const code = codeIn(f.mail().at(-1));
        const done = await post(f, 'stepup', query, { receipt: RECEIPT, confirm: { name }, code }, host ? { host } : {});
        assert.equal(done.status, 200, done.text);
        opened[who] = cookieOf(done)!;
      }
      resetPublicFormLimits();
      assert.equal((await post(f, 'details', '', {}, { host: NORTH_HOST, cookie: opened.north })).status, 200);
      assert.equal((await post(f, 'details', via(SOUTH), {}, { cookie: opened.south })).status, 200);
      const southOnNorth = await post(f, 'details', '', {}, { host: NORTH_HOST, cookie: opened.south });
      assert.equal(southOnNorth.status, 404);
      assert.doesNotMatch(southOnNorth.text, /South detail/);
      resetPublicFormLimits();
      const northAtSouth = await post(f, 'details', via(SOUTH), {}, { cookie: opened.north });
      assert.equal(northAtSouth.status, 404);
      assert.doesNotMatch(northAtSouth.text, /North detail/);
    });

    test("a code on the sms channel goes to the stored number under the tenant's own key, and opens `show` alone", async (t) => {
      resetProvider();
      t.after(resetProvider);
      const f = await open(t, 'sms');
      const runtime = integrationRuntimeOf('yard');
      assert.ok(runtime, 'the jobs module lists FakePay, so the deployment opened its integrations');
      // North set its channel up; south has not.
      await saveIntegrationSettings(runtime, 'north', 'north-owner', {
        integration: 'fakepay',
        secrets: { apiKey: 'sk_north', webhookSecret: 'whsec_north_0123456789abcdef' },
      });

      const asked = await post(f, 'stepup', via(NORTH), { receipt: RECEIPT, confirm: { name: 'Ada' } });
      assert.equal(asked.status, 200, asked.text);
      assert.deepEqual(asked.body, { sent: true });
      const [sent] = await texted(1);
      assert.ok(sent, 'a text was sent');
      assert.equal(sent.to, '+1 (555) 010-0001', "to north's application's stored number");
      assert.equal(sent.apiKey, 'sk_north', "under north's own key");
      const code = codeIn(sent);
      assert.ok(code, 'the code is in the text');
      assert.doesNotMatch(asked.text, new RegExp(code!), 'and never in the reply');
      assert.deepEqual(f.mail(), [], 'and no email went');

      // South has no key: the same answer, word for word, and nothing sent.
      resetPublicFormLimits();
      const unset = await post(f, 'stepup', via(SOUTH), { receipt: RECEIPT, confirm: { name: 'Bea' } });
      assert.equal(unset.status, 200, unset.text);
      assert.deepEqual(unset.body, asked.body);
      assert.equal((await texted(2, 300)).length, 1, 'south sent nothing');

      const opened = await post(f, 'stepup', via(NORTH), { receipt: RECEIPT, confirm: { name: 'Ada' }, code });
      assert.equal(opened.status, 200, opened.text);
      assert.deepEqual(opened.body, { status: { status: 'reviewing' }, details: { more: 'North detail' } }, 'show, not the number');
      const cookie = cookieOf(opened);
      assert.ok(cookie, 'a session cookie');
      resetPublicFormLimits();
      const details = await post(f, 'details', via(NORTH), {}, { cookie });
      assert.deepEqual(details.body, { status: { status: 'reviewing' }, details: { more: 'North detail' } });
      assert.doesNotMatch(details.text, /555/);
      const again = await post(f, 'stepup', via(NORTH), { receipt: RECEIPT, confirm: { name: 'Ada' }, code });
      assert.equal(again.status, 404, 'a code opens once');
    });

    /* More of north's applications, each with the number given: every one a different subject, so only the send caps
       stand between them and the provider. */
    const smsOpen = async (t: Parameters<typeof openTenantPublicForms>[0], numbers: readonly string[]) => {
      resetProvider();
      t.after(resetProvider);
      const f = await open(t, 'sms');
      await saveIntegrationSettings(integrationRuntimeOf('yard')!, 'north', 'north-owner', {
        integration: 'fakepay',
        secrets: { apiKey: 'sk_north', webhookSecret: 'whsec_north_0123456789abcdef' },
      });
      const rows = numbers.map(
        (number, at) => `('m${at}', 'north', 'YRD-M${at}', 'Ada', 'reviewing', 'ada@example.test', '${number}', 'More')`,
      );
      await f.engine.exec(`INSERT INTO lead (id, tenant_id, reference, name, status, email, mobile, more) VALUES ${rows.join(', ')}`);
      const ask = async (at: number) => {
        resetPublicFormLimits();
        return await post(f, 'stepup', via(NORTH), { receipt: `YRD-M${at}`, confirm: { name: 'Ada' } });
      };
      return { f, ask };
    };

    test('codes to one number stop at five an hour however many applications name it, and the sixth answers as sent', async (t) => {
      // One number written four ways is one destination.
      const spellings = ['+1 (555) 010-0009', '+15550100009', '1-555-010-0009', '+1 555 010 0009'];
      const { ask } = await smsOpen(
        t,
        Array.from({ length: 7 }, (_, at) => spellings[at % spellings.length]),
      );
      for (let at = 0; at < 7; at++) {
        const asked = await ask(at);
        assert.equal(asked.status, 200, asked.text);
        assert.deepEqual(asked.body, { sent: true }, 'a capped ask is told what a sent one is');
      }
      assert.equal((await texted(5)).length, 5);
      assert.equal((await texted(6, 300)).length, 5, 'five texts, not seven');
    });

    test("a tenant's texts stop at its hourly cap across numbers, and one client's asks at its own", async (t) => {
      codeCapsForTests({ tenant: 2 });
      t.after(() => codeCapsForTests());
      const tenantCapped = await smsOpen(t, ['+1 555 020 0001', '+1 555 020 0002', '+1 555 020 0003']);
      for (let at = 0; at < 3; at++) assert.deepEqual((await tenantCapped.ask(at)).body, { sent: true });
      assert.equal((await texted(2)).length, 2);
      assert.equal((await texted(3, 300)).length, 2, "the tenant's third text is not sent");

      resetOneTimeCodes();
      resetProvider();
      codeCapsForTests({ client: 2 });
      for (let at = 0; at < 3; at++) assert.deepEqual((await tenantCapped.ask(at)).body, { sent: true });
      assert.equal((await texted(2)).length, 2);
      assert.equal((await texted(3, 300)).length, 2, "the client's third ask sends nothing");
    });

    test('a step-up on a channel no listed integration provides does not start', async (t) => {
      // Its integrations say what they provide (FakePay: sms). A tenant deployment refuses opaquely and records why.
      await assert.rejects(openTenantPublicForms(t, dialect, database, { statusCheck: { channel: 'fax' } }), (error) => {
        assert.match(refusalReasons(error).join('\n'), /channel "fax", which no integration the App lists provides/);
        return true;
      });
    });
  });
}
