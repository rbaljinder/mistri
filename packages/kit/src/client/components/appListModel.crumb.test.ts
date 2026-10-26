/**
 * What the crumb says of a refined list: the values it narrows to, a count
 * when they are not plain, and nothing for a sort — never "filtered".
 */
import { expect, test } from 'vitest';
import { refinementWords } from './appListModel.js';

test('a refinement is said as its values, a count when they are not plain, nothing for a sort', () => {
  expect(refinementWords('')).toBe('');
  expect(refinementWords('sort price desc')).toBe('');
  expect(refinementWords('body_type = Sedan')).toBe('Sedan');
  expect(refinementWords('body_type = "Sedan" and make = Toyota')).toBe('Sedan, Toyota');
  expect(refinementWords('make = Toyota and fuel = Hybrid and body_type = SUV and year = 2020')).toBe('Toyota, Hybrid +2');
  // A number alone says nothing: it carries its column's name.
  expect(refinementWords('make = Toyota and year = 2020')).toBe('Toyota, Year 2020');
  expect(refinementWords('make = Toyota and price <= 10000')).toBe('Toyota +1');
  expect(refinementWords('price <= 10000')).toBe('1 filter');
  expect(refinementWords('price <= 10000 and year >= 2018 sort price')).toBe('2 filters');
});
