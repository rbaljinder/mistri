import { afterEach, expect, test } from 'vitest';
import { cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Revealed } from './PageRoom.js';

/*
 * A record page that arrives after the navigation hold or the startup veil
 * has let go at its cap is kept out of sight until it is complete, then shown
 * whole (PageRoom.tsx, Revealed): drawn in steps, its head grew a line when
 * its verbs came and pushed everything under it down (0.43 CLS on the
 * lender's loan). Covered, it writes nothing, so the hold sees nothing stir.
 */

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
  document.documentElement.removeAttribute('data-starting');
});

/** A read that stays out until answered. */
function slowRead(client: QueryClient) {
  let answer!: () => void;
  void client.fetchQuery({
    queryKey: ['slow'],
    queryFn: () =>
      new Promise<number>((resolve) => {
        answer = () => resolve(1);
      }),
  });
  return () => answer();
}

function mount(pane: HTMLElement, client: QueryClient) {
  document.body.append(pane);
  const { container } = render(
    <QueryClientProvider client={client}>
      <Revealed>
        <p>The record</p>
      </Revealed>
    </QueryClientProvider>,
    { container: pane },
  );
  return container.querySelector('.page-revealed') as HTMLElement;
}

const frames = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('a page that arrives uncovered is out of sight, at its held height, until nothing is asked, then shown whole', async () => {
  const client = new QueryClient();
  const answer = slowRead(client);
  const pane = Object.assign(document.createElement('div'), { className: 'content' });
  const page = mount(pane, client);
  expect(page.style.visibility).toBe('hidden');
  expect(page.style.minHeight).toBe('100vh');
  await frames(150);
  expect(page.style.visibility).toBe('hidden');
  answer();
  await waitFor(() => expect(page.getAttribute('style') ?? '').toBe(''));
});

test('under the hold it writes nothing, and hides the page the moment the hold lets go before it is complete', async () => {
  const client = new QueryClient();
  const answer = slowRead(client);
  const pane = Object.assign(document.createElement('div'), { className: 'content nav-holding' });
  const page = mount(pane, client);
  expect(page.getAttribute('style')).toBeNull();
  pane.classList.remove('nav-holding');
  await Promise.resolve();
  expect(page.style.visibility).toBe('hidden');
  answer();
  await waitFor(() => expect(page.getAttribute('style') ?? '').toBe(''));
});

test('under the startup veil it waits the same way', async () => {
  const client = new QueryClient();
  const answer = slowRead(client);
  document.documentElement.setAttribute('data-starting', '');
  const page = mount(Object.assign(document.createElement('div'), { className: 'content' }), client);
  expect(page.getAttribute('style')).toBeNull();
  document.documentElement.removeAttribute('data-starting');
  await Promise.resolve();
  expect(page.style.visibility).toBe('hidden');
  answer();
  await waitFor(() => expect(page.getAttribute('style') ?? '').toBe(''));
});

test('covered and complete, the page is never touched', async () => {
  const client = new QueryClient();
  const pane = Object.assign(document.createElement('div'), { className: 'content nav-holding' });
  const page = mount(pane, client);
  await frames(150);
  pane.classList.remove('nav-holding');
  await frames(50);
  expect(page.getAttribute('style')).toBeNull();
});
