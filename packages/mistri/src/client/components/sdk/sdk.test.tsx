/**
 * `@mistriwork/mistri/ui` held to what it promises: the names the served module offers
 * are exactly the SDK's, the kit draws in the looks' own classes without the
 * walk's globals, a value renderer never makes a cell wait and never takes a
 * column down with it, and the fixture host answers a declared read as the
 * planner would.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as ui from './index.js';
import type * as PublicUi from '../../../../schema/ui.js';
import { Dropdown } from '../../../../../kit/src/client/components/Dropdown.js';
import { SplitListDetail } from '../SplitListDetail.js';
import { UI_EXPORTS } from '../../../shared/uiSdk.js';
import { Card, Meter, Table, Value } from './kit.js';
import { UiHostContext, type UiHost } from './context.js';
import { fixtures, renderSection, renderValue } from './testing.js';
import { FixtureSection } from './fixture.js';
import { useMessage, useRows } from './hooks.js';
import { sayAppMessage } from './appMessage.js';

describe('the SDK surface', () => {
  test('exports exactly the names the served module re-exports', () => {
    expect(Object.keys(ui).sort()).toEqual([...UI_EXPORTS].sort());
  });

  test('public presentation primitives are the host implementations with matching props', () => {
    const dropdown: typeof PublicUi.Dropdown = ui.Dropdown;
    const split: typeof PublicUi.SplitListDetail = ui.SplitListDetail;
    const internalDropdown: typeof Dropdown = dropdown;
    const internalSplit: typeof SplitListDetail = split;
    expect(internalDropdown).toBe(Dropdown);
    expect(internalSplit).toBe(SplitListDetail);
  });

  test("the split's layout props the host sets for itself are not on the public type", () => {
    // @ts-expect-error `expandList` belongs to the shell's own rooms.
    const expand: Parameters<typeof PublicUi.SplitListDetail>[0] = { list: null, expandList: true };
    expect(expand.list).toBeNull();
  });
});

describe('the kit', () => {
  const host = { column: () => undefined, app: true } as unknown as UiHost;
  const withHost = (node: React.ReactNode) => render(<UiHostContext.Provider value={host}>{node}</UiHostContext.Provider>);

  test('a card inside a card is a plain group, never a box in a box', () => {
    const { container } = withHost(
      <Card title="Outer">
        <Card title="Inner">x</Card>
      </Card>,
    );
    expect(container.querySelectorAll('.kit-card')).toHaveLength(1);
    expect(container.querySelectorAll('.kit-group')).toHaveLength(1);
  });

  test("a value keeps every digit of an id past 2^53, and says a display rule's tone as the looks do", () => {
    withHost(
      <>
        <Value value="9007199254740993" />
        <Value value="review" display={{ tone: { review: 'warn' } }} />
      </>,
    );
    expect(screen.getByText('9007199254740993')).toBeInTheDocument();
    expect(screen.getByText('Review')).toHaveClass('tone', 'tone-warn');
  });

  describe('a table', () => {
    // The kit's other tests leave their markup up, and a table's text is the same words.
    beforeEach(cleanup);
    afterEach(cleanup);
    const rows = [
      { id: 7, name: 'Maple Court', status: 'review', rent: 1900 },
      { id: 9007199254740991, name: 'Birch Court', status: 'ready', rent: 2100 },
    ];
    const columns = [
      { key: 'name', label: 'Home' },
      { key: 'status', label: 'Status', display: { tone: { review: 'warn', ready: 'good' } } },
      { key: 'rent', label: 'Rent', align: 'right' as const },
    ];

    test("is the look's table: each cell a value, dressed as its column is, with a name for assistive technology", () => {
      withHost(<Table label="Homes" columns={columns} rows={rows} />);
      const table = screen.getByRole('table', { name: 'Homes' });
      expect(table.closest('.table-wrap')).not.toBeNull();
      expect(screen.getAllByRole('columnheader').map((head) => head.textContent)).toEqual(['Home', 'Status', 'Rent']);
      expect(screen.getByText('Review')).toHaveClass('tone', 'tone-warn');
      expect(screen.getByRole('columnheader', { name: 'Rent' })).toHaveClass('align-right');
    });

    test('keeps every digit of an id past 2^53 a column draws', () => {
      withHost(<Table label="Homes" columns={[{ key: 'id', label: 'Id' }]} rows={[{ id: '9007199254740993' }]} />);
      expect(screen.getByText('9007199254740993')).toBeInTheDocument();
    });

    test('sorts by the caller: a head is a button only with onSort, says which way it stands, and never reorders the rows', () => {
      const { rerender } = withHost(<Table label="Homes" columns={columns} rows={rows} />);
      expect(screen.queryByRole('button')).toBeNull();
      const onSort = vi.fn();
      rerender(
        <UiHostContext.Provider value={host}>
          <Table label="Homes" columns={columns} rows={rows} sort={{ key: 'rent', direction: 'desc' }} onSort={onSort} />
        </UiHostContext.Provider>,
      );
      expect(screen.getByRole('columnheader', { name: /Rent/ })).toHaveAttribute('aria-sort', 'descending');
      expect(screen.getByRole('columnheader', { name: 'Home' })).not.toHaveAttribute('aria-sort');
      fireEvent.click(screen.getByRole('button', { name: 'Home' }));
      expect(onSort).toHaveBeenCalledWith('name');
      expect(
        screen
          .getAllByRole('row')
          .slice(1)
          .map((row) => row.textContent?.slice(0, 5)),
      ).toEqual(['Maple', 'Birch']);
    });

    test('links a row by its first cell, once for a click on it and once for a click beside it', () => {
      const onRowClick = vi.fn();
      withHost(<Table label="Homes" columns={columns} rows={rows} onRowClick={onRowClick} />);
      fireEvent.click(screen.getByRole('button', { name: 'Maple Court' }));
      expect(onRowClick).toHaveBeenCalledTimes(1);
      expect(onRowClick).toHaveBeenLastCalledWith(rows[0]);
      fireEvent.click(screen.getByText('Ready'));
      expect(onRowClick).toHaveBeenCalledTimes(2);
      expect(onRowClick).toHaveBeenLastCalledWith(rows[1]);
    });

    test('says its empty note under the head, and lets a column draw its own cell', () => {
      withHost(
        <Table
          label="Homes"
          columns={[{ key: 'name', label: 'Home', render: (row) => <em>{String(row.name).toUpperCase()}</em> }]}
          rows={[] as Array<{ name: string }>}
          empty="No homes yet."
        />,
      );
      expect(screen.getByText('No homes yet.')).toBeInTheDocument();
      expect(screen.getAllByRole('row')).toHaveLength(1);
    });
  });

  test('a meter is a meter to assistive technology', () => {
    withHost(<Meter value={30} max={60} label="30 of 60" />);
    expect(screen.getByRole('meter', { name: '30 of 60' })).toHaveAttribute('aria-valuenow', '30');
  });
});

describe('@mistriwork/mistri/ui/testing', () => {
  test('answers a declared read with its show, sort and limit, and a hook from the same rows', async () => {
    const declaration = {
      title: 'People',
      component: { id: 'people', props: { n: { default: 2 } } },
      rows: { list: { from: 'person', show: ['name'], sort: 'name desc', limit: 2 } },
    };
    const Seen = ({ rows, props }: { rows: { list: Array<{ name: string }> }; props: { n: number } }) => {
      const all = useRows('person', { show: ['name', 'age'] });
      return (
        <p>
          {rows.list.map((row) => Object.keys(row).join('+') + ':' + row.name).join(' ')} n={props.n} hook={all.data?.length ?? '…'}
        </p>
      );
    };
    const data = fixtures<{ person: { name: string; age: number } }>({
      person: [
        { name: 'Ann', age: 3 },
        { name: 'Cy', age: 5 },
        { name: 'Bo', age: 4 },
      ],
    });
    renderSection(Seen, declaration, { data });
    expect(await screen.findByText('name:Cy name:Bo n=2 hook=3')).toBeInTheDocument();
  });

  test('answers a declared total with the fixtures measured whole: one figure, or a group for each value', async () => {
    const declaration = {
      component: { id: 'ages' },
      figures: {
        people: { from: 'person', measure: 'count' },
        years: { from: 'person', measure: 'sum age' },
        byTeam: { from: 'person', measure: 'sum age', by: 'team' },
        nobody: { from: 'absent', measure: 'count' },
        noAge: { from: 'absent', measure: 'max age' },
      },
    };
    const Seen = ({ figures }: { figures: Record<string, unknown> }) => <p>{JSON.stringify(figures)}</p>;
    const data = fixtures<{ person: { age: number; team: string } }>({
      person: [
        { age: 3, team: 'red' },
        { age: 5, team: 'blue' },
        { age: 4, team: 'red' },
      ],
    });
    renderSection(Seen, declaration, { data });
    expect(
      await screen.findByText(
        '{"people":3,"years":12,"byTeam":[{"key":"red","value":7},{"key":"blue","value":5}],"nobody":0,"noAge":null}',
      ),
    ).toBeInTheDocument();
  });

  test("useMessage says the App's catalog with its arguments, and a key it lacks as itself", () => {
    const Help = () => (
      <p>
        {useMessage('help.title')} · {useMessage('help.results', { count: 1 })} · {useMessage('help.results', { count: 3 })} ·{' '}
        {useMessage('help.missing')}
      </p>
    );
    renderSection(
      Help,
      { title: 'Help', component: { id: 'help' } },
      {
        messages: { 'help.title': 'Centro de ayuda', 'help.results': '{count, plural, one {# artículo} other {# artículos}}' },
      },
    );
    expect(screen.getByText('Centro de ayuda · 1 artículo · 3 artículos · help.missing')).toBeInTheDocument();
  });

  test('a message the server parsed is said as one written as text', () => {
    // The payload's form: each message parsed (intl-messageformat's own AST), as the server sends it.
    const parsed = {
      'help.hello': [
        { type: 0, value: 'Hola, ' },
        { type: 1, value: 'name' },
      ],
    };
    expect(sayAppMessage(parsed, 'help.hello', { name: 'Ana' })).toBe('Hola, Ana');
    expect(sayAppMessage(parsed, 'help.hello')).toBe('help.hello');
    expect(sayAppMessage(undefined, 'help.hello')).toBe('help.hello');
  });

  test('a story draws a section over the same fixtures, with no test runner', async () => {
    const Names = ({ rows }: { rows: { list: Array<{ name: string }> } }) => <p>{rows.list.map((row) => row.name).join(', ')}</p>;
    render(
      <FixtureSection
        component={Names}
        declaration={{ component: { id: 'names' }, rows: { list: { from: 'person', show: ['name'] } } }}
        options={{ data: fixtures({ person: [{ name: 'Ann' }, { name: 'Bo' }] }), width: 360 }}
      />,
    );
    expect(screen.getByText('Ann, Bo').closest('[data-component="names"]')).toBeInTheDocument();
  });

  test('draws a value renderer on one value, compact in a grid', () => {
    const Hours = ({ value, compact }: { value: unknown; compact: boolean }) => (
      <span>
        {String(value)}h{compact ? ' (compact)' : ''}
      </span>
    );
    renderValue(Hours, { id: 'hours' }, { value: 38, column: { name: 'hours', resource: 'timesheet' }, context: 'grid' });
    expect(screen.getByText('38h (compact)')).toBeInTheDocument();
  });
});

describe('a value renderer in the page', () => {
  test("draws the platform's value until its module arrives, and for good when it throws", async () => {
    vi.resetModules();
    const Throws = () => {
      throw new Error('renderer broke');
    };
    vi.doMock('./componentLoader.js', () => ({ loadComponent: () => Promise.resolve(Throws) }));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { ValueSlot } = await import('../../../../../kit/src/client/components/valueRenderers.js');
    /* The App shell's components (appnav.js), installed into the module graph just reset. */
    const { installShell } = await import('../../../../../kit/src/client/shellMode.js');
    installShell({ components: (await import('./appComponents.js')).appComponents });
    render(
      <table>
        <tbody>
          <tr>
            <td>
              <ValueSlot
                id="broken"
                value={1}
                column={{ name: 'n', resource: 't' }}
                context="grid"
                compact
                fallback={<span>plain 1</span>}
              />
            </td>
          </tr>
        </tbody>
      </table>,
    );
    expect(screen.getByText('plain 1')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(errors).toHaveBeenCalledWith(expect.stringContaining('the value renderer "broken" threw'), expect.anything()),
    );
    expect(screen.getByText('plain 1')).toBeInTheDocument();
    errors.mockRestore();
    vi.doUnmock('./componentLoader.js');
  });
});

describe('the Segmented, Stat and Columns blocks', () => {
  test('Segmented is one radio group whose arrows move the choice', () => {
    const onChange = vi.fn();
    render(
      <ui.Segmented
        label="Show"
        value="all"
        onChange={onChange}
        options={[
          { value: 'all', label: 'All' },
          { value: 'late', label: 'Late', count: 3 },
        ]}
      />,
    );
    expect(screen.getByRole('radiogroup', { name: 'Show' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /All/ })).toHaveAttribute('aria-checked', 'true');
    screen.getByRole('radio', { name: /All/ }).focus();
    fireEvent.keyDown(screen.getByRole('radio', { name: /All/ }), { key: 'ArrowRight' });
    expect(onChange).toHaveBeenCalledWith('late');
  });

  test('Stat says its value and change, and Columns says every column in its table', () => {
    const { container } = render(
      <>
        <ui.Stat label="Events" value="1,204" change={{ text: '↑ 12% vs prior 30 d' }} trend={[1, 3, 2, 5]} />
        <ui.Columns
          series={[
            { key: 'a', label: 'Tracked' },
            { key: 'b', label: 'Business' },
          ]}
          rows={[
            { key: '2026-10-01', values: { a: 3, b: 1 } },
            { key: '2026-10-02', values: { a: 2, b: 0 } },
          ]}
        />
      </>,
    );
    expect(screen.getByText('1,204')).toBeInTheDocument();
    expect(screen.getByText('↑ 12% vs prior 30 d')).toBeInTheDocument();
    expect(screen.getAllByText('Tracked').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.chart-data tbody tr')).toHaveLength(2);
  });
});
