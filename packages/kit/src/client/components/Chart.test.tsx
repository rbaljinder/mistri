/**
 * The three chart shapes: what they draw from rows, what they say, and
 * the one interaction the line has.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { BarChart, DonutChart, LineChart, Sparkline, StackedBars, axisMarks, namesAtEnds, periodTick } from './Chart.js';
import { installShell } from '../shellMode.js';

afterEach(cleanup);
const money = (v: unknown) => `$${Number(v)}`;

describe('the bars', () => {
  const months = [
    { key: '2026-01', value: 10 },
    { key: '2026-03', value: 30 },
    { key: '2026-04', value: 20 },
  ];

  test('one bar per period, the missing ones at zero, the last one current with its value said over it', () => {
    const { container } = render(<BarChart rows={months} say={money} wide={600} />);
    const bars = [...container.querySelectorAll('.chart-bar')];
    expect(bars.map((bar) => bar.querySelector('title')!.textContent)).toEqual([
      'Jan 2026: $10',
      'Feb 2026: $0',
      'Mar 2026: $30',
      'Apr 2026: $20',
    ]);
    expect(bars.map((bar) => bar.classList.contains('is-active'))).toEqual([false, false, false, true]);
    expect(container.querySelector('.chart-bar-tip text')).toHaveTextContent('Apr 2026 · $20');
    // The guide runs across the levels at the current bar's top.
    const guide = container.querySelector('.chart-bar-guide')!;
    expect(guide.getAttribute('y1')).toBe(bars[3].getAttribute('y'));
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '4 bars; highest $30; Apr 2026 $20');
    // Every bar is a row assistive technology reads.
    expect([...container.querySelectorAll('.chart-data tr')].map((row) => row.textContent)).toEqual([
      'Jan 2026$10',
      'Feb 2026$0',
      'Mar 2026$30',
      'Apr 2026$20',
    ]);
  });

  test('periods stand in time order however the answer ranked them', () => {
    /* A record page's chart comes back ranked by its measure, newest first on a tie. */
    const ranked = [
      { key: '2026-06', value: 1 },
      { key: '2026-04', value: 3 },
      { key: '2025-10', value: 2 },
    ];
    const { container } = render(<BarChart rows={ranked} say={money} wide={600} />);
    const said = [...container.querySelectorAll('.chart-bar title')].map((t) => t.textContent);
    expect(said[0]).toBe('Oct 2025: $2');
    expect(said.at(-1)).toBe('Jun 2026: $1');
    expect(said).toHaveLength(9);
  });

  test('the table assistive technology reads is hidden inside a block, so its rows cannot stretch the page', () => {
    const days = Array.from({ length: 40 }, (_, i) => ({ key: `2026-08-${String((i % 28) + 1).padStart(2, '0')}`, value: i }));
    const { container } = render(<BarChart rows={days} say={money} wide={600} />);
    const table = container.querySelector('table.chart-data')!;
    expect(table.classList.contains('visually-hidden')).toBe(false);
    expect(table.parentElement!.tagName).toBe('DIV');
    expect(table.parentElement!.classList.contains('visually-hidden')).toBe(true);
  });

  test('the pointer names another bar, and leaving gives the current one back', () => {
    const { container } = render(<BarChart rows={months} say={money} wide={600} />);
    const svg = screen.getByRole('img');
    svg.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 200,
      right: 600,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const first = Number(container.querySelector('.chart-bar')!.getAttribute('x'));
    fireEvent.pointerMove(svg, { clientX: first + 2 });
    expect(container.querySelector('.chart-bar.is-active title')).toHaveTextContent('Jan 2026: $10');
    expect(container.querySelector('.chart-bar-tip text')).toHaveTextContent('Jan 2026 · $10');
    fireEvent.pointerLeave(svg);
    expect(container.querySelector('.chart-bar-tip text')).toHaveTextContent('Apr 2026 · $20');
  });

  test('categories keep the order they are given and are named in the reader’s words', () => {
    const { container } = render(
      <BarChart
        rows={[
          { key: 'won', value: 3 },
          { key: 'lost', value: 5 },
        ]}
        label={(key) => `Stage ${String(key)}`}
        wide={600}
      />,
    );
    expect([...container.querySelectorAll('.chart-x-tick')].map((tick) => tick.textContent)).toEqual(['Stage won', 'Stage lost']);
  });

  test('over categories no bar is the one in hand: none is inked at rest, and the pointer names one', () => {
    const { container } = render(
      <BarChart
        rows={[
          { key: 'prospecting', value: 3 },
          { key: 'negotiation', value: 5 },
        ]}
        wide={600}
      />,
    );
    expect(container.querySelectorAll('.chart-bar.is-active, .chart-x-tick.is-active')).toHaveLength(0);
    expect(container.querySelector('.chart-bar-tip')).toBeNull();
    expect(container.querySelector('.chart-bar-guide')).toBeNull();
    const svg = screen.getByRole('img');
    svg.getBoundingClientRect = () => ({
      left: 0,
      top: 0,
      width: 600,
      height: 200,
      right: 600,
      bottom: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const first = Number(container.querySelector('.chart-bar')!.getAttribute('x'));
    fireEvent.pointerMove(svg, { clientX: first + 2 });
    expect(container.querySelector('.chart-bar-tip text')).toHaveTextContent('prospecting · 3');
    expect(container.querySelector('.chart-bar-guide')).not.toBeNull();
    fireEvent.pointerLeave(svg);
    expect(container.querySelector('.chart-bar-tip')).toBeNull();
  });

  test('a target is ruled across the bars and kept in view', () => {
    const { container } = render(<BarChart rows={months} say={money} target={50} wide={600} />);
    expect(container.querySelector('.chart-target-label')).toHaveTextContent('Target $50');
    // The scale is ruled at round levels, the highest at or over the target ($0 / $20 / $40 / $60).
    const ticks = [...container.querySelectorAll('.chart-y-tick')].map((tick) => Number(tick.textContent!.replace(/[$,]/g, '')));
    expect(Math.max(...ticks)).toBeGreaterThanOrEqual(50);
  });

  test('nothing to draw says so', () => {
    render(<BarChart rows={[]} />);
    expect(screen.getByText('Nothing to draw.')).toBeInTheDocument();
  });
});

describe('the line', () => {
  test('puts the months a breakdown left out back at zero, and labels the gridlines in the caller’s words', () => {
    const { container } = render(
      <LineChart
        rows={[
          { key: '2026-01', value: 10 },
          { key: '2026-03', value: 30 },
        ]}
        say={money}
      />,
    );
    const dots = container.querySelectorAll('.chart-dot title');
    expect([...dots].map((t) => t.textContent)).toEqual(['Jan 2026: $10', 'Feb 2026: $0', 'Mar 2026: $30']);
    expect([...container.querySelectorAll('.chart-tick')].map((t) => t.textContent)).toContain('$20');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '3 points, from $10 to $30; peak $30');
  });

  test('a crosshair follows the pointer and leaves with it', () => {
    const { container } = render(
      <LineChart
        rows={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]}
        say={money}
      />,
    );
    const cursor = container.querySelector('.chart-cursor')!;
    expect(cursor).toHaveAttribute('hidden');
    fireEvent.pointerMove(screen.getByRole('img'), { clientX: 0 });
    expect(cursor).not.toHaveAttribute('hidden');
    expect(cursor.querySelector('.chart-cursor-text')).toHaveTextContent('a · $1');
    fireEvent.pointerLeave(screen.getByRole('img'));
    expect(cursor).toHaveAttribute('hidden');
  });

  test('a point itself drills, by click and by keyboard, and the figure holding buttons is a group', async () => {
    const user = userEvent.setup();
    const picked: unknown[] = [];
    const { container } = render(
      <LineChart
        rows={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]}
        say={money}
        onPick={(v) => picked.push(v)}
      />,
    );
    const points = screen.getAllByRole('button', { name: /: \$/ });
    expect(points).toHaveLength(2);
    await user.click(points[1]);
    expect(picked).toEqual(['b']);
    fireEvent.keyDown(points[0], { key: 'Enter' });
    expect(picked).toEqual(['b', 'a']);
    fireEvent.keyDown(points[0], { key: ' ' });
    expect(picked).toEqual(['b', 'a', 'a']);
    /* The figure holding buttons is a group, not an image: a button
       inside role="img" fails axe's nested-interactive, as a donut's does. */
    expect(container.querySelector('.chart-line')).toHaveAttribute('role', 'group');
  });

  test('a line chart keeps one tab stop across its drillable points, roving with the arrows', () => {
    const picked: unknown[] = [];
    render(
      <LineChart
        rows={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
          { key: 'c', value: 3 },
        ]}
        say={money}
        onPick={(v) => picked.push(v)}
      />,
    );
    const points = screen.getAllByRole('button', { name: /: \$/ });
    expect(points).toHaveLength(3);
    /* One tab stop for the line: the first drillable point, the rest -1. */
    expect(points.map((p) => p.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    fireEvent.keyDown(points[0], { key: 'ArrowRight' });
    expect(points.map((p) => p.getAttribute('tabindex'))).toEqual(['-1', '0', '-1']);
    fireEvent.keyDown(points[1], { key: 'End' });
    expect(points.map((p) => p.getAttribute('tabindex'))).toEqual(['-1', '-1', '0']);
    fireEvent.keyDown(points[2], { key: 'Home' });
    expect(points.map((p) => p.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
    /* The roved-to point still drills. */
    fireEvent.keyDown(points[0], { key: 'Enter' });
    expect(picked).toEqual(['a']);
  });

  test('a line with nothing to drill stays an image, and a gap-filled bucket is no door', () => {
    const picked: unknown[] = [];
    const { container } = render(
      <LineChart
        rows={[
          { key: '2026-01', value: 10 },
          { key: '2026-03', value: 30 },
        ]}
        say={money}
        onPick={(v) => picked.push(v)}
      />,
    );
    /* Jan and Mar drill; the Feb bucket fillGaps invented holds no raw key. */
    expect(screen.getAllByRole('button', { name: /: \$/ })).toHaveLength(2);
    expect(container.querySelector('.chart-line')).toHaveAttribute('role', 'group');
    const { container: plain } = render(
      <LineChart
        rows={[
          { key: 'a', value: 1 },
          { key: 'b', value: 2 },
        ]}
        say={money}
      />,
    );
    expect(plain.querySelector('.chart-line')).toHaveAttribute('role', 'img');
    expect(picked).toEqual([]);
  });

  test('one point is not a line', () => {
    render(<LineChart rows={[{ key: 'a', value: 1 }]} />);
    expect(screen.getByText('Not enough points to draw a line.')).toBeInTheDocument();
  });

  test('narrow charts retain readable height and reduce date ticks while keeping the endpoints', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ({ key: `2026-${String(i + 1).padStart(2, '0')}`, value: i }));
    const { container, rerender } = render(<LineChart rows={rows} wide={600} />);
    const count = container.querySelectorAll('.chart-x-tick').length;
    rerender(<LineChart rows={rows} wide={240} />);
    expect(screen.getByRole('img')).toHaveAttribute('viewBox', '0 0 240 120');
    const ticks = [...container.querySelectorAll('.chart-x-tick')];
    expect(ticks.length).toBeLessThan(count);
    expect(ticks[0]).toHaveTextContent('Jan 2026');
    expect(ticks.at(-1)).toHaveTextContent(/^Dec$/);
    // The final tick is inward-aligned; its neighbour needs more than a half-label of room.
    for (let i = 1; i < ticks.length; i++) {
      expect(Number(ticks[i].getAttribute('x')) - Number(ticks[i - 1].getAttribute('x'))).toBeGreaterThan(60);
    }
  });
});

describe('a line with too little to join', () => {
  const two = [
    { key: '2026-10-10', value: 4 },
    { key: '2026-10-12', value: 6 },
  ];

  test('keeps its shape and stands its points alone: no stroke, no fill, solid where the bucket holds something', () => {
    const { container } = render(<LineChart rows={two} say={money} dots />);
    expect(container.querySelector('svg.chart-line')).not.toBeNull();
    expect(container.querySelector('.chart-stroke')).toBeNull();
    expect(container.querySelector('.chart-area')).toBeNull();
    const dots = [...container.querySelectorAll('.chart-dot')];
    // The day between them is a real zero: still a point, drawn hollow.
    expect(dots.map((d) => d.classList.contains('chart-dot-solid'))).toEqual([true, false, true]);
    // Every point is still a row assistive technology reads.
    expect(container.querySelectorAll('.chart-data tr')).toHaveLength(3);
  });

  test('one point is drawn, in the middle, where a line would say there is not enough to draw', () => {
    const one = [{ key: '2026-10-10', value: 4 }];
    const { container, rerender } = render(<LineChart rows={one} say={money} wide={600} dots />);
    expect(container.querySelectorAll('.chart-dot')).toHaveLength(1);
    rerender(<LineChart rows={one} say={money} wide={600} />);
    expect(container.querySelector('.chart-dot')).toBeNull();
    expect(container.textContent).toContain('Not enough points');
  });

  test('a line that has enough is still a line', () => {
    const { container } = render(<LineChart rows={two} say={money} />);
    expect(container.querySelector('.chart-stroke')).not.toBeNull();
    expect(container.querySelector('.chart-dot-solid')).toBeNull();
  });
});

describe('the levels', () => {
  test('are said on one side, in a gutter left of the line, whatever the line does', () => {
    const { container } = render(
      <LineChart
        rows={[
          { key: 'a', value: 2 },
          { key: 'b', value: 4 },
          { key: 'c', value: 9 },
        ]}
      />,
    );
    const levels = [...container.querySelectorAll('.chart-y-tick')];
    // Round levels over the figures, never the figures' own min/mid/max ("4.5").
    expect(levels.map((t) => t.textContent)).toEqual(['0', '5', '10']);
    const firstDot = Number(container.querySelector('.chart-dot')!.getAttribute('cx'));
    for (const level of levels) {
      expect(level.getAttribute('text-anchor')).toBe('end');
      expect(Number(level.getAttribute('x'))).toBeLessThan(firstDot);
    }
  });

  test('every point is a row of a table assistive technology can read', () => {
    render(
      <LineChart
        rows={[
          { key: '2026-01', value: 10 },
          { key: '2026-02', value: 30 },
        ]}
        say={money}
      />,
    );
    const table = screen.getByRole('table');
    expect(table.parentElement).toHaveClass('visually-hidden');
    expect(
      within(table)
        .getAllByRole('row')
        .map((row) => row.textContent),
    ).toEqual(['Jan 2026$10', 'Feb 2026$30']);
  });
});

describe('the months on the axis', () => {
  test('are budgeted at what they say, so a month with room is not dropped for a year it would not show', () => {
    const keys = [
      '2025-09',
      '2025-10',
      '2025-11',
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
    ];
    const at = (i: number) => 40 + i * 105;
    expect(axisMarks(keys, at).map((mark) => mark.text)).toEqual([
      'Sep 2025',
      'Oct',
      'Nov',
      'Dec',
      'Jan 2026',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
    ]);
    const narrow = axisMarks(keys, (i) => 30 + i * 28);
    expect(narrow[0]).toEqual({ index: 0, text: 'Sep 2025' });
    expect(narrow.at(-1)!.index).toBe(11);
    expect(narrow.length).toBeLessThan(keys.length);
  });

  test('under bars are budgeted centred, as drawn, and a clash further in tries a longer stride rather than naming only the ends', () => {
    // Seven months under a half-width card's bars: 26px apart, centred under each bar.
    const keys = ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09'];
    const at = (i: number) => 90 + i * 26;
    const bars = axisMarks(keys, at, { centered: true });
    expect(bars.length).toBeGreaterThan(2);
    expect(bars[0]).toEqual({ index: 0, text: 'Mar 2026' });
    expect(bars.at(-1)!.index).toBe(6);
    // No two named months overlap or crowd, measured where each is drawn.
    const width = (text: string) => text.length * 6.6 + 4;
    for (let k = 1; k < bars.length; k++) {
      expect(at(bars[k].index) - width(bars[k].text) / 2 - (at(bars[k - 1].index) + width(bars[k - 1].text) / 2)).toBeGreaterThanOrEqual(
        12,
      );
    }
  });
});

describe('a month on the axis', () => {
  test('is its short name, with the year on the first tick and wherever the year turns', () => {
    const rows = ['2025-11', '2025-12', '2026-01', '2026-02'].map((key, i) => ({ key, value: i + 1 }));
    const { container } = render(<LineChart rows={rows} wide={900} />);
    expect([...container.querySelectorAll('.chart-x-tick')].map((t) => t.textContent)).toEqual(['Nov 2025', 'Dec', 'Jan 2026', 'Feb']);
    expect(container.querySelector('.chart-x-tick')!.textContent).not.toMatch(/\d{4}-\d{2}/);
  });

  test('is said in the App’s locale, and a key that is not a month is said as it came', () => {
    installShell({ format: () => ({ locale: 'es-ES' }) });
    try {
      expect(periodTick('2026-03')).toMatch(/^mar/i);
      expect(periodTick('2026-03')).toMatch(/2026/);
      expect(periodTick('2026-04', '2026-03')).not.toMatch(/2026/);
    } finally {
      installShell({ format: () => null });
    }
    expect(periodTick('2026-Q3')).toBe('2026-Q3');
    expect(periodTick('Vacation')).toBe('Vacation');
  });
});

describe('a day on the axis', () => {
  test('says the date, with its year where the year starts or turns', () => {
    installShell({ format: () => ({ locale: 'en-US' }) });
    try {
      expect(periodTick('2026-09-10')).toBe('Sep 10, 2026');
      expect(periodTick('2026-09-11', '2026-09-10')).toBe('Sep 11');
      expect(periodTick('2027-01-01', '2026-12-31')).toBe('Jan 1, 2027');
    } finally {
      installShell({ format: () => null });
    }
  });

  test('a week is said by its first day, "Oct 5", its year where the year starts', () => {
    installShell({ format: () => ({ locale: 'en-US' }) });
    try {
      const rows = ['2026-09-28', '2026-10-05', '2026-10-12'].map((key, i) => ({ key, value: i + 1 }));
      const { container } = render(<LineChart rows={rows} wide={900} />);
      expect([...container.querySelectorAll('.chart-x-tick')].map((t) => t.textContent)).toEqual(['Sep 28, 2026', 'Oct 5', 'Oct 12']);
    } finally {
      installShell({ format: () => null });
    }
  });
});

describe('the donut', () => {
  test('keeps each categorical slice and its legend swatch on the same theme token', () => {
    const { container } = render(
      <DonutChart
        rows={[
          { key: 'a', value: 3 },
          { key: 'b', value: 2 },
        ]}
      />,
    );
    const slices = [...container.querySelectorAll<SVGCircleElement>('.chart-slice')];
    const swatches = [...container.querySelectorAll<HTMLElement>('.chart-swatch')];
    for (let i = 0; i < slices.length; i++) {
      const token = `var(--chart-${i + 1}, var(--accent))`;
      expect(slices[i].style.stroke).toBe(token);
      expect(swatches[i].style.background).toBe(token);
      expect(slices[i].style.opacity).toBe(swatches[i].style.opacity);
      expect(slices[i].style.opacity).toContain('var(--chart-series-opacity,');
    }
  });

  test('gathers the tail into others, and only a named slice is a door', async () => {
    const user = userEvent.setup();
    const picked: unknown[] = [];
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key, i) => ({ key, value: 8 - i }));
    const { container } = render(<DonutChart rows={rows} say={money} onPick={(v) => picked.push(v)} />);
    expect(container.querySelectorAll('.chart-slice')).toHaveLength(7);
    expect(container.querySelector('.chart-donut-total')).toHaveTextContent('$36');
    const items = screen.getAllByRole('listitem');
    expect(items[6]).toHaveTextContent('others (2)');
    expect(items[6].querySelector('button')).toBeNull();
    await user.click(container.querySelector('.chart-legend-drill')!);
    expect(picked).toEqual(['a']);
  });

  test('a slice itself drills, by click and by keyboard, and others stays a picture', async () => {
    const user = userEvent.setup();
    const picked: unknown[] = [];
    const rows = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((key, i) => ({ key, value: 8 - i }));
    const { container } = render(<DonutChart rows={rows} say={money} onPick={(v) => picked.push(v)} />);
    const slices = screen.getAllByRole('button', { name: /: \$/ });
    expect(slices).toHaveLength(6);
    await user.click(slices[1]);
    expect(picked).toEqual(['b']);
    fireEvent.keyDown(slices[0], { key: 'Enter' });
    expect(picked).toEqual(['b', 'a']);
    expect(container.querySelectorAll('.chart-slice')).toHaveLength(7);
    expect(container.querySelectorAll('.chart-slice-drill')).toHaveLength(6);
    /* The figure holding buttons is a group, not an image: a button
       inside role="img" fails axe's nested-interactive. */
    expect(container.querySelector('.chart-donut')).toHaveAttribute('role', 'group');
  });

  test('a donut with nothing to drill stays an image', () => {
    const { container } = render(
      <DonutChart
        rows={[
          { key: 'a', value: 30 },
          { key: 'b', value: 10 },
        ]}
        say={money}
      />,
    );
    expect(container.querySelector('.chart-donut')).toHaveAttribute('role', 'img');
  });

  test('a total label sits under the summed figure, and the legend says each share', () => {
    const { container } = render(
      <DonutChart
        rows={[
          { key: 'a', value: 30 },
          { key: 'b', value: 10 },
        ]}
        total="Total visitors"
      />,
    );
    expect(container.querySelector('.chart-donut-total')).toHaveTextContent('40');
    expect(container.querySelector('.chart-donut-caption')).toHaveTextContent('Total visitors');
    expect([...container.querySelectorAll('.chart-legend-share')].map((n) => n.textContent)).toEqual(['75%', '25%']);
  });

  test('nothing positive is nothing to divide', () => {
    render(<DonutChart rows={[{ key: 'a', value: 0 }]} />);
    expect(screen.getByText('Nothing to divide.')).toBeInTheDocument();
  });
});

describe('a target', () => {
  test('a line keeps its target in view as a rule, and says it', () => {
    const { container } = render(
      <LineChart
        rows={[
          { key: 'a', value: 10 },
          { key: 'b', value: 20 },
        ]}
        say={money}
        target={50}
      />,
    );
    expect(container.querySelector('.chart-target-label')).toHaveTextContent('Target $50');
    const rule = container.querySelector('.chart-target-line')!;
    // The target is inside the scale, over the line's highest point.
    const peak = Math.min(...[...container.querySelectorAll('.chart-dot')].map((dot) => Number(dot.getAttribute('cy'))));
    expect(Number(rule.getAttribute('y1'))).toBeGreaterThanOrEqual(14);
    expect(Number(rule.getAttribute('y1'))).toBeLessThan(peak);
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '2 points, from $10 to $20; peak $20; target $50');
  });
});

describe('stacked bars', () => {
  const rows = [
    { key: 'north', series: 'won', value: 6 },
    { key: 'north', series: 'lost', value: 2 },
    { key: 'south', series: 'won', value: 1 },
    { key: 'south', series: 'lost', value: 3 },
    { key: 'south', series: 'open', value: 4 },
    { key: 'east', series: 'won', value: 0 },
  ];

  test('each bar divides by the second key, longest first, one token per series in every bar and the legend', () => {
    const { container } = render(<StackedBars rows={rows} say={money} />);
    const bars = [...container.querySelectorAll('.chart-stacked-row')];
    expect(bars.map((bar) => bar.querySelector('.chart-stacked-label')?.textContent)).toEqual(['north', 'south']);
    expect(bars.map((bar) => bar.querySelector('.chart-stacked-total')?.textContent)).toEqual(['$8', '$8']);
    const legend = [...container.querySelectorAll('.chart-stacked-legend li')];
    expect(legend.map((item) => item.querySelector('.chart-legend-key')?.textContent)).toEqual(['won', 'lost', 'open']);
    const won = legend[0].querySelector<HTMLElement>('.chart-swatch')!.style.background;
    expect(won).toBe('var(--chart-1, var(--accent))');
    for (const bar of bars) expect(bar.querySelector<HTMLElement>('.chart-stacked-part')!.style.background).toBe(won);
    expect(bars[1].querySelectorAll('.chart-stacked-part')).toHaveLength(3);
    expect(bars[0]).toHaveTextContent('won $6, lost $2');
  });

  test('bars over days stand in time order, the latest ones kept, each said as a date', () => {
    const days = ['2026-09-10', '2026-09-14', '2026-08-27', '2026-09-02'].flatMap((key, i) => [
      { key, series: 'pick', value: 40 - i * 5 },
      { key, series: 'receipt', value: 2 },
    ]);
    installShell({ format: () => ({ locale: 'en-US' }) });
    try {
      const { container } = render(<StackedBars rows={days} limit={3} />);
      expect([...container.querySelectorAll('.chart-stacked-label')].map((label) => label.textContent)).toEqual([
        'Sep 2, 2026',
        'Sep 10',
        'Sep 14',
      ]);
    } finally {
      installShell({ format: () => null });
    }
  });

  test('a target past every bar sets the scale and is ruled across each track', () => {
    const { container } = render(<StackedBars rows={rows} say={money} target={16} />);
    expect(container.querySelector<HTMLElement>('.chart-stacked-fill')!.style.width).toBe('50.00%');
    expect([...container.querySelectorAll<HTMLElement>('.chart-stacked-target')].map((rule) => rule.style.left)).toEqual([
      '100.00%',
      '100.00%',
    ]);
    expect(container.querySelector('.chart-stacked-goal')).toHaveTextContent('Target$16');
  });

  test('the tail of the series is gathered into others, and only a named bar is a door', async () => {
    const user = userEvent.setup();
    const picked: unknown[] = [];
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map((series, i) => ({ key: 'north', series, value: 9 - i }));
    const { container } = render(<StackedBars rows={[...many, { key: null, series: 'a', value: 1 }]} onPick={(v) => picked.push(v)} />);
    const legend = [...container.querySelectorAll('.chart-stacked-legend .chart-legend-key')].map((key) => key.textContent);
    expect(legend).toHaveLength(8);
    expect(legend.at(-1)).toBe('others (2)');
    expect(container.querySelector('.chart-stacked-row')!.querySelectorAll('.chart-stacked-part')).toHaveLength(8);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    await user.click(screen.getByRole('button'));
    expect(picked).toEqual(['north']);
  });

  test('nothing positive is nothing to stack', () => {
    render(<StackedBars rows={[{ key: 'a', series: 'x', value: 0 }]} />);
    expect(screen.getByText('Nothing to stack.')).toBeInTheDocument();
  });
});

describe('the spark', () => {
  test('stretches a path across the card with a dot on the last point, or draws nothing under four points', () => {
    const rows = [
      { key: 'w1', value: 1 },
      { key: 'w2', value: 2 },
      { key: 'w3', value: 2 },
      { key: 'w4', value: 3 },
    ];
    const { container } = render(<Sparkline rows={rows} say={money} />);
    expect(container.querySelector('.spark')).toHaveAttribute('preserveAspectRatio', 'none');
    expect(container.querySelector('.spark-stroke')).toHaveAttribute(
      'd',
      expect.stringMatching(/^M1\.0,\d+\.\d( L[\d.]+,[\d.]+){2} L99\.0,3\.0$/),
    );
    expect(container.querySelector('.spark-dot')).toHaveAttribute('d', 'M99.0,3.0 h0');
    // The wash under the trend closes along the foot; a look chooses whether to show it.
    expect(container.querySelector('.spark-area')).toHaveAttribute('d', expect.stringMatching(/ L99\.0,28 L1\.0,28 Z$/));
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', 'trend: $1, $2, $2, $3');
    cleanup();
    const { container: short } = render(<Sparkline rows={rows.slice(0, 3)} />);
    expect(short.innerHTML).toBe('');
  });
});

describe('a line per series', () => {
  const months = ['2026-01', '2026-02', '2026-03'];
  const rows = months.flatMap((key, i) => [
    { key, series: 'web', value: 10 + i },
    { key, series: 'email', value: 5 },
    { key, series: 'ads', value: 1 + i },
  ]);

  test('draws a stroke and a legend entry for each, and the picker narrows to one', async () => {
    const { container } = render(<LineChart rows={rows} say={money} wide={600} />);
    expect(container.querySelectorAll('.chart-series-stroke')).toHaveLength(3);
    // Largest first when nothing says another order.
    expect([...container.querySelectorAll('.chart-multi-legend .chart-legend-key')].map((n) => n.textContent)).toEqual([
      'web',
      'email',
      'ads',
    ]);
    await userEvent.setup().selectOptions(container.querySelector('select.chart-series-pick') as HTMLSelectElement, 'email');
    expect(container.querySelectorAll('.chart-series-stroke')).toHaveLength(1);
    expect([...container.querySelectorAll('.chart-multi-legend .chart-legend-key')].map((n) => n.textContent)).toEqual(['email']);
  });

  test('three lines are named where they end, the key above hidden; more, or names too long for the width, keep it', () => {
    const { container } = render(<LineChart rows={rows} say={money} wide={600} />);
    expect([...container.querySelectorAll('.chart-end-name')].map((n) => n.textContent)).toEqual(['web', 'email', 'ads']);
    expect(container.querySelector('.chart-multi-legend')!.hasAttribute('hidden')).toBe(true);
    cleanup();
    const four = render(
      <LineChart rows={[...rows, ...months.map((key) => ({ key, series: 'print', value: 2 }))]} say={money} wide={600} />,
    );
    expect(four.container.querySelectorAll('.chart-end-name')).toHaveLength(0);
    expect(four.container.querySelector('.chart-multi-legend')!.hasAttribute('hidden')).toBe(false);
    cleanup();
    const long = rows.map((row) => ({ ...row, series: `${row.series} campaigns across every region` }));
    const narrow = render(<LineChart rows={long} say={money} wide={360} />);
    expect(narrow.container.querySelectorAll('.chart-end-name')).toHaveLength(0);
  });

  test('names at the ends are pushed apart where their lines end close together, and kept inside the plot', () => {
    expect(namesAtEnds([50, 52, 120], 10, 200)).toEqual([50, 64, 120]);
    expect(namesAtEnds([199, 200], 10, 200), 'the column moves up rather than past the bottom').toEqual([186, 200]);
    expect(namesAtEnds([30, 10], 10, 200)).toEqual([30, 10]);
  });

  test("a vocabulary sets the legend's order and each line's color", () => {
    const { container } = render(<LineChart rows={rows} say={money} wide={600} seriesVocabulary={['ads', 'email', 'web']} />);
    expect([...container.querySelectorAll('.chart-multi-legend .chart-legend-key')].map((n) => n.textContent)).toEqual([
      'ads',
      'email',
      'web',
    ]);
    const strokes = [...container.querySelectorAll<SVGPathElement>('.chart-series-stroke')];
    expect(strokes.map((path) => path.style.stroke)).toEqual([
      'var(--chart-1, var(--accent))',
      'var(--chart-2, var(--accent))',
      'var(--chart-3, var(--accent))',
    ]);
  });
});

describe('a smooth line', () => {
  const rows = [
    { key: '2026-01', value: 1 },
    { key: '2026-02', value: 5 },
    { key: '2026-03', value: 2 },
    { key: '2026-04', value: 8 },
  ];
  test('is drawn with cubic segments, and a straight one with none', () => {
    const smooth = render(<LineChart rows={rows} say={money} wide={600} smooth />);
    expect(smooth.container.querySelector('.chart-stroke')!.getAttribute('d')).toContain('C');
    cleanup();
    const straight = render(<LineChart rows={rows} say={money} wide={600} />);
    expect(straight.container.querySelector('.chart-stroke')!.getAttribute('d')).not.toContain('C');
  });
});

describe('categories that carry a tone (a state)', () => {
  const states = [
    { key: 'open', value: 5 },
    { key: 'on_hold', value: 3 },
    { key: 'closed', value: 2 },
  ];
  const tones: Record<string, string> = { open: 'info', on_hold: 'warn', closed: 'neutral' };

  test("bars wear the ink their state's dot wears, and keep the look's hue where a category has no tone", () => {
    const { container } = render(<BarChart rows={states} wide={600} tone={(key) => tones[String(key)]} />);
    const bars = [...container.querySelectorAll<SVGRectElement>('.chart-bar')];
    expect(bars.map((bar) => bar.classList.contains('is-toned'))).toEqual([true, true, true]);
    expect(bars.map((bar) => bar.style.getPropertyValue('--bar-ink'))).toEqual([
      'var(--status-info)',
      'var(--status-warning)',
      'var(--ink-subtle)',
    ]);
    cleanup();
    const partial = render(<BarChart rows={states} wide={600} tone={(key) => (key === 'open' ? 'info' : undefined)} />);
    expect(partial.container.querySelector('.is-toned')).toBeNull();
  });

  test('a donut wears tones only where every slice has its own', () => {
    const { container } = render(<DonutChart rows={states} tone={(key) => tones[String(key)]} />);
    expect([...container.querySelectorAll<SVGCircleElement>('.chart-slice')].map((slice) => slice.style.stroke)).toEqual([
      'var(--status-info)',
      'var(--status-warning)',
      'var(--ink-subtle)',
    ]);
    cleanup();
    const shared = render(<DonutChart rows={states} tone={() => 'info'} />);
    expect(shared.container.querySelector<SVGCircleElement>('.chart-slice')!.style.stroke).toBe('var(--chart-1, var(--accent))');
  });
});
