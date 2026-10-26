/**
 * Who an @ offers: the people (and teams) of the declared resources, by what
 * was typed, each said by its name; a stored handle shown beside the name
 * only where it is a word a person would say, never a key.
 */
import { expect, test, vi } from 'vitest';

const rows: Record<string, Array<Record<string, unknown>>> = {
  agent: [
    { id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', first_name: 'Morgan' },
    { id: '7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a', first_name: 'Morgan' },
  ],
  member: [
    { username: 'morgan.h', name: 'Morgan Hughes' },
    { username: '42', name: 'Morgan Tran' },
  ],
  team: [{ id: 7, name: 'Network and Infrastructure' }],
  squad: [
    { id: 7, name: 'Network' },
    { id: 8, name: 'Nobody yet' },
  ],
  squad_member: [{ squad_id: 7 }],
  staff: [
    { id: '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b', first_name: 'Morgan', last_name: 'Hughes', email: 'mhughes@example.test' },
    { id: '7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a', first_name: 'Morgan', last_name: 'Tran', email: 'mtran@example.test' },
  ],
};
const asked: string[] = [];
vi.mock('../core.js', () => ({
  api: async (_path: string, body: { q: string }) => {
    asked.push(body.q);
    return { rows: rows[body.q.split(' ')[0]] ?? [] };
  },
  quote: (text: string) => JSON.stringify(text),
  findTable: (id: string) =>
    id === 'agent'
      ? {
          id,
          columns: [
            { name: 'id', primaryKey: true },
            { name: 'first_name', primaryKey: false },
          ],
        }
      : id === 'staff'
        ? {
            id,
            columns: [
              { name: 'id', type: 'uuid', primaryKey: true },
              { name: 'first_name', type: 'text' },
              { name: 'last_name', type: 'text' },
              { name: 'email', type: 'text' },
            ],
          }
        : { id, columns: [] },
  refsFrom: (id: string) => (id === 'squad_member' ? [{ from: { columns: ['squad_id'] }, to: { table: 'squad', columns: ['id'] } }] : []),
}));

const { mentionSearch } = await import('./RichTextField.js');

test('a person keyed by the database is offered by name alone, never "@<uuid>"', async () => {
  /* The list said "Morgan @3f2a9c1e-…" for every agent: the handle stored is the key, not a word. */
  const people = await mentionSearch({ from: 'agent', by: 'id', labelColumn: 'first_name' }, 'desk')('mor');
  expect(people.map((person) => [person.label, person.handle])).toEqual([
    ['Morgan', undefined],
    ['Morgan', undefined],
  ]);
  expect(people[0].id).toBe('3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b');
});

test('a handle that is a word tells two people apart; a number is not one', async () => {
  const people = await mentionSearch({ from: 'member', by: 'username', labelColumn: 'name' }, 'desk')('mor');
  expect(people.map((person) => [person.label, person.handle])).toEqual([
    ['Morgan Hughes', 'morgan.h'],
    ['Morgan Tran', undefined],
  ]);
});

test('teams are offered after the people, said as teams', async () => {
  const offered = await mentionSearch(
    { from: 'member', by: 'username', labelColumn: 'name', groups: { from: 'team', by: 'id', labelColumn: 'name' } },
    'desk',
  )('n');
  expect(offered.at(-1)).toEqual({ id: '7', label: 'Network and Infrastructure', kind: 'group' });
});

test('a label template tells two Morgans apart, whether the handle is a UUID or an email', async () => {
  for (const by of ['id', 'email']) {
    asked.length = 0;
    const people = await mentionSearch({ from: 'staff', by, labelColumn: '{first_name} {last_name}' }, 'desk')('Mor');
    expect(people.map((person) => [person.label, person.handle])).toEqual([
      ['Morgan Hughes', undefined],
      ['Morgan Tran', undefined],
    ]);
    // Stored as the handle: an email is one, where it used to drop every row.
    expect(people[1].id).toBe(by === 'id' ? '7d1e2f3a-4b5c-4d6e-8f9a-0b1c2d3e4f5a' : 'mtran@example.test');
    // Each word of the label is looked for, and the handle where it is text; a UUID is not searched as text.
    expect(asked[0]).toContain('first_name startswith Mor');
    expect(asked[0]).toContain('last_name contains " Mor"');
    expect(asked[0].includes('email startswith')).toBe(by === 'email');
    expect(asked[0]).not.toContain('id startswith');
    expect(asked[0]).toMatch(/show .*first_name, last_name sort first_name, last_name$/);
  }
});

test('with "through", only a team that has a member is offered', async () => {
  asked.length = 0;
  const offered = await mentionSearch(
    {
      from: 'member',
      by: 'username',
      labelColumn: 'name',
      groups: { from: 'squad', by: 'id', labelColumn: 'name', through: 'squad_member' },
    },
    'desk',
  )('n');
  expect(offered.filter((item) => item.kind === 'group')).toEqual([{ id: '7', label: 'Network', kind: 'group' }]);
  expect(asked).toContain('squad_member squad_id in (7, 8) show squad_id');
});
