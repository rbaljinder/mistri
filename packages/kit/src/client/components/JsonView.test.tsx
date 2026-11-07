/**
 * A JSON document drawn: laid out by its shape, folded past two levels, a
 * page of a long array at a time; a tree a keyboard walks; a filter that
 * marks and opens; each node's value and path a click away; the raw text
 * tinted, numbered and wrapped on asking; and Copy.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { parseJsonText } from './jsonModel.js';

vi.mock('../core.js', () => ({ formatLocale: () => 'en-US' }));

const { JsonView } = await import('./JsonView.js');

afterEach(() => cleanup());

const item = (name: string) => screen.getByRole('treeitem', { name });

describe('the layout', () => {
  test('an object is quiet labels beside values, and each scalar says what it is', () => {
    render(
      <JsonView
        value={{
          name: 'Ada',
          active: true,
          retired: false,
          score: 1234.5,
          left: null,
          site: 'https://example.com/ada',
          born: '1815-12-10',
          note: '',
          brand: '#1d6a5a',
          owner: 'ada@example.com',
        }}
      />,
    );
    expect(screen.getByText('name')).toHaveClass('json-key');
    expect(screen.getByText('Ada')).toHaveClass('json-text');
    expect(screen.getByText('true')).toHaveClass('json-bool');
    expect(screen.getByText('false')).toHaveClass('json-bool');
    expect(screen.getByText('1,234.5')).toHaveClass('json-number');
    expect(screen.getByText('null')).toHaveClass('json-null');
    const link = screen.getByRole('link', { name: 'https://example.com/ada' });
    expect(link).toHaveAttribute('href', 'https://example.com/ada');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Dec 10, 1815')).toHaveAttribute('title', '1815-12-10');
    expect(screen.getByTitle('An empty string')).toHaveTextContent('""');
    // A machine's strings: a color with its swatch, an address in the code face.
    const brand = screen.getByText('#1d6a5a');
    expect(brand).toHaveClass('json-code');
    expect(brand.querySelector('.json-swatch')).toHaveStyle({ background: '#1d6a5a' });
    expect(screen.getByText('ada@example.com')).toHaveClass('json-code');
    expect(screen.getByText('Ada')).not.toHaveClass('json-code');
  });

  test('like records are a table whose rows say their columns, and short words are chips', () => {
    const { container } = render(
      <JsonView
        value={{
          lines: [
            { sku: 'A-1', qty: 2 },
            { sku: 'B-2', qty: 5, rush: true },
          ],
          tags: ['red', 'blue'],
        }}
      />,
    );
    const table = container.querySelector<HTMLElement>('table.json-table')!;
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(['sku', 'qty', 'rush', '']);
    expect(item('Row 1: sku A-1, qty 2')).toBeInTheDocument();
    expect(item('Row 2: sku B-2, qty 5, rush true')).toBeInTheDocument();
    expect(within(table).getByText('true')).toBeInTheDocument();
    expect(item('lines: 2 items')).toHaveAttribute('aria-expanded', 'true');
    expect(
      within(item('tags: 2 items'))
        .getAllByRole('treeitem')
        .map((li) => li.getAttribute('aria-label')),
    ).toEqual(['0: red', '1: blue']);
  });

  test('two levels are open; the third folds behind its count and opens on asking', async () => {
    render(<JsonView value={{ customer: { address: { city: 'Oslo', zip: '0150' } } }} />);
    expect(item('customer: 1 key')).toHaveAttribute('aria-expanded', 'true');
    const address = item('address: 2 keys');
    expect(address).toHaveAttribute('aria-expanded', 'false');
    expect(address).toHaveTextContent('▸address{2 keys}');
    expect(screen.queryByText('Oslo')).toBeNull();
    await userEvent.click(within(address).getByText('{2 keys}'));
    expect(address).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Oslo')).toBeInTheDocument();
    await userEvent.click(within(address).getByText('address'));
    expect(screen.queryByText('Oslo')).toBeNull();
  });

  test("a table's nested values start folded, and a wide table folds its extra columns per row", () => {
    const row = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    const { container } = render(<JsonView value={[{ ...row, meta: { a: 1 } }, row]} />);
    expect([...container.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual([
      'k0',
      'k1',
      'k2',
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
      '+3 more',
      '',
    ]);
    expect(item('Row 1, the rest: 3 keys')).toHaveAttribute('aria-expanded', 'false');
    expect(item('Row 2, the rest: 2 keys')).toHaveAttribute('aria-expanded', 'false');
  });

  test('a long array shows its first page, then the rest on asking', async () => {
    render(<JsonView value={{ ids: Array.from({ length: 45 }, (_, i) => `id-${i}`) }} />);
    const ids = item('ids: 45 items');
    expect(within(ids).getAllByRole('treeitem')).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Show 25 more' }));
    expect(within(ids).getAllByRole('treeitem')).toHaveLength(45);
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  });
});

const payload = {
  id: 'evt_1',
  type: 'invoice.paid',
  customer: { name: 'Ada', email: 'ada@example.com', address: { city: 'London', geo: { lat: 51.5 } } },
  lines: [
    { sku: 'A-1', qty: 1 },
    { sku: 'B-2', qty: 5 },
  ],
  tags: ['net-30', 'renewal'],
  'x-ada-flag': true,
};

describe('expand and collapse', () => {
  test('Expand all opens every level; Collapse all folds every one; a fold by hand still works after either', async () => {
    render(<JsonView value={payload} />);
    expect(screen.queryByText('51.5')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Expand all' }));
    expect(screen.getByText('51.5')).toBeInTheDocument();
    expect(screen.getAllByRole('treeitem').filter((node) => node.getAttribute('aria-expanded') === 'false')).toEqual([]);
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(screen.getAllByRole('treeitem').map((node) => node.getAttribute('aria-level'))).toEqual(['1', '1', '1', '1', '1', '1']);
    expect(screen.getAllByRole('treeitem').filter((node) => node.getAttribute('aria-expanded') === 'true')).toEqual([]);
    await userEvent.click(within(item('customer: 3 keys')).getByText('customer'));
    expect(item('customer: 3 keys')).toHaveAttribute('aria-expanded', 'true');
    expect(item('address: 2 keys')).toHaveAttribute('aria-expanded', 'false');
  });

  test('a document with nothing to fold offers neither', () => {
    render(<JsonView value={{ a: 1, b: 'two' }} />);
    expect(screen.queryByRole('button', { name: 'Expand all' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Collapse all' })).toBeNull();
  });
});

describe('the filter', () => {
  test('is offered past a dozen nodes, not before', () => {
    render(<JsonView value={{ a: 1, b: 2 }} />);
    expect(screen.queryByRole('searchbox')).toBeNull();
    cleanup();
    render(<JsonView value={payload} />);
    expect(screen.getByRole('searchbox', { name: 'Filter keys and values' })).toBeInTheDocument();
  });

  test('marks each match in keys and values, opens what holds one, folds the rest, and says how many', async () => {
    const { container } = render(<JsonView value={payload} />);
    await userEvent.type(screen.getByRole('searchbox'), 'ada');
    expect(await screen.findByText('3 matches')).toBeInTheDocument();
    expect([...container.querySelectorAll('mark')].map((mark) => mark.textContent)).toEqual(['Ada', 'ada', 'ada']);
    expect(container.querySelector('mark')!.closest('.json-text')).not.toBeNull();
    expect(item('customer: 3 keys')).toHaveAttribute('aria-expanded', 'true');
    // Nothing found inside: folded while the filter stands.
    expect(item('lines: 2 items')).toHaveAttribute('aria-expanded', 'false');
    await userEvent.clear(screen.getByRole('searchbox'));
    await userEvent.type(screen.getByRole('searchbox'), 'lat');
    expect(await screen.findByText('1 match')).toBeInTheDocument();
    // The ancestors of a deep match open, every one of them.
    expect(item('address: 2 keys')).toHaveAttribute('aria-expanded', 'true');
    expect(item('geo: 1 key')).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('mark')).toHaveTextContent('lat');
  });

  test('a value is marked whole when its JSON matched and its words did not', async () => {
    const { container } = render(<JsonView value={{ ...payload, total: 12500 }} />);
    await userEvent.type(screen.getByRole('searchbox'), '12500');
    expect(await screen.findByText('1 match')).toBeInTheDocument();
    expect(container.querySelector('mark')).toHaveTextContent('12,500');
  });

  test('a match past the page is drawn anyway', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `id-${i}`);
    render(<JsonView value={{ ids }} />);
    expect(screen.queryByText('id-57')).toBeNull();
    await userEvent.type(screen.getByRole('searchbox'), 'id-57');
    expect(await screen.findByText('1 match')).toBeInTheDocument();
    expect(item('57: id-57')).toBeInTheDocument();
  });

  test('says when nothing matches, folding nothing; Escape clears it, and / finds it', async () => {
    render(<JsonView value={payload} />);
    const box = screen.getByRole('searchbox');
    await userEvent.type(box, 'zebra');
    expect(await screen.findByText('No matches')).toBeInTheDocument();
    expect(item('customer: 3 keys')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{Escape}');
    expect(box).toHaveValue('');
    act(() => item('id: evt_1').focus());
    await userEvent.keyboard('/');
    expect(box).toHaveFocus();
  });
});

describe('the keyboard', () => {
  test('one Tab stop; Up and Down walk what is open; Right opens then enters; Left folds then leaves; Home and End', async () => {
    render(<JsonView value={{ a: 1, b: { c: { d: 2 } }, e: 3 }} />);
    const tree = screen.getByRole('tree', { name: 'JSON document' });
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .filter((node) => node.tabIndex === 0),
    ).toHaveLength(1);
    // The bar's tools come first; the tree is the next stop, on its first node.
    act(() => screen.getByRole('button', { name: 'Copy' }).focus());
    await userEvent.tab();
    expect(item('a: 1')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(item('b: 1 key')).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    const c = item('c: 1 key');
    expect(c).toHaveFocus();
    expect(c).toHaveAttribute('aria-level', '2');
    expect(c).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{ArrowRight}');
    expect(c).toHaveAttribute('aria-expanded', 'true');
    expect(c).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    expect(item('d: 2')).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(c).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(c).toHaveAttribute('aria-expanded', 'false');
    await userEvent.keyboard('{ArrowLeft}');
    expect(item('b: 1 key')).toHaveFocus();
    await userEvent.keyboard('{End}');
    expect(item('e: 3')).toHaveFocus();
    await userEvent.keyboard('{Home}');
    expect(item('a: 1')).toHaveFocus();
    // The node last visited is the one Tab stop.
    await userEvent.keyboard('{ArrowDown}');
    expect(
      within(tree)
        .getAllByRole('treeitem')
        .filter((node) => node.tabIndex === 0),
    ).toEqual([item('b: 1 key')]);
  });

  test('Enter and Space fold the node they are on; a node collapsed away hands the Tab stop back', async () => {
    render(<JsonView value={{ b: { c: { d: 2 } } }} />);
    act(() => item('c: 1 key').focus());
    await userEvent.keyboard('{Enter}');
    expect(item('c: 1 key')).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard(' ');
    expect(item('c: 1 key')).toHaveAttribute('aria-expanded', 'false');
    act(() => item('c: 1 key').focus());
    await userEvent.click(screen.getByRole('button', { name: 'Collapse all' }));
    expect(item('b: 1 key')).toHaveAttribute('tabindex', '0');
  });

  test("the current node's copies and links are the Tab stops after it; no other node's are", async () => {
    render(<JsonView value={{ a: 'https://example.com/a', b: 'https://example.com/b' }} />);
    const links = screen.getAllByRole('link');
    expect(links.map((link) => link.tabIndex)).toEqual([0, -1]);
    act(() => screen.getByRole('button', { name: 'Copy' }).focus());
    await userEvent.tab();
    expect(item('a: https://example.com/a')).toHaveFocus();
    await userEvent.tab();
    expect(links[0]).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Copy value of a' })).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Copy path a' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Copy value of b' })).toHaveAttribute('tabindex', '-1');
  });
});

describe('copy', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  });

  test('Copy writes the pretty-printed text and says so; a refused clipboard is said too', async () => {
    writeText.mockReset().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    render(<JsonView value={{ a: 1 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
    expect(screen.getByRole('status')).toHaveTextContent('Copied the JSON.');
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    expect(await screen.findByRole('button', { name: 'Copy refused' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('The browser refused clipboard access, so nothing was copied.');
  });

  test("a node's value is copied as itself and its path as code reaches it, a key that is not a name in brackets", async () => {
    const read = parseJsonText('{"headers": {"x-request-id": "r-1", "id": 9007199254740993}, "lines": [{"sku": "A"}, {"sku": "B"}]}')!;
    render(<JsonView value={read.value as object} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy path headers["x-request-id"]' }));
    expect(await screen.findByText('Copied the path headers["x-request-id"].')).toHaveAttribute('role', 'status');
    expect(writeText).toHaveBeenLastCalledWith('headers["x-request-id"]');
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of headers["x-request-id"]' }));
    await screen.findByText('Copied the value of headers["x-request-id"].');
    expect(writeText).toHaveBeenLastCalledWith('r-1');
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of headers.id' }));
    await screen.findByText('Copied the value of headers.id.');
    expect(writeText).toHaveBeenLastCalledWith('9007199254740993');
    fireEvent.click(screen.getByRole('button', { name: 'Copy path lines[1]' }));
    expect(writeText).toHaveBeenLastCalledWith('lines[1]');
    fireEvent.click(screen.getByRole('button', { name: 'Copy value of lines[1]' }));
    await screen.findByText('Copied the value of lines[1].');
    expect(writeText).toHaveBeenLastCalledWith('{\n  "sku": "B"\n}');
  });
});

describe('raw', () => {
  test('Tree | Raw swaps the layout for the pretty-printed text, and back', async () => {
    const { container } = render(<JsonView value={{ a: 1, b: [true] }} />);
    const tree = screen.getByRole('button', { name: 'Tree' });
    const raw = screen.getByRole('button', { name: 'Raw' });
    expect(tree).toHaveAttribute('aria-pressed', 'true');
    expect(raw).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(raw);
    expect(raw).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('region', { name: 'Raw JSON' }).textContent).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    expect(container.querySelector('.json-fields')).toBeNull();
    await userEvent.click(tree);
    expect(screen.queryByRole('region', { name: 'Raw JSON' })).toBeNull();
    expect(container.querySelector('.json-fields')).not.toBeNull();
  });

  test('each line is numbered in a gutter that is not text, tinted by type, big integers in all their digits; Wrap wraps', async () => {
    const read = parseJsonText('{"id": 9007199254740993, "name": "naïve \\"q\\"", "ok": false, "none": null}')!;
    render(<JsonView value={read.value as object} />);
    await userEvent.click(screen.getByRole('button', { name: 'Raw' }));
    const region = screen.getByRole('region', { name: 'Raw JSON' });
    const lines = region.querySelectorAll('.json-line');
    expect([...lines].map((line) => line.getAttribute('data-n'))).toEqual(['1', '2', '3', '4', '5', '6']);
    // The number is an attribute drawn by CSS: the text is the JSON alone.
    expect(region.textContent).toBe('{\n  "id": 9007199254740993,\n  "name": "naïve \\"q\\"",\n  "ok": false,\n  "none": null\n}');
    const tint = (kind: string) => [...region.querySelectorAll(`.json-t-${kind}`)].map((token) => token.textContent);
    expect(tint('key')).toEqual(['"id"', '"name"', '"ok"', '"none"']);
    expect(tint('number')).toEqual(['9007199254740993']);
    expect(tint('string')).toEqual(['"naïve \\"q\\""']);
    expect(tint('boolean')).toEqual(['false']);
    expect(tint('null')).toEqual(['null']);
    expect(tint('punct')).toContain('{');
    const wrap = screen.getByRole('button', { name: 'Wrap' });
    expect(wrap).toHaveAttribute('aria-pressed', 'false');
    expect(region).not.toHaveClass('is-wrapped');
    await userEvent.click(wrap);
    expect(wrap).toHaveAttribute('aria-pressed', 'true');
    expect(region).toHaveClass('is-wrapped');
  });
});
