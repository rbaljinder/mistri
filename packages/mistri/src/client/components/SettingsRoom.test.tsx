// @vitest-environment happy-dom
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ offered: false }));
vi.mock('@mistriwork/kit/client/components/Prefs.js', () => ({
  PrefsRows: ({ part }: { part?: string }) => <div data-part={part} />,
}));
vi.mock('./AccountProfile.js', () => ({
  AccountProfile: ({ embedded, focus }: { embedded?: boolean; focus?: boolean }) => (
    <div data-profile data-embedded={String(embedded)} data-focus={String(focus)} />
  ),
}));
vi.mock('../appState.js', () => ({ profileIsOffered: () => mocks.offered, activeApp: () => null }));
vi.mock('@mistriwork/kit/client/sessionIdentity.js', () => {
  const identity = { mode: 'authenticated' };
  return { sessionIdentity: () => identity, subscribeSessionIdentity: () => () => {} };
});

const { SettingsRoom } = await import('./SettingsRoom.js');

afterEach(() => {
  cleanup();
  mocks.offered = false;
});

test('the preferences are one region of two sections, each saying what it is about beside its rows', () => {
  render(<SettingsRoom />);
  expect(screen.getByRole('heading', { level: 1, name: 'Settings' })).toBeInTheDocument();
  const preferences = screen.getByRole('region', { name: 'Preferences' });
  const sections = within(preferences).getAllByRole('heading', { level: 2 });
  expect(sections.map((heading) => heading.textContent)).toEqual(['Appearance', 'Reading']);
  expect([...preferences.querySelectorAll('[data-part]')].map((node) => node.getAttribute('data-part'))).toEqual([
    'appearance',
    'language',
    'lists',
  ]);
  // No profile where the session was not offered one.
  expect(document.querySelector('[data-profile]')).toBeNull();
});

test('the profile leads where it is offered, drawn in the page, and takes the focus only when the page is opened at it', () => {
  mocks.offered = true;
  const view = render(<SettingsRoom section="preferences" />);
  const profile = screen.getByRole('region', { name: 'Your profile' });
  expect(profile.querySelector('[data-profile]')).toHaveAttribute('data-embedded', 'true');
  expect(profile.querySelector('[data-profile]')).toHaveAttribute('data-focus', 'false');
  expect(profile.compareDocumentPosition(screen.getByRole('region', { name: 'Preferences' }))).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  view.rerender(<SettingsRoom section="profile" />);
  expect(screen.getByRole('region', { name: 'Your profile' }).querySelector('[data-profile]')).toHaveAttribute('data-focus', 'true');
});
