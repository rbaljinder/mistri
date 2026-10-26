import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { FormPresentation } from './FormSurface.js';

const loaded = vi.hoisted(() => ({
  value: null as { app: { id: string; name: string }; form: FormPresentation } | null,
  failure: null as Error | null,
}));
vi.mock('../publicForm.js', () => ({
  loadPublicForm: vi.fn(async () => {
    if (loaded.failure) throw loaded.failure;
    return loaded.value ?? undefined;
  }),
}));

const { FormDialog } = await import('./FormDialog.js');
const { loadPublicForm } = await import('../publicForm.js');

const form: FormPresentation = {
  id: 'inquire',
  label: 'Inquire about a vehicle',
  submitLabel: 'Send',
  done: { title: 'Sent', description: 'The dealer will reply.' },
  prefillable: ['stock_ref', 'message'],
  input: [
    { name: 'stock_ref', label: 'Stock number', type: 'text', required: true, maxLength: 40 },
    { name: 'message', label: 'Your question', type: 'textarea', required: true, maxLength: 500 },
  ],
};

const draw = (prefill = '') =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <FormDialog view="inquire" prefill={prefill} onClose={() => {}} />
    </QueryClientProvider>,
  );

beforeEach(() => {
  loaded.value = { app: { id: 'forecourt', name: 'Forecourt' }, form };
  loaded.failure = null;
  vi.mocked(loadPublicForm)
    .mockReset()
    .mockImplementation(async () => {
      if (loaded.failure) throw loaded.failure;
      return loaded.value ?? undefined;
    });
});
afterEach(() => cleanup());

test('draws the public form over the record, started by the action', async () => {
  draw('stock_ref=FC-1001&message=Is+it+still+available%3F');
  await waitFor(() => expect(screen.getByRole('heading', { name: 'Inquire about a vehicle' })).toBeInTheDocument());
  // The action's prefill and defaults reach the form as they would through the
  // address, which is what keeps the dialog and the form's own page the same.
  expect(screen.getByLabelText('Stock number (required)')).toHaveValue('FC-1001');
  expect(screen.getByLabelText('Your question (required)')).toHaveValue('Is it still available?');
});

test('with nothing to start it, the form is blank rather than half-filled', async () => {
  draw();
  await waitFor(() => expect(screen.getByLabelText('Stock number (required)')).toHaveValue(''));
});

test('a form that is not there says so instead of drawing an empty dialog', async () => {
  loaded.value = null;
  draw();
  await waitFor(() => expect(screen.getByText('There is no such form here.')).toBeInTheDocument());
});

test('a form that cannot be loaded says why', async () => {
  loaded.failure = new Error('The form could not be loaded (503).');
  draw();
  await waitFor(() => expect(screen.getByText('The form could not be loaded (503).')).toBeInTheDocument());
});

test('a prefill from a component at runtime fills only what the form names prefillable, and never the address', async () => {
  // A component's openForm hands the dialog its values; nothing puts them in history or a referrer.
  loaded.value = {
    app: { id: 'forecourt', name: 'Forecourt' },
    form: {
      ...form,
      prefillable: ['stock_ref'],
      input: [...form.input, { name: 'email', label: 'Email', type: 'text', required: true, maxLength: 200 }],
    },
  };
  const before = window.location.href;
  draw('stock_ref=FC-1001&message=Private+note&email=someone%40example.test');
  await waitFor(() => expect(screen.getByLabelText('Stock number (required)')).toHaveValue('FC-1001'));
  expect(screen.getByLabelText('Your question (required)')).toHaveValue('');
  expect(screen.getByLabelText('Email (required)')).toHaveValue('');
  expect(window.location.href).toBe(before);
});

test('each opening owns its named GET even when the query client is shared, and names the App', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const drawOne = () =>
    render(
      <QueryClientProvider client={client}>
        <FormDialog view="inquire" appId="forecourt" prefill="" onClose={() => {}} />
      </QueryClientProvider>,
    );
  const first = drawOne();
  await screen.findByRole('heading', { name: 'Inquire about a vehicle' });
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['public-form'] });
  });
  expect(loadPublicForm).toHaveBeenCalledTimes(1);
  first.unmount();
  drawOne();
  await screen.findByRole('heading', { name: 'Inquire about a vehicle' });
  expect(loadPublicForm).toHaveBeenCalledTimes(2);
  expect(loadPublicForm).toHaveBeenLastCalledWith('inquire', { appId: 'forecourt', fresh: true });
});

test('a late preparation for a previous form cannot replace the current operation', async () => {
  let finish!: (value: NonNullable<Awaited<ReturnType<typeof loadPublicForm>>>) => void;
  vi.mocked(loadPublicForm)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce({ app: { id: 'forecourt', name: 'Forecourt' }, form: { ...form, id: 'visit', label: 'Arrange a visit' } });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const dialog = (view: string) => (
    <QueryClientProvider client={client}>
      <FormDialog view={view} appId="forecourt" prefill="" onClose={() => {}} />
    </QueryClientProvider>
  );
  const drawn = render(dialog('inquire'));
  await waitFor(() => expect(loadPublicForm).toHaveBeenCalledTimes(1));
  drawn.rerender(dialog('visit'));
  await screen.findByRole('heading', { name: 'Arrange a visit' });
  await act(async () => {
    finish(loaded.value!);
  });
  expect(screen.getByRole('heading', { name: 'Arrange a visit' })).toBeVisible();
  expect(screen.queryByRole('heading', { name: 'Inquire about a vehicle' })).toBeNull();
});
