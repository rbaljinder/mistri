import { type ChildProcess } from 'node:child_process';
import { spawn } from './support/spawned';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test } from './support/harness';
import { scalar } from './support/db';

/**
 * A rich text column end to end: typed and formatted in the editor, saved,
 * stored as sanitized HTML, drawn again from it; a paste from an office suite
 * cleaned before it is kept; and a value written behind the App's back with a
 * script in it drawn as words, never run. The database is asked what was
 * stored, never the screen alone.
 *
 * A server of its own over a fresh database (listen(0), mkdtemp).
 */
let origin = '';
let db = '';
let directory = '';
let child: ChildProcess | undefined;

test.beforeAll(async () => {
  // A describe-level timeout does not cover this hook (Playwright): the fixture started here needs its own.
  test.setTimeout(120_000);
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-rich-text-browser-'));
  db = join(directory, 'desk.db');
  const source = new DatabaseSync(db);
  try {
    source.exec(`
      CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT);
      INSERT INTO ticket VALUES (1, 'Planted',
        '<p onclick="window.__pwned = 1">Planted <script>window.__pwned = 2</script><img src="x" onerror="window.__pwned = 3">' ||
        '<a href="javascript:window.__pwned = 4">click me</a></p><iframe src="javascript:window.__pwned = 5"></iframe>');`);
  } finally {
    source.close();
  }
  const config = join(directory, 'connections.json');
  writeFileSync(config, JSON.stringify({ connections: [{ name: 'desk', url: db, writable: true }] }));
  const appDirectory = join(directory, 'app');
  mkdirSync(appDirectory);
  writeFileSync(
    join(appDirectory, 'app.json'),
    JSON.stringify({
      id: 'desk',
      name: 'Desk',
      connection: 'desk',
      resources: {
        ticket: { access: 'write', labels: { title: 'Title', body: 'Body' }, display: { body: { format: 'richText' } } },
      },
      views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets', show: ['title', 'body'] } },
      pages: { ticket: { base: 'ticket', sections: [{ kind: 'fields', show: ['title', 'body'] }] } },
      home: 'tickets',
      nav: ['tickets'],
    }),
  );
  const reservation = createServer();
  await new Promise<void>((done) => reservation.listen(0, '127.0.0.1', done));
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((done) => reservation.close(() => done()));
  origin = `http://127.0.0.1:${port}`;
  const started = spawn(
    process.execPath,
    ['--import', 'tsx', 'packages/mistri/src/server/index.ts', '--config', config, '--app', appDirectory, '--port', String(port)],
    {
      cwd: resolve('.'),
      env: { ...process.env, DATABASE_URL: '', XDG_CONFIG_HOME: join(directory, 'xdg'), MISTRI_OPEN: '0' },
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
    const timer = setTimeout(() => fail(new Error(`The fixture did not start: ${log}`)), 20_000);
    const ready = () => {
      if (log.includes('Listening on ')) {
        clearTimeout(timer);
        done();
      }
    };
    started.stdout!.on('data', ready);
    started.once('exit', () => {
      clearTimeout(timer);
      fail(new Error(`The fixture exited: ${log}`));
    });
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null) {
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
});

const stored = (title: string) => String(scalar(db, `SELECT body FROM ticket WHERE title = '${title}'`) ?? '');

test('rich text is typed, formatted, saved as sanitized HTML and drawn again from it', async ({ page }) => {
  await page.goto(`${origin}/tickets`);
  await expect(page.locator('body')).toHaveClass(/app-mode/);
  await page.getByRole('button', { name: /^\+ New/ }).click();
  const form = page.locator('.newpanel');
  await form.getByLabel('Title', { exact: true }).fill('Typed');
  const editor = form.getByRole('textbox', { name: 'Body' });
  await editor.click();
  await page.keyboard.type('Hello ');
  const bold = form.getByRole('button', { name: 'Bold', exact: true });
  await bold.click();
  await page.keyboard.type('world');
  await bold.click();
  // Markdown's own shortcuts: a dash starts a list, backticks make code.
  await page.keyboard.press('Enter');
  await page.keyboard.type('- first `item`');
  await expect(editor.locator('ul li')).toHaveText('first item');
  await expect(editor.locator('ul li code')).toHaveText('item');
  await expect(form.getByRole('toolbar', { name: /Body/ })).toBeVisible();
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => stored('Typed')).toBe('<p>Hello <strong>world</strong></p><ul><li><p>first <code>item</code></p></li></ul>');
  const id = Number(scalar(db, "SELECT id FROM ticket WHERE title = 'Typed'"));
  await page.goto(`${origin}/tickets/${id}`);
  const drawn = page.locator('.rich-text').first();
  await expect(drawn.locator('strong')).toHaveText('world');
  await expect(drawn.locator('ul li')).toHaveText('first item');
  // The list shows one line of its words.
  await page.goto(`${origin}/tickets`);
  await expect(page.locator('tbody .rich-text-excerpt', { hasText: /^Hello world · - first item$/ })).toBeVisible();
});

test('a paste from Word is cleaned of its office markup and anything unsafe before it is kept', async ({ page }) => {
  await page.goto(`${origin}/tickets`);
  await page.getByRole('button', { name: /^\+ New/ }).click();
  const form = page.locator('.newpanel');
  await form.getByLabel('Title', { exact: true }).fill('Pasted');
  const editor = form.getByRole('textbox', { name: 'Body' });
  await editor.click();
  await editor.evaluate((element) => {
    const data = new DataTransfer();
    data.setData(
      'text/html',
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><style>p.MsoNormal{color:red}</style></head><body>' +
        '<!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]-->' +
        '<p class="MsoNormal" style="color:red" onclick="window.__pwned = 1"><b>Agenda</b><o:p></o:p></p>' +
        '<p>Read <a href="javascript:window.__pwned = 2">this</a><script>window.__pwned = 3</script></p></body></html>',
    );
    data.setData('text/plain', 'Agenda\nRead this');
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(editor.locator('strong')).toHaveText('Agenda');
  await form.getByRole('button', { name: 'Add', exact: true }).click();
  await expect.poll(() => stored('Pasted')).toBe('<p><strong>Agenda</strong></p><p>Read this</p>');
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
});

test('a value written behind the App’s back with a script in it is drawn as words, and nothing runs', async ({ page }) => {
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await page.goto(`${origin}/tickets/1`);
  const drawn = page.locator('.rich-text').first();
  await expect(drawn).toContainText('Planted');
  await expect(drawn).toContainText('click me');
  await expect(drawn.locator('script, iframe, img, a, [onclick], [onerror]')).toHaveCount(0);
  await drawn.getByText('click me').click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as { __pwned?: number }).__pwned)).toBeUndefined();
  expect(dialogs).toEqual([]);
});
