/**
 * A command's lookup is held back when the record plainly fails its `when` (commandLookupHold.ts). A `when` naming
 * `me` reads the person first, through the lookup's own reader; a `when` that does not never does, and a capability
 * link's holder is no person, so a `when` naming `me` holds the lookup whatever the person's row says.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryRequest, QueryResult } from '../packages/engine/src/adapters/adapter.js';
import type { DatabaseSchema } from '../packages/engine/src/shared/schema.js';
import { commandCatalog } from '../packages/mistri/src/server/commands/commandDb.js';
import { lookupHeldBy } from '../packages/mistri/src/server/commands/commandLookupHold.js';

const column = (name: string, type: string, primaryKey = false) => ({ name, type, nullable: false, primaryKey });
const schema: DatabaseSchema = {
  label: 'Hold',
  dialect: 'sqlite',
  readAt: '',
  tables: [
    { id: 'member', name: 'member', schema: '', isView: false, columns: [column('id', 'INTEGER', true), column('email', 'TEXT')] },
    {
      id: 'task',
      name: 'task',
      schema: '',
      isView: false,
      columns: [
        column('id', 'INTEGER', true),
        { ...column('owner_id', 'INTEGER'), references: { table: 'member', column: 'id' } },
        column('status', 'TEXT'),
      ],
    },
  ],
  foreignKeys: [{ name: 'task.owner_id', from: { table: 'task', columns: ['owner_id'] }, to: { table: 'member', columns: ['id'] } }],
};
const table = commandCatalog(schema, ['member', 'task'], (name) => name)!.task!;
const people = { table: 'member', column: 'email', key: 'id', id: 'member' } as const;
const now = () => new Date('2026-01-01T00:00:00Z');
const person = { email: 'ada@example.test' };

/** A lookup's own reader that says the person is member 2, and counts the reads. */
function reader() {
  const reads: QueryRequest[] = [];
  const own = async (read: QueryRequest): Promise<QueryResult> => {
    reads.push(read);
    return { rows: [{ id: 2 }] } as unknown as QueryResult;
  };
  return { own, reads };
}
const authorized = (actor: Record<string, unknown>) => ({ actor, machine: undefined, people, tenant: undefined }) as never;

test('a `when` naming me reads the person first, and judges the record against them', async () => {
  const { own, reads } = reader();
  const hold = (owner: number) =>
    lookupHeldBy(
      authorized({ kind: 'account', id: 'a1', ...person }),
      { target: 'task', when: 'owner_id = me' },
      table,
      [{ id: 1, owner_id: owner }],
      own,
      now,
    );
  assert.equal(await hold(2), false, "the person's own record is not held");
  assert.equal(reads.length, 1, 'the person was read once');
  assert.equal(reads[0]!.table, 'member');
  assert.deepEqual(reads[0]!.filter, { groups: [[{ column: 'email', op: '=', value: 'ada@example.test' }]] });
  assert.equal(await hold(1), true, "someone else's record plainly fails the `when`, so the lookup is held");
  assert.equal(reads.length, 2);
});

test('a `when` that does not name me reads no person', async () => {
  const { own, reads } = reader();
  const hold = (status: string) =>
    lookupHeldBy(
      authorized({ kind: 'account', id: 'a1', ...person }),
      { target: 'task', when: 'status = open' },
      table,
      [{ id: 1, owner_id: 2, status }],
      own,
      now,
    );
  assert.equal(await hold('open'), false);
  assert.equal(await hold('closed'), true);
  assert.equal(reads.length, 0, 'no person read');
  assert.equal(
    await lookupHeldBy(authorized({ kind: 'account', id: 'a1', ...person }), { target: 'task' }, table, [{ id: 1, owner_id: 2 }], own, now),
    false,
  );
  assert.equal(reads.length, 0);
});

test('a lookup whose reader cannot make the person is refused before any outside call', async () => {
  await assert.rejects(
    lookupHeldBy(
      authorized({ kind: 'account', id: 'a1', ...person }),
      { target: 'task', when: 'owner_id = me' },
      table,
      [{ id: 1, owner_id: 2 }],
      undefined,
      now,
    ),
  );
});

test("a link's holder is no person: a `when` naming me holds the lookup, one that does not is judged on the row", async () => {
  const { own } = reader();
  const link = authorized({ kind: 'link', link: { id: 'l', name: 'n', resource: 'task', key: '1' } });
  assert.equal(await lookupHeldBy(link, { target: 'task', when: 'owner_id = me' }, table, [{ id: 1, owner_id: 2 }], own, now), true);
  assert.equal(
    await lookupHeldBy(link, { target: 'task', when: 'status = open' }, table, [{ id: 1, owner_id: 2, status: 'open' }], own, now),
    false,
  );
});
