import { beforeEach, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../test/shellBridge.js';
import { el } from '../../../kit/src/client/dom.js';

vi.mock('../../../kit/src/client/core.js', () => ({ $: (id: string) => document.getElementById(id), api: vi.fn(), el }));
vi.mock('./appState.js', () => ({ activeApp: () => null }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);

beforeEach(() => {
  document.body.className = '';
  document.body.innerHTML = '<div id="content"></div><div id="db-label"></div>';
});

/* An address that names no App is a wrong address, not an outage: the screen
   says so and lists what is served, never "could not connect to its database". */
test('an address naming no App lists the Apps served instead of blaming the database', async () => {
  const { showAppUnavailable } = await import('./appUnavailable.js');
  const { UnknownAppError } = await import('../../../kit/src/client/requestIdentity.js');
  showAppUnavailable(new UnknownAppError('helpdesk', [{ id: 'help-desk', name: 'Help Desk' }]));
  const content = document.getElementById('content')!;
  expect(content.querySelector('h1')?.textContent).toBe('No App named "helpdesk" here');
  expect(content.textContent).toContain('This server serves one App:');
  expect(content.querySelector('a')?.getAttribute('href')).toBe('/help-desk');
  expect(content.querySelector('li')?.textContent).toBe('Help Desk at /help-desk');
  expect(content.textContent).not.toMatch(/database/);
});

test('an App server that could not open its database still says so', async () => {
  const { showAppUnavailable } = await import('./appUnavailable.js');
  showAppUnavailable();
  expect(document.getElementById('content')!.textContent).toContain('The application could not connect to its database.');
});

/* A row-policy App reloading after a save, or waiting for a restart, answered
   503 with a sentence saying so, and the page said the database was out of
   reach instead. */
test('an App server that says why it is not serving the App is quoted, not blamed on the database', async () => {
  const { showAppUnavailable } = await import('./appUnavailable.js');
  showAppUnavailable(undefined, 'The App changed and is reloading. Try again in a moment.');
  const content = document.getElementById('content')!.textContent;
  expect(content).toContain('The App changed and is reloading. Try again in a moment.');
  expect(content).not.toMatch(/could not connect/);
});

/* A tenant's public address that names no workspace: a stale or
   mistyped link, said as one, with the sign-in beside it — never the database. */
test('a public address that names no workspace says so and offers the sign-in', async () => {
  const { showNoWorkspace } = await import('./appUnavailable.js');
  showNoWorkspace('Desk', '/desk/sign-in');
  const content = document.getElementById('content')!;
  expect(content.querySelector('h1')?.textContent).toBe('No workspace here');
  expect(content.textContent).toContain('No workspace lives at this address.');
  expect(content.querySelector('a')?.getAttribute('href')).toBe('/desk/sign-in');
  expect(content.textContent).not.toMatch(/database|unavailable/i);
});
