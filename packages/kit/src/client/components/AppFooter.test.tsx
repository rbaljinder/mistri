import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { AppFooter } from './AppFooter.js';

afterEach(() => cleanup());

test('a footer draws its small print and its links', () => {
  render(
    <AppFooter
      footer={{
        text: 'Prices exclude tax.',
        links: [
          { label: 'Terms', href: 'https://example.invalid/terms' },
          { label: 'Contact', href: 'mailto:sales@example.invalid' },
        ],
      }}
    />,
  );
  expect(screen.getByText('Prices exclude tax.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Terms' }).getAttribute('href')).toBe('https://example.invalid/terms');
  expect(screen.getByRole('link', { name: 'Contact' }).getAttribute('href')).toBe('mailto:sales@example.invalid');
});

/* The parser already holds a link to https:, mailto: and tel:, and this says
   it again at the last moment an href can do harm: a scheme that got this far
   is drawn as its label and never becomes a link. */
test('a link whose scheme is not allowed is drawn as text, not as a link', () => {
  render(<AppFooter footer={{ links: [{ label: 'Nope', href: 'javascript:alert(1)' }] }} />);
  expect(screen.queryByRole('link', { name: 'Nope' })).toBeNull();
  expect(screen.getByText('Nope')).toBeTruthy();
});

/* An App that declares `ui.footer` but leaves it empty gets no rule across
   the bottom of every room: nothing to say, nothing drawn. */
test('a footer with neither text nor links draws nothing', () => {
  const { container } = render(<AppFooter footer={{}} />);
  expect(container.querySelector('.app-footer')).toBeNull();
});

test("markup in the author's text is shown, never run", () => {
  render(<AppFooter footer={{ text: '<b>bold</b> & plain' }} />);
  expect(screen.getByText('<b>bold</b> & plain')).toBeTruthy();
  expect(document.querySelector('.app-footer-text b')).toBeNull();
});
