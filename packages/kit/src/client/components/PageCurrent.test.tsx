/**
 * A current card says the facts its `show` names, in that order, and none of
 * the columns the read carried only to name the row; its title is the name
 * the page hands it (the parent's name left out), while opening the record
 * still carries the whole name for the breadcrumb.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const visit: TableMeta = {
  id: 'visit',
  name: 'visit',
  schema: '',
  isView: false,
  columns: [
    { name: 'id', type: 'INTEGER', nullable: false, primaryKey: true },
    { name: 'reason', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'scheduled_at', type: 'TEXT', nullable: true, primaryKey: false },
    { name: 'provider', type: 'TEXT', nullable: true, primaryKey: false },
  ],
};
const opened = vi.hoisted(() => [] as unknown[][]);
vi.mock('../core.js', () => ({
  columnLabel: () => null,
  labelPath: () => '$label',
  openRecord: (...args: unknown[]) => {
    opened.push(args);
  },
  state: { schema: { tables: [], foreignKeys: [] } },
}));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span>{String(value)}</span> }));
vi.mock('./columnPresentation.js', () => ({ presentationColumns: () => new Map() }));

const { CurrentCard } = await import('./PageCurrent.js');
afterEach(() => {
  cleanup();
  opened.length = 0;
});

const row = { id: 7, reason: 'Rash', scheduled_at: '2026-10-17', provider: 'Dr. Webb' };

test('says the facts its show names, in order, and not the column read to name the row', () => {
  render(
    <CurrentCard
      table={visit}
      caption="Next visit"
      row={row}
      columns={['reason', 'scheduled_at', 'provider', 'id']}
      show={['provider', 'scheduled_at']}
      record={{ key: { id: 7 }, label: 'Noah Fischer · Telehealth' }}
      title="Telehealth"
      noun="visit"
      empty={null}
    />,
  );
  const terms = [...document.querySelectorAll('.page-card-fact dt')].map((term) => term.textContent);
  expect(terms).toEqual(['Provider', 'Scheduled at']);
  expect(screen.queryByText('Rash')).toBeNull();
});

test('is titled by the name it is given, and opens the record by its whole name', async () => {
  render(
    <CurrentCard
      table={visit}
      caption="Next visit"
      row={row}
      columns={['reason']}
      record={{ key: { id: 7 }, label: 'Noah Fischer · Telehealth' }}
      title="Telehealth"
      noun="visit"
      empty={null}
    />,
  );
  const name = screen.getByRole('button', { name: 'Telehealth' });
  expect(screen.queryByText('Noah Fischer · Telehealth')).toBeNull();
  await userEvent.click(name);
  expect(opened[0]).toEqual(['visit', { id: 7 }, 'Noah Fischer · Telehealth']);
});

test('without a show, says every column but the name and the key', () => {
  render(
    <CurrentCard
      table={visit}
      row={row}
      columns={['id', 'reason', 'provider']}
      record={{ key: { id: 7 }, label: 'Rash' }}
      noun="visit"
      empty={null}
    />,
  );
  expect([...document.querySelectorAll('.page-card-fact dt')].map((term) => term.textContent)).toEqual(['Reason', 'Provider']);
});

test('named as the page is, says no name of its own, and still opens from its foot', async () => {
  render(
    <CurrentCard
      table={visit}
      caption="Review file"
      row={row}
      columns={['provider']}
      show={['provider']}
      record={{ key: { id: 7 }, label: 'AL-1006' }}
      title={null}
      noun="review file"
      empty={null}
    />,
  );
  expect(screen.queryByText('AL-1006')).toBeNull();
  expect(document.querySelector('.page-card-title')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'View review file' }));
  expect(opened[0]).toEqual(['visit', { id: 7 }, 'AL-1006']);
});
