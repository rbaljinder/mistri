/**
 * The designed list and dashboard, drawn on fixture rows: the leads list (a person in the first cell) and the sales
 * dashboard (its deals table). The lead page reads its record from a page param a fixture does not set, so
 * e2e/crm-designed.spec.ts draws it.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import leads from './leads.page.tsx';
import sales from './sales-dashboard.page.tsx';

const viewer = { signedIn: true, account: 'rep' };
const row = (id: number, name: string, status: string) => ({
  id,
  name,
  company: `${name} Co`,
  email: `${name.toLowerCase()}@example.com`,
  phone: null,
  status,
  source: 'web',
  created_on: '2026-09-01',
  'owner_id.name': 'Rae',
});

test('the leads list draws each lead as a person with a status', async () => {
  const data = fixtures({ lead: [row(1, 'Ana', 'new'), row(2, 'Ben', 'working')] });
  const view = renderPage(leads, { viewer, data });
  expect(await view.findByRole('table', { name: 'Leads' })).toBeInTheDocument();
  expect(await view.findByText('Ana Co')).toBeInTheDocument();
  expect(view.getByText('Ben')).toBeInTheDocument();
});

test('the sales dashboard lists the largest open deals', async () => {
  const data = fixtures({
    opportunity: [
      {
        id: 1,
        name: 'Fleet renewal',
        stage: 'negotiation',
        amount: 48000,
        close_date: '2026-10-02',
        'account_id.name': 'Acme',
        'owner_id.name': 'Rae',
      },
    ],
  });
  const view = renderPage(sales, { viewer, data });
  expect(await view.findByText('Fleet renewal')).toBeInTheDocument();
});
