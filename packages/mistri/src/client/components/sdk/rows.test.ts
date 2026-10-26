import { expect, test } from 'vitest';
import { rowPart } from '../../../../../engine/src/shared/recordReadKeys.js';
import { rowsByPath } from './rows.js';

test("a custom section's record values are labelled by their own columns, whatever order the page read them in", () => {
  /* G45: the page reads its row once, in the order the first reader named the
     columns (the header's `state` before `number`); a later section that names
     `id, state, number` is handed its columns of that one answer. */
  const read = {
    view: { columns: [{ path: 'state' }, { path: 'number' }, { path: 'id' }, { path: 'is_draft' }] },
    columns: ['state', 'number', 'id', 'is_draft'],
    rows: [{ state: 'closed', number: 'INC-7', id: 7, is_draft: false }],
  };
  const strip = ['id', 'state', 'number'];
  expect(rowsByPath(strip, rowPart(read, strip), 'unread')).toEqual([{ id: 7, state: 'closed', number: 'INC-7' }]);
  // A label path is answered under the server's own name for it.
  const named = {
    view: { columns: [{ path: 'owner_id.name' }, { path: 'id' }] },
    columns: ['owner_name', 'id'],
    rows: [{ owner_name: 'Ada', id: 3 }],
  };
  expect(rowsByPath(['id', 'owner_id.name'], named, 'unread')).toEqual([{ id: 3, 'owner_id.name': 'Ada' }]);
});

test('a timestamp column reaches a component as ISO 8601 with a full offset, the same instant, and nothing else is rewritten', () => {
  // G109: Postgres text (`-04`, `+00`) is NaN to Date.parse; the grid keeps showing what is stored.
  const column = (name: string, type: string) => ({ name, type, nullable: true, primaryKey: false });
  const table = {
    name: 'announcement',
    schema: 'public',
    id: 'announcement',
    columns: [
      column('id', 'integer'),
      column('ends_at', 'timestamp with time zone'),
      column('starts_at', 'timestamp without time zone'),
      column('on_day', 'date'),
      column('note', 'text'),
    ],
  };
  const schema = { label: 'x', dialect: 'postgres', tables: [table], foreignKeys: [], readAt: '' } as never;
  const paths = ['id', 'ends_at', 'starts_at', 'on_day', 'note'];
  const stamps = [
    ['2026-10-12 19:16:00-04', '2026-10-12T19:16:00-04:00'],
    ['2026-10-12 19:16:00+00', '2026-10-12T19:16:00+00:00'],
    ['2026-10-12 19:16:00+05:30', '2026-10-12T19:16:00+05:30'],
    ['2026-10-12 19:16:00.123456-04', '2026-10-12T19:16:00.123456-04:00'],
    ['2026-10-12T19:16:00Z', '2026-10-12T19:16:00Z'],
  ] as const;
  for (const [stored, iso] of stamps) {
    const got = {
      view: null,
      columns: paths,
      rows: [{ id: 1, ends_at: stored, starts_at: '2026-10-12 19:16:00', on_day: '2026-10-12', note: stored }],
    };
    const [row] = rowsByPath(paths, got, 'unread', { schema, base: 'announcement' });
    expect(row.ends_at).toBe(iso);
    expect(Number.isNaN(Date.parse(String(row.ends_at)))).toBe(false);
    expect(Date.parse(String(row.ends_at))).toBe(Date.parse(iso));
    // No zone is stored, so none is invented; a plain date is already parseable and is left alone.
    expect(row.starts_at).toBe('2026-10-12T19:16:00');
    expect(Number.isNaN(Date.parse(String(row.starts_at)))).toBe(false);
    expect(row.on_day).toBe('2026-10-12');
    expect(Number.isNaN(Date.parse(String(row.on_day)))).toBe(false);
    // A text column that merely looks like a timestamp is the author's.
    expect(row.note).toBe(stored);
  }
  // The same instant whatever spelling the offset came in.
  const spelled = (stored: string) =>
    Date.parse(
      String(
        rowsByPath(['ends_at'], { view: null, columns: ['ends_at'], rows: [{ ends_at: stored }] }, 'unread', {
          schema,
          base: 'announcement',
        })[0].ends_at,
      ),
    );
  expect(spelled('2026-10-12 19:16:00-04')).toBe(Date.UTC(2026, 9, 12, 23, 16, 0));
  expect(spelled('2026-10-12 19:16:00+00')).toBe(Date.UTC(2026, 9, 12, 19, 16, 0));
  expect(spelled('2026-10-12 19:16:00+05:30')).toBe(Date.UTC(2026, 9, 12, 13, 46, 0));
  expect(spelled('2026-10-12 19:16:00.5-04')).toBe(Date.UTC(2026, 9, 12, 23, 16, 0, 500));
  // Without a schema (or a column it can place) a value is read as it came.
  expect(
    rowsByPath(['ends_at'], { view: null, columns: ['ends_at'], rows: [{ ends_at: '2026-10-12 19:16:00-04' }] }, 'unread')[0].ends_at,
  ).toBe('2026-10-12 19:16:00-04');
});
