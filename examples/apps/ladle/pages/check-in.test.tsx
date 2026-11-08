/**
 * The check-in page's reads, drawn as the door sees them: classes to choose from, and, when a read fails, an
 * error with Try again rather than the empty-state sentence a failed read used to fall into.
 */
import '@testing-library/jest-dom/vitest';
import { expect, test } from 'vitest';
import { fixtures, renderPage } from '@mistriwork/mistri/ui/testing';
import page from './check-in.page.tsx';

const viewer = { signedIn: true, account: 'front-desk' };
const commands = { checkIn: { label: 'Check in' } };
const classes = [{ id: 2, title: 'Fresh pasta by hand', starts_at: '2026-09-15T18:30:00Z' }];

/** Fixtures whose named tables cannot be read: the host's read rejects, as a dropped connection's would. */
function unreadable(good: ReturnType<typeof fixtures>, ...broken: string[]) {
  const tables = new Proxy(good.tables, {
    get(target, name) {
      if (typeof name === 'string' && broken.includes(name)) throw new Error(`The ${name} list could not be read.`);
      return Reflect.get(target, name);
    },
  });
  return { ...good, tables };
}

test('draws the classes still to come', async () => {
  const view = renderPage(page, { viewer, commands, data: fixtures({ class_session: classes }) });
  expect(await view.findByRole('button', { name: /^Fresh pasta by hand/ })).toBeInTheDocument();
});

test('with no class to come, it says so', async () => {
  const view = renderPage(page, { viewer, commands, data: fixtures({ class_session: [] }) });
  expect(await view.findByText('No classes coming up')).toBeInTheDocument();
});

test('a class list that cannot be read says so and offers Try again, not "No classes coming up"', async () => {
  const view = renderPage(page, { viewer, commands, data: unreadable(fixtures({ class_session: classes }), 'class_session') });
  expect(await view.findByRole('button', { name: 'Try again' })).toBeInTheDocument();
  expect(view.getByText('The class_session list could not be read.')).toBeInTheDocument();
  expect(view.queryByText('No classes coming up')).toBeNull();
});

test('a guest list that cannot be read offers Try again, not "Everyone is in"', async () => {
  const view = renderPage(page, {
    viewer,
    commands,
    address: { class: '2' },
    data: unreadable(fixtures({ class_session: classes }), 'booking'),
  });
  await view.findAllByRole('button', { name: 'Try again' });
  expect(view.queryByText('Everyone is in')).toBeNull();
});
