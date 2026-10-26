import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollectionSelection, type CollectionSelectionItem } from './CollectionSelection.js';

const items: CollectionSelectionItem[] = [
  { key: '001', label: 'First' },
  { key: 'opaque-2', label: 'Second' },
  { key: '9007199254740993', label: 'Third' },
  { key: 'disabled', label: 'Unavailable', disabled: true },
];

describe('CollectionSelection', () => {
  afterEach(cleanup);

  it('returns exact opaque keys and exposes selected rows accessibly', async () => {
    const onSelectionChange = vi.fn();
    render(<CollectionSelection items={items} selectedKeys={['9007199254740993']} onSelectionChange={onSelectionChange} />);
    expect(screen.getByRole('row', { name: 'Third' })).toHaveAttribute('aria-selected', 'true');
    await userEvent.click(screen.getByRole('row', { name: 'First' }));
    expect(onSelectionChange).toHaveBeenCalledWith(['001'], { reason: 'replace', anchorKey: '001' });
  });

  it('moves the focused row and skips disabled items', async () => {
    const onFocusChange = vi.fn();
    render(<CollectionSelection items={items} onFocusChange={onFocusChange} />);
    const first = screen.getByRole('row', { name: 'First' });
    first.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('row', { name: 'Second' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('row', { name: 'Third' })).toHaveFocus();
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('row', { name: 'Third' })).toHaveFocus();
    expect(onFocusChange).toHaveBeenLastCalledWith('9007199254740993');
  });

  it('selects an inclusive range from the last anchor with Shift-click', async () => {
    const onSelectionChange = vi.fn();
    render(<CollectionSelection items={items} onSelectionChange={onSelectionChange} />);
    await userEvent.click(screen.getByRole('row', { name: 'First' }));
    fireEvent.click(screen.getByRole('row', { name: 'Third' }), { shiftKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['001', 'opaque-2', '9007199254740993'], { reason: 'range', anchorKey: '001' });
  });

  it('supports keyboard range extension and exact modifier toggles', async () => {
    const onSelectionChange = vi.fn();
    const view = render(<CollectionSelection items={items} onSelectionChange={onSelectionChange} />);
    const first = screen.getByRole('row', { name: 'First' });
    first.focus();
    await userEvent.keyboard(' ');
    view.rerender(<CollectionSelection items={items} selectedKeys={['001']} onSelectionChange={onSelectionChange} />);
    screen.getByRole('row', { name: 'First' }).focus();
    await userEvent.keyboard('{Shift>}{ArrowDown}{/Shift}');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['001', 'opaque-2'], { reason: 'range', anchorKey: '001' });
    view.rerender(<CollectionSelection items={items} selectedKeys={['001', 'opaque-2']} onSelectionChange={onSelectionChange} />);
    fireEvent.click(screen.getByRole('row', { name: 'Second' }), { ctrlKey: true });
    expect(onSelectionChange).toHaveBeenLastCalledWith(['001'], { reason: 'toggle', anchorKey: 'opaque-2' });
  });

  it('clears with Escape and can select only the visible collection with Mod+A', async () => {
    const onSelectionChange = vi.fn();
    const onClearSelection = vi.fn();
    render(
      <CollectionSelection
        items={items}
        selectedKeys={['001', 'external-key']}
        onSelectionChange={onSelectionChange}
        onClearSelection={onClearSelection}
      />,
    );
    const first = screen.getByRole('row', { name: 'First' });
    first.focus();
    await userEvent.keyboard('{Control>}a{/Control}');
    expect(onSelectionChange).toHaveBeenLastCalledWith(['001', 'opaque-2', '9007199254740993'], { reason: 'select-all', anchorKey: '001' });
    await userEvent.keyboard('{Escape}');
    expect(onSelectionChange).toHaveBeenLastCalledWith([], { reason: 'clear', anchorKey: null });
    expect(onClearSelection).toHaveBeenCalledOnce();
  });
});
