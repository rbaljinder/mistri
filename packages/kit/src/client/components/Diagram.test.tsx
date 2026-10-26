/** The diagram drawn: nodes that open, walk on click, and a schema limited by a picker. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const t = (id: string, cols: unknown[]) =>
  ({ id, name: id, schema: '', isView: false, indexed: [], columns: cols }) as unknown as TableMeta;
const customer = t('customer', [
  col('id', 'INTEGER', { primaryKey: true }),
  col('name', 'TEXT'),
  col('a', 'TEXT'),
  col('b', 'TEXT'),
  col('c', 'TEXT'),
  col('d', 'TEXT'),
  col('e', 'TEXT'),
]);
const order = t('order', [col('id', 'INTEGER', { primaryKey: true }), col('customer_id', 'INTEGER')]);
const fk = { name: 'order_customer', from: { table: 'order', columns: ['customer_id'] }, to: { table: 'customer', columns: ['id'] } };
const gone: unknown[] = [];
vi.mock('../core.js', () => ({
  state: { schema: { label: 'shop', tables: [customer, order], foreignKeys: [fk] } },
  findTable: (id: string) => (id === 'customer' ? customer : id === 'order' ? order : undefined),
  labelColumn: () => 'name',
  go: (e: unknown, mode: string) => gone.push([e, mode]),
  tableView: (id: string) => ({ kind: 'table', table: id }),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
  viewportScale: () => 1,
  toast: () => {},
}));
vi.mock('../schemaexport.js', () => ({ exportSchema: async () => {} }));
const { NeighbourhoodDiagram, SchemaDiagram } = await import('./Diagram.js');

afterEach(() => {
  cleanup();
  gone.length = 0;
});

test('a neighbourhood draws the neighbours with their key on the edge, opens a node, and walks on click', async () => {
  const user = userEvent.setup();
  render(
    <div className="diagram">
      <NeighbourhoodDiagram tableId="customer" expandable={false} />
    </div>,
  );
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('customer and what it touches');
  expect(document.querySelectorAll('.node')).toHaveLength(2);
  expect(document.querySelector('.edge-label')).toHaveTextContent('customer_id');
  const focus = document.querySelector('.node-focus')!;
  expect(focus.querySelectorAll('.node-field')).toHaveLength(5);
  expect(focus.querySelector('.node-more text')).toHaveTextContent('+ 2 more');
  fireEvent.click(focus.querySelector('.node-more')!);
  expect(document.querySelector('.node-focus .node-field:nth-of-type(1)')).toBeTruthy();
  expect(document.querySelector('.node-focus')!.querySelectorAll('.node-field')).toHaveLength(7);
  expect(document.querySelector('.node-focus .node-more text')).toHaveTextContent('− show less');
  fireEvent.click(document.querySelector('.node-focus .node-more')!);
  await user.click(document.querySelector('.node-in .node-head')!);
  expect(gone).toEqual([[{ kind: 'table', table: 'order' }, 'reset']]);
});

test('the whole schema counts what it draws, dims what a hovered table does not touch, and can be limited', async () => {
  const user = userEvent.setup();
  render(
    <div className="diagram diagram-schema">
      <SchemaDiagram expandable={false} />
    </div>,
  );
  expect(document.querySelector('.diagram-legend')).toHaveTextContent('2 tables · 1 foreign key · 2 levels deep');
  expect(document.querySelectorAll('.node')).toHaveLength(2);
  fireEvent.mouseEnter(document.querySelector('[data-table="order"]')!);
  expect(document.querySelector('[data-table="order"]')).toHaveClass('lit');
  expect(document.querySelector('[data-table="customer"]')).not.toHaveClass('dim');
  fireEvent.mouseLeave(document.querySelector('[data-table="order"]')!);
  const picker = screen.getByRole('combobox', { name: 'Limit the diagram to these tables' });
  await user.type(picker, 'cust');
  await user.click(screen.getByRole('option', { name: /customer/ }));
  expect(document.querySelector('.diagram-chip')).toHaveTextContent('customer');
  expect(document.querySelector('.diagram-legend')).toHaveTextContent('2 of 2 tables');
  await user.click(screen.getByRole('button', { name: 'Show all' }));
  expect(document.querySelector('.diagram-chip')).toBeNull();
});
