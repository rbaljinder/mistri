/**
 * The read-your-write marker is named for the running product, as the environment variables are: `mistri_fresh` under
 * mistri, `tablewalk_fresh` under the browser.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { readFreshness } from '../packages/engine/src/server/http/readRouting.js';
import { setProduct } from '../packages/engine/src/server/product.js';

const NOW = 1_700_000_000_000;

function ask(cookie: string | undefined) {
  const headers: Record<string, string | string[] | undefined> = {};
  const context = readFreshness(
    { headers: { ...(cookie ? { cookie } : {}) } },
    {
      headersSent: false,
      getHeader: (name) => headers[name],
      setHeader: (name, value) => {
        headers[name] = value as string;
        return undefined as never;
      },
    },
    '',
    () => NOW,
  );
  context.onWrite?.();
  return { context, set: headers['set-cookie'] };
}

describe('the read-your-write cookie', () => {
  afterEach(() => setProduct('mistri'));

  test('is mistri_fresh under mistri and tablewalk_fresh under the browser', () => {
    setProduct('mistri');
    assert.equal(ask(undefined).set, `mistri_fresh=${NOW}; Path=/; Max-Age=10; HttpOnly; SameSite=Lax`);
    setProduct('tablewalk');
    assert.equal(ask(undefined).set, `tablewalk_fresh=${NOW}; Path=/; Max-Age=10; HttpOnly; SameSite=Lax`);
  });

  test('is read under its own name, and a recent one only', () => {
    setProduct('mistri');
    assert.equal(ask(`mistri_fresh=${NOW - 2_000}`).context.fresh, true);
    assert.equal(ask(`mistri_fresh=${NOW - 11_000}`).context.fresh, false);
    assert.equal(ask(`other=1; mistri_fresh=${NOW + 60_000}`).context.fresh, false, 'a time from the future is not ours');
    setProduct('tablewalk');
    assert.equal(ask(`tablewalk_fresh=${NOW - 2_000}`).context.fresh, true);
    assert.equal(ask(`mistri_fresh=${NOW - 2_000}`).context.fresh, false, "the other product's marker is not read");
  });

  test("under mistri the browser's name is not read", () => {
    setProduct('mistri');
    assert.equal(ask(`tablewalk_fresh=${NOW - 2_000}`).context.fresh, false);
  });
});
