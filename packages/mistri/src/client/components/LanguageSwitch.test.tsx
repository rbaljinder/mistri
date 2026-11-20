import { afterEach, expect, test } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { localeCookieName } from '@mistriwork/engine/shared/appLocale.js';
import { holdAppWords } from '@mistriwork/kit/client/messages.js';
import { addressIn, LanguageSwitch } from './LanguageSwitch.js';

afterEach(() => {
  cleanup();
  holdAppWords(undefined);
  document.cookie = `${localeCookieName('clinic')}=; path=/; max-age=0`;
  window.history.replaceState(null, '', '/');
});

test('an App with one catalog, or none, draws no switch', () => {
  const { container, rerender } = render(<LanguageSwitch appId="clinic" languages={undefined} />);
  expect(container.innerHTML).toBe('');
  rerender(<LanguageSwitch appId="clinic" languages={{ offered: ['en'], locale: 'en' }} />);
  expect(container.innerHTML).toBe('');
});

test('two catalogs: each named in itself, the current one marked, every choice a ?locale= address', () => {
  window.history.replaceState(null, '', '/clinic/form/intake?via=north');
  holdAppWords({ 'mistri.language': 'Idioma' });
  render(<LanguageSwitch appId="clinic" languages={{ offered: ['en', 'es'], locale: 'es' }} />);
  const nav = screen.getByRole('navigation', { name: 'Idioma' });
  const links = [...nav.querySelectorAll('a')];
  expect(links.map((link) => link.textContent)).toEqual(['English', 'Español']);
  expect(links.map((link) => link.getAttribute('lang'))).toEqual(['en', 'es']);
  expect(links[1]!.getAttribute('aria-current')).toBe('true');
  expect(links[0]!.hasAttribute('aria-current')).toBe(false);
  // The tenant's intake address rides along: a pick never drops the visitor into another tenant's form.
  expect(new URLSearchParams(links[0]!.getAttribute('href')!.slice(1)).get('via')).toBe('north');
  expect(new URLSearchParams(links[0]!.getAttribute('href')!.slice(1)).get('locale')).toBe('en');
});

test('a pick keeps the App language cookie, so the reload and the next visit open in it', () => {
  render(<LanguageSwitch appId="clinic" languages={{ offered: ['en', 'es'], locale: 'en' }} />);
  const spanish = screen.getByText('Español');
  // The click is not prevented: the link itself is the reload with ?locale=.
  expect(fireEvent.click(spanish)).toBe(true);
  expect(document.cookie).toContain(`${localeCookieName('clinic')}=es`);
});

test('addressIn replaces a locale already in the address and keeps the rest', () => {
  expect(addressIn('es', '?via=north&locale=en')).toBe('?via=north&locale=es');
  expect(addressIn('en', '')).toBe('?locale=en');
});
