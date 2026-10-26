import { COMPASS, expect, type Page, test } from './support/ownServers';

// This worker's own Compass (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });
// Each walk is five navigations read frame by frame, after a cold start of the worker's own server.
test.describe.configure({ timeout: 60_000 });

/*
 * A navigation swaps finished screens (docs/design.md, motion rule 9;
 * packages/kit/src/client/navigationHold.ts). List → record painted an empty pane, then a
 * skeleton, then the header, the sections, the aside and the related lists
 * one by one, each pushing the next down; Back painted the list from empty at
 * the top. Every frame from the press on is read here: the reader sees the
 * screen they left or the complete one they asked for, nothing between, and
 * nothing already on screen moves.
 */

interface Frame {
  held: boolean;
  title: string | null;
  loading: number;
  enter: boolean;
}

/** Watch every frame, and every layout shift, from here on. */
async function watch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { frames_: Frame[]; shifts_: Array<{ value: number; nodes: string[] }>; watching_: boolean };
    w.frames_ = [];
    w.shifts_ = [];
    if (!w.watching_) {
      w.watching_ = true;
      /* Every shift, those right after the press included: CLS forgives those,
         and the reader does not. */
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; sources?: Array<{ node?: Node }> }>) {
          w.shifts_.push({
            value: entry.value,
            nodes: (entry.sources ?? []).map((s) => (s.node as Element | undefined)?.className?.toString() ?? '?'),
          });
        }
      }).observe({ type: 'layout-shift' });
      const tick = () => {
        const content = document.getElementById('content');
        const held = Boolean(content?.querySelector(':scope > .nav-held'));
        const room = content ? Array.from(content.children).filter((child) => !child.classList.contains('nav-held')) : [];
        const title = room.map((child) => child.querySelector('.root-current, h1')?.textContent?.trim()).find(Boolean) ?? null;
        const loading = room.reduce((n, child) => n + child.querySelectorAll('.sk-bar, .loading').length, 0);
        const enter = document.getAnimations().some((a) => (a as CSSAnimation).animationName === 'nav-enter');
        w.frames_.push({ held, title, loading, enter });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }
  });
}

async function seen(page: Page) {
  return page.evaluate(() => {
    const w = window as unknown as { frames_: Frame[]; shifts_: Array<{ value: number; nodes: string[] }> };
    return { frames: w.frames_, shifts: w.shifts_ };
  });
}

/** The frames the reader saw of the new room: every one after the held copy went. */
const shown = (frames: Frame[]) => frames.slice(frames.findIndex((f) => f.held) + 1).filter((f) => !f.held);

/** A list's rows as the reader has them: table rows at a desk, record cards on a phone. */
const rowsOf = (page: Page) => page.locator('#content tbody tr.clickable, #content .record-summary-title').locator('visible=true');

async function openList(page: Page) {
  await page.goto(`${COMPASS}/accounts?tab=all`);
  const rows = rowsOf(page);
  await expect(rows.nth(15)).toBeVisible({ timeout: 30_000 });
  // Rows arrive with the page's own settling; the navigation is what is measured.
  await page.waitForTimeout(500);
  return rows;
}

/* A desk window short enough that the fifteenth row is below the fold at a 32px row (--row-h), so the list has
   scrolled before the record opens. */
for (const size of [
  { width: 1280, height: 640 },
  { width: 390, height: 844 },
]) {
  test(`list → record → related record → Back → Back swaps finished screens, with nothing moving (${size.width}px)`, async ({ page }) => {
    await page.setViewportSize(size);
    const rows = await openList(page);
    const pane = page.locator('#content');
    const row = rows.nth(14);
    await row.scrollIntoViewIfNeeded();
    const listScroll = await pane.evaluate((el) => el.scrollTop);
    expect(listScroll).toBeGreaterThan(100);
    const name = (size.width > 600 ? await row.locator('td').first().innerText() : await row.innerText()).split('\n')[0]!.trim();

    await watch(page);
    await row.click();
    await expect(page.locator('.page-head .root-current')).toHaveText(name);
    await expect(page.locator('#content > .nav-held')).toHaveCount(0);
    await page.waitForTimeout(300);
    let { frames, shifts } = await seen(page);
    expect(
      frames.some((f) => f.held),
      'the list was held while the record was asked for',
    ).toBe(true);
    // No frame shows an empty pane or a record still arriving: the header is there from the first frame, and no placeholder.
    expect(
      shown(frames).filter((f) => f.title === null || f.loading > 0),
      'frames of an unfinished record',
    ).toEqual([]);
    expect(shifts, 'layout shifts on list → record').toEqual([]);
    // A record starts at its top, not at the list's scroll.
    expect(await pane.evaluate((el) => el.scrollTop)).toBe(0);
    // A step to a new place taken with the pointer enters, once complete.
    expect(frames.some((f) => f.enter)).toBe(true);

    await watch(page);
    const owner = page.locator('#content .page-head .ref-jump').filter({ hasText: /\w/ }).last();
    const person = (await owner.innerText()).trim();
    await owner.click();
    await expect(page.locator('.page-head .root-current')).toHaveText(person);
    await page.waitForTimeout(300);
    ({ frames, shifts } = await seen(page));
    expect(
      shown(frames).filter((f) => f.title === null || f.loading > 0),
      'frames of an unfinished related record',
    ).toEqual([]);
    expect(shifts, 'layout shifts on record → related record').toEqual([]);

    await watch(page);
    await page.goBack();
    await expect(page.locator('.page-head .root-current')).toHaveText(name);
    await page.waitForTimeout(300);
    ({ frames, shifts } = await seen(page));
    expect(
      shown(frames).filter((f) => f.title === null || f.loading > 0),
      'frames of an unfinished record on Back',
    ).toEqual([]);
    expect(shifts, 'layout shifts on Back to the record').toEqual([]);
    // Back animates nothing.
    expect(frames.some((f) => f.enter)).toBe(false);

    await watch(page);
    await page.goBack();
    await expect(rows.nth(15)).toBeVisible();
    await page.waitForTimeout(300);
    ({ frames, shifts } = await seen(page));
    expect(
      shown(frames).filter((f) => f.loading > 0),
      'frames of a list still arriving on Back',
    ).toEqual([]);
    expect(shifts, 'layout shifts on Back to the list').toEqual([]);
    // The list comes back where the reader left it.
    expect(Math.abs((await pane.evaluate((el) => el.scrollTop)) - listScroll)).toBeLessThanOrEqual(2);
  });
}

test('the screen held is the screen that was there, to the pixel', async ({ page }) => {
  const rows = await openList(page);
  const row = rows.nth(14);
  await row.scrollIntoViewIfNeeded();
  // No hover or press state on the row: the picture is of the list as it stood.
  await page.mouse.move(1, 1);
  const pane = await page.locator('#content').boundingBox();
  const clip = { x: pane!.x, y: pane!.y, width: pane!.width, height: Math.min(pane!.height, 720 - pane!.y) };
  // Compare the initial hold before its intentional 300ms waiting fade.
  // A busy CI screenshot must not advance that timer while capturing it.
  const now = new Date();
  await page.clock.install({ time: now });
  await page.clock.pauseAt(now);
  const before = await page.screenshot({ clip, animations: 'disabled' });
  // The record is slow to come, so the hold is still up when the picture is taken.
  await page.route('**/api/**', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue().catch(() => {});
  });
  await row.evaluate((element) => element.click());
  await expect(page.locator('#content > .nav-held')).toHaveCount(1);
  const held = await page.screenshot({ clip, animations: 'disabled' });
  /* Compared in a blank page of its own (the App's policy is not asked to
     admit a data: address): a pixel differs when its channels move by more
     than antialiasing does. */
  const scratch = await page.context().newPage();
  const share = await scratch.evaluate(
    async ([a, b]) => {
      const read = async (data: string) => {
        const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const [x, y] = await Promise.all([read(a), read(b)]);
      let differing = 0;
      for (let i = 0; i < x.length; i += 4)
        if (Math.abs(x[i]! - y[i]!) + Math.abs(x[i + 1]! - y[i + 1]!) + Math.abs(x[i + 2]! - y[i + 2]!) > 24) differing++;
      return differing / (x.length / 4);
    },
    [before.toString('base64'), held.toString('base64')],
  );
  await scratch.close();
  if (share >= 0.0005) {
    await test.info().attach('before-hold', { body: before, contentType: 'image/png' });
    await test.info().attach('held-screen', { body: held, contentType: 'image/png' });
  }
  expect(share, 'the held picture differs from the list it replaced').toBeLessThan(0.0005);
  await page.clock.resume();
  // And the record still comes, complete.
  await expect(page.locator('#content > .nav-held')).toHaveCount(0);
  await expect(page.locator('.page-head .root-current')).toBeVisible();
});

test('with reduced motion, and from the keyboard, a record arrives without moving', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  let rows = await openList(page);
  await watch(page);
  await rows.nth(3).click();
  await expect(page.locator('.page-head .root-current')).toBeVisible();
  await page.waitForTimeout(300);
  let { frames } = await seen(page);
  expect(frames.some((f) => f.held)).toBe(true);
  expect(
    frames.some((f) => f.enter),
    'reduced motion silences the enter',
  ).toBe(false);

  // A phone's list is buttons, which the keyboard presses as it would any.
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.setViewportSize({ width: 390, height: 844 });
  rows = await openList(page);
  await watch(page);
  await rows.nth(4).focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/accounts\/\d+$/);
  await expect(page.locator('.page-head .root-current')).toBeVisible();
  await page.waitForTimeout(300);
  ({ frames } = await seen(page));
  expect(
    frames.some((f) => f.enter),
    'keyboard navigation animates nothing',
  ).toBe(false);
});
