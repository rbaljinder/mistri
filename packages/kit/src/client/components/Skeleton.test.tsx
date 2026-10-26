/**
 * A record page that is still on its way past the navigation hold draws its own anatomy, from its definition: the
 * main column's sections and the aside's, so what arrives stands where its placeholder stood.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { PageSkeleton } from './PageSkeleton.js';

afterEach(() => cleanup());

test("a page's placeholder has its sections, in their regions, in their own shapes", () => {
  render(
    <PageSkeleton
      sections={[
        { kind: 'fields', paths: ['a', 'b', 'c'] },
        { kind: 'list', title: 'Charges', from: 'charge' } as never,
        { kind: 'fields', region: 'aside', title: 'Resident', paths: ['x', 'y'] },
        { kind: 'fields', hidden: true, paths: ['z'] },
      ]}
    />,
  );
  const page = document.querySelector('.sk-page')!;
  expect(page.getAttribute('role')).toBe('status');
  const main = page.querySelector('.sk-page-main')!;
  expect(main.querySelectorAll('.sk-page-section')).toHaveLength(2);
  expect(main.querySelectorAll('.sk-page-field')).toHaveLength(3);
  expect(main.querySelector('.sk-grid')).not.toBeNull();
  expect(page.querySelector('.sk-page-aside')!.querySelectorAll('.sk-page-field')).toHaveLength(2);
});

test('a page with nothing in its aside draws no aside', () => {
  render(<PageSkeleton sections={[{ kind: 'fields', paths: ['a'] }]} />);
  expect(document.querySelector('.sk-page-aside')).toBeNull();
});
