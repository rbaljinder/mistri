/**
 * The platform's own inputs for a display rule: a column whose rule is a
 * rating, a slider, a color, a time, a month or a year is edited in its own
 * control, fetched on demand through the same slot an App's input takes, and
 * an App's declared input for the column still wins.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { api } from '../../../../kit/src/client/core.js';
import { installShell } from '../../../../kit/src/client/shellMode.js';
import { appComponents } from './sdk/appComponents.js';

vi.mock('../../../../kit/src/client/core.js', async (actual) => ({ ...(await actual<object>()), api: vi.fn() }));
import { builtInInput } from './builtInInputs.js';
import { columnInput, InputSlot } from '../../../../kit/src/client/components/inputRenderers.js';

const APP = {
  resources: {
    project: {
      display: {
        health: { format: 'rating', outOf: 4 },
        term: { slider: { min: 12, max: 84, step: 12 } },
        hue: { format: 'color' },
        opens: { format: 'time' },
        renews: { format: 'month' },
        model: { format: 'year' },
        notes: { format: 'json' },
        upc: { scan: true },
        signed: { signature: { table: 'signature', key: 'id' } },
        unsigned: { signature: true },
        own: { format: 'rating' },
      },
      inputs: { own: { id: 'acme:stars' } },
    },
  },
};

beforeEach(() => installShell({ app: () => APP as never, inApp: () => true, components: appComponents }));
afterEach(() => {
  cleanup();
  installShell({ app: () => null, inApp: () => false });
});

const props = (name: string, value: string | number | null, onChange = vi.fn()) => ({
  value,
  onChange,
  id: `f-${name}`,
  invalid: false,
  disabled: false,
  required: false,
  label: name,
  field: { name, resource: 'project' },
});

describe('built-in inputs', () => {
  test("a column's display rule names its input; a declared input wins, and a format with none keeps the box", () => {
    expect(columnInput('project', 'health')).toBe('mistri:rating');
    expect(columnInput('project', 'term')).toBe('mistri:slider');
    expect(['hue', 'opens', 'renews', 'model'].map((column) => columnInput('project', column))).toEqual([
      'mistri:color',
      'mistri:time',
      'mistri:month',
      'mistri:year',
    ]);
    expect(columnInput('project', 'own')).toBe('acme:stars');
    expect(columnInput('project', 'notes')).toBe('mistri:json');
    expect(columnInput('project', 'upc')).toBe('mistri:scan');
    expect(columnInput('project', 'signed')).toBe('mistri:signature');
    // A signature whose file resource did not resolve has nowhere to be kept: the plain box stays.
    expect(columnInput('project', 'unsigned')).toBeUndefined();
    expect(columnInput('project', 'constructor')).toBeUndefined();
    expect(builtInInput('qr')).toBeNull();
  });

  test('stars are a radio group of the rule’s length: a click picks, the arrows move, a second click clears', () => {
    const Rating = builtInInput('rating')!;
    const onChange = vi.fn();
    const { container } = render(<Rating {...props('health', 2, onChange)} />);
    const group = container.querySelector('[role="radiogroup"]')!;
    const stars = group.querySelectorAll<HTMLButtonElement>('[role="radio"]');
    expect(stars).toHaveLength(4);
    expect(stars[1]!.getAttribute('aria-checked')).toBe('true');
    expect([...stars].filter((star) => star.tabIndex === 0)).toHaveLength(1);
    fireEvent.click(stars[3]!);
    expect(onChange).toHaveBeenLastCalledWith(4);
    fireEvent.click(stars[1]!);
    expect(onChange).toHaveBeenLastCalledWith(null);
    fireEvent.keyDown(group, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith(3);
    fireEvent.keyDown(group, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith(1);
  });

  test("a slider runs the rule's range and step, its figure beside it", () => {
    const Slider = builtInInput('slider')!;
    const onChange = vi.fn();
    const { container } = render(<Slider {...props('term', 36, onChange)} />);
    const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
    expect([range.min, range.max, range.step, range.value]).toEqual(['12', '84', '12', '36']);
    expect(container.querySelector('output')!.textContent).toBe('36');
    fireEvent.change(range, { target: { value: '48' } });
    expect(onChange).toHaveBeenLastCalledWith(48);
  });

  test('a color is the picker and its code; a time, a month and a year are native pickers trimmed to what they show', () => {
    const Color = builtInInput('color')!;
    const onChange = vi.fn();
    const color = render(<Color {...props('hue', '#1D4ED8', onChange)} />);
    expect(color.container.querySelector<HTMLInputElement>('input[type="color"]')!.value).toBe('#1d4ed8');
    fireEvent.change(color.container.querySelector('input[type="text"]')!, { target: { value: ' #0e7490 ' } });
    expect(onChange).toHaveBeenLastCalledWith('#0e7490');
    color.unmount();

    const Time = builtInInput('time')!;
    const time = render(<Time {...props('opens', '08:30:00')} />);
    expect(time.container.querySelector<HTMLInputElement>('input[type="time"]')!.value).toBe('08:30');
    time.unmount();
    const Month = builtInInput('month')!;
    const month = render(<Month {...props('renews', '2027-03-01')} />);
    expect(month.container.querySelector('input')!.getAttribute('value') ?? month.container.querySelector('input')!.value).toBe('2027-03');
    month.unmount();
    const Year = builtInInput('year')!;
    const yearChange = vi.fn();
    const year = render(<Year {...props('model', 2024, yearChange)} />);
    const box = year.container.querySelector<HTMLInputElement>('input[type="number"]')!;
    fireEvent.change(box, { target: { value: '2025' } });
    expect(yearChange).toHaveBeenLastCalledWith(2025);
    fireEvent.change(box, { target: { value: '' } });
    expect(yearChange).toHaveBeenLastCalledWith(null);
  });

  test('the slot draws the plain box until the built-in input arrives, then the input', async () => {
    const { container } = render(
      <InputSlot component="mistri:rating" fallback={<input data-stub="plain-box" />} context="edit" {...props('health', 3)} />,
    );
    await waitFor(() => expect(container.querySelector('[role="radiogroup"]')).not.toBeNull());
    expect(container.querySelector('[data-stub="plain-box"]')).toBeNull();
  });

  test('a JSON document is edited as text: its parse problem said while typed, Format laying out one that reads', () => {
    const Json = builtInInput('json')!;
    const onChange = vi.fn();
    const { container, getByRole, rerender } = render(<Json {...props('notes', '{"a":1}', onChange)} />);
    const box = container.querySelector('textarea')!;
    expect(box).toHaveClass('json-input-text');
    fireEvent.click(getByRole('button', { name: 'Format' }));
    expect(onChange).toHaveBeenLastCalledWith('{\n  "a": 1\n}');
    fireEvent.change(box, { target: { value: '{"a":' } });
    expect(onChange).toHaveBeenLastCalledWith('{"a":');
    rerender(<Json {...props('notes', '{"a":', onChange)} />);
    expect(container.querySelector('.json-input-problem')!.textContent).toMatch(/^Not valid JSON: /);
    expect(box).toHaveAttribute('aria-invalid', 'true');
    expect(getByRole('button', { name: 'Format' })).toBeDisabled();
    fireEvent.change(box, { target: { value: '  ' } });
    expect(onChange).toHaveBeenLastCalledWith(null);
  });

  test('a code is typed where no camera reads one, and Scan stands beside the box only where the browser can', () => {
    const Scan = builtInInput('scan')!;
    const onChange = vi.fn();
    const { container, queryByRole, unmount } = render(<Scan {...props('upc', '0123', onChange)} />);
    fireEvent.change(container.querySelector('input')!, { target: { value: '0123456789012' } });
    expect(onChange).toHaveBeenLastCalledWith('0123456789012');
    expect(queryByRole('button', { name: 'Scan' })).toBeNull();
    unmount();
    vi.stubGlobal('BarcodeDetector', class {});
    Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: () => new Promise(() => {}) }, configurable: true });
    try {
      const { getByRole } = render(<Scan {...props('upc', null)} />);
      fireEvent.click(getByRole('button', { name: 'Scan' }));
      expect(getByRole('button', { name: 'Stop scanning' })).toHaveAttribute('aria-pressed', 'true');
    } finally {
      vi.unstubAllGlobals();
      Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
    }
  });

  test('a signature is kept as a picture row only when asked, and the form holds that row', async () => {
    HTMLCanvasElement.prototype.toBlob = function (done: BlobCallback) {
      done(new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' }));
    };
    vi.mocked(api).mockResolvedValue({ key: { id: 41 } });
    const Signature = builtInInput('signature')!;
    const onChange = vi.fn();
    const { getByRole, getByPlaceholderText, rerender } = render(<Signature {...props('signed', null, onChange)} />);
    // Nothing drawn: nothing to undo, clear or keep.
    expect(getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(getByRole('button', { name: 'Use this signature' })).toBeDisabled();
    fireEvent.click(getByRole('button', { name: 'Type instead' }));
    fireEvent.change(getByPlaceholderText('Type your full name'), { target: { value: 'Ana Ruiz' } });
    fireEvent.click(getByRole('button', { name: 'Use this signature' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(41));
    expect(api).toHaveBeenCalledWith('/api/file/upload', {
      table: 'signature',
      values: {},
      file: { name: 'signature.png', type: 'image/png', data: 'iVBORw==' },
    });
    // Kept, it is its picture, with a way to sign again.
    rerender(<Signature {...props('signed', 41, onChange)} />);
    expect(getByRole('img', { name: 'signed: the kept signature' })).toHaveAttribute('src', expect.stringContaining('table=signature'));
    expect(getByRole('button', { name: 'Sign again' })).toBeEnabled();
  });
});
