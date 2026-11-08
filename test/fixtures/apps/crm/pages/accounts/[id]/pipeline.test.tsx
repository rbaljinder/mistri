/**
 * The account's Pipeline tab, drawn on account 13: its open deals in the order they close, none of another
 * account's, and the house empty state where every deal is won or lost.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import page from './pipeline.page.tsx';

const viewer = { signedIn: true, account: 'rep' };
const deal = (id: number, account_id: number, name: string, stage: string, amount: number, close_date: string) => ({
  id,
  account_id,
  name,
  stage,
  amount,
  close_date,
});

test("lists the account's open deals by close date, and none of another account's", async () => {
  const data = fixtures({
    opportunity: [
      deal(1, 13, 'Fleet renewal', 'negotiation', 48000, '2026-10-02'),
      deal(2, 13, 'Pilot rollout', 'prospecting', 12000, '2026-09-12'),
      deal(3, 13, 'Old contract', 'closed_won', 30000, '2026-06-01'),
      deal(4, 7, 'Someone else', 'proposal', 9000, '2026-09-01'),
    ],
  });
  const view = renderPage(page, { viewer, record: { id: 13 }, data });
  const list = await view.findByRole('list', { name: 'Open deals by close date' });
  const items = await view.findAllByRole('listitem');
  expect(items.map((item) => item.textContent)).toEqual([
    expect.stringContaining('Pilot rollout · Prospecting'),
    expect.stringContaining('Fleet renewal · Negotiation'),
  ]);
  expect(list).not.toHaveTextContent('Old contract');
  expect(list).not.toHaveTextContent('Someone else');
});

test('says so when every deal with the account is closed', async () => {
  const data = fixtures({ opportunity: [deal(3, 13, 'Old contract', 'closed_lost', 30000, '2026-06-01')] });
  const view = renderPage(page, { viewer, record: { id: 13 }, data });
  expect(await view.findByText('No open deals')).toBeInTheDocument();
});
