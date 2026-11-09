/**
 * `@mistriwork/mistri/react/headless` against a stubbed server: the page hooks, through the headless Provider and the
 * host it builds (./host.ts), read and run only what the surface the boot answered names, and every request names that
 * surface. The server's own refusal is test/app-surfaces.test.ts; the whole path in a browser is e2e/embed-headless.spec.ts.
 */
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_HEADER } from '../shared/appSurfaces.js';
import type { EmbedSurface } from '../shared/embedProtocol.js';
import { Provider, useCommand, useHref, useRecord, useRows } from './headless.js';

const column = (name: string, primaryKey = false) => ({ name, type: 'TEXT', nullable: !primaryKey, primaryKey });

const SURFACE: EmbedSurface = {
  key: 'leads',
  label: 'Leads',
  app: 'compass',
  loader: false,
  declared: ['lead'],
  schema: {
    label: 'Compass',
    dialect: 'sqlite',
    readAt: '2026-11-08T00:00:00.000Z',
    foreignKeys: [],
    tables: [
      { name: 'lead', schema: '', id: 'lead', isView: false, columns: [column('id', true), column('name'), column('status')] },
      { name: 'account', schema: '', id: 'account', isView: false, columns: [column('id', true), column('name')] },
    ],
  },
  reads: [{ id: 'lead', name: 'lead', key: ['id'], title: 'name' }],
  commands: [
    { id: 'qualify', label: 'Qualify', version: 2, target: 'lead', key: ['id'], granted: true, input: [] },
    { id: 'disqualify', label: 'Disqualify', version: 1, target: 'lead', key: ['id'], granted: false, input: [] },
  ],
};

const LEADS = [
  { id: 1, name: 'Stone & Co', status: 'new' },
  { id: 2, name: 'Harbor Works', status: 'working' },
];

/* The server as the headless host meets it: the boot, view/run over the surface's rows, and the command routes. */
const server = vi.hoisted(() => ({
  asked: [] as Array<{ url: string; init?: RequestInit }>,
  /* What execute answers instead of an applied receipt, when a case says. */
  execute: undefined as { status: number; body: unknown } | undefined,
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  server.asked = [];
  server.execute = undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const at = String(url);
      server.asked.push({ url: at, init });
      const sent = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (at.includes('/api/embed/boot')) return json({ protocol: 1, signedIn: true, surface: SURFACE });
      if (at.includes('/api/view/run')) {
        const view = sent.view as { columns: Array<{ path: string }> };
        const paths = view.columns.map((each) => each.path);
        const query = String(sent.query ?? '');
        const rows = LEADS.filter((row) => !/id = /.test(query) || query.includes(`id = ${row.id}`));
        return json({
          view,
          columns: paths,
          rows: rows.map((row) => Object.fromEntries(paths.map((path) => [path, row[path as keyof typeof row]]))),
        });
      }
      if (at.includes('/api/commands/prepare')) return json({ expectedVersion: 3, initial: {} });
      if (at.includes('/api/commands/execute')) {
        if (server.execute) return json(server.execute.body, server.execute.status);
        return json({
          status: 'applied',
          command: sent.command,
          commandVersion: sent.commandVersion,
          key: sent.key,
          receiptId: 'receipt-1',
          result: { message: 'Qualified.' },
        });
      }
      return json({ error: `unexpected ${at}` }, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const headerOf = (init: RequestInit | undefined, name: string) => (init?.headers as Record<string, string> | undefined)?.[name];

function Leads() {
  const rows = useRows('lead', { show: ['id', 'name'] });
  const href = useHref();
  return (
    <ul>
      {rows.data?.map((row) => (
        <li key={String(row.id)}>
          <a href={href.record('lead', { id: row.id })}>{String(row.name)}</a>
        </li>
      ))}
    </ul>
  );
}

function Qualify({ command = 'qualify' }: { command?: string }) {
  const handle = useCommand(command as never);
  const [said, setSaid] = useState('');
  return (
    <>
      <span>{handle.granted ? 'granted' : 'not granted'}</span>
      <button
        onClick={() =>
          void handle.run({ id: 1 }).then((outcome) => setSaid(`${outcome.status}: ${'message' in outcome ? outcome.message : ''}`))
        }
      >
        Run
      </button>
      <output>{said}</output>
    </>
  );
}

const open = (children: React.ReactNode, basePath = '/crm') =>
  render(
    <Provider endpoint="/api/mistri" app="compass" surface="leads" basePath={basePath} fallback={<p>Opening</p>}>
      {children}
    </Provider>,
  );

describe('the headless Provider', () => {
  it('draws the fallback, asks the boot for the surface, then draws only its children', async () => {
    const { container } = open(<p>Inside</p>);
    expect(screen.getByText('Opening')).toBeTruthy();
    await screen.findByText('Inside');
    const boot = server.asked.find((each) => each.url.includes('/api/embed/boot'))!;
    expect(new URL(boot.url, 'http://x').searchParams.get('surface')).toBe('leads');
    expect(new URL(boot.url, 'http://x').searchParams.get('app')).toBe('compass');
    /* Nothing of mistri's: no wrapper element, no stylesheet. */
    expect(container.innerHTML).toBe('<p>Inside</p>');
    expect(document.querySelector('link[rel="stylesheet"], style')).toBeNull();
  });

  it('keeps drawing the fallback for a reader the boot says is signed out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(fetch).mockImplementation(async () => json({ protocol: 1, signedIn: false }));
    open(<p>Inside</p>);
    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByText('Opening')).toBeTruthy();
    expect(screen.queryByText('Inside')).toBeNull();
  });
});

describe('the hooks against the headless host', () => {
  it('useRows reads the surface rows through view/run, naming the surface; useHref writes the front end’s own addresses', async () => {
    open(<Leads />);
    const link = await screen.findByText('Harbor Works');
    expect(link.getAttribute('href')).toBe('/crm/lead/2');
    const read = server.asked.find((each) => each.url.includes('/api/view/run'))!;
    expect(read.url).toBe('/api/mistri/api/view/run?app=compass');
    expect(headerOf(read.init, SURFACE_HEADER)).toBe('leads');
    const body = JSON.parse(String(read.init?.body)) as { app: string; view: { base: string } };
    expect(body.app).toBe('compass');
    expect(body.view.base).toBe('lead');
  });

  it('useRecord reads one row by its key', async () => {
    function One() {
      const record = useRecord('lead', { id: 2 }, ['id', 'name']);
      return <p>{record.data ? String(record.data.name) : 'reading'}</p>;
    }
    open(<One />);
    await screen.findByText('Harbor Works');
  });

  it('a resource the surface does not declare is a mistake said where the hook is used', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Outside() {
      useRows('account');
      return null;
    }
    open(<Outside />);
    await waitFor(() => expect(error.mock.calls.flat().map(String).join(' ')).toMatch(/account/));
    expect(server.asked.some((each) => each.url.includes('/api/view/run'))).toBe(false);
  });

  it('useCommand prepares, then executes on the record, naming the surface, and reads the applied receipt', async () => {
    open(<Qualify />);
    expect(await screen.findByText('granted')).toBeTruthy();
    fireEvent.click(screen.getByText('Run'));
    await screen.findByText('applied: Qualified.');
    const prepare = server.asked.find((each) => each.url.includes('/api/commands/prepare'))!;
    const execute = server.asked.find((each) => each.url.includes('/api/commands/execute'))!;
    expect(prepare.url).toBe('/api/mistri/api/commands/prepare?app=compass');
    expect(headerOf(execute.init, SURFACE_HEADER)).toBe('leads');
    const sent = JSON.parse(String(execute.init?.body)) as Record<string, unknown>;
    expect(sent).toMatchObject({ command: 'qualify', commandVersion: 2, key: { id: 1 }, expectedVersion: 3 });
  });

  it('a command this reader is not granted refuses without a request', async () => {
    open(<Qualify command="disqualify" />);
    expect(await screen.findByText('not granted')).toBeTruthy();
    fireEvent.click(screen.getByText('Run'));
    await screen.findByText(/^refused: /);
    expect(server.asked.some((each) => each.url.includes('/api/commands/'))).toBe(false);
  });

  it("the server's surface refusal comes back as a refused outcome, never as applied", async () => {
    server.execute = { status: 403, body: { code: 'surface', error: 'The surface "leads" runs "qualify"; "qualify" is not one of them.' } };
    open(<Qualify />);
    await screen.findByText('granted');
    fireEvent.click(screen.getByText('Run'));
    await screen.findByText(/^refused: The surface "leads"/);
  });
});
