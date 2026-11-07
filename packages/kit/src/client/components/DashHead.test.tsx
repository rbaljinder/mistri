import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DashHead } from './DashHead.js';

afterEach(cleanup);

const PAGE = { id: 'walk', label: 'Pick walk', description: 'Walk the open lines in bin order.', favorite: true as const };

/* Whatever form the head takes, the room has one h1 and it is the page's name: a screen reader lands on it, and the
   document title, crumbs and palette say the same label. */
const oneTitle = (container: HTMLElement, name: string) => {
  const titles = container.querySelectorAll('h1');
  expect(titles).toHaveLength(1);
  expect(titles[0]!.textContent).toBe(name);
  return titles[0]!;
};

test('the full head: the title, its star and the intro', () => {
  const { container } = render(<DashHead dashboard={PAGE} />);
  expect(oneTitle(container, 'Pick walk').className).not.toContain('visually-hidden');
  expect(screen.getByRole('button', { name: /favorites/i })).toBeTruthy();
  expect(screen.getByText('Walk the open lines in bin order.')).toBeTruthy();
});

test("head: 'compact' is the title on one line with its verbs, and no intro", () => {
  const { container } = render(<DashHead dashboard={{ ...PAGE, head: 'compact' }} />);
  const title = oneTitle(container, 'Pick walk');
  expect(title.className).not.toContain('visually-hidden');
  expect(title.parentElement!.className).toContain('dash-head-compact');
  expect(title.parentElement!.className).toContain('applist-head-row');
  expect(screen.getByRole('button', { name: /favorites/i })).toBeTruthy();
  expect(screen.queryByText('Walk the open lines in bin order.')).toBeNull();
});

test('head: false is a page that draws its own: the title stays for a screen reader alone, with no star or intro', () => {
  const { container } = render(<DashHead dashboard={{ ...PAGE, head: 'own', headingHidden: true }} />);
  expect(oneTitle(container, 'Pick walk').className).toContain('visually-hidden');
  expect(screen.queryByRole('button', { name: /favorites/i })).toBeNull();
  expect(screen.queryByText('Walk the open lines in bin order.')).toBeNull();
});

test('heading: false hides only the title: the star and the intro the author wrote stay', () => {
  const { container } = render(<DashHead dashboard={{ ...PAGE, headingHidden: true }} />);
  expect(oneTitle(container, 'Pick walk').className).toContain('visually-hidden');
  expect(screen.getByText('Walk the open lines in bin order.')).toBeTruthy();
});
