/**
 * The parts a field report asked for, each as a page meets it: `Stat`'s delta and link, `Sparkline`, `MiniBars` (with
 * the table a screen reader reads), `Tile`, `DateNav` (its steps, its `T` key and `skip`) and `useNotice`; and the
 * parts a page draws people and facts with: `Person`, `Details`, a table's `avatar` column and a status `Value` under
 * each of the looks' status recipes.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { renderPage, renderSection } from './testing.js';
import { definePage } from './page.js';
import { BreakdownList, DescriptionList, MiniBars, Person, Sparkline, StatCard, Table, Tile, Value, useNotice } from './index.js';
import { UiHostContext, type UiHost } from './context.js';
import { DateNav, stepDay } from './DateNav.js';

afterEach(cleanup);
const drawn = (children: React.ReactNode, more: object = {}) =>
  renderSection(() => <>{children}</>, { component: { id: 'parts' }, ...more });

describe('Stat', () => {
  test('a delta is signed and toned by which way is good', () => {
    drawn(
      <>
        <StatCard label="Revenue" value="$1" delta={{ value: 12, good: 'up' }} />
        <StatCard label="Churn" value="3%" delta={{ value: -2, good: 'up' }} />
        <StatCard label="Wait" value="4m" delta={{ value: -1, good: 'down' }} />
      </>,
    );
    const news = [...document.querySelectorAll('.kit-stat-change')];
    expect(news.map((each) => each.textContent)).toEqual(['+12', '−2', '−1']);
    expect(news[0]).toHaveClass('kit-stat-change', 'kit-stat-good');
    expect(news[1]).toHaveClass('kit-stat-change', 'kit-stat-bad');
    expect(news[2]).toHaveClass('kit-stat-change', 'kit-stat-good');
  });

  test('a delta names what it is measured against, after the change', () => {
    drawn(<StatCard label="Revenue" value="$1" delta={{ value: 12, good: 'up', against: 'vs last month' }} />);
    expect(document.querySelector('.nx-stat-delta')!.textContent).toBe('+12');
    expect(document.querySelector('.kit-stat-against')!.textContent).toBe('vs last month');
  });

  test('with href the whole stat is a link', () => {
    drawn(<StatCard label="Open" value="14" href="/leads" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('href')).toBe('/leads');
    expect(link.textContent).toContain('14');
  });

  test('a stat with none of the new props is as it was', () => {
    drawn(<StatCard label="Open" value="14" />);
    expect(document.querySelector('a')).toBeNull();
    expect(document.querySelector('.kit-stat-change')).toBeNull();
  });
});

describe('Sparkline and MiniBars', () => {
  test('a sparkline names its values for a screen reader', () => {
    drawn(<Sparkline data={[1, 3, 2, 5, 4]} label="Orders" />);
    expect(document.querySelector('svg')?.getAttribute('aria-label')).toBe('trend: 1, 3, 2, 5, 4');
    expect(screen.getByRole('group', { name: 'Orders' })).not.toBeNull();
  });

  test('mini bars are drawn to the tallest, the highlight lit, and read out as a table', () => {
    drawn(<MiniBars data={[2, 4, 1]} labels={['Mon', 'Tue', 'Wed']} highlight={1} />);
    const bars = [...document.querySelectorAll<HTMLElement>('.kit-minibars-bars > i')];
    expect(bars.map((bar) => bar.style.height)).toEqual(['50%', '100%', '25%']);
    expect(bars.map((bar) => bar.classList.contains('is-lit'))).toEqual([false, true, false]);
    const rows = [...document.querySelectorAll('tr')].map((row) => row.textContent);
    expect(rows).toEqual(['Mon2', 'Tue4', 'Wed1']);
    expect(document.querySelector('.kit-minibars-bars')?.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('Tile', () => {
  test('it is a button, says it is selected, and is a card, not a control', () => {
    const press = vi.fn();
    drawn(
      <Tile onClick={press} selected>
        Chosen
      </Tile>,
    );
    const tile = screen.getByRole('button', { name: 'Chosen' });
    expect(tile.getAttribute('data-slot')).toBe('tile');
    expect(tile.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(tile);
    expect(press).toHaveBeenCalledTimes(1);
  });

  test('with href it is a link, and disabled it does not press', () => {
    const press = vi.fn();
    drawn(
      <>
        <Tile href="/a">Link</Tile>
        <Tile onClick={press} disabled>
          Off
        </Tile>
      </>,
    );
    expect(screen.getByRole('link', { name: 'Link' }).getAttribute('href')).toBe('/a');
    fireEvent.click(screen.getByRole('button', { name: 'Off' }));
    expect(press).not.toHaveBeenCalled();
  });
});

describe('DateNav', () => {
  test('stepping skips the days it is told to, in either direction, and is bounded', () => {
    const weekend = (day: string) => [0, 6].includes(new Date(`${day}T00:00:00Z`).getUTCDay());
    expect(stepDay('2026-11-13', 1, weekend)).toBe('2026-11-16'); // Friday to Monday
    expect(stepDay('2026-11-16', -1, weekend)).toBe('2026-11-13');
    expect(stepDay('2026-11-13', 1, () => true)).toBe('2026-11-28');
  });

  test('previous, next and a week at a time, and T goes to today unless a box is being typed in', () => {
    const seen: string[] = [];
    drawn(<DateNav value="2026-11-13" onValueChange={(day) => seen.push(day)} step="week" />);
    fireEvent.click(screen.getByRole('button', { name: 'Next week' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous week' }));
    expect(seen).toEqual(['2026-11-20', '2026-11-06']);
    const before = seen.length;
    fireEvent.keyDown(document.body, { key: 't' });
    expect(seen).toHaveLength(before + 1);
    fireEvent.keyDown(document.body, { key: 'T', metaKey: true });
    const prevented = new KeyboardEvent('keydown', { key: 't', bubbles: true, cancelable: true });
    prevented.preventDefault();
    document.body.dispatchEvent(prevented);
    expect(seen).toHaveLength(before + 1);
    const box = document.createElement('input');
    document.body.append(box);
    fireEvent.keyDown(box, { key: 't' });
    box.remove();
    expect(seen).toHaveLength(before + 1);
  });
});

describe('useNotice', () => {
  test('raises the platform notice with its tone', () => {
    const announced: { text: string; tone: 'ok' | 'error' }[] = [];
    function Raise() {
      const notice = useNotice();
      return (
        <button type="button" onClick={() => notice({ text: 'Not that day', tone: 'critical' })}>
          go
        </button>
      );
    }
    renderPage(definePage({ label: 'Desk', reads: [], commands: [], component: () => <Raise /> }), { announced });
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    expect(announced).toEqual([{ text: 'Not that day', tone: 'error' }]);
  });

  test("a warning is not said as an error, and the old word 'error' is not said as a success", () => {
    const announced: { text: string; tone: 'ok' | 'error' | 'warning' }[] = [];
    /* What a JavaScript page, or one that builds the notice untyped, still passes: the tone before the tones were unified. */
    const legacy = 'error' as unknown as 'critical';
    function Raise() {
      const notice = useNotice();
      return (
        <>
          <button type="button" onClick={() => notice({ text: 'Nearly full', tone: 'warning' })}>
            warn
          </button>
          <button type="button" onClick={() => notice({ text: 'Refused', tone: legacy })}>
            refuse
          </button>
          <button type="button" onClick={() => notice({ text: 'Saved' })}>
            save
          </button>
        </>
      );
    }
    renderPage(definePage({ label: 'Desk', reads: [], commands: [], component: () => <Raise /> }), { announced });
    for (const name of ['warn', 'refuse', 'save']) fireEvent.click(screen.getByRole('button', { name }));
    expect(announced).toEqual([
      { text: 'Nearly full', tone: 'warning' },
      { text: 'Refused', tone: 'error' },
      { text: 'Saved', tone: 'ok' },
    ]);
  });
});

/* A host that knows the lead's columns as an App says them: a label each, and the status column's tones. */
const leadHost = {
  app: true,
  column: (resource: string, column: string) =>
    resource !== 'lead'
      ? undefined
      : column === 'status'
        ? { label: 'Stage', rule: { tone: { working: 'warn', won: 'good' } } }
        : column === 'owner_name'
          ? { label: 'Owner', rule: null }
          : undefined,
} as unknown as UiHost;
const withLeads = (node: React.ReactNode) => render(<UiHostContext.Provider value={leadHost}>{node}</UiHostContext.Provider>);

describe('Person', () => {
  afterEach(() => vi.restoreAllMocks());

  test('a disc of initials a reader skips, the name it hears, and one quieter line', async () => {
    withLeads(<Person name="Ada Stone" secondary="Acme, buyer" />);
    const disc = document.querySelector('.kit-person-avatar')!;
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(await within(disc as HTMLElement).findByText('AS')).toBeInTheDocument();
    expect(screen.getByText('Ada Stone')).toHaveClass('kit-person-name');
    expect(screen.getByText('Acme, buyer')).toHaveClass('kit-person-secondary');
    expect(screen.queryByRole('link')).toBeNull();
  });

  test('with href the name is the one link, and no second line is drawn for an empty one', () => {
    withLeads(<Person name="Ada Stone" secondary="" href="/compass/contacts/7" />);
    const link = screen.getByRole('link', { name: 'Ada Stone' });
    expect(link).toHaveAttribute('href', '/compass/contacts/7');
    expect(screen.getAllByRole('link')).toHaveLength(1);
    expect(document.querySelector('.kit-person-secondary')).toBeNull();
  });

  test('carries the size asked for and defaults to sm', () => {
    const { unmount } = withLeads(<Person name="Ada Stone" size="lg" />);
    expect(document.querySelector('.kit-person')).toHaveAttribute('data-size', 'lg');
    unmount();
    withLeads(<Person name="Ada Stone" />);
    expect(document.querySelector('.kit-person')).toHaveAttribute('data-size', 'sm');
  });
});

describe('Details', () => {
  const lead = { status: 'working', owner_name: 'Ada Stone', note: null };

  test("terms are the App's labels and values are dressed as their columns are, in the record page's grid", () => {
    withLeads(<DescriptionList resource="lead" row={lead} fields={['status', 'owner_name', 'note']} />);
    const list = document.querySelector('dl')!;
    expect(list).toHaveClass('page-field-grid', 'kit-details', 'kit-details-wrap');
    expect([...list.querySelectorAll('dt')].map((term) => term.textContent)).toEqual(['Stage', 'Owner', 'note']);
    expect(screen.getByText('Working')).toHaveClass('tone', 'tone-warn');
    expect(screen.getByText('Ada Stone').closest('dd')).not.toBeNull();
  });

  test('a pair the page worked out is drawn as given, and an empty one says so', () => {
    withLeads(
      <DescriptionList
        resource="lead"
        row={lead}
        fields={[
          { label: 'Age', value: '12 days' },
          { label: 'Next step', value: '' },
        ]}
      />,
    );
    const values = [...document.querySelectorAll('dd')].map((value) => value.textContent);
    expect(values).toEqual(['12 days', '—']);
    expect(document.querySelectorAll('dt')[0]!.textContent).toBe('Age');
  });

  test('columns fixes the count at a desk', () => {
    withLeads(<DescriptionList resource="lead" row={lead} fields={['status']} columns={2} />);
    const list = document.querySelector('dl') as HTMLElement;
    expect(list).toHaveAttribute('data-columns', '2');
    expect(list.style.getPropertyValue('--page-field-columns')).toBe('repeat(2, minmax(0, 1fr))');
  });
});

describe("a table's avatar column", () => {
  test("a disc before the cell's own name, the picture from the row's field, inside the row's one link", async () => {
    withLeads(
      <Table
        ariaLabel="Leads"
        rows={[{ id: 1, owner_name: 'Ada Stone', photo: '' }]}
        columns={[{ key: 'owner_name', label: 'Owner', avatar: 'photo' }]}
        onRowClick={() => {}}
      />,
    );
    const cell = screen.getByRole('cell');
    const disc = cell.querySelector('.kit-cell-avatar')!;
    expect(disc).toHaveAttribute('aria-hidden', 'true');
    expect(await within(disc as HTMLElement).findByText('AS')).toBeInTheDocument();
    expect(within(cell).getByText('Ada Stone')).toBeInTheDocument();
  });

  test('a function of the row names the face itself', async () => {
    withLeads(
      <Table
        ariaLabel="Leads"
        rows={[{ id: 1, owner: 'Grace Hopper' }]}
        columns={[{ key: 'owner', label: 'Owner', avatar: (row) => ({ name: String(row.owner) }) }]}
      />,
    );
    expect(await within(screen.getByRole('cell')).findByText('GH')).toBeInTheDocument();
  });
});

describe("a status value under each of the looks' recipes", () => {
  afterEach(() => delete document.documentElement.dataset.lookStatus);

  /* The recipes dress `.tone.tone-*` (themeFamilies.css, sageLook.css, lumenLook.css), so a value outside a table must
     carry those classes whichever recipe the look names, and a display rule's tone names are Tone's own. */
  test.each(['dot', 'pill', 'pill-dot', 'quiet'])('%s', (recipe) => {
    document.documentElement.dataset.lookStatus = recipe;
    withLeads(
      <>
        <Value value="working" resource="lead" column="status" />
        <Value value="won" display={{ tone: { won: 'good' } }} />
      </>,
    );
    const working = screen.getByText('Working');
    expect(working).toHaveClass('tone', 'tone-warn');
    expect(working.closest('td, dd')).toBeNull();
    expect(screen.getByText('Won')).toHaveClass('tone', 'tone-good');
  });
});

describe('Bars', () => {
  test('a list of meters against the largest, each saying its group, its figure and its note', () => {
    drawn(
      <BreakdownList
        ariaLabel="By stage"
        format="money"
        items={[
          { key: 'lead', label: 'Lead', value: 1200, note: '4 deals' },
          { key: 'won', label: 'Won', value: 300 },
        ]}
      />,
    );
    const list = screen.getByRole('list', { name: 'By stage' });
    const meters = screen.getAllByRole('meter');
    expect(list.querySelectorAll('li.kit-bars-row')).toHaveLength(2);
    expect(meters.map((meter) => meter.getAttribute('aria-valuetext'))).toEqual([
      expect.stringMatching(/^Lead: .*1,200.*, 4 deals$/),
      expect.stringMatching(/^Won: .*300[^,]*$/),
    ]);
    expect(meters[0].getAttribute('aria-valuenow')).toBe('1200');
    expect(meters[0].getAttribute('aria-valuemax')).toBe('1200');
  });
});

/* The parts are token-only: a look dresses them, so a color or a corner written into their stylesheet would be the one
   place a theme cannot reach. Read as text, so it holds without a browser (e2e/page-parts-themes.spec.ts reads the same
   rule off what is drawn). */
describe('the kit parts stylesheets', () => {
  const sheet = (name: string) => readFileSync(fileURLToPath(new URL(name, import.meta.url)), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const sheets = { 'kit.css': sheet('./kit.css'), 'DashboardBlocks.css': sheet('../DashboardBlocks.css') };

  test('no color is written as a literal: each is a token, or a mix of tokens', () => {
    const literal = /#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/g;
    for (const [name, css] of Object.entries(sheets)) expect([...css.matchAll(literal)].map((m) => `${name}: ${m[0]}`)).toEqual([]);
  });

  test("a part's corner is a token, or the pill's and the disc's", () => {
    const parts = /^[^{}]*\.kit-(?:bars|person|details|cell-|param|card-part|stat-against)[^{}]*\{([^{}]*)\}/gm;
    const corners: string[] = [];
    const rules = [...sheets['kit.css'].matchAll(parts)];
    /* A renamed class would leave nothing to read, and so nothing to refuse. */
    expect(rules.length).toBeGreaterThan(20);
    for (const rule of rules) for (const [, value] of rule[1]!.matchAll(/border-radius:\s*([^;]+)/g)) corners.push(value!.trim());
    expect(corners.filter((value) => !/^(?:var\(|calc\(var\(|0\b|999px|50%|inherit)/.test(value))).toEqual([]);
  });
});
