/** A public home drawn in the shell: the landing when its answer names the served view, else the public form of that key. */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const answers: Record<string, unknown> = {};
const asked: string[] = [];
vi.mock('../../../../kit/src/client/core.js', () => ({
  api: async (path: string) => {
    asked.push(path);
    if (Object.hasOwn(answers, path)) return answers[path];
    throw Object.assign(new Error('Not found.'), { status: 404 });
  },
}));
vi.mock('../../../../kit/src/client/components/Landing.js', () => ({
  LoadErrorNote: ({ error }: { error: string }) => (error ? <p>{error}</p> : null),
}));
/* What the App draws into the landing is tested with LandingData and viewLink; here, only that the landing is drawn. */
vi.mock('./LandingData.js', () => ({ landingSection: () => null, landingImage: () => undefined }));
vi.mock('../../../../kit/src/client/components/viewLink.js', () => ({ viewLink: () => undefined }));
const { PublicHome } = await import('./PublicHome.js');

const app = { id: 'lending', name: 'Lending' };
function draw(view: string, landingView?: string | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <PublicHome view={view} loadError="" landingView={landingView} />
    </QueryClientProvider>,
  );
}
afterEach(() => {
  cleanup();
  asked.length = 0;
  for (const key of Object.keys(answers)) delete answers[key];
});

test('the landing, when its answer names the served home', async () => {
  answers['/api/landing'] = { app, view: 'welcome', landing: { hero: { heading: 'Finance your next car', actions: [] } } };
  draw('welcome');
  expect(await screen.findByRole('heading', { level: 1, name: 'Finance your next car' })).toBeInTheDocument();
  expect(asked).toEqual(['/api/landing']);
});

test('a public form, when the landing is another view; it is drawn under its label', async () => {
  answers['/api/landing'] = { app, view: 'welcome', landing: { hero: { heading: 'Finance your next car', actions: [] } } };
  answers['/api/forms/finance'] = {
    app,
    form: {
      id: 'finance',
      label: 'Apply for financing',
      input: [{ name: 'name', label: 'Name', type: 'text' }],
      steps: [{ id: 'you', label: 'You', fields: ['name'] }],
    },
  };
  draw('finance');
  expect(await screen.findByRole('heading', { name: 'Apply for financing' })).toBeInTheDocument();
  expect(screen.queryByText('Finance your next car')).toBeNull();
  expect(asked).toEqual(['/api/landing', '/api/forms/finance']);
});

test('a public form home skips the landing probe when the payload names another landing view', async () => {
  answers['/api/forms/finance'] = {
    app,
    form: {
      id: 'finance',
      label: 'Apply for financing',
      input: [{ name: 'name', label: 'Name', type: 'text' }],
      steps: [{ id: 'you', label: 'You', fields: ['name'] }],
    },
  };
  draw('finance', 'welcome');
  expect(await screen.findByRole('heading', { name: 'Apply for financing' })).toBeInTheDocument();
  expect(asked).toEqual(['/api/forms/finance']);
});

test('a public form home skips the landing probe when the payload names no landing', async () => {
  answers['/api/forms/finance'] = {
    app,
    form: {
      id: 'finance',
      label: 'Apply for financing',
      input: [{ name: 'name', label: 'Name', type: 'text' }],
      steps: [{ id: 'you', label: 'You', fields: ['name'] }],
    },
  };
  draw('finance', null);
  expect(await screen.findByRole('heading', { name: 'Apply for financing' })).toBeInTheDocument();
  expect(asked).toEqual(['/api/forms/finance']);
});

test('the landing, when the payload names it as the home', async () => {
  answers['/api/landing'] = { app, view: 'welcome', landing: { hero: { heading: 'Finance your next car', actions: [] } } };
  draw('welcome', 'welcome');
  expect(await screen.findByRole('heading', { level: 1, name: 'Finance your next car' })).toBeInTheDocument();
  expect(asked).toEqual(['/api/landing']);
});

test('a home nothing answers for is said, not drawn blank', async () => {
  draw('gone');
  expect(await screen.findByText(/could not be loaded: Not found\./)).toBeInTheDocument();
});
