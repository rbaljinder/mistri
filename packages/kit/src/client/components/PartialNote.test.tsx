import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { PartialNote } from './PartialNote.js';

afterEach(cleanup);

test('names the labels it could not read, in one quiet line', () => {
  render(<PartialNote table="shipments" partial={[{ reference: 'carrier_id', reason: 'network' }]} />);
  expect(screen.getByRole('status')).toHaveTextContent('Carrier labels unavailable — showing the stored keys.');
});

test('says each reference once, however many columns read through it', () => {
  render(
    <PartialNote
      table="shipments"
      partial={[
        { reference: 'carrier_id', reason: 'timeout' },
        { reference: 'carrier_id', reason: 'timeout' },
        { reference: 'depot', reason: 'unavailable' },
      ]}
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('Carrier, Depot labels unavailable');
});
