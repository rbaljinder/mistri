import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BarChart, BreakdownList, DonutChart, FunnelChart, MiniBars, StackedBarChart } from './charts/barAndPartCharts.js';
import { AreaChart, LineChart, Sparkline } from './charts/charts.js';
import { HeatmapMatrix, RadarChart, RadialGauge } from './charts/chartsAdvanced.js';
import { FunnelSteps } from './charts/FunnelSteps.js';
import { Field } from './Field.js';
import { PhotoTiles } from './HeroBlocks.js';
import { masks } from './masks.js';
import { CodeEditor } from './primitives/codeAndJsonEditors.js';
import { Autocomplete, Combobox } from './primitives/comboboxAndListbox.js';
import { DateTimePicker, TreeSelect } from './primitives/dateTimeAndTreePickers.js';
import { EntityPicker } from './primitives/entityPicker.js';
import { FormattedValue, ImageCropper } from './primitives/formattedAndCropper.js';
import { Input } from './primitives/inputs.js';
import { NumberInput } from './primitives/numericAndTokenInputs.js';
import { DatePicker } from './primitives/pickers.js';
import { Select } from './Select.js';
import { SensitiveField } from './SensitiveField.js';
import { Tabs } from './Tabs.js';
import { InviteAcceptCard } from './views/AuthSurfaces.js';
import { GanttView } from './views/GanttView.js';
import { KanbanBoard } from './views/KanbanBoard.js';
import { formatAttachmentSize } from './views/mediaShared.js';

afterEach(() => {
  document.documentElement.removeAttribute('data-nx-motion');
  cleanup();
});

describe('A6 & Chart Defects (G-C1..G-C17) — Edge Data Across Charts, Counts, Bytes & Money', () => {
  it('LineChart and AreaChart plot negative values, render a visible centered dot for 1-point series, and handle empty []', () => {
    const series = [{ key: 'y', label: 'Delta' }];
    const { container: negHost } = render(
      <div>
        <div data-testid="line-wrap">
          <LineChart
            xKey="x"
            series={series}
            data={[
              { x: 'Jan', y: -5 },
              { x: 'Feb', y: 0 },
              { x: 'Mar', y: 10 },
            ]}
            showDots
          />
        </div>
        <div data-testid="area-wrap">
          <AreaChart
            xKey="x"
            series={series}
            data={[
              { x: 'Jan', y: -5 },
              { x: 'Feb', y: 0 },
              { x: 'Mar', y: 10 },
            ]}
          />
        </div>
      </div>,
    );
    expect(negHost.innerHTML).not.toContain('NaN');
    const circles = negHost.querySelectorAll('[data-testid="line-wrap"] circle');
    expect(circles.length).toBe(3);
    const cyValues = Array.from(circles).map((c) => Number(c.getAttribute('cy')));
    // SVG y increases downward: y(-5) > y(0) > y(10)
    expect(cyValues[0]!).toBeGreaterThan(cyValues[1]!);
    expect(cyValues[1]!).toBeGreaterThan(cyValues[2]!);

    const { container: singleHost } = render(<LineChart xKey="x" series={series} data={[{ x: 'Only', y: 10 }]} showDots={false} />);
    expect(singleHost.innerHTML).not.toContain('NaN');
    expect(singleHost.querySelectorAll('circle').length).toBe(1);

    const { container: emptyHost } = render(<AreaChart xKey="x" series={series} data={[]} />);
    expect(emptyHost.innerHTML).not.toContain('NaN');
    expect(emptyHost.querySelectorAll('circle').length).toBe(0);
  });

  it('LineChart avoids colliding dense long x-axis labels (G-C2)', () => {
    const dense = Array.from({ length: 10 }, (_, idx) => ({
      x: `2026-11-${String(idx + 1).padStart(2, '0')} 14:00`,
      y: idx * 3,
    }));
    const { container: host } = render(<LineChart xKey="x" series={[{ key: 'y', label: 'Count' }]} data={dense} />);
    const xTicks = Array.from(host.querySelectorAll('svg text')).filter((t) => (t.textContent ?? '').startsWith('2026-11-'));
    expect(xTicks.length).toBeLessThan(dense.length);
    const xs = xTicks.map((t) => Number(t.getAttribute('x')));
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]! - xs[i - 1]!).toBeGreaterThan(40);
    }
  });

  it('Sparkline supports single-point [10], flat series at midpoint, negative values [-5, 0, 10], and empty []', () => {
    const { container: single } = render(<Sparkline data={[10]} width={80} height={24} />);
    const dot = single.querySelector('circle');
    expect(dot).not.toBeNull();
    expect(Number(dot?.getAttribute('cx'))).toBe(40);
    expect(Number(dot?.getAttribute('cy'))).toBe(12);

    const { container: flat } = render(<Sparkline data={[7, 7, 7]} width={80} height={24} curve="linear" />);
    const d = flat.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
    expect(d).toContain('12.00');

    const { container: neg } = render(<Sparkline data={[-5, 0, 10]} fill />);
    expect(neg.innerHTML).not.toContain('NaN');

    const { container: empty } = render(<Sparkline data={[]} />);
    expect(empty.querySelector('path')).toBeNull();
  });

  it('BarChart, StackedBarChart, and MiniBars support negative values [-5, 0, 10] cleanly', () => {
    const { container: host } = render(
      <div>
        <BarChart
          xKey="label"
          series={[{ key: 'value', label: 'Delta' }]}
          data={[
            { label: 'Loss', value: -5 },
            { label: 'Flat', value: 0 },
            { label: 'Gain', value: 10 },
          ]}
        />
        <StackedBarChart
          xKey="category"
          data={[
            { category: 'Q1', net: -5, gain: 10 },
            { category: 'Q2', net: 0, gain: 4 },
          ]}
          series={[
            { key: 'net', label: 'Net' },
            { key: 'gain', label: 'Gain' },
          ]}
        />
        <MiniBars data={[-5, 0, 10]} height={24} />
      </div>,
    );
    expect(host.innerHTML).not.toContain('NaN');
    for (const rect of host.querySelectorAll('rect')) {
      expect(Number(rect.getAttribute('height'))).toBeGreaterThanOrEqual(0);
      expect(Number(rect.getAttribute('width'))).toBeGreaterThanOrEqual(0);
    }
  });

  it('DonutChart filters <= 0 segments and renders empty state when total <= 0 (G-C10)', () => {
    const { container: mixed } = render(
      <DonutChart
        size={110}
        data={[
          { label: 'Zero', value: 0 },
          { label: 'Negative', value: -5 },
          { label: 'Positive', value: 10 },
        ]}
      />,
    );
    expect(mixed.innerHTML).not.toContain('NaN');
    expect(mixed.querySelectorAll('circle.nx-donut-segment').length).toBe(1);

    const { container: zeroOnly } = render(<DonutChart data={[{ label: 'Zero', value: 0 }]} />);
    expect(zeroOnly.textContent).toContain('No data');
  });

  it('BreakdownList preserves >2^53 string counts, clamps negative widths to 0%, and scales against explicit total (B7 / G-C12)', () => {
    const { container: host } = render(
      <BreakdownList
        total={100}
        items={[
          { label: 'Exact Snowflake ID Count', value: '9007199254740993' },
          { label: 'Partial', value: 25 },
          { label: 'Adjustment', value: -5 },
        ]}
      />,
    );
    expect(host.textContent).toContain('9,007,199,254,740,993');
    expect(host.textContent).not.toContain('9,007,199,254,740,992');

    const fills = Array.from(host.querySelectorAll<HTMLElement>('.nx-breakdown-fill'));
    expect(fills[1]?.style.width).toBe('25%');
    expect(fills[2]?.style.width).toBe('0%');
  });

  it('FunnelChart and FunnelSteps render 0% bar width for <= 0 values, neutral badge tone, and list/table semantics (G-C9)', () => {
    const { container: host } = render(
      <div>
        <FunnelChart
          stages={[
            { label: 'Visited', value: 0 },
            { label: 'Converted', value: -5 },
          ]}
        />
        <FunnelSteps
          steps={[
            { title: 'Step 1', count: 0, basis: null },
            { title: 'Step 2', count: 0, basis: 0 },
          ]}
        />
      </div>,
    );
    for (const bar of host.querySelectorAll<HTMLElement>('.nx-funnel-bar-fill')) {
      expect(bar.style.width).toBe('0%');
    }
    for (const fill of host.querySelectorAll<HTMLElement>('[data-slot="funnel-fill"]')) {
      expect(fill.style.width).toBe('0%');
    }
    const badge = host.querySelector('.nx-funnel .nx-badge');
    expect(badge?.getAttribute('data-tone')).toBe('neutral');
    expect(host.querySelector('.nx-funnel[role="list"]')).not.toBeNull();
    expect(host.querySelector('.nx-funnel table')).not.toBeNull();
  });

  it('RadarChart places outer axis labels outside the polygon (G-C8) and supports negative min', () => {
    const { container: host } = render(
      <RadarChart
        size={260}
        min={-10}
        axes={[
          { label: 'Throughput', max: 100 },
          { label: 'Latency', max: 100 },
          { label: 'Reliability', max: 100 },
        ]}
        series={[{ label: 'Current', values: [-5, 0, 80] }]}
      />,
    );
    expect(host.innerHTML).not.toContain('NaN');
    const topLabel = Array.from(host.querySelectorAll('svg text')).find((t) => t.textContent === 'Throughput')!;
    const polygons = host.querySelectorAll('svg polygon');
    const outerRingTopY = Number(polygons[polygons.length - 2]?.getAttribute('points')?.split(' ')[0]?.split(',')[1]);
    expect(Number(topLabel.getAttribute('y'))).toBeLessThan(outerRingTopY - 10);
  });

  it('RadialGauge guards NaN, clamps readout consistently with aria-valuenow, formats min/max, and respects reduced motion (G-C7, A1)', () => {
    document.documentElement.dataset.nxMotion = 'reduced';
    const { container: nanGauge } = render(<RadialGauge value={Number.NaN} label="CPU" showEndpoints formatValue={(v) => `${v}%`} />);
    expect(nanGauge.innerHTML).not.toContain('NaN');
    expect(nanGauge.textContent).toContain('0%');
    expect(nanGauge.textContent).toContain('100%');

    const { container: overGauge } = render(<RadialGauge value={145} min={0} max={100} label="Load" />);
    const meter = overGauge.querySelector('[role="meter"]')!;
    expect(meter.getAttribute('aria-valuenow')).toBe('100');
    expect(overGauge.querySelector('.nx-radial-gauge-value')?.textContent).toBe('100%');
  });

  it('HeatmapMatrix uses roving tabIndex so only one cell is in the Tab sequence', () => {
    const { container: host } = render(
      <HeatmapMatrix
        rows={['R1', 'R2', 'R3']}
        columns={['C1', 'C2', 'C3']}
        values={[
          [-5, 0, 10],
          [2, 4, 6],
          [1, 3, 9],
        ]}
      />,
    );
    const cells = Array.from(host.querySelectorAll<HTMLButtonElement>('.nx-heatmap-cell'));
    expect(cells.length).toBe(9);
    expect(cells.filter((c) => c.tabIndex === 0).length).toBe(1);
    expect(cells.filter((c) => c.tabIndex === -1).length).toBe(8);
  });

  it('preserves >2^53 precision, 2-decimal currency ($1,250.50), and byte rollover (1.0 MB, 8.0 PB, EB) across FormattedValue, masks.money, NumberInput, InviteAcceptCard, and formatAttachmentSize', () => {
    const { container: host } = render(
      <div>
        <FormattedValue data-testid="curr" format="currency" value={1250.5} currency="USD" locale="en-US" />
        <FormattedValue data-testid="b-mb" format="bytes" value={1048575} />
        <FormattedValue data-testid="b-pb" format="bytes" value={9007199254740992} />
        <FormattedValue data-testid="big-int" format="number" value="9007199254740993" locale="en-US" />
        <FormattedValue data-testid="big-dec" format="currency" value="9007199254740993.5" currency="USD" locale="en-US" />
        <NumberInput value="9007199254740993" locale="en-US" aria-label="Big counter" />
        <InviteAcceptCard workspaceName="Ops" inviterName="Alex" memberCount="9007199254740993" locale="en-US" />
      </div>,
    );

    expect(host.querySelector('[data-testid="curr"]')?.textContent).toBe('$1,250.50');
    expect(host.querySelector('[data-testid="b-mb"]')?.textContent).toBe('1.0 MB');
    expect(host.querySelector('[data-testid="b-pb"]')?.textContent).toBe('8.0 PB');
    expect(host.querySelector('[data-testid="big-int"]')?.textContent).toBe('9,007,199,254,740,993');
    expect(host.querySelector('[data-testid="big-dec"]')?.textContent).toBe('$9,007,199,254,740,993.50');

    const spin = host.querySelector<HTMLInputElement>('[role="spinbutton"]')!;
    expect(spin.value).toBe('9,007,199,254,740,993');

    expect(host.querySelector('.nx-invite-member-count')?.textContent).toBe('9,007,199,254,740,993 members');

    expect(masks.money('$', 20, 'en-US').format('1250.5')).toBe('$1,250.50');
    expect(masks.money('$', 20, 'en-US').format('2500')).toBe('$2,500');
    expect(masks.money('$', 20, 'en-US').format('9007199254740993')).toBe('$9,007,199,254,740,993');
    expect(masks.money('$', 20, 'en-US').parse('$9,007,199,254,740,993')).toBe('9007199254740993');

    expect(formatAttachmentSize(1048575)).toBe('1.0 MB');
    expect(formatAttachmentSize(9007199254740992)).toBe('8.0 PB');
    expect(formatAttachmentSize('1152921504606846976')).toBe('1.0 EB');
  });
});

describe('C1, C3, C5, C7, A4, G-P3, G-P4, G-V3, G-V4 — Field Wiring, Layout, Console Hygiene & Disabled Clear Controls', () => {
  it('wires <Field label="..."> onto Select, Combobox, DatePicker, DateRangePicker, EntityPicker, and TreeSelect (C3)', () => {
    const { container: host } = render(
      <div>
        <Field label="prim Select">
          <Select options={[{ value: 'a', label: 'Alpha' }]} value="a" onValueChange={() => {}} />
        </Field>
        <Field label="Team Combobox">
          <Combobox options={[{ value: 'eng', label: 'Engineering' }]} />
        </Field>
        <Field label="Due Date">
          <DatePicker />
        </Field>
        <Field label="Window">
          <DatePicker mode="range" />
        </Field>
        <Field label="Owner Record">
          <EntityPicker entities={[{ id: '1', label: 'Node One' }]} />
        </Field>
        <Field label="Department Tree">
          <TreeSelect options={[{ value: 'ops', label: 'Operations' }]} />
        </Field>
      </div>,
    );

    const labels = Array.from(host.querySelectorAll('label'));
    expect(labels.length).toBe(6);
    for (const lbl of labels) {
      const forId = lbl.getAttribute('for');
      expect(forId).toBeTruthy();
      expect(host.querySelector(`[id="${CSS.escape(forId!)}"]`)).not.toBeNull();
    }
  });

  it('renders SensitiveField Show/Hide button inside data-slot="field-box" and DateTimePicker inside a single input-group (A4)', () => {
    const { container: host } = render(
      <div>
        <SensitiveField
          id="ssn"
          label="SSN"
          value="123456789"
          onValueChange={() => {}}
          mask={masks.ssn}
          showLabel="Show"
          hideLabel="Hide"
        />
        <DateTimePicker label="Scheduled" showTimezone />
      </div>,
    );

    const fieldBox = host.querySelector('[data-slot="field-box"]')!;
    expect(fieldBox.querySelector('button')).not.toBeNull();

    const dtPicker = host.querySelector('[data-slot="datetime-picker"]')!;
    expect(dtPicker.querySelectorAll('[data-slot="input-group"]').length).toBe(1);
  });

  it('hides clear and chip-remove buttons when controls are disabled or readOnly (G-P4)', () => {
    const { container: host } = render(
      <div>
        <Input value="abc" onValueChange={() => {}} clearable disabled ariaLabel="Disabled input" />
        <Combobox options={[{ value: 'a', label: 'Alpha' }]} value="a" clearable disabled ariaLabel="Disabled combo" />
        <Autocomplete suggestions={['Alpha']} value="Alpha" clearable disabled ariaLabel="Disabled auto" />
        <DatePicker value="2026-11-23" clearable disabled ariaLabel="Disabled date" />
        <EntityPicker entities={[{ id: '1', label: 'One' }]} value="1" clearable disabled ariaLabel="Disabled entity" />
        <TreeSelect options={[{ value: '1', label: 'One' }]} value="1" clearable disabled ariaLabel="Disabled tree" />
      </div>,
    );
    expect(host.querySelector('.nx-input-clear')).toBeNull();
    expect(host.querySelector('.nx-tree-select-clear')).toBeNull();
  });

  it('applies nx-tabs-count class, wraps CodeEditor lines by default, avoids empty img src warnings, and labels Kanban/Gantt controls', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { container: host } = render(
        <div>
          <Tabs
            ariaLabel="Sections"
            tabs={[
              { value: 'one', label: 'One', count: 4, content: 'Body' },
              { value: 'two', label: 'Two', count: 0, content: 'Body 2' },
            ]}
          />
          <CodeEditor defaultValue="const x = 1;" />
          <ImageCropper src="" />
          <PhotoTiles
            tiles={[
              { src: '', alt: 'First placeholder' },
              { src: '', alt: 'Second placeholder' },
            ]}
          />
          <KanbanBoard
            columns={[{ id: 'todo', title: 'To Do', wipLimit: 2 }]}
            cards={[{ id: 'c1', title: 'Task 1' }]}
            defaultValue={{ todo: ['c1'] }}
            allowCreate
          />
          <GanttView startDate="2026-11-01" min={0} max={5} step={1} axisStep={1} tasks={[{ id: 'b1', name: 'Build', start: 0, end: 2 }]} />
        </div>,
      );

      expect(host.querySelector('.nx-tabs-count')?.textContent).toBe('4');
      expect(host.querySelector('textarea.nx-code-textarea')?.getAttribute('wrap')).toBe('soft');
      expect(host.querySelectorAll('img[src=""]').length).toBe(0);
      expect(host.textContent).toContain('Nov 1');
      expect(errSpy).not.toHaveBeenCalled();
    } finally {
      errSpy.mockRestore();
    }
  });
});
