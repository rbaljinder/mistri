/**
 * The header's New menu, drawn and driven: one "+ New" button, its lines in
 * the App's order with their marks, a click handing the line to the shell,
 * and no button at all for a reader with nothing to make. Which lines a
 * reader is offered is appNewMenu's (test/app-shell-new.test.ts).
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { NewMenu } from './NewMenu.js';

afterEach(cleanup);

describe('NewMenu', () => {
  test('lists every way to make something and opens the one picked', async () => {
    const onOpen = vi.fn();
    const entries = [
      { view: 'tickets', label: 'Ticket', table: 'ticket' },
      { view: 'raise-change', label: 'Change', icon: 'arrows-left-right' as const },
    ];
    render(<NewMenu entries={entries} onOpen={onOpen} />);
    const trigger = screen.getByRole('button', { name: 'New' });
    expect(trigger).toHaveTextContent('+ New');
    await userEvent.click(trigger);
    const lines = await screen.findAllByRole('menuitem');
    expect(lines.map((line) => line.textContent)).toEqual(['Ticket', 'Change']);
    expect(lines[1].querySelector('.tw-icon')).not.toBeNull();
    // Icons on all lines or none: the line without a mark keeps its empty slot, so the labels line up.
    expect(lines[0].firstElementChild).toHaveClass('new-menu-slot');
    await userEvent.click(screen.getByRole('menuitem', { name: 'Change' }));
    expect(onOpen).toHaveBeenCalledWith(entries[1]);
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  test('a long menu reads by its groups: each a labelled group, the arrows walking straight through them', async () => {
    const onOpen = vi.fn();
    const entries = [
      { view: 'note', label: 'Note' },
      { view: 'tickets', label: 'Ticket', table: 'ticket', group: 'Service desk' },
      { view: 'problems', label: 'Problem', table: 'problem', group: 'Service desk' },
      { view: 'leads', label: 'Lead', table: 'lead', group: 'Sales' },
    ];
    render(<NewMenu entries={entries} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: 'New' }));
    const desk = await screen.findByRole('group', { name: 'Service desk' });
    expect(Array.from(desk.querySelectorAll('[role="menuitem"]'), (line) => line.textContent)).toEqual(['Ticket', 'Problem']);
    const sales = screen.getByRole('group', { name: 'Sales' });
    expect(sales).toHaveTextContent('Lead');
    // The line written outside every group stands first, with no heading; a rule parts each run from the next.
    expect(screen.getAllByRole('menuitem').map((line) => line.textContent)).toEqual(['Note', 'Ticket', 'Problem', 'Lead']);
    expect(screen.getAllByRole('separator')).toHaveLength(2);
    // The headings are labels, not lines: the arrows pass from the last of one group to the first of the next.
    const note = screen.getByRole('menuitem', { name: 'Note' });
    note.focus();
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(screen.getByRole('menuitem', { name: 'Lead' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith(entries[3]);
  });

  test('draws nothing for a reader with nothing to make', () => {
    const { container } = render(<NewMenu entries={[]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
