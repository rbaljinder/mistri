/**
 * The New menu's lines as the palette lists them: a list's line is the verb its button says, a form's line is the
 * command's own words, and both are found by typing "new …".
 */
import { expect, test, vi } from 'vitest';

const went: unknown[] = [];
vi.mock('../core.js', () => ({
  state: { schema: undefined },
  findTable: (id: string) => ({ id, name: id, schema: '', isView: false, columns: [] }),
  go: (...args: unknown[]) => went.push(args),
  pageView: (...args: unknown[]) => ({ kind: 'page', args }),
  tableView: (...args: unknown[]) => ({ kind: 'table', args }),
}));
vi.mock('../insert.js', () => ({ canInsert: () => true }));

const { newPaletteItems } = await import('./newMenuModel.js');
const { score } = await import('./paletteModel.js');

const app = {
  views: {
    leases: { label: 'Leases', table: 'lease' },
    postRent: { label: 'Post rent', command: { id: 'postRent' } },
  },
  nav: [],
  resources: {},
  home: undefined,
  grantedCommands: ['postRent'],
  ui: {
    shell: {
      new: [
        { view: 'leases', label: 'Lease', icon: 'receipt' },
        { view: 'postRent', label: 'Post this month’s rent', command: 'postRent', icon: 'wrench' },
      ],
    },
  },
} as unknown as Parameters<typeof newPaletteItems>[0];

test('a list says "New lease" and a form says its command’s own words, each with its mark', () => {
  const items = newPaletteItems(app);
  expect(items.map((item) => [item.kind, item.label, item.icon])).toEqual([
    ['create', 'New lease', 'receipt'],
    ['create', 'Post this month’s rent', 'wrench'],
  ]);
});

test('both are found by typing "new", and the form by its own words', () => {
  const [lease, rent] = newPaletteItems(app);
  expect(score(lease.search, 'new lease')).toBeGreaterThan(0);
  expect(score(rent.search, 'post this')).toBeGreaterThan(0);
  expect(score(rent.search, 'new post this')).toBeGreaterThan(0);
  // Said as a verb, not as "New post this month’s rent".
  expect(rent.label).not.toMatch(/^New /);
});

test('opening a line goes where the menu’s button goes', () => {
  const [lease, rent] = newPaletteItems(app);
  lease.run();
  rent.run();
  expect(went).toHaveLength(2);
  expect(went[0]).toMatchObject([{ kind: 'table', view: 'leases' }, 'reset']);
  expect(went[1]).toMatchObject([{ kind: 'page' }, 'reset']);
});

test('with no New menu declared, each table its lists show offers its New, once, in the menu’s order', () => {
  const bare = {
    ...app,
    views: {
      visits: { label: 'Visits', table: 'visit', kind: 'list' },
      jobs: { label: 'Jobs', table: 'job', kind: 'list' },
      openJobs: { label: 'Open jobs', table: 'job', kind: 'list' },
      postRent: { label: 'Post rent', command: { id: 'postRent' } },
    },
    nav: [{ view: 'jobs' }, { view: 'visits' }],
    ui: {},
  } as unknown as Parameters<typeof newPaletteItems>[0];
  const items = newPaletteItems(bare);
  expect(items.map((item) => [item.kind, item.label])).toEqual([
    ['create', 'New job'],
    ['create', 'New visit'],
  ]);
  expect(score(items[1].search, 'new visit')).toBeGreaterThan(0);
});
