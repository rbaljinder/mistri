/**
 * The report desk as a moderator reads it: the open reports oldest first, the pick kept in the address, and the picked
 * report's record beside the queue, titled by its post; a desk with nothing reported draws no records.
 */
import '@testing-library/jest-dom/vitest';
import { fireEvent, waitFor, within } from '@testing-library/react';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import { state } from '@mistriwork/kit/client/core.js';
import page from './report-queue.page.tsx';

/* The block reads the App's catalog, which a rendered page has none of: the report table and the post it names. */
const column = (name: string, primaryKey = false) => ({
  name,
  type: ['id', 'post_id'].includes(name) ? 'INTEGER' : 'TEXT',
  nullable: !primaryKey,
  primaryKey,
});
(state as { schema: unknown }).schema = {
  tables: [
    {
      id: 'report',
      name: 'report',
      schema: '',
      isView: false,
      columns: ['id', 'post_id', 'reason', 'details', 'status', 'created_at'].map((name) => column(name, name === 'id')),
    },
    { id: 'post', name: 'post', schema: '', isView: false, columns: ['id', 'body'].map((name) => column(name, name === 'id')) },
  ],
  foreignKeys: [{ from: { table: 'report', column: 'post_id' }, to: { table: 'post', column: 'id' } }],
};

const viewer = { signedIn: true, account: 'moderator' };
const report = [
  {
    id: 12,
    post_id: 4,
    reason: 'spam',
    details: 'A link to a store.',
    status: 'open',
    created_at: '2026-11-06T10:00:00Z',
    'post_id.body': 'Great build!! Get 80% off',
  },
  {
    id: 15,
    post_id: 9,
    reason: 'harassment',
    details: null,
    status: 'open',
    created_at: '2026-11-07T09:00:00Z',
    'post_id.body': 'Nobody asked you',
  },
];

test('lists the open reports with the post each is about, and the pick rides in the address', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ report }) });
  const queue = await view.findByRole('list', { name: 'Open reports' });
  expect(queue.querySelectorAll('li')).toHaveLength(2);
  expect(queue.querySelector('li')).toHaveTextContent('Great build!! Get 80% off');
  expect(queue.querySelector('li')).toHaveTextContent('spam');
  // Reports are anonymous: the reader's details are what tell two reports of one post apart.
  expect(queue.querySelector('li')).toHaveTextContent('A link to a store.');
  const second = view.getByText('Nobody asked you').closest('button')!;
  expect(second).not.toHaveAttribute('aria-current');
  fireEvent.click(second);
  // The pick is the page's param, which the test page keeps as the reader moves, as the address would.
  await waitFor(() => expect(second).toHaveAttribute('aria-current', 'true'));
});

test('a report in the address is open beside the queue, titled by its post', async () => {
  const view = renderPage(page, { viewer, address: { report: '12' }, data: fixtures({ report }) });
  const pane = await view.findByRole('complementary', { name: 'Details' });
  expect(await within(pane).findByRole('heading', { name: 'Great build!! Get 80% off' })).toBeInTheDocument();
  expect(view.getByText('Great build!! Get 80% off', { selector: 'strong span' }).closest('button')).toHaveAttribute(
    'aria-current',
    'true',
  );
});

test('with nothing reported the queue is empty and no record is open', async () => {
  const view = renderPage(page, { viewer, data: fixtures({ report: [] }) });
  const queue = await view.findByRole('list', { name: 'Open reports' });
  expect(queue.querySelectorAll('li')).toHaveLength(0);
  expect(view.container.querySelector('.split-list-detail')).toHaveAttribute('data-selected', 'false');
});
