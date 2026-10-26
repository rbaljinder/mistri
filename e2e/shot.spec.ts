import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from './support/harness';

/**
 * `mistri shot`, run as an agent runs it: the command serves the App
 * itself (a free port, a temporary config directory), drives Chromium and
 * prints each PNG's path. What is checked is what an agent relies on: the
 * files exist and show a page, an address the App does not answer to is
 * refused before anything is served, and the reader's own config directory
 * is never touched.
 *
 * Its own database (mkdtemp) and its own server (a free port): nothing shared.
 */
let directory = '';
let db = '';
/** Stands in for the reader's real config directory: shot must leave it as it found it — absent. */
let realConfig = '';

test.beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'tablewalk-shot-'));
  db = join(directory, 'thread.db');
  const seeded = spawnSync(process.execPath, [resolve('test/fixtures/databases/thread/seed.mjs'), db], { encoding: 'utf8' });
  if (seeded.status !== 0) throw new Error(seeded.stderr);
  realConfig = join(directory, 'real-config');
});
test.afterAll(() => rmSync(directory, { recursive: true, force: true }));

function shot(args: string[]): Promise<{ code: number; out: string; err: string }> {
  return new Promise((done, reject) => {
    execFile(
      process.execPath,
      [
        '--import',
        'tsx',
        resolve('packages/mistri/src/server/index.ts'),
        'shot',
        '--app',
        'test/fixtures/apps/thread',
        '--config',
        `${db}.json`,
        ...args,
      ],
      { timeout: 150_000, killSignal: 'SIGKILL', env: { ...process.env, XDG_CONFIG_HOME: realConfig } },
      (error, out, err) => {
        if (error && (error as { killed?: boolean }).killed) {
          reject(new Error(`mistri shot ${args.join(' ')} did not exit: ${err}`));
          return;
        }
        done({ code: (error as { code?: number } | null)?.code ?? 0, out, err });
      },
    );
  });
}

/** A PNG's width and height, from its header. */
const size = (file: string) => {
  const bytes = readFileSync(file);
  expect(bytes.subarray(1, 4).toString('latin1')).toBe('PNG');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20), bytes: bytes.length };
};

test('shoots a list and a record page at a desk and on a phone, prints each file, and never touches the config directory', async () => {
  test.setTimeout(180_000);
  const out = join(directory, 'shots');
  const ran = await shot(['issues', '/issues/1', '--both', '--out', out]);
  expect(ran.code, ran.err).toBe(0);
  const files = ran.out.trim().split('\n');
  expect(files).toEqual(['issues-desk', 'issues-phone', 'issues-1-desk', 'issues-1-phone'].map((name) => join(out, `${name}.png`)));
  for (const file of files) {
    const picture = size(file);
    expect(picture.width).toBe(file.endsWith('-phone.png') ? 390 : 1280);
    // A blank window compresses to a few kilobytes; a drawn page of rows and chrome does not.
    expect(picture.bytes).toBeGreaterThan(20_000);
  }
  expect(existsSync(realConfig)).toBe(false);
});

test('--scale makes a sharper picture of the same layout, and a scale outside 1 to 3 is refused before anything is served', async () => {
  test.setTimeout(180_000);
  const out = join(directory, 'scaled');
  const ran = await shot(['issues', '--scale', '2', '--out', out]);
  expect(ran.code, ran.err).toBe(0);
  expect(size(join(out, 'issues-desk.png')).width).toBe(2560);
  const refused = await shot(['issues', '--scale', '4', '--out', join(directory, 'refused-scale')]);
  expect(refused.code).toBe(1);
  expect(refused.err).toMatch(/--scale "4" is not a number from 1 to 3/);
  expect(existsSync(join(directory, 'refused-scale'))).toBe(false);
});

test('refuses an address the App does not answer to, naming the ones it does, before serving anything', async () => {
  const ran = await shot(['/nowhere', '--out', join(directory, 'refused')]);
  expect(ran.code).toBe(1);
  expect(ran.err).toMatch(/names no route of "thread": \/nowhere is not one\. Known: .*issues/);
  expect(existsSync(join(directory, 'refused'))).toBe(false);
  // One App is served at the root: another App's address is a route this one does not have.
  const other = await shot(['/forecourt/vehicles']);
  expect(other.code).toBe(1);
  expect(other.err).toMatch(/names no route of "thread": \/forecourt is not one/);
  expect(existsSync(realConfig)).toBe(false);
});

test('a whole page is taller than the window, and a look is named in the file', async () => {
  test.setTimeout(180_000);
  const out = join(directory, 'full');
  mkdirSync(out, { recursive: true });
  // A record page, not the issues list: Sage starts an App compact (ca0a0ed8d), and at
  // that density the list's twenty rows fit a 900px window, so it has nothing to grow by.
  const ran = await shot(['/issues/1', '--full', '--theme', 'sage', '--dark', '--out', out]);
  expect(ran.code, ran.err).toBe(0);
  expect(readdirSync(out)).toEqual(['issues-1-sage-dark-desk.png']);
  expect(size(join(out, 'issues-1-sage-dark-desk.png')).height).toBeGreaterThan(900);
});

test('--phone with --width is a window that wide, --theme names the look in the file, and --compare draws two looks side by side', async () => {
  test.setTimeout(240_000);
  const out = join(directory, 'sized');
  const ran = await shot(['issues', '--phone', '--width', '700', '--theme', 'mono', '--out', out]);
  expect(ran.code, ran.err).toBe(0);
  expect(readdirSync(out)).toEqual(['issues-mono-phone.png']);
  expect(size(join(out, 'issues-mono-phone.png')).width).toBe(700);
  // One window's width: with both sizes it is refused before anything is served.
  const both = await shot(['issues', '--both', '--width', '700', '--out', join(directory, 'refused-width')]);
  expect(both.code).toBe(1);
  expect(both.err).toMatch(/--width sets one window's width; use it with --desk or --phone/);
  expect(existsSync(join(directory, 'refused-width'))).toBe(false);
  // --desk at its own width, the App's look beside Sage in one picture, in --out itself.
  const compared = await shot(['issues', '--desk', '--compare', 'sage', '--out', join(directory, 'compared')]);
  expect(compared.code, compared.err).toBe(0);
  expect(readdirSync(join(directory, 'compared'))).toEqual(['issues-light.png']);
  expect(size(join(directory, 'compared', 'issues-light.png')).width).toBeGreaterThan(2 * 1280 - 1);
});

/* Grown once, to the pane's overflow at the first size, a record page's desk
   shot ended where its main column did: the taller window gave the pane's
   chrome more room (a height in vh), so the aside ran past the new bottom. */
test('a whole page grows until nothing is below, the aside beside a shorter main column included', async ({ page }) => {
  const { growToContent } = await import('../packages/mistri/src/server/build/shot.ts');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.setContent(`<body style="margin:0;height:100vh;display:flex;flex-direction:column">
    <header style="height:calc(56px + 4vh);flex:none"></header>
    <main id="content" style="flex:1;overflow:auto;display:grid;grid-template-columns:2fr 1fr">
      <section style="height:600px"></section><aside id="aside" style="height:1400px"></aside>
    </main></body>`);
  const height = await growToContent(page, 1280, 900);
  const left = await page.evaluate(() => {
    const pane = document.getElementById('content')!;
    return pane.scrollHeight - pane.clientHeight;
  });
  expect(left).toBeLessThanOrEqual(1);
  // Once, by the first overflow, is 1492: 4vh of it went to the header, and the aside's last 24px stayed below.
  expect(height).toBeGreaterThan(1492);
  expect(await page.evaluate(() => document.getElementById('aside')!.getBoundingClientRect().bottom)).toBeLessThanOrEqual(height + 1);
});
