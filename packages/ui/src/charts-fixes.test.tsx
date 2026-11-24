/** What went wrong in the charts once, each held by the case that shows it. */
import { cleanup, fireEvent, render } from '@testing-library/react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarChart, BreakdownList, DonutChart, FunnelChart, LineChart, MiniBars, RadialGauge, Sparkline } from './charts.js';
import { pickAxisLabels } from './charts/chartShared.js';
import { UiSurfaceSeamContext } from './internal/surfaceSeam.js';

/* Unmounted after each case: a gauge left drawn still owes a frame, and React ran it after the file's window was gone. */
afterEach(cleanup);

const tableRows = (container: HTMLElement) =>
  [...container.querySelectorAll('table.chart-data tbody tr')].map((tr) => [...tr.children].map((cell) => cell.textContent));

describe('MiniBars, signed', () => {
  it('places every bar from the zero line in shares of the height, with no width-relative margin', () => {
    const { container } = render(<MiniBars data={[-5, 0, 10, -3, 8]} />);
    const bars = [...container.querySelectorAll<HTMLElement>('.kit-minibars-bars > i')];
    expect(bars).toHaveLength(5);
    /* -5..10 puts zero a third of the way up: two thirds from the top. */
    const zeroTop = (10 / 15) * 100;
    for (const bar of bars) {
      expect(bar.style.marginTop).toBe('');
      expect(bar.style.marginBottom).toBe('');
      const top = parseFloat(bar.style.top);
      const height = parseFloat(bar.style.height);
      expect(top).toBeGreaterThanOrEqual(0);
      expect(top + height).toBeLessThanOrEqual(100.001);
      /* One edge of each bar is the zero line. */
      expect(Math.min(Math.abs(top - zeroTop), Math.abs(top + height - zeroTop))).toBeLessThan(0.01);
    }
    expect(parseFloat(bars[2]!.style.top)).toBeCloseTo(0);
    expect(parseFloat(bars[0]!.style.top)).toBeCloseTo(zeroTop);
  });
});

describe('axis labels', () => {
  const dates = Array.from({ length: 16 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const along = (n: number, from: number, to: number) => (i: number) => from + (i / (n - 1)) * (to - from);
  const boxes = (labels: string[], xAt: (i: number) => number, lo: number, hi: number) =>
    pickAxisLabels(labels, xAt, lo, hi).map(({ index, anchor }) => {
      const w = labels[index]!.length * 7.2;
      const x = xAt(index);
      return anchor === 'start' ? [x, x + w] : anchor === 'end' ? [x - w, x] : [x - w / 2, x + w / 2];
    });

  it('thins sixteen dates evenly, keeps both ends, and lets none touch', () => {
    const picks = pickAxisLabels(dates, along(16, 46, 436), 38, 444);
    expect(picks.map((p) => p.index)).toEqual([0, 5, 10, 15]);
    const drawn = boxes(dates, along(16, 46, 436), 38, 444);
    for (let i = 1; i < drawn.length; i++) expect(drawn[i]![0]).toBeGreaterThan(drawn[i - 1]![1]!);
  });

  it('labels all six short categories when there is room', () => {
    const names = ['Wedding', 'Gala', 'Retreat', 'Launch', 'Summit', 'Party'];
    expect(pickAxisLabels(names, along(6, 46, 436), 38, 444).map((p) => p.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('still names the first and last point on a phone-width plot', () => {
    const picks = pickAxisLabels(dates, along(16, 46, 286), 38, 294).map((p) => p.index);
    expect(picks[0]).toBe(0);
    expect(picks.at(-1)).toBe(15);
  });

  it('draws the chosen labels, not a fixed stride', () => {
    const names = ['Wedding', 'Gala', 'Retreat', 'Launch', 'Summit', 'Party'];
    const { container } = render(<LineChart data={names.map((x, i) => ({ x, n: i }))} xKey="x" series={[{ key: 'n', label: 'N' }]} />);
    const texts = [...container.querySelectorAll('svg text')].map((t) => t.textContent);
    for (const name of names) expect(texts).toContain(name);
  });
});

describe('Sparkline with one reading', () => {
  it('draws a centred dot on a short flat stroke inside the box', () => {
    const { container } = render(<Sparkline data={[7]} width={96} height={28} />);
    const dot = container.querySelector('circle')!;
    expect(dot.getAttribute('cx')).toBe('48');
    expect(dot.getAttribute('cy')).toBe('14');
    const d = container.querySelector('path')!.getAttribute('d')!;
    const [, x1, y1, x2, y2] = d.match(/^M ([\d.]+) ([\d.]+) L ([\d.]+) ([\d.]+)$/)!.map(Number);
    expect(y1).toBe(14);
    expect(y2).toBe(14);
    expect((x1! + x2!) / 2).toBe(48);
    expect(x1).toBeGreaterThan(0);
    expect(x2).toBeLessThan(96);
  });
});

describe('DonutChart', () => {
  const data = [
    { label: 'Completed', value: 42 },
    { label: 'Scheduled', value: 18 },
    { label: 'Negative adjustment', value: -5 },
  ];

  it('backs the ring with a hidden table when the legend is off', () => {
    const { container } = render(<DonutChart data={data} showLegend={false} />);
    expect(container.querySelector('.nx-donut-legend')).toBeNull();
    expect(tableRows(container)).toEqual([
      ['Completed', '42', '70%'],
      ['Scheduled', '18', '30%'],
      ['Negative adjustment', '-5', '—'],
    ]);
  });

  it('says in the description that a negative was left out, and nothing when none was', () => {
    const { container } = render(<DonutChart data={data} />);
    const svg = container.querySelector('svg')!;
    const note = container.ownerDocument.getElementById(svg.getAttribute('aria-describedby')!)!;
    expect(note.textContent).toBe('1 negative value is not drawn.');
    const clean = render(<DonutChart data={data.slice(0, 2)} />);
    expect(clean.container.querySelector('svg')!.hasAttribute('aria-describedby')).toBe(false);
  });

  it('draws a one-line-a-segment legend, not a meter list, and takes its words', () => {
    const { container } = render(
      <DonutChart data={data} showLegend words={{ segment: 'Teil', value: 'Wert', share: 'Anteil', notDrawn: (n) => `${n} fehlt` }} />,
    );
    expect(container.querySelector('.nx-breakdown-list')).toBeNull();
    expect(container.querySelector('[role="meter"]')).toBeNull();
    const rows = [...container.querySelectorAll('.nx-donut-legend-row')].map((row) => row.textContent);
    expect(rows).toEqual(['Completed4270%', 'Scheduled1830%', 'Negative adjustment-5—']);
    expect([...container.querySelectorAll('table.chart-data thead th')].map((th) => th.textContent)).toEqual(['Teil', 'Wert', 'Anteil']);
    expect(container.textContent).toContain('1 fehlt');
  });
});

describe('BreakdownList string values', () => {
  const count = (container: HTMLElement) => [...container.querySelectorAll('.nx-breakdown-count')].map((n) => n.textContent);

  it('sends a string through formatValue, say and the host preset as it would the number', () => {
    const viaFormat = render(<BreakdownList items={[{ label: 'A', value: '45' }]} formatValue={(v) => `${v} units`} />);
    expect(count(viaFormat.container)).toEqual(['45 units']);
    const Legacy = BreakdownList as unknown as (props: Record<string, unknown>) => React.ReactNode;
    const viaSay = render(<Legacy items={[{ label: 'A', value: '45' }]} say={(v: number) => `said ${v}`} />);
    expect(count(viaSay.container)).toEqual(['said 45']);
    const viaSeam = render(
      <UiSurfaceSeamContext.Provider value={{ formatPreset: (v, preset) => `${preset}:${v}` }}>
        <BreakdownList items={[{ label: 'A', value: '45' }]} format="money" />
      </UiSurfaceSeamContext.Provider>,
    );
    expect(count(viaSeam.container)).toEqual(['money:45']);
  });

  it('prints percent with its sign and money in the given currency', () => {
    const pct = render(<BreakdownList items={[{ label: 'A', value: '45.5' }]} format="percent" locale="en-US" />);
    expect(count(pct.container)).toEqual(['45.5%']);
    const eur = render(<BreakdownList items={[{ label: 'A', value: 1200 }]} format="money" currency="EUR" locale="en-US" />);
    expect(count(eur.container)).toEqual(['€1,200']);
  });

  it('keeps every digit of a count past 2^53, in the preset and the currency', () => {
    const big = '9007199254740993';
    const plain = render(<BreakdownList items={[{ label: 'A', value: big }]} locale="en-US" />);
    expect(count(plain.container)).toEqual(['9,007,199,254,740,993']);
    const pct = render(<BreakdownList items={[{ label: 'A', value: big }]} format="percent" locale="en-US" />);
    expect(count(pct.container)).toEqual(['9,007,199,254,740,993%']);
    const eur = render(<BreakdownList items={[{ label: 'A', value: big }]} format="money" currency="EUR" locale="en-US" />);
    expect(count(eur.container)).toEqual(['€9,007,199,254,740,993']);
  });
});

describe('cartesian charts', () => {
  const series = [{ key: 'n', label: 'Load' }];

  it('breaks the line at a missing point and says so in the table', () => {
    const data = [
      { x: 'a', n: 1 },
      { x: 'b', n: 2 },
      { x: 'c', n: null },
      { x: 'd', n: 4 },
      { x: 'e', n: 5 },
    ] as unknown as Array<Record<string, number | string>>;
    const { container } = render(<LineChart data={data} xKey="x" series={series} curve="linear" />);
    const strokes = [...container.querySelectorAll('svg path[stroke]')];
    expect(strokes).toHaveLength(2);
    for (const stroke of strokes) expect(stroke.getAttribute('d')!.match(/[ML]/g)).toHaveLength(2);
    expect(tableRows(container)[2]).toEqual(['c', 'No data']);
    expect(tableRows(container)[0]).toEqual(['a', '1']);
  });

  it('skips the bar for a missing value and names it in the table with the given word', () => {
    const data = [{ x: 'a', n: 3 }, { x: 'b', n: Number.NaN }, { x: 'c' }] as Array<Record<string, number | string>>;
    const { container } = render(<BarChart data={data} xKey="x" series={series} missingLabel="keine Daten" />);
    expect(container.querySelectorAll('svg path[fill]')).toHaveLength(1);
    expect(tableRows(container)).toEqual([
      ['a', '3'],
      ['b', 'keine Daten'],
      ['c', 'keine Daten'],
    ]);
  });

  it('plots a string past 2^53 and prints its digits exactly', () => {
    const { container } = render(<BarChart data={[{ x: 'a', n: '9007199254740993' }]} xKey="x" series={series} locale="en-US" />);
    expect(container.querySelectorAll('svg path[fill]')).toHaveLength(1);
    expect(tableRows(container)).toEqual([['a', '9,007,199,254,740,993']]);
  });

  it('draws a series too long to spread into Math.min', () => {
    const long = Array.from({ length: 300_000 }, (_, i) => i % 97);
    expect(() => render(<Sparkline data={long} curve="linear" />)).not.toThrow();
  });

  it('steps the readout by keyboard and announces the point', () => {
    const data = [
      { x: 'Mon', n: 1 },
      { x: 'Tue', n: 2 },
      { x: 'Wed', n: 3 },
    ];
    for (const Chart of [LineChart, BarChart]) {
      const { container, unmount } = render(<Chart data={data} xKey="x" series={series} ariaLabel="Load by day" />);
      const svg = container.querySelector('svg')!;
      expect(svg.getAttribute('tabindex')).toBe('0');
      const title = () => container.querySelector('.nx-chart-tooltip-title')?.textContent;
      expect(title()).toBeUndefined();
      fireEvent.focus(svg);
      expect(title()).toBe('Mon');
      fireEvent.keyDown(svg, { key: 'ArrowRight' });
      expect(title()).toBe('Tue');
      expect(container.querySelector('[aria-live]')!.textContent).toBe('Tue: Load 2');
      fireEvent.keyDown(svg, { key: 'End' });
      expect(title()).toBe('Wed');
      fireEvent.keyDown(svg, { key: 'ArrowRight' });
      expect(title()).toBe('Wed');
      fireEvent.keyDown(svg, { key: 'Home' });
      expect(title()).toBe('Mon');
      fireEvent.keyDown(svg, { key: 'Escape' });
      expect(title()).toBeUndefined();
      unmount();
    }
  });

  it('names the picture once, on an element with a role', () => {
    for (const Chart of [LineChart, BarChart]) {
      const { container, unmount } = render(<Chart data={[{ x: 'a', n: 1 }]} xKey="x" series={series} ariaLabel="Load by day" />);
      const named = [...container.querySelectorAll('[aria-label="Load by day"]')];
      expect(named).toHaveLength(1);
      expect(named[0]!.getAttribute('role')).toBe('img');
      unmount();
    }
  });
});

describe('RadialGauge', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('renders the same first markup whatever the motion preference, so hydration agrees with the server', () => {
    const server = renderToString(<RadialGauge value={50} />);
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('reduce'),
      addEventListener() {},
      removeEventListener() {},
    }));
    expect(renderToString(<RadialGauge value={50} />)).toBe(server);
  });

  it('adds the percent sign only on the default range with no formatter', () => {
    const value = (ui: React.ReactElement) => render(ui).container.querySelector('.nx-radial-gauge-value')!.textContent;
    expect(value(<RadialGauge value={42} />)).toBe('42%');
    expect(value(<RadialGauge value={42} formatValue={(v) => `${v} pts`} />)).toBe('42 pts');
    expect(value(<RadialGauge value={42} max={200} />)).toBe('42');
  });
});

describe('FunnelChart', () => {
  it('takes the heads of its table as words', () => {
    const stages = [
      { label: 'Sent', value: 10 },
      { label: 'Opened', value: 5 },
    ];
    const heads = (ui: React.ReactElement) =>
      [...render(ui).container.querySelectorAll('table.chart-data thead th')].map((th) => th.textContent);
    expect(heads(<FunnelChart stages={stages} />)).toEqual(['Stage', 'Value', 'Overall']);
    expect(heads(<FunnelChart stages={stages} words={{ stage: 'Étape', value: 'Valeur', overall: 'Total' }} />)).toEqual([
      'Étape',
      'Valeur',
      'Total',
    ]);
  });
});

describe('a chart says what its marks are, and its value axis has room for its labels', () => {
  const valueTicks = (host: ParentNode) =>
    [...host.querySelectorAll('text.nx-chart-axis-text')].filter((text) => text.getAttribute('text-anchor') === 'end');
  const money = (v: number) => `$${v.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  const rows = [
    { month: 'Jan', revenue: 4000 },
    { month: 'Feb', revenue: 12000 },
  ];
  const series = [{ key: 'revenue', label: 'Revenue' }];

  it('draws the donut legend by default, as every other chart does, and leaves it out when asked', () => {
    const data = [
      { label: 'Completed', value: 42 },
      { label: 'Scheduled', value: 18 },
    ];
    expect(render(<DonutChart data={data} />).container.querySelectorAll('.nx-donut-legend-row')).toHaveLength(2);
    expect(render(<DonutChart data={data} showLegend={false} />).container.querySelector('.nx-donut-legend')).toBeNull();
  });

  it.each([
    ['LineChart', <LineChart key="l" data={rows} xKey="month" series={series} formatValue={money} />],
    ['BarChart', <BarChart key="b" data={rows} xKey="month" series={series} formatValue={money} />],
  ])('%s widens its left gutter to the widest formatted tick, so money is not cut on the left', (_name, chart) => {
    const ticks = valueTicks(render(chart).container);
    const widest = ticks.reduce((most, text) => Math.max(most, text.textContent!.length), 0);
    expect(ticks.map((text) => text.textContent)).toContain('$12,000.00');
    // A label ends at its x and runs left about 7.2px a character: its start has to be inside the drawing.
    for (const text of ticks) expect(Number(text.getAttribute('x')) - widest * 7.2).toBeGreaterThanOrEqual(0);
  });

  it('keeps the old gutter for short labels, and says a tick too wide for the cap in the compact form', () => {
    const short = render(<LineChart data={rows} xKey="month" series={series} />);
    expect(valueTicks(short.container)[0]!.getAttribute('x')).toBe('38');

    const long = (v: number) => `${money(v)} USD`;
    const said = valueTicks(render(<LineChart data={rows} xKey="month" series={series} formatValue={long} />).container).map(
      (text) => text.textContent,
    );
    expect(said).toContain('$12K USD');
    for (const label of said) expect(label!.length * 7.2 + 10).toBeLessThanOrEqual(88);
  });
});
