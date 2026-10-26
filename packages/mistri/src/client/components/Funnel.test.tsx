import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { Funnel, type FunnelStep } from './Funnel.js';

afterEach(cleanup);
const plain = (value: unknown) => String(value);
const names = (container: HTMLElement, cls: string) => [...container.querySelectorAll(cls)].map((node) => node.textContent);

const steps: FunnelStep[] = [
  { title: 'Lead', basis: null, count: 40 },
  { title: 'Qualified', basis: 0, count: 20 },
  { title: 'Referred', basis: 1, count: 6, optional: true },
  { title: 'Won', basis: 1, count: 5 },
];

describe('the funnel section', () => {
  test('draws each stage against the first, as a share of the stage it follows, with the rows it lost', () => {
    const { container } = render(<Funnel steps={steps} say={plain} table="leads" />);
    expect(names(container, '.dash-funnel-name')).toEqual(['Lead', 'Qualified', 'ReferredOptional', 'Won']);
    expect(names(container, '.dash-funnel-value')).toEqual(['40', '20', '6', '5']);
    // The optional stage and the one after it are both a share of Qualified, the last required stage before them.
    expect(names(container, '.dash-funnel-share').map((text) => text?.trim())).toEqual([
      '',
      '50% of Lead',
      '30% of Qualified',
      '25% of Qualified',
    ]);
    // Only a required stage loses rows: an optional one is a side road.
    expect(names(container, '.dash-funnel-drop').map((text) => text?.trim())).toEqual(['', '−20', '', '−15']);
    expect((container.querySelectorAll('.dash-funnel-fill')[3] as HTMLElement).style.width).toBe('12.5%');
    expect(screen.getByRole('list')).toHaveAttribute('aria-label', '4 stages from Lead to Won');
  });

  test('holds every stage and its place while the counts are on their way', () => {
    const { container } = render(<Funnel steps={steps.map((step) => ({ ...step, count: undefined }))} say={plain} table="leads" />);
    expect(names(container, '.dash-funnel-name')).toHaveLength(4);
    expect(screen.getByRole('list')).toHaveAttribute('aria-busy', 'true');
  });

  test('a stage opens the rows that reached it, and the lost figure those that stopped there', () => {
    const open = vi.fn();
    const drop = vi.fn();
    const door = steps.map((step, i) => ({ ...step, reached: { open: () => open(i) }, dropped: { open: () => drop(i) } }));
    render(<Funnel steps={door} say={plain} table="leads" />);
    screen.getByTitle('Open the leads that reached Qualified').click();
    screen.getByTitle('Open the leads that stopped before Won').click();
    expect(open).toHaveBeenCalledWith(1);
    expect(drop).toHaveBeenCalledWith(3);
  });
});
