import { execFile, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from './support/harness';
import { alikeNotes, pictureDifferences } from '../packages/mistri/src/server/build/shot';

/**
 * TC9: `shot --recipes` measures how far apart each pair of a part's values
 * draws a page, in the browser that took the pictures, and names the pairs
 * nothing on the page shows apart. Three pictures drawn here: two the same but
 * for one small mark, one plainly different; and one of another size, which is
 * never compared.
 *
 * The first test serves nothing: the pictures are drawn with setContent. The
 * second runs `mistri shot` as an author runs it, under tsx, over its own
 * database (mkdtemp) on a free port of its own.
 */
test('a sheet’s pictures are compared pixel by pixel, and only the near-alike pairs are named', async ({ page, browser }) => {
  await page.setViewportSize({ width: 400, height: 300 });
  const draw = async (html: string) => {
    await page.setContent(`<body style="margin:0;background:#fff;font:16px sans-serif">${html}</body>`);
    return { png: await page.screenshot() };
  };
  const card = '<div style="margin:40px;padding:20px;border:1px solid #ddd">A card on a lane</div>';
  const plain = await draw(card);
  const marked = await draw(`${card}<div style="position:absolute;left:0;top:0;width:10px;height:10px;background:#000"></div>`);
  const different = await draw('<div style="height:300px;background:#123"></div>');
  const smaller = await (async () => {
    await page.setViewportSize({ width: 200, height: 300 });
    return draw(card);
  })();

  const pairs = await pictureDifferences(browser, [plain, plain, marked, different, smaller]);
  const share = (a: number, b: number) => pairs.find((pair) => pair.a === a && pair.b === b)?.share;
  expect(share(0, 1)).toBe(0);
  // 100 of 120,000 pixels: under the one percent the sheet calls alike.
  expect(share(0, 2)).toBeCloseTo(100 / 120_000, 4);
  expect(share(0, 3)).toBeGreaterThan(0.9);
  expect(pairs.some((pair) => pair.b === 4)).toBe(false);

  const notes = alikeNotes('recipes.board', '/orders', ['ruled', 'soft', 'marked', 'strip', 'small'], pairs);
  expect(notes).toEqual([
    expect.stringMatching(/^note: recipes\.board ruled and soft draw \/orders the same/),
    expect.stringMatching(/^note: recipes\.board (ruled|soft) and marked draw \/orders nearly alike: 0\.08% of the picture differs/),
    expect.stringMatching(/^note: recipes\.board (ruled|soft) and marked draw \/orders nearly alike/),
  ]);
});

test('shot --recipes on a page that draws nothing of the part says so once, beside the sheet', async () => {
  test.setTimeout(180_000);
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-recipe-alike-'));
  try {
    const db = join(directory, 'thread.db');
    const seeded = spawnSync(process.execPath, [resolve('test/fixtures/databases/thread/seed.mjs'), db], { encoding: 'utf8' });
    expect(seeded.status, seeded.stderr).toBe(0);
    const out = join(directory, 'shots');
    const ran = await new Promise<{ code: number; out: string; err: string }>((done) =>
      execFile(
        process.execPath,
        [
          ...['--import', 'tsx', resolve('packages/mistri/src/server/index.ts'), 'shot', '--app', 'test/fixtures/apps/thread'],
          ...['--config', `${db}.json`, 'issues', '--recipes', 'steps', '--out', out],
        ],
        { timeout: 150_000, killSignal: 'SIGKILL', env: { ...process.env, XDG_CONFIG_HOME: join(directory, 'xdg') } },
        (error, stdout, stderr) => done({ code: (error as { code?: number } | null)?.code ?? 0, out: stdout, err: stderr }),
      ),
    );
    expect(ran.code, ran.err).toBe(0);
    const sheet = ran.out.trim().split('\n').at(-1)!.split('  ')[0]!;
    expect(existsSync(sheet), ran.out).toBe(true);
    // An issue list has no breakdown drawn as steps: one note, not three pairs "the same".
    const notes = ran.err.split('\n').filter((line) => line.startsWith('note:'));
    expect(notes).toEqual([
      expect.stringMatching(/^note: no value of recipes\.steps changes \S*issues: nothing on it is drawn by that part\./),
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
