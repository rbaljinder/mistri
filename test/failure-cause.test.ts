/**
 * A failed send is logged with its cause (observe/failureCause.ts), and the
 * cause holds no address, no URL and no long token.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { causeText, describeCause } from '../packages/mistri/src/server/observe/failureCause.js';

test('the name, the code and a short message are said', () => {
  const error = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:587'), { code: 'ECONNREFUSED' });
  assert.equal(causeText(error), 'Error (ECONNREFUSED): connect ECONNREFUSED 127.0.0.1:587');
  assert.deepEqual(describeCause('nope'), { name: 'string', message: '' });
});

test('an address, a URL carrying a token and a long secret are never said', () => {
  // Built in two parts so a secret scanner does not take the fixture for a real key.
  const secret = 'sk_' + 'live_' + '0123456789abcdef0123456789abcdef';
  const text = causeText(
    Object.assign(
      new Error(`550 <ada@example.test> rejected; POST https://hooks.example.test/T123/${secret}?key=1 failed with ${secret}`),
      {
        name: 'SmtpError',
        code: 'EENVELOPE',
      },
    ),
  );
  assert.match(text, /^SmtpError \(EENVELOPE\): /);
  for (const leaked of ['ada@example.test', 'hooks.example.test', secret, 'key=1'])
    assert.ok(!text.includes(leaked), `${leaked} in ${text}`);
});

test('an odd code is dropped and a long message is cut', () => {
  const cause = describeCause(Object.assign(new Error('x '.repeat(400)), { code: 'has spaces and is very odd' }));
  assert.equal(cause.code, undefined);
  assert.ok(cause.message.length <= 201);
});
