import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CRM, CRM_CLOCK, CRM_DB, expect, type Page, test } from './support/ownServers';
import { startSavedFormApp } from './support/savedFormServer';
import { scalar } from './support/db';

// This worker's own Compass (support/ownServers.ts) is the App at the root; the spec starts the other placements itself.
test.use({ servers: ['crm'] });

/**
 * Where an App is served (shared/mount.ts), walked in a browser: the same App
 * at the root — one App on a server — under its id when mounted there, and
 * under a reverse proxy's path. Every kind of address is opened as a link and
 * written by the App as the reader moves: a record, a record's tab, the New
 * form, a dashboard's window, and on an App that signs people in, its public
 * form, its sign-in and its status check. Nothing reaches the server outside
 * its placement: a page in the wrong spelling names nothing, every request
 * the page makes is under the base, and so are the cookies it is given.
 */
const address = (page: Page) => {
  const url = new URL(page.url());
  return url.pathname + url.search;
};

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

/** Compass over this worker's CRM copy, placed by `flags`. */
async function startCompass(flags: readonly string[]): Promise<{ origin: string; stop: () => Promise<void> }> {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-mounts-'));
  const config = join(directory, 'crm.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'crm', url: CRM_DB, writable: true }] }));
  const port = await freePort();
  const child: ChildProcess = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('packages/mistri/src/server/index.ts'),
      '--config',
      config,
      '--app',
      'test/fixtures/apps/crm',
      '--port',
      String(port),
      ...flags,
    ],
    {
      env: { ...process.env, MISTRI_OPEN: '0', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_CLOCK: CRM_CLOCK },
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
  const deadline = Date.now() + 30_000;
  while (!log.includes('Listening on ')) {
    if (Date.now() > deadline || child.exitCode !== null) {
      await stop();
      throw new Error(`Compass did not start: ${log}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  return { origin: `http://127.0.0.1:${port}`, stop };
}

/* The server's own requests a page made outside the base: its API, host modules
   and components. From source the client's modules are Vite's, served from the
   root whatever the base (devclient.ts); a built server has them under it. */
const outside = (seen: readonly string[], base: string) =>
  seen.filter((path) => /\/(?:api|_mistri|_components)\//.test(path) && !path.startsWith(`${base}/`));

/** Every request the page makes, by path, to show none leaves its placement. */
function requests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin.startsWith('http://127.0.0.1')) seen.push(url.pathname);
  });
  return seen;
}

const PLACEMENTS = [
  { name: 'at the root, the one App on its server', flags: [] as string[], under: '' },
  { name: 'under its id, mounted there', flags: ['--mount', 'compass=/compass'], under: '/compass' },
  { name: "under a reverse proxy's path", flags: ['--base-path', '/tools'], under: '/tools' },
];

test.describe('Compass, placed three ways', () => {
  const lead = Number(scalar(CRM_DB, 'SELECT id FROM lead WHERE owner_id IS NOT NULL ORDER BY id DESC LIMIT 1'));
  const name = String(scalar(CRM_DB, 'SELECT name FROM lead WHERE id = ?', lead));
  const account = Number(
    scalar(CRM_DB, 'SELECT account_id FROM opportunity GROUP BY account_id ORDER BY count(*) DESC, account_id LIMIT 1'),
  );

  for (const placement of PLACEMENTS) {
    test(`${placement.name}: a record, a tab, the New form and a dashboard's window`, async ({ page }) => {
      test.setTimeout(90_000);
      const server = placement.flags.length ? await startCompass(placement.flags) : { origin: CRM, stop: async () => {} };
      try {
        const at = (path: string) => `${placement.under}${path}`;
        const seen = requests(page);
        await page.setViewportSize({ width: 1440, height: 924 });

        // A record, opened as a link; its reference opens the target's own address, in the same placement.
        await page.goto(`${server.origin}${at(`/leads/${lead}`)}`);
        // A fresh server compiles the client from source on its first page.
        await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 60_000 });
        await expect(page.locator('.crumbs')).toContainText(name);
        expect(address(page)).toBe(at(`/leads/${lead}`));
        await page.locator('main .ref-jump').first().click();
        await expect.poll(() => address(page)).toMatch(new RegExp(`^${at('/sales-team/')}\\d+$`));

        // A record's tab, written as the reader picks it and read back on a reload.
        await page.goto(`${server.origin}${at(`/accounts/${account}`)}`);
        await page.getByRole('tab', { name: /^Opportunities/ }).click();
        await expect.poll(() => address(page)).toBe(at(`/accounts/${account}/opportunities`));
        await page.reload();
        await expect(page.getByRole('tab', { name: /^Opportunities/ })).toHaveAttribute('aria-selected', 'true');

        // The New form, as a link and as the App writes it.
        await page.goto(`${server.origin}${at('/leads/new')}`);
        await expect(page.getByRole('dialog', { name: 'New lead' })).toBeVisible();
        await page.getByRole('dialog', { name: 'New lead' }).getByRole('button', { name: 'Cancel' }).click();
        await expect.poll(() => address(page)).toBe(at('/leads'));
        await page.getByRole('button', { name: '+ New lead' }).click();
        await expect.poll(() => address(page)).toBe(at('/leads/new'));
        await page.getByRole('dialog', { name: 'New lead' }).getByRole('button', { name: 'Cancel' }).click();

        // A dashboard's window is a parameter of its address.
        await page.goto(`${server.origin}${at('/sales-dashboard')}`);
        // Compass shows its windows as one date-range button: the menu holds the choices.
        await page.getByRole('button', { name: /^Time window:/ }).click();
        await page.getByRole('menuitem', { name: 'Last 30 days' }).click();
        await expect.poll(() => address(page)).toBe(at('/sales-dashboard?period=last-30-days'));
        await page.reload();
        await expect.poll(() => address(page)).toBe(at('/sales-dashboard?period=last-30-days'));

        // The home, and the App's own id is no alias for it anywhere but where it is mounted there.
        // The App's home, as the server says it: `/`, `/compass`, `/tools/` (shared/mount.ts appHome).
        const home = placement.under === '/tools' ? '/tools/' : placement.under || '/';
        await page.goto(`${server.origin}${home}`);
        await expect(page.getByRole('button', { name: /^Time window:/ })).toBeVisible();
        expect(new URL(page.url()).pathname).toBe(home);
        if (placement.under === '/tools') expect(outside(seen, '/tools')).toEqual([]);
        if (placement.under === '/tools') {
          expect((await page.request.get(`${server.origin}/leads/${lead}`)).status()).toBe(404);
          expect((await page.request.get(`${server.origin}/api/whoami`)).status()).toBe(404);
        }
      } finally {
        await server.stop();
      }
    });
  }
});

test.describe('An App that signs people in, placed three ways', () => {
  for (const placement of PLACEMENTS) {
    const flags = placement.flags.map((flag) => flag.replace('compass=/compass', 'saved-application=/saved-application'));
    const under = placement.under.replace('/compass', '/saved-application');
    test(`${placement.name}: its public form, its status check and its sign-in`, async ({ page }) => {
      test.setTimeout(90_000);
      const app = await startSavedFormApp(flags);
      try {
        const at = (path: string) => `${under}${path}`;
        const seen = requests(page);

        // The public form: its first step saves under the base, and its cookie is scoped to the base.
        await page.goto(`${app.origin}${at('/form/apply')}`);
        await expect(page.getByRole('heading', { name: 'Apply for financing' })).toBeVisible({ timeout: 60_000 });
        await page.getByLabel('First name', { exact: false }).fill('Ada');
        await page.getByLabel('Last name', { exact: false }).fill('Lovelace');
        await page.getByLabel('Email', { exact: false }).fill('ada@example.invalid');
        await page.getByRole('button', { name: 'Continue' }).click();
        await expect(page.getByRole('heading', { name: 'Address' })).toBeVisible();
        const base = under === '/tools' ? '/tools' : '';
        expect((await page.context().cookies()).map((cookie) => [cookie.name, cookie.path])).toEqual([
          ['tw_form_apply', `${base}/api/forms/apply`],
        ]);

        // The status check, as a link, answers through the API under the base.
        await page.goto(`${app.origin}${at('/form/apply/status')}`);
        await expect(page.getByRole('heading', { name: 'Check your application' })).toBeVisible();
        await page.getByLabel('Reference').fill('APP-0000-0000-0000');
        await page.getByLabel('Last name', { exact: false }).fill('Nobody');
        await page.getByRole('button', { name: 'Check status' }).click();
        await expect(
          page
            .locator('.form-status, .form-page')
            .getByText(/not find|no application|check the reference/i)
            .first(),
        ).toBeVisible();

        // The sign-in page, and a session cookie named for this App and scoped to the base.
        await page.goto(`${app.origin}${at('/sign-in')}`);
        await expect(page.getByRole('button', { name: /^Sign in$/ })).toBeVisible();
        const up = await page.request.post(`${app.origin}${base}/api/auth/sign-up/email`, {
          headers: { origin: app.origin },
          data: { name: 'Mount Reader', email: 'mount@example.invalid', password: 'mount-password-1' },
        });
        expect(up.status(), await up.text()).toBe(200);
        const session = (await page.context().cookies()).find((cookie) => cookie.name.endsWith('session_token'));
        expect(session).toMatchObject({ name: 'mistri-saved-application.session_token', path: base || '/' });
        // The browser sends it back where the App asks who is signed in.
        const me = await (await page.request.get(`${app.origin}${base}/api/whoami?app=saved-application`)).json();
        expect(me).toMatchObject({ signedIn: true, who: 'mount@example.invalid' });
        if (under === '/tools') expect(outside(seen, '/tools')).toEqual([]);
      } finally {
        await app.stop();
      }
    });
  }
});

test('the main App at the root beside another under its id', async ({ page }) => {
  test.setTimeout(120_000);
  /* Tick and a second App over Tick's database in one process:
     `--mount tick=/` makes Tick the main App, the Desk keeps /desk, and each
     reads and writes its own addresses. */
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-suite-'));
  const { execFileSync } = await import('node:child_process');
  // One connection, one App: the Desk reads a second copy of Tick's database.
  for (const name of ['tick', 'desk'])
    execFileSync(process.execPath, ['examples/databases/tick/seed.mjs', join(directory, `${name}.db`)], { stdio: 'pipe' });
  const config = join(directory, 'suite.json');
  writeFileSync(
    config,
    JSON.stringify({
      connections: [
        { name: 'tick', url: join(directory, 'tick.db'), writable: true },
        { name: 'desk', url: join(directory, 'desk.db') },
      ],
    }),
  );
  const desk = join(directory, 'desk');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(desk);
  writeFileSync(
    join(desk, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: { task: {} },
      views: { work: { kind: 'list', from: 'task' } },
      home: 'work',
      nav: ['work'],
    }),
  );
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      resolve('packages/mistri/src/server/index.ts'),
      '--config',
      config,
      '--app',
      'examples/apps/tick',
      '--app',
      desk,
      '--mount',
      'tick=/',
      '--port',
      String(port),
    ],
    {
      env: { ...process.env, MISTRI_OPEN: '0', XDG_CONFIG_HOME: join(directory, 'xdg') },
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
  try {
    const deadline = Date.now() + 30_000;
    while (!log.includes('Listening on ')) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error(`the suite did not start: ${log}`);
      await new Promise((done) => setTimeout(done, 100));
    }
    // Where each is, said where the person who started it is looking.
    await expect.poll(() => log).toContain(`Tick: http://localhost:${port}/\n`);
    await expect.poll(() => log).toContain(`Desk: http://localhost:${port}/desk\n`);
    const origin = `http://127.0.0.1:${port}`;
    await page.goto(`${origin}/tasks/1`);
    await expect(page.locator('html')).not.toHaveAttribute('data-starting', { timeout: 60_000 });
    await expect(page.getByRole('main').getByText('Plan the week').first()).toBeVisible();
    expect(address(page)).toBe('/tasks/1');
    await page.goto(`${origin}/desk`);
    await expect(page.getByRole('main').getByRole('heading', { name: 'Task', level: 1 })).toBeVisible();
    expect(address(page)).toBe('/desk');
    await page.goto(`${origin}/desk/work/1`);
    await expect(page.getByRole('main').getByText('Plan the week').first()).toBeVisible();
    await expect.poll(() => address(page)).toBe('/desk/work/1');
  } finally {
    if (child.exitCode === null) {
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
  }
});
