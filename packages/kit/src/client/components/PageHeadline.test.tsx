/**
 * A record's headline: the figure large with its caption said to assistive
 * technology, the facts under their captions, and calls to action that open
 * a room in place or a public form at its own address — never a link to
 * nowhere.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PageHeadlineAction } from '../../../../engine/src/shared/pageModel.js';
import { configureAppTargetLinks } from '../../../../mistri/src/client/appTargetLinks.js';
import { establishSessionIdentity, lockSessionIdentity } from '../sessionIdentity.js';
import { installShell, shell } from '../shellMode.js';

const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { activeConnection: 'forecourt' } }));
vi.mock('../core.js', () => ({
  api: mocks.api,
  state: mocks.state,
  columnDisplay: () => null,
  columnLabel: (_t: string, column: string) => (({ mileage: 'Miles' }) as Record<string, string>)[column] ?? null,
}));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span className="value">{String(value)}</span> }));
vi.mock('./viewLink.js', () => ({
  viewLink: (key: string) => (key === 'vehicles' ? { href: '/forecourt/vehicles:vehicle' } : undefined),
  formLink: (key: string) => ({ href: `/forecourt/form/${key}` }),
}));
const { PageHeadline } = await import('./PageHeadline.js');

const row = { price: 24995, year: 2025, mileage: 8610, fuel: 'Hybrid' };
function draw(actions: PageHeadlineAction[]) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <PageHeadline tableId="vehicle" row={row} paths={['price', 'year', 'mileage', 'fuel']} column={() => undefined} actions={actions} />
    </QueryClientProvider>,
  );
}
/* A call to action into another App is the App shell's to draw (appnav.js names it). */
beforeEach(async () => {
  const { AppTargetAction } = await import('../../../../mistri/src/client/components/AppTargetAction.js');
  installShell({ slots: { ...shell().slots, TargetAction: AppTargetAction } });
});
beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ forms: [{ id: 'inquire' }] });
});
afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
});

test('the figure first, its caption said but not shown, then each fact under its caption', () => {
  const { container } = draw([]);
  const figure = container.querySelector('.page-headline-figure')!;
  expect(figure).toHaveTextContent('Price: 24995');
  expect(figure.querySelector('.visually-hidden')).toHaveTextContent('Price:');
  const facts = container.querySelector('dl')!;
  expect([...facts.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Year', 'Miles', 'Fuel']);
  expect(within(facts).getByText('8610')).toBeInTheDocument();
  expect(screen.queryByRole('link')).toBeNull();
  expect(mocks.api).not.toHaveBeenCalled();
});

test('a public form opens at its own address, a room in place; the first is primary unless it says otherwise', async () => {
  draw([
    { label: 'Inquire about this car', view: 'inquire' },
    { label: 'All vehicles', view: 'vehicles' },
  ]);
  const inquire = await screen.findByRole('link', { name: 'Inquire about this car' });
  expect(inquire).toHaveAttribute('href', '/forecourt/form/inquire');
  expect(inquire).toHaveClass('is-primary');
  const all = screen.getByRole('link', { name: 'All vehicles' });
  expect(all).toHaveAttribute('href', '/forecourt/vehicles:vehicle');
  expect(all).toHaveClass('is-secondary');
  expect(mocks.api).toHaveBeenCalledWith('/api/forms');
});

test('an action that names neither a room nor a public form is not drawn', async () => {
  draw([
    { label: 'Nowhere', view: 'staff-only', intent: 'secondary' },
    { label: 'All vehicles', view: 'vehicles', intent: 'primary' },
  ]);
  expect(await screen.findByRole('link', { name: 'All vehicles' })).toHaveClass('is-primary');
  await vi.waitFor(() => expect(mocks.api).toHaveBeenCalled());
  expect(screen.queryByRole('link', { name: 'Nowhere' })).toBeNull();
});

test('cross-App headline binds served row fields and never falls through to local forms', async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'forecourt' });
  configureAppTargetLinks({ basePath: '/suite', appId: 'forecourt' });
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/suite/loans/24995' }) });
  vi.stubGlobal('fetch', fetcher);
  draw([
    { label: 'Lender', to: { app: 'lender', kind: 'record', resource: 'loan', key: { id: { column: 'price' } } } },
    { label: 'All vehicles', view: 'vehicles' },
  ]);
  expect(await screen.findByRole('link', { name: 'Lender' })).toHaveAttribute('href', '/suite/loans/24995');
  expect(screen.getByRole('link', { name: 'Lender' })).toHaveClass('is-primary');
  expect(screen.getByRole('link', { name: 'All vehicles' })).toHaveClass('is-secondary');
  expect(JSON.parse(fetcher.mock.calls[0][1].body).target.key).toEqual({ id: 24995 });
  expect(mocks.api).not.toHaveBeenCalled();
});

test('a public form is not offered to a signed-in reader, who has the App’s own rooms; a room still is', async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'staff', appId: 'forecourt' });
  draw([
    { label: 'Inquire about this car', view: 'inquire' },
    { label: 'All vehicles', view: 'vehicles' },
  ]);
  expect(await screen.findByRole('link', { name: 'All vehicles' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Inquire about this car' })).toBeNull();
  // The form list is never asked of: nothing is going to be drawn from it.
  expect(mocks.api).not.toHaveBeenCalled();
});

test('open: modal on a signed-in room opens the form over the record, and keeps its own address for a new tab', async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'resident', appId: 'forecourt' });
  const FormDialog = ({ view, prefill }: { view: string; prefill: string }) => <div role="dialog">{`${view}?${prefill}`}</div>;
  installShell({ slots: { ...shell().slots, FormDialog } });
  draw([{ label: 'All vehicles', view: 'vehicles', open: 'modal' }]);
  const link = await screen.findByRole('link', { name: 'All vehicles' });
  expect(link).toHaveAttribute('href', '/forecourt/vehicles:vehicle');
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(link);
  expect(await screen.findByRole('dialog')).toHaveTextContent('vehicles?');
});
