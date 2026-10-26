/**
 * A free-form page's blocks are the platform's own components, handed what they would be handed in a dashboard,
 * a record page or a list: these hold what each block hands its component, and what it refuses before drawing.
 */
import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { UiPageContext, type UiPageFrame } from './context.js';

const mocks = vi.hoisted(() => ({
  pageFor: vi.fn(async (table: string) => (table === 'note' ? null : `page-${table}`)),
  set: vi.fn(),
}));
const column = (name: string, primaryKey = false) => ({ name, type: 'TEXT', nullable: !primaryKey, primaryKey });
vi.mock('../../../../../kit/src/client/core.js', () => ({
  pageFor: mocks.pageFor,
  state: {
    schema: {
      tables: ['ticket', 'task', 'note', 'desk'].map((id) => ({
        id,
        name: id,
        schema: '',
        isView: false,
        columns: [column('id', true), column('name'), column('parent_id'), column('starts_on'), column('due_on')],
      })),
    },
  },
}));
vi.mock('../../../../../kit/src/client/components/recordSurface.js', () => ({
  captureRecordSurfaceOwner: () => ({ isCurrent: () => true }),
}));
/* A part arrives when drawn, as onDemand's do, without the shell's loading note. */
vi.mock('../../../../../kit/src/client/components/onDemand.js', async () => {
  const { createElement, useEffect, useState } = await import('react');
  return {
    onDemand: (load: () => Promise<Record<string, unknown>>, name: string) =>
      function Part(props: object) {
        const [part, setPart] = useState<{ draw: (props: object) => ReactNode } | null>(null);
        useEffect(() => {
          void load().then((module) => setPart({ draw: module[name] as (props: object) => ReactNode }));
        }, []);
        return part ? createElement(part.draw, props) : null;
      },
  };
});
const handed = (label: string) => (props: object) => <pre data-testid={label}>{JSON.stringify(props)}</pre>;
vi.mock('../Dashboard.js', () => ({ DashboardBlock: handed('section') }));
vi.mock('../RecordPageBody.js', () => ({
  RecordPageBody: ({ tableId, recordKey, pageId, sections, only }: Record<string, unknown>) =>
    handed('record')({ tableId, recordKey, pageId, sections, only }),
}));
vi.mock('../TreeList.js', () => ({ TreeList: ({ spec, entry }: Record<string, unknown>) => handed('tree')({ spec, entry }) }));
vi.mock('../GanttList.js', () => ({ GanttList: ({ spec, entry }: Record<string, unknown>) => handed('gantt')({ spec, entry }) }));
vi.mock('../AssistantPanel.js', () => ({ AssistantRoom: handed('assistant') }));
vi.mock('../../../../../kit/src/client/components/PageSections.js', () => ({
  TabStrip: ({
    tabs,
    entry,
    onTab,
    draw,
  }: {
    tabs: { token: string; label: ReactNode }[];
    entry: { tab?: string };
    onTab: (t?: string) => void;
    draw: (i: number) => ReactNode;
  }) => {
    const at = Math.max(
      0,
      tabs.findIndex((tab) => tab.token === entry.tab),
    );
    return (
      <div>
        {tabs.map((tab) => (
          <button key={tab.token} type="button" onClick={() => onTab(tab.token)}>
            {tab.label}
          </button>
        ))}
        {draw(at)}
      </div>
    );
  },
}));

const { Assistant, Breakdown, Chart, Gantt, Metric, RecordCard, Rows, Tabs, Timeline, Tree } = await import('./blocks.js');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const frame: UiPageFrame = {
  view: 'board',
  label: 'Board',
  reads: ['ticket', 'task', 'note'],
  commands: [],
  params: ['tab'],
  get: (name) => (name === 'tab' ? 'closed' : undefined),
  set: (...args) => mocks.set(...args),
};
const inPage = (block: ReactNode) => render(<UiPageContext.Provider value={frame}>{block}</UiPageContext.Provider>);
const json = async (id: string) => JSON.parse((await screen.findByTestId(id)).textContent ?? '');

test("Metric, Chart and Rows hand the dashboard's section their DSL words, on the resource's table", async () => {
  inPage(<Metric title="Open" from="ticket" query="status = open" compare="previous period" better="down" width="half" />);
  expect(await json('section')).toEqual({
    section: {
      kind: 'metric',
      table: 'ticket',
      query: 'status = open',
      compare: 'previous period',
      better: 'down',
      width: 'half',
      title: 'Open',
    },
  });
  cleanup();
  inPage(<Chart title="Opened" from="ticket" by="month opened_on" measure="count" shape="bar" />);
  expect((await json('section')).section).toEqual({
    kind: 'chart',
    table: 'ticket',
    shape: 'bar',
    by: 'month opened_on',
    measure: 'count',
    title: 'Opened',
  });
  cleanup();
  // Figures said as a metric's are, by the dashboard's sayer: seconds as a time taken.
  inPage(<Chart title="Response" from="ticket" by="month opened_on" measure="avg first_response_seconds" format="duration" unit="avg" />);
  expect((await json('section')).section).toMatchObject({ kind: 'chart', format: 'duration', unit: 'avg' });
  cleanup();
  inPage(<Breakdown title="By status" from="ticket" by="status" measure="avg first_response_seconds" format="duration" limit={5} />);
  expect((await json('section')).section).toEqual({
    kind: 'breakdown',
    table: 'ticket',
    by: 'status',
    measure: 'avg first_response_seconds',
    limit: 5,
    format: 'duration',
    title: 'By status',
  });
  cleanup();
  inPage(<Breakdown title="Bad" from="ticket" by="status" format={'hours' as never} />);
  expect(await screen.findByText(/<Breakdown> has a "format" of "hours"/)).toBeTruthy();
  cleanup();
  inPage(<Rows title="Newest" from="task" show={['name', 'due_on']} sort="due_on desc" limit={5} />);
  expect((await json('section')).section).toEqual({
    kind: 'rows',
    table: 'task',
    sort: 'due_on desc',
    limit: 5,
    show: ['name', 'due_on'],
    title: 'Newest',
  });
});

test('a block refuses a word it does not take, a value outside its words, and a resource the page does not read', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  inPage(
    <>
      <Metric title="Open" from="ticket" colour="red" />
      <Chart title="Shape" from="ticket" by="status" shape={'pie' as never} />
      <Rows title="Desks" from={'desk' as never} />
    </>,
  );
  expect(await screen.findByText(/<Metric> has no "colour"/)).toBeTruthy();
  expect(screen.getByText(/<Chart> has a "shape" of "pie"/)).toBeTruthy();
  expect(screen.getByText(/<Rows> reads "desk", which the page "Board" does not read/)).toBeTruthy();
  expect(screen.queryByTestId('section')).toBeNull();
});

test("RecordCard draws the record's own page, with `show` as its one fields section; Timeline only its timeline", async () => {
  inPage(<RecordCard from="ticket" record={{ id: 7 }} show={['name']} />);
  expect(await json('record')).toEqual({
    tableId: 'ticket',
    recordKey: { id: 7 },
    pageId: 'page-ticket',
    sections: [{ kind: 'fields', paths: ['name'] }],
  });
  cleanup();
  inPage(<Timeline from="task" record={{ id: 3 }} />);
  expect(await json('record')).toEqual({ tableId: 'task', recordKey: { id: 3 }, pageId: 'page-task', only: 'timeline' });
  cleanup();
  inPage(<RecordCard from="note" record={{ id: 1 }} />);
  expect(await screen.findByText('This record has no page.')).toBeTruthy();
});

test("Tree and Gantt are a list's presentations, read by the presentation's own parser", async () => {
  inPage(<Tree from="task" parent="parent_id" primary="name" query="status = open" />);
  expect(await json('tree')).toEqual({
    spec: { kind: 'tree', parent: 'parent_id', primary: 'name' },
    entry: { kind: 'table', table: 'task', query: 'status = open' },
  });
  cleanup();
  inPage(<Gantt from="task" start="starts_on" end="due_on" primary="name" />);
  expect((await json('gantt')).spec).toEqual({ kind: 'gantt', start: 'starts_on', end: 'due_on', primary: 'name' });
  cleanup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  inPage(<Gantt from="task" start="due_on" end="due_on" primary="name" />);
  expect(await screen.findByText(/"end" names "due_on", the same column as "start"/)).toBeTruthy();
});

test("Tabs open where the page param says and keep the tab picked in it; Assistant is the App's own", async () => {
  inPage(
    <Tabs
      param="tab"
      tabs={[
        { key: 'open', label: 'Open', content: <p>Open work</p> },
        { key: 'closed', label: 'Closed', content: <p>Closed work</p> },
      ]}
    />,
  );
  expect(await screen.findByText('Closed work')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Open' }));
  expect(mocks.set).toHaveBeenCalledWith('tab', 'open');
  cleanup();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  inPage(<Tabs param="view" tabs={[{ key: 'a', label: 'A', content: null }]} />);
  expect(await screen.findByText(/keeps its tab in "view", which is not one of the page's params/)).toBeTruthy();
  cleanup();
  inPage(<Assistant conversation="c-1" />);
  expect(await json('assistant')).toEqual({ conversation: 'c-1' });
});
