/** A choice from a table on a public form: rows the server served are the whole answer, an empty list included. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppCommandField } from '../../shared/app.js';

const { run } = vi.hoisted(() => ({ run: vi.fn(async () => ({ rows: [{ id: 'own', name: 'Read by the page' }] })) }));
vi.mock('./CommandReference.js', () => ({ run }));

const { IntakeControl } = await import('./IntakeControls.js');

afterEach(() => {
  cleanup();
  run.mockClear();
});

const make = (served: boolean, options: Array<{ value: string; label: string }>): AppCommandField =>
  ({
    name: 'make',
    label: 'Make',
    type: 'choice',
    options,
    source: { from: 'make', by: 'id', labelColumn: 'name', ...(served ? { served: true } : {}) },
  }) as AppCommandField;

function draw(field: AppCommandField) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <IntakeControl field={field} id="make" value={undefined} onChange={() => {}} source={{ visitor: { app: 'yard' } }} />
    </QueryClientProvider>,
  );
}

test('served rows are drawn as they came, with no read of the page’s own', async () => {
  draw(make(true, [{ value: 'n-kia', label: 'Kia' }]));
  expect(await screen.findByText('Kia')).toBeTruthy();
  expect(run).not.toHaveBeenCalled();
});

test('an empty served list offers nothing and reads nothing: a tenant’s visitor has no read of its own to ask', async () => {
  draw(make(true, []));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(run).not.toHaveBeenCalled();
  expect(screen.queryByText('Read by the page')).toBeNull();
});

test('a list the server did not serve is read by the page', async () => {
  draw(make(false, []));
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Read by the page')).toBeTruthy();
});
