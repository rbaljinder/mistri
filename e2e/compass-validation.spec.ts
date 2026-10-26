import { CRM, CRM_DB, expect, type Locator, test } from './support/ownServers';
import { DatabaseSync } from 'node:sqlite';
import { scalar } from './support/db';

// This worker's own servers (support/ownServers.ts), so the spec runs in the parallel lane.
test.use({ servers: ['crm'] });

/**
 * Compass's root `validation` (preview): resource invariants the server
 * checks against the stored row after every insert and update, whichever
 * surface wrote it. A refusal rolls the write back and answers like a
 * database constraint: 200 with a `rejected` outcome naming the failing
 * fields, each with the rule's authored message — written to be said to the
 * person, it crosses with its field; the condition and the value never do —
 * so the form keeps its values, marks the field, stores nothing, and the
 * corrected save writes.
 */
const REFUSED = 'The record does not satisfy the application rules.';
const CLOSE_RULE = 'A deal cannot close before it was created.';
const LEAD_RULE = 'A converted lead names the contact it became.';

/* The picker's options are drawn in the enclosing panel, not inside the field. */
async function pick(form: Locator, field: Locator, text: string): Promise<void> {
  await field.locator('.picker-input').fill(text);
  await form.locator('.picker-option').first().click();
  await expect(form.locator('.picker-option')).toHaveCount(0);
}

test('a deal that closes before it was created is refused, keeps the form, and is written only once corrected', async ({ page }) => {
  const resizeWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().startsWith('validation-resize-warning:')) resizeWarnings.push(message.text());
  });
  await page.addInitScript(() => {
    const NativeObserver = window.ResizeObserver;
    let nextObserver = 0;
    let phase = 'initial';
    const identity = (target: EventTarget | null) =>
      target instanceof Element ? `${target.tagName}#${target.id}.${target.getAttribute('class') ?? ''}` : '';
    for (const type of ['pointerdown', 'focusin', 'submit']) {
      window.addEventListener(
        type,
        (event) => {
          phase = `${type}:${identity(event.target)}`;
        },
        true,
      );
    }
    const recent: Array<{ observer: number; at: number; phase: string; stack?: string; targets: unknown[] }> = [];
    window.ResizeObserver = class extends NativeObserver {
      constructor(callback: ResizeObserverCallback) {
        const stack = new Error().stack;
        const id = ++nextObserver;
        super((entries, observer) => {
          recent.push({
            observer: id,
            at: performance.now(),
            phase,
            stack,
            targets: entries.map((entry) => ({
              target: identity(entry.target),
              connected: entry.target.isConnected,
              content: [entry.contentRect.width, entry.contentRect.height],
              border: Array.from(entry.borderBoxSize ?? [], (box) => [box.inlineSize, box.blockSize]),
              parent: identity(entry.target.parentElement),
              vars:
                entry.target instanceof HTMLElement
                  ? ['--anchor-width', '--available-width', '--available-height'].map((name) => [
                      name,
                      entry.target.style.getPropertyValue(name),
                    ])
                  : [],
            })),
          });
          // Entry sizes and inline variables only: no extra layout reads or scheduled work.
          if (recent.length > 24) recent.shift();
          callback(entries, observer);
        });
      }
    };
    window.addEventListener('error', (event) => {
      if (event.message.includes('ResizeObserver'))
        console.info(`validation-resize-warning:${JSON.stringify({ message: event.message, recent })}`);
      // Observe only; do not hide the browser warning or suppress Vite's report.
    });
  });
  const name = `Validation rule deal ${Date.now()}`;
  const stored = () => Number(scalar(CRM_DB, 'SELECT count(*) FROM opportunity WHERE name = ?', name));
  const account = String(scalar(CRM_DB, 'SELECT name FROM account WHERE id = 1'));
  const owner = String(scalar(CRM_DB, 'SELECT name FROM sales_rep WHERE id = 1'));
  let key: Record<string, unknown> | undefined;
  try {
    await page.goto(`${CRM}/opportunity`);
    await expect(page.locator('body')).toHaveClass(/app-mode/);
    await page.getByRole('button', { name: '+ New opportunity' }).click();
    const form = page.locator('.newpanel');
    await expect(form.getByRole('heading')).toHaveText('New opportunity');
    const field = (label: string) =>
      form.locator('.insert-field').filter({ has: page.locator('label', { hasText: new RegExp(`^${label}\\*?$`) }) });

    await field('Opportunity').locator('input').fill(name);
    await pick(form, field('Account'), account.split(' ')[0]);
    await pick(form, field('Owner'), owner.split(' ')[0]);
    // A moment is captioned by what happened, its `_on` dropped (42297f25): created_on is "Created".
    await field('Created').locator('input').fill('2026-09-04');
    await field('Close date').locator('input').fill('2026-09-01');

    const refused = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const response = await refused;
    expect(response.status()).toBe(200);
    expect(await response.json()).toMatchObject({
      outcome: 'rejected',
      errors: [{ code: 'validation_failed', message: REFUSED, fields: [{ field: 'close_date', message: CLOSE_RULE }] }],
    });
    // The client's own required checks passed; the server's rule marks the one field it names.
    await expect(form.locator('.insert-field.missing')).toHaveCount(1);
    await expect(field('Close date').locator('.insert-missing')).toHaveText(CLOSE_RULE);
    await expect(field('Close date').locator('input')).toHaveValue('09/01/2026');
    expect(stored()).toBe(0);

    // Corrected, the same form writes.
    await field('Close date').locator('input').fill('2026-10-30');
    const written = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/insert');
    await form.getByRole('button', { name: 'Add', exact: true }).click();
    const result = await (await written).json();
    expect(result.errors).toBeUndefined();
    key = result.key;
    expect(key?.id).toBeDefined();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    expect(stored()).toBe(1);
    expect(scalar(CRM_DB, 'SELECT close_date FROM opportunity WHERE id = ?', key!.id as number)).toBe('2026-10-30');
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(resizeWarnings, 'form validation must not cause resize-observer feedback').toEqual([]);
  } finally {
    // The dashboard and list baselines read this database; leave it as seeded.
    if (key) {
      const removed = await page.request.post(`${CRM}/api/delete`, { data: { app: 'compass', table: 'opportunity', key, confirm: true } });
      expect((await removed.json()).deleted).toBe(true);
    }
  }
});

test('the won machine move requires its probability stamp and refuses a move out of a final state', async ({ page }) => {
  const id = Number(scalar(CRM_DB, "SELECT id FROM opportunity WHERE stage = 'negotiation' AND probability < 100 ORDER BY id LIMIT 1"));
  const probability = Number(scalar(CRM_DB, 'SELECT probability FROM opportunity WHERE id = ?', id));
  const update = (values: Record<string, unknown>) =>
    page.request.post(`${CRM}/api/update`, {
      data: { app: 'compass', table: 'opportunity', key: { id }, values },
    });
  const refused = await update({ stage: 'closed_won' });
  expect(refused.status()).toBe(400);
  expect(await refused.json()).toMatchObject({ code: 'validation_failed' });
  expect(scalar(CRM_DB, 'SELECT stage FROM opportunity WHERE id = ?', id)).toBe('negotiation');
  // At 100 the same move writes.
  expect((await (await update({ stage: 'closed_won', probability: 100 })).json()).errors).toBeUndefined();
  expect(scalar(CRM_DB, 'SELECT stage FROM opportunity WHERE id = ?', id)).toBe('closed_won');
  // Won is final in the deal's machine: no write takes it back, so the seed is put back beside the server.
  const back = await update({ stage: 'negotiation', probability });
  expect(JSON.stringify(await back.json())).toContain("moves only by its machine's verbs");
  expect(scalar(CRM_DB, 'SELECT stage FROM opportunity WHERE id = ?', id)).toBe('closed_won');
  const db = new DatabaseSync(CRM_DB);
  try {
    db.prepare("UPDATE opportunity SET stage = 'negotiation', probability = ? WHERE id = ?").run(probability, id);
  } finally {
    db.close();
  }
});

test('the lead rule holds on the update route: converting without a contact is refused, with one it writes', async ({ page }) => {
  const id = Number(scalar(CRM_DB, "SELECT id FROM lead WHERE status = 'working' AND converted_contact_id IS NULL ORDER BY id LIMIT 1"));
  const refused = await page.request.post(`${CRM}/api/update`, {
    data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'converted' } },
  });
  expect(refused.status()).toBe(200);
  expect(await refused.json()).toMatchObject({
    outcome: 'rejected',
    errors: [{ code: 'validation_failed', message: REFUSED, fields: [{ field: 'converted_contact_id', message: LEAD_RULE }] }],
  });
  expect(scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id)).toBe('working');
  // Naming the contact satisfies the rule; put the seed back afterwards.
  const contact = Number(scalar(CRM_DB, 'SELECT id FROM contact ORDER BY id LIMIT 1'));
  const converted = await page.request.post(`${CRM}/api/update`, {
    data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'converted', converted_contact_id: contact } },
  });
  expect((await converted.json()).errors).toBeUndefined();
  expect(scalar(CRM_DB, 'SELECT status FROM lead WHERE id = ?', id)).toBe('converted');
  const restored = await page.request.post(`${CRM}/api/update`, {
    data: { app: 'compass', table: 'lead', key: { id }, values: { status: 'working', converted_contact_id: null } },
  });
  expect((await restored.json()).errors).toBeUndefined();
});
