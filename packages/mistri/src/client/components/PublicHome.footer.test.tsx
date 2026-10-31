/**
 * One footer per surface. A landing drawn as the content pane's home sits inside Content, which puts the App's footer
 * under every room; the landing must not draw a second. Composed from the real Content, PublicHome, LandingSurface
 * and AppFooter, because each alone draws its footer correctly.
 */
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { installShell, shell } from '../../../../kit/src/client/shellMode.js';

const footer = { text: 'Rates are indicative.', links: [{ label: 'Privacy', href: 'https://example.test/privacy' }] };
const app = { id: 'lending', name: 'Lending' };
const landing = { hero: { heading: 'Finance your next car', actions: [] }, footer };

vi.mock('../../../../kit/src/client/core.js', async (original) => ({
  ...(await original<object>()),
  api: async (path: string) => {
    if (path === '/api/landing') return { app, view: 'welcome', landing };
    throw Object.assign(new Error('Not found.'), { status: 404 });
  },
}));
vi.mock('../appState.js', () => ({
  activeApp: () => ({ id: 'lending', name: 'Lending', home: 'welcome', views: {}, nav: [], ui: { footer } }),
  appLoadError: () => '',
  inAppMode: () => true,
}));
vi.mock('../../../../kit/src/client/dashboard.js', () => ({ dashboardEntry: () => null }));
vi.mock('../../../../kit/src/client/url.js', () => ({ syncHash: () => {} }));
vi.mock('./LandingData.js', () => ({ landingSection: () => null, landingImage: () => undefined }));
vi.mock('../../../../kit/src/client/components/viewLink.js', () => ({ viewLink: () => undefined }));
vi.mock('../../../../kit/src/client/components/Crumbs.js', () => ({ Crumbs: () => null }));
vi.mock('../../../../kit/src/client/components/Rooms.js', () => ({
  AppListRoom: () => <p>a list</p>,
  DashboardRoom: () => null,
  RowRoom: () => <p>a record</p>,
}));

const core = await import('../../../../kit/src/client/core.js');
const { Content } = await import('../../../../kit/src/client/components/Content.js');
const { PublicHome } = await import('./PublicHome.js');

beforeEach(async () => {
  await bridgeShell();
  installShell({
    rooms: { ...shell().rooms, Home: () => <PublicHome view="welcome" loadError="" /> },
  });
  core.state.activeConnection = 'lending';
  core.state.schema = { tables: [], foreignKeys: [] };
});
afterEach(() => cleanup());

const draw = () => {
  core.render();
  return render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Content onHome={() => {}} />
    </QueryClientProvider>,
  );
};

test('a landing as the signed-in home shows one footer, the App', async () => {
  core.state.stack = [];
  const { container } = draw();
  await screen.findByRole('heading', { level: 1, name: 'Finance your next car' });
  expect(container.querySelectorAll('footer')).toHaveLength(1);
  expect(container.querySelectorAll('.app-footer')).toHaveLength(1);
  expect(container.querySelector('.front-footer')).toBeNull();
  expect(screen.getAllByRole('link', { name: 'Privacy' })).toHaveLength(1);
});

test('a record keeps the App footer', () => {
  core.state.stack = [core.rowView('invoice', { id: 1 }, '1')];
  const { container } = draw();
  expect(container.querySelectorAll('.app-footer')).toHaveLength(1);
});

test('a standalone landing keeps its own footer', async () => {
  const { LandingSurface } = await import('../../../../kit/src/client/components/LandingSurface.js');
  const { container } = render(<LandingSurface landing={landing} app={app} />);
  expect(container.querySelectorAll('.front-footer')).toHaveLength(1);
  expect(container.querySelectorAll('.app-footer')).toHaveLength(0);
});
