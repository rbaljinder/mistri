/**
 * The offer's second figure and small print, and calls to action that open a
 * public form already filled from the record: the record's own values first,
 * then the author's words, and nothing for a field the record leaves empty.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const mocks = vi.hoisted(() => ({ api: vi.fn(), state: { activeConnection: 'forecourt' } }));
vi.mock('../core.js', () => ({
  api: mocks.api,
  state: mocks.state,
  columnDisplay: () => null,
  columnLabel: (_t: string, column: string) => (({ est_monthly: 'Est.' }) as Record<string, string>)[column] ?? null,
}));
vi.mock('./Value.js', () => ({ Value: ({ value }: { value: unknown }) => <span className="value">{String(value)}</span> }));
vi.mock('./viewLink.js', () => ({
  viewLink: (key: string) => (key === 'vehicles' ? { href: '/forecourt/vehicles' } : undefined),
  formLink: (key: string) => ({ href: `/forecourt/form/${key}` }),
}));
const { PageHeadline, prefilledFormLink, wasShown } = await import('./PageHeadline.js');

beforeEach(() => {
  mocks.api.mockReset();
  mocks.api.mockResolvedValue({ forms: [{ id: 'inquire' }] });
});
afterEach(cleanup);

test('a second figure under the first, the small print under the actions, and forms opened with this car named', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <PageHeadline
        tableId="vehicle"
        row={{ price: 12995, est_monthly: 237, stock_ref: 'FC-1049' }}
        paths={['price']}
        column={() => undefined}
        subfigure="est_monthly"
        note="Estimated at 10% down."
        actions={[
          { label: 'Inquire', view: 'inquire', prefill: { stock_ref: 'stock_ref' } },
          { label: 'Test drive', view: 'inquire', prefill: { stock_ref: 'stock_ref' }, defaults: { message: 'A test drive, please.' } },
        ]}
      />
    </QueryClientProvider>,
  );
  expect(container.querySelector('.page-headline-sub')).toHaveTextContent('Est. 237');
  expect(container.querySelector('.page-headline-note')).toHaveTextContent('Estimated at 10% down.');
  expect(await screen.findByRole('link', { name: 'Inquire' })).toHaveAttribute('href', '/forecourt/form/inquire?stock_ref=FC-1049');
  expect(screen.getByRole('link', { name: 'Test drive' })).toHaveAttribute(
    'href',
    '/forecourt/form/inquire?stock_ref=FC-1049&message=A+test+drive%2C+please.',
  );
  // No facts were named, so there is no row of them.
  expect(container.querySelector('dl')).toBeNull();
});

test('an empty field fills nothing, and a record with no second figure draws none', () => {
  expect(
    prefilledFormLink(
      { href: '/forecourt/form/inquire' },
      { label: 'Ask', view: 'inquire', prefill: { stock_ref: 'stock_ref' } },
      { stock_ref: null },
    ),
  ).toEqual({ href: '/forecourt/form/inquire' });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={client}>
      <PageHeadline
        tableId="vehicle"
        row={{ price: 12995, est_monthly: null }}
        paths={['price']}
        column={() => undefined}
        subfigure="est_monthly"
        actions={[]}
      />
    </QueryClientProvider>,
  );
  expect(container.querySelector('.page-headline-sub')).toBeNull();
  expect(container.querySelector('.page-headline-note')).toBeNull();
});

test('the price it was, struck through beside the figure, only when it is set and higher; a fact with no value is left out', () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const draw = (row: Record<string, unknown>) =>
    render(
      <QueryClientProvider client={client}>
        <PageHeadline tableId="vehicle" row={row} paths={['price', 'trim', 'year']} column={() => undefined} was="was_price" actions={[]} />
      </QueryClientProvider>,
    );
  const { container } = draw({ price: 12995, was_price: 13995, trim: null, year: 2021 });
  const was = container.querySelector('.page-headline-figure s.page-headline-was')!;
  expect(was).toHaveTextContent('Was price: 13995');
  expect(was.querySelector('.visually-hidden')).toHaveTextContent('Was price:');
  // The empty trim is not "Trim —": only the year is said.
  expect([...container.querySelectorAll('dt')].map((dt) => dt.textContent)).toEqual(['Year']);
  cleanup();
  for (const was_price of [null, '', 12995, 9995]) {
    const { container: drawn } = draw({ price: 12995, was_price, year: 2021 });
    expect(drawn.querySelector('.page-headline-was')).toBeNull();
    cleanup();
  }
  // Ids and figures past 2^53 arrive as strings: compared as the numbers they are.
  expect(wasShown({ price: '12995', was_price: '13995' }, 'price', 'was_price')).toBe(true);
  expect(wasShown({ price: 12995, was_price: 'n/a' }, 'price', 'was_price')).toBe(false);
});
