/**
 * One value, rendered by what it is: the plain readings, the app's dress,
 * and a reference chip that walks.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ColumnMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';

const opened: unknown[] = [];
let display: Record<string, unknown> | null = null;

const tables: Record<string, unknown> = {};
const asked: unknown[] = [];

vi.mock('../core.js', () => ({
  state: { schema: { tables: [], foreignKeys: [] } },
  columnDisplay: () => display,
  emptyWord: () => 'Empty',
  findTable: (id: string) => tables[id] ?? { id, name: id, columns: [] },
  api: async (...a: unknown[]) => {
    asked.push(a);
    return { rows: [{ id: 7 }] };
  },
  refsFrom: () => [],
  openRecord: (...a: unknown[]) => opened.push(a),
  columnKind,
}));

const { Value, RefJump, Dressed } = await import('./Value.js');
const { dressFor, sayValue } = await import('./valueModel.js');

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra }) as ColumnMeta;

afterEach(() => {
  cleanup();
  opened.length = 0;
  asked.length = 0;
  display = null;
  for (const id of Object.keys(tables)) delete tables[id];
});

describe('a plain value', () => {
  test("a record's tags are chips in their tones, never the JSON they arrive as", () => {
    const { container } = render(<Value col={col('tags', 'tags')} value='[["design","info"],["docs"]]' compact />);
    const chips = [...container.querySelectorAll('.value-tags > .record-tag')].map((chip) => [chip.textContent, chip.className]);
    expect(chips).toEqual([
      ['design', 'record-tag tone tone-info'],
      ['docs', 'record-tag tone tone-neutral'],
    ]);
    expect(container.textContent).not.toContain('[');
    cleanup();
    render(<Value col={col('tags', 'tags')} value="[]" />);
    expect(screen.getByTitle('null').textContent).toBe('Empty');
  });

  test('null and missing values never become zero, false or literal null text', () => {
    render(
      <>
        <Value col={col('total', 'NUMERIC')} value={null} />
        <Value col={col('active', 'BOOLEAN')} value={null} />
        <Value col={col('name', 'TEXT')} value={undefined} />
      </>,
    );
    expect(screen.getAllByText('Empty')).toHaveLength(3);
    expect(screen.getAllByTitle('null')).toHaveLength(3);
  });
  test("compact previews retain full text without the record field's multiline layout", () => {
    const body = 'A long activity note. '.repeat(30);
    render(<Value col={col('body', 'TEXT')} value={body} compact />);
    expect(screen.getByTitle(body.trim())).toHaveTextContent(body.trim());
    expect(document.querySelector('.long-value')).toBeNull();
    cleanup();
    render(<Value col={col('body', 'TEXT')} value={body} />);
    expect(document.querySelector('.long-value')).toHaveTextContent(body.trim());
  });

  test('a short text written on several lines is read as typed, one line per line', () => {
    const checklist = 'Which device:\nSince when:\nWhat it says:';
    expect(sayValue(col('description', 'TEXT'), checklist)).toEqual({ kind: 'long', text: checklist });
    render(<Value col={col('description', 'TEXT')} value={checklist} />);
    expect(document.querySelector('.long-value')?.textContent).toBe(checklist);
  });

  test("is classified by the grid's planner on a row of one", () => {
    expect(sayValue(col('active', 'INTEGER'), 1)).toEqual({ kind: 'boolean', on: true, title: '1' });
    expect(sayValue(col('total', 'NUMERIC'), 12345.5)).toEqual({ kind: 'number', text: '12,345.5', title: '12345.5' });
    // A key is an identifier and is never grouped.
    expect(sayValue(col('id', 'INTEGER', { primaryKey: true }), 17901)).toEqual({ kind: 'number', text: '17901', title: undefined });
    // One value cannot tell a price from a year, so a figure is grouped under 10,000 too; a year column is not.
    expect(sayValue(col('price', 'INTEGER'), 9495)).toEqual({ kind: 'number', text: '9,495', title: '9495' });
    expect(sayValue(col('year', 'INTEGER'), 2025)).toEqual({ kind: 'number', text: '2025', title: undefined });
    expect(sayValue(col('model_year', 'INTEGER'), 2019)).toEqual({ kind: 'number', text: '2019', title: undefined });
    // Through a path the column is its last hop's: a vehicle's year on a deal reads 2026, never "2,026".
    expect(sayValue(col('vehicle_id.year', 'INTEGER'), 2026)).toEqual({ kind: 'number', text: '2026', title: undefined });
    // Past 2^53 the string is shown as it arrived, grouped by hand.
    expect(sayValue(col('big', 'BIGINT'), '9223372036854775807')).toEqual(expect.objectContaining({ text: '9,223,372,036,854,775,807' }));
    expect(sayValue(col('at', 'TIMESTAMP'), '2025-03-14T09:30:00.000Z')).toEqual({
      kind: 'date',
      text: 'Mar 14, 2025, 9:30 AM',
      title: '2025-03-14T09:30:00.000Z',
    });
    expect(sayValue(col('at', 'TIMESTAMP'), '2025-03-14T00:00:00')).toEqual({
      kind: 'date',
      text: 'Mar 14, 2025',
      title: '2025-03-14T00:00:00',
    });
    expect(sayValue(col('on', 'DATE'), '2025-03-14')).toEqual({ kind: 'date', text: 'Mar 14, 2025', title: '2025-03-14' });
    expect(sayValue(col('at', 'TIME'), '09:30:15')).toEqual({ kind: 'date', text: '9:30:15 AM', title: '09:30:15' });
    expect(sayValue(col('code', 'TEXT'), 'on_hold')).toEqual({ kind: 'text', text: 'on_hold', prose: false });
    expect(sayValue(col('name', 'TEXT'), 'Southerly Logistics')).toEqual(expect.objectContaining({ prose: true }));
    expect(sayValue(col('body', 'TEXT'), 'x'.repeat(91)).kind).toBe('long');
  });

  test('renders each kind the way the record page always has', () => {
    render(
      <>
        <Value col={col('active', 'INTEGER')} value={0} />
        <Value col={col('name', 'TEXT')} value="Acme Ltd" />
      </>,
    );
    expect(screen.getByText('✗ no')).toHaveClass('bool-value', 'no');
    expect(screen.getByText('Acme Ltd')).toHaveClass('prose');
  });
});

describe("the app's dress", () => {
  test('a tone is an exact key, a threshold, or the rest', () => {
    const rule = { tone: { open: 'good', '>= 90': 'bad', '*': 'neutral' } };
    expect(dressFor(rule, 'open')).toEqual({ kind: 'tone', tone: 'good', text: 'open', label: 'Open' });
    expect(dressFor(rule, 95)).toEqual({ kind: 'tone', tone: 'bad', text: '95', label: '95' });
    expect(dressFor(rule, 'closed')).toEqual({ kind: 'tone', tone: 'neutral', text: 'closed', label: 'Closed' });
    // A vocabulary word is said as its picker says it; a code or a phrase stays as stored.
    expect(dressFor(rule, 'in_progress')).toMatchObject({ text: 'in_progress', label: 'In progress' });
    expect(dressFor(rule, 'USD')).toMatchObject({ text: 'USD', label: 'USD' });
    expect(dressFor(rule, 'Harbor Auto')).toMatchObject({ text: 'Harbor Auto', label: 'Harbor Auto' });
    // A word no key names reads neutral, without a `'*'` to say so; the prototype is not a vocabulary.
    expect(dressFor({ tone: { open: 'good' } }, 'closed')).toMatchObject({ kind: 'tone', tone: 'neutral' });
    expect(dressFor({ tone: { open: 'good' } }, 'constructor')).toMatchObject({ tone: 'neutral', text: 'constructor' });
  });

  test('money, percent with its bar, a relative day — and a bigint falls through', () => {
    expect(dressFor({ format: 'money', currency: 'EUR' }, 1234)?.text).toMatch(/€|EUR/);
    expect(dressFor({ format: 'percent', bar: true }, 42)).toEqual({ kind: 'percent', text: '42%', bar: 42 });
    expect(dressFor({ format: 'number' }, 12345.5)).toEqual({ kind: 'number', text: '12,345.5', title: '12345.5' });
    expect(dressFor({ format: 'money' }, '9223372036854775807')).toBeNull();
    // Local, not UTC: relativeDay counts from the reader's own today.
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    expect(dressFor({ format: 'relative' }, today)).toEqual({ kind: 'relative', text: 'today', title: today });
  });

  test('a due date passed on a row still open is drawn in the warning tone, and only then', () => {
    const day = (offset: number) => {
      const d = new Date();
      d.setDate(d.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    display = { format: 'relative' };
    const due = col('due_on', 'DATE');
    // Tick's task: a yes-or-no named like done that is no.
    render(<Value col={due} value={day(-3)} tableId="task" row={{ completed: false, due_on: day(-3) }} />);
    expect(screen.getByText('3 days ago')).toHaveClass('date-value', 'overdue');
    cleanup();
    // Past the near window it is the date, still in the tone.
    render(<Value col={due} value={day(-40)} tableId="task" row={{ completed: 0, due_on: day(-40) }} />);
    expect(document.querySelector('.date-value')).toHaveClass('overdue');
    cleanup();
    // Done, today, ahead, a row that says nothing of open, or a date that is not a due date: no tone.
    for (const [name, value, row] of [
      ['due_on', day(-3), { completed: true }],
      ['due_on', day(0), { completed: false }],
      ['due_on', day(5), { completed: false }],
      ['due_on', day(-3), { name: 'x' }],
      ['created_at', day(-3), { completed: false }],
    ] as const) {
      render(<Value col={col(name, 'DATE')} value={value} tableId="task" row={row} />);
      expect(document.querySelector('.date-value')).not.toHaveClass('overdue');
      cleanup();
    }
  });

  test('a dressed value is drawn as the record and the grid both draw it', () => {
    display = { format: 'percent', bar: true };
    render(<Value col={col('score', 'INTEGER')} value={30} tableId="lead" />);
    expect(screen.getByTitle('30%').querySelector('.pct-fill')).toHaveStyle({ width: '30%' });
    cleanup();
    render(<Dressed dress={{ kind: 'tone', tone: 'good', text: 'in_progress', label: 'In progress' }} />);
    // The label is drawn; the stored word is kept for the reader who writes a query.
    expect(screen.getByText('In progress')).toHaveClass('tone', 'tone-good');
    expect(screen.getByText('In progress')).toHaveAttribute('title', 'in_progress');
  });
});

describe('a masked value', () => {
  test('is a placeholder everywhere it is drawn: no title, no link, no renderer, the value nowhere in the page', () => {
    const token = 'sk_live_4eC39HqLyjWDarjtT1zdp7dc';
    display = { masked: true };
    render(
      <>
        <Value col={col('email', 'TEXT')} value={token} tableId="api_key" />
        <Value col={col('email', 'TEXT')} value={token} tableId="api_key" compact />
      </>,
    );
    expect(screen.getAllByText('••••••')).toHaveLength(2);
    expect(document.body.innerHTML).not.toContain('sk_live');
    expect(document.querySelector('[title]')).toBeNull();
    expect(dressFor({ masked: true }, null)).toBeNull();
  });

  test('a prefix masks only the values that start with it, saying the prefix', () => {
    const rule = { masked: { prefix: 'ENC:' }, tone: { '*': 'neutral' } };
    expect(dressFor(rule, 'ENC:QUJDREVGR0g=')).toEqual({ kind: 'masked', text: 'ENC:••••••' });
    expect(dressFor(rule, 'plain')).toMatchObject({ kind: 'tone', label: 'Plain' });
  });

  test('a long unbroken token is said by its start, the whole on request; the Workbench too', async () => {
    const blob = `ENC:${'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo='.repeat(8)}`;
    expect(sayValue(col('sealed', 'TEXT'), blob)).toEqual({ kind: 'opaque', text: blob, head: blob.slice(0, 24) });
    // Prose that runs long is still prose.
    expect(sayValue(col('body', 'TEXT'), 'word '.repeat(30)).kind).toBe('long');
    render(<Value col={col('sealed', 'TEXT')} value={blob} />);
    expect(document.body.textContent).not.toContain(blob);
    await userEvent.click(screen.getByRole('button', { name: `Show all ${blob.length} characters` }));
    expect(document.querySelector('.value-opaque-open')).toHaveTextContent(blob);
    cleanup();
    render(<Value col={col('sealed', 'TEXT')} value={blob} compact />);
    expect(screen.getByText(`${blob.slice(0, 24)}…`)).toHaveClass('value-opaque');
  });
});

describe('a reference chip', () => {
  test('shows the value and what it is an id of, and opens the row', async () => {
    const user = userEvent.setup();
    render(<RefJump references={{ table: 'customer', column: 'id' }} value={4} />);
    const chip = screen.getByRole('button', { name: /4/ });
    expect(chip).toHaveAttribute('data-ref-table', 'customer');
    expect(chip).toHaveTextContent('customer');
    await user.click(chip);
    expect(opened).toEqual([['customer', { id: 4 }, 'customer 4']]);
  });

  test('a soft key opens its record by the primary key, read once', async () => {
    const user = userEvent.setup();
    tables.product = { id: 'product', name: 'product', columns: [col('id', 'INTEGER', { primaryKey: true }), col('sku', 'TEXT')] };
    render(<RefJump references={{ table: 'product', column: 'sku' }} value="LNT-01" label="Lantern" />);
    await user.click(screen.getByRole('button'));
    await vi.waitFor(() => expect(opened).toEqual([['product', { id: 7 }, 'product LNT-01']]));
    expect(asked).toEqual([
      [
        '/api/query',
        { table: 'product', columns: ['id'], filter: { groups: [[{ column: 'sku', op: '=', value: 'LNT-01' }]] }, limit: 1, offset: 0 },
      ],
    ]);
  });

  test('a chip that already shows the name does not explain the table', () => {
    render(<RefJump references={{ table: 'country', column: 'code' }} value="AU" label="Australia" />);
    const chip = screen.getByRole('button');
    expect(chip).toHaveTextContent('Australia');
    expect(chip.querySelector('.ref-jump-table')).toBeNull();
    expect(chip).toHaveAttribute('title', 'Open Australia (country AU)');
  });
});

describe('the building blocks a display rule adds', () => {
  test('an avatar says the name beside two initials, and one name keeps one colour', async () => {
    const { initialsOf, hueOf } = await import('./valueModel.js');
    expect(initialsOf('Margot Fontaine')).toBe('MF');
    expect(initialsOf('stonebridge-marine inc')).toBe('SM');
    expect(initialsOf('  ')).toBe('?');
    expect(hueOf('Hugo Duval')).toBe(hueOf('Hugo Duval'));
    const dress = dressFor({ avatar: true }, 'Hugo Duval');
    expect(dress).toMatchObject({ kind: 'avatar', text: 'Hugo Duval', initials: 'HD' });
    render(<Dressed dress={dress!} />);
    expect(screen.getByText('Hugo Duval')).toBeVisible();
    expect(screen.getByText('HD')).toHaveAttribute('aria-hidden', 'true');
  });

  test('a meter fills against its max, and its tone colours the bar instead of making a pill', () => {
    const dress = dressFor({ format: 'number', bar: true, max: 40, tone: { '>= 32': 'bad' } }, 36);
    expect(dress).toMatchObject({ kind: 'meter', text: '36', fill: 90, tone: 'bad' });
    const { container } = render(<Dressed dress={dress!} />);
    expect(container.querySelector('.meter-wrap.meter-bad .pct-fill')).toHaveStyle({ width: '90%' });
    expect(container.querySelector('.tone')).toBeNull();
  });

  test('a meter never reads past its ends, and an id past 2^53 is left alone', () => {
    expect(dressFor({ bar: true, max: 10 }, 25)).toMatchObject({ fill: 100 });
    expect(dressFor({ bar: true, max: 10 }, -3)).toMatchObject({ fill: 0 });
    expect(dressFor({ bar: true, max: 10 }, '9007199254740993')).toBeNull();
  });
});

describe('a value to act on', () => {
  afterEach(() => {
    document.body.classList.remove('app-mode');
  });
  test('in an App an email, a phone and a web address are links, by rule or by a column named for them', () => {
    document.body.classList.add('app-mode');
    render(
      <>
        <Value col={col('email', 'TEXT')} value="liam.tanaka@example.org" tableId="lead" />
        <Value col={col('phone', 'TEXT')} value="+64 28 335 4014" tableId="lead" />
        <Value col={col('website', 'TEXT')} value="https://riverstone.example/" tableId="account" />
      </>,
    );
    expect(screen.getByRole('link', { name: 'liam.tanaka@example.org' })).toHaveAttribute('href', 'mailto:liam.tanaka@example.org');
    expect(screen.getByRole('link', { name: '+64 28 335 4014' })).toHaveAttribute('href', 'tel:+64283354014');
    const site = screen.getByRole('link', { name: 'riverstone.example' });
    expect(site).toHaveAttribute('href', 'https://riverstone.example/');
    expect(site).toHaveAttribute('rel', 'noopener noreferrer');
  });
  test('only a value of the right shape is linked, only on http, and never inside another target', () => {
    document.body.classList.add('app-mode');
    display = { format: 'url' };
    render(
      <>
        <Value col={col('notes', 'TEXT')} value="javascript:alert(1)" tableId="lead" />
        <Value col={col('homepage', 'TEXT')} value="www.example.test" tableId="lead" compact />
      </>,
    );
    expect(screen.queryAllByRole('link')).toHaveLength(0);
    display = null;
    cleanup();
    render(<Value col={col('email', 'TEXT')} value="ask at the desk" tableId="lead" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
  test('the Workbench shows the data exactly', () => {
    render(<Value col={col('email', 'TEXT')} value="liam.tanaka@example.org" tableId="lead" />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});

/* SQLite stores a yes/no as 1 and 0, and an author keys its rule by true and false: the cell said a bare "1". */
describe("a yes/no column's rule", () => {
  test('reads 1 and 0 as true and false, for its words, its tone and its marks', async () => {
    const { yesNoRule } = await import('./valueModel.js');
    const rule = yesNoRule({ values: { true: 'Active', false: 'Left' }, tone: { true: 'good', '*': 'neutral' } });
    expect(dressFor(rule, 1)).toEqual({ kind: 'tone', tone: 'good', text: '1', label: 'Active' });
    expect(dressFor(rule, 0)).toEqual({ kind: 'tone', tone: 'neutral', text: '0', label: 'Left' });
    expect(dressFor(rule, true)).toEqual({ kind: 'tone', tone: 'good', text: 'true', label: 'Active' });
    expect(dressFor(yesNoRule({ values: { true: 'Paid', false: 'Owing' } }), '0')).toEqual({ kind: 'word', text: '0', label: 'Owing' });
  });
  test('a tone with no word of its own says ✓ and ✗, as the plain cell does', async () => {
    const { yesNoRule } = await import('./valueModel.js');
    const rule = yesNoRule({ tone: { true: 'bad' } });
    expect(dressFor(rule, 1)).toMatchObject({ kind: 'tone', tone: 'bad', label: '✓' });
    expect(dressFor(rule, 0)).toMatchObject({ kind: 'tone', label: '✗' });
  });
});

describe('the face a value is set in', () => {
  test('a rule’s face wraps the value, and an App reads a name in the reading face but keeps a code in the data face', () => {
    document.body.classList.add('app-mode');
    try {
      display = { face: 'code' };
      const { container } = render(<Value col={col('vin', 'TEXT')} value="1HGCM82633A004352" tableId="car" />);
      expect(container.querySelector('.face-code')).not.toBeNull();
      cleanup();
      display = null;
      render(<Value col={col('make', 'TEXT')} value="Toyota" tableId="car" />);
      expect(document.querySelector('.prose')?.textContent).toBe('Toyota');
      cleanup();
      render(<Value col={col('stock_number', 'TEXT')} value="A1234" tableId="car" />);
      expect(document.querySelector('.prose')).toBeNull();
    } finally {
      document.body.classList.remove('app-mode');
    }
  });
});
