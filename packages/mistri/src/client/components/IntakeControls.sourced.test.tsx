/** A choice from a table on a public form: rows the server served are the whole answer, an empty list included. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { AppCommandField } from '../../shared/app.js';

const { run } = vi.hoisted(() => ({ run: vi.fn(async () => ({ rows: [{ id: 'own', name: 'Read by the page' }] })) }));
vi.mock('./CommandReference.js', () => ({ run }));
const reader = vi.hoisted(() => ({ locale: undefined as string | undefined }));
vi.mock('@mistriwork/kit/client/locale.js', async (original) => ({
  ...(await original<typeof import('@mistriwork/kit/client/locale.js')>()),
  formatLocale: () => reader.locale,
}));

const { IntakeControl } = await import('./IntakeControls.js');

afterEach(() => {
  cleanup();
  run.mockClear();
  reader.locale = undefined;
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

test('a choice from a table that says radios is radios, however many rows it has (a field report)', async () => {
  const rows = ['Kia', 'Ford', 'Fiat', 'Audi', 'Saab', 'Seat', 'Opel', 'Mini'].map((label) => ({ value: `n-${label}`, label }));
  draw({ ...make(true, rows), as: 'radios' } as AppCommandField);
  expect(await screen.findAllByRole('radio')).toHaveLength(8);
  expect(screen.getByRole('radiogroup').id).toBe('make');
  expect(screen.queryByRole('combobox')).toBeNull();
});

test("a list the page reads is said by the reader's language's column, else by labelColumn", async () => {
  reader.locale = 'es-MX';
  run.mockResolvedValueOnce({
    rows: [
      { id: 'n-ford', name: 'Ford', name_es: 'Vado' },
      { id: 'n-kia', name: 'Kia', name_es: null },
    ],
  } as never);
  const field = make(false, []) as AppCommandField & { source: object };
  draw({ ...field, source: { ...field.source, labelColumns: { es: 'name_es' } } } as AppCommandField);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ q: 'make show id, name, name_es sort name' });
  expect(await screen.findByText('Vado')).toBeTruthy();
});

/* A choice narrowed by another answer (`where: 'location = location and active = true'`), compiled as the server sends it. */
const service = (served: boolean, options: Array<{ value: number; label: string; row?: Record<string, unknown> }>): AppCommandField =>
  ({
    name: 'service',
    label: 'Service',
    type: 'choice',
    options,
    source: {
      from: 'service',
      by: 'id',
      labelColumn: 'name',
      ...(served ? { served: true } : {}),
      match: [
        [
          { column: 'location', operator: 'eq', values: [{ answer: 'location' }] },
          { column: 'active', operator: 'eq', values: [true] },
        ],
      ],
    },
  }) as AppCommandField;

const services = [
  { value: 10, label: 'Cleaning', row: { location: 1, active: 1 } },
  { value: 11, label: 'Whitening', row: { location: 1, active: 0 } },
  { value: 20, label: 'Braces', row: { location: 2, active: 1 } },
];

function drawNarrowed(field: AppCommandField, answers: Record<string, unknown>, value: number | string | undefined, onChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tree = (answers: Record<string, unknown>, value: number | string | undefined) => (
    <QueryClientProvider client={client}>
      <IntakeControl
        field={field}
        id="service"
        value={value}
        onChange={onChange}
        source={{ visitor: { app: 'clinic' } }}
        answers={{ ...answers, service: value }}
      />
    </QueryClientProvider>
  );
  const drawn = render(tree(answers, value));
  return {
    onChange,
    redraw: (answers: Record<string, unknown>, value: number | string | undefined) => drawn.rerender(tree(answers, value)),
  };
}

test('a served list is narrowed by the other answers on the page, with no read; nothing is offered until they are given', async () => {
  const { redraw } = drawNarrowed(service(true, services), {}, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(screen.queryByText('Cleaning')).toBeNull();
  expect(screen.queryByText('Braces')).toBeNull();
  redraw({ location: 1 }, undefined);
  expect(await screen.findByText('Cleaning')).toBeTruthy();
  expect(screen.queryByText('Whitening')).toBeNull();
  expect(screen.queryByText('Braces')).toBeNull();
  expect(run).not.toHaveBeenCalled();
});

test('a parent change clears a child pick the narrowed list no longer offers, and keeps one it still does', async () => {
  const { onChange, redraw } = drawNarrowed(service(true, services), { location: 1 }, 10);
  expect(await screen.findByText('Cleaning')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  redraw({ location: 2 }, 10);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(''));
  onChange.mockClear();
  redraw({ location: '2' }, 20);
  expect(await screen.findByText('Braces')).toBeTruthy();
  expect(onChange).not.toHaveBeenCalled();
  redraw({}, 20);
  await waitFor(() => expect(onChange).toHaveBeenCalledWith(''), { timeout: 500 });
});

test('a list the page reads is read with the where bound, once per change of the answers it reads, and not before', async () => {
  run.mockResolvedValue({ rows: [{ id: 20, name: 'Braces' }] } as never);
  const { redraw } = drawNarrowed(service(false, []), {}, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(run).not.toHaveBeenCalled();
  redraw({ location: 2 }, undefined);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(1));
  expect((run.mock.calls[0] as unknown[])[1]).toMatchObject({ q: 'service location = 2 and active = true show id, name sort name' });
  expect(await screen.findByText('Braces')).toBeTruthy();
  redraw({ location: 2, note: 'an answer it does not read' }, undefined);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(run).toHaveBeenCalledTimes(1);
  redraw({ location: 1 }, undefined);
  await waitFor(() => expect(run).toHaveBeenCalledTimes(2));
  expect((run.mock.calls[1] as unknown[])[1]).toMatchObject({ q: 'service location = 1 and active = true show id, name sort name' });
  run.mockReset();
  run.mockImplementation(async () => ({ rows: [{ id: 'own', name: 'Read by the page' }] }));
});
