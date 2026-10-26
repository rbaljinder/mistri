/**
 * The bin map, drawn as its stories draw it: bins placed by their codes,
 * each shaded by its fill and said in words, an inactive one marked, and a
 * bin opened as a peek.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fireEvent, within } from '@testing-library/react';
import { renderExample } from '@mistriwork/mistri/ui/testing';
import map, { Desk, Phone } from './BinMap.examples.tsx';
import { fillOf, placeOf, shadeOf } from './BinMap.tsx';

test('reads a place from a bin code', () => {
  expect(placeOf('RNO-A-07-2')).toEqual({ kind: 'pick', aisle: 'A', bay: 7, level: 2 });
  expect(placeOf('RNO-R-12')).toEqual({ kind: 'reserve', bay: 12 });
  expect(placeOf('RNO-DOCK')).toEqual({ kind: 'dock' });
  expect(placeOf('RNO-odd')).toBeUndefined();
  expect(fillOf({ capacity: 120, units: 180 })).toBe(1);
});

test('shades any stock a visible step from empty, and a full bin in the accent itself', () => {
  expect(shadeOf(0)).toBe(0);
  expect(shadeOf(0.05)).toBeGreaterThan(25);
  expect(shadeOf(0.25)).toBeLessThan(shadeOf(0.5));
  expect(shadeOf(1)).toBe(100);
});

test('lays out each aisle by bay and level, shades each bin by its fill, and opens one as a peek', () => {
  const view = renderExample(map, Desk);
  const aisle = within(view.getByRole('region', { name: 'Aisle A' }));
  const bins = aisle.getAllByRole('button');
  expect(bins).toHaveLength(12);
  // Levels read top down: the first row is level 3.
  expect(bins[0]).toHaveAccessibleName('ABE-A-01-3: 111 of 120 units');
  expect(bins[0].style.getPropertyValue('--c-bin-map-shade')).toBe(`${shadeOf(111 / 120)}%`);
  // Each bay is said once, over its column, not on every bin.
  expect(bins[0].textContent).toBe('');
  expect(view.getByRole('button', { name: 'ABE-B-04-3: 108 of 120 units, inactive' })).toHaveAttribute('data-inactive', 'true');
  expect(within(view.getByRole('region', { name: 'Reserve' })).getByRole('button', { name: /ABE-R-02: 0 of 600/ })).toHaveAttribute(
    'data-empty',
    'true',
  );
  expect(view.getByText(/units in 27 bins/)).toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: /^ABE-DOCK/ }));
  expect(view.navigations).toEqual([{ kind: 'record', resource: 'bin', key: { id: 102 }, mode: 'drawer' }]);
});

test('a phone keeps every bay of an aisle across', () => {
  const view = renderExample(map, Phone);
  expect(view.container.querySelector('.c-bin-map')).toHaveAttribute('data-compact', 'true');
  expect(within(view.getByRole('region', { name: 'Aisle B' })).getAllByRole('button')).toHaveLength(12);
});
