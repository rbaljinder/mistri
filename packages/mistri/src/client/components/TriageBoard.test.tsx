import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TriageBoard, type TriageCard } from './TriageBoard.js';
import { readFileSync } from 'node:fs';
import { pressToDrag } from '../../../../kit/src/client/components/dragTesting.js';

const lanes = [
  { id: 'new', label: 'New' },
  { id: 'triage', label: 'Triage' },
  { id: 'done', label: 'Done' },
];
const cards: TriageCard[] = [
  { id: 'a', laneId: 'new', title: 'Broken login', subtitle: 'Aster', meta: 'P1' },
  { id: 'b', laneId: 'triage', title: 'Slow export', subtitle: 'Compass' },
];
/** Open a card's ⋯ menu; its items' names, in order. */
async function menu(title: string) {
  await userEvent.click(screen.getByRole('button', { name: `Actions for ${title}` }));
  return (await screen.findAllByRole('menuitem')).map((item) => item.textContent);
}

describe('TriageBoard', () => {
  afterEach(cleanup);

  it('preserves authored lane order and renders explicit empty lanes', () => {
    render(<TriageBoard lanes={lanes} cards={cards} />);
    expect([...screen.getAllByRole('heading', { level: 2 })].map((node) => node.textContent)).toEqual(['New', 'Triage', 'Done']);
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('status')).toHaveTextContent('No items here.');
  });

  it('says once, above its lanes, that a board with no cards is empty', () => {
    render(<TriageBoard lanes={lanes} cards={[]} />);
    expect(screen.getByText('Nothing on this board yet.').closest('.empty-note')).toHaveClass('triage-board-empty');
    expect(screen.queryByText('No items here.')).toBeNull();
    expect(screen.getAllByRole('heading', { level: 2 })).toHaveLength(3);
  });

  it("says a lane's whole count and limit where the host knows more than its cards, and asks for more in place", async () => {
    const onMore = vi.fn();
    render(<TriageBoard lanes={[{ ...lanes[0], total: 900, limit: 5, more: { count: 20, onMore } }, lanes[1], lanes[2]]} cards={cards} />);
    // The limit is met by the lane's work, not the page drawn.
    expect(screen.getByLabelText('900 items, limit 5, over the limit')).toHaveTextContent('900 / 5');
    await userEvent.click(screen.getByRole('button', { name: 'Show 20 more' }));
    expect(onMore).toHaveBeenCalledOnce();
  });

  it("draws a lane's name and a card's line as the host dresses them, keeping their words for assistive technology", () => {
    render(
      <TriageBoard
        lanes={[{ ...lanes[0], mark: <span className="tone tone-warn">New</span> }, lanes[1], lanes[2]]}
        cards={[{ ...cards[0], line: <span className="tone tone-bad">Aster</span> }, cards[1]]}
      />,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'New' }).querySelector('.tone')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Broken login, Aster' }).querySelector('.tone-bad')).not.toBeNull();
  });

  it('names the lane in view and steps to the next, for a phone that shows one lane at a time', async () => {
    render(<TriageBoard lanes={lanes} cards={cards} />);
    const picker = screen.getByRole('group', { name: 'Lanes' });
    expect(picker).toHaveTextContent('New 1 of 3');
    expect(within(picker).getByRole('button', { name: 'Previous lane' })).toBeDisabled();
    await userEvent.click(within(picker).getByRole('button', { name: 'Next lane' }));
    expect(picker).toHaveTextContent('Triage 2 of 3');
  });

  it('selects a card without owning its detail or persistence', async () => {
    const onSelect = vi.fn();
    await userEvent.click(
      render(<TriageBoard lanes={lanes} cards={cards} onSelect={onSelect} />).getByRole('button', { name: 'Broken login, Aster' }),
    );
    expect(onSelect).toHaveBeenCalledWith(cards[0]);
  });

  it("offers only other lanes, in the card's one menu, and delegates the guarded move", async () => {
    const onMove = vi.fn();
    render(<TriageBoard lanes={lanes} cards={cards} onMove={onMove} />);
    // No select waits under the card: the moves are behind its ⋯.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(await menu('Broken login')).toEqual(['Triage', 'Done']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Triage' }));
    expect(onMove).toHaveBeenCalledWith(cards[0], { lane: 'triage' });
  });

  it('moves keyboard focus between cards without changing lanes', async () => {
    render(<TriageBoard lanes={lanes} cards={cards} />);
    const first = screen.getByRole('button', { name: 'Broken login, Aster' });
    first.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('button', { name: 'Slow export, Compass' })).toHaveFocus();
  });

  it('draws no menu for a card whose host offers nothing', () => {
    render(<TriageBoard lanes={lanes} cards={[{ ...cards[0], targets: [] }]} onMove={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /^Actions for/ })).toBeNull();
  });

  it('lists only the lanes the host offers', async () => {
    render(<TriageBoard lanes={lanes} cards={[{ ...cards[0], targets: ['done'] }]} onMove={vi.fn()} />);
    expect(await menu('Broken login')).toEqual(['Done']);
  });

  it('says a lane by its word with the stored value as its title; a limit is the count over it, warned past it', () => {
    render(
      <TriageBoard
        lanes={[
          { id: 'in_progress', label: 'In progress', title: 'in_progress', limit: 1 },
          { id: 'done', label: 'Done', limit: 3 },
        ]}
        cards={[
          { id: 'a', laneId: 'in_progress', title: 'A' },
          { id: 'b', laneId: 'in_progress', title: 'B' },
        ]}
      />,
    );
    const busy = screen.getByRole('heading', { level: 2, name: 'In progress' });
    expect(busy).toHaveAttribute('title', 'in_progress');
    const over = busy.closest('header')!.querySelector('.triage-lane-count')!;
    expect(over).toHaveTextContent('2 / 1');
    expect(over).toHaveClass('is-over');
    expect(over.getAttribute('aria-label')).toBe('2 items, limit 1, over the limit');
    const calm = screen.getByRole('heading', { level: 2, name: 'Done' }).closest('header')!.querySelector('.triage-lane-count')!;
    expect(calm).toHaveTextContent('0 / 3');
    expect(calm).not.toHaveClass('is-over');
  });

  it("a card's ⋯ stands beside the button that opens it, not inside or over it", () => {
    render(<TriageBoard lanes={lanes} cards={cards} onMove={vi.fn()} />);
    const open = screen.getByRole('button', { name: /^Broken login/ });
    const menu = screen.getByRole('button', { name: 'Actions for Broken login' });
    expect(open.contains(menu)).toBe(false);
    expect(open.parentElement).toHaveClass('triage-card', 'has-menu');
    // Outside the dragged box: a press on the ⋯ opens its menu and never lifts the card.
    expect(open.parentElement!.contains(menu)).toBe(false);
    expect(open.closest('.triage-card-wrap')).toBe(menu.closest('.triage-card-wrap'));
  });

  it("draws a card's category as a chip in its series color, and its footer facts with their marks, people last", () => {
    const footer = [
      { key: 'due', icon: 'calendar-blank', node: <span>Oct 9</span>, text: 'Due Oct 9' },
      { key: 'owner', node: <span className="avatar-stack">AL</span>, text: 'Ada Lovelace', person: true },
    ];
    render(<TriageBoard lanes={lanes} cards={[{ ...cards[0], category: { label: 'Bug', color: 3 }, footer }, cards[1]]} />);
    const card = screen.getByRole('button', { name: /Broken login/ });
    expect(card.querySelector('.triage-card-category')).toHaveTextContent('Bug');
    // The series color is the card's, the box the button stands in beside its ⋯.
    expect(card.closest('.triage-card')).toHaveClass('cat-c3');
    const facts = [...card.querySelectorAll('.triage-card-foot .triage-card-fact')];
    expect(facts).toHaveLength(2);
    expect(facts[0].querySelector('svg')).not.toBeNull();
    expect(facts[0]).not.toHaveClass('is-person');
    expect(facts[1]).toHaveClass('is-person');
    expect(facts[1].querySelector('.avatar-stack')).not.toBeNull();
    // The card's name carries its facts for assistive technology.
    expect(card.getAttribute('aria-label')).toContain('Ada Lovelace');
    // A card without them draws neither.
    const plain = screen.getByRole('button', { name: /Slow export/ });
    expect(plain.querySelector('.triage-card-category')).toBeNull();
    expect(plain.querySelector('.triage-card-foot')).toBeNull();
  });

  it("puts a + in the head of a lane the host offers New in, and in no other, and it calls the host's New", async () => {
    const onNew = vi.fn();
    const { container, rerender } = render(<TriageBoard lanes={[{ ...lanes[0], onNew }, lanes[1], lanes[2]]} cards={cards} />);
    const plus = container.querySelectorAll('.triage-lane-new');
    expect(plus).toHaveLength(1);
    expect(plus[0].closest('header')).toHaveTextContent('New');
    await userEvent.click(screen.getByRole('button', { name: /^New in New/ }));
    expect(onNew).toHaveBeenCalledOnce();
    rerender(<TriageBoard lanes={lanes} cards={cards} />);
    expect(container.querySelector('.triage-lane-new')).toBeNull();
  });

  describe('with swimlanes', () => {
    const rows = [
      { id: 'high', label: 'High' },
      { id: 'low', label: 'Low' },
    ];
    const laned: TriageCard[] = [
      { id: 'a', laneId: 'new', rowId: 'high', title: 'Alpha' },
      { id: 'b', laneId: 'done', rowId: 'high', title: 'Bravo' },
      { id: 'c', laneId: 'new', rowId: 'low', title: 'Charlie' },
    ];
    const reason = 'Priority is not yours to change here, so a card keeps its row.';

    it('heads the lanes once, draws a folding row per value, and counts each row', () => {
      render(<TriageBoard lanes={lanes} cards={laned} rows={rows} rowsLabel="Priority" />);
      expect(screen.getAllByRole('heading', { level: 2 }).map((node) => node.textContent)).toEqual(['New', 'Triage', 'Done']);
      expect(screen.getAllByRole('heading', { level: 3 }).map((node) => node.textContent)).toEqual(['High', 'Low']);
      const high = screen.getByRole('heading', { level: 3, name: 'High' }).closest('details')!;
      expect(high).toHaveAttribute('open');
      expect(high.querySelector('summary .triage-lane-count')).toHaveTextContent('2');
      // A cell is named by its lane and its row, and holds its own cards.
      const cell = within(high).getByRole('region', { name: 'New High' });
      expect(within(cell).getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
      /* A `.triage-cell-count` assertion stood here, asserting that a bare
         figure in the cell's corner is not drawn. Nothing has ever drawn that
         class, so it passed whatever the board did. What the design actually
         requires is the line below: the count belongs to the lane, over every
         row, not to the cell. */
      // The lane's count is over every row.
      expect(screen.getByRole('heading', { level: 2, name: 'New' }).closest('header')).toHaveTextContent('2');
    });

    it('draws an empty cell without a box of its own, marked only while a card is carried over it, and still a place to land', () => {
      const onMove = vi.fn();
      render(<TriageBoard lanes={lanes} cards={laned} rows={rows} rowsLabel="Priority" onMove={onMove} />);
      const empty = screen.getByRole('region', { name: 'Triage High' });
      expect(empty).toHaveClass('is-empty');
      expect(empty).not.toHaveClass('is-over');
      expect(screen.getByRole('region', { name: 'New High' })).not.toHaveClass('is-empty');
      const drag = pressToDrag(screen.getByRole('button', { name: 'Charlie' }));
      drag.over(empty);
      expect(empty).toHaveClass('is-over');
      // The card's copy keeps its row's dress, but not the row's details, which would draw a summary of its own.
      expect(document.querySelector('.drag-ghost .triage-swimlane')).not.toBeNull();
      expect(document.querySelector('.drag-ghost details')).toBeNull();
      drag.drop();
      expect(empty).not.toHaveClass('is-over');
      expect(onMove).toHaveBeenCalledWith(expect.objectContaining({ id: 'c' }), { lane: 'triage', row: 'high' });
    });

    it('moves a card to another row from its menu, and with Alt+Shift and an arrow', async () => {
      const onMove = vi.fn();
      render(<TriageBoard lanes={lanes} cards={laned} rows={rows} rowsLabel="Priority" onMove={onMove} />);
      expect(await menu('Charlie')).toEqual(['Triage', 'Done', 'High']);
      await userEvent.click(screen.getByRole('menuitem', { name: 'High' }));
      expect(onMove).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c' }), { lane: 'new', row: 'high' });
      screen.getByRole('button', { name: 'Charlie' }).focus();
      await userEvent.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}');
      expect(onMove).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Charlie' })).toHaveAttribute(
        'aria-keyshortcuts',
        expect.stringContaining('Alt+Shift+ArrowUp'),
      );
    });

    it("where the row is not the reader's, offers no row and says why a row change is refused", async () => {
      const onMove = vi.fn();
      const onRefuse = vi.fn();
      render(
        <TriageBoard lanes={lanes} cards={laned} rows={rows} rowsLabel="Priority" rowLock={reason} onMove={onMove} onRefuse={onRefuse} />,
      );
      expect(await menu('Charlie')).toEqual(['Triage', 'Done']);
      await userEvent.keyboard('{Escape}');
      screen.getByRole('button', { name: 'Charlie' }).focus();
      await userEvent.keyboard('{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}');
      expect(onRefuse).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'c' }), reason);
      // A drop on the other row is taken only to be refused: nothing is marked, nothing moves.
      const cell = screen.getByRole('region', { name: 'New High' });
      const drag = pressToDrag(screen.getByRole('button', { name: 'Charlie' }));
      drag.over(cell);
      expect(cell).not.toHaveClass('is-over');
      drag.drop();
      expect(onRefuse).toHaveBeenCalledTimes(2);
      expect(onMove).not.toHaveBeenCalled();
    });
  });

  it("F2 and the card menu's Edit ask the host for an editor, which it draws under the card", async () => {
    const onEdit = vi.fn();
    const edits = [{ field: 'name', label: 'Name' }];
    const { rerender } = render(<TriageBoard lanes={lanes} cards={[{ ...cards[0], edits }]} onEdit={onEdit} />);
    const card = screen.getByRole('button', { name: 'Broken login, Aster' });
    expect(card).toHaveAttribute('aria-keyshortcuts', 'F2');
    card.focus();
    await userEvent.keyboard('{F2}');
    expect(onEdit).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a' }), 'name');
    expect(await menu('Broken login')).toEqual(['Name']);
    await userEvent.click(screen.getByRole('menuitem', { name: 'Name' }));
    expect(onEdit).toHaveBeenCalledTimes(2);
    rerender(
      <TriageBoard
        lanes={lanes}
        cards={[{ ...cards[0], edits }]}
        onEdit={onEdit}
        under={{ id: 'a', node: <input aria-label="Name editor" /> }}
      />,
    );
    expect(within(card.closest('article')!).getByRole('textbox', { name: 'Name editor' })).toBeInTheDocument();
  });
});

describe('a draggable card says it can be dragged', () => {
  it('marks only the cards that can move, and the stylesheet gives that mark a grab cursor and a grip', () => {
    const { container } = render(<TriageBoard lanes={lanes} cards={cards} />);
    expect(container.querySelector('[data-draggable="true"]')).toBeNull();
    cleanup();
    const movable = render(<TriageBoard lanes={lanes} cards={cards} onMove={() => {}} />);
    expect(movable.container.querySelectorAll('.triage-card[data-draggable="true"]')).toHaveLength(2);
    const css = readFileSync('packages/mistri/src/client/components/TriageBoard.css', 'utf8');
    expect(css).toMatch(/\.triage-card\[data-draggable='true'\] \{ cursor: grab; \}/);
    expect(css).toMatch(/\.triage-card\[data-draggable='true'\]::after/);
  });
});
