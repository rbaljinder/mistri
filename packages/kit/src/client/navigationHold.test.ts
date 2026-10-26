import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/* The module keeps the pane it was installed on and the last screen shown,
   as the shell does for a page's life: each test starts it afresh. */
type Hold = typeof import('./navigationHold.js');
type Work = typeof import('./pendingWork.js');
let hold: Hold;
let work: Work;
let pane: HTMLElement;
let reading = false;
let told: () => void = () => {};

const list = { kind: 'table', table: 'account' };
const record = { kind: 'page', table: 'account', pageId: 'account', key: { id: 52 } };
const other = { kind: 'page', table: 'sales_rep', pageId: 'sales_rep', key: { id: 11 } };

/** Draw a room the way React would: the pane's children replaced. */
function draw(html: string) {
  for (const child of Array.from(pane.children)) if (!child.classList.contains('nav-held')) child.remove();
  pane.insertAdjacentHTML('afterbegin', html);
}

/** A paint as core.render() makes one: hold, draw, then let the hold watch. */
function paint(entry: object, html: string, depth = 1, room = true) {
  hold.beforePaint(room, entry, depth);
  draw(html);
  hold.afterPaint(entry, depth);
}

const frames = (n: number) => {
  for (let i = 0; i < n; i++) vi.advanceTimersToNextFrame();
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance'] });
  vi.resetModules();
  hold = await import('./navigationHold.js');
  work = await import('./pendingWork.js');
  pane = document.createElement('main');
  pane.id = 'content';
  document.body.append(pane);
  reading = false;
  hold.installNavigationHold(pane, {
    busy: () => reading,
    watch: (changed) => {
      told = changed;
      return () => {};
    },
  });
  window.history.replaceState(null, '', '/compass/accounts');
  paint(
    list,
    '<div class="crumbs-host"><nav class="crumbs">Accounts</nav></div><div class="applist-host"><h1 id="title">Accounts</h1><input name="q" value="x"></div>',
  );
  frames(5);
  await Promise.resolve();
});

afterEach(() => {
  pane.remove();
  vi.clearAllTimers();
  vi.useRealTimers();
});

test('a navigation keeps a still copy of the screen it leaves until the new room is complete', () => {
  pane.scrollTop = 439;
  window.history.pushState(null, '', '/compass/accounts/52');
  // The press that opened it: a pointer, so the arrival may enter.
  window.dispatchEvent(new Event('pointerdown'));
  paint(
    record,
    '<div class="crumbs-host"><nav class="crumbs">Accounts › Clearwater</nav></div><div class="panel-pad"><h1>Clearwater</h1></div>',
    2,
  );
  // The room asks for its record.
  const request = work.beginWork();

  const copy = pane.querySelector<HTMLElement>('.nav-held')!;
  expect(copy).not.toBeNull();
  expect(copy.getAttribute('aria-hidden')).toBe('true');
  expect(copy.inert).toBe(true);
  // The picture of the list, drawn where no lookup reaches: the page has one title, one field.
  const picture = hold.heldPicture()!;
  expect(picture.textContent).toContain('Accounts');
  expect(picture.classList.contains('nav-holding')).toBe(false);
  expect(copy.textContent).toBe('');
  expect(document.querySelectorAll('input')).toHaveLength(0);
  expect(picture.querySelector('[name]')).toBeNull();
  expect((picture.querySelector('input') as HTMLInputElement).value).toBe('x');
  expect(pane.classList.contains('nav-holding')).toBe(true);
  // A step taken with the pointer moves no focus into the room: it is hidden outright.
  expect(pane.classList.contains('nav-holding-focusable')).toBe(false);
  expect(hold.holding()).toBe(true);

  frames(5);
  expect(hold.holding()).toBe(true);
  request();
  frames(2);
  expect(hold.holding()).toBe(true);
  frames(1);
  expect(hold.holding()).toBe(false);
  expect(pane.querySelector('.nav-held')).toBeNull();
  expect(pane.classList.contains('nav-holding')).toBe(false);
  // A new place starts at the top, and enters.
  expect(pane.scrollTop).toBe(0);
  expect(pane.classList.contains('nav-enter')).toBe(true);
});

test('work begun before the navigation never holds the new room', () => {
  const old = work.beginWork();
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  frames(5);
  expect(hold.holding()).toBe(false);
  old();
});

test('a read that is running, or that just changed, holds it as a request does', () => {
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  reading = true;
  frames(4);
  expect(hold.holding()).toBe(true);
  reading = false;
  told();
  frames(2);
  expect(hold.holding()).toBe(true);
  frames(2);
  expect(hold.holding()).toBe(false);
});

test('past the budget the copy is dimmed and the pane busy; at the cap the room is shown as it stands', () => {
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  const request = work.beginWork();
  vi.advanceTimersByTime(hold.BUDGET - 1);
  expect(pane.querySelector('.nav-held')!.classList.contains('nav-held-waiting')).toBe(false);
  vi.advanceTimersByTime(1);
  expect(pane.querySelector('.nav-held')!.classList.contains('nav-held-waiting')).toBe(true);
  expect(pane.getAttribute('aria-busy')).toBe('true');
  vi.advanceTimersByTime(hold.CAP - hold.BUDGET);
  expect(hold.holding()).toBe(false);
  expect(pane.hasAttribute('aria-busy')).toBe(false);
  request();
});

test('any input ends the hold at once: nothing waits on it', () => {
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  const request = work.beginWork();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j' }));
  expect(hold.holding()).toBe(false);
  expect(pane.querySelector('.nav-held')).toBeNull();
  request();
});

test('a key opens a record without motion, and a refinement keeps its place and scroll', () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  // From the keyboard the room takes the focus as it is drawn, so it is held transparent, not hidden.
  expect(pane.classList.contains('nav-holding-focusable')).toBe(true);
  frames(5);
  expect(hold.holding()).toBe(false);
  expect(pane.classList.contains('nav-enter')).toBe(false);

  pane.scrollTop = 120;
  window.dispatchEvent(new Event('pointerdown'));
  // The same record drawn again (a write that repaints): held, kept where it was, no enter.
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1><p>saved</p></div>', 2);
  expect(pane.classList.contains('nav-holding-focusable')).toBe(true);
  frames(5);
  expect(pane.classList.contains('nav-holding-focusable')).toBe(false);
  expect(pane.scrollTop).toBe(120);
  expect(pane.classList.contains('nav-enter')).toBe(false);
});

test('Back returns to where the reader was on that screen, without motion', () => {
  pane.scrollTop = 439;
  window.history.pushState(null, '', '/compass/accounts/52');
  window.dispatchEvent(new Event('pointerdown'));
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  frames(5);
  expect(pane.scrollTop).toBe(0);

  window.history.pushState(null, '', '/compass/accounts');
  window.dispatchEvent(new PopStateEvent('popstate'));
  paint(list, '<div class="applist-host"><h1>Accounts</h1></div>', 1);
  frames(5);
  expect(pane.scrollTop).toBe(439);
  expect(pane.classList.contains('nav-enter')).toBe(false);
});

test('a paint that keeps its room holds nothing', () => {
  paint(list, '<div class="applist-host"><h1>Accounts</h1></div>', 1, false);
  expect(hold.holding()).toBe(false);
  expect(pane.querySelector('.nav-held')).toBeNull();
});

test('a room that redirects as it opens is one navigation: one copy, and the step still starts at the top', () => {
  pane.scrollTop = 300;
  // A refinement of the list first (kept where it is), then the room it redirects to: a new place.
  paint({ ...list }, '<div class="applist-host"></div>', 1);
  paint(other, '<div class="panel-pad"><h1>Nia</h1></div>', 2);
  expect(pane.querySelectorAll('.nav-held')).toHaveLength(1);
  expect(hold.heldPicture()!.textContent).toContain('Accounts');
  frames(5);
  expect(pane.scrollTop).toBe(0);
});

test('a room still drawing itself is still arriving: a commit into it starts the quiet count again', async () => {
  paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
  frames(3);
  // React draws the next slice of the room: the sections a plan enabled.
  pane.querySelector('.panel-pad')!.insertAdjacentHTML('beforeend', '<section class="page-section">Company</section>');
  await Promise.resolve();
  frames(2);
  expect(hold.holding()).toBe(true);
  frames(2);
  expect(hold.holding()).toBe(false);
});

test('a stylesheet a part links as it loads is read then, so the next navigation still holds', async () => {
  /* The published client links a part's stylesheet when the part is first
     drawn. Read only at the next press, it was still on its way, and that
     navigation went unheld: the related record painted into an empty pane. */
  // happy-dom's own load of the file would go to a server there is none of.
  const settings = (
    window as unknown as { happyDOM: { settings: { disableCSSFileLoading: boolean; handleDisabledFileLoadingAsSuccess: boolean } } }
  ).happyDOM.settings;
  const loading = [settings.disableCSSFileLoading, settings.handleDisabledFileLoadingAsSuccess] as const;
  settings.disableCSSFileLoading = true;
  settings.handleDisabledFileLoadingAsSuccess = true;
  const fetched: string[] = [];
  vi.stubGlobal('fetch', async (url: URL) => {
    fetched.push(String(url));
    return new Response('.part{color:red}');
  });
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = '/assets/part.css';
  document.head.append(link);
  try {
    await Promise.resolve();
    link.dispatchEvent(new Event('load'));
    expect(fetched, 'read when it loaded, before any press').toContain(new URL('/assets/part.css', document.baseURI).href);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    window.history.pushState(null, '', '/compass/accounts/52');
    paint(record, '<div class="panel-pad"><h1>Clearwater</h1></div>', 2);
    expect(hold.holding()).toBe(true);
  } finally {
    link.remove();
    vi.unstubAllGlobals();
    [settings.disableCSSFileLoading, settings.handleDisabledFileLoadingAsSuccess] = loading;
  }
});
