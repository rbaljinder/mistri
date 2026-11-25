/**
 * The type a helper takes a handler's `db` by (`CommandDb<Src, Reads, Writes>`, from `@mistriwork/mistri/commands`):
 * read-only for the tables it reads, the handler's own write handle for the ones it writes, and a table it was not
 * given is a type error. Held by the root typecheck: nothing below the first test runs.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineCommand, defineSource, type CommandDb } from '@mistriwork/mistri/commands';

interface Rows {
  account: { id: number; name: string; balance: number };
  entry: { id: number; account_id: number; amount: number; memo: string | null };
  audit_note: { id: number; body: string };
}
const ledger = defineSource<Rows>('ledger');

/** Reads the account, writes an entry: the helper every money path shares. */
async function post(db: CommandDb<typeof ledger, 'account', 'entry'>, accountId: number, amount: number) {
  const account = await db.account.get(accountId);
  const entry = await db.entry.insert({ account_id: account.id, amount });
  await db.entry.update(entry, { memo: `to ${account.name}` });
  // @ts-expect-error A table the helper reads is not one it writes.
  await db.account.update(account, { balance: 0 });
  // @ts-expect-error A table the helper was not given.
  await db.audit_note.insert({ body: 'posted' });
  // @ts-expect-error A column the table does not have.
  await db.entry.insert({ account_id: account.id, amount, nope: 1 });
  return entry.id;
}

/** Read-only, as it has always been: two type parameters. */
const balanceOf = async (db: CommandDb<typeof ledger, 'account'>, id: number) => (await db.account.get(id)).balance;

export const postEntry = defineCommand({
  source: ledger,
  target: 'account',
  read: ['audit_note'],
  write: ['entry'],
  async handle({ db, record }) {
    // The handler's own `db`, which reads and writes more than the helpers ask, is handed over as it is.
    await post(db, record.id, await balanceOf(db, record.id));
  },
});

export const readOnly = defineCommand({
  source: ledger,
  target: 'account',
  async handle({ db, record }) {
    await balanceOf(db, record.id);
    // @ts-expect-error This command does not write `entry`, so its `db` is not the writing helper's.
    await post(db, record.id, 1);
  },
});

test('a helper that writes is typed by the tables it reads and the ones it writes', () => {
  assert.equal(typeof post, 'function');
});
