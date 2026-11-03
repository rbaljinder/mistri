import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { Icon, loadIconsWith, onUnknownIcon, registerIcons, weighIconsWith, type IconGlyph } from './Icon.js';

afterEach(cleanup);

const dot: IconGlyph = [['M0 0h1'], ['M0 0h2']];
const ring: IconGlyph = [['M1 1h1'], ['M1 1h2']];
const paths = (svg: Element) => [...svg.querySelectorAll('path')].map((path) => path.getAttribute('d'));

test('a registered glyph draws regular, or bold when asked, in a labelled or decorative box', () => {
  registerIcons({ dot });
  const { container, rerender } = render(<Icon name="dot" size={16} />);
  const svg = container.querySelector('svg')!;
  expect(paths(svg)).toEqual(['M0 0h1']);
  expect(svg).toHaveAttribute('aria-hidden', 'true');
  expect(svg).toHaveAttribute('width', '16');
  expect(svg).toHaveClass('mistri-icon');
  rerender(<Icon name="dot" weight="bold" label="Dot" />);
  expect(paths(screen.getByRole('img', { name: 'Dot' }))).toEqual(['M0 0h2']);
});

test('a name not yet known keeps its box and draws once the loader brings it', async () => {
  loadIconsWith(async () => ({ ring }));
  const { container } = render(<Icon name="ring" size={20} />);
  const svg = container.querySelector('svg')!;
  expect(svg).toHaveAttribute('width', '20');
  await waitFor(() => expect(paths(svg)).toEqual(['M1 1h1']));
});

test("the page's weight draws an icon that names none; one that names its own keeps it", () => {
  registerIcons({ dot });
  weighIconsWith({
    weight: () => 'fill',
    drawing: (name) => (name === 'dot' ? ['M9 9'] : undefined),
    subscribe: () => () => {},
    version: () => 1,
  });
  try {
    const { container } = render(
      <>
        <Icon name="dot" />
        <Icon name="dot" weight="bold" />
      </>,
    );
    const [weighed, own] = [...container.querySelectorAll('svg')];
    expect(paths(weighed!)).toEqual(['M9 9']);
    expect(paths(own!)).toEqual(['M0 0h2']);
  } finally {
    weighIconsWith({ weight: () => 'regular', drawing: () => undefined, subscribe: () => () => {}, version: () => 0 });
  }
});

/* A name that names no glyph drew an empty box, and nothing said so: a custom component's misspelt icon was found by
   looking. Once every glyph is in, the page is told the name once, with the names there are, and may draw another. */
test('a name that names no glyph, once every glyph is in, is told once and may draw another instead', async () => {
  const told: string[] = [];
  onUnknownIcon((name, names) => {
    told.push(`${name}: ${names.includes('ring') ? 'ring among them' : 'no ring'}`);
    return 'dot';
  });
  registerIcons({ dot });
  loadIconsWith(async () => ({ ring }));
  const { container } = render(
    <>
      <Icon name="rnig" />
      <Icon name="rnig" />
    </>,
  );
  const [first, second] = container.querySelectorAll('svg');
  await waitFor(() => expect(paths(first)).toEqual(['M0 0h1']));
  expect(paths(second)).toEqual(['M0 0h1']);
  expect(told).toEqual(['rnig: ring among them']);
  onUnknownIcon(undefined);
});
