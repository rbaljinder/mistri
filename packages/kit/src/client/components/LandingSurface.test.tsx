import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { AppLanding } from '../../../../mistri/src/shared/app.js';
import { actionHref, LandingSurface, safeHref } from './LandingSurface.js';

const landing: AppLanding = {
  hero: {
    heading: 'Finance your next car',
    description: 'Apply in minutes.\n\nA person reads every application.',
    actions: [
      { label: 'Apply for financing', view: 'finance' },
      { label: 'Staff sign in', signIn: true },
    ],
  },
  sections: [
    {
      kind: 'steps',
      title: 'How it works',
      items: [
        { title: 'Apply', description: 'Five minutes.' },
        { title: 'We review', description: 'A desk reads it.' },
      ],
    },
    { kind: 'features', items: [{ title: 'Your licence', description: '<b>not bold</b>' }] },
    { kind: 'faq', title: 'Questions', items: [{ question: 'Is it real?', answer: 'No, a demonstration.' }] },
    { kind: 'text', title: 'About', text: 'One.\n\nTwo.' },
    {
      kind: 'callToAction',
      title: 'Ready?',
      actions: [
        { label: 'Start', view: 'finance' },
        { label: 'Sign in', signIn: true, intent: 'primary' },
      ],
    },
    {
      kind: 'contact',
      title: 'Contact',
      items: [
        { label: 'desk@example.test', href: 'mailto:desk@example.test' },
        { label: 'Not a link', href: 'javascript:alert(1)' },
      ],
    },
  ],
  footer: { text: 'A fictional lender.', links: [{ label: 'Site', href: 'https://example.test' }] },
};
const app = { id: 'ignition', name: 'Ignition' };

afterEach(cleanup);

test('one h1, headings that never skip a level, and every call to action is a link to its route', () => {
  const { container } = render(<LandingSurface landing={landing} app={app} />);
  expect(container.querySelectorAll('h1')).toHaveLength(1);
  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Finance your next car');
  const levels = [...container.querySelectorAll('h1, h2, h3')].map((heading) => Number(heading.tagName[1]));
  for (let i = 1; i < levels.length; i++) expect(levels[i] - levels[i - 1]).toBeLessThanOrEqual(1);
  // A section without a title puts its items at h2, not h3 under nothing.
  expect(screen.getByRole('heading', { name: 'Your licence' }).tagName).toBe('H2');
  expect(screen.getByRole('heading', { name: 'We review' }).tagName).toBe('H3');
  const apply = screen.getByRole('link', { name: 'Apply for financing' });
  expect(apply).toHaveAttribute('href', '/ignition/form/finance');
  expect(apply).toHaveClass('front-action-primary');
  const staff = screen.getByRole('link', { name: 'Staff sign in' });
  expect(staff).toHaveAttribute('href', '/ignition/sign-in');
  expect(staff).toHaveClass('front-action-secondary');
  // An author's kind wins over position.
  expect(screen.getByRole('link', { name: 'Sign in' })).toHaveClass('front-action-primary');
  expect(screen.getByRole('region', { name: 'How it works' })).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'How it works' })).getAllByRole('listitem')).toHaveLength(2);
});

test('author text is text: markup is shown, blank lines are paragraphs, and a bad href is not a link', () => {
  const { container } = render(<LandingSurface landing={landing} app={app} />);
  expect(screen.getByText('<b>not bold</b>')).toBeInTheDocument();
  expect(container.querySelector('b')).toBeNull();
  expect(screen.getByText('A person reads every application.').tagName).toBe('P');
  expect(screen.getByText('Two.').tagName).toBe('P');
  expect(screen.getByRole('link', { name: 'desk@example.test' })).toHaveAttribute('href', 'mailto:desk@example.test');
  expect(screen.queryByRole('link', { name: 'Not a link' })).toBeNull();
  expect(screen.getByText('Not a link').tagName).toBe('SPAN');
  expect(container.querySelector('a[href^="javascript"]')).toBeNull();
  expect(screen.getByText('A fictional lender.').closest('footer')).not.toBeNull();
});

test('the FAQ is the house accordion: a disclosure button per question, the answer in the region it opens', async () => {
  render(<LandingSurface landing={landing} app={app} />);
  const question = screen.getByRole('button', { name: 'Is it real?' });
  expect(question).toHaveAttribute('aria-expanded', 'false');
  // Under a titled section the question is an h3, so the outline never skips.
  expect(screen.getByRole('heading', { level: 3, name: 'Is it real?' })).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: 'Is it real?' })).toBeNull();
  await userEvent.setup().click(question);
  expect(question).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByRole('region', { name: 'Is it real?' })).toHaveTextContent('No, a demonstration.');
});

/* In an App the public reads, the landing's data sections and its calls to
   action that open a view are the App's to draw; LandingSurface asks. */
const browsing: AppLanding = {
  hero: {
    heading: 'Find your next car',
    actions: [
      { label: 'Browse vehicles', view: 'vehicles' },
      { label: 'Ask a dealer', view: 'inquire' },
    ],
  },
  sections: [
    { kind: 'search', title: 'Search', view: 'vehicles', filters: ['make'] },
    { kind: 'view', title: 'Recommended', view: 'recommended', limit: 6 },
  ],
};

test("a call to action that opens a view takes the App's address and is followed in place; a form keeps its own", async () => {
  const onClick = vi.fn((event) => event.preventDefault());
  const openView = (view: string) => (view === 'vehicles' ? { href: '/forecourt/vehicles:vehicle', onClick } : undefined);
  render(<LandingSurface landing={browsing} app={{ id: 'forecourt', name: 'Forecourt' }} openView={openView} />);
  const browse = screen.getByRole('link', { name: 'Browse vehicles' });
  expect(browse).toHaveAttribute('href', '/forecourt/vehicles:vehicle');
  await userEvent.setup().click(browse);
  expect(onClick).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('link', { name: 'Ask a dealer' })).toHaveAttribute('href', '/forecourt/form/inquire');
});

test('the sections that read rows are drawn by the host, under their titles; without one, they are not there at all', () => {
  const renderSection = (section: AppLanding['sections'] extends (infer S)[] | undefined ? S : never) =>
    section.kind === 'view' ? <p>cards of {section.view}</p> : section.kind === 'search' ? <form aria-label="Search vehicles" /> : null;
  const { unmount } = render(
    <LandingSurface landing={browsing} app={{ id: 'forecourt', name: 'Forecourt' }} renderSection={renderSection} />,
  );
  expect(within(screen.getByRole('region', { name: 'Recommended' })).getByText('cards of recommended')).toBeInTheDocument();
  expect(within(screen.getByRole('region', { name: 'Search' })).getByRole('form', { name: 'Search vehicles' })).toBeInTheDocument();
  unmount();
  render(<LandingSurface landing={browsing} app={{ id: 'forecourt', name: 'Forecourt' }} />);
  expect(screen.queryByRole('heading', { name: 'Recommended' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Search' })).toBeNull();
});

test('hrefs: routes are encoded, and only three schemes pass', () => {
  expect(actionHref('my app', { label: 'Apply', view: 'finance' })).toBe('/my%20app/form/finance');
  expect(actionHref('ignition', { label: 'In', signIn: true })).toBe('/ignition/sign-in');
  for (const href of ['https://example.test', 'mailto:a@example.test', 'tel:+12025550142']) expect(safeHref(href)).toBe(href);
  for (const href of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'http://example.test'])
    expect(safeHref(href)).toBeUndefined();
});

const withHero: AppLanding = {
  hero: {
    heading: 'Find your next car',
    description: 'Sixty cars.',
    actions: [{ label: 'Browse', view: 'vehicles' }],
    image: { from: 'site_image', key: 1, alt: 'Three cars in the studio' },
    layout: 'overlay',
    search: { view: 'vehicles', filters: ['make'] },
    highlights: ['60 cars', '6 dealers'],
  },
};
const searchForm = (section: AppLanding['sections'] extends (infer S)[] | undefined ? S : never) =>
  section.kind === 'search' ? <form aria-label={`Search ${section.view}`} /> : null;

test('a hero with a photo: the photo with its alt text, the layout named, the search inside, the highlights one line', () => {
  render(
    <LandingSurface
      landing={withHero}
      app={{ id: 'forecourt', name: 'Forecourt' }}
      imageSrc={() => '/api/file?key=1&inline=1'}
      renderSection={searchForm}
    />,
  );
  const hero = screen.getByRole('region', { name: 'Find your next car' });
  expect(hero).toHaveClass('front-hero-overlay');
  expect(within(hero).getByRole('img', { name: 'Three cars in the studio' })).toHaveAttribute('src', '/api/file?key=1&inline=1');
  expect(within(hero).getByRole('form', { name: 'Search vehicles' })).toBeInTheDocument();
  expect(
    within(hero)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['60 cars', '6 dealers']);
  // The words stay one heading and one lede, whatever the layout.
  expect(within(hero).getByRole('heading', { level: 1 })).toHaveTextContent('Find your next car');
});

test('a photo without a layout is split; without a host there is no photo, no search and no layout, only the words', () => {
  const split = { hero: { ...withHero.hero, layout: undefined } };
  const { unmount } = render(<LandingSurface landing={split} app={{ id: 'forecourt', name: 'Forecourt' }} imageSrc={() => '/x.png'} />);
  expect(screen.getByRole('region', { name: 'Find your next car' })).toHaveClass('front-hero-split');
  unmount();
  render(<LandingSurface landing={withHero} app={{ id: 'forecourt', name: 'Forecourt' }} />);
  const hero = screen.getByRole('region', { name: 'Find your next car' });
  expect(hero.className).toBe('front-hero');
  expect(within(hero).queryByRole('img')).toBeNull();
  expect(within(hero).queryByRole('form')).toBeNull();
  expect(within(hero).getByText('60 cars')).toBeInTheDocument();
});

test('photo tiles in a mosaic, a badge over the heading, and icon rows under the actions', () => {
  const blocks: AppLanding = {
    hero: {
      heading: 'Finance your next car',
      actions: [{ label: 'Apply', view: 'finance' }],
      tiles: [
        { from: 'site_image', key: 1, alt: 'Three cars in the studio' },
        { from: 'site_image', key: 2, alt: 'The forecourt at dusk' },
        { from: 'site_image', key: 3, alt: 'A dealer’s desk' },
      ],
      badge: { text: 'Decisions in minutes', icon: 'lightning' },
      points: [
        { icon: 'shield-check', text: 'No effect on your credit score' },
        { icon: 'clock', text: 'Five minutes to apply' },
      ],
    },
  };
  const { unmount } = render(
    <LandingSurface
      landing={blocks}
      app={{ id: 'forecourt', name: 'Forecourt' }}
      imageSrc={(image) => `/api/file?key=${String(image.key)}`}
    />,
  );
  const hero = screen.getByRole('region', { name: 'Finance your next car' });
  expect(hero).toHaveClass('front-hero-split');
  const images = within(hero).getAllByRole('img');
  expect(images.map((image) => image.getAttribute('alt'))).toEqual([
    'Three cars in the studio',
    'The forecourt at dusk',
    'A dealer’s desk',
  ]);
  expect(images[0].closest('.front-hero-tiles')).toHaveClass('front-hero-tiles-3');
  expect(images[0]).toHaveAttribute('fetchpriority', 'high');
  expect(images[1]).toHaveAttribute('loading', 'lazy');
  // The badge comes before the one heading, so the heading still opens the region's words.
  const badge = within(hero).getByText('Decisions in minutes');
  expect(badge.closest('.front-badge')?.compareDocumentPosition(within(hero).getByRole('heading', { level: 1 }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(
    within(hero)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['No effect on your credit score', 'Five minutes to apply']);
  unmount();
  // A tile without an address: no mosaic with a hole in it, and no layout; the words, badge and rows stay.
  render(
    <LandingSurface
      landing={blocks}
      app={{ id: 'forecourt', name: 'Forecourt' }}
      imageSrc={(image) => (image.key === 2 ? undefined : `/api/file?key=${String(image.key)}`)}
    />,
  );
  const bare = screen.getByRole('region', { name: 'Finance your next car' });
  // With no photo the points stand beside the words, after them in the reading order: a desk sets them opposite.
  expect(bare.className).toBe('front-hero front-hero-beside');
  expect(within(bare).queryByRole('img')).toBeNull();
  expect(within(bare).getByText('Decisions in minutes')).toBeInTheDocument();
  const points = within(bare).getByText('Five minutes to apply').closest('.front-hero-points');
  expect(points?.previousElementSibling).toHaveClass('front-hero-text');
  expect(within(bare).getByRole('link', { name: 'Apply' }).compareDocumentPosition(points!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});
