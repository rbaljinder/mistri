/** The composer drawn from its store: the panels, the sentence, the preview, and the actions each control drives. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';
import { resolveAggregate, type ViewAggregate } from '../../../../engine/src/shared/view.js';

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra });
const customer = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: [],
  approxRows: 120,
  columns: [
    col('id', 'INTEGER', { primaryKey: true }),
    col('name', 'TEXT'),
    col('country_code', 'TEXT', { references: { table: 'country', column: 'code' } }),
  ],
} as unknown as TableMeta;
const country = {
  id: 'country',
  name: 'country',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('code', 'TEXT', { primaryKey: true }), col('label', 'TEXT')],
} as unknown as TableMeta;
const invoice = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: [],
  columns: [
    col('id', 'INTEGER', { primaryKey: true }),
    col('total', 'REAL'),
    col('customer_id', 'INTEGER', { references: { table: 'customer', column: 'id' } }),
  ],
} as unknown as TableMeta;
const fkInvoice = {
  name: 'invoice_customer',
  from: { table: 'invoice', columns: ['customer_id'] },
  to: { table: 'customer', columns: ['id'] },
};
const fkCountry = {
  name: 'customer_country',
  from: { table: 'customer', columns: ['country_code'] },
  to: { table: 'country', columns: ['code'] },
};

const snapshot = {
  draft: {
    id: '',
    name: '',
    base: 'customer',
    columns: [{ path: 'id' }, { path: 'name' }],
    aggregates: [] as Array<{ fn: string; via: string }>,
    query: '',
    orderBy: [] as Array<{ path: string; direction: string }>,
    limit: 20,
  },
  opened: new Set<string>(),
  justAdded: null as string | null,
  fromConfig: [] as unknown[],
  savedViews: [{ id: 'v1', name: 'Aussies', base: 'customer', columns: [{ path: 'id' }] }],
  pinned: [] as string[],
  preview: null as unknown,
  previewError: null as unknown,
  showSql: false,
  showText: false,
  textEdit: null as string | null,
  running: false,
};
const act = {
  setName: vi.fn(),
  toggleText: vi.fn(),
  toggleSql: vi.fn(),
  saveDraft: vi.fn(),
  saveAs: vi.fn(),
  leave: vi.fn(),
  setBase: vi.fn(),
  toggleField: vi.fn(),
  addJoin: vi.fn(),
  removeJoin: vi.fn(),
  addAggregate: vi.fn(),
  removeAggregate: vi.fn(),
  startFromChild: vi.fn(),
  setQuery: vi.fn(),
  setLimit: vi.fn(),
  setTextEdit: vi.fn(),
  applyText: vi.fn(),
  sortByPath: vi.fn(),
  renameColumn: vi.fn(),
  togglePin: vi.fn(),
  openSaved: vi.fn(),
  removeSaved: vi.fn(),
  consumeJustAdded: vi.fn(),
  completionsFor: (text: string) =>
    text.endsWith('.')
      ? [{ value: 'country_code.label', label: 'country_code.label', detail: 'text', kind: 'value' }]
      : [
          { value: 'name', label: 'name', detail: 'text', kind: 'value' },
          { value: 'country_code.', label: 'country_code.', detail: '→ country', kind: 'table', partial: true },
        ],
};
let databaseTools = true;
vi.mock('../connectionScope.js', () => ({ canUseDatabaseTools: () => databaseTools }));
vi.mock('../core.js', () => ({
  state: { schema: { tables: [customer, country, invoice], foreignKeys: [fkInvoice, fkCountry] } },
  findTable: (id: string) => (({ customer, country, invoice }) as Record<string, TableMeta>)[id],
  hopsFrom: (id: string) => (id === 'customer' ? [{ name: 'country_code', target: 'country', optional: true, fk: fkCountry }] : []),
  refsTo: (id: string) => (id === 'customer' ? [fkInvoice] : []),
  tableAtPrefix: (_b: string, prefix: string) => (prefix === 'country_code' ? country : null),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../composer.js', () => ({
  MAX_DEPTH: 4,
  composerVersion: () => 0,
  subscribeComposer: () => () => {},
  composerState: () => snapshot,
  composerActions: act,
  phraseOne: (t: TableMeta, hop: { target: string; optional?: boolean }) =>
    `each ${t.name} ${hop.optional ? 'may have one' : 'has one'} ${hop.target}`,
  phraseMany: (t: TableMeta, fk: { from: { table: string } }) => `each ${t.name} has many ${fk.from.table}s`,
  plural: (n: string) => `${n}s`,
  aggregateLabel: (a: { fn: string; via: string }) => `a ${a.fn} of ${a.via}`,
  shortAggregate: (a: { fn: string; via: string }) => `${a.fn}(${a.via})`,
  sameAggregate: (a: ViewAggregate, b: ViewAggregate, base: string) => {
    const schema = {
      dialect: 'sqlite' as const,
      label: '',
      readAt: '',
      tables: [customer, country, invoice],
      foreignKeys: [fkInvoice, fkCountry],
    };
    return (
      a.fn === b.fn &&
      (a.on ?? '') === (b.on ?? '') &&
      (a.column ?? '') === (b.column ?? '') &&
      resolveAggregate(schema, base, a).fk === resolveAggregate(schema, base, b).fk
    );
  },
}));
const { Composer } = await import('./Composer.js');

afterEach(() => {
  cleanup();
  databaseTools = true;
  Object.values(act).forEach((f) => {
    if ('mockClear' in f) (f as ReturnType<typeof vi.fn>).mockClear();
  });
  snapshot.opened = new Set();
  snapshot.preview = null;
  snapshot.previewError = null;
  snapshot.showText = false;
  snapshot.draft.aggregates = [];
});

test('App Workbench renders projected results without offering SQL diagnostics', () => {
  databaseTools = false;
  snapshot.preview = {
    rows: [{ name: 'Nia' }],
    columns: ['name'],
    resolved: [{ name: 'name', path: 'name', type: 'text', table: 'customer', column: 'name' }],
    total: 1,
    ms: 3,
    joinCount: 1,
  };
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  expect(screen.getByText('Nia')).toBeInTheDocument();
  expect(screen.getByText('1 join')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'SQL' })).not.toBeInTheDocument();
});

test('says what the view is, lists the base fields ticked as chosen, and the related tables with their phrases', async () => {
  const user = userEvent.setup();
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  expect(screen.getByRole('button', { name: 'Base table' })).toHaveTextContent('customer');
  expect(document.querySelector('.composer-summary strong')).toHaveTextContent('One row per customer.');
  const checks = document.querySelectorAll('.composer-check');
  expect(checks).toHaveLength(3);
  expect(checks[0]).toHaveClass('on');
  expect(within(checks[0] as HTMLElement).getByRole('checkbox')).toBeChecked();
  await user.click(within(checks[2] as HTMLElement).getByRole('checkbox'));
  expect(act.toggleField).toHaveBeenCalledWith('country_code');
  expect(screen.getByText('each customer may have one country')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Add' }));
  expect(act.addJoin).toHaveBeenCalledWith('country_code');
  expect(screen.getByText('each customer has many invoices')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Count' }));
  expect(act.addAggregate).toHaveBeenCalledWith({ fn: 'count', via: 'invoice.customer_id' });
  await user.click(screen.getByRole('button', { name: 'Start here' }));
  expect(act.startFromChild).toHaveBeenCalledWith(fkInvoice);
  expect(screen.getByText('Building…')).toBeInTheDocument();
});

test('an open join lists its fields under the base and reads into the sentence; a summary is a tickable chip', () => {
  snapshot.opened = new Set(['country_code']);
  snapshot.draft.aggregates = [{ fn: 'count', via: 'invoice_customer' }];
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  const groups = document.querySelectorAll('.composer-group');
  expect(groups).toHaveLength(3);
  expect(groups[1].querySelector('.composer-group-path')).toHaveTextContent('via country_code');
  expect(groups[2].querySelector('.composer-group-name')).toHaveTextContent('summaries');
  expect(document.querySelector('.composer-summary strong')).toHaveTextContent(
    'One row per customer, with columns from country, and a count of invoice_customer.',
  );
  expect(screen.getByRole('button', { name: 'Added' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: 'Counted' })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Counted' }));
  expect(act.removeAggregate).toHaveBeenCalledWith({ fn: 'count', via: 'invoice.customer_id' });
});

test('numeric summaries emit qualified relationships rather than physical constraint names', async () => {
  const user = userEvent.setup();
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  await user.click(screen.getByRole('button', { name: 'Summarise invoice' }));
  await user.click(screen.getByRole('option', { name: /Total total/ }));
  expect(act.addAggregate).toHaveBeenCalledWith({ fn: 'sum', via: 'invoice.customer_id', column: 'total' });
});

test('count controls retain every column of a composite relationship', async () => {
  const user = userEvent.setup();
  const original = fkInvoice.from.columns;
  fkInvoice.from.columns = ['customer_id', 'tenant_id'];
  try {
    render(
      <div className="composer">
        <Composer />
      </div>,
    );
    await user.click(screen.getByRole('button', { name: 'Count' }));
    expect(act.addAggregate).toHaveBeenCalledWith({ fn: 'count', via: 'invoice.customer_id+tenant_id' });
  } finally {
    fkInvoice.from.columns = original;
  }
});

test('the filter completes paths as you type and a hop keeps the caret at the dot; the preview draws the rows', async () => {
  const user = userEvent.setup();
  snapshot.preview = {
    rows: [{ id: 1, name: 'Nia', country: null }],
    columns: ['id', 'name', 'country'],
    resolved: [
      { name: 'id', path: 'id', type: 'integer', table: 'customer', column: 'id' },
      { name: 'name', path: 'name', type: 'text', table: 'customer', column: 'name' },
      { name: 'country', path: 'country_code.label', type: 'text', table: 'country', column: 'label', hops: 1 },
    ],
    total: 120,
    ms: 3,
    joins: [1],
  };
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  const box = screen.getByRole('textbox', { name: 'Filter' });
  await user.type(box, 'n');
  expect(act.setQuery).toHaveBeenLastCalledWith('n');
  const options = screen.getAllByRole('option');
  expect(options.map((o) => o.textContent)).toEqual(['nametext', 'country_code.→ country']);
  fireEvent.mouseDown(options[1]);
  expect(act.setQuery).toHaveBeenLastCalledWith('country_code.');
  expect(document.querySelector('.result-head .stat')).toHaveTextContent('1 of 120 rows');
  expect(document.querySelectorAll('tbody td')[2]).toHaveClass('null');
  expect(document.querySelector('.composer-th-table')).toHaveTextContent('country');
  await user.click(screen.getByRole('columnheader', { name: /^name/ }));
  expect(act.sortByPath).toHaveBeenCalledWith('name');
  await user.click(screen.getByRole('button', { name: 'Rename name' }));
  expect(act.renameColumn).toHaveBeenCalled();
});

test('the top bar and the saved list drive their actions', async () => {
  const user = userEvent.setup();
  render(
    <div className="composer">
      <Composer />
    </div>,
  );
  await user.type(screen.getByRole('textbox', { name: 'View name' }), 'A');
  expect(act.setName).toHaveBeenCalledWith('A');
  await user.click(screen.getByRole('button', { name: 'Text' }));
  expect(act.toggleText).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(act.saveDraft).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Close the composer' }));
  expect(act.leave).toHaveBeenCalledTimes(1);
  await user.click(screen.getByRole('button', { name: 'Pin Aussies' }));
  expect(act.togglePin).toHaveBeenCalledWith('v1');
  await user.click(screen.getByText('Aussies'));
  expect(act.openSaved).toHaveBeenCalledWith(snapshot.savedViews[0]);
  await user.click(screen.getByRole('button', { name: 'Remove Aussies' }));
  expect(act.removeSaved).toHaveBeenCalledWith(snapshot.savedViews[0]);
});
