/**
 * A free-form page's room: a bare page (`layout: 'bare'`) takes the shell's bars away while it is the room and gives
 * them back when it leaves; every other page leaves the shell as it is. Its title stays for a screen reader either way.
 */
import { afterEach, expect, test } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { FreePage } from './FreePage.js';
import type { DashboardDef } from '@mistriwork/kit/client/components/dashboardModel.js';

afterEach(cleanup);

const dashboard = (change: Partial<DashboardDef>): DashboardDef =>
  ({ id: 'kiosk', label: 'Kiosk', sections: [], ...change }) as unknown as DashboardDef;
const page = { reads: [], commands: [], params: [] };

test('a bare page wears page-bare on the body while it is drawn, and keeps its title for a screen reader', () => {
  const view = render(<FreePage dashboard={dashboard({ layout: 'bare', head: 'own', headingHidden: true })} page={page} />);
  expect(document.body).toHaveClass('page-bare');
  expect(screen.getByRole('heading', { level: 1, name: 'Kiosk' })).toHaveClass('visually-hidden');
  expect(document.querySelector('.free-page-body')).toHaveClass('is-bare');
  view.unmount();
  expect(document.body).not.toHaveClass('page-bare');
});

test('a page that says no layout leaves the shell its bars', () => {
  render(<FreePage dashboard={dashboard({})} page={page} />);
  expect(document.body).not.toHaveClass('page-bare');
  expect(document.querySelector('.free-page-body')).not.toHaveClass('is-bare');
});
