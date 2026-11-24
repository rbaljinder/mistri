/**
 * `<PageHeader>`: a free-form page's own head, in the platform's head markup (the dashboard head's, PageHeading.tsx),
 * so every look dresses it as it dresses the platform's. An h2, since the page's one h1 is the platform's.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { DashHead } from '@mistriwork/kit/client/components/DashHead.js';
import { PageHeader } from './page.js';

afterEach(() => cleanup());

test('the title, intro, verbs and a way back, in the platform head classes', () => {
  const { container } = render(
    <PageHeader
      title="Pick walk"
      description="Lists due today"
      actions={<button type="button">Release</button>}
      back={{ label: 'All lists', href: '/pick-lists' }}
    />,
  );
  const head = container.querySelector('.applist-head.dash-head')!;
  expect(head).toHaveClass('has-actions', 'has-back');
  expect(screen.getByRole('heading', { level: 2, name: 'Pick walk' })).toHaveClass('applist-title');
  expect(screen.queryByRole('heading', { level: 1 })).toBeNull();
  expect(head.querySelector('.dash-description')).toHaveTextContent('Lists due today');
  expect(head.querySelector('.dash-head-actions')).toContainElement(screen.getByRole('button', { name: 'Release' }));
  const back = screen.getByRole('link', { name: 'Back to All lists' });
  expect(back).toHaveAttribute('href', '/pick-lists');
  expect(head.querySelector('.dash-head-back')).toContainElement(back);
  cleanup();
  render(<PageHeader title="Order" back={{ label: 'Back to Work Orders', href: '/work-orders' }} />);
  expect(screen.getByRole('link', { name: 'Back to Work Orders' })).toHaveAttribute('href', '/work-orders');
});

test('a ReactNode title, and nothing drawn for what is not given', () => {
  const { container } = render(<PageHeader title={<em>Pick walk</em>} />);
  expect(container.querySelector('h2 em')).toHaveTextContent('Pick walk');
  expect(container.querySelector('.dash-head-actions, .dash-head-back, .dash-description')).toBeNull();
  expect(container.querySelector('.dash-head')).not.toHaveClass('has-actions');
});

test('it wears the same markup as the platform head of a page: the same box and the same title class', () => {
  const platform = render(<DashHead dashboard={{ id: 'p', label: 'Pick walk', description: 'Lists due today' }} />).container;
  const own = render(<PageHeader title="Pick walk" description="Lists due today" />).container;
  const strip = (html: string) => html.replace(/<h[12]/g, '<h').replace(/<\/h[12]>/g, '</h>');
  expect(strip(own.innerHTML)).toBe(strip(platform.innerHTML));
});

test('with verbs it is two regions: the words (title over intro) and, beside them, the verbs', () => {
  // A field report: on a page with no platform head, the verbs stood between the title and its intro, a row of
  // three. The words are one region now, so the verbs wrap under them at a phone and stand beside them at a desk.
  const { container } = render(<PageHeader title="Floor" description="By bay" actions={<button type="button">Week</button>} />);
  const head = container.querySelector('.dash-head')!;
  const regions = [...head.children].map((child) => child.className);
  expect(regions).toEqual(['dash-head-text', 'applist-head-tools dash-head-actions']);
  const words = head.querySelector('.dash-head-text')!;
  expect(words.children[0]).toBe(screen.getByRole('heading', { level: 2, name: 'Floor' }));
  expect(words.children[1]).toHaveClass('dash-description');
});
