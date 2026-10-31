import { CRM, CRM_DB, expect, test } from './support/ownServers';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * The record page's Save against Compass's root `validation` (preview). The
 * update route refuses a lead converted without a contact with 200
 * `rejected`, naming the failing field; the record marks it the way the New
 * form marks its fields — the message on the field, the draft kept, the
 * focus on the first marked field — and nothing is written. Answered, the
 * same Save writes.
 */
const REFUSED = 'The record does not satisfy the application rules.';
/* The rule's authored message crosses with its field (appValidation.ts). */
const FIELD = 'A converted lead names the contact it became.';

test('a lead converted without a contact is refused on its record, marks the contact, and saves once it is named', async ({ page }) => {
  // The highest such lead: compass-validation.spec.ts converts the lowest.
  const id = Number(
    scalar(CRM_DB, "SELECT id FROM lead WHERE status = 'working' AND converted_contact_id IS NULL ORDER BY id DESC LIMIT 1"),
  );
  const contact = Number(scalar(CRM_DB, 'SELECT id FROM contact ORDER BY id LIMIT 1'));
  const contactName = String(scalar(CRM_DB, 'SELECT name FROM contact WHERE id = ?', contact));
  const stored = (column: string) => scalar(CRM_DB, `SELECT ${column} FROM lead WHERE id = ?`, id);
  try {
    await page.goto(`${CRM}/@lead~${id}`);
    await expect(page.locator('body')).toHaveClass(/app-mode/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(String(stored('name')));

    await page.getByRole('button', { name: 'Edit Status', exact: true }).click();
    await page.getByRole('button', { name: 'Status', exact: true }).click();
    await page.getByRole('option', { name: 'Converted', exact: true }).click();
    const dock = page.getByRole('region', { name: 'Unsaved changes', exact: true });
    await expect(dock).toContainText('1 unsaved change');

    const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/update');
    await dock.getByRole('button', { name: 'Save changes', exact: true }).click();
    const response = await refused;
    expect(response.status()).toBe(422);
    expect(await response.json()).toMatchObject({
      outcome: 'rejected',
      errors: [{ code: 'validation_failed', message: REFUSED, fields: [{ field: 'converted_contact_id', message: FIELD }] }],
    });

    // The contact was never opened: marked, it opens to be answered and takes the focus.
    const contactField = page.getByRole('combobox', { name: /^Converted contact/ });
    await expect(contactField).toHaveAttribute('aria-invalid', 'true');
    await expect(contactField).toHaveAccessibleDescription(FIELD);
    await expect(contactField).toBeFocused();
    await expect(page.locator('.edit-field-error')).toHaveText([FIELD]);
    // Every named field is on the record, so the summary adds nothing; the draft stays.
    await expect(page.getByText(REFUSED)).toHaveCount(0);
    await expect(dock).toContainText('1 unsaved change');
    await expect(page.getByRole('button', { name: 'Status', exact: true })).toContainText('Converted');
    expect(stored('status')).toBe('working');
    expect(stored('converted_contact_id')).toBeNull();

    // Naming the contact is the answer to its mark; the same Save writes both fields.
    await contactField.fill(contactName.split(' ')[0]);
    await page.locator('.picker-option').filter({ hasText: contactName }).first().click();
    await expect(contactField).not.toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('.edit-field-error')).toHaveCount(0);
    const written = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/update');
    await dock.getByRole('button', { name: 'Save changes', exact: true }).click();
    expect((await (await written).json()).errors).toBeUndefined();
    await expect(page.getByRole('region', { name: 'Saved changes', exact: true })).toContainText('Changes saved');
    expect(stored('status')).toBe('converted');
    expect(stored('converted_contact_id')).toBe(contact);
  } finally {
    // The dashboard and list baselines read this database; leave it as seeded.
    if (stored('status') !== 'working' || stored('converted_contact_id') !== null) {
      const restored = await page.request.post(`${CRM}/api/update`, {
        data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'working', converted_contact_id: null } },
      });
      expect((await restored.json()).errors).toBeUndefined();
    }
  }
});
