import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { installShell } from '../shellMode.js';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { setPublicVisitor } from '../../../../mistri/src/client/publicVisitor.js';
import { setAppKeepsRoles } from '../roleLabels.js';
import type { ResourceClientReply, ResourceHttpSuccess } from '../../../../engine/src/shared/resourceHttp.js';

const errors = vi.fn();
const explain = vi.fn();
const history = vi.fn();
const resetNested = vi.fn();
const request = vi.fn();
const clients: QueryClient[] = [];
/* An App's captions, as the label seam answers them; outside an App it answers null. */
const captions: Record<string, string> = { carrier_id: 'Carrier', status: 'Status' };
vi.mock('../core.js', () => ({
  $: () => null,
  api: request,
  findTable: () => undefined,
  go: vi.fn(),
  tableView: vi.fn(),
  pageSize: () => 2,
  setExplain: explain,
  showErrors: errors,
  // What page.js, write.js and the record surface register with core as they load.
  setRecordMutationPendingProbe: vi.fn(),
  registerSurfaceMutationPendingProbe: vi.fn(),
  columnLabel: (_table: string, name: string) => captions[name] ?? null,
  state: { page: 0, activeConnection: 'demo' },
}));
vi.mock('../history.js', () => ({ recordQuery: history }));
vi.mock('../nested.js', () => ({ resetNested }));
vi.mock('../filterbar.js', () => ({ deriveFilterNames: () => [] }));
vi.mock('../connectionScope.js', () => ({ canUseDatabaseTools: () => true }));
/* The sign-in drawn in place is the shell's answer (surfaceShell.js, from publicSurface.js). */
const signInHere = vi.fn();
const placement = vi.hoisted(() => ({ arrived: undefined as string | undefined }));
vi.mock('../addressMount.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../addressMount.js')>()),
  arrivedPlacement: () => placement.arrived,
}));
vi.mock('./Diagram.js', () => ({ NeighbourhoodDiagram: () => null }));
vi.mock('./FilterBoxes.js', () => ({ FilterBar: () => null }));
vi.mock('./TableView.js', () => ({
  ViewTabs: () => null,
  isApiConnection: () => false,
  GridCellEdit: Object.assign(() => null, { ready: async () => {}, here: () => true }),
  TableView: ({ data }: { data: ResourceHttpSuccess<'/api/run'> }) => <div data-testid="rows">{JSON.stringify(data)}</div>,
}));
vi.mock('./Breakdown.js', () => ({
  BreakdownView: ({ data }: { data: ResourceHttpSuccess<'/api/breakdown'> }) => <div data-testid="groups">{JSON.stringify(data)}</div>,
}));

const { TableRoom } = await import('./TableRoom.js');
const { BreakdownRoom } = await import('./BreakdownRoom.js');
const entry = { kind: 'table' as const, table: 'invoice', query: 'invoice show id' };

beforeEach(bridgeShell);

test("a refusal names the columns it quotes by the App's captions, and nothing else changes", async () => {
  const { inCaptions } = await import('./TableRoom.js');
  const shipments = { id: 'shipments', name: 'shipments', schema: '', isView: false, columns: [] };
  const refused = Object.assign(
    new Error('shipments: the API cannot filter by "carrier_id !=". It can filter by status =, carrier_id = or in, destination_state =.'),
    { columns: ['carrier_id', 'status', 'destination_state'] },
  );
  // Only the listed names, whole words; one without a caption stays as the API names it.
  expect(inCaptions(refused, shipments)).toBe(
    'shipments: the API cannot filter by "Carrier !=". It can filter by Status =, Carrier = or in, destination_state =.',
  );
  // A failure that lists no columns is said as it came.
  expect(inCaptions(new Error('The data could not be loaded. Try again shortly.'), shipments)).toBe(
    'The data could not be loaded. Try again shortly.',
  );
});
const viewReply: ResourceHttpSuccess<'/api/run', 'app'> = {
  table: 'invoice',
  columns: ['id'],
  rows: [{ id: 1 }],
  ms: 1,
  view: { id: 'read', name: 'Read', base: 'invoice', columns: [{ path: 'id' }] },
  text: entry.query,
  errors: [],
  resolved: [],
  joinCount: 0,
  limit: 2,
  offset: 0,
};

function wrap(child: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return <QueryClientProvider client={client}>{child}</QueryClientProvider>;
}

afterEach(() => {
  cleanup();
  for (const client of clients) client.clear();
  clients.length = 0;
  vi.clearAllMocks();
});

test('a table parse failure shows diagnostics without publishing rows or history', async () => {
  const failure: ResourceClientReply<'/api/run'> = { errors: [{ message: 'Incomplete query.' }], explain: 'parse context' };
  request.mockResolvedValue(failure);
  const onResult = vi.fn();
  render(wrap(<TableRoom entry={entry} onResult={onResult} />));
  expect(await screen.findByText('Fix the query above to see results.')).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(failure.errors);
  expect(explain).toHaveBeenCalledWith('parse context');
  expect(history).not.toHaveBeenCalled();
  expect(onResult).not.toHaveBeenCalled();
  expect(screen.queryByTestId('rows')).not.toBeInTheDocument();
});

test('an App list over a table the reader cannot read is not a query to fix', async () => {
  request.mockResolvedValue({ errors: [{ message: 'No table called "invoice".', at: 0 }] });
  setAppKeepsRoles(true);
  try {
    render(wrap(<TableRoom entry={entry} chrome={false} />));
    expect(await screen.findByText('This page is not available to your role.')).toBeInTheDocument();
    expect(screen.queryByText('Fix the query above to see results.')).not.toBeInTheDocument();
  } finally {
    setAppKeepsRoles(false);
  }
});

// A field report from the user's own App: in an App with no roles the refusal named a role no one could hold.
test('an App with no roles never blames a role for a list it does not show', async () => {
  request.mockResolvedValue({ errors: [{ message: 'No table called "invoice".', at: 0 }] });
  render(wrap(<TableRoom entry={entry} chrome={false} />));
  expect(await screen.findByText('This page is not available.')).toBeInTheDocument();
  expect(screen.queryByText(/your role/)).not.toBeInTheDocument();
});

test('a signed-out visitor asked to sign in for a list (401 members_only) is offered it in place', async () => {
  request.mockRejectedValue(Object.assign(new Error('Sign in to continue.'), { status: 401, code: 'members_only' }));
  setPublicVisitor(true);
  installShell({ signInHere });
  try {
    render(wrap(<TableRoom entry={entry} chrome={false} />));
    expect(await screen.findByText(/This page is for signed-in members\./)).toBeInTheDocument();
    expect(screen.queryByText('Sign in to continue.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument();
  } finally {
    setPublicVisitor(false);
  }
});

/* Field report CX5: a signed-out visitor was told the list was "not available to your role" where no role is the
   reason. On a tenant's public address the door stays the top bar's, so no button: the sentence still says sign in. */
test("a signed-out visitor on a tenant's public address is told the list is for members, not that it is their role", async () => {
  request.mockResolvedValue({ errors: [{ message: 'No table called "invoice".', at: 0 }] });
  setPublicVisitor(true);
  placement.arrived = 'acme';
  try {
    render(wrap(<TableRoom entry={entry} chrome={false} />));
    expect(await screen.findByText('This page is for signed-in members.')).toBeInTheDocument();
    expect(screen.queryByText('This page is not available to your role.')).not.toBeInTheDocument();
  } finally {
    placement.arrived = undefined;
    setPublicVisitor(false);
  }
});

test('a signed-out visitor refused a list is offered the sign-in, drawn where they stand', async () => {
  request.mockResolvedValue({ errors: [{ message: 'No table called "invoice".', at: 0 }] });
  setPublicVisitor(true);
  installShell({ signInHere });
  try {
    render(wrap(<TableRoom entry={entry} chrome={false} />));
    expect(await screen.findByText(/This page is for signed-in members\./)).toBeInTheDocument();
    expect(screen.queryByText('This page is not available to your role.')).not.toBeInTheDocument();
    await act(async () => screen.getByRole('button', { name: 'Sign in' }).click());
    expect(signInHere).toHaveBeenCalledWith('demo');
  } finally {
    setPublicVisitor(false);
  }
});

test('a successful App view passes through an absent total and clears SQL diagnostics', async () => {
  request.mockResolvedValue(viewReply);
  const onResult = vi.fn();
  render(wrap(<TableRoom entry={entry} onResult={onResult} />));
  await screen.findByTestId('rows');
  expect(onResult).toHaveBeenCalledWith(viewReply);
  expect(onResult.mock.calls[0][0]).not.toHaveProperty('total');
  expect(explain).toHaveBeenCalledWith(undefined);
  expect(errors).toHaveBeenCalledWith([]);
  expect(history).toHaveBeenCalledWith(entry.query);
});

test('an embedded result does not alter the shared errors, SQL or history', async () => {
  request.mockResolvedValue(viewReply);
  render(wrap(<TableRoom entry={entry} chrome={false} />));
  await screen.findByTestId('rows');
  expect(errors).not.toHaveBeenCalled();
  expect(explain).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect(resetNested).not.toHaveBeenCalled();
});

test('a late reply cannot publish after its table room unmounts', async () => {
  let finish!: (reply: ResourceClientReply<'/api/run'>) => void;
  request.mockReturnValue(
    new Promise<ResourceClientReply<'/api/run'>>((resolve) => {
      finish = resolve;
    }),
  );
  const onResult = vi.fn();
  const mounted = render(wrap(<TableRoom entry={entry} onResult={onResult} />));
  mounted.unmount();
  await act(async () => {
    finish(viewReply);
  });
  expect(onResult).not.toHaveBeenCalled();
  expect(history).not.toHaveBeenCalled();
  expect(errors).not.toHaveBeenCalled();
});

test('a breakdown parse failure renders no groups and is not recorded in history', async () => {
  const failure: ResourceClientReply<'/api/breakdown'> = { errors: [{ message: 'Incomplete group.' }] };
  request.mockResolvedValue(failure);
  render(wrap(<BreakdownRoom entry={{ kind: 'breakdown', table: 'invoice', query: 'invoice count by' }} />));
  expect(await screen.findByText('Fix the line above to see groups.')).toBeInTheDocument();
  expect(errors).toHaveBeenCalledWith(failure.errors);
  expect(explain).toHaveBeenCalledWith(undefined);
  expect(history).not.toHaveBeenCalled();
  expect(screen.queryByTestId('groups')).not.toBeInTheDocument();
});

test('an App breakdown success needs neither total nor SQL diagnostics', async () => {
  const reply: ResourceHttpSuccess<'/api/breakdown', 'app'> = {
    columns: ['count'],
    rows: [{ count: 2 }],
    ms: 1,
    resolved: [],
    breakdown: { base: 'invoice', by: [], measures: [{ fn: 'count' }], limit: 2 },
    offset: 0,
  };
  request.mockResolvedValue(reply);
  render(wrap(<BreakdownRoom entry={{ kind: 'breakdown', table: 'invoice', query: 'invoice count' }} />));
  expect(await screen.findByTestId('groups')).toHaveTextContent(JSON.stringify(reply));
  expect(errors).toHaveBeenCalledWith([]);
  expect(explain).toHaveBeenCalledWith(undefined);
  expect(history).toHaveBeenCalledWith('invoice count');
});
