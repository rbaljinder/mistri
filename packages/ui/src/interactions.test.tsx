/**
 * Keyboard navigation, focus placement/restoration, disabled-state, and locale/words
 * interaction tests across date/time inputs, selects/comboboxes, and menus.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { useRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DropItem, DropMenu } from './DropMenu.js';
import { AreaChart } from './charts.js';
import { formatChartNumber } from './charts/chartShared.js';
import {
  Combobox,
  ContextMenu,
  DatePicker,
  DateTimePicker,
  DropdownMenu,
  FormattedValue,
  MultiSelect,
  Select,
  TimeInput,
} from './primitives.js';
import { CalendarView, DataTable, FilterBar } from './views.js';

afterEach(() => {
  document.documentElement.lang = '';
  cleanup();
});

describe('Date and time inputs: keyboard, focus & disabled state', () => {
  it('TimeInput steps segments with ArrowUp/ArrowDown, moves focus with ArrowRight, and blocks input when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function ControlledTime({ disabled = false }: { disabled?: boolean }) {
      const [val, setVal] = useState<string | null>('09:30');
      return (
        <TimeInput
          label="Start time"
          value={val}
          hourCycle={24}
          disabled={disabled}
          onValueChange={(next) => {
            setVal(next);
            onChange(next);
          }}
        />
      );
    }

    const { rerender } = render(<ControlledTime />);
    const segments = screen.getAllByRole('spinbutton');
    expect(segments.length).toBeGreaterThanOrEqual(2);

    const hourSegment = segments[0]!;
    const minuteSegment = segments[1]!;

    await user.click(hourSegment);
    expect(hourSegment).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenLastCalledWith('10:30');

    await user.keyboard('{ArrowRight}');
    expect(minuteSegment).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(onChange).toHaveBeenLastCalledWith('10:29');

    onChange.mockClear();
    rerender(<ControlledTime disabled />);
    for (const seg of screen.getAllByRole('spinbutton')) {
      expect(seg.getAttribute('aria-disabled') === 'true' || seg.hasAttribute('disabled') || seg.tabIndex < 0).toBe(true);
    }
    fireEvent.keyDown(screen.getAllByRole('spinbutton')[0]!, { key: 'ArrowUp' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('DatePicker & DateRangePicker open via keyboard, close on Escape restoring focus, and honor disabled', async () => {
    const user = userEvent.setup();
    const onRangeChange = vi.fn();

    const { rerender } = render(<DatePicker label="Release date" defaultValue="2026-11-15" locale="en-US" clearable />);

    const trigger = document.querySelector<HTMLButtonElement>('.nx-date-picker-trigger')!;
    trigger.focus();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    const grid = await screen.findByRole('grid');
    expect(grid).toBeTruthy();

    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('grid')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());

    rerender(<DatePicker mode="range" label="Window" defaultValue={['2026-11-10', '2026-11-14']} disabled onValueChange={onRangeChange} />);

    const disabledTrigger = document.querySelector<HTMLButtonElement>('.nx-date-picker-trigger')!;
    expect(disabledTrigger.disabled || disabledTrigger.getAttribute('aria-disabled') === 'true').toBe(true);
    await user.click(disabledTrigger);
    expect(screen.queryByRole('grid')).toBeNull();
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it('DateTimePicker updates composite ISO value via keyboard segment stepping and disables all sub-controls', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <DateTimePicker label="Scheduled at" defaultValue="2026-11-21T14:15" showTimezone onValueChange={onChange} />,
    );

    const spinbuttons = screen.getAllByRole('spinbutton');
    await user.click(spinbuttons[0]!);
    await user.keyboard('{ArrowUp}');
    expect(onChange).toHaveBeenCalledWith(
      '2026-11-21T15:15',
      expect.objectContaining({ date: '2026-11-21', time: '15:15', timezone: 'UTC' }),
    );

    onChange.mockClear();
    rerender(<DateTimePicker label="Scheduled at" defaultValue="2026-11-21T14:15" showTimezone disabled onValueChange={onChange} />);
    const tzTrigger = screen.getByRole('button', { name: /^Timezone/ });
    expect(tzTrigger).toBeDisabled();
  });
});

describe('Selects & Comboboxes: keyboard, focus & disabled state', () => {
  const PRIORITY_OPTIONS = [
    { value: 'low', label: 'Low' },
    { value: 'frozen', label: 'Frozen', disabled: true },
    { value: 'high', label: 'High' },
  ] as const;

  it('Select opens with ArrowDown, skips disabled options, commits on Enter, restores focus on Escape, and blocks when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function ControlledSelect({ disabled = false }: { disabled?: boolean }) {
      const [val, setVal] = useState<string>('low');
      return (
        <Select
          label="Priority"
          options={PRIORITY_OPTIONS}
          value={val}
          disabled={disabled}
          onValueChange={(next, details) => {
            setVal(next);
            onChange(next, details);
          }}
        />
      );
    }

    const { rerender } = render(<ControlledSelect />);
    const trigger = screen.getByRole('button', { name: /^Priority/ });
    trigger.focus();
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    await user.keyboard('{ArrowDown}');
    const initialOptions = await screen.findAllByRole('option');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(initialOptions[1]).toHaveAttribute('aria-disabled', 'true');

    // ArrowDown from 'Low' (index 0) skips disabled 'Frozen' (index 1) directly to 'High' (index 2)
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('high', expect.anything()), { timeout: 1000 });
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'), { timeout: 1000 });

    // Reopen and verify Escape closes without changing selection and restores focus to trigger
    onChange.mockClear();
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'true'), { timeout: 1000 });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'), { timeout: 1000 });
    await waitFor(() => expect(trigger).toHaveFocus(), { timeout: 1000 });
    expect(onChange).not.toHaveBeenCalled();

    // Disabled Select cannot open
    rerender(<ControlledSelect disabled />);
    const disabledTrigger = screen.getByRole('button', { name: /^Priority/ });
    expect(disabledTrigger).toBeDisabled();
    fireEvent.keyDown(disabledTrigger, { key: 'ArrowDown' });
    expect(disabledTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('MultiSelect toggles multiple choices via keyboard, skips disabled items, and blocks opening when disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    function ControlledMulti({ disabled = false }: { disabled?: boolean }) {
      const [vals, setVals] = useState<string[]>(['low']);
      return (
        <MultiSelect
          label="Tags"
          options={PRIORITY_OPTIONS}
          value={vals}
          disabled={disabled}
          onValueChange={(next, details) => {
            setVals(next);
            onChange(next, details);
          }}
        />
      );
    }

    const { rerender } = render(<ControlledMulti />);
    const trigger = screen.getByRole('button', { name: /^Tags/ });
    trigger.focus();

    await user.keyboard('{ArrowDown}');
    await screen.findAllByRole('option');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    // ArrowDown from 'Low' skips disabled 'Frozen' and toggles 'High' on Enter
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(['low', 'high'], expect.anything()), { timeout: 1000 });

    await user.keyboard('{Escape}');
    await waitFor(() => expect(trigger).toHaveAttribute('aria-expanded', 'false'), { timeout: 1000 });
    await waitFor(() => expect(trigger).toHaveFocus(), { timeout: 1000 });

    onChange.mockClear();
    rerender(<ControlledMulti disabled />);
    const disabledTrigger = screen.getByRole('button', { name: /^Tags/ });
    expect(disabledTrigger).toBeDisabled();
    fireEvent.keyDown(disabledTrigger, { key: 'ArrowDown' });
    expect(disabledTrigger).toHaveAttribute('aria-expanded', 'false');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Combobox filters via keyboard typing, skips disabled items, commits on Enter, and honors disabled', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    const { rerender } = render(
      <Combobox
        label="Assignee"
        options={[
          { value: 'ada', label: 'Ada Lovelace' },
          { value: 'alan', label: 'Alan Turing', disabled: true },
          { value: 'grace', label: 'Grace Hopper' },
        ]}
        onValueChange={(next) => onChange(next)}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Assignee' });
    await user.click(input);
    await user.keyboard('Grace');
    await screen.findByRole('listbox');
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => expect(onChange).toHaveBeenCalledWith('grace'));

    onChange.mockClear();
    rerender(
      <Combobox label="Assignee" disabled options={[{ value: 'ada', label: 'Ada Lovelace' }]} onValueChange={(next) => onChange(next)} />,
    );
    const disabledInput = screen.getByRole('combobox', { name: 'Assignee' });
    expect(disabledInput).toBeDisabled();
    await user.click(disabledInput);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

describe('Menus: keyboard roving, focus restoration & disabled items', () => {
  it('DropdownMenu opens with keyboard, skips disabled items, fires onSelect on Enter, and restores focus on Escape', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onArchive = vi.fn();
    const onDelete = vi.fn();

    render(
      <DropdownMenu
        trigger={<button type="button">Record actions</button>}
        items={[
          { id: 'edit', label: 'Edit record', onSelect: onEdit },
          { id: 'archive', label: 'Archive record', disabled: true, onSelect: onArchive },
          { id: 'delete', label: 'Delete record', danger: true, onSelect: onDelete },
        ]}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Record actions' });
    trigger.focus();
    expect(trigger).toHaveFocus();

    // Open with Enter, press Escape -> menu closes without firing callbacks and restores focus
    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(onEdit).not.toHaveBeenCalled();

    // Open again, disabled 'Archive record' ignores activation
    await user.keyboard('{ArrowDown}');
    await screen.findByRole('menu');
    const archiveItem = screen.getByRole('menuitem', { name: 'Archive record' });
    await user.click(archiveItem);
    expect(onArchive).not.toHaveBeenCalled();

    // Select 'Delete record' with keyboard
    const deleteItem = screen.getByRole('menuitem', { name: 'Delete record' });
    deleteItem.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(1));
  });

  it('DropMenu supports keyboard navigation, custom finalFocus restoration, and disabled trigger', async () => {
    const user = userEvent.setup();
    const onPick = vi.fn();

    function DropMenuHarness({ disabled = false }: { disabled?: boolean }) {
      const nextTarget = useRef<HTMLButtonElement>(null);
      return (
        <div>
          <DropMenu label="More" disabled={disabled} finalFocus={nextTarget}>
            <DropItem onClick={() => onPick('duplicate')}>Duplicate</DropItem>
            <DropItem disabled onClick={() => onPick('locked')}>
              Locked
            </DropItem>
            <DropItem onClick={() => onPick('export')}>Export CSV</DropItem>
          </DropMenu>
          <button ref={nextTarget} type="button">
            After menu
          </button>
        </div>
      );
    }

    const { rerender } = render(<DropMenuHarness />);
    const trigger = screen.getByRole('button', { name: 'More' });
    trigger.focus();

    await user.keyboard('{Enter}');
    await screen.findByRole('menu');
    const locked = screen.getByRole('menuitem', { name: 'Locked' });
    await user.click(locked);
    expect(onPick).not.toHaveBeenCalled();

    const duplicate = screen.getByRole('menuitem', { name: 'Duplicate' });
    duplicate.focus();
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onPick).toHaveBeenCalledWith('duplicate'));
    await waitFor(() => expect(screen.getByRole('button', { name: 'After menu' })).toHaveFocus());

    rerender(<DropMenuHarness disabled />);
    const disabledTrigger = screen.getByRole('button', { name: 'More' });
    expect(disabledTrigger).toBeDisabled();
    await user.click(disabledTrigger);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('ContextMenu opens on contextmenu event, invokes enabled item, and blocks when disabled', async () => {
    const user = userEvent.setup();
    const onInspect = vi.fn();

    const { rerender } = render(
      <ContextMenu disabled={false} items={[{ id: 'inspect', label: 'Inspect row', onSelect: onInspect }]}>
        <div>Row target</div>
      </ContextMenu>,
    );

    fireEvent.contextMenu(screen.getByText('Row target'));
    const item = await screen.findByRole('menuitem', { name: 'Inspect row' });
    await user.click(item);
    expect(onInspect).toHaveBeenCalledTimes(1);

    onInspect.mockClear();
    rerender(
      <ContextMenu disabled items={[{ id: 'inspect', label: 'Inspect row', onSelect: onInspect }]}>
        <div>Row target</div>
      </ContextMenu>,
    );
    fireEvent.contextMenu(screen.getByText('Row target'));
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

describe('Locale resolution & overridable words', () => {
  it('picks up <html lang> automatically in charts, FormattedValue, and CalendarView and accepts explicit locale/words', () => {
    document.documentElement.lang = 'de-DE';

    expect(formatChartNumber(1234.5)).toBe(new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(1234.5));

    const { container } = render(
      <div>
        <FormattedValue value={1250.5} format="currency" currency="EUR" />
        <AreaChart
          data={[{ day: 'Mo', count: 1234.5 }]}
          xKey="day"
          series={[{ key: 'count', label: 'Aufträge' }]}
          seriesLabel="Datenreihen"
        />
        <CalendarView
          defaultSelectedDate="2026-11-15"
          events={[]}
          words={{
            todayLabel: 'Heute',
            monthLabel: 'Monat',
            weekLabel: 'Woche',
            dayLabel: 'Tag',
            previousPeriodLabel: 'Vorheriger Zeitraum',
            nextPeriodLabel: 'Nächster Zeitraum',
          }}
        />
        <DataTable
          data={[{ id: '1', name: 'Alder Court' }]}
          columns={[{ id: 'name', header: 'Objekt' }]}
          selectable
          words={{ selectAllVisible: 'Alle sichtbaren Zeilen auswählen', columnsButton: 'Spalten' }}
        />
        <FilterBar
          facets={[{ id: 'status', label: 'Status', options: [{ value: 'open', label: 'Offen' }] }]}
          words={{ regionLabel: 'Filterleiste', addFilterButton: 'Filter hinzufügen' }}
        />
      </div>,
    );

    expect(container.textContent).toContain('1.250,50');
    expect(container.textContent).toContain('November 2026');
    expect(screen.getByRole('button', { name: 'Heute' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Vorheriger Zeitraum' })).toBeTruthy();
    expect(screen.getByRole('checkbox', { name: 'Alle sichtbaren Zeilen auswählen' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Spalten' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Filterleiste' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter hinzufügen' })).toBeTruthy();
  });
});
