/**
 * Whether a command's lookup is held back: a record its machine or `when` plainly refuses as it stands holds the
 * lookup, so no outside call goes out for a command the transaction then refuses (commandWhen.ts plainlyFails). The
 * transaction judges again and says why; one that admits the record after all (it moved between the two reads) is
 * refused as stale, since the handler would run without its lookup.
 */
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { mentionsMe } from '../../shared/appMe.js';
import type { AuthorizedBusinessCommand } from './businessCommandAccess.js';
import type { CommandCatalog, UntypedRow } from './commandDb.js';
import { compileWhen, plainlyFails, whenPerson } from './commandWhen.js';

export async function lookupHeldBy(
  authorized: Pick<AuthorizedBusinessCommand, 'actor' | 'machine' | 'people' | 'tenant'>,
  command: Readonly<{ target: string; when?: string | undefined }>,
  table: CommandCatalog[string],
  rows: readonly UntypedRow[],
  own: ((read: QueryRequest) => Promise<QueryResult>) | undefined,
  now: () => Date,
): Promise<boolean> {
  /* Only a `when` that names `me` costs the person's read; the person is found as the transaction finds them
     (whenPerson over the command's people), through the lookup's `own` where the lookup can make it. A link
     has no person, so `me` is no one and the `when` is judged on that; a reader that cannot read the person
     refuses the command here, before any outside call, as the transaction's own access error would. */
  let person: { read: boolean; me?: QueryPerson } = { read: false };
  if (rows.length && mentionsMe(command.when)) {
    const me = await whenPerson(
      { query: (read) => (own ? own(read) : Promise.reject(new AppAccessDenied())) },
      authorized.actor,
      authorized.people,
      [command.when],
    );
    person = { read: true, ...(me ? { me } : {}) };
  }
  /* A link's holder is no person, so a `when` naming `me` cannot hold of them (whenPerson: no verified email). */
  if (authorized.actor.kind === 'link' && mentionsMe(command.when)) return true;
  const graph = authorized.machine?.verb && authorized.machine.tables.get(command.target);
  return rows.some((row) => {
    if (graph && !authorized.machine!.verb!.from.has(String(row[graph.column]))) return true;
    if (command.when === undefined || (mentionsMe(command.when) && !person.read)) return false;
    const me = authorized.tenant ? { ...(person.me ?? { email: authorized.actor.email ?? null }), tenant: authorized.tenant } : person.me;
    try {
      return plainlyFails(table, compileWhen(table, command.when, now(), me), row);
    } catch {
      return false;
    }
  });
}
