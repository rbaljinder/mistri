/**
 * A custom section on a record's page takes no place while its component
 * draws nothing: an author's section for a role the reader does not hold
 * left its heading, rule and margin over an empty gap (G53).
 */
import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

let drawn: { set?: (show: boolean) => void } = {};
vi.mock('./componentLoader.js', async () => {
  const { useState } = await import('react');
  function Authoring() {
    const [show, setShow] = useState(false);
    drawn.set = setShow;
    return show ? <p>Draft and questions</p> : null;
  }
  /* A dashboard's component says what it was handed. */
  function Breaching(props: { period?: string; record?: unknown; section: { region: string; width: string } }) {
    return (
      <p>
        {`${props.section.region} ${props.section.width} ${props.period ?? 'no period'} ${props.record === undefined ? 'no record' : 'record'}`}
      </p>
    );
  }
  /* A component with aggregate reads says what the platform measured for it. */
  function Summary(props: { figures: Record<string, unknown>; rows: Record<string, unknown[]> }) {
    return <p>{`${JSON.stringify(props.figures)} ${Object.keys(props.rows).length} rows reads`}</p>;
  }
  const parts: Record<string, unknown> = { breaching: Breaching, summary: Summary };
  return { loadComponent: (id: string) => Promise.resolve(parts[id] ?? Authoring) };
});
vi.mock('../../../../../kit/src/client/core.js', () => ({
  api: vi.fn(),
  primaryKey: () => ['id'],
  state: {},
  findTable: () => ({ columns: [{ name: 'owner' }] }),
  quote: (value: string) => `'${value}'`,
}));
const asked: Array<{ text?: string; def?: unknown }> = [];
vi.mock('../../../../../kit/src/client/breakdownBatch.js', () => ({
  batchedBreakdown: vi.fn(async (ask: { text?: string; def?: unknown }) => {
    asked.push(ask);
    return ask.text?.includes(' by ') ? { rows: [{ status: 'open', count: 7, label: 'Open' }] } : { rows: [{ count: 1234 }] };
  }),
}));

const { CustomDashSection, CustomPageSection } = await import('./CustomSection.js');

afterEach(() => {
  cleanup();
  drawn = {};
  asked.length = 0;
});

function SectionBox({ section, body, hidden }: { section: { title?: string }; body: ReactNode; hidden?: boolean }) {
  return (
    <section data-testid="box" hidden={hidden || undefined}>
      <h2>{section.title}</h2>
      {body}
    </section>
  );
}

test('a custom section whose component draws nothing is hidden, and shown again once it draws', async () => {
  const section = { kind: 'custom', title: 'Authoring', component: { id: 'authoring' } };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomPageSection
        {...({
          page: { id: 'item', base: 'item', sections: [section] },
          section,
          index: 0,
          plan: { index: 0, kind: 'custom', reads: {} },
          base: { id: 'item', name: 'item', columns: [] },
          recordKey: { id: 1 },
          frame: { pageApi: vi.fn(), Loading: () => <p>Loading</p>, SectionBox },
        } as unknown as Parameters<typeof CustomPageSection>[0])}
      />
    </QueryClientProvider>,
  );
  await vi.waitFor(() => expect(drawn.set).toBeDefined());
  await vi.waitFor(() => expect(screen.getByTestId('box')).toHaveAttribute('hidden'));
  act(() => drawn.set!(true));
  await vi.waitFor(() => expect(screen.getByTestId('box')).not.toHaveAttribute('hidden'));
  expect(screen.getByText('Draft and questions')).toBeInTheDocument();
});

test("a dashboard's custom section is handed the reader's window and its region, with no record", async () => {
  const section = { kind: 'custom', title: 'Breaching now', width: 'half', component: { id: 'breaching' } };
  const drawOn = (aside: boolean, windowNow: string | null) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <CustomDashSection section={section as never} windowNow={windowNow} picks={{}} aside={aside} />
      </QueryClientProvider>,
    );
  drawOn(false, 'last 7 days');
  expect(screen.getByRole('heading', { name: 'Breaching now' })).toBeInTheDocument();
  expect(await screen.findByText('main half last 7 days no record')).toBeInTheDocument();
  cleanup();
  drawOn(true, null);
  expect(await screen.findByText('aside half no period no record')).toBeInTheDocument();
});

test("a dashboard's custom section is handed its aggregate reads, measured by the server under the window and the picks", async () => {
  const section = {
    kind: 'custom',
    title: 'Summary',
    component: { id: 'summary' },
    aggregates: {
      open: { table: 'ticket', measure: 'count', query: 'status = open', over: 'opened_on' },
      byStatus: { table: 'ticket', measure: 'count', by: 'status', limit: 5 },
    },
  };
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomDashSection section={section as never} windowNow="last 7 days" picks={{ owner: 'ada' }} />
    </QueryClientProvider>,
  );
  // One figure, and one group per value: exact numbers from the breakdown, not a count of rows the component loaded.
  expect(await screen.findByText('{"open":1234,"byStatus":[{"key":"open","value":7,"label":"Open"}]} 0 rows reads')).toBeInTheDocument();
  const texts = asked.map((ask) => ask.text);
  expect(texts).toContain("ticket status = open and opened_on = last 7 days and owner = 'ada' count");
  expect(texts).toContain("ticket owner = 'ada' count by status limit 5");
});

test("a record page's custom section is handed its aggregate reads, each the page's own breakdown", async () => {
  const section = {
    kind: 'custom',
    title: 'Summary',
    component: { id: 'summary' },
    aggregates: { all: { by: undefined }, groups: { by: 'status' } },
  };
  const def = { base: 'sale', by: [], measures: [{ fn: 'count', alias: 'value' }], limit: 1 };
  const groupsDef = { base: 'sale', by: [{ path: 'status', alias: 'key_1' }], measures: [{ fn: 'count', alias: 'value' }], limit: 100 };
  const pageApi = vi.fn(async (_path: string, body: { def: unknown }) =>
    body.def === def ? { rows: [{ value: 1040 }] } : { rows: [{ key_1: 'won', value: 347 }] },
  );
  render(
    <QueryClientProvider client={new QueryClient()}>
      <CustomPageSection
        {...({
          page: { id: 'account', base: 'account', sections: [section] },
          section,
          index: 0,
          plan: { index: 0, kind: 'custom', reads: {}, aggregates: { all: { breakdown: def }, groups: { breakdown: groupsDef } } },
          base: { id: 'account', name: 'account', columns: [] },
          recordKey: { id: 1 },
          frame: { pageApi, Loading: () => <p>Loading</p>, SectionBox },
        } as unknown as Parameters<typeof CustomPageSection>[0])}
      />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('{"all":1040,"groups":[{"key":"won","value":347}]} 0 rows reads')).toBeInTheDocument();
  expect(pageApi).toHaveBeenCalledWith('/api/breakdown', { def });
  expect(pageApi).toHaveBeenCalledWith('/api/breakdown', { def: groupsDef });
});
