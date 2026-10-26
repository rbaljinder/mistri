/**
 * A sensitive answer, end to end over a real server: the intake fixture's
 * Social Security number is `keep: 'handler'` — the handler alone sees it
 * whole, and stores its last four. After a submission, and after one whose
 * handler throws with the whole number in its words, no file the server
 * wrote (the database, its WAL and journal, the session store) and nothing it
 * printed holds the number, in either spelling.
 *
 * Beside it, a step's check (`/api/forms/<key>/check/<step>`): a rule's
 * sentence at its field, an answer to a field its `when` hides refused, an
 * unknown step behind the sign-in, and the sixty-first check in a minute a 429.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { startIntakeApp } from '../e2e/support/intakeServer.js';

const WHOLE = ['123456789', '123-45-6789', '987654321', '987-65-4321'];

function filesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

const answers = (more: Record<string, unknown> = {}) => ({
  email: 'ada@example.invalid',
  confirm_email: 'ada@example.invalid',
  first_name: 'Ada',
  last_name: 'Lovelace',
  date_of_birth: '1990-12-10',
  account_type: 'savings',
  joint: false,
  consent: true,
  ...more,
});

test(
  'a sensitive answer reaches no file and no log; a step check says rules, refuses hidden answers and is budgeted',
  { timeout: 60_000 },
  async () => {
    const app = await startIntakeApp();
    try {
      const post = (path: string, body: unknown) =>
        fetch(`${app.origin}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        });
      // The intake page's tab says its label before the script runs: it has no heading and a brand row of the mark alone.
      const page = await (await fetch(`${app.origin}/form/apply`)).text();
      assert.match(page, /<title>Open an account<\/title>/);
      const { form } = (await (await fetch(`${app.origin}/api/forms/apply`)).json()) as { form: { steps: Array<{ id: string }> } };
      const ids = form.steps.map((step) => step.id);
      assert.deepEqual(ids, ['email', 'name', 'account', 'joint', 'consent']);

      // A rule's sentence, at the field it names first.
      const mismatch = await post('/api/forms/apply/check/email', {
        input: { email: 'ada@example.invalid', confirm_email: 'eve@example.invalid' },
      });
      assert.equal(mismatch.status, 200);
      assert.deepEqual(await mismatch.json(), { problems: { confirm_email: 'The email addresses do not match.' } });
      // A step's check reads only the steps so far: a later answer is one nobody asked for.
      const ahead = (await (
        await post('/api/forms/apply/check/email', {
          input: { email: 'ada@example.invalid', confirm_email: 'ada@example.invalid', consent: true },
        })
      ).json()) as {
        problems: Record<string, string>;
      };
      assert.deepEqual(Object.keys(ahead.problems), ['consent']);
      // The nickname is shown only on a joint application: given on one that is not, it is refused, not dropped.
      const hidden = (await (await post('/api/forms/apply/check/joint', { input: answers({ nickname: 'Ada' }) })).json()) as {
        problems: Record<string, string>;
      };
      assert.ok(hidden.problems.nickname, JSON.stringify(hidden));
      const shown = (await (
        await post('/api/forms/apply/check/joint', { input: { ...answers({ joint: true, nickname: 'Ada' }), consent: undefined } })
      ).json()) as {
        problems: Record<string, string>;
      };
      assert.deepEqual(shown.problems, {});
      // A mask's characters are the visitor's; the number itself must be nine digits.
      const short = (await (
        await post('/api/forms/apply/check/name', { input: { ...answers({ ssn: '1234' }), account_type: undefined } })
      ).json()) as {
        problems: Record<string, string>;
      };
      assert.ok(short.problems.ssn, JSON.stringify(short));
      // A step the form lacks is no public path at all: the gate leaves it behind the sign-in.
      assert.equal((await post('/api/forms/apply/check/nope', { input: {} })).status, 401);
      assert.equal((await fetch(`${app.origin}/api/forms/apply/check/email`)).status, 405);

      const applied = await post('/api/forms/apply', { input: answers({ ssn: '123456789' }), submission: 'submission-key-000001' });
      assert.equal(applied.status, 200, await applied.clone().text());
      assert.doesNotMatch(await applied.text(), /123456789|6789/);
      const thrown = await post('/api/forms/apply', {
        input: answers({ ssn: '987654321', joint: true, nickname: 'trip' }),
        submission: 'submission-key-000002',
      });
      assert.ok(thrown.status >= 500, `the throwing handler answered ${thrown.status}`);
      assert.doesNotMatch(await thrown.text(), /987654321/);

      // Up to here the budget held; the rest of the minute's sixty, then a 429.
      let status = 0;
      for (let n = 0; n < 60 && status !== 429; n++) status = (await post('/api/forms/apply/check/email', { input: {} })).status;
      assert.equal(status, 429, 'a client past sixty checks a minute is told to wait');

      const db = new DatabaseSync(app.database, { readOnly: true });
      try {
        assert.deepEqual(
          db
            .prepare('SELECT ssn_last4 FROM application')
            .all()
            .map((row) => row.ssn_last4),
          ['6789'],
          'the handler kept the last four, and the throwing one wrote nothing',
        );
      } finally {
        db.close();
      }
      // Let the server finish writing what it writes after an answer, then read everything it wrote and said.
      await new Promise((resolve) => setTimeout(resolve, 300));
      const files = filesUnder(app.directory);
      assert.ok(files.some((file) => file.endsWith('members.db')));
      for (const file of files) {
        const bytes = readFileSync(file);
        for (const whole of WHOLE) assert.equal(bytes.indexOf(whole), -1, `${file} holds ${whole}`);
      }
      const log = app.log();
      assert.match(log, /\[sensitive\]|could not verify/, 'the throwing handler is reported');
      for (const whole of WHOLE) assert.ok(!log.includes(whole), `the server's output holds ${whole}:\n${log.slice(-2000)}`);
    } finally {
      await app.stop();
    }
  },
);
