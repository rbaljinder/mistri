import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { setMessageLanguage, setMessageScope } from '../messages.js';
import { ListEmpty } from './ListEmpty.js';
import { ListNavigationProvider } from './listNavigation.js';

afterEach(() => {
  cleanup();
  setMessageLanguage('en');
  setMessageScope();
});

// The server says an App's captions in the reader's language (server/app/appMessages.ts);
// the client draws the words it was served, and a chrome language switch must not
// remount the empty state or lose the work around it.
test('served copy draws as given and a chrome language switch preserves surrounding drafts', () => {
  setMessageScope('localized-empty-test');
  setMessageLanguage('en');
  render(
    <ListNavigationProvider navigate={() => ({ href: '/example/tasks' })}>
      <input aria-label="Draft" defaultValue="Unsaved work" />
      <ListEmpty
        spec={{ title: 'Aún no hay tareas', description: 'Asigna una tarea para empezar.', action: { label: 'Ver tareas', view: 'tasks' } }}
      />
    </ListNavigationProvider>,
  );
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();
  act(() => setMessageLanguage('es'));
  expect(screen.getByText('Aún no hay tareas')).toBeVisible();
  expect(screen.getByRole('link', { name: 'Ver tareas' })).toHaveAttribute('href', '/example/tasks');
  expect(screen.getByText('Asigna una tarea para empezar.')).toBeVisible();
  expect(draft).toHaveValue('Unsaved work');
  expect(draft).toHaveFocus();
});
