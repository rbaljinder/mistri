/**
 * `auth.me.create`: a new account's row in the table people are rows of,
 * made by the server rather than by an administrator after the fact.
 *
 *   auth: { me: { from: 'member', column: 'email', create: { name: 'display_name' } } }
 *
 * Made the first time the account is seen signed in to the App — straight
 * after sign-up, or a first sign-in through an identity provider — so the
 * account a row is made for is one the server has verified, and an account
 * made while the App was down still gets its row at its next visit. The row
 * is found by its email (or, where `auth.me.by` is 'account', its account id), which the catalog check requires unique
 * (appMe.personCreateProblem): a second request racing the first meets the
 * constraint, finds the row the first made, and is done. Idempotent, then,
 * on the email column, and never a second row.
 *
 * The write is the server's own, like a stamp: no role's grant is asked, and
 * nothing a request says reaches it except through the verified session.
 */
import type { Adapter } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import { personTable } from '../../shared/appMe.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

type Writer = Pick<Adapter, 'query'> & { insert: NonNullable<Adapter['insert']> };

/* The emails (or account ids) this process has seen a row for, per App: one read per account
   per process, not one per request. Bounded so a flood of sign-ups cannot
   grow it without end; forgetting only costs a read. */
const seen = new WeakMap<AppDef, Set<string>>();
const SEEN_MOST = 10_000;

/** Whether this process has already seen the account's row: the request path asks before it loads anything.
 * `match` is what the row is found by: the email, or the account's id where `auth.me.by` is 'account'. */
export function personRowSeen(app: AppDef, match: string): boolean {
  return seen.get(app)?.has(match.trim()) === true;
}

/** What the people table's column holds for an account: its id where the App binds `me` by account, else its email. */
export const personMatch = (app: AppDef, account: { email: string; id?: string }): string | undefined =>
  (app.auth?.me?.by === 'account' ? account.id : account.email)?.trim() || undefined;

/** A name for an account that gave none: its email's local part. */
const nameOf = (email: string, name: string | undefined) => name?.trim() || email.split('@')[0] || email;

/**
 * Make the signed-in account's person row if it has none. Resolves once the
 * row is there; rejects only where the database refused the row and no row
 * carries the email afterwards either.
 */
export async function ensurePersonRow(
  app: AppDef,
  schema: DatabaseSchema,
  writer: Writer,
  account: { email: string; id?: string; name?: string },
): Promise<void> {
  const create = app.auth?.me?.create;
  if (!create) return;
  const email = account.email.trim();
  const match = personMatch(app, account);
  if (!email || !match) return;
  let known = seen.get(app);
  if (known?.has(match)) return;
  const { table, column } = personTable(app, schema);
  if (!table || !column) return;
  const [key] = primaryKey(table);
  const there = async () =>
    (
      await writer.query({
        table: table.id,
        columns: [key],
        limit: 1,
        offset: 0,
        filter: { groups: [[{ column, op: '=', value: match }]] },
      })
    ).rows.length > 0;
  if (!(await there())) {
    try {
      await writer.insert({
        table: table.id,
        values: { [column]: match, ...(create.name ? { [create.name]: nameOf(email, account.name) } : {}) },
      });
    } catch (error) {
      // Another request made it first: the unique column says so.
      if (!(await there())) throw error;
    }
  }
  if (!known) seen.set(app, (known = new Set()));
  if (known.size >= SEEN_MOST) known.clear();
  known.add(match);
}
