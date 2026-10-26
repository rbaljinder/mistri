import { expect, test, type Page } from './support/harness';
import { DEPOT_ADMIN, startSample } from './support/sampleServer';
import { scalar } from './support/db';

/* The two inputs a display rule gives a column that is not typed as text — a code the camera reads (`scan`) and a
   signature drawn on a pad (`signature`) — filled in a real browser and saved, each read back from the database.
   Depot holds both: a product's UPC and a pick list's proof of delivery. The scan is the typed path (a browser
   under test has no camera); the camera's own decoding is the unit test's (builtInInputs.test.tsx). */
test.describe('scan and signature fields', () => {
  test.setTimeout(180_000);

  const signIn = async (page: Page, origin: string) => {
    const login = await page.request.post(`${origin}/api/auth/sign-in/email`, { headers: { origin }, data: DEPOT_ADMIN });
    expect(login.ok()).toBe(true);
  };

  test('a code typed into a scan field and a signature drawn on the pad are saved on their records', async ({ page }) => {
    const sample = await startSample('depot');
    try {
      await signIn(page, sample.origin);
      /* Scan is drawn only where the browser reads codes: Chromium on macOS has BarcodeDetector, the Linux runner's
         does not. A stand-in that is never asked to read keeps the button on both; this test types the code. */
      await page.addInitScript(() => {
        if (!('BarcodeDetector' in window)) (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {};
      });

      // A product's UPC: the box beside Scan takes the code as a reader at the bench would type it.
      const product = Number(scalar(sample.db, 'SELECT id FROM product ORDER BY id LIMIT 1'));
      await page.goto(`${sample.origin}/products/${product}`);
      // The first page of a fresh server compiles the client: give it the time the cold start takes.
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
      await page.getByRole('button', { name: /^Edit UPC/ }).click();
      await expect(page.getByRole('button', { name: 'Scan', exact: true })).toBeVisible();
      await page.getByRole('textbox', { name: 'UPC', exact: true }).fill('036000291452');
      // Depot saves explicitly: the change waits in the dock until Save changes.
      await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT upc FROM product WHERE id = ?', product)).toBe('036000291452');

      // A pick list signed for at the dock: a stroke on the pad, kept as a picture, the list pointing at it.
      const list = Number(scalar(sample.db, 'SELECT id FROM pick_list WHERE signature_id IS NULL ORDER BY id LIMIT 1'));
      const signatures = Number(scalar(sample.db, 'SELECT count(*) FROM delivery_signature'));
      await page.goto(`${sample.origin}/pick-lists/${list}`);
      await page.getByRole('button', { name: 'Edit Signed for' }).click();
      const pad = page.getByRole('img', { name: 'Sign here: Signed for' });
      await expect(pad).toBeVisible();
      await pad.scrollIntoViewIfNeeded();
      const box = (await pad.boundingBox())!;
      await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * 0.6);
      await page.mouse.down();
      for (const [x, y] of [
        [0.3, 0.3],
        [0.45, 0.7],
        [0.6, 0.35],
        [0.8, 0.55],
      ])
        await page.mouse.move(box.x + box.width * x, box.y + box.height * y, { steps: 4 });
      await page.mouse.up();
      await page.getByRole('button', { name: 'Use this signature', exact: true }).click();
      await expect(page.getByRole('img', { name: 'Signed for: the kept signature' })).toBeVisible();
      await page.getByRole('region', { name: 'Unsaved changes' }).getByRole('button', { name: 'Save changes', exact: true }).click();
      await expect.poll(() => scalar(sample.db, 'SELECT signature_id FROM pick_list WHERE id = ?', list)).not.toBeNull();
      const kept = scalar(sample.db, 'SELECT signature_id FROM pick_list WHERE id = ?', list);
      expect(Number(scalar(sample.db, 'SELECT count(*) FROM delivery_signature'))).toBe(signatures + 1);
      expect(scalar(sample.db, 'SELECT content_type FROM delivery_signature WHERE id = ?', kept)).toBe('image/png');
      expect(Number(scalar(sample.db, 'SELECT byte_size FROM delivery_signature WHERE id = ?', kept))).toBeGreaterThan(200);
    } finally {
      await sample.stop();
    }
  });
});
