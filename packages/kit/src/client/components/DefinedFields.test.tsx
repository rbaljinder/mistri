/** Row-defined fields: drawn from the definitions the reader's query returns, in their order; typed into one object; offered as a list's boxes. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

const asked: Array<Record<string, unknown>> = [];
const ATTRIBUTE = {
  id: 'attribute',
  name: 'attribute',
  columns: ['id', 'category_id', 'key', 'label', 'type', 'options', 'required', 'help', 'position'].map((name) => ({
    name,
    type: name === 'id' || name === 'category_id' || name === 'position' ? 'integer' : 'text',
    nullable: name !== 'id',
    primaryKey: name === 'id',
  })),
};
const ROWS = [
  { category_id: 1, key: 'season', label: 'Season', type: 'choice', options: '3-season\n4-season', required: 1, help: null, position: 2 },
  {
    category_id: 1,
    key: 'capacity',
    label: 'Sleeps',
    type: 'number',
    options: null,
    required: 1,
    help: 'How many it sleeps.',
    position: 1,
  },
  {
    category_id: null,
    key: 'features',
    label: 'Features',
    type: 'choices',
    options: 'Rain cover\nHip belt',
    required: 0,
    help: null,
    position: 9,
  },
  // An admin's typo is skipped, never drawn.
  { category_id: 1, key: 'bad key', label: 'Broken', type: 'number', options: null, required: 0, help: null, position: 3 },
];
vi.mock('../core.js', async (original) => ({
  ...(await original<typeof import('../core.js')>()),
  findTable: (id: string) => (id === 'attribute' ? ATTRIBUTE : undefined),
  api: async (_path: string, body: Record<string, unknown>) => {
    asked.push(body);
    return { rows: ROWS };
  },
}));
const { DefinedFields, DefinedInputs, DefinedBoxes } = await import('./DefinedFields.js');
const { PlatformControl } = await import('./NewRecord.js');

const binding = { from: 'attribute', per: 'category_id' };
function draw(node: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  asked.length = 0;
});

test('a record page says its fields by their captions, in definition order, read in the record’s scope', async () => {
  const product = {
    id: 1,
    name: 'Test',
    category_id: 1,
    specs: JSON.stringify({ capacity: 2, season: '3-season', features: ['Rain cover', 'Hip belt'] }),
  };
  draw(
    <dl>
      <DefinedFields
        base={{ id: 'product', name: 'product', columns: [] } as never}
        row={product}
        column="specs"
        binding={binding}
        recordKey={{ id: 1 }}
        editing={false}
      />
    </dl>,
  );
  await waitFor(() => expect(document.querySelectorAll('.page-field dt')).toHaveLength(3));
  expect([...document.querySelectorAll('.page-field dt')].map((dt) => dt.textContent)).toEqual(['Sleeps', 'Season', 'Features']);
  expect(document.querySelector('.page-field dt')).toHaveAttribute('title', 'How many it sleeps.');
  expect(document.querySelectorAll('.page-field dd')[2]).toHaveTextContent('Rain cover, Hip belt');
  // This category's definitions and those of every category: `per` is asked as the record holds it.
  expect(asked[0]).toMatchObject({
    table: 'attribute',
    filter: { groups: [[{ column: 'category_id', op: '=', value: 1 }], [{ column: 'category_id', op: 'isNull' }]] },
  });
});

test('the New form types each field into one object, and drops a key emptied again', async () => {
  const user = userEvent.setup();
  const sent: string[] = [];
  draw(
    <DefinedInputs
      Control={PlatformControl}
      column="specs"
      binding={binding}
      per={1}
      value="{}"
      onChange={(text) => sent.push(text)}
      errors={[{ field: 'specs.season', message: 'Choose from the list.' }]}
    />,
  );
  const sleeps = await screen.findByRole('textbox', { name: 'Sleeps' });
  await user.type(sleeps, '4');
  expect(JSON.parse(sent.at(-1)!)).toEqual({ capacity: 4 });
  await user.click(screen.getByRole('checkbox', { name: 'Rain cover' }));
  expect(JSON.parse(sent.at(-1)!)).toEqual({ features: ['Rain cover'] });
  await user.click(screen.getByRole('checkbox', { name: 'Rain cover' }));
  expect(JSON.parse(sent.at(-1)!)).toEqual({});
  // A refusal naming `specs.season` is said under that field.
  expect(screen.getByText('Choose from the list.')).toBeVisible();
  expect(screen.getByText('How many it sleeps.')).toBeInTheDocument();
});

test('a list is handed a box per field: a choice its options, a list of choices asked by `has`', async () => {
  const boxes = vi.fn();
  draw(<DefinedBoxes column="specs" binding={binding} per={undefined} onBoxes={boxes} />);
  await waitFor(() => expect(boxes).toHaveBeenCalled());
  const [column, given] = boxes.mock.calls[0];
  expect(column).toBe('specs');
  expect(given.map((box: { column: string; label: string; kind: string }) => [box.column, box.label, box.kind])).toEqual([
    ['specs.capacity', 'Sleeps', 'text'],
    ['specs.season', 'Season', 'enum'],
    ['specs.features', 'Features', 'tags'],
  ]);
  expect(given[2].meta.allowed).toEqual(['Rain cover', 'Hip belt']);
  // With no one `per` value, every definition is asked for.
  expect(asked[0]).not.toHaveProperty('filter');
});
