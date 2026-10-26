/** Delayed access reads/writes cannot publish into another App/account/subject. */
import { expect, test, type Page } from './support/harness';
import { suiteChooserPage } from '../packages/mistri/src/server/auth/suiteChooser';

function gate() {
  let release!: () => void, arrived!: () => void;
  return {
    held: new Promise<void>((resolve) => {
      release = resolve;
    }),
    arrival: new Promise<void>((resolve) => {
      arrived = resolve;
    }),
    release: () => release(),
    arrive: () => arrived(),
  };
}

async function fixture(page: Page, email?: 'accepted' | 'unknown') {
  const origin = 'http://suite.test';
  let account = 'administrator',
    revision = 0,
    failure: 'conflict' | 'unknown' | undefined;
  let held: { path: string; subjectId: string; barrier: ReturnType<typeof gate> } | undefined;
  const mutations: Array<{ appId: string; accountId: string; body: Record<string, unknown> }> = [];
  // Await completion of the actual UI handlers, after a stale response could
  // have drawn. HTTP response arrival alone does not establish that ordering.
  await page.addInitScript(() => {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (
        this instanceof HTMLElement &&
        ['management-lookup', 'management-save', 'management-issue', 'preference'].includes(this.id) &&
        typeof listener === 'function'
      ) {
        const original = listener,
          key = this.id === 'preference' ? 'preferencesFinished' : this.id === 'management-lookup' ? 'loadsFinished' : 'mutationsFinished';
        listener = function (this: EventTarget, event: Event) {
          const result = original.call(this, event);
          void Promise.resolve(result).finally(() => {
            document.documentElement.dataset[key] = String(Number(document.documentElement.dataset[key] ?? 0) + 1);
          });
        };
      }
      return add.call(this, type, listener, options);
    };
  });
  await page.route(`${origin}/tools/_mistri/apps`, (route) =>
    route.fulfill({ contentType: 'text/html', body: suiteChooserPage('Suite', '/tools', 'test') }),
  );
  await page.route(`${origin}/tools/api/suite/apps`, (route) =>
    route.fulfill({
      json: {
        accountId: account,
        emailAvailable: Boolean(email),
        apps: ['alpha', 'beta'].map((id) => ({ id, name: id, href: `/tools/${id}/`, manageHref: `/tools/_mistri/apps#manage=${id}` })),
      },
    }),
  );
  await page.route(`${origin}/tools/api/auth/sign-out`, (route) => route.fulfill({ json: {} }));
  await page.route(new RegExp(`${origin}/tools/(alpha|beta)/api/suite/`), async (route) => {
    const req = route.request(),
      appId = new URL(req.url()).pathname.split('/')[2];
    const path = req.url().split('/api/suite/')[1],
      body = req.postDataJSON();
    const accountId = req.headers()['x-mistri-account'];
    const base = { accountId, appId, subjectId: body.subjectId };
    const isMutation = path !== 'grants/read' && path !== 'invitations/list';
    if (isMutation) mutations.push({ appId, accountId, body });
    const intercepted = held;
    if (intercepted?.path === path && intercepted.subjectId === body.subjectId) {
      held = undefined;
      intercepted.barrier.arrive();
      await intercepted.barrier.held;
    }
    if (isMutation && failure) {
      const failed = failure;
      failure = undefined;
      if (failed === 'unknown') return route.abort('failed');
      revision++;
      return route.fulfill({ status: 409, json: { error: 'The App grant changed.' } });
    }
    if (path === 'grants/read') return route.fulfill({ json: { ...base, revision, roles: [], assignableRoles: ['reader', 'admin'] } });
    if (path === 'invitations/list') return route.fulfill({ json: { ...base, invitations: [], total: 0, offset: body.offset } });
    if (path === 'invitations/issue')
      return route.fulfill({
        json: {
          id: 'old-invitation',
          token: 'A'.repeat(43),
          acceptUrl: `/tools/_mistri/apps#invite=${appId}.${'A'.repeat(43)}`,
          ...(email ? { delivery: { status: email } } : {}),
        },
      });
    return route.fulfill({ json: { revision: ++revision, roles: body.roles } });
  });
  await page.goto(`${origin}/tools/_mistri/apps#manage=alpha`);
  await expect(page.locator('#management-app')).toHaveText('alpha');
  const load = async (id: string) => {
    await page.getByLabel('Subject account ID', { exact: true }).fill(id);
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
  };
  return {
    origin,
    mutations,
    load,
    switchAccount: () => {
      account = 'next-administrator';
    },
    failNext: (kind: typeof failure) => {
      failure = kind;
    },
    hold: (path: string, subjectId: string) => {
      const barrier = gate();
      held = { path, subjectId, barrier };
      return barrier;
    },
  };
}

test('preference CAS refresh preserves selection and needs an explicit retry', async ({ page }) => {
  const f = await fixture(page),
    writes: unknown[] = [];
  let revision = 0;
  await page.route(`${f.origin}/tools/api/suite/preferences`, (route) => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { accountId: 'administrator', defaultApp: 'beta', revision } });
    writes.push(route.request().postDataJSON());
    if (++revision === 1) return route.fulfill({ status: 409, json: { error: 'The App preference changed.' } });
    return route.fulfill({ json: { accountId: 'administrator', defaultApp: 'alpha', revision } });
  });
  await page.getByLabel('Default App', { exact: true }).selectOption('alpha');
  await page.getByRole('button', { name: 'Save default App', exact: true }).click();
  await expect(page.locator('#preference-status')).toContainText('Your selection is preserved');
  await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('alpha');
  expect(writes).toEqual([{ defaultApp: 'alpha', expectedRevision: 0 }]);
  await page.getByRole('button', { name: 'Save default App', exact: true }).click();
  await expect(page.locator('#preference-status')).toContainText('Default App saved.');
  expect(writes).toEqual([
    { defaultApp: 'alpha', expectedRevision: 0 },
    { defaultApp: 'alpha', expectedRevision: 1 },
  ]);
});

for (const transition of ['App', 'account'] as const) {
  test(`late preference response is fenced after changing ${transition}`, async ({ page }) => {
    const f = await fixture(page),
      held = gate();
    let writes = 0;
    await page.route(`${f.origin}/tools/api/suite/preferences`, async (route) => {
      writes++;
      held.arrive();
      await held.held;
      await route.fulfill({ json: { accountId: 'administrator', defaultApp: 'alpha', revision: 1 } });
    });
    try {
      await page.getByLabel('Default App', { exact: true }).selectOption('alpha');
      await page.getByRole('button', { name: 'Save default App', exact: true }).click();
      await held.arrival;
      await expect(page.getByRole('button', { name: 'Save default App', exact: true })).toBeDisabled();
      if (transition === 'App') {
        await page.getByRole('link', { name: 'Manage access for beta', exact: true }).click();
        await expect(page.locator('#management-app')).toHaveText('beta');
      } else {
        f.switchAccount();
        await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
        await expect(page.locator('#account')).toHaveText('next-administrator');
      }
      held.release();
      await page.waitForFunction(() => document.documentElement.dataset.preferencesFinished === '1');
      await expect(page.getByLabel('Default App', { exact: true })).toHaveValue('');
      await expect(page.locator('#preference-status')).toContainText('No default saved yet.');
      expect(writes).toBe(1);
    } finally {
      held.release();
    }
  });
}

for (const delivery of ['accepted', 'unknown'] as const) {
  test(`email ${delivery} keeps invitation issuance separate and the copy fallback available`, async ({ page }) => {
    const f = await fixture(page, delivery);
    await f.load('target');
    await expect(page.locator('#management-current')).toContainText('current revision 0');
    await page.getByRole('checkbox', { name: 'reader', exact: true }).check();
    await page.getByRole('checkbox', { name: 'Email invitation to this account', exact: true }).check();
    await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
    await expect(page.locator('#management-message')).toContainText(
      delivery === 'accepted' ? 'Email accepted by the delivery service' : 'Email delivery could not be confirmed',
    );
    await expect(page.getByLabel('Invitation link', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Copy invitation link', exact: true })).toBeEnabled();
    expect(f.mutations).toHaveLength(1);
    expect(f.mutations[0].body).toMatchObject({ subjectId: 'target', delivery: 'email', roles: ['reader'] });
  });
}

for (const transition of ['subject', 'App', 'account'] as const) {
  test(`late grant read cannot overwrite a changed ${transition}`, async ({ page }) => {
    const f = await fixture(page),
      held = f.hold('grants/read', 'old-subject');
    try {
      await f.load('old-subject');
      await held.arrival;
      if (transition === 'App') {
        await page.getByRole('link', { name: 'Manage access for beta', exact: true }).click();
        await expect(page.locator('#management-app')).toHaveText('beta');
      } else if (transition === 'account') {
        f.switchAccount();
        await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
        await expect(page.locator('#account')).toHaveText('next-administrator');
      }
      await f.load('new-subject');
      await expect(page.locator('#management-current')).toContainText('Account new-subject');
      held.release();
      await page.waitForFunction(() => document.documentElement.dataset.loadsFinished === '2');
      await expect(page.locator('#management-current')).toContainText('Account new-subject');
      await expect(page.getByLabel('Subject account ID', { exact: true })).toHaveValue('new-subject');
      await expect(page.locator('#management-app')).toHaveText(transition === 'App' ? 'beta' : 'alpha');
      expect(f.mutations).toHaveLength(0);
    } finally {
      held.release();
    }
  });

  test(`late invitation response cannot expose a link after changing ${transition}`, async ({ page }) => {
    const f = await fixture(page);
    await f.load('old-subject');
    await expect(page.locator('#management-current')).toContainText('Account old-subject');
    await page.getByRole('checkbox', { name: 'reader', exact: true }).check();
    const held = f.hold('invitations/issue', 'old-subject');
    try {
      await page.getByRole('button', { name: 'Create invitation', exact: true }).click();
      await held.arrival;
      await expect(page.getByRole('button', { name: 'Create invitation', exact: true })).toBeDisabled();
      // Even synthetic duplicate events cannot send another mutation.
      await page.locator('#management-issue').dispatchEvent('click');
      if (transition === 'App') {
        await page.getByRole('link', { name: 'Manage access for beta', exact: true }).click();
        await expect(page.locator('#management-app')).toHaveText('beta');
      } else if (transition === 'account') {
        f.switchAccount();
        await page.getByRole('button', { name: 'Sign out of the suite', exact: true }).click();
        await expect(page.locator('#account')).toHaveText('next-administrator');
      }
      await f.load('new-subject');
      await expect(page.locator('#management-current')).toContainText('Account new-subject');
      held.release();
      await page.waitForFunction(() => document.documentElement.dataset.mutationsFinished === '2');
      await expect(page.getByLabel('Invitation link', { exact: true })).toBeHidden();
      await expect(page.locator('#management-current')).toContainText('Account new-subject');
      expect(f.mutations).toEqual([
        {
          appId: 'alpha',
          accountId: 'administrator',
          body: {
            subjectId: 'old-subject',
            roles: ['reader'],
            expectedRevision: 0,
            expiresAt: expect.any(Number),
          },
        },
      ]);
    } finally {
      held.release();
    }
  });
}

for (const failure of ['conflict', 'unknown'] as const) {
  test(`${failure} outcome preserves edits and requires a fresh read without automatic replay`, async ({ page }) => {
    const f = await fixture(page);
    await f.load('target');
    await expect(page.locator('#management-current')).toContainText('current revision 0');
    await page.getByRole('checkbox', { name: 'admin', exact: true }).check();
    f.failNext(failure);
    await page.getByRole('button', { name: 'Save App access', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.mutationsFinished === '1');
    await expect(page.locator('#management-message')).toContainText(
      failure === 'conflict' ? 'Your selected roles are preserved' : 'could not be confirmed',
    );
    await expect(page.getByRole('checkbox', { name: 'admin', exact: true })).toBeChecked();
    await expect(page.getByRole('button', { name: 'Save App access', exact: true })).toBeDisabled();
    await page.locator('#management-save').dispatchEvent('click');
    await page.getByRole('button', { name: 'Load access', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save App access', exact: true })).toBeEnabled();
    await expect(page.getByRole('checkbox', { name: 'admin', exact: true })).toBeChecked();
    expect(f.mutations).toHaveLength(1);
    await page.getByRole('button', { name: 'Save App access', exact: true }).click();
    await expect(page.locator('#management-message')).toHaveText('App access saved.');
    expect(f.mutations).toHaveLength(2);
    expect(f.mutations[1].body).toEqual({ subjectId: 'target', roles: ['admin'], expectedRevision: failure === 'conflict' ? 1 : 0 });
  });
}
