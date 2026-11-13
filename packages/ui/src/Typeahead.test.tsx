import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { createRef, useState, type Ref } from 'react';

vi.mock('./internal/ruler.js', () => ({
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  viewportSize: () => ({ width: 1000, height: 800 }),
}));
const { Typeahead } = await import('./Typeahead.js');
const { checkPatterns } = await import('./conformancePatterns.js');
afterEach(cleanup);

function Harness({
  popupRef,
  pick = () => {},
  textChange = () => {},
  parentEscape = () => {},
  fit,
}: {
  fit?: 'width' | 'min-width';
  popupRef?: Ref<HTMLDivElement>;
  pick?: (value: string) => void;
  textChange?: (value: string) => void;
  parentEscape?: () => void;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <div
      data-testid="surface"
      onKeyDown={(event) => {
        if (event.key === 'Escape') parentEscape();
      }}
    >
      <Typeahead
        text={text}
        onText={(value) => {
          textChange(value);
          setText(value);
        }}
        items={['Alpha', 'Beta']}
        itemKey={(item) => item}
        itemLabel={(item) => item}
        itemClassName={(_, highlighted) => (highlighted ? 'highlighted' : '')}
        renderItem={(item) => item}
        onPick={(value) => {
          pick(value);
          setText(value);
          setOpen(false);
        }}
        open={open}
        onOpenChange={setOpen}
        inputProps={{ 'aria-label': 'Search' }}
        fit={fit}
        popupRef={popupRef}
        popupClassName="test-popup"
        listClassName="test-list"
      />
      <button type="button">Outside</button>
    </div>
  );
}

test('object popupRef points to the actual portalled popup and clears on close', async () => {
  const popupRef = createRef<HTMLDivElement>();
  render(<Harness popupRef={popupRef} />);
  const user = userEvent.setup();
  expect(popupRef.current).toBeNull();
  await user.click(screen.getByRole('combobox'));
  const list = await screen.findByRole('listbox');
  expect(popupRef.current).toBe(list.closest('.test-popup'));
  expect(popupRef.current).toBeInstanceOf(HTMLDivElement);
  expect(popupRef.current).toContainElement(screen.getByRole('option', { name: 'Alpha' }));
  expect(screen.getByTestId('surface')).not.toContainElement(popupRef.current);
  await user.click(screen.getByText('Outside'));
  await waitFor(() => expect(popupRef.current).toBeNull());
});

test.each(['width', 'min-width'] as const)('%s sizing keeps fixed-fit geometry on the positioner only', async (fit) => {
  render(<Harness fit={fit} />);
  await userEvent.setup().click(screen.getByRole('combobox'));
  const popup = (await screen.findByRole('listbox')).closest('.test-popup') as HTMLElement;
  const positioner = popup.parentElement!;
  if (fit === 'width') {
    expect(positioner.style.width).toBe('var(--anchor-width)');
    expect(positioner.style.maxWidth).toBe('var(--available-width)');
    expect(popup.style.width).toBe('100%');
    expect(popup.style.minWidth).toBe('');
  } else {
    expect(positioner.style.width).toBe('');
    expect(positioner.style.maxWidth).toBe('');
    expect(popup.style.minWidth).toBe('var(--anchor-width)');
    expect(popup.style.maxWidth).toBe('var(--available-width)');
  }
  expect(positioner.style.position).toBe('fixed');
});

test('callback popupRef follows the popup inside an enclosing dialog and clears on unmount', async () => {
  const popupRef = vi.fn();
  const view = render(
    <div role="dialog">
      <Harness popupRef={popupRef} />
    </div>,
  );
  const user = userEvent.setup();
  await user.click(screen.getByRole('combobox'));
  const popup = (await screen.findByRole('listbox')).closest('.test-popup');
  expect(popupRef).toHaveBeenLastCalledWith(popup);
  expect(screen.getByRole('dialog')).toContainElement(popup as HTMLElement);
  view.unmount();
  expect(popupRef).toHaveBeenLastCalledWith(null);
});

test.each(['pointer', 'keyboard'] as const)('%s selection reports one pick and does not turn the label into search', async (method) => {
  const pick = vi.fn();
  const textChange = vi.fn();
  render(<Harness pick={pick} textChange={textChange} />);
  const user = userEvent.setup();
  const input = screen.getByRole('combobox');
  await user.type(input, 'a');
  await screen.findByRole('option', { name: 'Alpha' });
  textChange.mockClear();
  if (method === 'pointer') await user.click(screen.getByRole('option', { name: 'Alpha' }));
  else await user.keyboard('{ArrowDown}{Enter}');
  expect(pick).toHaveBeenCalledTimes(1);
  expect(input).toHaveValue(pick.mock.calls[0][0]);
  expect(textChange).not.toHaveBeenCalled();
});

test('Escape closes the open typeahead without escaping to its parent', async () => {
  const parentEscape = vi.fn();
  const pick = vi.fn();
  render(<Harness parentEscape={parentEscape} pick={pick} />);
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox'), 'a');
  await screen.findByRole('listbox');
  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
  expect(parentEscape).not.toHaveBeenCalled();
  expect(pick).not.toHaveBeenCalled();
});

function Labelled({ inputProps, empty }: { inputProps: Record<string, string>; empty?: string }) {
  const [text, setText] = useState('');
  return (
    <>
      <label htmlFor="tree-box">Tree species</label>
      <Typeahead
        text={text}
        onText={setText}
        items={['Alder', 'Birch'].filter((item) => item.toLowerCase().startsWith(text.toLowerCase()))}
        itemKey={(item) => item}
        itemLabel={(item) => item}
        itemClassName={() => ''}
        renderItem={(item) => item}
        onPick={setText}
        open
        onOpenChange={() => {}}
        inputProps={{ id: 'tree-box', ...inputProps }}
        popupClassName="test-popup"
        listClassName="test-list"
        empty={empty}
      />
    </>
  );
}

test('a list is named by the label of a box that has no aria-label, as the box is, and passes the ARIA patterns', async () => {
  render(<Labelled inputProps={{}} />);
  const list = await screen.findByRole('listbox', { name: 'Tree species' });
  expect(list.getAttribute('aria-label')).toBe('Tree species');
  expect(await checkPatterns(document.body, { keys: false })).toEqual([]);
});

test("a box's own aria-label still names the list, ahead of its label", async () => {
  render(<Labelled inputProps={{ 'aria-label': 'Find a tree' }} />);
  expect(await screen.findByRole('listbox', { name: 'Find a tree' })).toBeTruthy();
});

test('an empty message sits beside the list, not inside a listbox, and nothing matched leaves no listbox', async () => {
  render(<Labelled inputProps={{ 'aria-label': 'Find a tree' }} empty="No tree by that name" />);
  await userEvent.setup().type(screen.getByRole('combobox'), 'zz');
  const status = await screen.findByText('No tree by that name');
  expect(status.closest('[role="listbox"]')).toBeNull();
  expect(screen.queryByRole('listbox')).toBeNull();
  expect(await checkPatterns(document.body, { keys: false })).toEqual([]);
});

test("with nothing matched, the empty message is drawn on the list's surface and Escape stays with the popup", async () => {
  const drawerEscape = vi.fn();
  render(
    <div onKeyDown={(e) => e.key === 'Escape' && drawerEscape()}>
      <Labelled inputProps={{ 'aria-label': 'Find a tree' }} empty="No tree by that name" />
    </div>,
  );
  const user = userEvent.setup();
  await user.type(screen.getByRole('combobox'), 'zz');
  const status = await screen.findByText('No tree by that name');
  expect(status.closest('.test-list')).not.toBeNull();
  await user.keyboard('{Escape}');
  expect(drawerEscape).not.toHaveBeenCalled();
});
