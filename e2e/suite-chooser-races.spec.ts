/** Invitation navigation cannot change the App a visible acceptance button names. */
import { expect, test } from './support/harness';
import { suiteChooserPage } from '../packages/mistri/src/server/auth/suiteChooser';

test('chooser fences delayed refresh and acceptance across invitation hash changes', async ({ page }) => {
  // Observe the async click handler's completion, not merely receipt of HTTP
  // headers: assertions must run after a stale completion could clear gamma.
  await page.addInitScript(() => {
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if (this instanceof HTMLButtonElement && this.id === 'accept' && type === 'click' && typeof listener === 'function') {
        const original = listener;
        listener = function (this: EventTarget, event: Event) {
          const result = original.call(this, event);
          void Promise.resolve(result).finally(() => {
            document.documentElement.dataset.acceptFinished = 'true';
          });
        };
      }
      return add.call(this, type, listener, options);
    };
  });
  const origin = 'http://suite.test';
  const alpha = `alpha.${'A'.repeat(43)}`,
    beta = `beta.${'B'.repeat(43)}`,
    gamma = `gamma.${'C'.repeat(43)}`;
  let releaseRefresh!: () => void, refreshArrived!: () => void;
  const heldRefresh = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    refreshArrived = resolve;
  });
  let releaseAccept!: () => void, acceptArrived!: () => void;
  const heldAccept = new Promise<void>((resolve) => {
    releaseAccept = resolve;
  });
  const accepting = new Promise<void>((resolve) => {
    acceptArrived = resolve;
  });
  let calls = 0;
  const accepted: unknown[] = [];
  await page.route(`${origin}/tools/_mistri/apps`, (route) =>
    route.fulfill({ contentType: 'text/html', body: suiteChooserPage('Suite', '/tools', 'fixture') }),
  );
  await page.route(`${origin}/tools/api/suite/apps`, async (route) => {
    if (++calls === 2) {
      refreshArrived();
      await heldRefresh;
    }
    await route.fulfill({ json: { accountId: 'reader', apps: [] } });
  });
  await page.route(`${origin}/tools/api/suite/invitations/accept`, async (route) => {
    accepted.push(route.request().postDataJSON());
    acceptArrived();
    await heldAccept;
    await route.fulfill({ json: { revision: 1, roles: ['reader'] } });
  });
  try {
    await page.goto(`${origin}/tools/_mistri/apps#invite=${alpha}`);
    await expect(page.getByText('Invitation for alpha.', { exact: true })).toBeVisible();
    await page.goto(`${origin}/tools/_mistri/apps#invite=${beta}`);
    await arrived;
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeHidden();
    releaseRefresh();
    await expect(page.getByText('Invitation for beta.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Accept invitation', exact: true }).click();
    await accepting;
    assertAccepted();
    await page.goto(`${origin}/tools/_mistri/apps#invite=${gamma}`);
    await expect(page.getByText('Invitation for gamma.', { exact: true })).toBeVisible();
    releaseAccept();
    await page.waitForFunction(() => document.documentElement.dataset.acceptFinished === 'true');
    await expect(page.getByText('Invitation for gamma.', { exact: true })).toBeVisible();
    await expect(page).toHaveURL(`${origin}/tools/_mistri/apps#invite=${gamma}`);
    await expect(page.getByRole('button', { name: 'Accept invitation', exact: true })).toBeEnabled();
    assertAccepted();
  } finally {
    releaseRefresh();
    releaseAccept();
  }
  function assertAccepted() {
    expect(accepted).toEqual([{ appId: 'beta', token: 'B'.repeat(43) }]);
  }
});
