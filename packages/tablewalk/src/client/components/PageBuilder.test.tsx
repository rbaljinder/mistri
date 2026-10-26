/** The page builder: sections added from what the schema offers, arranged, and saved as one draft. */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { TableMeta } from '../../../../engine/src/shared/schema.js';

const col = (name: string, type: string) => ({ name, type, nullable: true, primaryKey: false });
const customer = {
  id: 'customer',
  name: 'customer',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('id', 'INTEGER'), col('name', 'TEXT'), col('country_code', 'TEXT')],
} as unknown as TableMeta;
const country = {
  id: 'country',
  name: 'country',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('code', 'TEXT'), col('label', 'TEXT')],
} as unknown as TableMeta;
const invoice = {
  id: 'invoice',
  name: 'invoice',
  schema: '',
  isView: false,
  indexed: [],
  columns: [col('id', 'INTEGER'), col('total', 'REAL'), col('customer_id', 'INTEGER')],
} as unknown as TableMeta;
const toasts: string[] = [];
vi.mock('../../../../kit/src/client/core.js', () => ({
  findTable: (id: string) => (({ customer, country, invoice }) as Record<string, TableMeta>)[id],
  refsFrom: (id: string) =>
    id === 'customer'
      ? [{ name: 'customer_country', from: { table: 'customer', columns: ['country_code'] }, to: { table: 'country', columns: ['code'] } }]
      : [],
  tableAtPrefix: (_base: string, prefix: string) => (prefix === 'country_code' ? country : null),
  toast: (m: string) => toasts.push(m),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('./pageDraft.js', async (actual) => ({
  ...(await actual<typeof import('./pageDraft.js')>()),
  asConfig: (p: { name: string }) => `{"pages":[{"name":"${p.name}"}]}`,
}));
const { PageBuilder } = await import('./PageBuilder.js');
type PageDraft = import('./PageBuilder.js').PageDraft;

const relations = [
  {
    from: 'invoice',
    path: 'customer_id',
    label: 'invoice',
    hops: 1,
    via: ['invoice.customer_id'],
    all: ['id', 'total', 'customer_id'],
    defaults: ['id', 'total'],
    columns: ['total'],
  },
];

function draw(draft: PageDraft, derived = false) {
  const props = {
    draft,
    derived,
    original: draft,
    relations,
    references: [],
    onClose: vi.fn(),
    onSave: vi.fn<(draft: PageDraft) => Promise<void>>().mockResolvedValue(undefined),
    onDelete: vi.fn<(page: PageDraft) => Promise<void>>().mockResolvedValue(undefined),
  };
  render(<PageBuilder {...props} />);
  return props;
}

afterEach(() => {
  cleanup();
  toasts.length = 0;
});

test('section region is editable and survives reorder and save without nesting sections', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = {
    id: 'p',
    name: 'Customer',
    base: 'customer',
    source: 'saved',
    sections: [
      { kind: 'fields', title: 'Context', paths: ['name'] },
      { kind: 'fields', title: 'Details', paths: ['id'] },
    ],
  };
  const props = draw(draft);
  await user.click(screen.getAllByRole('button', { name: 'Section region' })[0]);
  await user.click(screen.getByRole('option', { name: 'Aside' }));
  expect(draft.sections[0].region).toBe('aside');
  await user.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
  expect(draft.sections[1]).toMatchObject({ title: 'Context', region: 'aside', paths: ['name'] });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).toHaveBeenCalledWith(
    expect.objectContaining({
      sections: [expect.objectContaining({ title: 'Details' }), expect.objectContaining({ title: 'Context', region: 'aside' })],
    }),
  );
});

test('recovery is an explicit choice and restores uncontrolled name and section inputs', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = { id: 'saved:customer:1', name: 'Fresh', base: 'customer', source: 'saved', sections: [{ kind: 'fields' }] };
  const recovered = { ...draft, name: 'Recovered', sections: [{ kind: 'fields' as const, title: 'Recovered section' }] };
  const changed = vi.fn<(draft: PageDraft) => 'stored'>(() => 'stored');
  const discarded = vi.fn(() => 'empty' as const);
  const close = vi.fn();
  render(
    <PageBuilder
      draft={draft}
      original={structuredClone(draft)}
      derived={false}
      relations={[]}
      references={[]}
      onSave={async () => {}}
      onDelete={async () => {}}
      onClose={close}
      recovery={{ version: 1, original: '{}', revision: 'x', draft: recovered, updatedAt: 1 }}
      recoverySourceChanged
      onDraftChange={changed}
      onDiscard={discarded}
    />,
  );
  expect(screen.getByRole('button', { name: /^Save$/ })).toBeDisabled();
  expect(screen.getByRole('alert')).toHaveTextContent('original page has changed');
  await user.click(screen.getByRole('button', { name: 'Restore draft' }));
  expect(screen.getByRole('textbox', { name: 'Page name' })).toHaveValue('Recovered');
  expect(screen.getByRole('textbox', { name: 'Section title' })).toHaveValue('Recovered section');
  expect(changed).toHaveBeenCalledWith(recovered);
  await user.type(screen.getByRole('textbox', { name: 'Section title' }), ' edited');
  expect(changed.mock.calls.at(-1)?.[0]).toMatchObject({ sections: [{ title: 'Recovered section edited' }] });
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(discarded).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

test('browser navigation is warned only while a draft has changed', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = {
    id: 'saved:customer:warn',
    name: 'Customer',
    base: 'customer',
    source: 'saved',
    sections: [{ kind: 'fields' }],
  };
  draw(draft);
  const clean = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  await user.type(screen.getByRole('textbox', { name: 'Page name' }), ' edited');
  const dirty = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  cleanup();
  const closed = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(closed);
  expect(closed.defaultPrevented).toBe(false);
});

test('adds a group of fields two ways, a count and a list, and saves the draft', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = { id: 'saved:customer:1', name: 'Customer 360', base: 'customer', sections: [], source: 'saved' };
  const props = draw(draft);
  expect(screen.getByRole('dialog', { name: 'Edit page' })).toBeInTheDocument();
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Page name' })).toHaveFocus());
  expect(screen.getByText('No sections yet. Add one below.')).toBeInTheDocument();
  await user.click(screen.getByText('+ Fields'));
  await user.click(screen.getByRole('menuitem', { name: /^country via country_code/ }));
  expect(draft.sections[0]).toMatchObject({
    kind: 'fields',
    title: 'country · via country_code',
    paths: ['country_code.label'],
    columns: 2,
  });
  await user.click(screen.getByText('+ Count'));
  await user.click(screen.getAllByRole('menuitem', { name: /^invoice / }).at(-1)!);
  expect(draft.sections[1]).toMatchObject({ kind: 'metric', fn: 'count', from: 'invoice', path: 'customer_id', width: 'third' });
  await user.click(screen.getByText('+ List'));
  await user.click(screen.getAllByRole('menuitem', { name: /^invoice / }).at(-1)!);
  expect(draft.sections[2]).toMatchObject({ kind: 'list', from: 'invoice', limit: 10, width: 'half' });
  expect(document.querySelectorAll('.pb-section')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).toHaveBeenCalledWith(draft);
});

test('a fields group opens its arranger in place; a list its column picker; hide and remove act on the draft', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = {
    id: 'saved:customer:1',
    name: 'p',
    base: 'customer',
    source: 'saved',
    sections: [
      { kind: 'fields', width: 'full' },
      { kind: 'list', from: 'invoice', path: 'customer_id', title: 'Invoices', limit: 10, width: 'half' },
    ],
  };
  draw(draft);
  const rows = document.querySelectorAll('.pb-section');
  expect(within(rows[0] as HTMLElement).getByText('all 3')).toBeInTheDocument();
  expect(within(rows[1] as HTMLElement).getByText('default')).toBeInTheDocument();
  await user.click(within(rows[0] as HTMLElement).getByText('all 3'));
  expect(document.querySelectorAll('.pb-arrange-row')).toHaveLength(3);
  await user.click(screen.getByRole('button', { name: 'Remove name' }));
  expect(draft.sections[0]).toMatchObject({ paths: ['id', 'country_code'] });
  expect(document.querySelector('.pb-fields-btn')).toHaveTextContent('2 of 3');
  await user.click(document.querySelectorAll('.pb-fields-btn')[1]);
  expect(document.querySelectorAll('.pb-field-row')).toHaveLength(3);
  await user.click(within(document.querySelector('.pb-field-grid')!).getByRole('checkbox', { name: /customer_id/ }));
  expect(draft.sections[1]).toMatchObject({ columns: ['id', 'total', 'customer_id'] });
  await user.click(screen.getByRole('button', { name: 'Default' }));
  expect(draft.sections[1]).toMatchObject({ columns: undefined });
  await user.click(screen.getAllByRole('button', { name: 'Hide this section' })[1]);
  expect(draft.sections[1].hidden).toBe(true);
  await user.click(screen.getAllByRole('button', { name: 'Remove section' })[0]);
  expect(draft.sections).toHaveLength(1);
  expect(draft.sections[0].kind).toBe('list');
});

test('a derived page has no Delete and is a new page; an empty page will not save; Lists as tabs writes the flag', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = { id: 'saved:customer:2', name: 'customer (edited)', base: 'customer', sections: [], source: 'saved' };
  const props = draw(draft, true);
  expect(screen.getByRole('heading', { level: 2 })).toHaveTextContent('New page');
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).not.toHaveBeenCalled();
  expect(toasts).toEqual(['A page needs at least one section.']);
  await user.click(screen.getByRole('checkbox', { name: 'Lists as tabs' }));
  expect(draft.listTabs).toBe(false);
});

test('closing an unchanged draft does not ask to discard it', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] }, true);
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
});

test('a changed draft survives dismissal until discard is explicitly chosen', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
  const input = screen.getByRole('textbox', { name: 'Page name' });
  await user.clear(input);
  await user.type(input, 'Customer desk');
  await user.click(screen.getByRole('button', { name: 'Close' }));
  const confirm = screen.getByRole('dialog', { name: 'Discard unsaved changes?' });
  expect(props.onClose).not.toHaveBeenCalled();
  await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
  expect(input).toHaveValue('Customer desk');
  await user.click(screen.getByRole('button', { name: 'Cancel' }));
  await user.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(props.onClose).toHaveBeenCalledOnce();
  expect(props.onSave).not.toHaveBeenCalled();
});

test('Escape closes a menu, then the field arranger, then asks about unsaved field changes', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
  await user.click(screen.getByRole('button', { name: 'all 3' }));
  await user.click(screen.getByRole('button', { name: 'Remove name' }));
  await user.click(screen.getByRole('button', { name: '+ Fields' }));
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(screen.getByRole('button', { name: 'Remove id' })).toBeVisible();
  expect(props.onClose).not.toHaveBeenCalled();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('button', { name: 'Remove id' })).toBeNull();
  expect(screen.getByRole('button', { name: '2 of 3' })).toHaveFocus();
  expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('dialog', { name: 'Discard unsaved changes?' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog', { name: 'Discard unsaved changes?' })).toBeNull();
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.draft.sections[0]).toMatchObject({ paths: ['id', 'country_code'] });
});

test('Delete is a nested prompt and requires the original saved page name', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
  const remove = screen.getByRole('button', { name: 'Delete' });
  await user.click(remove);
  await waitFor(() => expect(screen.getByRole('textbox', { name: 'Type the page name to confirm' })).toHaveFocus());
  await user.keyboard('{Escape}');
  expect(props.onClose).not.toHaveBeenCalled();
  expect(props.onDelete).not.toHaveBeenCalled();
  await user.click(remove);
  await user.type(screen.getByRole('textbox', { name: 'Type the page name to confirm' }), 'Wrong name');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(props.onDelete).not.toHaveBeenCalled();
  await user.click(remove);
  await user.type(screen.getByRole('textbox', { name: 'Type the page name to confirm' }), 'Customer');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(props.onDelete).toHaveBeenCalledExactlyOnceWith(props.original);
});

test('clipboard failure opens a nested copy prompt without losing the draft', async () => {
  const user = userEvent.setup();
  const clipboard = vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('Denied'));
  try {
    const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
    await user.click(screen.getByRole('button', { name: 'Copy as JSON' }));
    const text = await screen.findByRole('textbox', { name: 'Page' });
    expect(text.tagName).toBe('TEXTAREA');
    expect(text).toHaveValue('{"pages":[{"name":"Customer"}]}');
    await waitFor(() => expect(text).toHaveFocus());
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('textbox', { name: 'Page' })).toBeNull();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSave).not.toHaveBeenCalled();
  } finally {
    clipboard.mockRestore();
  }
});

test('saving blocks duplicate actions and dismissal; rejection retains the draft for retry', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
  let reject!: (reason: Error) => void;
  props.onSave.mockReturnValueOnce(
    new Promise<void>((_resolve, no) => {
      reject = no;
    }),
  );
  const name = screen.getByRole('textbox', { name: 'Page name' });
  await user.clear(name);
  await user.type(name, 'Unsaved changes');
  const save = screen.getByRole('button', { name: 'Save' });
  await user.click(save);
  expect(save).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Close' })).toBeDisabled();
  expect(screen.getByRole('status')).toHaveTextContent('Saving');
  expect(name.closest('.pb-name-row')).toHaveAttribute('inert');
  await user.click(save);
  await user.keyboard('{Escape}');
  expect(props.onSave).toHaveBeenCalledOnce();
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => reject(new Error('Disk full')));
  expect(screen.getByRole('alert')).toHaveTextContent('Page save was not confirmed. Disk full');
  expect(screen.getByRole('alert')).toHaveFocus();
  expect(name).toHaveValue('Unsaved changes');
  expect(save).toBeEnabled();
  await user.click(save);
  expect(props.onSave).toHaveBeenCalledTimes(2);
  expect(props.onSave).toHaveBeenLastCalledWith(props.draft);
  expect(screen.queryByRole('alert')).toBeNull();
});

test('failed deletion retains the editor and restores available actions', async () => {
  const user = userEvent.setup();
  const props = draw({ id: 'p', name: 'Customer', base: 'customer', sections: [{ kind: 'fields' }] });
  let reject!: (reason: Error) => void;
  props.onDelete.mockReturnValueOnce(
    new Promise<void>((_resolve, no) => {
      reject = no;
    }),
  );
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  await user.type(screen.getByRole('textbox', { name: 'Type the page name to confirm' }), 'Customer');
  await user.click(screen.getByRole('button', { name: 'Delete' }));
  expect(screen.getByRole('status')).toHaveTextContent('Deleting');
  expect(screen.getByRole('button', { name: 'Delete' })).toBeDisabled();
  await user.keyboard('{Escape}');
  expect(props.onClose).not.toHaveBeenCalled();
  await act(async () => reject(new Error('Permission denied')));
  expect(screen.getByRole('alert')).toHaveTextContent('Page deletion was not confirmed. Permission denied');
  expect(screen.getByRole('button', { name: 'Delete' })).toBeEnabled();
  expect(screen.getByRole('textbox', { name: 'Page name' })).toHaveValue('Customer');
});

test('timeline streams survive edits and do not acquire a list column picker', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = {
    id: 'p',
    name: 'Customer',
    base: 'customer',
    listTabs: false,
    sections: [
      { kind: 'fields', title: 'Identity', paths: ['name'], names: false },
      {
        kind: 'timeline',
        title: 'Activity',
        streams: [{ from: 'invoice', path: 'customer_id', at: 'issued_on', show: 'id', filter: 'total > 0' }],
        when: 'id > 0',
        width: 'half',
        offsetLeft: 'half',
        limit: 12,
      },
    ],
  };
  const props = draw(draft);
  const streams = structuredClone(draft.sections[1]);
  const timeline = within(document.querySelector('.pb-timeline') as HTMLElement);
  expect(timeline.getByText('1 stream')).toBeVisible();
  expect(timeline.queryByRole('button', { name: 'default' })).toBeNull();
  const title = timeline.getByRole('textbox', { name: 'Section title' });
  await user.clear(title);
  await user.type(title, 'Recent activity');
  await user.click(timeline.getByRole('button', { name: 'Move up' }));
  expect(screen.getAllByRole('textbox', { name: 'Section title' }).map((input) => (input as HTMLInputElement).value)).toEqual([
    'Recent activity',
    'Identity',
  ]);
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).toHaveBeenCalledWith({ ...draft, sections: [{ ...streams, title: 'Recent activity' }, draft.sections[1]] });
});

test('reordering keeps titles and the expanded field editor attached to their section', async () => {
  const user = userEvent.setup();
  const draft: PageDraft = {
    id: 'p',
    name: 'Customer',
    base: 'customer',
    sections: [
      { kind: 'fields', title: 'Identity', paths: ['name'] },
      { kind: 'fields', title: 'Location', paths: ['country_code'] },
    ],
  };
  draw(draft);
  const row = within(document.querySelectorAll('.pb-section')[1] as HTMLElement);
  await user.click(row.getByRole('button', { name: '1 of 3' }));
  await user.click(row.getByRole('button', { name: 'Move up' }));
  const first = within(document.querySelector('.pb-section') as HTMLElement);
  expect(first.getByRole('textbox', { name: 'Section title' })).toHaveValue('Location');
  expect(first.getByRole('button', { name: '1 of 3' })).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('button', { name: 'Remove country_code' })).toBeVisible();
  await user.click(first.getByRole('button', { name: 'Remove section' }));
  expect(screen.getByRole('textbox', { name: 'Section title' })).toHaveValue('Identity');
  expect(screen.queryByRole('button', { name: 'Remove country_code' })).toBeNull();
});

test('list sizing is authored independently of section width and defaults to fit', async () => {
  const user = userEvent.setup();
  const props = draw({
    id: 'p',
    name: 'Customer',
    base: 'customer',
    sections: [{ kind: 'list', from: 'invoice', path: 'customer_id', width: 'half' }],
  });
  await user.click(screen.getByRole('button', { name: 'Table sizing' }));
  await user.click(screen.getByRole('option', { name: 'Scroll columns' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave.mock.calls[0][0].sections[0]).toMatchObject({ sizing: 'scroll', width: 'half' });
  await user.click(screen.getByRole('button', { name: 'Table sizing' }));
  await user.click(screen.getByRole('option', { name: 'Fit columns' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave.mock.calls[1][0].sections[0]).not.toHaveProperty('sizing');
});

test('invalid drafts cannot be saved or exported, and remain editable', async () => {
  const user = userEvent.setup();
  const props = draw({
    id: 'p',
    name: 'Customer',
    base: 'customer',
    sections: [{ kind: 'metric', from: 'invoice', path: 'customer_id', fn: 'sum' }],
  });
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('no column to sum');
  await user.click(screen.getByRole('button', { name: 'Copy as JSON' }));
  expect(screen.getByRole('alert')).toHaveTextContent('no column to sum');
  expect(props.onClose).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Column' }));
  await user.click(screen.getByRole('option', { name: 'total' }));
  await user.click(screen.getByRole('button', { name: 'Save' }));
  expect(props.onSave).toHaveBeenCalledOnce();
});
