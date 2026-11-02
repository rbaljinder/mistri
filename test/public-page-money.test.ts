import assert from 'node:assert/strict';
import { test } from 'node:test';
import { said } from '../packages/mistri/src/server/http/publicPage.js';
import type { AppDisplayRule } from '../packages/engine/src/shared/servedApp.js';

/* A server-drawn public page says money as the client does (locale.ts): to the currency's minor digits, and with
   `whole: true` without them only where they are zeros, so a listing price never hides a cent it has. */
const ui = { locale: 'en-US', currency: 'USD' } as never;
const say = (rule: AppDisplayRule, value: unknown) => said(rule, value, ui)?.replace(/[  ]/g, ' ');

test('a public page says money to its minor digits, and whole where the rule says whole and the amount is', () => {
  const money: AppDisplayRule = { format: 'money' };
  assert.equal(say(money, '22495.00'), '$22,495.00');
  const whole: AppDisplayRule = { format: 'money', whole: true };
  assert.deepEqual(
    ['22495.00', 22495, '-12'].map((v) => say(whole, v)),
    ['$22,495', '$22,495', '-$12'],
  );
  assert.deepEqual(
    ['22495.50', '0.05', '-12.50'].map((v) => say(whole, v)),
    ['$22,495.50', '$0.05', '-$12.50'],
  );
  assert.equal(say(whole, '90071992547409931.00'), '$90,071,992,547,409,931');
  assert.equal(say(whole, '90071992547409931.25'), '$90,071,992,547,409,931.25');
  assert.deepEqual(
    [2249500, 2249550].map((v) => say({ ...whole, minor: true }, v)),
    ['$22,495', '$22,495.50'],
  );
  assert.equal(say({ ...whole, currency: 'JPY' }, 1500), '¥1,500');
  assert.match(say({ ...whole, currency: 'KWD' }, '12.000')!, /12$/);
  assert.match(say({ ...whole, currency: 'KWD' }, '12.500')!, /12\.500$/);
  assert.equal(say({ ...whole, unit: '/mo' }, 242), '$242/mo');
});
