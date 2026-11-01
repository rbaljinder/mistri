/**
 * The first two minutes.
 *
 * Two screens nobody who already uses tablewalk will ever see again, which is
 * exactly why they are worth a browser test: nothing in daily use exercises
 * them, so they are the two most likely to be broken by a change to something
 * else and the last two anybody would notice.
 *
 * The empty state is driven by routing `/api/connections` to an empty list
 * rather than by starting a second server. The server's own half — that it
 * starts at all with nothing named, serves the page, and answers 409 for
 * anything needing a database — is asserted over the wire in
 * `test/http.test.ts`. What is left for a browser is what the browser
 * decides: which screen is drawn, and what the controls on it do.
 *
 * These tests opt out of the suite-wide `storageState`, which marks the tour
 * as already seen. A first load is the subject here.
 */
import { DEMO, expect, test } from './support/ownServers';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['explorer'] });

/** A browser that has never been here. */
test.use({ storageState: { cookies: [], origins: [] } });

test.describe('with nothing connected', () => {
  test.beforeEach(async ({ page }) => {
    /* A server with nothing connected, faked at the two endpoints that say
       so. Both are needed and for different reasons: boot learns the empty
       state from the schema request's 409 — the failure already carries the
       answer, so an ordinary load does not pay for a second request — and
       then confirms it against the list before showing a welcome screen over
       what might be a different fault. */
    await page.route('**/api/schema*', async (route) => {
      await route.fulfill({ status: 409, json: { error: 'No connection is open.' } });
    });
    await page.route('**/api/connections', async (route) => {
      /* Only the plain list. `/api/connections/test` and the rest still reach
         the server, so the Add dialog behaves as it really does. */
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({ json: { connections: [], active: null } });
    });
  });

  test('the page explains itself and offers two ways in', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { name: 'Follow the data.' })).toBeVisible();
    /* The promise made before the box that asks for a password, not after. */
    await expect(page.locator('.welcome-assure')).toContainText('Read only');
    /* Two choices, because a fresh install has two kinds of visitor. The
       sample is the zero-friction one and holds the focus; a database of
       your own is the button beside it. */
    await expect(page.getByRole('button', { name: 'Open the sample database' })).toBeFocused();
    await expect(page.getByRole('button', { name: 'Connect a database' })).toBeVisible();
  });

  test('the sample database is one click, and lands you in it', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Open the sample database' })).toBeVisible();

    /* The empty-list and 409 mocks were only there to draw the welcome screen.
       From here the real server answers: the click builds (or reuses) a demo,
       makes it active, and the page reloads into it — so the table list the
       welcome screen kept hidden is now on screen, and the welcome is gone. */
    await page.unroute('**/api/connections');
    await page.unroute('**/api/schema*');
    await page.getByRole('button', { name: 'Open the sample database' }).click();

    await expect(page.locator('.sidebar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open the sample database' })).toHaveCount(0);
  });

  test('the controls that need a database are not on screen', async ({ page }) => {
    await page.goto('/');

    /* Hidden rather than disabled. A query bar over no database is a control
       that invites a keystroke it cannot answer. */
    for (const selector of ['#querybar', '.sidebar', '#search-button']) {
      await expect(page.locator(selector)).toBeHidden();
    }
  });

  test('the button opens the dialog that takes a connection', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();

    // The whole manager would put an empty list between someone and the only
    // thing there is to do here, so the dialog is offered on its own.
    await expect(page.getByRole('heading', { name: 'Add a connection' })).toBeVisible();
    await expect(page.locator('.conn-manager')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Test' })).toBeVisible();

    /* Both shapes at once, no tab to choose between them first. */
    await expect(page.getByLabel('Connection URL or file path')).toBeVisible();
    await expect(page.getByLabel('Host')).toBeVisible();
    await expect(page.getByLabel('Password')).toBeVisible();
  });

  test('a pasted URL fills in the parts below it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();
    await page.getByLabel('Connection URL or file path').fill('postgres://alice@db.example:6543/shop');

    await expect(page.getByLabel('Host')).toHaveValue('db.example');
    await expect(page.getByLabel('Port')).toHaveValue('6543');
    await expect(page.getByLabel('Database')).toHaveValue('shop');
    await expect(page.getByLabel('User')).toHaveValue('alice');
  });

  test('a typed password is not echoed into the URL box', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();
    const box = page.getByLabel('Connection URL or file path');
    await box.fill('postgres://alice@db.example/shop');
    await page.getByLabel('Password').fill('hunter2');

    /* The reason the two shapes can share a screen. The Password field is
       masked because the app decided the secret should not be readable over a
       shoulder; echoing it in plain text four lines below would undo that. */
    await expect(box).not.toHaveValue(/hunter2/);
    // It is still going to be used, and the line that says so proves it.
    await expect(page.locator('.conn-preview')).toHaveText('postgres://alice:••••••@db.example/shop');
  });

  test('a URL with no scheme is caught, and fixed in one click', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();

    /* Exactly what tablewalk prints as a connection's name, pasted back. With
       no `://` it is read as a file path, and the failure that came back was
       SQLite's "unable to open database file". */
    await page.getByLabel('Connection URL or file path').fill('postgres@127.0.0.1/tablewalk');
    await expect(page.locator('.conn-scheme-hint')).toBeVisible();

    /* The form used to contradict itself here: the parts switched to SQLite
       and the Driver control went on reading "postgres", because assigning to
       a custom dropdown's `value` set an expando on a div and did nothing. */
    await expect(page.locator('.dd-value')).toHaveText('sqlite');
    await expect(page.getByLabel('File', { exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'postgres://' }).click();

    await expect(page.getByLabel('Connection URL or file path')).toHaveValue('postgres://postgres@127.0.0.1/tablewalk');
    await expect(page.locator('.dd-value')).toHaveText('postgres');
    await expect(page.getByLabel('Host')).toHaveValue('127.0.0.1');
    await expect(page.getByLabel('Database')).toHaveValue('tablewalk');
    await expect(page.locator('.conn-scheme-hint')).toBeHidden();
  });

  test('a half-typed URL does not wipe the fields under it', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();
    await page.getByLabel('Connection URL or file path').fill('postgres://alice@db.example/shop');
    await expect(page.getByLabel('Host')).toHaveValue('db.example');

    /* Typing happens one character at a time and most prefixes parse to
       nothing. Applying those emptied the form under the cursor — invisible
       while the parts were behind a tab, and the first thing you would see
       now. */
    await page.getByLabel('Connection URL or file path').fill('postgres:/');
    await expect(page.getByLabel('Host')).toHaveValue('db.example');
  });

  test('a bad target is reported in the dialog, not on a broken page', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();
    await page.getByLabel('Connection URL or file path').fill('/nope/not/a/database.db');
    await page.getByRole('button', { name: 'Add and open' }).click();

    /* Marked as a failure, not left as another grey line among the fields —
       the answer to a button press has to look like one. */
    await expect(page.locator('.conn-result.bad')).toBeVisible();
    // Still on the dialog, with what was typed still in it.
    await expect(page.getByLabel('Connection URL or file path')).toHaveValue('/nope/not/a/database.db');
  });

  test("the name box offers the database's own name", async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Connect a database' }).click();
    await page.getByLabel('Connection URL or file path').fill('postgres://bob@db.example/shop');

    /* Left blank the server names it after the URL — `bob@db.example/shop`,
       which is thirty characters of punctuation in the top bar and slugged
       into every link. The database's own name is what people call it. */
    await expect(page.getByLabel('Connection name')).toHaveAttribute('placeholder', 'shop');
  });
});

test.describe('when the only connection will not open', () => {
  test.beforeEach(async ({ page }) => {
    await page.route('**/api/schema*', async (route) => {
      await route.fulfill({ status: 409, json: { error: 'No connection is open.' } });
    });
    await page.route('**/api/connections', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await route.fulfill({
        json: {
          connections: [
            {
              id: 'broken',
              name: 'broken',
              source: 'session',
              connected: false,
              detail: '/no/such/dir/x.db',
              error: 'unable to open database file',
            },
          ],
          active: null,
        },
      });
    });
  });

  test('says which one, and why, and offers the way to fix it', async ({ page }) => {
    await page.goto('/');

    /* This was a dead end. Boot asked "is there a connection?" — yes, a
       broken one — so it skipped the welcome screen and painted "Could not
       read the schema: No connection is open." A true sentence with nothing
       to click. */
    await expect(page.locator('.welcome-trouble')).toBeVisible();
    await expect(page.locator('.welcome-trouble')).toContainText('One connection is configured');
    await expect(page.locator('.welcome-trouble')).toContainText('broken');
    await expect(page.locator('.welcome-trouble')).toContainText('unable to open database file');

    await page.getByRole('button', { name: 'Open connections' }).click();
    await expect(page.locator('.conn-manager')).toBeVisible();
  });

  test('and still offers the ordinary way in', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('button', { name: 'Connect a database' })).toBeVisible();
  });
});

test.describe('the tour', () => {
  test('opens once on a first visit, and remembers being dismissed', async ({ page }) => {
    await page.goto(`/${DEMO}`);

    const card = page.getByRole('dialog', { name: 'The database you are on' });
    await expect(card).toBeVisible();
    await expect(page.locator('.tour-step')).toHaveText('1 of 6');

    await page.keyboard.press('Escape');
    await expect(page.locator('.tour-card')).toHaveCount(0);

    /* The point of the whole feature: it is shown once. A tour that returns
       on every load is the thing people mean when they complain about tours. */
    await page.reload();
    await expect(page.locator('.tour-card')).toHaveCount(0);
  });

  test('walks forward and back, and highlights what it is talking about', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    await expect(page.locator('.tour-card')).toBeVisible();

    /* The ring is drawn over the anchor, so "is it pointing at the right
         thing" is answerable by comparing rectangles rather than by trusting
         that a class was applied.

         Polled, because the ring slides between stops: read immediately after
         a click it is measured in flight, a hundred pixels from either end.
         Waiting for it to arrive is what the assertion is actually about. */
    const ringOver = async (selector: string) => {
      await expect
        .poll(async () => {
          const ring = await page.locator('.tour-ring').boundingBox();
          const anchor = await page.locator(selector).boundingBox();
          if (!ring || !anchor) return -1;
          return Math.max(Math.abs(ring.x - anchor.x), Math.abs(ring.y - anchor.y));
        })
        .toBeLessThan(12);
    };

    /* The picker, not `#db-label`: with more than one connection the label
         is hidden and the picker is what names the database. The stop offers
         both and takes whichever is on screen. */
    await ringOver('#conn-picker');
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await ringOver('.sidebar');
    await page.getByRole('button', { name: 'Back' }).click();
    await ringOver('#conn-picker');

    // Back is not offered on the first stop, because there is nowhere to go.
    await expect(page.getByRole('button', { name: 'Back' })).toBeHidden();
  });

  test('the stop about walking rows points at nothing, on purpose', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    for (let i = 0; i < 3; i += 1) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }

    await expect(page.locator('.tour-step')).toHaveText('4 of 6');
    // An idea, not a control: no ring, and the scrim dims everything evenly.
    await expect(page.locator('.tour-ring')).toBeHidden();
    await expect(page.locator('.tour-scrim')).toHaveClass(/dim/);
  });

  test('the last stop finishes it, and the menu brings it back', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    for (let i = 0; i < 5; i += 1) {
      await page.getByRole('button', { name: 'Next', exact: true }).click();
    }
    await expect(page.locator('.tour-step')).toHaveText('6 of 6');
    // "Skip" and "Done" on the same card would be two buttons for one act.
    await expect(page.getByRole('button', { name: 'Skip' })).toBeHidden();
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.tour-card')).toHaveCount(0);

    /* Findable again. The one thing worse than a tour nobody asked for is one
       that cannot be reopened by somebody who now wants it. */
    await page.locator('#more-button').click();
    /* Nothing has been edited, so a standing "nothing to undo" row would only be a write control on a read-only start. */
    await expect(page.getByRole('menuitem', { name: /Undo the last edit/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /Take the tour/ }).click();
    await expect(page.locator('.tour-card')).toBeVisible();
    await expect(page.locator('.tour-step')).toHaveText('1 of 6');
  });

  test('a click outside ends it rather than advancing', async ({ page }) => {
    await page.goto(`/${DEMO}`);
    await expect(page.locator('.tour-card')).toBeVisible();

    /* Advancing on a stray click is how someone loses the one stop they were
       halfway through reading. */
    await page.locator('.tour-scrim').click({ position: { x: 5, y: 400 } });
    await expect(page.locator('.tour-card')).toHaveCount(0);
  });
});
