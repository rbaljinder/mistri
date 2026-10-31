import { expect, test, type Page } from './support/harness';
import { COMMONS_ADMIN, confirmEmail, startSample } from './support/sampleServer';
import { DatabaseSync } from 'node:sqlite';
import { scalar } from './support/db';

/**
 * Commons, the forum sample: what a signed-out reader reads, what a member
 * writes and may not, and what a moderator decides from the queue. Every
 * write is a command, so each check reads the database it wrote.
 */
const threadId = (db: string, title: string) => Number(scalar(db, 'SELECT id FROM thread WHERE title = ?', title));

/** Sign up and follow the confirmation link: Commons' sign-up is open, so `me` waits for a proven address. */
async function signUp(page: Page, sample: { origin: string; log: () => string }, email: string) {
  const answer = await page.request.post(`${sample.origin}/api/auth/sign-up/email`, {
    headers: { origin: sample.origin },
    data: { name: email.split('@')[0], email, password: 'disposable-commons-member-password' },
  });
  expect(answer.ok(), await answer.text()).toBe(true);
  await confirmEmail(page.request, sample.log, email);
}

/** Join through the signed-in form: a handle and a name. */
async function join(page: Page, origin: string, handle: string, name: string) {
  await page.goto(`${origin}/@form-join`);
  await page.getByLabel('Handle', { exact: false }).fill(handle);
  await page.getByLabel('Your name', { exact: false }).fill(name);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(page.getByText('Welcome to Commons', { exact: true })).toBeVisible();
}

/** Run a record's command from its toolbar, on a desk or under More on a phone. */
async function openAction(page: Page, label: string) {
  const button = page.getByRole('button', { name: label, exact: true });
  const more = page.getByRole('button', { name: 'More actions', exact: true });
  await expect(button.or(more).first()).toBeVisible();
  if (await button.isVisible()) await button.click();
  else {
    await more.click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  }
  return page.getByRole('dialog', { name: label });
}

test.describe('Commons', () => {
  let sample: Awaited<ReturnType<typeof startSample>>;
  test.setTimeout(120_000);
  test.beforeEach(async () => {
    sample = await startSample('commons');
  });
  test.afterEach(async () => {
    await sample?.stop();
  });

  test("the front list's heads are whole: a figure's label is not covered or cut by controls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${sample.origin}/latest`);
    await expect(page.locator('th .th-label').first()).toBeVisible();
    const heads = await page.evaluate(() =>
      [...document.querySelectorAll('th')]
        .filter((th) => th.querySelector('.th-label'))
        .map((th) => {
          const label = th.querySelector('.th-label') as HTMLElement;
          const box = label.getBoundingClientRect();
          const y = box.top + box.height / 2;
          const owner = (x: number) => !!document.elementFromPoint(x, y)?.closest('.th-label, .th-sort');
          return {
            name: label.textContent,
            left: owner(box.left + 2),
            right: owner(box.right - 2),
            cut: label.scrollWidth > label.clientWidth,
          };
        }),
    );
    expect(heads.length).toBeGreaterThan(1);
    for (const h of heads) expect(h, `${h.name} head`).toMatchObject({ left: true, right: true, cut: false });
  });

  test('a signed-out reader reads the front page, a thread and a post, and sees no moderation', async ({ page }) => {
    await page.goto(`${sample.origin}/`);
    await expect(page.getByRole('heading', { name: 'Where makers show their work' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Fresh from Show & Tell' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Moderation/ })).toHaveCount(0);
    // A board's card says what belongs there under its name, the whole line kept in its title.
    const help = page.locator('.cards-card', { has: page.getByRole('heading', { name: 'Help Desk' }) }).locator('.cards-description');
    await expect(help).toHaveText(/^Stuck on a build\? Say what you tried/);
    await expect(help).toHaveAttribute('title', 'Stuck on a build? Say what you tried, what you expected and what happened instead.');
    const id = threadId(sample.db, 'Weather station, version three');
    await page.goto(`${sample.origin}/latest/~${id}`);
    await expect(page.getByRole('heading', { name: 'Weather station, version three', level: 1 })).toBeVisible();
    await expect(page.getByText('The backwards USB port is a rite of passage.').first()).toBeVisible();
    // The storefront: no sign-in screen over it, no history, no command a visitor cannot run.
    await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'History' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Reply', exact: true })).toHaveCount(0);
    // A report is anyone's to send, from the post, anonymously.
    const post = Number(scalar(sample.db, 'SELECT id FROM post WHERE thread_id = ? AND opening = 1', id));
    await page.goto(`${sample.origin}/@post~${post}`);
    await page.getByRole('link', { name: 'Report this post' }).click();
    const form = page.getByRole('dialog');
    await expect(form.getByLabel('Post number', { exact: false })).toHaveValue(String(post));
    // Five reasons: a listbox rather than radios.
    await form.getByRole('button', { name: 'Reason (required)', exact: true }).click();
    await page.getByRole('option', { name: 'Off topic', exact: true }).click();
    await form.getByRole('button', { name: 'Send report', exact: true }).click();
    await expect(form.getByText('Thanks for telling us')).toBeVisible();
    expect(scalar(sample.db, "SELECT COUNT(*) FROM report WHERE post_id = ? AND reason = 'off_topic' AND status = 'open'", post)).toBe(1);
  });

  for (const width of [1440, 390]) {
    test(`${width}px: a member joins, replies, and cannot edit someone else's post`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const email = `maker-${width}@example.test`;
      await signUp(page, sample, email);
      await join(page, sample.origin, `maker${width}`, 'Morgan Maker');
      const accountMember = Number(scalar(sample.db, 'SELECT id FROM member WHERE handle = ?', `maker${width}`));
      expect(scalar(sample.db, 'SELECT account_id IS NOT NULL FROM member WHERE id = ?', accountMember)).toBe(1);

      const id = threadId(sample.db, 'Solar LoRa node: how big a panel?');
      await page.goto(`${sample.origin}/latest/~${id}`);
      const reply = await openAction(page, 'Reply');
      await reply.getByLabel('Your reply', { exact: false }).fill('Two cells and a 1 W panel ran mine through a gray November.');
      await reply.getByRole('button', { name: 'Reply', exact: true }).click();
      await expect(reply.getByRole('status')).toHaveAttribute('data-phase', 'success');
      expect(
        scalar(
          sample.db,
          "SELECT COUNT(*) FROM post WHERE thread_id = ? AND author_id = ? AND status = 'published' AND body LIKE 'Two cells%'",
          id,
          accountMember,
        ),
      ).toBe(1);

      // Someone else's post: the button is there (the handler, not the page, knows whose post it is), and the server refuses.
      const theirs = Number(scalar(sample.db, 'SELECT id FROM post WHERE thread_id = ? AND opening = 1', id));
      const before = String(scalar(sample.db, 'SELECT body FROM post WHERE id = ?', theirs));
      await page.goto(`${sample.origin}/@post~${theirs}`);
      const edit = await openAction(page, 'Edit post');
      await edit.getByLabel('Post', { exact: false }).fill('Rewritten by somebody else.');
      await edit.getByRole('button', { name: 'Edit post', exact: true }).click();
      await expect(edit.getByText('Only the member who wrote a post can edit it.')).toBeVisible();
      expect(scalar(sample.db, 'SELECT body FROM post WHERE id = ?', theirs)).toBe(before);
      expect(scalar(sample.db, 'SELECT COUNT(*) FROM post_revision WHERE post_id = ?', theirs)).toBe(0);
    });
  }

  test('the post stream: a member reacts from a chip and takes it back; a visitor reads the counts and a profile head', async ({
    page,
    browser,
  }) => {
    const id = threadId(sample.db, 'Weather station, version three');
    const opening = Number(scalar(sample.db, 'SELECT id FROM post WHERE thread_id = ? AND opening = 1', id));
    const likes = () => Number(scalar(sample.db, "SELECT COUNT(*) FROM reaction WHERE post_id = ? AND kind = 'like'", opening));
    // Signed out: the stream and a member's head draw from the public grant alone, and offer no reaction to press.
    const visitor = await browser.newPage();
    await visitor.goto(`${sample.origin}/latest/~${id}`);
    const stream = visitor.locator('[data-component="post-stream"]');
    await expect(stream.locator('.c-post-stream-post').first()).toContainText('@priya');
    await expect(stream.getByRole('button', { name: /^Like/ })).toHaveCount(0);
    await expect(stream.getByRole('button', { name: /^Report / }).first()).toBeVisible();
    const author = Number(scalar(sample.db, 'SELECT author_id FROM post WHERE id = ?', opening));
    await visitor.goto(`${sample.origin}/@member~${author}`);
    // The record header: the name with its portrait, the team and town under it, from the public grant alone.
    const head = visitor.locator('.page-head');
    await expect(head.getByRole('heading', { level: 1 })).toHaveText('Priya Raman');
    await expect(head.locator('.page-head-facts')).toBeVisible();
    await expect(head.locator('img.page-record-avatar')).toBeVisible();
    await expect(visitor.locator('[data-section-error]')).toHaveCount(0);
    await visitor.close();

    await signUp(page, sample, 'reactor@example.test');
    await join(page, sample.origin, 'reactor', 'Rae Actor');
    await page.goto(`${sample.origin}/latest/~${id}`);
    const first = page.getByRole('group', { name: "Reactions to Priya Raman's post" }).first();
    const like = first.getByRole('button', { name: /^Like/ });
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    const before = likes();
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'true');
    expect(likes()).toBe(before + 1);
    await like.click();
    await expect(like).toHaveAttribute('aria-pressed', 'false');
    expect(likes()).toBe(before);
    await expect(page.locator('[data-section-error]')).toHaveCount(0);
  });

  test('a signed-in account that has not joined is offered Join to react, joins over the post, and reacts there', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await signUp(page, sample, 'newcomer@example.test');
    const id = threadId(sample.db, 'Weather station, version three');
    const opening = Number(scalar(sample.db, 'SELECT id FROM post WHERE thread_id = ? AND opening = 1', id));
    const thanks = () => Number(scalar(sample.db, "SELECT COUNT(*) FROM reaction WHERE post_id = ? AND kind = 'thanks'", opening));
    await page.goto(`${sample.origin}/latest/~${id}`);
    const first = page.getByRole('group', { name: "Reactions to Priya Raman's post" }).first();
    // Before any click: the counts to read and one way on, never a chip the handler would refuse.
    const joinToReact = first.getByRole('button', { name: "Join to react to Priya Raman's post" });
    await expect(joinToReact).toBeVisible();
    await expect(first.getByRole('button', { name: /^(Like|Thanks|Helpful)/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Join to reply to / }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Reply to / })).toHaveCount(0);
    // Where the reader is, in the address the App settled on.
    const address = page.url();
    await joinToReact.click();
    const form = page.getByRole('dialog', { name: 'Join Commons' });
    await form.getByLabel('Handle', { exact: false }).fill('newcomer');
    await form.getByLabel('Your name', { exact: false }).fill('Nia Comer');
    await form.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(form.getByText('Welcome to Commons', { exact: true })).toBeVisible();
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(form).toHaveCount(0);
    // Back on the same post, the controls live: no toast, no join, a chip to press.
    expect(page.url()).toBe(address);
    await expect(first.getByRole('button', { name: /^Join to / })).toHaveCount(0);
    const chip = first.getByRole('button', { name: /^Thanks/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'false');
    const before = thanks();
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(thanks()).toBe(before + 1);
    await expect(page.getByRole('button', { name: /^Reply to / }).first()).toBeVisible();
    await expect(page.getByText('Join Commons first', { exact: false })).toHaveCount(0);
    await expect(page.locator('[data-section-error]')).toHaveCount(0);
  });

  test('a reply the stream opened and the server refused opens again, prepared afresh', async ({ page }) => {
    await signUp(page, sample, 'twice@example.test');
    await join(page, sample.origin, 'twice', 'Tess Wice');
    const id = threadId(sample.db, 'Solar LoRa node: how big a panel?');
    const standing = (to: string) => {
      const db = new DatabaseSync(sample.db);
      try {
        db.exec('PRAGMA busy_timeout = 5000');
        db.prepare("UPDATE member SET standing = ? WHERE handle = 'twice'").run(to);
      } finally {
        db.close();
      }
    };
    await page.goto(`${sample.origin}/latest/~${id}`);
    const replyTo = page.getByRole('button', { name: /^Reply to / }).first();
    await replyTo.click();
    const form = page.getByRole('dialog', { name: 'Reply' });
    await form.getByLabel('Your reply', { exact: false }).fill('A first try, sent while the account is suspended.');
    // Suspended between opening and sending: the server refuses, in its words.
    const was = String(scalar(sample.db, "SELECT standing FROM member WHERE handle = 'twice'"));
    standing('suspended');
    await form.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(form.getByRole('status')).toContainText('suspended');
    await page.keyboard.press('Escape');
    await expect(form).toHaveCount(0);
    standing(was);
    // The same button, no reload: the form prepares the record again and sends.
    await replyTo.click();
    await expect(form.getByRole('button', { name: 'Reply', exact: true })).toBeEnabled();
    await expect(form.getByRole('status')).not.toContainText('could not be prepared');
    await form.getByLabel('Your reply', { exact: false }).fill('A second try, once the thread is open again.');
    await form.getByRole('button', { name: 'Reply', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(Number(scalar(sample.db, "SELECT COUNT(*) FROM post WHERE thread_id = ? AND body LIKE 'A second try%'", id))).toBe(1);
  });

  test("a thread's history names who wrote by name, never by email", async ({ page }) => {
    const [thread, name] = String(
      scalar(
        sample.db,
        `SELECT json_extract(key_json, '$.id') || '|' || actor_name FROM __mistri_history_change
      WHERE resource = 'thread' AND actor_name <> '' ORDER BY id DESC LIMIT 1`,
      ),
    ).split('|');
    await signUp(page, sample, 'reader@example.test');
    await page.goto(`${sample.origin}/latest/~${thread}`);
    const history = page.locator('.history-entry').first();
    await expect(history.locator('.history-by')).toHaveText(name);
    await expect(page.locator('.history-by', { hasText: '@' })).toHaveCount(0);
    await expect(page.getByText(/@commons\.example\.test/)).toHaveCount(0);
  });

  test("390px: a fields section's one column stays one column, as at a desk", async ({ page }) => {
    const signIn = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
      headers: { origin: sample.origin },
      data: COMMONS_ADMIN,
    });
    expect(signIn.ok(), await signIn.text()).toBe(true);
    await page.setViewportSize({ width: 390, height: 844 });
    const report = Number(scalar(sample.db, 'SELECT id FROM report ORDER BY id LIMIT 1'));
    await page.goto(`${sample.origin}/reports/${report}`);
    const post = page.locator('.page-section', { has: page.getByRole('button', { name: 'The post', exact: true }) });
    const fields = post.locator('.page-field');
    await expect(fields.first()).toBeVisible();
    const lefts = await fields.evaluateAll((all) => all.map((field) => Math.round(field.getBoundingClientRect().left)));
    expect(lefts.length).toBeGreaterThan(1);
    expect(new Set(lefts).size).toBe(1);
  });

  test('a moderator removes a reported post from the queue', async ({ page }) => {
    const signIn = await page.request.post(`${sample.origin}/api/auth/sign-in/email`, {
      headers: { origin: sample.origin },
      data: COMMONS_ADMIN,
    });
    expect(signIn.ok(), await signIn.text()).toBe(true);
    const spam = Number(scalar(sample.db, "SELECT id FROM post WHERE body LIKE 'Great build!! Get 80%'"));
    const words = String(scalar(sample.db, 'SELECT body FROM post WHERE id = ?', spam));
    await page.goto(`${sample.origin}/queue`);
    const queue = page.getByRole('grid', { name: 'Moderation queue' });
    await queue.getByRole('row', { name: /Great build!! Get 80%/ }).click();
    const toolbar = page.getByRole('toolbar', { name: 'Selected records' });
    await expect(toolbar).toContainText('1 selected');
    await toolbar.getByRole('button', { name: 'Remove post', exact: true }).click();
    const form = page.getByRole('dialog', { name: 'Remove post' });
    await form.getByLabel('Note for the moderators', { exact: false }).fill('Advertising on a build thread.');
    await form.getByRole('button', { name: 'Remove post', exact: true }).click();
    await expect(form.getByRole('status')).toHaveAttribute('data-phase', 'success');
    expect(scalar(sample.db, 'SELECT status FROM post WHERE id = ?', spam)).toBe('hidden');
    expect(scalar(sample.db, 'SELECT body FROM post WHERE id = ?', spam)).toBe('This post was removed by the moderators.');
    // The words are the moderators' now, and the report is closed as actioned.
    expect(scalar(sample.db, 'SELECT body FROM removal WHERE post_id = ?', spam)).toBe(words);
    expect(scalar(sample.db, "SELECT COUNT(*) FROM report WHERE post_id = ? AND status = 'open'", spam)).toBe(0);
    await form.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(queue.getByRole('row', { name: /Great build!! Get 80%/ })).toHaveCount(0);
  });
});
