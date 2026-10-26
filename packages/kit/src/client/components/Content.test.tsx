/**
 * The content pane's room, and when it starts over.
 *
 * The real walk (core.js) drives a Content whose rooms are stand-ins that
 * count their mounts. A refinement of the table room on screen — a page, a
 * header's sort or filter — keeps the room, and its Query re-asks in place;
 * everything else starts it over, the way a repaint always did. The address
 * bar is written on every paint either way.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { bridgeShell } from '../../../../../test/shellBridge.js';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useEffect } from 'react';

const mounts: string[] = [];
const synced = vi.fn();
let appMode = false;
let served: { views: Record<string, unknown> } | null = null;

function Probe({ name, entry }: { name: string; entry: { query?: string } }) {
  useEffect(() => {
    mounts.push(name);
  }, [name]);
  return (
    <div data-testid="room" data-query={entry.query}>
      {name}
    </div>
  );
}

vi.mock('../../../../mistri/src/client/appState.js', () => ({ activeApp: () => served, appLoadError: () => '', inAppMode: () => appMode }));
/* The kit reads the App through the shell's answers (shellMode.ts), which the mock above gives it. */
beforeEach(bridgeShell);
vi.mock('../dashboard.js', () => ({ dashboardEntry: () => null }));
vi.mock('../url.js', () => ({ syncHash: () => synced() }));
vi.mock('../../../../mistri/src/client/components/AppLanding.js', () => ({ AppLanding: () => null }));
vi.mock('./appListModel.js', () => ({ appListFor: (table: string) => ({ table }), appListQuery: () => '' }));
vi.mock('./BreakdownRoom.js', () => ({ BreakdownRoom: () => null }));
vi.mock('./Crumbs.js', () => ({ Crumbs: () => null }));
vi.mock('./dashboardModel.js', () => ({}));
vi.mock('./Landing.js', () => ({
  AppHomeLanding: () => null,
  LoadErrorNote: () => null,
  NothingGranted: () => <Probe name="nothing granted" entry={{}} />,
  WorkbenchLanding: () => <Probe name="home" entry={{}} />,
}));
vi.mock('./PageRoom.js', () => ({ PageRoom: () => null }));
vi.mock('./Rooms.js', () => ({
  AppListRoom: ({ entry }: { entry: { query: string } }) => <Probe name="app list" entry={entry} />,
  DashboardRoom: () => null,
  RowRoom: ({ entry }: { entry: { query?: string } }) => <Probe name="record" entry={entry} />,
}));
vi.mock('./SavedViews.js', () => ({ SavedViewsSection: () => null }));
vi.mock('./TableRoom.js', () => ({ TableRoom: ({ entry }: { entry: { query: string } }) => <Probe name="table" entry={entry} /> }));

const core = await import('../core.js');
const { sortBy } = await import('../thmenu.js');
const { Content, holdHome } = await import('./Content.js');

const room = () => screen.getByTestId('room');
afterEach(() => cleanup());
const draw = () => render(<Content onHome={() => {}} />);

beforeEach(() => {
  mounts.length = 0;
  synced.mockClear();
  appMode = false;
  served = null;
  core.state.activeConnection = 'demo';
  core.state.schema = { tables: [], foreignKeys: [] };
  core.state.stack = [core.tableView('invoice')];
  core.state.page = 0;
  /* Boot paints before the pane is up; this is that paint, so the room on
     screen is this test's and not the last one's. */
  core.render();
});

describe('a refinement keeps the table room', () => {
  test('a page change re-renders it in place, and the address bar is still written', () => {
    draw();
    const before = room();
    act(() =>
      core.refine(() => {
        core.state.page = 2;
        core.render();
      }),
    );
    expect(mounts).toEqual(['table']);
    expect(room()).toBe(before);
    expect(synced).toHaveBeenCalledTimes(2);
  });

  test('a header sort rewrites the walk as a replace, and keeps the room', () => {
    draw();
    act(() => sortBy('id'));
    expect(core.currentEntry()).toMatchObject({ kind: 'table', table: 'invoice', query: 'invoice sort id' });
    expect(core.state.stack).toHaveLength(1);
    expect(core.state.navMode).toBe('replace');
    expect(room()).toHaveAttribute('data-query', 'invoice sort id');
    act(() => sortBy('id'));
    expect(room()).toHaveAttribute('data-query', 'invoice sort id desc');
    expect(mounts).toEqual(['table']);
  });

  test('a header filter keeps it too', () => {
    draw();
    act(() => core.refine(() => core.go(core.tableView('invoice', 'invoice paid = true'), 'replace')));
    expect(room()).toHaveAttribute('data-query', 'invoice paid = true');
    expect(mounts).toEqual(['table']);
  });
});

describe('everything else starts the room over', () => {
  test('a plain paint — a write, a re-run — as it always did', () => {
    draw();
    act(() => core.render());
    expect(mounts).toEqual(['table', 'table']);
  });

  test('a replace that is not a refinement: the query bar, a filter box, a saved view', () => {
    draw();
    act(() => core.go(core.tableView('invoice', 'invoice sort id'), 'replace'));
    expect(mounts).toEqual(['table', 'table']);
  });

  test('another table is another room, even asked for as a refinement', () => {
    draw();
    act(() => core.refine(() => core.go(core.tableView('customer'), 'replace')));
    expect(room()).toHaveAttribute('data-query', 'customer');
    expect(mounts).toEqual(['table', 'table']);
  });

  test('another tab is another room', () => {
    draw();
    act(() => core.refine(() => core.go({ ...core.tableView('invoice'), tab: 'ddl' }, 'replace')));
    expect(mounts).toEqual(['table', 'table']);
  });

  test('a step along the walk is another room', () => {
    draw();
    act(() => core.refine(() => core.go(core.tableView('invoice', 'invoice customer_id = 4'), 'push')));
    expect(core.state.stack).toHaveLength(2);
    expect(mounts).toEqual(['table', 'table']);
  });

  test('a refinement painted over a room that is not a table view', () => {
    core.state.stack = [core.rowView('invoice', { id: 1 }, '1')];
    core.render();
    draw();
    act(() => core.refine(() => core.render()));
    expect(mounts).toEqual(['record', 'record']);
  });

  test('in an app a table is an app list, and a paint that is not a refinement starts it over', () => {
    appMode = true;
    draw();
    act(() => core.render());
    expect(mounts).toEqual(['app list', 'app list']);
  });
});

describe("an App's list keeps its room through a refinement, as the Workbench's table does", () => {
  test("a page turned or a header's sort re-asks in place: rebuilding the grid inside the click was the slowest interaction on a list", () => {
    appMode = true;
    draw();
    act(() =>
      core.refine(() => {
        core.state.page = 1;
        core.render();
      }),
    );
    act(() => core.refine(() => core.go(core.tableView('invoice', 'invoice sort total desc'), 'replace')));
    expect(room()).toHaveAttribute('data-query', 'invoice sort total desc');
    expect(mounts).toEqual(['app list']);
  });
});

describe('a deep link boot has not applied yet', () => {
  test('draws nothing rather than home, then the room the address names', () => {
    core.state.stack = [];
    core.render();
    holdHome(true);
    try {
      draw();
      // Home would mount its rooms and fire their reads for a page nobody asked for.
      expect(screen.queryByTestId('room')).toBeNull();
      expect(mounts).toEqual([]);
      act(() => {
        holdHome(false);
        core.state.stack = [core.tableView('invoice')];
        core.render();
      });
      expect(room()).toHaveTextContent('table');
      expect(mounts).toEqual(['table']);
    } finally {
      holdHome(false);
    }
  });

  test('an empty walk is home once nothing is held', () => {
    core.state.stack = [];
    core.render();
    draw();
    expect(room()).toHaveTextContent('home');
  });
});

/* The first account holds `admin`; an App whose roles leave it out serves it no view, and home fell through to the
   Workbench's landing, whose diagram said "This database has no tables". */
test("an App that grants this account nothing says so, and never draws the Workbench's landing", () => {
  served = { views: {} };
  core.state.stack = [];
  core.render();
  draw();
  expect(room()).toHaveTextContent('nothing granted');
});
