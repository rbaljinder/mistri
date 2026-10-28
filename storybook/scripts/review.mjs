/** Review the real story previews, including their theme and responsive layout. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const origin = process.env.STORYBOOK_URL || 'http://localhost:6006';
const output = new URL('../.artifacts/', import.meta.url);
const filter = process.env.STORYBOOK_FILTER || '';
const looks = (process.env.STORYBOOK_LOOKS || 'workshop,lumen,sage').split(',');
const response = await fetch(`${origin}/index.json`);
assert(response.ok, `Storybook index returned ${response.status}`);
const index = await response.json();
const stories = Object.values(index.entries).filter((entry) => entry.type === 'story' && entry.id.includes(filter));
assert(stories.length, 'No matching stories');
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
try {
  const page = await browser.newPage();
  let errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const look of looks)
    for (const width of [1440, 390])
      for (const mode of ['light', 'dark']) {
        await page.setViewportSize({ width, height: 1000 });
        for (const story of stories) {
          errors = [];
          try {
            await page.goto(`${origin}/iframe.html?id=${story.id}&viewMode=story&globals=look:${look};mode:${mode}`);
            await page.waitForFunction(
              () =>
                (document.body.classList.contains('sb-show-main') && document.querySelector('#storybook-root')?.children.length) ||
                document.querySelector('.sb-errordisplay')?.checkVisibility(),
              undefined,
              { timeout: 15000 },
            );
            await page.evaluate(() => document.fonts.ready);
            // Fixture reads take150ms; allow their loading states to settle before measuring.
            await page.waitForTimeout(500);
            const measured = await page.evaluate(() => ({
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
              error: document.querySelector('.sb-errordisplay')?.checkVisibility()
                ? document.querySelector('.sb-errordisplay').textContent
                : null,
              look: document.documentElement.dataset.visualTheme,
              mode: document.documentElement.dataset.theme,
            }));
            assert.equal(measured.look, look, 'Preview has the requested theme');
            assert.equal(measured.mode, mode, 'Preview has the requested color mode');
            assert.equal(measured.overflow, false, 'Document overflows horizontally');
            assert.equal(measured.error, null, 'Storybook reported a render failure');
            assert.deepEqual(errors, [], 'Uncaught browser errors');
            await page.screenshot({ path: new URL(`${story.id}-${look}-${mode}-${width}.png`, output).pathname, fullPage: true });
            results.push({ id: story.id, width, look, mode, passed: true });
          } catch (error) {
            results.push({ id: story.id, width, look, mode, passed: false, error: error.message, browserErrors: [...errors] });
          }
          console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${story.id} ${look}/${mode} ${width}`);
        }
      }
} finally {
  const report = filter ? `review-${filter.replace(/[^a-z0-9_-]/gi, '_')}.json` : 'review.json';
  await writeFile(new URL(report, output), JSON.stringify(results, null, 2));
  await browser.close();
}
const failures = results.filter((result) => !result.passed);
console.log(`${results.length - failures.length}/${results.length} render/layout checks passed. Artifacts: ${output.pathname}`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exitCode = 1;
}
