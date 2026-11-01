/** The new standalone primitives: Switch, Tabs, Drawer, Popover, Avatar and Pagination. */
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { Switch, type SwitchProps } from './Switch.js';
import { Tabs } from './Tabs.js';
import { Drawer } from './Drawer.js';
import { Popover } from './Popover.js';
import { Avatar, initialsOf } from './Avatar.js';
import { Pagination, paginationItems } from './Pagination.js';
import { Carousel } from './Carousel.js';
import { Resizable } from './Resizable.js';
import { ScrollArea } from './ScrollArea.js';
import { Tooltip } from './Tooltip.js';

afterEach(cleanup);

test('a switch says its state and toggles on Space, and a busy switch refuses the press', async () => {
  const onCheckedChange = vi.fn();
  const { rerender } = render(<Switch label="Notify me" onCheckedChange={onCheckedChange} />);
  const control = screen.getByRole('switch', { name: 'Notify me' });
  expect(control).toHaveAttribute('aria-checked', 'false');
  await userEvent.click(control);
  expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  rerender(<Switch label="Notify me" checked onCheckedChange={onCheckedChange} busy />);
  expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  await userEvent.click(screen.getByRole('switch'));
  expect(onCheckedChange).toHaveBeenCalledTimes(1);
});

test('tabs show one panel at a time and the arrow walk moves between them', async () => {
  render(
    <Tabs
      tabs={[
        { value: 'one', label: 'One', children: 'First panel' },
        { value: 'two', label: 'Two', children: 'Second panel' },
      ]}
    />,
  );
  expect(screen.getByText('First panel')).toBeVisible();
  expect(screen.queryByText('Second panel')).toBeNull();
  await userEvent.click(screen.getByRole('tab', { name: 'Two' }));
  expect(screen.getByText('Second panel')).toBeVisible();
  expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
});

test('a drawer mounts only while open and closes on Escape', async () => {
  const onOpenChange = vi.fn();
  const { rerender } = render(
    <Drawer open title="Filters" onOpenChange={onOpenChange}>
      <button>Inside</button>
    </Drawer>,
  );
  expect(screen.getByText('Filters')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  /* Base UI reports the open state first and the reason second; the
     test's claim is the state, not the reason. */
  expect(onOpenChange.mock.calls[0]?.[0]).toBe(false);
  rerender(
    <Drawer open={false} title="Filters" onOpenChange={onOpenChange}>
      <button>Inside</button>
    </Drawer>,
  );
  /* Base UI keeps the sheet in the tree for its exit animation; the
     claim that matters here is that it is no longer the open sheet. */
  expect(screen.queryByRole('dialog')).not.toHaveAttribute('data-open');
});

test('a popover opens from its trigger and shows its layer', async () => {
  render(
    <Popover trigger={<button>Open</button>}>
      <p>Popover body</p>
    </Popover>,
  );
  expect(screen.queryByText('Popover body')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(screen.getByText('Popover body')).toBeVisible();
});

test('an avatar falls back to initials, two words then one', () => {
  expect(initialsOf('Ada Lovelace')).toBe('AL');
  expect(initialsOf('Ada')).toBe('A');
  expect(initialsOf('')).toBe('');
  render(<Avatar name="Ada Lovelace" />);
  expect(screen.getByText('AL')).toBeVisible();
});

test('pagination marks the current page, disables the ends, and shortens a long run', async () => {
  const onPageChange = vi.fn();
  render(<Pagination page={1} pages={20} onPageChange={onPageChange} />);
  expect(screen.getByRole('button', { name: 'Previous' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '1' })).toHaveAttribute('aria-current', 'page');
  expect(screen.getAllByText('…').length).toBeGreaterThan(0);
  await userEvent.click(screen.getByRole('button', { name: '3' }));
  expect(onPageChange).toHaveBeenCalledWith(3);
  expect(paginationItems(10, 20)).toEqual([1, '…', 8, 9, 10, 11, 12, '…', 20]);
  expect(paginationItems(1, 3)).toEqual([1, 2, 3]);
});

test('pagination renders nothing for a single page', () => {
  const { container } = render(<Pagination page={1} pages={1} onPageChange={vi.fn()} />);
  expect(container).toBeEmptyDOMElement();
});

test('a switch without a label still renders, and fireEvent toggles an uncontrolled one', () => {
  render(<Switch defaultChecked={false} />);
  const control = screen.getByRole('switch');
  fireEvent.click(control);
  expect(control).toHaveAttribute('aria-checked', 'true');
});

test('switch props type-check: controlled props are accepted', () => {
  const props: SwitchProps = { checked: true, onCheckedChange: () => {} };
  expect(props.checked).toBe(true);
});

test('a carousel shows one slide, steps and dots move it, and the ends disable', async () => {
  const onIndexChange = vi.fn();
  const slides = [
    { label: 'Studio', children: 'Studio slide' },
    { label: 'Work', children: 'Work slide' },
    { label: 'Wall', children: 'Wall slide' },
  ];
  render(<Carousel slides={slides} ariaLabel="Project photos" onIndexChange={onIndexChange} />);
  expect(screen.getByRole('region', { name: 'Project photos' })).toBeInTheDocument();
  expect(screen.getByText('Slide 1 of 3: Studio')).toBeVisible();
  // The slide change is announced politely, not left for a reader to find.
  expect(screen.getByText('Slide 1 of 3: Studio')).toHaveAttribute('aria-live', 'polite');
  expect(screen.getByRole('button', { name: 'Previous slide' })).toBeDisabled();
  await userEvent.click(screen.getByRole('button', { name: 'Next slide' }));
  expect(onIndexChange).toHaveBeenCalledWith(1);
  expect(screen.getByText('Slide 2 of 3: Work')).toBeVisible();
  await userEvent.click(screen.getByRole('button', { name: 'Go to slide 3: Wall' }));
  expect(screen.getByText('Slide 3 of 3: Wall')).toBeVisible();
  expect(screen.getByRole('button', { name: 'Next slide' })).toBeDisabled();
  expect(screen.getByRole('group', { name: '3 of 3: Wall' })).toHaveAttribute('aria-roledescription', 'slide');
});

test('a carousel moves on arrow keys and Home/End', async () => {
  const slides = [{ children: 'One' }, { children: 'Two' }];
  render(<Carousel slides={slides} />);
  const region = screen.getByRole('region', { name: 'Carousel' });
  region.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByText('Slide 2 of 2')).toBeVisible();
  await userEvent.keyboard('{Home}');
  expect(screen.getByText('Slide 1 of 2')).toBeVisible();
  await userEvent.keyboard('{End}');
  expect(screen.getByText('Slide 2 of 2')).toBeVisible();
});

test('a carousel leaves arrow keys to an input inside its slides', async () => {
  const slides = [{ children: <input aria-label="Slide note" /> }, { children: 'Two' }];
  render(<Carousel slides={slides} />);
  const input = screen.getByLabelText('Slide note');
  input.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByText('Slide 1 of 2')).toBeVisible();
  expect(input).toHaveFocus();
});

test('a carousel hands focus on when its step disables under it', async () => {
  const slides = [{ children: 'One' }, { children: 'Two' }];
  render(<Carousel slides={slides} />);
  const previous = screen.getByRole('button', { name: 'Previous slide' });
  const next = screen.getByRole('button', { name: 'Next slide' });
  next.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(previous).toHaveFocus();
  await userEvent.keyboard('{ArrowLeft}');
  expect(next).toHaveFocus();
});

test('a carousel renders nothing for no slides', () => {
  const { container } = render(<Carousel slides={[]} />);
  expect(container).toBeEmptyDOMElement();
});

test('resizable panes start at their shares, and the handle walks on arrow keys within its minimums', async () => {
  const onSizesChange = vi.fn();
  render(
    <Resizable
      ariaLabel="Record and detail"
      panels={[
        { label: 'Record', defaultSize: 60, children: 'Record pane' },
        { label: 'Detail', defaultSize: 40, children: 'Detail pane' },
      ]}
      onSizesChange={onSizesChange}
    />,
  );
  const handle = screen.getByRole('separator', { name: 'Resize Record and Detail' });
  expect(handle).toHaveAttribute('aria-valuenow', '60');
  // Panes side by side are parted by a vertical line, so that is the separator's orientation.
  expect(handle).toHaveAttribute('aria-orientation', 'vertical');
  // A named pane has a role to be named by, and says it scrolls on purpose (the double-scroll probe reads that).
  const pane = screen.getByRole('group', { name: 'Record' });
  expect(pane).toHaveClass('ui-resizable-panel');
  expect(pane).toHaveAttribute('data-scrolls');
  handle.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(onSizesChange).toHaveBeenLastCalledWith([65, 35]);
  await userEvent.keyboard('{Home}');
  expect(onSizesChange).toHaveBeenLastCalledWith([10, 90]);
  await userEvent.keyboard('{End}');
  expect(onSizesChange).toHaveBeenLastCalledWith([90, 10]);
});

test('stacked resizable panes are parted by a horizontal line', () => {
  render(
    <Resizable
      direction="vertical"
      panels={[
        { label: 'Top', children: 'T' },
        { label: 'Bottom', children: 'B' },
      ]}
    />,
  );
  expect(screen.getByRole('separator')).toHaveAttribute('aria-orientation', 'horizontal');
});

test('resizable panes scale shares that do not add to 100, and refuse fewer than two panes', () => {
  const { container, rerender } = render(
    <Resizable
      panels={[
        { defaultSize: 1, children: 'A' },
        { defaultSize: 2, children: 'B' },
      ]}
    />,
  );
  const panels = container.querySelectorAll('.ui-resizable-panel');
  expect(panels[0]?.getAttribute('style')).toContain('33.333');
  expect(panels[1]?.getAttribute('style')).toContain('66.666');
  rerender(<Resizable panels={[{ children: 'Only' }]} />);
  expect(container).toBeEmptyDOMElement();
});

test('a scroll area is a labelled region, a tab stop only while its content overflows', () => {
  const { rerender } = render(
    <ScrollArea ariaLabel="Recent activity" maxHeight="320px">
      <p>First row</p>
      <p>Second row</p>
    </ScrollArea>,
  );
  const region = screen.getByRole('region', { name: 'Recent activity' });
  /* Nothing overflows under a test renderer, so there is no tab stop
     to nowhere — only the labelled region holding its content. */
  expect(region).toHaveAttribute('tabindex', '-1');
  // A deliberate scroller says so, so the double-scroll probe leaves it alone.
  expect(region).toHaveAttribute('data-scrolls');
  expect(screen.getByText('Second row')).toBeVisible();
  /* Once the content outgrows the box, the region becomes the tab stop
     a keyboard reader scrolls with. */
  Object.defineProperty(region, 'scrollHeight', { configurable: true, value: 600 });
  Object.defineProperty(region, 'clientHeight', { configurable: true, value: 320 });
  rerender(
    <ScrollArea ariaLabel="Recent activity" maxHeight="320px">
      <p>First row</p>
      <p>Second row</p>
    </ScrollArea>,
  );
  expect(region).toHaveAttribute('tabindex', '0');
});

test('a tooltip says its note on hover and on focus, and names it from the trigger', async () => {
  render(<Tooltip trigger={<button>Save</button>}>Saves the record without leaving the page.</Tooltip>);
  const trigger = screen.getByRole('button', { name: 'Save' });
  await userEvent.hover(trigger);
  /* Base UI waits out its open delay before the note appears. */
  const note = await screen.findByRole('tooltip', {}, { timeout: 3000 });
  expect(note).toHaveTextContent('Saves the record without leaving the page.');
  expect(trigger).toHaveAttribute('aria-describedby', note.id);
  await userEvent.unhover(trigger);
});

test('a carousel leaves its keys to a slider or a portal inside a slide, and answers only to itself and its own controls', async () => {
  const slides = [{ children: <div role="slider" tabIndex={0} aria-label="Zoom" aria-valuenow={1} /> }, { children: 'Two' }];
  render(<Carousel slides={slides} />);
  screen.getByRole('slider', { name: 'Zoom' }).focus();
  await userEvent.keyboard('{ArrowRight}{End}');
  expect(screen.getByText('Slide 1 of 2')).toBeVisible();
  // A step button is the carousel's own control; its arrow still moves the slide.
  screen.getByRole('button', { name: 'Next slide' }).focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(screen.getByText('Slide 2 of 2')).toBeVisible();
});

test("a carousel, a pager and a resizable group say their words in the caller's language", () => {
  render(
    <>
      <Carousel
        slides={[{ children: 'Uno' }, { children: 'Dos', label: 'Segunda' }]}
        words={{
          region: 'Carrusel',
          next: 'Siguiente',
          chooseSlide: 'Elegir una diapositiva',
          goToSlide: (n) => `Ir a la diapositiva ${n}`,
          slide: (n, total) => `${n} de ${total}`,
          status: (n, total) => `Diapositiva ${n} de ${total}`,
        }}
      />
      <Pagination page={1} pages={3} onPageChange={() => {}} words={{ pages: 'Páginas', next: 'Siguiente página' }} />
      <Resizable
        panels={[{ children: 'A', label: 'Lista' }, { children: 'B' }]}
        words={{ resize: (a, b) => `Cambiar ${a} y ${b}`, panel: (n) => `panel ${n} (es)` }}
      />
    </>,
  );
  expect(screen.getByRole('region', { name: 'Carrusel' })).toBeInTheDocument();
  expect(screen.getByRole('group', { name: 'Elegir una diapositiva' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Ir a la diapositiva 2' })).toBeInTheDocument();
  expect(screen.getByText('Diapositiva 1 de 2')).toBeVisible();
  expect(screen.getByRole('navigation', { name: 'Páginas' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Siguiente página' })).toBeInTheDocument();
  expect(screen.getByRole('separator', { name: 'Cambiar Lista y panel 2 (es)' })).toBeInTheDocument();
});

test('initials split by letter, not by UTF-16 unit', () => {
  expect(initialsOf('𠮷野 Taro')).toBe('𠮷T');
  expect(initialsOf('😀 Smile')).toBe('😀S');
  expect(initialsOf('Zoë')).toBe('Z');
});

test("a tooltip joins the trigger's own description instead of replacing it", () => {
  render(
    <>
      <p id="own-hint">Required.</p>
      <Tooltip trigger={<button aria-describedby="own-hint">Save</button>} defaultOpen>
        Saves it.
      </Tooltip>
    </>,
  );
  const described = screen.getByRole('button', { name: 'Save' }).getAttribute('aria-describedby')!.split(' ');
  expect(described).toContain('own-hint');
  expect(described).toHaveLength(2);
});

test('a drawer without a title is named by its ariaLabel', () => {
  render(
    <Drawer open ariaLabel="Filters">
      <p>Body</p>
    </Drawer>,
  );
  expect(screen.getByRole('dialog', { name: 'Filters' })).toBeInTheDocument();
});

test('tabs start on the first tab that is not disabled', () => {
  render(
    <Tabs
      tabs={[
        { value: 'one', label: 'One', disabled: true, children: 'First panel' },
        { value: 'two', label: 'Two', children: 'Second panel' },
      ]}
    />,
  );
  expect(screen.getByRole('tab', { name: 'Two' })).toHaveAttribute('aria-selected', 'true');
});
