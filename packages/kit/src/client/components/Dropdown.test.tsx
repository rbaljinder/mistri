import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Dropdown, readsAsName } from './Dropdown.js';

afterEach(cleanup);

test("a list its caller names nothing is called by the catalog's word, and a named one keeps its name", () => {
  render(
    <>
      <Dropdown value="a" items={[{ value: 'a', label: 'Alpha' }]} onChange={() => {}} />
      <Dropdown value="b" items={[{ value: 'b', label: 'Beta' }]} ariaLabel="Region" onChange={() => {}} />
    </>,
  );
  expect(screen.getByRole('button', { name: 'Select' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Region' })).toBeInTheDocument();
});

test('only a short name can follow "Choose" in a placeholder', () => {
  expect(readsAsName('Status')).toBe(true);
  expect(readsAsName('Assigned to')).toBe(true);
  expect(readsAsName('What would you like to know?')).toBe(false);
  expect(readsAsName('Which of these describes your reason for contacting us')).toBe(false);
});
