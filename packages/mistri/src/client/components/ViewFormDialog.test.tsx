/**
 * The dialog a headline's `open: 'modal'` opens: a public form for a view the App does not own, the App's own
 * signed-in form drawn as its room draws it, and, for a view that is no form, its room.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';

const bridge = vi.hoisted(() => ({
  app: null as unknown,
  form: undefined as unknown,
  go: vi.fn(),
}));
vi.mock('@mistriwork/kit/client/uiBridge.js', () => ({ pageBridge: { activeApp: () => bridge.app } }));
vi.mock('@mistriwork/kit/client/core.js', () => ({ go: bridge.go, pageView: (id: string) => ({ page: id }) }));
vi.mock('@mistriwork/kit/client/components/appRooms.js', () => ({
  formPageId: (view: string) => `form-${view}`,
  formAt: () => bridge.form,
}));
vi.mock('./FormDialog.js', () => ({ FormDialog: ({ view }: { view: string }) => <div role="dialog">public {view}</div> }));
vi.mock('./SignedInFormDialog.js', () => ({
  SignedInFormDialog: ({ form }: { form: { label: string } }) => <div role="dialog">signed-in {form.label}</div>,
}));

const { ViewFormDialog } = await import('./ViewFormDialog.js');

beforeEach(() => {
  bridge.go.mockReset();
  bridge.form = undefined;
});
afterEach(cleanup);

test('a view the App does not own is a public form', async () => {
  bridge.app = { id: 'lintel', name: 'Lintel', views: { report: { command: 'x' } } };
  render(<ViewFormDialog view="apply" prefill="" onClose={() => {}} />);
  expect(await screen.findByRole('dialog')).toHaveTextContent('public apply');
});

test('an own form view is drawn as its signed-in room draws it', async () => {
  bridge.app = { id: 'lintel', name: 'Lintel', views: { report: { command: 'x' } } };
  bridge.form = { label: 'Report a problem' };
  render(<ViewFormDialog view="report" prefill="unit=3" onClose={() => {}} />);
  expect(await screen.findByRole('dialog')).toHaveTextContent('signed-in Report a problem');
  expect(bridge.go).not.toHaveBeenCalled();
});

test('an own view that is no form closes the dialog and goes to its room', async () => {
  bridge.app = { id: 'lintel', name: 'Lintel', views: { units: {} } };
  const onClose = vi.fn();
  render(<ViewFormDialog view="units" prefill="" onClose={onClose} />);
  await waitFor(() => expect(bridge.go).toHaveBeenCalledTimes(1));
  expect(onClose).toHaveBeenCalled();
  expect(screen.queryByRole('dialog')).toBeNull();
});
