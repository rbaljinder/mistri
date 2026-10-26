/**
 * Field report S1: an App whose own definition did not fit its database (a
 * field no table has) was refused at startup as "The App row policy definition
 * could not be loaded or is invalid", and its author went to a policy module
 * that was fine. The App's own failure is now said as the App's, `App error:`
 * and its cause at the file and line that wrote it; the policy module's own
 * refusals still say the policy.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { refusedStart } from './support/policyServer.js';

const app = (fields: string[]) => ({
  id: 'spoke',
  name: 'Spoke',
  auth: { signUp: 'open', defaultRole: 'rider', rows: 'policy', roles: { rider: { read: true, write: true } } },
  resources: { job: { access: 'write', fields: { read: fields } } },
  views: { jobs: { kind: 'list', from: 'job' } },
  home: 'jobs',
  nav: ['jobs'],
});
const SQL = 'CREATE TABLE job(id INTEGER PRIMARY KEY, title TEXT NOT NULL);';
const POLICY = `export default { appId: 'spoke', resolveRows() { return { job: true }; } };`;

test("an App's own invalid definition under a row policy is blamed on the App, not on the policy", { timeout: 60_000 }, async (t) => {
  const said = await refusedStart(t, { app: app(['id', 'title', 'missing_col']), module: true, policy: POLICY, sql: SQL });
  // Said as every App error is, its cause first and placed where it is written: not framed as the policy's.
  assert.match(said, /App error: .*"missing_col" is unknown/);
  assert.match(said, /\n {2}at app\.mjs:\d+ \[[\w-]+\]\n/);
  assert.match(said, /> +\d+ \| .*missing_col/);
  assert.doesNotMatch(said, /Policy startup error/);
  assert.doesNotMatch(said, /row policy definition could not be loaded/);
});

test("a policy module's own fault still names the policy", { timeout: 60_000 }, async (t) => {
  const said = await refusedStart(t, { app: app(['id', 'title']), policy: `export default { appId: 'spoke' };`, sql: SQL });
  assert.match(
    said,
    /Policy startup error: The App row policy definition could not be loaded or is invalid\. Cause: The row policy has no resolveRows function\./,
  );
});
