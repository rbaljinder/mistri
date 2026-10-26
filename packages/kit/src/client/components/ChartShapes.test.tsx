/**
 * The further chart shapes: what each draws from a breakdown's answer, what it
 * says to a reader who cannot see it, and the order it keeps.
 */
import { afterEach, describe, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ChartShape, squarify, tileLabel } from './ChartShapes.js';

afterEach(cleanup);
const money = (v: unknown) => `$${Number(v)}`;
const plain = (v: unknown) => String(v);

const rowsOf = (container: HTMLElement) => [...container.querySelectorAll('.chart-data tbody tr')].map((row) => row.textContent);

describe('the scatter', () => {
  test('a dot per group placed by both measures, each said in its own dress', () => {
    const answer = {
      columns: ['site', 'count', 'sum cost'],
      rows: [
        { site: 'North', count: 4, 'sum cost': 120 },
        { site: 'South', count: 9, 'sum cost': 40 },
        { site: 'West', count: null, 'sum cost': 10 },
      ],
    };
    const { container } = render(
      <ChartShape
        shape="scatter"
        answer={answer}
        say={money}
        sayX={plain}
        names={{ x: 'count', y: 'sum cost' }}
        label={plain}
        wide={500}
      />,
    );
    const dots = [...container.querySelectorAll('.chart-scatter-dot')];
    // A group with no figure has no place to stand, so it is left out rather than drawn at zero.
    expect(dots.map((dot) => dot.querySelector('title')!.textContent)).toEqual(['North: 4, $120', 'South: 9, $40']);
    expect(Number(dots[1].getAttribute('cx'))).toBeGreaterThan(Number(dots[0].getAttribute('cx')));
    expect(Number(dots[1].getAttribute('cy'))).toBeGreaterThan(Number(dots[0].getAttribute('cy')));
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '2 dots: count across, sum cost up');
    expect(rowsOf(container)).toEqual(['North4$120', 'South9$40']);
  });
});

describe('the heat map', () => {
  const answer = {
    columns: ['weekday opened_on', 'hour opened_on', 'count'],
    rows: [
      { 'weekday opened_on': '2', 'hour opened_on': '09', count: 3 },
      { 'weekday opened_on': '1', 'hour opened_on': '14', count: 10 },
      { 'weekday opened_on': '1', 'hour opened_on': '09', count: 1 },
    ],
  };
  const days = (key: unknown) => ({ 1: 'Mon', 2: 'Tue' })[Number(key) as 1 | 2] ?? String(key);

  test('rows and columns in their own order, an hour with nothing kept as a column, the empty cells unshaded', () => {
    const { container } = render(<ChartShape shape="heatmap" answer={answer} say={plain} label={days} seriesLabel={plain} wide={500} />);
    expect([...container.querySelectorAll('.chart-heat-row')].map((node) => node.textContent)).toEqual(['Mon', 'Tue']);
    expect([...container.querySelectorAll('.chart-heat-col')].map((node) => node.textContent)).toEqual([
      '09',
      '10',
      '11',
      '12',
      '13',
      '14',
    ]);
    const cells = [...container.querySelectorAll<HTMLElement>('.chart-heat-cell')];
    expect(cells.map((cell) => cell.textContent)).toEqual(['1', '0', '0', '0', '0', '10', '3', '0', '0', '0', '0', '0']);
    expect(cells[1].getAttribute('style')).toBeNull();
    expect(cells[5].style.getPropertyValue('--heat')).toBe('82%');
    expect(screen.getByRole('table')).toHaveAttribute('aria-label', '2 by 6; highest 10 at Mon, 14');
  });

  test('the pointed-at cell is said under the grid', () => {
    const { container } = render(<ChartShape shape="heatmap" answer={answer} say={plain} label={days} seriesLabel={plain} wide={500} />);
    fireEvent.pointerEnter(container.querySelectorAll('.chart-heat-cell')[6]);
    expect(container.querySelector('.chart-heat-said')).toHaveTextContent('Tue · 09 — 3');
  });
});

describe('the waterfall', () => {
  test('rises and falls from where the last ended, then the total, said with their signs', () => {
    const answer = {
      columns: ['month', 'sum change'],
      rows: [
        { month: '2026-02', 'sum change': -30 },
        { month: '2026-01', 'sum change': 100 },
      ],
    };
    const { container } = render(<ChartShape shape="waterfall" answer={answer} say={money} label={plain} wide={500} />);
    const bars = [...container.querySelectorAll('.chart-waterfall-bar')];
    expect(bars.map((bar) => bar.getAttribute('class')!.split(' ')[1])).toEqual(['is-rise', 'is-fall', 'is-total']);
    expect(rowsOf(container)).toEqual(['Jan 2026+$100', 'Feb−$30', 'Total$70']);
    // The fall starts at the rise's top.
    expect(bars[1].getAttribute('y')).toBe(bars[0].getAttribute('y'));
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '2 changes to a total of $70');
  });
});

describe('the treemap', () => {
  test('tiles largest first, past eight one "Others" tile, the areas in proportion', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ site: `S${i + 1}`, count: 10 - i }));
    const { container } = render(
      <ChartShape shape="treemap" answer={{ columns: ['site', 'count'], rows }} say={plain} label={plain} wide={600} />,
    );
    const tiles = [...container.querySelectorAll<HTMLElement>('.chart-tile')];
    expect(tiles).toHaveLength(8);
    expect(tiles[7]).toHaveClass('is-other');
    expect(rowsOf(container)[0]).toBe('S11018%');
    expect(rowsOf(container)[7]).toBe('Others (3)611%');
    expect(screen.getByRole('img')).toHaveAttribute('aria-label', '10 groups; largest S1 10');
  });

  test('squarify fills the box exactly, every tile its share of the area', () => {
    const boxes = squarify([6, 6, 4, 3, 2, 2, 1], { x: 0, y: 0, w: 600, h: 400 });
    const area = boxes.reduce((sum, box) => sum + box.w * box.h, 0);
    expect(area).toBeCloseTo(240_000, 3);
    expect(boxes[0].w * boxes[0].h).toBeCloseTo((6 / 24) * 240_000, 3);
    for (const box of boxes) {
      expect(box.x + box.w).toBeLessThanOrEqual(600.0001);
      expect(box.y + box.h).toBeLessThanOrEqual(400.0001);
    }
  });

  test('a tile says its name whole, on more lines or a size down, or not at all', () => {
    const measure = (text: string) => text.length * 6.6;
    // One line where it fits, with its figure under it where there is height for one.
    expect(tileLabel('Backpacks', 140, 70, measure)).toEqual({ size: 12, lines: 1, value: true });
    // "Sleeping bags" in 90px is two lines, never "Sleeping …".
    expect(tileLabel('Sleeping bags', 90, 70, measure)).toMatchObject({ size: 12, lines: 2 });
    // A short tile that two lines will not fit says it a size down on one.
    expect(tileLabel('Tires & tubes', 102, 34, measure)).toMatchObject({ size: 11, lines: 1, value: false });
    // A word wider than the tile, or a tile too small for any line, says nothing; its tooltip still does.
    expect(tileLabel('Accessories', 50, 80, measure)).toBeNull();
    expect(tileLabel('Bags', 80, 20, measure)).toBeNull();
  });
});
