/**
 * The row host seam, on its own.
 *
 * A decoration declared beside a grid lands in the row it names, stays
 * mounted through repaints that move or drop other rows, and goes when its
 * own row leaves. The grid here is a stand-in that does exactly what
 * Grid.tsx does with the store — keyed rows, a stable ref per key on the
 * leading cell — so what is under test is the seam, not the grid.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { useEffect } from 'react';
import { primaryKey as sharedPk, type TableMeta } from '../../../../engine/src/shared/schema.js';
import { createRowHosts, RowDecoration, RowHosts, RowHostScope, rowKeyString, useRowHostScope, useRowHosts } from './RowHost.js';

/* Only bulkActions reads core here, and only for the key's columns. */
vi.mock('../core.js', () => ({ primaryKey: sharedPk, api: vi.fn(), quote: (value: unknown) => `'${String(value)}'` }));

const col = (name: string, primaryKey = false) => ({ name, type: 'INTEGER', nullable: !primaryKey, primaryKey });
const bigid: TableMeta = {
  id: 'bigid',
  name: 'bigid',
  schema: '',
  isView: false,
  columns: [col('id', true), col('note')] as TableMeta['columns'],
};
const line: TableMeta = {
  id: 'invoice_line',
  name: 'invoice_line',
  schema: '',
  isView: false,
  columns: [col('invoice_id', true), col('line_no', true), col('sku')] as TableMeta['columns'],
};

const mounted: string[] = [];
const unmounted: string[] = [];
beforeEach(() => {
  mounted.length = 0;
  unmounted.length = 0;
});
afterEach(() => cleanup());

/** What the grid does: rows kept by key, the leading cell handed to the store. */
function StandInGrid({ keys }: { keys: string[] }) {
  const store = useRowHostScope()!;
  return (
    <table>
      <tbody>
        {keys.map((key) => (
          <tr key={key} data-key={key}>
            <td className="row-host" ref={store.ref(key)} />
            <td>{key}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Mark({ id }: { id: string }) {
  useEffect(() => {
    mounted.push(id);
    return () => {
      unmounted.push(id);
    };
  }, [id]);
  return <b className="mark">{id}</b>;
}

function Marks({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key) => (
        <RowDecoration key={key} rowKey={key}>
          <Mark id={key} />
        </RowDecoration>
      ))}
    </>
  );
}

const markIn = (key: string) => document.querySelector(`tr[data-key="${key}"] td.row-host .mark`);

describe('keys', () => {
  test('are strings, and a 64-bit id keeps every digit', () => {
    const key = rowKeyString(bigid, { id: '9223372036854775807', note: 'int64 max' });
    expect(typeof key).toBe('string');
    expect(key).toBe('[["id","9223372036854775807"]]');
    // What Number() would have made of it: a different, valid-looking row.
    expect(key).not.toContain(String(Number('9223372036854775807')));
    expect(rowKeyString(bigid, { id: 1 })).toBe('[["id","1"]]');
  });

  test("are spelled as bulkKey spells them, so a selection made on the grid is the queue's", async () => {
    const { bulkKey } = await import('../bulkActions.js');
    const cases: Array<[TableMeta, Record<string, unknown>]> = [
      [bigid, { id: '9223372036854775807' }],
      [bigid, { id: 7 }],
      [line, { invoice_id: 1001, line_no: 2 }],
    ];
    for (const [table, row] of cases) expect(rowKeyString(table, row)).toBe(bulkKey(table, row));
  });

  test('a composite key names every column, in key order', () => {
    expect(rowKeyString(line, { sku: 'SKU-100', line_no: 2, invoice_id: 1001 })).toBe('[["invoice_id","1001"],["line_no","2"]]');
  });

  test('a row that cannot say which row it is has none', () => {
    expect(rowKeyString(undefined, { id: 1 })).toBeNull();
    expect(rowKeyString(bigid, { note: 'a projection without the key' })).toBeNull();
    expect(rowKeyString(line, { invoice_id: 1001 })).toBeNull();
    // NULL equals nothing, and must not collide with the text 'null'.
    expect(rowKeyString(bigid, { id: null })).toBeNull();
    expect(rowKeyString({ ...bigid, columns: [col('note')] as TableMeta['columns'] }, { note: 'x' })).toBeNull();
  });
});

describe('the store', () => {
  test('one stable ref per key, and a snapshot that changes only when a host does', () => {
    const store = createRowHosts();
    const ref = store.ref('a');
    expect(store.ref('a')).toBe(ref);
    const before = store.hosts();
    expect(store.hosts()).toBe(before);
    const cell = document.createElement('td');
    const cleanupA = ref(cell);
    expect(store.hosts()).not.toBe(before);
    expect(store.hosts().get('a')).toBe(cell);
    const settled = store.hosts();
    ref(cell);
    expect(store.hosts()).toBe(settled);
    cleanupA?.();
    expect(store.hosts().has('a')).toBe(false);
  });

  test('a stale departure does not take a newer host with it', () => {
    const store = createRowHosts();
    const first = document.createElement('td');
    const second = document.createElement('td');
    const leaveFirst = store.ref('a')(first);
    store.ref('a')(second);
    leaveFirst?.();
    expect(store.hosts().get('a')).toBe(second);
  });

  test('tells its readers when a host arrives or leaves', () => {
    const store = createRowHosts();
    let told = 0;
    const stop = store.subscribe(() => {
      told += 1;
    });
    const leave = store.ref('a')(document.createElement('td'));
    leave?.();
    stop();
    store.ref('b')(document.createElement('td'));
    expect(told).toBe(2);
  });
});

describe('decorations', () => {
  test('land in the host for their key, in the same commit as the row', () => {
    render(
      <RowHosts>
        <StandInGrid keys={['a', 'b']} />
        <Marks keys={['a', 'b']} />
      </RowHosts>,
    );
    expect(markIn('a')).toHaveTextContent('a');
    expect(markIn('b')).toHaveTextContent('b');
    expect(document.querySelectorAll('.mark')).toHaveLength(2);
  });

  test('wait for a row that is not drawn yet, and arrive with it', () => {
    const view = render(
      <RowHosts>
        <StandInGrid keys={['a']} />
        <Marks keys={['a', 'b']} />
      </RowHosts>,
    );
    expect(markIn('b')).toBeNull();
    expect(mounted).toEqual(['a']);
    view.rerender(
      <RowHosts>
        <StandInGrid keys={['a', 'b']} />
        <Marks keys={['a', 'b']} />
      </RowHosts>,
    );
    expect(markIn('b')).toHaveTextContent('b');
    expect(mounted).toEqual(['a', 'b']);
  });

  test('survive a repaint that reorders, adds and drops other rows', () => {
    const view = render(
      <RowHosts>
        <StandInGrid keys={['a', 'b']} />
        <Marks keys={['a', 'b', 'c']} />
      </RowHosts>,
    );
    const b = markIn('b');
    view.rerender(
      <RowHosts>
        <StandInGrid keys={['c', 'b']} />
        <Marks keys={['a', 'b', 'c']} />
      </RowHosts>,
    );
    // The same node, never unmounted: b's row moved, it was not redrawn.
    expect(markIn('b')).toBe(b);
    expect(mounted.filter((id) => id === 'b')).toHaveLength(1);
    expect(unmounted).not.toContain('b');
    expect(markIn('c')).toHaveTextContent('c');
  });

  test('unmount when their row leaves the result', () => {
    const view = render(
      <RowHosts>
        <StandInGrid keys={['a', 'b']} />
        <Marks keys={['a', 'b']} />
      </RowHosts>,
    );
    view.rerender(
      <RowHosts>
        <StandInGrid keys={['b']} />
        <Marks keys={['a', 'b']} />
      </RowHosts>,
    );
    expect(unmounted).toEqual(['a']);
    expect(document.querySelectorAll('.mark')).toHaveLength(1);
    expect(markIn('b')).toHaveTextContent('b');
  });

  test('with no scope, or a null one, there is nothing to decorate', () => {
    function Keys() {
      return <p data-testid="keys">{[...useRowHosts().keys()].join(',') || 'none'}</p>;
    }
    const view = render(<Keys />);
    expect(view.getByTestId('keys')).toHaveTextContent('none');
    view.rerender(
      <RowHosts>
        <StandInGrid keys={['a']} />
        <RowHostScope store={null}>
          <Keys />
        </RowHostScope>
      </RowHosts>,
    );
    expect(view.getByTestId('keys')).toHaveTextContent('none');
    view.rerender(
      <RowHosts>
        <StandInGrid keys={['a']} />
        <Keys />
      </RowHosts>,
    );
    expect(view.getByTestId('keys')).toHaveTextContent('a');
  });
});
