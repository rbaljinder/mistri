/**
 * The board's three spellings of every move — a drag, Alt and an arrow key,
 * and the card's ⋯ menu — each delegating the same callback, with the focus
 * and the spoken sentence the host hands back.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriageBoard, type TriageCard } from './TriageBoard.js';
import { dragOnto, pressToDrag } from '../../../../kit/src/client/components/dragTesting.js';

const lanes = [
  { id: 'new', label: 'New' },
  { id: 'triage', label: 'Triage' },
  { id: 'done', label: 'Done' },
];
const cards: TriageCard[] = [
  { id: 'a', laneId: 'new', title: 'First' },
  { id: 'b', laneId: 'new', title: 'Second' },
  { id: 'c', laneId: 'new', title: 'Third' },
  { id: 'd', laneId: 'triage', title: 'Elsewhere' },
];
const card = (name: string) => screen.getByRole('button', { name });
/** The names in a card's ⋯ menu, read and closed again. */
async function items(title: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  const names = (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
  await userEvent.keyboard('{Escape}');
  return names;
}

describe('TriageBoard moves', () => {
  afterEach(cleanup);

  it('Alt and left or right moves a card to the nearest lane it may enter; a plain arrow only moves the focus', async () => {
    const onMove = vi.fn();
    render(<TriageBoard lanes={lanes} cards={[{ ...cards[0], targets: ['done'] }, cards[3]]} onMove={onMove} />);
    card('First').focus();
    await userEvent.keyboard('{Alt>}{ArrowRight}{/Alt}');
    // Triage is not a lane this card may enter, so the step goes over it, as the menu leaves it out.
    expect(onMove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }), { lane: 'done' });
    await userEvent.keyboard('{ArrowRight}');
    expect(onMove).toHaveBeenCalledOnce();
    expect(card('Elsewhere')).toHaveFocus();
    expect(card('First')).toHaveAttribute('aria-keyshortcuts', 'Alt+ArrowLeft Alt+ArrowRight');
  });

  it("Alt and up or down asks for the card's new place in its lane; the ends ask nothing", async () => {
    const onReorder = vi.fn();
    render(<TriageBoard lanes={lanes} cards={cards} onReorder={onReorder} />);
    card('Second').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await userEvent.keyboard('{Alt>}{ArrowDown}{/Alt}');
    expect(onReorder.mock.calls.map(([moved, index]) => [moved.id, index])).toEqual([
      ['b', 0],
      ['b', 2],
    ]);
    card('First').focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    expect(onReorder).toHaveBeenCalledTimes(2);
    // A lane of one has no order to change: no menu, no shortcut.
    expect(screen.queryByRole('button', { name: 'Actions for Elsewhere' })).toBeNull();
    expect(card('Elsewhere')).not.toHaveAttribute('aria-keyshortcuts');
  });

  it("the card menu's Order names each place the card can take", async () => {
    const onReorder = vi.fn();
    render(<TriageBoard lanes={lanes} cards={cards} onReorder={onReorder} />);
    expect(await items('First')).toEqual(['Move down', 'Move to bottom']);
    expect(await items('Second')).toEqual(['Move up', 'Move down', 'Move to top', 'Move to bottom']);
    expect(await items('Third')).toEqual(['Move up', 'Move to top']);
    await userEvent.click(screen.getByRole('button', { name: 'Actions for Third' }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Move to top' }));
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c' }), 0);
  });

  it('a drop before a card is a new place; a drop in another lane is a move; a lane it may not enter takes nothing', () => {
    const onMove = vi.fn();
    const onReorder = vi.fn();
    render(
      <TriageBoard lanes={lanes} cards={[...cards.slice(0, 3), { ...cards[3], targets: ['new'] }]} onMove={onMove} onReorder={onReorder} />,
    );
    const wrap = (name: string) => card(name).closest('article')!;
    const reorder = pressToDrag(card('Third'));
    reorder.over(wrap('First'));
    // The place is the gap the drag opens (usePointerDrag.test.tsx); its own lane is not marked as a lane to enter.
    expect(wrap('First').closest('section')).not.toHaveClass('is-over');
    reorder.drop();
    expect(onReorder).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'c' }), 0);

    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!;
    const move = pressToDrag(card('First'));
    move.over(done);
    expect(done).toHaveClass('is-over');
    move.drop();
    // An empty lane has no place to name: the card keeps its number.
    expect(onMove).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'a' }), { lane: 'done' });

    // Elsewhere may only go to New: dropping it on Done does nothing.
    const refused = pressToDrag(card('Elsewhere'));
    refused.over(done);
    expect(done).not.toHaveClass('is-over');
    refused.drop();
    expect(onMove).toHaveBeenCalledOnce();
  });

  it('where lanes keep an order, a card dropped in another lane lands where it was let go', () => {
    const onMove = vi.fn();
    render(<TriageBoard lanes={lanes} cards={cards} onMove={onMove} onReorder={vi.fn()} />);
    const triage = screen.getByRole('heading', { name: 'Triage' }).closest('section')!;
    // Before a card: that card's place.
    dragOnto(card('Second'), card('Elsewhere').closest('article')!);
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'b' }), { lane: 'triage', index: 0 });
    // Anywhere else in a lane with cards: last.
    dragOnto(card('Third'), triage);
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c' }), { lane: 'triage', index: 1 });
    // Without an order, a move never names a place.
    cleanup();
    render(<TriageBoard lanes={lanes} cards={cards} onMove={onMove} />);
    dragOnto(card('First'), card('Elsewhere').closest('article')!);
    expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }), { lane: 'triage' });
  });

  it('a card let go over a lane it may not enter says so; a board with no order opens no gap and draws no rule', () => {
    const onMove = vi.fn();
    const onRefuse = vi.fn();
    render(
      <TriageBoard lanes={lanes} cards={[{ ...cards[3], targets: ['new'] }, ...cards.slice(0, 3)]} onMove={onMove} onRefuse={onRefuse} />,
    );
    const done = screen.getByRole('heading', { name: 'Done' }).closest('section')!;
    dragOnto(card('Elsewhere'), done);
    expect(onMove).not.toHaveBeenCalled();
    expect(onRefuse).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ id: 'd' }),
      'Elsewhere can’t move to Done from where it is.',
    );
    // Unordered: over a card in its own lane, nothing slides and nothing is marked.
    const drag = pressToDrag(card('Third'));
    drag.over(card('First').closest('article')!);
    expect(card('First').closest('article')!.style.translate).toBe('');
    expect(document.querySelector('[data-drop]')).toBeNull();
    drag.cancel();
  });

  it('a lifted card follows the pointer as a copy; Escape puts it back, and a drop is not a click', async () => {
    const onReorder = vi.fn();
    const onSelect = vi.fn();
    render(<TriageBoard lanes={lanes} cards={cards} onReorder={onReorder} onSelect={onSelect} />);
    const first = card('First').closest('article')!;
    // The box is what is lifted (it carries the drag source); the button inside opens the card.
    const third = card('Third').closest('.triage-card')!;
    const drag = pressToDrag(card('Third'));
    drag.over(first);
    expect(third).toHaveAttribute('data-lifted');
    const ghost = document.querySelector<HTMLElement>('.drag-ghost')!;
    expect(ghost).toHaveAttribute('aria-hidden', 'true');
    expect(ghost.style.transform).toMatch(/^translate\(/);
    // The copy is not a second card: no id, no drop name, nothing found twice.
    expect(ghost.querySelector('[data-drop-item]')).toBeNull();
    drag.cancel();
    expect(document.querySelector('.drag-ghost')).toBeNull();
    expect(third).not.toHaveAttribute('data-lifted');
    expect(onReorder).not.toHaveBeenCalled();
    // Let go over a card, the press ends in a click there; that click is the drop's, not a selection.
    dragOnto(card('Third'), first);
    fireEvent.click(card('Third'));
    expect(onReorder).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(card('Third'));
    expect(onSelect).toHaveBeenCalledOnce();
  });

  it("says the host's sentence politely and puts the focus on the card it names", () => {
    const { rerender, container } = render(<TriageBoard lanes={lanes} cards={cards} />);
    const region = container.querySelector('[aria-live="polite"]')!;
    expect(region).toBeEmptyDOMElement();
    rerender(<TriageBoard lanes={lanes} cards={cards} announcement="Moved “Third” to place 1 of 3 in new" focus={{ id: 'c', seq: 1 }} />);
    expect(region).toHaveTextContent('Moved “Third” to place 1 of 3 in new');
    expect(card('Third')).toHaveFocus();
    // Empty lanes still say so as a status; the live region is not one of them.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  it('keeps the focus with a moved card that is drawn anew in its lane after the move is told', () => {
    // The host tells the move before its rows arrive: the card is focused where it was…
    const { rerender } = render(<TriageBoard lanes={lanes} cards={cards} focus={{ id: 'c', seq: 1 }} />);
    expect(card('Third')).toHaveFocus();
    // …then drawn in its new lane, a new button, and the focus goes with it rather than to the page.
    const moved = cards.map((each) => (each.id === 'c' ? { ...each, laneId: 'done' } : each));
    rerender(<TriageBoard lanes={lanes} cards={moved} focus={{ id: 'c', seq: 1 }} />);
    expect(card('Third')).toHaveFocus();
    expect(card('Third').closest('section')).toHaveAccessibleName(/^Done/);
    // Once placed, a later redraw leaves the focus wherever the reader has put it.
    card('First').focus();
    rerender(<TriageBoard lanes={lanes} cards={[...moved]} focus={{ id: 'c', seq: 1 }} />);
    expect(card('First')).toHaveFocus();
  });
});
