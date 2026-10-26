import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import {
  appNavTargetHrefs,
  appNavTargetKey,
  localAppNavTarget,
  navTargets,
  refreshAppNavTargets,
  useAppNavTargets,
  type NavTargetApp,
} from './appNavTargets.js';
import { appMenu } from '../../../kit/src/client/components/appRooms.js';
import { configureAppTargetLinks } from './appTargetLinks.js';
import {
  establishSessionIdentity,
  establishTenantSelection,
  lockSessionIdentity,
  requireTenantSelection,
} from '../../../kit/src/client/sessionIdentity.js';
import { appMounts, outward } from '../../../engine/src/shared/mount.js';
import type { BoundAppTarget } from '../../../engine/src/shared/appLinks.js';
import type { DatabaseSchema } from '../../../engine/src/shared/schema.js';

const schema: DatabaseSchema = {
  label: 'source',
  dialect: 'sqlite',
  readAt: '',
  foreignKeys: [],
  tables: [
    {
      id: 'loan',
      name: 'loan',
      schema: 'main',
      isView: false,
      columns: [
        { name: 'id', type: 'text', primaryKey: true, nullable: false },
        { name: 'reference', type: 'text', primaryKey: false, nullable: false },
      ],
    },
    {
      id: 'line',
      name: 'line',
      schema: 'main',
      isView: false,
      columns: ['loan_id', 'number'].map((name) => ({ name, type: 'text', primaryKey: true, nullable: false })),
    },
  ],
};
function app(): NavTargetApp {
  return {
    id: 'leads',
    views: { loans: { table: 'loan', label: 'Loans', path: 'work' } },
    resources: { loan: {}, line: {} },
    home: 'loans',
    nav: [],
  };
}
const record: BoundAppTarget = { app: 'leads', kind: 'record', resource: 'loan', key: { id: '9007199254740993' } };
const foreign: BoundAppTarget = { app: 'lender', kind: 'view', view: 'loans' };
function signedIn() {
  establishSessionIdentity({ signedIn: true, accountId: 'reader', appId: 'leads' });
}
function selected(tenantId: string) {
  requireTenantSelection();
  establishTenantSelection({
    accountId: 'reader',
    appId: 'leads',
    tenantId,
    tabId: `tab-${tenantId}`,
    context: `secret-${tenantId}`,
    revision: 1,
    expiresAt: Date.now() + 60000,
  });
}
const fetcher = vi.fn();
beforeEach(() => {
  lockSessionIdentity();
  signedIn();
  configureAppTargetLinks(null);
  fetcher.mockReset();
  vi.stubGlobal('fetch', fetcher);
});
afterEach(() => {
  cleanup();
  configureAppTargetLinks(null);
  vi.unstubAllGlobals();
});
function Consumer({ value, name = 'target' }: { value: NavTargetApp; name?: string }) {
  const hrefs = useAppNavTargets(value, schema);
  const href = hrefs.get(appNavTargetKey(foreign));
  return href ? <a href={href}>{name}</a> : null;
}

test.each([
  { base: '', mount: '' },
  { base: '/tools', mount: 'desk' },
])('standalone canonical home/view/record under $base $mount', ({ base, mount }) => {
  const mounted = appMounts(['leads'], { base, mounts: { leads: mount } });
  const show = (path: string) => outward(mounted, path);
  const prefix = base + (mount ? `/${mount}` : '');
  expect(localAppNavTarget(app(), schema, { app: 'leads', kind: 'home' }, show)).toBe(prefix || '/');
  expect(localAppNavTarget(app(), schema, { app: 'leads', kind: 'view', view: 'loans' }, show)).toBe(`${prefix}/work`);
  expect(localAppNavTarget(app(), schema, record, show)).toBe(`${prefix}/work/9007199254740993`);
});

test('natural and composite PKs use the canonical address book; no guessed fallback', () => {
  const value = app();
  value.resources.loan = { address: 'reference' };
  expect(localAppNavTarget(value, schema, record, (path) => path)).toBe('/leads/work/id=9007199254740993');
  expect(
    localAppNavTarget(
      value,
      schema,
      { app: 'leads', kind: 'record', resource: 'line', key: { loan_id: 'a/b', number: 3 } },
      (path) => path,
    ),
  ).toBe('/leads/line/loan_id=a%2Fb,number=3');
});

test('hidden declarations, unsafe/inexact keys, row bindings and explicit tenant intent have no local URL', () => {
  const value = app();
  const invalid: unknown[] = [
    foreign,
    { ...record, key: {} },
    { ...record, key: { id: '1', extra: '2' } },
    { ...record, key: { id: null } },
    { ...record, key: { id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...record, key: { id: '..' } },
    { ...record, key: { id: { column: 'id' } } },
    { ...record, resource: 'absent' },
    { app: 'leads', kind: 'view', view: 'secret' },
    { ...record, tenant: { kind: 'tenant', id: 'north' } },
    { ...record, tenant: { kind: 'choose' } },
    { ...record, tenant: { kind: 'platform' } },
  ];
  for (const target of invalid) expect(localAppNavTarget(value, schema, target as BoundAppTarget)).toBeUndefined();
  value.resources = {};
  expect(localAppNavTarget(value, schema, record)).toBeUndefined();
  expect(localAppNavTarget(app(), { ...schema, tables: [] }, record)).toBeUndefined();
});

test('two menus share one account-only request, and menu-open refresh prunes denial', async () => {
  configureAppTargetLinks({ appId: 'leads', basePath: '/tools' });
  const value = app();
  value.nav = [
    { label: 'Lender', to: foreign },
    { label: 'Again', to: foreign },
  ];
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) });
  render(
    <>
      <Consumer value={value} />
      <Consumer value={value} name="second" />
    </>,
  );
  expect(await screen.findByRole('link', { name: 'target' })).toHaveAttribute('href', '/tools/work');
  expect(screen.getByRole('link', { name: 'second' })).toHaveAttribute('href', '/tools/work');
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].headers).toEqual({ 'content-type': 'application/json', 'x-mistri-account': 'reader' });
  fetcher.mockResolvedValue({ ok: false });
  await act(async () => refreshAppNavTargets(value, schema));
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('link')).toBeNull();
});

test('refresh immediately removes hrefs and empty groups while denial is pending; aborted replies cannot restore them', async () => {
  configureAppTargetLinks({ appId: 'leads', basePath: '/tools' });
  const value = app();
  value.nav = [
    { view: 'loans', label: 'Loans' },
    {
      group: 'other',
      label: 'Other work',
      children: [{ group: 'lender', label: 'Lender work', children: [{ label: 'Lender', to: foreign }] }],
    },
  ];
  const allowed = { ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) };
  fetcher.mockResolvedValueOnce(allowed);
  render(
    <>
      <Consumer value={value} />
      <Consumer value={value} name="second" />
    </>,
  );
  await screen.findByRole('link', { name: 'target' });
  const menu = () => appMenu(value, navTargets.hrefs(value, schema));
  expect(menu().map((node) => node.kind)).toEqual(['destination', 'group']);

  let finishOld!: (response: typeof allowed) => void;
  let deny!: (response: { ok: false }) => void;
  fetcher
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          deny = resolve;
        }),
    );
  act(() => {
    refreshAppNavTargets(value, schema);
    // The non-React keyboard/model projection clears before refresh returns.
    expect(appNavTargetHrefs(value, schema).size).toBe(0);
  });
  expect(screen.queryByRole('link')).toBeNull();
  expect(menu().map((node) => node.kind)).toEqual(['destination']);
  const oldSignal = fetcher.mock.calls[1][1].signal as AbortSignal;

  act(() => refreshAppNavTargets(value, schema));
  expect(oldSignal.aborted).toBe(true);
  expect(screen.queryByRole('link')).toBeNull();
  expect(menu().map((node) => node.kind)).toEqual(['destination']);
  await act(async () => deny({ ok: false }));
  expect(screen.queryByRole('link')).toBeNull();
  expect(menu().map((node) => node.kind)).toEqual(['destination']);

  // A transport ignoring abort must not republish its older successful reply.
  await act(async () => finishOld(allowed));
  expect(appNavTargetHrefs(value, schema).size).toBe(0);
  expect(screen.queryByRole('link')).toBeNull();
  expect(menu().map((node) => node.kind)).toEqual(['destination']);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

test.each(['logout', 'context', 'payload'] as const)('a delayed response cannot revive a retired %s projection', async (change) => {
  configureAppTargetLinks({ appId: 'leads', basePath: '/tools' });
  selected('north');
  let finish!: (value: unknown) => void;
  fetcher.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const value = app();
  value.nav = [{ label: 'Lender', to: foreign }];
  const { rerender } = render(<Consumer value={value} />);
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  act(() => {
    if (change === 'logout') lockSessionIdentity();
    else if (change === 'context') selected('south');
    else rerender(<Consumer value={app()} />);
  });
  expect(signal.aborted).toBe(true);
  await act(async () => finish({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) }));
  expect(screen.queryByRole('link')).toBeNull();
  if (change === 'context') expect(fetcher).toHaveBeenCalledTimes(1);
});

test('foreign targets without S3 and explicit native tenant intent without discovery stay unavailable', async () => {
  const value = app();
  value.nav = [{ label: 'Lender', to: foreign }];
  render(<Consumer value={value} />);
  await act(async () => {});
  expect(fetcher).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).toBeNull();
});

test('focus refresh uses the new S3 generation and removes revoked destinations from both menus', async () => {
  configureAppTargetLinks({ appId: 'leads', basePath: '/tools' });
  fetcher.mockResolvedValue({ ok: true, json: async () => ({ accountId: 'reader', href: '/tools/work' }) });
  const value = app();
  value.nav = [{ label: 'Lender', to: foreign }];
  render(
    <>
      <Consumer value={value} />
      <Consumer value={value} name="second" />
    </>,
  );
  await screen.findByRole('link', { name: 'target' });
  fetcher.mockResolvedValue({ ok: false });
  await act(async () => window.dispatchEvent(new Event('focus')));
  expect(screen.queryByRole('link')).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(2);
});
