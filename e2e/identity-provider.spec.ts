/**
 * Signing in through an OpenID Connect provider in a real browser: the App's
 * own server (spawned over a temporary database and config, on a port of its
 * own) and a provider in this worker's process (test/support/mockOidc.ts).
 * The button says the provider's label; the browser goes to the provider,
 * comes back through the callback and lands in the App with the role its
 * claims give. A sign-in whose claims give no role comes back to the door
 * with a sentence. Nothing the browser is sent holds a token or the secret.
 */
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { expect, test } from './support/harness';
import { startMockOidc, type MockOidc } from '../test/support/mockOidc';

async function startApp(idp: MockOidc) {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-oidc-browser-'));
  let child: ReturnType<typeof spawn> | undefined;
  const stop = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const closed = once(child, 'close');
      child.kill('SIGTERM');
      const force = setTimeout(() => child?.kill('SIGKILL'), 5000);
      try {
        await closed;
      } finally {
        clearTimeout(force);
      }
    }
    rmSync(directory, { recursive: true, force: true });
  };
  try {
    const database = join(directory, 'tickets.db');
    const db = new DatabaseSync(database);
    db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL);
      INSERT INTO ticket VALUES (1, 'Radio check', 'open'), (2, 'Fuel order', 'open');`);
    db.close();
    const config = join(directory, 'mistri.json');
    writeFileSync(
      config,
      JSON.stringify({
        connections: [
          { name: 'crew-data', url: database },
          {
            name: 'workforce',
            kind: 'oidc',
            issuer: idp.issuer,
            clientId: idp.clientId,
            clientSecret: '${CREW_OIDC_SECRET}',
            label: 'Crew SSO',
            insecure: true,
          },
        ],
      }),
    );
    const authoring = join(directory, 'app');
    mkdirSync(authoring);
    const app = join(authoring, 'app.ts');
    writeFileSync(
      app,
      `import { defineApp, oidc } from ${JSON.stringify(pathToFileURL(resolve('packages/mistri/schema/app.mjs')).href)};
export default defineApp({
  id: 'crew', name: 'Crew desk', connection: 'crew-data',
  auth: { providers: ['email', oidc('workforce')], signUp: { providers: [oidc('workforce')] }, store: ${JSON.stringify(join(directory, 'sessions.db'))},
    roles: { agent: { read: true, claims: { groups: ['agents'] } } } },
  resources: { ticket: {} },
  views: { tickets: { kind: 'list', label: 'Tickets', from: 'ticket', show: ['name', 'status'] } },
  home: 'tickets', nav: ['tickets'],
});
`,
    );
    const reservation = createServer();
    await new Promise<void>((done, fail) => {
      reservation.once('error', fail);
      reservation.listen(0, '127.0.0.1', done);
    });
    const port = (reservation.address() as { port: number }).port;
    await new Promise<void>((done, fail) => reservation.close((error) => (error ? fail(error) : done())));
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(
      process.execPath,
      ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', app, '--port', String(port)],
      {
        // The callback comes back to the public URL, where the sign-in's state cookie was set: the address the browser uses.
        env: {
          ...process.env,
          DATABASE_URL: '',
          XDG_CONFIG_HOME: join(directory, 'xdg'),
          MISTRI_OPEN: '0',
          MISTRI_PUBLIC_URL: origin,
          BETTER_AUTH_SECRET: 'isolated-browser-oidc-secret-at-least-thirty-two-characters',
          CREW_OIDC_SECRET: idp.clientSecret,
          MISTRI_AUTH_ADMIN_EMAIL: '',
          MISTRI_AUTH_ADMIN_PASSWORD: '',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const running = child;
    let log = '';
    running.stdout!.on('data', (chunk) => {
      log += String(chunk);
    });
    running.stderr!.on('data', (chunk) => {
      log += String(chunk);
    });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error(`The App did not start: ${log}`)), 60_000);
      const ready = () => {
        if (log.includes('Listening on ')) {
          clearTimeout(timer);
          done();
        }
      };
      running.stdout!.on('data', ready);
      running.once('exit', () => {
        clearTimeout(timer);
        fail(new Error(`The App exited while starting: ${log}`));
      });
    });
    return { origin, stop, log: () => log };
  } catch (error) {
    await stop();
    throw error;
  }
}

test('a person signs in through the identity provider, and one with no role is told so at the door', async ({ page }) => {
  // The App's own server compiles the shell for its first visit (tsx, Vite's middleware): minutes on a busy machine.
  test.setTimeout(150_000);
  const idp = await startMockOidc();
  const app = await startApp(idp).catch(async (error) => {
    await idp.close();
    throw error;
  });
  try {
    const answers: Array<{ path: string; text: string }> = [];
    page.on('response', async (response) => {
      const url = new URL(response.url());
      if (url.origin !== app.origin) return;
      answers.push({ path: url.pathname, text: await response.text().catch(() => '') });
    });
    await page.addInitScript(() => localStorage.setItem('mistri.tour.v1', 'done'));
    await page.goto(`${app.origin}/`);
    await expect(page.getByRole('heading', { name: 'Sign in to Crew desk', exact: true })).toBeVisible();
    // Accounts are made at a first sign-in through the provider: no email sign-up, and no "made by an admin".
    await expect(page.getByText('Accounts are created by an admin.')).toHaveCount(0);

    idp.next({ sub: 'crew-ada', email: 'ada@crew.example', email_verified: true, name: 'Ada', claims: { groups: ['agents'] } });
    await page.getByRole('button', { name: 'Continue with Crew SSO', exact: true }).click();
    // The shell's first paint is compiled on demand under tsx: the first visit waits for it.
    await expect(page.locator('tbody').getByText('Radio check')).toBeVisible({ timeout: 30_000 });
    expect(idp.authorizations.at(-1)?.get('code_challenge_method')).toBe('S256');

    await page.getByRole('button', { name: /^Account:/ }).click();
    await page.getByRole('menuitem', { name: 'Sign out', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Sign in to Crew desk', exact: true })).toBeVisible();

    idp.next({ sub: 'crew-bo', email: 'bo@crew.example', email_verified: true, claims: { groups: ['canteen'] } });
    await page.getByRole('button', { name: 'Continue with Crew SSO', exact: true }).click();
    await expect(page.locator('.signin-problem')).toHaveText(
      'Your organization signed you in, and gives you no role in Crew desk. Ask your administrator for access.',
    );
    expect(new URL(page.url()).searchParams.has('error'), 'the refusal is taken out of the address').toBe(false);

    /* Nothing this server sent the browser holds a token or the client secret, and nothing but the address
       the browser is sent on to (the sign-in's own answer) names the provider. */
    expect(answers.length).toBeGreaterThan(3);
    for (const { path, text } of answers) {
      for (const token of idp.issued) expect(text.includes(token), path).toBe(false);
      expect(text.includes(idp.clientSecret), path).toBe(false);
      if (path !== '/api/auth/sign-in/social') expect(text.includes(idp.issuer), path).toBe(false);
    }
  } finally {
    await app.stop();
    await idp.close();
  }
});
