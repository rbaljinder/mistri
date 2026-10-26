/**
 * The per-field half of a refusal: one shape check for the New form and the
 * record page, and the update attempt that carries it to the record page.
 */
import { expect, test } from 'vitest';

const { safeFieldErrors } = await import('./fieldErrors.js');
const { createUpdateAttempts } = await import('./updateAttempts.js');

const FIELD = 'This value does not meet the application rules.';

test('named fields are kept in order, from `fields` and a single `field`, each once', () => {
  expect(
    safeFieldErrors([
      {
        message: 'Refused.',
        fields: [
          { field: 'converted_contact_id', message: FIELD },
          { field: 'status', message: 'Pick one.' },
        ],
      },
      { message: 'Also.', field: 'status' },
      { message: 'Single.', field: 'close_date' },
    ]),
  ).toEqual([
    { field: 'converted_contact_id', message: FIELD },
    { field: 'status', message: 'Pick one.' },
    { field: 'close_date', message: 'Single.' },
  ]);
});

test('untrusted names and messages that could not be a field and its message are dropped; a row-defined field is kept', () => {
  expect(
    safeFieldErrors([
      {
        message: 'Refused.',
        fields: [
          { field: 'has space', message: FIELD },
          { field: 'dotted.path.twice', message: FIELD },
          { field: 'specs.bad key', message: FIELD },
          { field: '.capacity', message: FIELD },
          { field: 'specs.capacity', message: 'Enter a number.' },
          { field: `bel${String.fromCharCode(7)}l`, message: FIELD },
          { field: '', message: FIELD },
          { field: 'x'.repeat(257), message: FIELD },
          { field: 'blank', message: '   ' },
          { field: 'long', message: 'm'.repeat(257) },
          { field: 42, message: FIELD } as never,
          { field: 'fine', message: 7 } as never,
          null as never,
        ],
      },
    ]),
  ).toEqual([{ field: 'specs.capacity', message: 'Enter a number.' }]);
  expect(safeFieldErrors([null as never, { message: 'No fields.' }])).toEqual([]);
});

test('a rejected update carries the checked fields; one without them is unchanged', async () => {
  const attempts = createUpdateAttempts();
  const owner = { connection: 'crm', table: 'lead', key: { id: 1 } };
  await expect(
    attempts.run(owner, { status: 'converted' }, async () => ({
      outcome: 'rejected',
      errors: [
        {
          code: 'validation_failed',
          message: 'The record does not satisfy the application rules.',
          fields: [
            { field: 'converted_contact_id', message: FIELD },
            { field: 'bad name', message: FIELD },
          ],
        },
      ],
    })),
  ).resolves.toEqual({
    kind: 'rejected',
    message: 'The record does not satisfy the application rules.',
    fields: [{ field: 'converted_contact_id', message: FIELD }],
  });
  await expect(
    attempts.run(owner, { status: 'x' }, async () => ({ outcome: 'rejected', errors: [{ message: 'Constraint refused' }] })),
  ).resolves.toEqual({ kind: 'rejected', message: 'Constraint refused' });
});
