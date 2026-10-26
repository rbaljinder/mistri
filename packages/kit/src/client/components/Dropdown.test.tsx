import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Dropdown } from './Dropdown.js';

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
