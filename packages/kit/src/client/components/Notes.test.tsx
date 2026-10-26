/**
 * The two sentences a place says instead of its content, and the boundary
 * that says the second one for a part that threw while drawing.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { Empty, Problem, ProblemScopeProvider } from './Notes.js';
import { ErrorBoundary, SECTION_ERROR } from './ErrorBoundary.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
});

function withClient(tree: ReactNode, client = new QueryClient()) {
  return <QueryClientProvider client={client}>{tree}</QueryClientProvider>;
}

test('an empty place is one sentence at body size, with what belongs there and the way to add it', () => {
  render(
    <Empty text="No invoices yet." detail="Invoices for this account will appear here." action={<a href="/invoices">New invoice</a>} />,
  );
  expect(screen.getByText('No invoices yet.', { exact: false }).closest('.empty-note')).toBeInTheDocument();
  expect(screen.getByText('Invoices for this account will appear here.')).toHaveClass('empty-note-detail');
  expect(screen.queryByRole('heading')).toBeNull();
  expect(screen.getByRole('link', { name: 'New invoice' })).toBeInTheDocument();
});

test("a problem is a warn mark, the reader's sentence and Try again, which asks every failed question again", async () => {
  const client = new QueryClient();
  const refetch = vi.spyOn(client, 'refetchQueries').mockResolvedValue();
  const retry = vi.fn();
  render(withClient(<Problem text="These invoices could not be loaded." retry={retry} />, client));
  expect(screen.getByRole('alert')).toHaveTextContent('These invoices could not be loaded.');
  expect(screen.getByRole('alert')).not.toHaveAttribute('data-section-error');
  expect(document.querySelector('.problem-mark')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(refetch).toHaveBeenCalledWith(expect.objectContaining({ type: 'active' }));
});

test('offline is said as offline, and said again when the connection comes back', () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => false });
  render(withClient(<Problem text="tablewalk is not answering." />));
  expect(screen.getByRole('alert')).toHaveTextContent('You are offline. Check your connection, then try again.');
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true });
  act(() => {
    window.dispatchEvent(new Event('online'));
  });
  expect(screen.getByRole('alert')).toHaveTextContent('tablewalk is not answering.');
});

test('one failure is said once on a screen: the places after the first say only that they are not loaded', () => {
  render(
    withClient(
      <ProblemScopeProvider>
        <Problem text="This record could not be loaded." />
        <Problem text="This record could not be loaded." />
        <Problem text="Another reason." />
      </ProblemScopeProvider>,
    ),
  );
  expect(screen.getAllByRole('alert').map((note) => note.textContent)).toEqual([
    expect.stringContaining('This record could not be loaded.'),
    expect.stringContaining('Another reason.'),
  ]);
  expect(screen.getByText('Not loaded, for the reason above.')).toHaveClass('problem-repeat');
});

function Bomb({ armed }: { armed: boolean }): ReactNode {
  if (armed) throw new Error('boom');
  return <p>Drawn</p>;
}

test('a part that throws while drawing says so in its own place, marked, and its neighbours stay', async () => {
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  function Page() {
    const [armed, setArmed] = useState(true);
    return (
      <>
        <button type="button" onClick={() => setArmed(false)}>
          Mend
        </button>
        <ErrorBoundary>
          <Bomb armed={armed} />
        </ErrorBoundary>
        <p>The neighbour</p>
      </>
    );
  }
  render(withClient(<Page />));
  const note = screen.getByRole('alert');
  expect(note).toHaveAttribute('data-section-error');
  expect(note).toHaveTextContent('This section could not be drawn.');
  expect(screen.getByText('The neighbour')).toBeInTheDocument();
  // The browser suites hear the caught error by this line, since no page error is raised.
  expect(errors).toHaveBeenCalledWith(SECTION_ERROR, expect.any(Error), expect.anything());
  await userEvent.click(screen.getByRole('button', { name: 'Mend' }));
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  expect(screen.getByText('Drawn')).toBeInTheDocument();
  expect(document.querySelector('[data-section-error]')).toBeNull();
});

test('a boundary forgets its error when what it holds is a different part', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const { rerender } = render(
    withClient(
      <ErrorBoundary resetKey="a" scope="room">
        <Bomb armed />
      </ErrorBoundary>,
    ),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('This page could not be drawn.');
  rerender(
    withClient(
      <ErrorBoundary resetKey="b" scope="room">
        <Bomb armed={false} />
      </ErrorBoundary>,
    ),
  );
  expect(screen.getByText('Drawn')).toBeInTheDocument();
});

test('a section that throws keeps its heading over the note', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(
    withClient(
      <ErrorBoundary
        fallback={(note) => (
          <section>
            <h2>Invoices</h2>
            {note}
          </section>
        )}
      >
        <Bomb armed />
      </ErrorBoundary>,
    ),
  );
  expect(screen.getByRole('heading', { name: 'Invoices' })).toBeInTheDocument();
  expect(screen.getByRole('alert')).toHaveAttribute('data-section-error');
});
