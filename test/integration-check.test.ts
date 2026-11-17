/**
 * An integration's own words and its connection check: `label` and `description` reach the settings screen's reply,
 * "Test connection" runs `check` on the server under the saved secrets and the settings grant, and a throw, a time-out
 * or a secret in a message never reaches the screen.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'node:test';
import { openIntegrationStore, provisionSqliteIntegrations } from '../packages/mistri/src/adapters/integrations/integrationStore.js';
import { defineIntegration, IntegrationDeclarationError, shape } from '../packages/mistri/src/server/integration.js';
import { captureIntegrations, type CapturedIntegrations } from '../packages/mistri/src/server/integrations/integrationDeclaration.js';
import {
  checkIntegrationConnection,
  createIntegrationRuntime,
  IntegrationSettingsRefusal,
  readIntegrationSettings,
  registerIntegrationRuntime,
  saveIntegrationSettings,
} from '../packages/mistri/src/server/integrations/integrationRuntime.js';
import { integrationRoutes } from '../packages/mistri/src/server/http/integrationRoutes.js';
import { HttpError } from '../packages/engine/src/server/http/reply.js';
import type { PostContext } from '../packages/engine/src/server/http/context.js';

process.env.MISTRI_SECRETS_KEY ??= 'a-secrets-key-for-tests-that-is-long-enough';

type Check = NonNullable<Parameters<typeof defineIntegration>[0]['check']>;
const pinger = (name: string, extra: Record<string, unknown> = {}) =>
  defineIntegration({
    name,
    secrets: ['apiKey'],
    client: () => ({}),
    actions: { ping: { input: shape({}), output: shape({}), run: () => ({}) } },
    ...extra,
  } as Parameters<typeof defineIntegration>[0]);
const capture = (...use: ReturnType<typeof pinger>[]) =>
  captureIntegrations({ use, editors: ['owner'] }, new Map(), (message: string): never => {
    throw new Error(message);
  });

async function openRuntime(t: TestContext, declared: CapturedIntegrations) {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-integration-check-'));
  const path = join(directory, 'app.db');
  new DatabaseSync(path).close();
  provisionSqliteIntegrations(path);
  const store = await openIntegrationStore({ sqlite: path });
  t.after(async () => {
    await store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return createIntegrationRuntime({ appId: 'shop', declared, store });
}
const saveKey = (runtime: Awaited<ReturnType<typeof openRuntime>>, name: string, apiKey = 'sk_live_secret') =>
  saveIntegrationSettings(runtime, 't1', 'owner', { integration: name, secrets: { apiKey } });

test('the settings reply carries the declared label and description, and says nothing of them when there are none', async (t) => {
  const runtime = await openRuntime(
    t,
    capture(
      pinger('twilio-sms', { label: 'Twilio SMS', description: 'Texts reminders to patients.', check: () => ({ ok: true }) }),
      pinger('plain'),
    ),
  );
  const { integrations } = await readIntegrationSettings(runtime, 't1', () => '');
  assert.equal(integrations[0]!.label, 'Twilio SMS');
  assert.equal(integrations[0]!.description, 'Texts reminders to patients.');
  assert.equal(integrations[0]!.canCheck, true);
  assert.ok(
    !('label' in integrations[1]!) && !('description' in integrations[1]!),
    'no label: the screen falls back to the humanized name',
  );
  assert.equal(integrations[1]!.canCheck, false);
});

test('defineIntegration refuses a label, description or check that is not what the settings screen can show', () => {
  for (const bad of [{ label: '' }, { label: 4 }, { description: 'x'.repeat(281) }, { check: 'yes' }])
    assert.throws(() => pinger('bad', bad), IntegrationDeclarationError);
});

test('a check runs under the saved secrets: ok, a failure in its own words, and nothing until every secret is saved', async (t) => {
  const seen: unknown[] = [];
  const check: Check = ({ secrets }) => {
    seen.push(secrets);
    return secrets.apiKey === 'sk_live_secret' ? { ok: true } : { ok: false, message: 'The account is closed.' };
  };
  const runtime = await openRuntime(t, capture(pinger('fakepay', { check })));
  const before = await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' });
  assert.equal(before.ok, false, 'no secret is saved: nothing is called');
  assert.deepEqual(seen, []);
  await saveKey(runtime, 'fakepay');
  assert.deepEqual(await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' }), { ok: true });
  assert.deepEqual(seen, [{ apiKey: 'sk_live_secret' }]);
  await saveKey(runtime, 'fakepay', 'sk_other_value');
  assert.deepEqual(await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' }), {
    ok: false,
    message: 'The account is closed.',
  });
});

test('a throw is a generic failure that never echoes the error, and a secret in a message is taken out', async (t) => {
  let mode: 'throw' | 'echo' | 'odd' = 'throw';
  const check: Check = ({ secrets }) => {
    if (mode === 'throw') throw new Error(`401 for key ${secrets.apiKey}`);
    if (mode === 'echo') return { ok: false, message: `Key ${secrets.apiKey} was refused.` };
    return {} as never;
  };
  const runtime = await openRuntime(t, capture(pinger('fakepay', { check })));
  await saveKey(runtime, 'fakepay');
  const thrown = await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' });
  assert.equal(thrown.ok, false);
  assert.ok(!JSON.stringify(thrown).includes('sk_live_secret') && !JSON.stringify(thrown).includes('401'));
  mode = 'echo';
  const echoed = await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' });
  assert.ok(!JSON.stringify(echoed).includes('sk_live_secret'));
  assert.deepEqual(echoed, { ok: false, message: 'Key … was refused.' });
  mode = 'odd';
  assert.equal(
    (await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' })).ok,
    false,
    'an answer that is not { ok } fails',
  );
});

test('a check that never answers is stopped at the limit and its signal aborted', async (t) => {
  let signal: AbortSignal | undefined;
  const check: Check = (context) => {
    signal = context.signal;
    return new Promise(() => {});
  };
  const runtime = await openRuntime(t, capture(pinger('fakepay', { check })));
  await saveKey(runtime, 'fakepay');
  const answer = await checkIntegrationConnection(runtime, 't1', { integration: 'fakepay' }, 30);
  assert.equal(answer.ok, false);
  assert.equal(signal?.aborted, true);
});

test('a check is refused for an integration the App does not use or one that declares none', async (t) => {
  const runtime = await openRuntime(t, capture(pinger('plain')));
  for (const body of [{ integration: 'nopay' }, { integration: 'plain' }, null, []])
    await assert.rejects(checkIntegrationConnection(runtime, 't1', body), IntegrationSettingsRefusal);
});

test('on a single-App server only an editor may run a check', async (t) => {
  const runtime = await openRuntime(t, capture(pinger('fakepay', { check: () => ({ ok: true }) })));
  t.after(registerIntegrationRuntime(runtime));
  const host = { app: { app: { id: 'shop' } }, auth: {} };
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const post = {
      res,
      path: new URL(req.url!, 'http://local').pathname,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {},
      registry: { configOf: () => undefined },
      connection: 'main',
      appHosts: [host],
      principal: req.headers['x-principal'] as string | undefined,
      role: req.headers['x-role'] as string | undefined,
    } as unknown as PostContext;
    try {
      if (!(await integrationRoutes(post))) res.writeHead(418).end();
    } catch (error) {
      res.writeHead(error instanceof HttpError ? error.status : 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/integrations/check`;
  const call = async (who?: { principal: string; role: string }) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-principal': who.principal, 'x-role': who.role } : {}) },
      body: JSON.stringify({ integration: 'fakepay' }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  assert.equal((await call()).status, 401, 'signed out');
  assert.equal((await call({ principal: 'bob@example.org', role: 'staff' })).status, 403, 'a role editors does not name');
  await saveIntegrationSettings(runtime, '', 'ann', { integration: 'fakepay', secrets: { apiKey: 'sk_live_secret' } });
  const ok = await call({ principal: 'ann@example.org', role: 'owner' });
  assert.deepEqual([ok.status, ok.body], [200, { ok: true }]);
});
