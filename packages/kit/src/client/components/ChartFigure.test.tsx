/**
 * The figure a dashboard's chart and the assistant's chart share: the order
 * its groups are drawn in, whichever shape draws them.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('../core.js', async (original) => ({
  ...(await original<typeof import('../core.js')>()),
  // The host has a width to draw in; happy-dom lays nothing out.
  viewportBox: () => ({ width: 600, height: 240, top: 0, left: 0, right: 600, bottom: 240 }),
}));
const { ChartFigure } = await import('./ChartFigure.js');

afterEach(() => cleanup());

// A breakdown answers its groups alphabetically; a stage is a pipeline.
const answer = {
  columns: ['stage', 'count'],
  rows: [
    { stage: 'negotiation', count: 25 },
    { stage: 'proposal', count: 41 },
    { stage: 'prospecting', count: 38 },
    { stage: 'qualification', count: 59 },
  ],
};
const vocabulary = ['prospecting', 'qualification', 'proposal', 'negotiation'];
const drawn = (container: HTMLElement) => [...container.querySelectorAll('table.chart-data th')].map((cell) => cell.textContent);

test.each([['line' as const], ['bar' as const]])('a %s over a key with declared choices walks them in their declared order', (shape) => {
  const { container } = render(
    <ChartFigure answer={answer} shape={shape} say={String} label={String} vocabulary={vocabulary} empty="Nothing" />,
  );
  expect(drawn(container)).toEqual(vocabulary);
});

test('a line over a key with no declared choices keeps the order it was answered in', () => {
  const { container } = render(<ChartFigure answer={answer} shape="line" say={String} label={String} empty="Nothing" />);
  expect(drawn(container)).toEqual(['negotiation', 'proposal', 'prospecting', 'qualification']);
});

/* An age in days, answered biggest first as a breakdown asks; and a priority stored 1 to 5, said Urgent to Planning. */
const ages = {
  columns: ['age_days', 'count'],
  rows: [
    { age_days: 0, count: 13 },
    { age_days: 1, count: 11 },
    { age_days: 6, count: 1 },
    { age_days: 3, count: 1 },
    { age_days: 2, count: 1 },
  ],
};
const priorities = {
  columns: ['priority', 'count'],
  rows: [
    { priority: 3, count: 13 },
    { priority: 4, count: 7 },
    { priority: 2, count: 4 },
    { priority: 5, count: 3 },
    { priority: 1, count: 1 },
  ],
};
const words: Record<string, string> = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Planning' };
const legend = (container: HTMLElement) => [...container.querySelectorAll('.chart-legend-key')].map((key) => key.textContent);
const swatches = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>('.chart-legend .chart-swatch')].map((swatch) => swatch.getAttribute('style') ?? '');

test('bars over a scale run in its order, not by their counts', () => {
  const { container } = render(<ChartFigure answer={ages} shape="bar" say={String} label={String} scale empty="Nothing" />);
  expect(drawn(container)).toEqual(['0', '1', '2', '3', '6']);
});

test('a donut over a declared order goes round in it, in steps of one hue where it is a scale', () => {
  const { container } = render(
    <ChartFigure
      answer={priorities}
      shape="donut"
      say={String}
      label={(key) => words[String(key)]}
      vocabulary={['1', '2', '3', '4', '5']}
      scale
      empty="Nothing"
    />,
  );
  expect(legend(container)).toEqual(['Urgent', 'High', 'Medium', 'Low', 'Planning']);
  expect(container.querySelector('.chart-donut-wrap')).toHaveClass('is-ordered');
  // One hue, deepest first: every swatch is the lead series mixed, none a categorical series of its own.
  const inks = swatches(container);
  expect(inks.every((ink) => /--ramp: color-mix\(in oklab/.test(ink) && ink.includes('--chart-1'))).toBe(true);
  expect(inks.some((ink) => /--chart-[2-8]/.test(ink))).toBe(false);
  expect(new Set(inks).size).toBe(5);
  expect(inks[0]).toContain('100%');
  expect(inks[4]).toContain(' 0%');
});

test('a donut over plain text stays biggest first, in categorical hues', () => {
  const sources = {
    columns: ['source', 'count'],
    rows: [
      { source: 'web', count: 3 },
      { source: 'phone', count: 9 },
      { source: 'email', count: 5 },
    ],
  };
  const { container } = render(<ChartFigure answer={sources} shape="donut" say={String} label={String} empty="Nothing" />);
  expect(legend(container)).toEqual(['phone', 'email', 'web']);
  expect(container.querySelector('.chart-donut-wrap')).not.toHaveClass('is-ordered');
  expect(swatches(container).map((ink) => /--chart-(\d)/.exec(ink)?.[1])).toEqual(['1', '2', '3']);
});

test('stacked bars over a scale stand its series in its order, in steps of one hue', () => {
  const crossed = {
    columns: ['team', 'priority', 'count'],
    rows: [
      { team: 'Desk', priority: 3, count: 9 },
      { team: 'Desk', priority: 1, count: 1 },
      { team: 'Field', priority: 2, count: 4 },
      { team: 'Field', priority: 3, count: 2 },
    ],
  };
  const { container } = render(
    <ChartFigure
      answer={crossed}
      shape="stacked"
      say={String}
      label={String}
      seriesLabel={(key) => words[String(key)]}
      seriesVocabulary={['1', '2', '3', '4', '5']}
      seriesScale
      empty="Nothing"
    />,
  );
  expect([...container.querySelectorAll('.chart-legend li')].map((item) => item.textContent)).toEqual(
    expect.arrayContaining([expect.stringContaining('Urgent')]),
  );
  const named = [...container.querySelectorAll('.chart-legend li')].map((item) => item.textContent ?? '');
  expect(named.findIndex((text) => text.includes('Urgent'))).toBeLessThan(named.findIndex((text) => text.includes('Medium')));
  expect(swatches(container).every((ink) => /--ramp: color-mix\(in oklab/.test(ink))).toBe(true);
});

test('before its answer a chart holds its room, at its own height where the section says one', () => {
  const { container, rerender } = render(
    <ChartFigure answer={undefined} shape="line" say={String} label={String} empty="Nothing" height={180} />,
  );
  const wait = container.querySelector<HTMLElement>('.chart-wait')!;
  expect(wait.getAttribute('aria-busy')).toBe('true');
  expect(wait.style.height).toBe('180px');
  rerender(<ChartFigure answer={undefined} shape="stacked" say={String} label={String} empty="Nothing" limit={3} />);
  expect(container.querySelector<HTMLElement>('.chart-wait-rows')!.style.height).toBe('122px');
});

/* A sprint's velocity, asked in the order the sprints were made: the figure keeps it, or sorts by value when told. */
const velocity = {
  columns: ['key_1', 'value'],
  rows: [
    { key_1: 'Sprint 1', value: 5 },
    { key_1: 'Sprint 2', value: 40 },
    { key_1: 'Sprint 3', value: 20 },
  ],
};

test('bars arranged by the answer keep the order they were asked in, and arranged by value go biggest first', () => {
  const kept = render(<ChartFigure answer={velocity} shape="bar" arrange="answer" say={String} label={String} empty="Nothing" />);
  expect(drawn(kept.container)).toEqual(['Sprint 1', 'Sprint 2', 'Sprint 3']);
  cleanup();
  const byValue = render(
    <ChartFigure
      answer={velocity}
      shape="bar"
      arrange="value"
      say={String}
      label={String}
      vocabulary={['Sprint 3', 'Sprint 1']}
      empty="Nothing"
    />,
  );
  expect(drawn(byValue.container)).toEqual(['Sprint 2', 'Sprint 3', 'Sprint 1']);
  cleanup();
  // The cut keeps the first categories in the order asked, not the largest.
  const cut = render(<ChartFigure answer={velocity} shape="bar" arrange="answer" limit={2} say={String} label={String} empty="Nothing" />);
  expect(drawn(cut.container)).toEqual(['Sprint 1', 'Sprint 2']);
});
