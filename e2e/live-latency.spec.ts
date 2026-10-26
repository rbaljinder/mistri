/**
 * Live sync's commit-to-paint, measured (DESIGN budget: p50 ≤ 600 ms, p95 ≤ 1.2 s on a quiet machine). Opt-in, since
 * a number taken on a shared, loaded machine says nothing: `TABLEWALK_LIVE_LATENCY=1`, and `TABLEWALK_TEST_PG` for the
 * PostgreSQL half.
 *
 * Alice writes through the API at a person's pace — a note, then a rename, one every `GAP` ms — and Bob's page, open on
 * the ticket, notes the moment each one is drawn. The clock starts when Alice's write has answered.
 */
import type { BrowserContext } from '@playwright/test';
import { expect, test } from './support/harness';
import { SESSION_APP_ID, startSessionApp } from './support/sessionServer';

const SAMPLES = Number(process.env.TABLEWALK_LIVE_SAMPLES ?? 20);
const GAP = Number(process.env.TABLEWALK_LIVE_GAP ?? 1500);

for (const engine of ['sqlite', 'postgres'] as const)
  test(`commit to paint on ${engine}`, async ({ browser }) => {
    test.skip(!process.env.TABLEWALK_LIVE_LATENCY, 'opt-in: TABLEWALK_LIVE_LATENCY=1');
    test.skip(engine === 'postgres' && !process.env.TABLEWALK_TEST_PG, 'needs TABLEWALK_TEST_PG');
    test.setTimeout(240_000);
    const app = await startSessionApp({
      live: true,
      history: true,
      notes: true,
      ...(engine === 'postgres' ? { postgres: process.env.TABLEWALK_TEST_PG } : {}),
    });
    try {
      const sign = async (who: 0 | 1): Promise<BrowserContext> => {
        const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        const account = app.accounts[who];
        const signed = await context.request.post(`${app.origin}/api/auth/sign-in/email`, {
          headers: { origin: app.origin },
          data: { email: account.email, password: account.password },
        });
        expect(signed.ok()).toBe(true);
        return context;
      };
      /* A note is the composer's command, prepared for the ticket's revision and sent once, as the page sends it. */
      const note = async (context: BrowserContext, body: string) => {
        const call = (path: string, data: Record<string, unknown>) =>
          context.request.post(`${app.origin}${path}?app=${SESSION_APP_ID}`, { headers: { origin: app.origin }, data });
        const asked = { command: 'addNote', commandVersion: 1, key: { id: 1 } };
        const prepared = await (await call('/api/commands/prepare', asked)).json();
        return call('/api/commands/execute', {
          ...asked,
          expectedVersion: prepared.expectedVersion,
          idempotencyKey: crypto.randomUUID(),
          input: { body },
        });
      };
      const alice = await sign(0);
      const bob = await (await sign(1)).newPage();
      await bob.goto(`${app.origin}/tickets/1`);
      await expect(bob.getByText('Session-owned ticket').first()).toBeVisible({ timeout: 30_000 });
      await bob.evaluate(() => {
        const seen: Record<string, number> = {};
        (window as unknown as { __seen: Record<string, number> }).__seen = seen;
        const look = () => {
          for (const found of document.body.innerText.matchAll(/\bMark (\d+)\b/g)) seen[found[1]] ??= Date.now();
        };
        new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true });
      });
      await bob.waitForTimeout(2000);
      const latencies: number[] = [];
      for (let n = 1; n <= SAMPLES; n++) {
        const write =
          n % 2
            ? note(alice, `Mark ${n}`)
            : alice.request.post(`${app.origin}/api/update?app=${SESSION_APP_ID}`, {
                headers: { origin: app.origin },
                data: { table: 'ticket', key: { id: 1 }, values: { name: `Mark ${n}` } },
              });
        const reply = await write;
        expect(reply.ok(), await reply.text()).toBe(true);
        const committed = Date.now();
        await expect
          .poll(() => bob.evaluate((k) => (window as unknown as { __seen: Record<string, number> }).__seen[k], String(n)), {
            timeout: 30_000,
            intervals: [50],
          })
          .toBeTruthy();
        const painted = await bob.evaluate((k) => (window as unknown as { __seen: Record<string, number> }).__seen[k], String(n));
        latencies.push(Math.max(0, painted - committed));
        await bob.waitForTimeout(Math.max(0, GAP - (Date.now() - committed)));
      }
      const sorted = [...latencies].sort((a, b) => a - b);
      const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
      const report = { engine, samples: sorted.length, gap: GAP, p50: at(0.5), p95: at(0.95), max: sorted.at(-1), all: latencies };
      console.log(`live commit→paint ${JSON.stringify(report)}`);
      test.info().annotations.push({ type: 'live-latency', description: JSON.stringify(report) });
      await alice.close();
    } finally {
      await app.stop();
    }
  });
