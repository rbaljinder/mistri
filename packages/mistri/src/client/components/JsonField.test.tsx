/**
 * A JSON document is never offered to a text box. The box would show
 * `[object Object]`, and anything typed over it would be staged as the
 * value — so a document is laid out read-only, in the explorer and in an
 * App, while a JSON column holding nothing yet keeps its editor.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { ColumnMeta, TableMeta } from '../../../../engine/src/shared/schema.js';
import { columnKind } from '../../../../engine/src/shared/schema.js';

const model = vi.hoisted(() => ({ app: false }));
vi.mock('../appState.js', () => ({ appSaveMode: () => 'explicit' }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../../../../kit/src/client/core.js', () => ({
  $: () => ({ addEventListener() {}, setAttribute() {}, textContent: '', title: '' }),
  state: { activeConnection: 'demo', canWrite: true, connections: [{ id: 'demo', writable: true }] },
  api: async () => ({}),
  el: (tag: string) => document.createElement(tag),
  loadJson: () => ({}),
  saveJson: () => {},
  prefersPages: () => model.app,
  captureNavigation: () => () => true,
  setRecordMutationPendingProbe: () => {},
  render: () => {},
  toast: () => {},
  writeAllowed: () => true,
  formatLocale: () => 'en-US',
  columnKind,
  columnLabel: () => null,
  refsFrom: () => [],
  findTable: () => undefined,
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
vi.mock('../../../../tablewalk/src/client/undo.js', () => ({ refreshUndo: () => {}, undoLast: async () => {} }));

const { Editable } = await import('../../../../kit/src/client/components/Editable.js');
const { activateDraft, discardStaged } = await import('../../../../kit/src/client/write.js');

const col = (name: string, type: string, extra = {}) => ({ name, type, nullable: true, primaryKey: false, ...extra }) as ColumnMeta;
const event: TableMeta = {
  id: 'event',
  name: 'event',
  schema: '',
  isView: false,
  indexed: ['id'],
  columns: [
    col('id', 'integer', { primaryKey: true, nullable: false }),
    col('payload', 'jsonb'),
    col('body', 'JSON'),
  ] as TableMeta['columns'],
};
const key = { id: 1 };

beforeEach(() => {
  model.app = false;
  act(() => {
    activateDraft(event, key);
    discardStaged();
  });
});
afterEach(() => cleanup());

describe('a JSON field on a writable record', () => {
  test.each([false, true])('a parsed document is laid out read-only, never put in a box (app mode %s)', async (app) => {
    model.app = app;
    const display = vi.fn(() => <span>formatted</span>);
    render(
      <Editable
        app={app}
        table={event}
        row={{ id: 1, payload: { kind: 'signup', tags: ['new'] } }}
        column={event.columns[1]}
        recordKey={key}
        display={app ? display : undefined}
      />,
    );
    expect(await screen.findByText('signup')).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(document.body.textContent).not.toContain('[object Object]');
    expect(display).not.toHaveBeenCalled();
  });

  test('JSON text in a column declared JSON is laid out the same way', async () => {
    render(<Editable table={event} row={{ id: 1, body: '{"total": 12.5}' }} column={event.columns[2]} recordKey={key} />);
    expect(await screen.findByText('12.5')).toHaveClass('json-number');
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  test('a JSON column holding nothing yet keeps its editor', () => {
    render(<Editable table={event} row={{ id: 1, payload: null }} column={event.columns[1]} recordKey={key} />);
    expect(screen.getByRole('textbox')).toHaveValue('');
  });
});
