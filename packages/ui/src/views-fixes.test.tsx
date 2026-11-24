/* The views' defects that reached review, each held by the case that shows it: a card that vanished, a link that went
   nowhere, a sign-in that said "verified" of credentials nobody had checked. */
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AccountSettingsView } from './views/AccountSettingsView.js';
import { AiAssistantPanel } from './views/AiAssistantView.js';
import { AppShell, Sidebar } from './views/AppShell.js';
import { SignInCard } from './views/AuthSurfaces.js';
import { CalendarView, type CalendarEvent } from './views/CalendarView.js';
import { CsvImportWizard } from './views/CsvImportWizard.js';
import { DataTable } from './views/DataTable.js';
import { GanttView } from './views/GanttView.js';
import { KanbanBoard } from './views/KanbanBoard.js';
import { ReviewQueueView } from './views/ReviewQueueView.js';
import { labelEvery } from './views/axisLabels.js';
import { coerceCsvNumber, headerSimilarity, parseCsvText } from './views/csvRules.js';
import { compareCells, sameRows } from './views/tableRules.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const button = (host: ParentNode, name: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll('button')].filter((b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name);
  if (found.length !== 1) throw new Error(`${found.length} buttons named "${name}"`);
  return found[0]!;
};

const field = (host: ParentNode, label: string): HTMLInputElement => {
  const found = [...host.querySelectorAll('label')].find((l) => l.textContent?.trim().startsWith(label));
  const input = found?.htmlFor ? host.querySelector<HTMLInputElement>(`#${CSS.escape(found.htmlFor)}`) : found?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input;
};

/* Lets every promise a handler returned settle, and React draw what followed. */
const settled = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));

describe('axis labels', () => {
  it('labels fewer ticks as the axis narrows, and all of them where they fit', () => {
    expect(labelEvery(8, 6, 1200)).toBe(1);
    expect(labelEvery(8, 6, 138)).toBeGreaterThanOrEqual(4);
    // Unmeasured, an axis is taken for a phone's, never for one wide enough for everything.
    expect(labelEvery(40, 6, 0)).toBeGreaterThan(1);
  });

  it('GanttView does not label every tick of a ruler it has not measured', () => {
    const { container } = render(<GanttView startDate="2026-09-01" tasks={[{ id: 't1', name: 'Lockout', start: 0, end: 3 }]} />);
    const ruler = container.querySelector('.nx-gantt-ruler')!;
    const labels = ruler.querySelectorAll('[data-slot="spans-axis-label"]');
    // Eight ticks (every second day of fourteen, and both ends); a 320px ruler holds four "Sep 11"s.
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.length).toBeLessThanOrEqual(4);
    expect(container.querySelector('.nx-gantt')?.hasAttribute('data-scrolls')).toBe(true);
  });
});

describe('KanbanBoard', () => {
  const columns = [
    { id: 'queued', title: 'Queued' },
    { id: 'active', title: 'On site' },
  ];

  it('puts a card that arrived after the lanes were worked out in the first lane, not nowhere', () => {
    const lanes = { queued: [], active: [] };
    const { container, rerender } = render(<KanbanBoard columns={columns} cards={[]} defaultValue={lanes} />);
    rerender(<KanbanBoard columns={columns} cards={[{ id: 'k1', title: 'Seal replacement' }]} defaultValue={lanes} />);
    const [queued, active] = [...container.querySelectorAll('.nx-kanban-lane')];
    expect(queued!.textContent).toContain('Seal replacement');
    expect(active!.textContent).not.toContain('Seal replacement');
  });

  it("puts such a card in the lane its own status names, by the lane's id or its title", () => {
    const cards = [
      { id: 'k1', title: 'By id', status: 'active' },
      { id: 'k2', title: 'By title', status: 'On site' },
      { id: 'k3', title: 'Placed', status: 'active' },
    ];
    const { container } = render(<KanbanBoard columns={columns} cards={cards} defaultValue={{ queued: ['k3'], active: [] }} />);
    const [queued, active] = [...container.querySelectorAll('.nx-kanban-lane')];
    expect(active!.textContent).toContain('By id');
    expect(active!.textContent).toContain('By title');
    // A card the lanes do place stays where they put it, whatever it says of itself.
    expect(queued!.textContent).toContain('Placed');
  });

  it('marks the lane that scrolls its cards as scrolling on purpose', () => {
    const { container } = render(<KanbanBoard columns={columns} cards={[]} />);
    for (const list of container.querySelectorAll('.nx-kanban-cards')) expect(list.hasAttribute('data-scrolls')).toBe(true);
  });
});

describe('AppShell', () => {
  it('keeps an item with an address a link when the sidebar is also told of the choice', () => {
    const chosen = vi.fn();
    const { container } = render(
      <Sidebar
        items={[
          { id: 'orders', label: 'Orders', href: '/orders' },
          { id: 'plain', label: 'Plain' },
        ]}
        onSelectItem={chosen}
      />,
    );
    const link = container.querySelector<HTMLAnchorElement>('a.nx-sidebar-item');
    expect(link?.getAttribute('href')).toBe('/orders');
    link!.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(link!);
    expect(chosen).toHaveBeenCalledWith('orders', expect.objectContaining({ href: '/orders' }));
    fireEvent.click(button(container, 'Plain'));
    expect(chosen).toHaveBeenCalledWith('plain', expect.objectContaining({ id: 'plain' }));
  });

  it('opens with a skip link to its main content', () => {
    const { container } = render(<AppShell sidebarProps={{ items: [{ id: 'a', label: 'A', href: '/a' }] }}>Body</AppShell>);
    const skip = container.querySelector<HTMLAnchorElement>('a.nx-skip-link');
    const main = container.querySelector('main');
    expect(skip).not.toBeNull();
    expect(container.querySelector('a, button')).toBe(skip);
    expect(main?.id).toBeTruthy();
    expect(skip!.getAttribute('href')).toBe(`#${main!.id}`);
  });
});

describe('SignInCard', () => {
  const fill = (host: HTMLElement) => {
    fireEvent.input(field(host, 'Email'), { target: { value: 'ana@example.com' } });
    fireEvent.input(field(host, 'Password'), { target: { value: 'hunter2hunter2' } });
  };

  it('says nothing of an outcome a handler did not report', () => {
    const { container } = render(<SignInCard onSignIn={() => undefined} />);
    fill(container);
    fireEvent.click(button(container, 'Sign in'));
    expect(container.textContent).not.toContain('Credentials verified');
    expect(container.textContent).not.toContain('Signed in as');
    expect(container.querySelector('[role="status"]')).toBeNull();
    // Not asked for a second factor by default: the password form is still the one shown.
    expect(container.textContent).not.toContain('Two-factor verification');
  });

  it('waits for the handler, shows that it is waiting, and shows the failure it reports', async () => {
    let answer!: (outcome: { ok: false; error: string }) => void;
    const onSignIn = vi.fn(() => new Promise<{ ok: false; error: string }>((resolve) => (answer = resolve)));
    const { container } = render(<SignInCard onSignIn={onSignIn} />);
    fill(container);
    fireEvent.click(button(container, 'Sign in'));
    const submit = container.querySelector<HTMLButtonElement>('button[type="submit"]')!;
    expect(submit.getAttribute('aria-busy') === 'true' || submit.disabled).toBe(true);
    fireEvent.click(submit);
    expect(onSignIn).toHaveBeenCalledTimes(1);

    answer({ ok: false, error: 'That password is not right.' });
    await settled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('That password is not right.');
    expect(container.querySelector('[role="status"]')).toBeNull();
  });

  it('shows a rejected sign-in as a failure', async () => {
    const { container } = render(<SignInCard onSignIn={() => Promise.reject(new Error('Network unreachable'))} />);
    fill(container);
    fireEvent.click(button(container, 'Sign in'));
    await settled();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Network unreachable');
  });

  it('says signed in only when the handler says so', async () => {
    const { container } = render(<SignInCard onSignIn={() => Promise.resolve({ ok: true })} />);
    fill(container);
    fireEvent.click(button(container, 'Sign in'));
    await settled();
    expect(container.querySelector('[role="status"]')?.textContent).toContain('Signed in as ana@example.com.');
  });

  it('moves to the code step when told to, and does not keep the password', async () => {
    const { container } = render(<SignInCard onSignIn={() => Promise.resolve({ next: '2fa' as const })} />);
    fill(container);
    fireEvent.click(button(container, 'Sign in'));
    await settled();
    expect(container.textContent).toContain('Two-factor verification');
    expect(container.textContent).not.toContain('Credentials verified');
    fireEvent.click(button(container, 'Back to password'));
    expect(field(container, 'Password').value).toBe('');
    expect(field(container, 'Email').value).toBe('ana@example.com');
  });

  it('offers to resend a code only where the host can send one, and reports what the host says', async () => {
    const bare = render(<SignInCard defaultMode="otp" />);
    expect([...bare.container.querySelectorAll('button')].some((b) => b.textContent?.includes('Resend code'))).toBe(false);
    bare.unmount();

    const onResendCode = vi.fn(() => Promise.reject(new Error('Too many requests')));
    const { container } = render(<SignInCard defaultMode="otp" defaultEmail="ana@example.com" onResendCode={onResendCode} />);
    fireEvent.click(button(container, 'Resend code'));
    await settled();
    expect(onResendCode).toHaveBeenCalledWith('ana@example.com');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Too many requests');
    expect(container.textContent).not.toContain('dispatched');
  });
});

describe('AccountSettingsView', () => {
  const createToken = (host: HTMLElement, name: string) => {
    fireEvent.input(field(host, 'Token name'), { target: { value: name } });
    fireEvent.click(button(host, 'Generate token'));
  };

  it("shows the secret the host minted, and never one of Math.random's", async () => {
    const random = vi.spyOn(Math, 'random');
    const onCreateToken = vi.fn(() => Promise.resolve('srv_live_9f8e7d6c5b4a'));
    const { container } = render(<AccountSettingsView layout="stacked" onCreateToken={onCreateToken} />);
    createToken(container, 'etl-worker');
    expect(container.querySelector('.nx-account-secret-code')).toBeNull();
    await settled();
    expect(container.querySelector('.nx-account-secret-code')?.textContent).toBe('srv_live_9f8e7d6c5b4a');
    expect(random).not.toHaveBeenCalled();
  });

  it('falls back to a secret from the platform generator when the host mints none', () => {
    const random = vi.spyOn(Math, 'random');
    const { container } = render(<AccountSettingsView layout="stacked" onCreateToken={() => undefined} />);
    createToken(container, 'etl-worker');
    expect(container.querySelector('.nx-account-secret-code')?.textContent).toMatch(/^token_[0-9a-f]{40}$/);
    expect(random).not.toHaveBeenCalled();
  });

  it('takes the token back and says so when creating it fails', async () => {
    const { container } = render(<AccountSettingsView layout="stacked" onCreateToken={() => Promise.reject(new Error('no'))} />);
    createToken(container, 'etl-worker');
    expect(container.textContent).toContain('1 active');
    await settled();
    expect(container.textContent).toContain('0 active');
    expect(container.querySelector('.nx-account-secret-code')).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be created');
  });

  it('says Copied only when the clipboard took the secret', async () => {
    const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
    try {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
      const { container } = render(<AccountSettingsView layout="stacked" />);
      createToken(container, 'etl-worker');
      fireEvent.click(button(container, 'Copy secret'));
      await settled();
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Copied')).toBe(false);
      expect(container.textContent).toContain('could not be copied');

      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error('denied')) },
      });
      fireEvent.click(button(container, 'Copy secret'));
      await settled();
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Copied')).toBe(false);

      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => Promise.resolve() } });
      fireEvent.click(button(container, 'Copy secret'));
      await settled();
      expect([...container.querySelectorAll('button')].some((b) => b.textContent?.trim() === 'Copied')).toBe(true);
    } finally {
      if (original) Object.defineProperty(navigator, 'clipboard', original);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  it('puts a session back, with a reason, when revoking it is refused', async () => {
    const sessions = [
      {
        id: 's1',
        deviceType: 'laptop' as const,
        client: 'Firefox on Linux',
        ip: '10.0.0.1',
        location: 'Leeds',
        lastActive: 'now',
        current: true,
      },
      { id: 's2', deviceType: 'mobile' as const, client: 'Safari on iPhone', ip: '10.0.0.2', location: 'York', lastActive: '1h ago' },
    ];
    const { container } = render(
      <AccountSettingsView layout="stacked" sessions={sessions} onRevokeSession={() => Promise.reject(new Error('no'))} />,
    );
    fireEvent.click(button(container, 'Revoke 1 other session'));
    expect(container.textContent).not.toContain('Safari on iPhone');
    await settled();
    expect(container.textContent).toContain('Safari on iPhone');
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('could not be revoked');
  });
});

describe('CalendarView', () => {
  const week: CalendarEvent[] = [
    { id: 'e1', title: 'Pump alignment', date: '2026-09-04', startMinutes: 540, endMinutes: 600 },
    { id: 'late', title: 'Night inspection', date: '2026-09-03', startMinutes: 1260, endMinutes: 1320 },
    { id: 'untimed', title: 'Call supplier', date: '2026-09-02' },
  ];
  const view = (events: CalendarEvent[], onEventsChange?: (next: CalendarEvent[]) => void) => (
    <CalendarView defaultMode="week" defaultSelectedDate="2026-09-04" today="2026-09-04" events={events} onEventsChange={onEventsChange} />
  );
  const span = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-slot="spans-span"][data-span-id="${id}"]`)!;
  const nudge = (part: HTMLElement) => {
    act(() => part.focus());
    fireEvent.keyDown(part, { key: 'ArrowDown', altKey: true });
  };

  it('labels an event drawn inside the visible hours with its own time', () => {
    const { container } = render(view(week));
    expect(span(container, 'late').getAttribute('aria-label')).toBe('Night inspection, 9 PM to 10 PM');
    expect(span(container, 'late').textContent).toContain('9 PM');
    // No start, no time to state: only where it is drawn is invented, and that is not said.
    expect(span(container, 'untimed').getAttribute('aria-label')).toBe('Call supplier');
  });

  it('writes back only the event that was moved', () => {
    const heard = vi.fn();
    const { container } = render(view(week, heard));
    nudge(span(container, 'e1'));
    expect(heard).toHaveBeenCalledTimes(1);
    const next = heard.mock.calls[0]![0] as CalendarEvent[];
    expect(next.find((e) => e.id === 'e1')).toMatchObject({ startMinutes: 570, endMinutes: 630 });
    expect(next.find((e) => e.id === 'late')).toBe(week[1]);
    expect(next.find((e) => e.id === 'untimed')).toBe(week[2]);
  });

  it('takes up events the host changes after a drag, uncontrolled', () => {
    const { container, rerender } = render(view(week));
    nudge(span(container, 'e1'));
    expect(span(container, 'e1').getAttribute('aria-label')).toContain('9:30 AM');
    // The same events in a new array are not a change: the drag stands.
    rerender(view([...week]));
    expect(span(container, 'e1').getAttribute('aria-label')).toContain('9:30 AM');
    rerender(view([...week, { id: 'new', title: 'Valve check', date: '2026-09-01', startMinutes: 600, endMinutes: 660 }]));
    expect(span(container, 'new')).not.toBeNull();
  });
});

describe('DataTable', () => {
  it('orders dates by time and numbers by size, with nothing-to-order-by last either way', () => {
    const monday = new Date('2026-09-07T00:00:00Z');
    const friday = new Date('2026-09-11T00:00:00Z');
    // As text these are "Mon Sep 07…" and "Fri Sep 11…": the later day first.
    expect(compareCells(monday, friday, 1)).toBeLessThan(0);
    expect(compareCells(monday, friday, -1)).toBeGreaterThan(0);
    expect([3, Number.NaN, 1, null, 2].sort((a, b) => compareCells(a, b, 1))).toEqual([1, 2, 3, Number.NaN, null]);
    expect([3, Number.NaN, 1, 2].sort((a, b) => compareCells(a, b, -1))).toEqual([3, 2, 1, Number.NaN]);
    expect(compareCells('WO-9', 'WO-10', 1)).toBeLessThan(0);
  });

  it('sorts a date column by date', () => {
    const rows = [
      { id: 'a', due: new Date('2026-09-07T12:00:00Z') },
      { id: 'b', due: new Date('2026-09-11T12:00:00Z') },
      { id: 'c', due: new Date('2026-09-02T12:00:00Z') },
    ];
    const { container } = render(
      <DataTable
        data={rows}
        defaultSort={{ columnId: 'due', direction: 'asc' }}
        columns={[
          { id: 'id', header: 'Id', accessor: 'id' },
          { id: 'due', header: 'Due', accessor: 'due', sortable: true, cell: (row) => row.due.toISOString().slice(0, 10) },
        ]}
      />,
    );
    const order = [...container.querySelectorAll('tbody tr')].map((tr) => tr.querySelector('td')?.textContent);
    expect(order).toEqual(['c', 'a', 'b']);
  });

  it('tells rows that say the same from rows that changed', () => {
    expect(sameRows([{ a: 1 }], [{ a: 1 }])).toBe(true);
    expect(sameRows([{ a: 1 }], [{ a: 2 }])).toBe(false);
    expect(sameRows([{ a: 1 }], [{ a: 1 }, { a: 1 }])).toBe(false);
  });

  it('drops a selection kept by position when the rows change under it', () => {
    const all = [{ name: 'Ana' }, { name: 'Ben' }, { name: 'Cy' }];
    const table = (data: typeof all) => <DataTable data={data} selectable columns={[{ id: 'name', header: 'Name', accessor: 'name' }]} />;
    const { container, rerender } = render(table(all));
    fireEvent.click(container.querySelector('[aria-label="Select row 1"]')!);
    expect(container.querySelectorAll('tr[data-selected]')).toHaveLength(1);
    // The same rows in new objects: nothing changed, the selection stands.
    rerender(table(all.map((row) => ({ ...row }))));
    expect(container.querySelectorAll('tr[data-selected]')).toHaveLength(1);
    // Filtered: position 1 is now Cy, who was never selected.
    rerender(table([all[0]!, all[2]!]));
    expect(container.querySelectorAll('tr[data-selected]')).toHaveLength(0);
  });

  it('hands a bulk action the rows of every page the selection was made on', () => {
    const pages = [[{ id: 'r1', name: 'Ana' }], [{ id: 'r2', name: 'Ben' }]];
    const onAction = vi.fn();
    const table = (page: number) => (
      <DataTable
        data={pages[page]!}
        selectable
        paginated
        pageSize={1}
        totalCount={2}
        page={page + 1}
        bulkActions={[{ id: 'archive', label: 'Archive', onAction }]}
        columns={[{ id: 'name', header: 'Name', accessor: 'name' }]}
      />
    );
    const { container, rerender } = render(table(0));
    fireEvent.click(container.querySelector('[aria-label="Select row r1"]')!);
    rerender(table(1));
    fireEvent.click(container.querySelector('[aria-label="Select row r2"]')!);
    fireEvent.click(button(container, 'Archive'));
    expect(onAction).toHaveBeenCalledWith(['r1', 'r2'], [pages[0]![0], pages[1]![0]]);
  });

  it('shows rows on their way as placeholders, not as an empty table, and scrolls in one marked place', () => {
    const columns = [{ id: 'name', header: 'Name', accessor: 'name' as const }];
    const { container, rerender } = render(<DataTable<{ name: string }> data={[]} loading columns={columns} />);
    expect(container.querySelector('table')?.getAttribute('aria-busy')).toBe('true');
    expect(container.querySelectorAll('tr[data-loading]').length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain('No matching records');
    expect(container.querySelector('.nx-table-scroll')?.hasAttribute('data-scrolls')).toBe(true);
    rerender(<DataTable<{ name: string }> data={[]} columns={columns} />);
    expect(container.textContent).toContain('No matching records');
    expect(container.querySelector('table')?.hasAttribute('aria-busy')).toBe(false);
  });
});

describe('CSV import', () => {
  it('reads the separator off the header line', () => {
    expect(parseCsvText('name;amount\nAna;1,5')).toMatchObject({ delimiter: ';', headers: ['name', 'amount'], rows: [['Ana', '1,5']] });
    expect(parseCsvText('name\tamount\nAna\t2')).toMatchObject({ delimiter: '\t', headers: ['name', 'amount'], rows: [['Ana', '2']] });
    expect(parseCsvText('name,note\nAna,"a;b"')).toMatchObject({ delimiter: ',', rows: [['Ana', 'a;b']] });
  });

  it('stops at a quote that never closes and names its line, instead of swallowing the rows after it', () => {
    const parsed = parseCsvText('name,note\nAna,fine\nBen,"unfinished\nCy,lost\nDee,lost');
    expect(parsed.error?.line).toBe(3);
    expect(parsed.error?.message).toContain('Line 3');
    expect(parsed.rows).toEqual([['Ana', 'fine']]);
    // A quote inside an unquoted cell is an inch mark, not the start of a quoted value.
    expect(parseCsvText('size,part\n5" pipe,elbow\n6" pipe,tee')).toMatchObject({
      rows: [
        ['5" pipe', 'elbow'],
        ['6" pipe', 'tee'],
      ],
    });
  });

  it('reads a number only where it can be read one way', () => {
    expect(coerceCsvNumber('1,5')).toEqual({ kind: 'number', value: 1.5 });
    expect(coerceCsvNumber('1,234,567')).toEqual({ kind: 'number', value: 1234567 });
    expect(coerceCsvNumber('$1,234.50')).toEqual({ kind: 'number', value: 1234.5 });
    expect(coerceCsvNumber('1.234,56')).toEqual({ kind: 'number', value: 1234.56 });
    expect(coerceCsvNumber('1,234')).toEqual({ kind: 'text', value: '1,234', reason: 'ambiguous' });
    expect(coerceCsvNumber('9007199254740993')).toEqual({ kind: 'text', value: '9007199254740993', reason: 'too-large' });
    expect(coerceCsvNumber('1,2,3')).toEqual({ kind: 'invalid' });
    expect(coerceCsvNumber('abc')).toEqual({ kind: 'invalid' });
  });

  it('matches a header to a field by whole words', () => {
    expect(headerSimilarity('id', { key: 'paid_amount', label: 'Paid amount' })).toBe(0);
    expect(headerSimilarity('Paid Amount', { key: 'paid_amount', label: 'Paid amount' })).toBe(100);
    expect(headerSimilarity('amount', { key: 'paid_amount', label: 'Paid amount' })).toBeGreaterThanOrEqual(55);
    expect(headerSimilarity('E-mail', { key: 'email', label: 'Email' })).toBe(100);
  });

  it('draws a capped preview of a long file and says so', () => {
    const csv = ['name', ...Array.from({ length: 450 }, (_, i) => `Row ${i + 1}`)].join('\n');
    const { container } = render(<CsvImportWizard initialCsv={csv} schemaFields={[{ key: 'name', label: 'Name' }]} />);
    fireEvent.click(button(container, 'Map columns'));
    fireEvent.click([...container.querySelectorAll('button')].find((b) => b.textContent?.includes('dry-run'))!);
    expect(container.querySelectorAll('.nx-csv-preview-table tbody tr')).toHaveLength(200);
    expect(container.textContent).toContain('Showing the first 200 of 450 rows');
    expect(container.textContent).toContain('All rows (450)');
  });

  it('refuses to go on from a file it could not read to the end', () => {
    const { container } = render(<CsvImportWizard initialCsv={'name,note\nAna,"open'} schemaFields={[{ key: 'name', label: 'Name' }]} />);
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Line 2');
    expect(button(container, 'Map columns').disabled).toBe(true);
  });
});

describe('AiAssistantPanel', () => {
  it('marks up mentions and record codes, and not email domains or the names of standards', () => {
    const { container } = render(
      <AiAssistantPanel
        messages={[
          {
            id: 'm1',
            role: 'assistant',
            content: 'Mail ana@example.com the SHA-256 of the UTF-16 export for WO-101, then tell @ben.okafor.',
          },
        ]}
      />,
    );
    expect([...container.querySelectorAll('.nx-ai-inline-ref')].map((ref) => ref.textContent)).toEqual(['WO-101', '@ben.okafor']);
  });

  it('follows a growing reply while the reader is at the end, and leaves a reader who scrolled up where they are', () => {
    const message = (content: string) => [{ id: 'm1', role: 'assistant' as const, content, streaming: true }];
    const { container, rerender } = render(<AiAssistantPanel messages={message('One')} />);
    const stream = container.querySelector<HTMLElement>('.nx-ai-panel-stream')!;
    let height = 1000;
    Object.defineProperty(stream, 'scrollHeight', { configurable: true, get: () => height });
    Object.defineProperty(stream, 'clientHeight', { configurable: true, get: () => 400 });

    stream.scrollTop = 600;
    fireEvent.scroll(stream);
    height = 1400;
    // One message still: it is the reply that grew.
    rerender(<AiAssistantPanel messages={message('One two three')} />);
    expect(stream.scrollTop).toBe(1400);

    stream.scrollTop = 200;
    fireEvent.scroll(stream);
    height = 1800;
    rerender(<AiAssistantPanel messages={[...message('One two three four'), { id: 'm2', role: 'assistant' as const, content: 'More' }]} />);
    expect(stream.scrollTop).toBe(200);
  });
});

describe('KanbanBoard lanes and quick-add', () => {
  const columns = [
    { id: 'queued', title: 'Queued' },
    { id: 'active', title: 'In progress' },
  ];
  const cards = [{ id: 'k1', title: 'Seal replacement' }];
  const adds = (host: ParentNode) => host.querySelectorAll('.nx-kanban-header-add, .nx-kanban-add-btn').length;

  it('draws the quick-add only where a created card has somewhere to go, unless asked outright', () => {
    expect(adds(render(<KanbanBoard columns={columns} cards={cards} />).container)).toBe(0);
    expect(adds(render(<KanbanBoard columns={columns} cards={cards} onCreateCard={() => undefined} />).container)).toBe(4);
    expect(adds(render(<KanbanBoard columns={columns} cards={cards} allowCreate />).container)).toBe(4);
    expect(adds(render(<KanbanBoard columns={columns} cards={cards} allowCreate={false} onCreateCard={() => undefined} />).container)).toBe(
      0,
    );
  });

  it('says its row of lanes scrolls on purpose', () => {
    const { container } = render(<KanbanBoard columns={columns} cards={cards} />);
    expect(container.querySelector('.nx-kanban-board')!.hasAttribute('data-scrolls')).toBe(true);
  });
});

describe('sentence case and the outer frame', () => {
  const titleCase = /\b[A-Z][a-z]+ (?:& )?[A-Z][a-z]+/;
  const item = {
    id: 'r1',
    code: 'CR-1',
    title: 'Raise the credit limit',
    requester: { name: 'Ana Ruiz' },
    summary: 'From 10,000 to 25,000.',
    diffs: [{ field: 'Limit', before: '10,000', after: '25,000' }],
    metadata: [{ label: 'Region', value: 'North' }],
  };

  it('AccountSettingsView says its own copy in sentence case', () => {
    const { container } = render(<AccountSettingsView layout="stacked" />);
    const said = [...container.querySelectorAll('h3, label, button, .nx-account-security-title, .nx-badge')].map(
      (el) => el.textContent ?? '',
    );
    expect(said).toContain('Personal profile');
    expect(said.some((text) => text.startsWith('Display name'))).toBe(true);
    expect(said).toContain('Save profile');
    expect(said).toContain('Register passkey');
    expect(said.filter((text) => titleCase.test(text))).toEqual([]);
  });

  it('ReviewQueueView says its own copy in sentence case and still takes the labels it is given', () => {
    const { container } = render(<ReviewQueueView items={[item]} />);
    expect(container.textContent).toContain('Approval and triage queue');
    expect(container.textContent).toContain('Proposed field changes');
    expect(container.textContent).toContain('Context and metadata');
    expect(container.textContent).toContain('Reviewer note');
    expect(button(container, 'Request changesR')).toBeTruthy();
    for (const old of ['Proposed Field Changes', 'Reviewer Note', 'Request Changes', 'Queue Items'])
      expect(container.textContent).not.toContain(old);

    const given = render(<ReviewQueueView items={[item]} title="Sign-Off Desk" requestChangesLabel="Send Back" enableShortcuts={false} />);
    expect(given.container.textContent).toContain('Sign-Off Desk');
    expect(button(given.container, 'Send Back')).toBeTruthy();
  });

  it('both keep their frame unless told they stand inside one', () => {
    const account = render(<AccountSettingsView layout="stacked" />).container.querySelector('.nx-account-settings')!;
    expect(account.hasAttribute('data-framed')).toBe(false);
    const bare = render(<AccountSettingsView layout="stacked" framed={false} />).container.querySelector('.nx-account-settings')!;
    expect(bare.getAttribute('data-framed')).toBe('false');

    const queue = render(<ReviewQueueView items={[item]} />).container.querySelector('.nx-review-queue-shell')!;
    expect(queue.hasAttribute('data-framed')).toBe(false);
    const bareQueue = render(<ReviewQueueView items={[item]} framed={false} />).container.querySelector('.nx-review-queue-shell')!;
    expect(bareQueue.getAttribute('data-framed')).toBe('false');
  });
});
