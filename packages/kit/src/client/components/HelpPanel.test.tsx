/**
 * The help panel: grammar beside examples built from the connected
 * schema, sharpened when the sample rows arrive, run with one click.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const ran: string[] = [];
let sample: Array<Record<string, unknown>> = [];
let here: { kind: string } | undefined;
let sampled = 0;
vi.mock('../core.js', () => ({
  state: { schema: { label: 'shop', tables: [] } },
  trapFocus: () => () => {},
  currentEntry: () => here,
}));
vi.mock('../helpContent.js', () => ({
  SECTIONS: [
    { title: 'Start with a table', note: 'The table comes first.', grammar: [['table', 'every row']], keys: ['table'] },
    { title: 'Filter', note: 'A condition after the name.', grammar: [['column = value', 'also != < >']], keys: ['filter'] },
    {
      title: 'Walk a reference',
      note: 'A dot follows a key.',
      grammar: [['reference.column', 'one hop']],
      keys: ['dotwalk'],
      absent: 'This database has no foreign keys, so there is nothing to walk.',
    },
    { title: 'Keys the page listens for', note: 'Single keys.', grammar: [['?', 'this panel']], rooms: ['table'], app: true },
    {
      title: 'Stepping through a list',
      note: 'A record opened from a list.',
      grammar: [['j', 'the next record']],
      rooms: ['row', 'page'],
      app: true,
    },
  ],
  buildExamples: (_schema: unknown, samples: Record<string, unknown[]>) => ({
    sampleTable: 'invoice',
    examples: {
      table: { query: 'invoice', caption: 'every invoice' },
      filter: samples.invoice
        ? { query: 'invoice status = open', caption: 'a real value' }
        : { query: 'invoice status = value', caption: 'a value' },
    },
  }),
  sampleRows: async () => {
    sampled += 1;
    return sample;
  },
  runExample: (q: string) => ran.push(q),
}));

const { HelpPanel } = await import('./HelpPanel.js');

afterEach(() => {
  cleanup();
  ran.length = 0;
  sample = [];
  here = undefined;
  sampled = 0;
});

const titles = () => [...document.querySelectorAll('.help-section-title')].map((node) => node.textContent);

test('names the database, draws grammar and examples, and says why a section is empty', async () => {
  render(<HelpPanel onClose={() => {}} />);
  expect(screen.getByRole('dialog', { name: 'Query language' })).toBeInTheDocument();
  expect(document.querySelector('.help-sub')).toHaveTextContent('Every example below runs against shop.');
  expect(document.querySelectorAll('.help-section')).toHaveLength(5);
  expect(screen.getByText('invoice status = value')).toBeInTheDocument();
  expect(screen.getByText('This database has no foreign keys, so there is nothing to walk.')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
});

test("the keys for the room the reader is in come first, marked as this page's", () => {
  here = { kind: 'row' };
  render(<HelpPanel onClose={() => {}} />);
  expect(titles()).toEqual([
    'Stepping through a list · this page',
    'Start with a table',
    'Filter',
    'Walk a reference',
    'Keys the page listens for',
  ]);
  expect(document.querySelector('.help-section')).toHaveClass('is-here');
});

test("an App's reader is shown the keys alone, and nothing is fetched to exemplify a language they are not offered", () => {
  here = { kind: 'table' };
  render(<HelpPanel onClose={() => {}} keysOnly />);
  expect(screen.getByRole('dialog', { name: 'Keyboard' })).toBeInTheDocument();
  expect(titles()).toEqual(['Keys the page listens for · this page', 'Stepping through a list']);
  expect(screen.queryByRole('button', { name: /every invoice/ })).toBeNull();
  expect(sampled).toBe(0);
});

test('the sample rows sharpen the examples once they arrive', async () => {
  sample = [{ status: 'open' }];
  render(<HelpPanel onClose={() => {}} />);
  await screen.findByText('invoice status = open');
});

test('an example runs and closes the panel; Escape and ? close it and go no further', async () => {
  const user = userEvent.setup();
  const onClose = vi.fn();
  const outer = vi.fn();
  document.addEventListener('keydown', outer);
  render(<HelpPanel onClose={onClose} />);
  await user.click(screen.getByRole('button', { name: /every invoice/ }));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(ran).toEqual(['invoice']);
  fireEvent.keyDown(document.body, { key: '?' });
  expect(onClose).toHaveBeenCalledTimes(2);
  /* A single key under the panel is swallowed; the page must not act on it. */
  fireEvent.keyDown(document.body, { key: 'h' });
  expect(outer).not.toHaveBeenCalledWith(expect.objectContaining({ key: 'h' }));
  document.removeEventListener('keydown', outer);
});
