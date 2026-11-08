import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({
  switcher: vi.fn(),
  choose: vi.fn(),
  follow: vi.fn(),
}));
vi.mock('../../../../kit/src/client/components/sidebarModel.js', () => ({
  workspaceSwitcher: mocks.switcher,
  chooseWorkspace: mocks.choose,
  subscribeSidebar: () => () => {},
}));
vi.mock('../../../../kit/src/client/core.js', () => ({
  subscribeWalk: () => () => {},
  viewportBox: (element: Element) => element.getBoundingClientRect(),
}));
/* A link per view, as viewLink answers for a list or a dashboard this reader is served. */
vi.mock('../../../../kit/src/client/components/viewLink.js', () => ({
  viewLink: (key: string) =>
    key === 'assistant' ? undefined : { href: `/desk/${key}`, onClick: (event: Event) => (event.preventDefault(), mocks.follow(key)) },
}));

const { WorkspaceSwitcher } = await import('./WorkspaceSwitcher.js');

const room = (id: string, label: string, error?: string) => ({
  kind: 'destination' as const,
  entry: { id, label, table: id, ...(error ? { error } : {}) },
});
const desk = {
  id: 'desk',
  label: 'Service desk',
  icon: 'lifebuoy',
  children: [room('assistant', 'Assistant'), room('tickets', 'Tickets')],
};
const crm = { id: 'crm', label: 'CRM', children: [room('broken', 'Broken', 'No table.'), room('leads', 'Leads')] };
const app = { name: 'Two products', nav: [], views: {}, resources: {} } as never;

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

test('draws each workspace as a link in declared order to its first room with an address, the current one marked', () => {
  mocks.switcher.mockReturnValue({ spaces: [desk, crm], current: 'crm' });
  render(<WorkspaceSwitcher app={app} variant="header" />);
  const nav = screen.getByRole('navigation', { name: 'Workspaces' });
  const links = [...nav.querySelectorAll('a')];
  expect(links.map((link) => [link.textContent, link.getAttribute('href')])).toEqual([
    ['Service desk', '/desk/tickets'],
    ['CRM', '/desk/leads'],
  ]);
  expect(links.map((link) => link.getAttribute('aria-current'))).toEqual([null, 'page']);
  expect(links.map((link) => link.getAttribute('data-fold'))).toEqual(['0', '1']);
});

test('on a phone the workspaces are a list, one row each, the current marked', () => {
  mocks.switcher.mockReturnValue({ spaces: [desk, crm], current: 'desk' });
  render(<WorkspaceSwitcher app={app} variant="drawer" />);
  const items = screen.getAllByRole('listitem');
  expect(items.map((item) => item.textContent)).toEqual(['Service desk', 'CRM']);
  expect(items.map((item) => item.querySelector('a')?.getAttribute('aria-current'))).toEqual(['page', null]);
  expect(screen.getByRole('navigation', { name: 'Workspaces' }).querySelector('[data-fold]')).toBeNull();
});

test('a plain click chooses the workspace before following the link; a modified click is left to the browser', async () => {
  mocks.switcher.mockReturnValue({ spaces: [desk, crm], current: 'desk' });
  const onChoose = vi.fn();
  render(<WorkspaceSwitcher app={app} variant="drawer" onChoose={onChoose} />);
  await userEvent.click(screen.getByRole('link', { name: 'CRM' }));
  expect(mocks.choose).toHaveBeenCalledWith(app, 'crm');
  expect(mocks.follow).toHaveBeenCalledWith('leads');
  expect(onChoose).toHaveBeenCalledOnce();
  mocks.choose.mockClear();
  fireEvent.click(screen.getByRole('link', { name: 'Service desk' }), { metaKey: true });
  expect(mocks.choose).not.toHaveBeenCalled();
});

test('draws nothing for one workspace, or none', () => {
  mocks.switcher.mockReturnValue(null);
  const { container } = render(<WorkspaceSwitcher app={app} variant="header" />);
  expect(container).toBeEmptyDOMElement();
});
