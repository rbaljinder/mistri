import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { DashboardNote } from './DashboardNote.js';
import { ListNavigationProvider } from './listNavigation.js';
import { configureAppTargetLinks } from '../../../../mistri/src/client/appTargetLinks.js';
import { establishSessionIdentity, lockSessionIdentity } from '../sessionIdentity.js';
import { installShell, shell } from '../shellMode.js';
import { AppTargetAction } from '../../../../mistri/src/client/components/AppTargetAction.js';

const viewLink = vi.fn((view: string) => (view === 'benefits' ? { href: '/payday/benefits' } : undefined));
const withNavigation = (tree: ReactNode) => <ListNavigationProvider navigate={viewLink}>{tree}</ListNavigationProvider>;

/* A call to action into another App is the App shell's to draw (appnav.js names it). */
beforeEach(() => installShell({ slots: { ...shell().slots, TargetAction: AppTargetAction } }));
afterEach(() => {
  cleanup();
  viewLink.mockClear();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
});

test('draws authored guidance in reading order, with a curated icon and an available view action', () => {
  const { container } = render(
    withNavigation(
      <DashboardNote
        title="Benefits"
        icon="shield-check"
        text={'Choose coverage during enrollment.\n\nChanges take effect next month.'}
        action={{ label: 'View benefits', view: 'benefits' }}
      />,
    ),
  );
  expect(container.querySelector('.dashboard-note-icon')).toHaveAttribute('aria-hidden', 'true');
  expect(screen.getByRole('heading', { name: 'Benefits' })).toBeInTheDocument();
  expect(screen.getByText('Choose coverage during enrollment.')).toBeInTheDocument();
  expect(screen.getByText('Changes take effect next month.')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'View benefits' })).toHaveAttribute('href', '/payday/benefits');
  expect(viewLink).toHaveBeenCalledWith('benefits');
});

test('hides an action whose view is unavailable, without adding empty chrome', () => {
  const { container } = render(
    withNavigation(<DashboardNote text="Enrollment is closed." action={{ label: 'Manage benefits', view: 'restricted' }} />),
  );
  expect(screen.queryByRole('link')).toBeNull();
  expect(container.querySelector('.dashboard-note-icon')).toBeNull();
  expect(screen.queryByRole('heading')).toBeNull();
});

test('cross-App note resolves an external native link without calling local navigation', async () => {
  lockSessionIdentity();
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'leads' });
  configureAppTargetLinks({ basePath: '', appId: 'leads' });
  const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/work' }) });
  vi.stubGlobal('fetch', fetcher);
  render(
    withNavigation(
      <DashboardNote text="Continue" action={{ label: 'Lender', to: { app: 'lender', kind: 'view', view: 'applications' } }} />,
    ),
  );
  expect(await screen.findByRole('link', { name: 'Lender' })).toHaveAttribute('href', '/work');
  expect(viewLink).not.toHaveBeenCalled();
});
