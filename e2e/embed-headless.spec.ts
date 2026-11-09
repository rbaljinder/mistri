import { execFileSync, type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { expect, test as base } from './support/harness';
import { fixture } from './support/fixture';
import { TMP } from './support/fixtures';
import { SURFACE_HEADER } from '../packages/mistri/src/shared/appSurfaces';

const FIXTURE = resolve('test/fixtures/apps/command-desk');
const APP_ID = 'command-desk-fixture';
const MANAGER = { name: 'north-manager', email: 'north-manager@example.test', password: 'headless-fixture-north-manager-password' };

let origin = '';
let child: ChildProcess;
let database = '';
let store = '';
let account = '';

/** Start the host over the run's directory and wait until it says its port. */
async function startHost(directory: string, config: string, app: string, staff: string) {
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'e2e/support/embedHeadlessHost.ts', config, '0', app, join(FIXTURE, 'commands.ts')],
    {
      env: {
        ...process.env,
        DATABASE_URL: '',
        XDG_CONFIG_HOME: join(directory, 'xdg'),
        MISTRI_OPEN: '0',
        COMMAND_DESK_STAFF_MAP: staff,
        BETTER_AUTH_SECRET: 'isolated-headless-host-secret-at-least-thirty-two-characters',
        MISTRI_AUTH_ADMIN_EMAIL: '',
        MISTRI_AUTH_ADMIN_PASSWORD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child = started;
  let log = '';
  started.stdout!.on('data', (chunk) => {
    log += String(chunk);
  });
  started.stderr!.on('data', (chunk) => {
    log += String(chunk);
  });
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`The host did not start: ${log}`)), 30_000);
    started.stdout!.on('data', () => {
      const said = /Host listening on (\d+)/.exec(log);
      if (said) {
        origin = `http://127.0.0.1:${said[1]}`;
        clearTimeout(timer);
        done();
      }
    });
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The host exited: ${log}`));
    });
  });
}

async function stopHost() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const closed = once(child, 'close');
  child.kill('SIGTERM');
  const force = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    await closed;
  } finally {
    clearTimeout(force);
  }
}

const test = base.extend<object, { started: void }>({
  started: fixture(async () => {
    const directory = mkdtempSync(join(TMP, 'embed-headless-'));
    database = join(directory, 'reviews.db');
    store = join(directory, 'sessions.db');
    execFileSync(process.execPath, ['--import', 'tsx', join(FIXTURE, 'seed.mjs'), database], { stdio: 'pipe' });
    const authoring = join(directory, 'app');
    mkdirSync(join(authoring, 'surfaces'), { recursive: true });
    /* The Command desk fixture, headless: open sign-up so the run can make its manager, and no screens of its own. */
    writeFileSync(
      join(authoring, 'app.ts'),
      `import app from ${JSON.stringify(pathToFileURL(join(FIXTURE, 'app.ts')).href)};
      export default {...app, id: '${APP_ID}', ui: {...app.ui, headless: true},
        auth: {...app.auth, providers:['email'], signUp:'open', defaultRole:'manager', store:${JSON.stringify(store)}}};`,
    );
    /* The surface the front end is in: the applications and the reviewers their command names, and that one command. */
    writeFileSync(
      join(authoring, 'surfaces', 'applications.surface.ts'),
      `import { defineSurface } from '@mistriwork/mistri/page';
      export default defineSurface({ label: 'Applications', reads: ['loan_application', 'reviewer'], commands: ['assignReviewer'] });`,
    );
    const staff = join(directory, 'staff.json');
    writeFileSync(staff, '{}', { mode: 0o600 });
    const config = `${database}.json`;
    await startHost(directory, config, authoring, staff);
    const response = await fetch(`${origin}/api/mistri/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { origin, 'content-type': 'application/json' },
      body: JSON.stringify(MANAGER),
      signal: AbortSignal.timeout(10_000),
    });
    const result = (await response.json()) as { user?: { id?: unknown } };
    if (!response.ok || typeof result.user?.id !== 'string')
      throw new Error(`The host could not make its manager: ${JSON.stringify(result)}`);
    account = result.user.id;
    /* The fixture's commands read the account-to-staff map once, as they load: bind the manager to the North desk and start again. */
    await stopHost();
    writeFileSync(staff, JSON.stringify({ [account]: 1 }));
    await startHost(directory, config, authoring, staff);
  }, stopHost),
});

/**
 * Headless mode, end to end: a front end that draws everything itself (e2e/support/embed-headless-host) names its
 * surface on every request to the mistri handler mounted in its own server, signs in through mistri, lists the
 * surface's rows and runs its one command with plain elements. Its reader's grants still decide: with the command's
 * grant taken away, the same button is refused and nothing is written.
 *
 * The host is its own process on a port the OS gives it over a fresh database (mkdtemp), so it runs beside the other
 * parallel specs.
 */
test.describe('a headless front end', () => {
  test('signs in, lists the surface, runs its command, and is refused once the grant is gone', async ({ page }) => {
    test.slow();
    const signedIn = await page.request.post(`${origin}/api/mistri/api/auth/sign-in/email`, {
      headers: { origin },
      data: { email: MANAGER.email, password: MANAGER.password },
    });
    expect(signedIn.ok()).toBe(true);

    await page.goto(`${origin}/`);
    const list = page.getByRole('list', { name: 'Applications' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list).toContainText('AL-1001 — submitted — unassigned');
    await expect(page.getByText('May assign')).toBeVisible();
    /* Nothing of mistri's on the page: no stylesheet of its own, no shell. */
    expect(await page.locator('link[rel="stylesheet"]').count()).toBe(0);

    await page.getByRole('button', { name: 'Assign Robin Bell' }).click();
    await expect(page.locator('output')).toHaveText('applied: Reviewer assigned.');
    await expect(list).toContainText('AL-1001 — submitted — reviewer 3');
    const db = new DatabaseSync(database, { readOnly: true });
    try {
      expect(db.prepare('SELECT reviewer_id FROM loan_application WHERE id = 1').get()).toEqual({ reviewer_id: 3 });
    } finally {
      db.close();
    }

    /* Outside the surface and without one: refused by the server, whatever the page would ask. */
    const outside = await page.request.post(`${origin}/api/mistri/api/view/run`, {
      headers: { [SURFACE_HEADER]: 'applications' },
      data: { app: APP_ID, view: { base: 'loan_decision' }, count: 'none' },
    });
    expect(outside.status()).toBe(403);
    expect((await outside.json()).code).toBe('surface');
    const bare = await page.request.post(`${origin}/api/mistri/api/view/run`, {
      data: { app: APP_ID, view: { base: 'loan_application' }, count: 'none' },
    });
    expect(bare.status()).toBe(403);

    /* The grant taken away: the manager is a viewer now, who reads the surface but may not run its command. */
    const sessions = new DatabaseSync(store);
    try {
      sessions.prepare('UPDATE user SET role = ? WHERE id = ?').run('viewer', account);
    } finally {
      sessions.close();
    }
    await page.reload();
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(page.getByText('May not assign')).toBeVisible();
    await page.getByRole('button', { name: 'Assign Robin Bell' }).click();
    await expect(page.locator('output')).toHaveText(/^refused: /);
    const revoked = await page.request.post(`${origin}/api/mistri/api/commands/execute?app=${APP_ID}`, {
      headers: { [SURFACE_HEADER]: 'applications' },
      data: {
        command: 'assignReviewer',
        commandVersion: 1,
        key: { id: 2 },
        expectedVersion: 0,
        idempotencyKey: 'headless-revoked-0001',
        input: { reviewer: 3, reason: 'Refused.' },
      },
    });
    expect(revoked.status()).toBe(403);
    expect((await revoked.json()).code).not.toBe('surface');
  });

  test('signs in at mistri and goes back to the front end, or says the person may', async ({ page }) => {
    /* The App draws no screen of its own: its root is not a page, and its sign-in is the one it opens. */
    expect((await page.request.get(`${origin}/api/mistri/`)).status()).toBe(404);
    await page.goto(`${origin}/api/mistri/sign-in?then=${encodeURIComponent('/?from=sign-in')}`);
    await page.getByLabel('Email').fill(MANAGER.email);
    await page.getByLabel('Password', { exact: true }).fill(MANAGER.password);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(`${origin}/?from=sign-in`);
    await expect(page.getByRole('list', { name: 'Applications' }).getByRole('listitem')).toHaveCount(3);

    /* Another origin's return address is not followed; with none, the page says the person is signed in. */
    for (const address of [
      `${origin}/api/mistri/sign-in?then=${encodeURIComponent('https://example.com/')}`,
      `${origin}/api/mistri/sign-in`,
    ]) {
      await page.goto(address);
      await expect(page.getByRole('heading', { name: 'Signed in' })).toBeVisible();
      await expect(page.getByText('You can close this tab and return to the page you came from.')).toBeVisible();
      expect(page.url()).toBe(address);
    }
  });
});
