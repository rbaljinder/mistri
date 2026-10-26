/**
 * A JSON document drawn: laid out by its shape, folded past two levels, a
 * page of a long array at a time, the raw text on asking, and Copy.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../core.js', () => ({ formatLocale: () => 'en-US' }));

const { JsonView } = await import('./JsonView.js');

afterEach(() => cleanup());

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
        }}
      />,
    );
    expect(screen.getByText('name').tagName).toBe('DT');
    expect(screen.getByText('Ada')).toBeInTheDocument();
    expect(screen.getByText('Yes')).toHaveClass('json-bool', 'yes');
    expect(screen.getByText('No')).toHaveClass('json-bool');
    expect(screen.getByText('No')).not.toHaveClass('yes');
    expect(screen.getByText('1,234.5')).toHaveClass('json-number');
    expect(screen.getByTitle('null')).toHaveTextContent('—');
    const link = screen.getByRole('link', { name: 'https://example.com/ada' });
    expect(link).toHaveAttribute('href', 'https://example.com/ada');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByText('Dec 10, 1815')).toHaveAttribute('title', '1815-12-10');
    expect(screen.getByTitle('An empty string')).toHaveTextContent('""');
  });

  test('like records are a table and short words are chips', () => {
    render(
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
    const table = screen.getByRole('table');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['sku', 'qty', 'rush']);
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(within(table).getByText('Yes')).toBeInTheDocument();
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(['red', 'blue']);
  });

  test('two levels are open; the third folds behind its count and opens on asking', async () => {
    render(<JsonView value={{ customer: { address: { city: 'Oslo', zip: '0150' } } }} />);
    expect(screen.getByRole('button', { name: 'customer: 1 key' })).toHaveAttribute('aria-expanded', 'true');
    const address = screen.getByRole('button', { name: 'address: 2 keys' });
    expect(address).toHaveAttribute('aria-expanded', 'false');
    expect(address).toHaveTextContent('▸2 keys');
    expect(screen.queryByText('Oslo')).toBeNull();
    await userEvent.click(address);
    expect(address).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Oslo')).toBeInTheDocument();
    await userEvent.click(address);
    expect(screen.queryByText('Oslo')).toBeNull();
  });

  test("a table's nested values start folded, and a wide table folds its extra columns per row", () => {
    const row = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i]));
    render(<JsonView value={[{ ...row, meta: { a: 1 } }, row]} />);
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'k0',
      'k1',
      'k2',
      'k3',
      'k4',
      'k5',
      'k6',
      'k7',
      '+3 more',
    ]);
    expect(screen.getByRole('button', { name: 'Row 1, the rest: 3 keys' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Row 2, the rest: 2 keys' })).toHaveAttribute('aria-expanded', 'false');
  });

  test('a long array shows its first page, then the rest on asking', async () => {
    render(<JsonView value={{ ids: Array.from({ length: 45 }, (_, i) => `id-${i}`) }} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(20);
    await userEvent.click(screen.getByRole('button', { name: 'Show 25 more' }));
    expect(screen.getAllByRole('listitem')).toHaveLength(45);
    expect(screen.queryByRole('button', { name: /^Show \d+ more$/ })).toBeNull();
  });
});

describe('raw and copy', () => {
  test('Raw swaps the layout for the pretty-printed text, and back', async () => {
    const { container } = render(<JsonView value={{ a: 1, b: [true] }} />);
    const raw = screen.getByRole('button', { name: 'Raw' });
    expect(raw).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(raw);
    expect(raw).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByLabelText('Raw JSON').textContent).toBe('{\n  "a": 1,\n  "b": [\n    true\n  ]\n}');
    expect(container.querySelector('.json-fields')).toBeNull();
    await userEvent.click(raw);
    expect(screen.queryByLabelText('Raw JSON')).toBeNull();
    expect(container.querySelector('.json-fields')).not.toBeNull();
  });

  test('Copy writes the pretty-printed text and says so; a refused clipboard is said too', async () => {
    const writeText = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('denied'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<JsonView value={{ a: 1 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith('{\n  "a": 1\n}');
    expect(screen.getByRole('status')).toHaveTextContent('Copied the JSON.');
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }));
    expect(await screen.findByRole('button', { name: 'Copy refused' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('The browser refused clipboard access, so nothing was copied.');
  });
});
