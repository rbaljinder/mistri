/**
 * A back-channel logout token's jti is reserved before the sessions are ended (packages/mistri/src/server/auth/backchannelLogout.ts).
 * A store error part-way must release it, so the provider's retry ends the rest instead of being refused as a replay.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { backchannelLogout, type LogoutContext } from '../packages/mistri/src/server/auth/backchannelLogout.js';

test('a failure while ending sessions releases the jti, so the retry is not a replay', async () => {
  const reserved = new Set<string>();
  const ended: string[] = [];
  let failOnce = true;
  const context: LogoutContext = {
    adapter: {
      findMany: async () => [{ id: 'r1', sessionId: 's1' }],
      findOne: async () => ({ token: 't1' }),
      delete: async () => undefined,
    },
    internalAdapter: {
      reserveVerificationValue: async ({ identifier }) => {
        if (reserved.has(identifier)) return null;
        reserved.add(identifier);
        return { identifier };
      },
      deleteVerificationByIdentifier: async (identifier) => void reserved.delete(identifier),
      deleteSession: async (token) => {
        if (failOnce) {
          failOnce = false;
          throw new Error('pool timeout');
        }
        ended.push(token);
      },
    },
  };
  const handle = backchannelLogout({
    providers: new Map([['idp', { verifyLogoutToken: async () => ({ iss: 'https://idp.example', sid: 'x', jti: 'j1' }) }]]),
    context: async () => context,
    where: 'test',
  });
  const post = async () => {
    const req = Object.assign(Readable.from([Buffer.from('logout_token=abc')]), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }) as unknown as IncomingMessage;
    const out = { statusCode: 0, setHeader() {}, end() {} } as unknown as ServerResponse;
    await handle(req, out, 'idp');
    return out.statusCode;
  };
  await assert.rejects(post(), /pool timeout/);
  assert.equal(await post(), 200, 'the retry is not refused as a replay');
  assert.deepEqual(ended, ['t1']);
  assert.equal(await post(), 400, 'a true replay after success is still refused');
});
