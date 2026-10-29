/**
 * Sign-in over plain http beyond this machine is refused at startup, not only warned about: a password would cross
 * the network in the clear. `--insecure-http-sign-in` (MISTRI_INSECURE_HTTP_SIGN_IN=1) is the operator's explicit
 * word that something else secures the hop; loopback, and an https public address, never needed it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { insecureSignInRefusal } from '../packages/engine/src/server/startupWarnings.js';
import { parseArgs } from '../packages/engine/src/server/cli/args.js';
import { loadApp, type LoadedApp } from '../packages/mistri/src/server/app/apps.js';
import { createAppAuth } from '../packages/mistri/src/server/auth/auth.js';
import { makeDemoDatabase } from './make-demo-db.js';

const secret = 'test-secret-that-is-at-least-thirty-two-characters-long';
let tmp: string;
let loaded: LoadedApp;

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), 'mistri-insecure-http-'));
  makeDemoDatabase(join(tmp, 'app.db'));
  const dir = join(tmp, 'secured');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'app.json'),
    JSON.stringify({
      name: 'Secured',
      resources: { work_order: {} },
      auth: { providers: ['email'], signUp: 'open', store: join(tmp, 'auth.db') },
      views: { 'work-orders': { kind: 'list', from: 'work_order' } },
      home: 'work-orders',
      nav: ['work-orders'],
    }),
  );
  loaded = await loadApp(dir);
});

after(() => rmSync(tmp, { recursive: true, force: true }));

test('the refusal names the fix and the override, and only fires beyond loopback at an http address', () => {
  const refused = insecureSignInRefusal('http://crm.example.com', '0.0.0.0');
  assert.match(refused ?? '', /MISTRI_PUBLIC_URL\) to the https address of a TLS proxy/);
  assert.match(refused ?? '', /--host 127\.0\.0\.1/);
  assert.match(refused ?? '', /--insecure-http-sign-in \(MISTRI_INSECURE_HTTP_SIGN_IN=1\)/);
  for (const [url, host] of [
    ['http://localhost:4000', '127.0.0.1'],
    ['https://crm.example.com', '0.0.0.0'],
  ])
    assert.equal(insecureSignInRefusal(url, host), undefined, `${url} on ${host}`);
});

test('the flag and its environment variable are read', () => {
  assert.equal(parseArgs(['--app', 'x']).insecureHttpSignIn, undefined);
  assert.equal(parseArgs(['--app', 'x', '--insecure-http-sign-in']).insecureHttpSignIn, true);
});

test('startup refuses sign-in at an http address beyond loopback, unless the override is given', async () => {
  const environment = { BETTER_AUTH_SECRET: secret };
  const base = { baseURL: 'http://crm.example.com', trustedOrigins: ['http://crm.example.com'], listenHost: '0.0.0.0' };
  await assert.rejects(
    createAppAuth(loaded, { ...base, environment }),
    /would cross the network in the clear[\s\S]*--insecure-http-sign-in/,
  );

  const warned: string[] = [];
  const warn = console.warn;
  console.warn = (line: unknown) => void warned.push(String(line));
  try {
    const runtime = await createAppAuth(loaded, { ...base, environment: { ...environment, MISTRI_INSECURE_HTTP_SIGN_IN: '1' } });
    runtime.close();
  } finally {
    console.warn = warn;
  }
  assert.match(warned.join('\n'), /never marked Secure/);
});

test('loopback needs no override', async () => {
  const runtime = await createAppAuth(loaded, {
    baseURL: 'http://127.0.0.1:4310',
    trustedOrigins: ['http://127.0.0.1:4310'],
    environment: { BETTER_AUTH_SECRET: secret },
  });
  runtime.close();
});
