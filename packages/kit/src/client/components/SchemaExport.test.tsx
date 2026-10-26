/** The schema export menu: the scope said once, five formats, the picture taken at click time. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const toasts: Array<[string, string?]> = [];
const exported: unknown[] = [];
let fail = false;
const schema = { tables: ['a', 'b', 'c'].map((id) => ({ id, name: id, schema: 'main', columns: [], isView: false })), foreignKeys: [] };
vi.mock('../core.js', () => ({
  toast: (m: string, tone?: string) => toasts.push([m, tone]),
  viewportBox: (n: Element) => n.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../schemaexport.js', () => ({
  exportSchema: async (kind: string, opts: unknown) => {
    if (fail) throw new Error('There is no diagram to export.');
    exported.push([kind, opts]);
  },
}));
const { SchemaExportControl } = await import('./SchemaExport.js');

afterEach(() => {
  cleanup();
  toasts.length = 0;
  exported.length = 0;
  fail = false;
});

test('says what will be exported, and a format click writes it and closes the menu', async () => {
  const user = userEvent.setup();
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  render(<SchemaExportControl schema={schema} only={new Set(['a', 'b'])} picture={() => ({ svg, size: { width: 10, height: 5 } })} />);
  const trigger = screen.getByRole('button', { name: 'Export' });
  await user.click(trigger);
  expect(document.querySelector('.export-scope')).toHaveTextContent('2 tables — what the diagram is showing');
  await user.click(screen.getByRole('menuitem', { name: /Mermaid/ }));
  await vi.waitFor(() => expect(exported).toHaveLength(1));
  expect(exported[0]).toEqual(['mermaid', { schema, only: new Set(['a', 'b']), svg, size: { width: 10, height: 5 } }]);
  expect(toasts).toEqual([['Exported 2 tables as MERMAID.', undefined]]);
  await vi.waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'));
});

test('a failure is said in the writer’s words, and the whole schema is the default scope', async () => {
  const user = userEvent.setup();
  fail = true;
  render(<SchemaExportControl schema={schema} />);
  await user.click(screen.getByRole('button', { name: 'Export' }));
  expect(document.querySelector('.export-scope')).toHaveTextContent('all 3 tables');
  await user.click(screen.getByRole('menuitem', { name: /PNG/ }));
  await vi.waitFor(() => expect(toasts).toEqual([['There is no diagram to export.', 'error']]));
});
