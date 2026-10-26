import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { Badge, IconRows, PhotoTiles } from './HeroBlocks.js';

afterEach(cleanup);

const photo = (n: number) => ({ src: `/p${n}.jpg`, alt: `Photo ${n}`, srcSet: `/p${n}.jpg 1x`, sizes: '50vw' });

test('a badge is a pill of words, with the icon before them when there is one', () => {
  const { container } = render(<Badge icon={<svg data-testid="mark" />}>Open to new clients</Badge>);
  const pill = container.querySelector('p.front-badge')!;
  expect(pill).toHaveTextContent('Open to new clients');
  expect(pill.firstElementChild).toBe(screen.getByTestId('mark'));
  cleanup();
  const bare = render(<Badge>Just words</Badge>).container.querySelector('p.front-badge')!;
  expect(bare.querySelector('svg')).toBeNull();
});

test.each([2, 3, 4])('%i tiles make a mosaic of that many, the first awaited and the rest lazy', (n) => {
  const { container } = render(<PhotoTiles tiles={Array.from({ length: n }, (_, i) => photo(i + 1))} />);
  const box = container.firstElementChild!;
  expect(box).toHaveClass('front-hero-media', 'front-hero-tiles', `front-hero-tiles-${n}`);
  const images = box.querySelectorAll('img');
  expect(images).toHaveLength(n);
  expect(images[0]).toHaveAttribute('fetchpriority', 'high');
  expect(images[0]).not.toHaveAttribute('loading');
  for (const image of [...images].slice(1)) {
    expect(image).toHaveAttribute('loading', 'lazy');
    expect(image).not.toHaveAttribute('fetchpriority');
  }
  for (const image of images) expect(image).toHaveAttribute('decoding', 'async');
  expect(images[0]).toHaveAttribute('srcset', '/p1.jpg 1x');
  expect(images[0]).toHaveAttribute('sizes', '50vw');
  expect(images[0]).toHaveAttribute('alt', 'Photo 1');
});

test('one photo is no mosaic, and a fifth is cut off', () => {
  expect(render(<PhotoTiles tiles={[photo(1)]} />).container).toBeEmptyDOMElement();
  cleanup();
  expect(render(<PhotoTiles tiles={[]} />).container).toBeEmptyDOMElement();
  cleanup();
  const { container } = render(<PhotoTiles tiles={[1, 2, 3, 4, 5].map(photo)} />);
  expect(container.querySelectorAll('img')).toHaveLength(4);
  expect(container.firstElementChild).toHaveClass('front-hero-tiles-4');
});

test('icon rows are a list of an icon and a line, four at most', () => {
  const rows = ['One', 'Two', 'Three', 'Four', 'Five'].map((text) => ({ icon: <svg data-testid="row-icon" />, text }));
  const { container } = render(<IconRows rows={rows} />);
  const list = container.querySelector('ul.front-points')!;
  const items = list.querySelectorAll('li');
  expect(items).toHaveLength(4);
  expect(items[0].firstElementChild).toBe(screen.getAllByTestId('row-icon')[0]);
  expect(items[0]).toHaveTextContent('One');
  expect(list).not.toHaveTextContent('Five');
});

test('no rows draw no list', () => {
  expect(render(<IconRows rows={[]} />).container).toBeEmptyDOMElement();
});
