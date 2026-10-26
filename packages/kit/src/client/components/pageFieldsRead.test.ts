import { expect, test } from 'vitest';
import { readPageFields } from './pageFieldsRead.js';

const filter = { groups: [[{ path: 'id', op: '=' as const, value: 4 }]] };
const read = (columns: string[], over: Record<string, unknown> = {}) => ({
  owner: 'demo',
  pageId: 'lead',
  base: { id: 'lead', name: 'lead' },
  filter,
  columns,
  ...over,
});
type Body = { view: { columns: Array<{ path: string }> } };
/** A server that answers any view of the row with exactly the columns asked. */
function server(row: Record<string, unknown>, refuse?: (columns: string[]) => boolean) {
  const sent: string[][] = [];
  const send = async (body: Body) => {
    const columns = body.view.columns.map((column) => column.path);
    sent.push(columns);
    if (refuse?.(columns)) return { errors: [{ message: 'no' }] };
    return {
      view: body.view,
      columns,
      resolved: columns.map((path) => ({ path, name: path })),
      rows: [Object.fromEntries(columns.map((path) => [path, row[path]]))],
    };
  };
  return { sent, send };
}

test('sections asking in one tick share one read of the row, and each gets exactly what it would have alone', async () => {
  const { sent, send } = server({ name: 'Ada', status: 'new', city: 'Lyon' });
  const [a, b] = await Promise.all([readPageFields(read(['name', 'status']), send), readPageFields(read(['status', 'city']), send)]);
  expect(sent).toEqual([['name', 'status', 'city']]);
  expect(a).toMatchObject({
    columns: ['name', 'status'],
    rows: [{ name: 'Ada', status: 'new' }],
    view: { columns: [{ path: 'name' }, { path: 'status' }] },
  });
  expect(b).toMatchObject({ columns: ['status', 'city'], rows: [{ status: 'new', city: 'Lyon' }] });
  expect(Object.keys((a as { rows: object[] }).rows[0])).toEqual(['name', 'status']);
});

test('another record, page or connection is never folded into the read', async () => {
  const { sent, send } = server({ name: 'Ada' });
  await Promise.all([
    readPageFields(read(['name']), send),
    readPageFields(read(['name'], { owner: 'other' }), send),
    readPageFields(read(['name'], { filter: { groups: [[{ path: 'id', op: '=', value: 5 }]] } }), send),
    readPageFields(read(['name'], { pageId: 'other' }), send),
  ]);
  expect(sent).toHaveLength(4);
});

test('a shared read that is refused is asked again a section at a time, so only the section that cannot read fails', async () => {
  const { sent, send } = server({ name: 'Ada', salary: 1 }, (columns) => columns.includes('salary'));
  const [ok, refused] = await Promise.all([readPageFields(read(['name']), send), readPageFields(read(['salary']), send)]);
  expect(sent).toEqual([['name', 'salary'], ['name'], ['salary']]);
  expect(ok).toMatchObject({ rows: [{ name: 'Ada' }] });
  expect(refused).toEqual({ errors: [{ message: 'no' }] });
});

test('reads in a later tick are read again, not answered from an earlier batch', async () => {
  const { sent, send } = server({ name: 'Ada' });
  await readPageFields(read(['name']), send);
  await readPageFields(read(['name']), send);
  expect(sent).toHaveLength(2);
});
