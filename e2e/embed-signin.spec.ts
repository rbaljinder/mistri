/**
 * Signing in from the host's own app, in a real browser. Compass signs people
 * in here (a wrapper beside this worker's CRM copy adds `auth`), and the
 * config file trusts a host, "portal", whose page is on the App's origin — as
 * it is when the host proxies the App, or mounts it. The host's server signs
 * an assertion for the person it already knows; its page posts it to the
 * exchange and goes to the leads list, which opens signed in: no sign-in
 * screen, no second password. The session is the App's own HttpOnly cookie,
 * and neither the assertion's key nor a token reaches the page.
 */
import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, test } from './support/harness';
import { CRM_CLOCK, CRM_DB } from './support/ownServers';
import { scalar } from './support/db';
import { mintEmbedAssertion } from '../packages/mistri/src/server/embed/mint';

const SECRET = 'portal-assertion-secret-of-at-least-thirty-two-bytes';

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done, fail) => {
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', done);
  });
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}

async function startCompass(): Promise<{ origin: string; stop: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), 'mistri-embed-signin-'));
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const config = join(directory, 'mistri.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'crm', url: CRM_DB, writable: true },
        { name: 'portal', kind: 'embed', issuer: 'https://portal.example', secret: '${PORTAL_EMBED_SECRET}', origins: [origin] },
      ],
    }),
  );
  const authoring = join(directory, 'app');
  mkdirSync(authoring);
  const app = join(authoring, 'app.ts');
  writeFileSync(
    app,
    `import { defineApp } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/schema/app.mjs')).href)};
import compass from ${JSON.stringify(pathToFileURL(resolve('test/fixtures/apps/crm/app.ts')).href)};
export default defineApp({ ...compass, auth: { providers: ['email'], defaultRole: 'rep', store: ${JSON.stringify(join(directory, 'sessions.db'))},
  roles: { rep: { read: true } } } } as never);
`,
  );
  const child: ChildProcess = spawn(
    process.execPath,
    ['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), '--config', config, '--app', app, '--port', String(port)],
    {
      env: {
        ...process.env,
        MISTRI_OPEN: '0',
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        MISTRI_CLOCK: CRM_CLOCK,
        MISTRI_PUBLIC_URL: origin,
        BETTER_AUTH_SECRET: 'isolated-browser-embed-secret-at-least-thirty-two-characters',
        PORTAL_EMBED_SECRET: SECRET,
        MISTRI_AUTH_ADMIN_EMAIL: '',
        MISTRI_AUTH_ADMIN_PASSWORD: '',
        ANTHROPIC_API_KEY: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let log = '';
  child.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  child.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  const deadline = Date.now() + 60_000;
  while (!log.includes('Listening on ')) {
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error(`Compass did not start: ${log}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return { origin, stop };
}

test("the host's page signs its person in, and the browser lands on Compass's leads signed in", async ({ page }) => {
  // The App's own server compiles the shell for its first visit (tsx, Vite's middleware): minutes on a busy machine.
  test.setTimeout(150_000);
  const compass = await startCompass();
  try {
    const lead = String(scalar(CRM_DB, "SELECT name FROM lead WHERE status = 'new' ORDER BY created_on DESC, id DESC LIMIT 1"));
    // The host's server: it knows Rita, and signs a minute-long statement of it for this page's origin.
    const assertion = await mintEmbedAssertion({
      issuer: 'https://portal.example',
      key: SECRET,
      app: 'compass',
      origin: compass.origin,
      subject: 'portal-user-42',
      email: 'rita@portal.example',
      name: 'Rita Ortiz',
    });
    // The host's page, on the App's origin as a proxy or a mounted handler puts it.
    await page.route(`${compass.origin}/host`, (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>Portal</title><p id="state">Signing you in…</p>
<script>
fetch('/api/auth/embed/exchange', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ assertion: ${JSON.stringify(assertion)} }) })
  .then((reply) => reply.json().then((body) => {
    if (reply.ok && !body.token) location.assign('/leads');
    else document.getElementById('state').textContent = 'Refused: ' + (body.code || reply.status);
  }));
</script>`,
      }),
    );
    await page.goto(`${compass.origin}/host`);
    await expect(page).toHaveURL(`${compass.origin}/leads`, { timeout: 60_000 });
    await expect(page.getByRole('gridcell', { name: lead }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /^sign in$/i })).toHaveCount(0);
    const cookies = await page.context().cookies(compass.origin);
    const session = cookies.find((cookie) => cookie.name === 'mistri-compass.session_token');
    expect(session?.httpOnly, 'the session is the App cookie, out of the page script').toBe(true);
    expect(await page.evaluate(() => document.cookie)).not.toContain('session_token');
    const who = await page.evaluate(async () => (await fetch('/api/whoami')).json());
    expect(who.signedIn).toBe(true);
    expect(who.who).toBe('rita@portal.example');
  } finally {
    await compass.stop();
  }
});
