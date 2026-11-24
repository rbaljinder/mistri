/* Regressions from the review of the input and editor primitives: each test here fails on the code as it was. */
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { masks } from './masks.js';
import { Slider } from './Slider.js';
import { CodeEditor } from './primitives/codeAndJsonEditors.js';
import { DateTimePicker } from './primitives/dateTimeAndTreePickers.js';
import { EntityPicker } from './primitives/entityPicker.js';
import { Meter } from './primitives/feedback.js';
import { FormattedValue } from './primitives/formattedAndCropper.js';
import { NumberInput, TagInput, TokenInput } from './primitives/numericAndTokenInputs.js';
import { KeyValueEditor, LineItemsEditor, type KeyValueItem, type LineItemRow } from './primitives/structuredEditors.js';

afterEach(() => {
  document.documentElement.removeAttribute('lang');
  cleanup();
});

describe('masks.money', () => {
  it('reads back what it drew in a locale whose decimal is a comma', () => {
    const de = masks.money('€', 20, 'de-DE');
    expect(de.format('1250')).toBe('€1.250');
    // One more digit typed after the grouped figure: twelve thousand five hundred and seven, not 1.25.
    expect(de.parse('€1.2507')).toBe('12507');
    expect(de.parse('€1.250,5')).toBe('1250.5');
    expect(de.format('1250.5')).toBe('€1.250,50');
    expect(de.format('12.')).toBe('€12,');
    expect(de.parse(de.format('12.'))).toBe('12.');
  });

  it('follows <html lang> the same way for format and parse', () => {
    document.documentElement.lang = 'de';
    const money = masks.money('$');
    expect(money.parse(`${money.format('1250')}7`)).toBe('12507');
  });

  it('keeps a leading minus, and a symbol that holds the decimal character is not the fraction', () => {
    const en = masks.money('$', 20, 'en-US');
    expect(en.parse('-$57')).toBe('-57');
    expect(en.parse(`${en.format('-5')}7`)).toBe('-57');
    expect(en.parse('-')).toBe('-');
    expect(en.format('-')).toBe('-');
    expect(en.parse('$1,250.50')).toBe('1250.50');
    expect(masks.money('Rs.', 20, 'en-US').parse('Rs.1,250')).toBe('1250');
  });
});

describe('NumberInput exact mode', () => {
  function Exact({ start, onNumber, step }: { start: string; onNumber?: (n: number | null) => void; step?: number }) {
    const [value, setValue] = useState(start);
    return (
      <NumberInput ariaLabel="Count" value={value} onStringValueChange={setValue} onValueChange={onNumber} step={step} min={0} max={100} />
    );
  }

  it('keeps the same input element when a big value is edited down to a safe one, and tells onValueChange', () => {
    const onNumber = vi.fn();
    render(<Exact start="9007199254740993" onNumber={onNumber} />);
    const box = screen.getByRole('spinbutton');
    fireEvent.focus(box);
    fireEvent.change(box, { target: { value: '12.' } });
    expect(screen.getByRole('spinbutton')).toBe(box);
    expect((box as HTMLInputElement).value).toBe('12.');
    expect(onNumber).toHaveBeenLastCalledWith(12);
    fireEvent.change(box, { target: { value: '12' } });
    expect(screen.getByRole('spinbutton')).toBe(box);
  });

  it('steps a decimal string exactly, clamps it, and states its value and bounds', () => {
    const onNumber = vi.fn();
    render(<Exact start="1.10" onNumber={onNumber} step={0.1} />);
    const box = screen.getByRole('spinbutton') as HTMLInputElement;
    expect(box.getAttribute('aria-valuenow')).toBe('1.1');
    expect(box.getAttribute('aria-valuemin')).toBe('0');
    expect(box.getAttribute('aria-valuemax')).toBe('100');
    fireEvent.focus(box);
    fireEvent.keyDown(box, { key: 'ArrowUp' });
    expect(box.value).toBe('1.20');
    expect(onNumber).toHaveBeenLastCalledWith(1.2);
    fireEvent.click(screen.getByRole('button', { name: 'Decrease value' }));
    fireEvent.click(screen.getByRole('button', { name: 'Decrease value' }));
    expect(box.value).toBe('1.00');
    for (let i = 0; i < 12; i += 1) fireEvent.keyDown(box, { key: 'ArrowDown' });
    expect(box.value).toBe('0.00');
  });
});

describe('TokenInput and TagInput', () => {
  const chips = (host: HTMLElement) => [...host.querySelectorAll('.nx-token-chip-label')].map((el) => el.textContent);

  it('draws a list of plain strings as separate chips, each with a remove control', () => {
    const { container } = render(<TagInput label="Tags" value={['hydraulics', 'urgent']} />);
    expect(chips(container)).toEqual(['hydraulics', 'urgent']);
    expect(container.querySelectorAll('.nx-token-chip-remove')).toHaveLength(2);
  });

  /* The editor is a contenteditable the SDK reads through the selection; a paste at the caret is how text reaches it here. */
  function paste(editor: HTMLElement, text: string) {
    editor.focus();
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.paste(editor, { clipboardData: { getData: () => text, types: ['text/plain'] } });
  }

  function Tags({ onTags }: { onTags: (tags: string[]) => void }) {
    const [tags, setTags] = useState<string[]>(['a']);
    return (
      <TokenInput
        label="Tags"
        tags={tags}
        onTagsChange={(next) => {
          onTags(next);
          setTags(next);
        }}
      />
    );
  }

  it('turns a pasted comma list into one chip each', () => {
    const onTags = vi.fn();
    const { container } = render(<Tags onTags={onTags} />);
    paste(container.querySelector<HTMLElement>('.nx-token-editor')!, 'b, c,d');
    expect(onTags).toHaveBeenLastCalledWith(['a', 'b', 'c', 'd']);
    expect(chips(container)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps typed text through a controlled round trip, commits it on Enter and on blur, and not while composing', () => {
    const onTags = vi.fn();
    const { container } = render(<Tags onTags={onTags} />);
    const editor = container.querySelector<HTMLElement>('.nx-token-editor')!;
    paste(editor, 'draft');
    // Text alone is not a tag yet, and the caller's list (which cannot hold it) must not wipe it.
    expect(onTags).not.toHaveBeenCalled();
    expect(editor.textContent).toContain('draft');
    fireEvent.keyDown(editor, { key: 'Enter', isComposing: true });
    expect(onTags).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: 'Enter' });
    expect(onTags).toHaveBeenLastCalledWith(['a', 'draft']);
    paste(editor, 'left behind');
    fireEvent.blur(editor);
    expect(onTags).toHaveBeenLastCalledWith(['a', 'draft', 'left behind']);
  });

  it('adopts a new controlled list and reports only chips', () => {
    const { container, rerender } = render(<TokenInput label="Filters" tags={['a']} />);
    rerender(<TokenInput label="Filters" tags={['a', 'b']} />);
    expect(chips(container)).toEqual(['a', 'b']);
  });
});

describe('structured editors', () => {
  it('KeyValueEditor gives an added row an id no reloaded row holds, and takes its words', () => {
    const saved: KeyValueItem[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `nx-kv-${n}`, key: `K${n}`, value: 'v' }));
    saved.push({ id: 'dupe', key: 'K1', value: 'x' });
    const onChange = vi.fn();
    render(<KeyValueEditor value={saved} onValueChange={onChange} words={{ duplicate: 'DOPPELT', pasteTip: 'Einfügen' }} />);
    expect(screen.getAllByText('DOPPELT')).toHaveLength(2);
    expect(screen.getByText('Einfügen')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add row' }));
    const next = onChange.mock.calls.at(-1)![0] as KeyValueItem[];
    expect(new Set(next.map((item) => item.id)).size).toBe(next.length);
  });

  it('LineItemsEditor gives an added line a fresh id and lets a money cell go negative', () => {
    const rows: LineItemRow[] = [1, 2, 3, 4, 5, 6].map((n) => ({ id: `nx-line-${n}`, description: `Line ${n}`, credit: -5 }));
    const onChange = vi.fn();
    const { container } = render(
      <LineItemsEditor
        columns={[
          { key: 'description', label: 'Description', kind: 'text' },
          { key: 'credit', label: 'Credit', kind: 'money' },
        ]}
        value={rows}
        onValueChange={onChange}
      />,
    );
    expect(container.querySelector('.nx-line-cell-money input')?.hasAttribute('min')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Add line/ }));
    const next = onChange.mock.calls.at(-1)![0] as LineItemRow[];
    expect(new Set(next.map((row) => row.id)).size).toBe(next.length);
  });
});

describe('FormattedValue', () => {
  it('formats a day written alone as that calendar day wherever the reader is', () => {
    // The suite runs in whatever zone the machine has; the UTC reading is the one that cannot drift.
    const { container } = render(<FormattedValue format="date" value="2026-03-01" locale="en-US" copyable />);
    expect(container.querySelector('.nx-fv-text')?.textContent).toBe('Mar 1, 2026');
    const spy = vi.spyOn(Intl, 'DateTimeFormat');
    render(<FormattedValue format="date" value="2026-03-01" locale="en-US" />);
    expect(spy.mock.calls.at(-1)?.[1]).toMatchObject({ timeZone: 'UTC' });
    spy.mockRestore();
  });
});

describe('DateTimePicker', () => {
  it('writes a day with no time as the day alone, and keeps a written offset', () => {
    const { container, rerender } = render(<DateTimePicker name="at" value="2026-03-01" ariaLabel="At" />);
    const hidden = () => container.querySelector<HTMLInputElement>('input[type="hidden"][name="at"]')!.value;
    expect(hidden()).toBe('2026-03-01');
    rerender(<DateTimePicker name="at" value="2026-03-01T14:30:00.000Z" ariaLabel="At" />);
    expect(hidden()).toBe('2026-03-01T14:30Z');
    rerender(<DateTimePicker name="at" value="2026-03-01T14:30+05:30" ariaLabel="At" />);
    expect(hidden()).toBe('2026-03-01T14:30+05:30');
  });
});

describe('CodeEditor', () => {
  it('lets Escape then Tab leave, and says so to a screen reader', () => {
    const onChange = vi.fn();
    render(<CodeEditor ariaLabel="Query" defaultValue="a" onValueChange={onChange} />);
    const box = screen.getByRole('textbox', { name: 'Query' });
    const described = box.getAttribute('aria-describedby')!.split(' ');
    expect(described.some((id) => /Escape, then Tab/.test(document.getElementById(id)?.textContent ?? ''))).toBe(true);
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box, { key: 'Escape' });
    // Not prevented: the browser moves focus on.
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(true);
    expect(onChange).toHaveBeenCalledTimes(1);
    // The hatch is one Tab wide.
    expect(fireEvent.keyDown(box, { key: 'Tab' })).toBe(false);
    fireEvent.keyDown(box, { key: 'Escape' });
    fireEvent.keyDown(box, { key: 'Shift' });
    expect(fireEvent.keyDown(box, { key: 'Tab', shiftKey: true })).toBe(true);
  });
});

describe('Meter and Slider', () => {
  it('Meter states a value inside its range, and none when there is no number', () => {
    const { rerender } = render(<Meter ariaLabel="Load" value={140} min={0} max={100} showValue />);
    expect(screen.getByRole('meter').getAttribute('aria-valuenow')).toBe('100');
    rerender(<Meter ariaLabel="Load" value={Number.NaN} min={0} max={100} showValue />);
    expect(screen.getByRole('meter').hasAttribute('aria-valuenow')).toBe(false);
  });

  it('Slider says money in the currency it is given', () => {
    render(<Slider id="budget" label="Budget" value={50} min={0} max={100} format="money" currency="EUR" locale="en-US" />);
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('€50');
  });
});

describe('EntityPicker', () => {
  it('names a preselected record the loader has not returned', async () => {
    const load = vi.fn(async () => []);
    await act(async () => {
      render(
        <EntityPicker
          ariaLabel="Customer"
          value="cus-9"
          loadEntities={load}
          selectedEntities={[{ id: 'cus-9', code: 'CUS-9', label: 'Northwind Traders' }]}
        />,
      );
    });
    expect((screen.getByRole('combobox') as HTMLInputElement).value).toBe('CUS-9 · Northwind Traders');
  });
});
