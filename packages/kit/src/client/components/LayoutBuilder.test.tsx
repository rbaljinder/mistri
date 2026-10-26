/** The layout editor: sections toggled, moved and renamed on the draft, fields arranged, the record told to redraw. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string) => ({ name, type, nullable: true, primaryKey: false });
const customer = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('id', 'INTEGER'), col('name', 'TEXT'), col('email', 'TEXT')],
} as unknown as TableMeta;
const order = {
  id: 'order',
  name: 'order',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('id', 'INTEGER'), col('total', 'REAL'), col('placed_at', 'TEXT')],
} as unknown as TableMeta;
vi.mock('../core.js', () => ({
  state: {
    schema: {
      tables: [customer, order],
      foreignKeys: [
        { name: 'order_customer', from: { table: 'order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } },
      ],
    },
  },
  findTable: (id: string) => (id === 'customer' ? customer : id === 'order' ? order : undefined),
  tableAtPrefix: () => null,
}));
vi.mock('../prompt.js', () => ({ promptFor: async () => 'Contact details' }));
const { LayoutBuilder } = await import('./LayoutBuilder.js');
const { EditLayoutButton } = await import('./EditLayoutButton.js');
type Template = import('./LayoutBuilder.js').Template;

function fresh(): Template {
  return {
    id: 'customer',
    name: 'Default layout',
    base: 'customer',
    sections: [
      { kind: 'fields' as const, title: 'Fields', paths: ['id', 'name'], columns: [] },
      { kind: 'list' as const, title: 'Orders', via: 'order_customer', paths: [], columns: ['id', 'total'], limit: 8 },
    ],
  };
}

afterEach(cleanup);

test('draws each section with its kind, and toggling, moving and renaming write to the draft and redraw', async () => {
  const user = userEvent.setup();
  const draft = fresh();
  const onApplied = vi.fn();
  render(
    <LayoutBuilder
      draft={draft}
      table={customer}
      onPreview={() => {}}
      onApplied={onApplied}
      onReset={() => {}}
      onCancel={() => {}}
      onSave={() => {}}
    />,
  );
  const sections = document.querySelectorAll('.tpl-section');
  expect(sections).toHaveLength(2);
  expect(sections[1].querySelector('.tpl-section-kind')).toHaveTextContent('table · order');
  await user.click(within(sections[1] as HTMLElement).getByRole('checkbox'));
  expect(draft.sections[1].off).toBe(true);
  expect(document.querySelectorAll('.tpl-section')[1]).toHaveClass('off');
  await user.click(within(document.querySelectorAll('.tpl-section')[1] as HTMLElement).getByRole('button', { name: 'Move up' }));
  expect(draft.sections[0].kind).toBe('list');
  await user.click(within(document.querySelectorAll('.tpl-section')[1] as HTMLElement).getByRole('button', { name: 'Rename section' }));
  await vi.waitFor(() => expect(draft.sections[1].title).toBe('Contact details'));
  expect(screen.getByText('Contact details')).toBeInTheDocument();
  expect(onApplied).toHaveBeenCalledTimes(3);
});

test('arranging fields previews; the list rows and the name write straight to the draft; the actions are the caller’s', async () => {
  const user = userEvent.setup();
  const draft = fresh();
  const onPreview = vi.fn();
  const onSave = vi.fn();
  render(
    <LayoutBuilder
      draft={draft}
      table={customer}
      onPreview={onPreview}
      onApplied={() => {}}
      onReset={() => {}}
      onCancel={() => {}}
      onSave={onSave}
    />,
  );
  await user.click(screen.getByRole('button', { name: 'Add email' }));
  expect(draft.sections[0].paths).toEqual(['id', 'name', 'email']);
  expect(onPreview).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Add placed_at' }));
  expect(draft.sections[1].columns).toEqual(['id', 'total', 'placed_at']);
  await user.clear(screen.getByRole('textbox', { name: 'Layout name' }));
  await user.type(screen.getByRole('textbox', { name: 'Layout name' }), 'Support view');
  expect(draft.name).toBe('Support view');
  await user.click(screen.getByRole('button', { name: 'Save layout' }));
  expect(onSave).toHaveBeenCalledTimes(1);
});

test('the layout button says when a layout is custom, and names it when the name says more than the table', () => {
  const onOpen = vi.fn();
  render(<EditLayoutButton table={customer} saved={{ id: 'x', name: 'Support view', base: 'customer', sections: [] }} onOpen={onOpen} />);
  expect(screen.getByRole('button')).toHaveClass('is-custom');
  expect(screen.getByRole('button')).toHaveTextContent('LayoutSupport view');
  cleanup();
  render(<EditLayoutButton table={customer} saved={null} onOpen={onOpen} />);
  expect(screen.getByRole('button')).toHaveAttribute('title', 'Choose what this record shows');
  expect(screen.getByRole('button')).not.toHaveClass('is-custom');
});
