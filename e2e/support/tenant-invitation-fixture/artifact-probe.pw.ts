import { test, expect, invitationArtifactOptions } from '../invitationTest.js';

test.use(invitationArtifactOptions);

// Deliberately failing, opt-in diagnostic probe, not a normal browser test.
// A non-secret sentinel stands in for both issuer handoff and recipient input.
test('secret-bearing failure report probe', async ({ page }) => {
  expect(process.env.PLAYWRIGHT_NO_COPY_PROMPT).toBe('1');
  await page.setContent('<label>Handoff<input></label><label>Recipient<input type="password"></label>');
  const sentinel = ['invitation', 'artifact', 'sentinel'].join('-');
  await page.getByLabel('Handoff').fill(sentinel);
  await page.getByLabel('Recipient').fill(sentinel);
  throw new Error('Intentional invitation artifact probe failure');
});
