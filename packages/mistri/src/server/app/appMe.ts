/**
 * `me`, the server's side (the word is packages/mistri/src/shared/appMe.ts): the verified
 * session's account, and — where the App says which table people are rows
 * of (`auth.me`) — the key of the row carrying its email, read through the
 * request's own reader, so a person is looked up only where this principal
 * may read people.
 *
 * An App may keep people's emails from each other (a field grant that leaves
 * the email column out) and still say `author_id = me`. Then the server finds
 * the row by the verified email itself (`trusted`) and the reader is asked
 * only whether it can see that one row: all it learns is the key of its own
 * row, which it could read anyway, and no email but its own ever reaches a
 * filter.
 */
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import { meSetShape, meSetsIn, mentionsMe, personTable } from '../../shared/appMe.js';
import type { QueryPerson } from '@mistriwork/engine/shared/query.js';
import type { MeSet } from '@mistriwork/engine/shared/queryOperands.js';
import { primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

type Reader = { query: (request: QueryRequest) => Promise<QueryResult> };

/**
 * Who `me` is for one request. `who` is the verified account's email
 * (signedInAs); absent, nobody is signed in and a condition on `me` says so.
 * Two rows carrying one email name nobody in particular, so neither is theirs.
 */
export async function lookupPerson(
  app: AppDef,
  schema: DatabaseSchema,
  who: string | undefined,
  reader: Reader,
  trusted?: { schema: DatabaseSchema; reader: Reader },
): Promise<QueryPerson> {
  const email = who ?? null;
  const { table, column } = personTable(app, schema);
  /* The reader's catalog lacks the email column (or the table): the App's
     own catalog says who people are, and the reader only whose row it sees. */
  if ((!table || !column) && trusted) {
    const whole = personTable(app, trusted.schema);
    if (!whole.table || !whole.column) return { email };
    const person = { table: whole.table.id, key: null };
    if (email === null) return { email, person };
    const [pk] = primaryKey(whole.table);
    const found = await trusted.reader.query({
      table: whole.table.id,
      columns: [pk],
      limit: 2,
      offset: 0,
      filter: { groups: [[{ column: whole.column, op: '=', value: email }]] },
    });
    const key = found.rows.length === 1 ? found.rows[0][pk] : null;
    if (typeof key !== 'number' && typeof key !== 'string') return { email, person };
    let seen = false;
    try {
      seen =
        (
          await reader.query({
            table: whole.table.id,
            columns: [pk],
            limit: 1,
            offset: 0,
            filter: { groups: [[{ column: pk, op: '=', value: key }]] },
          })
        ).rows.length === 1;
    } catch {
      /* A reader who may not read people is nobody's row. */
    }
    return { email, person: { table: whole.table.id, key: seen ? key : null } };
  }
  if (!table || !column) return { email };
  if (email === null) return { email, person: { table: table.id, key: null } };
  const [pk] = primaryKey(table);
  const found = await reader.query({
    table: table.id,
    columns: [pk],
    limit: 2,
    offset: 0,
    filter: { groups: [[{ column, op: '=', value: email }]] },
  });
  const key = found.rows.length === 1 ? found.rows[0][pk] : null;
  return { email, person: { table: table.id, key: typeof key === 'number' || typeof key === 'string' ? key : null } };
}

/**
 * Who `me` is in a tenant App, for one request on one lease: the row of
 * `auth.me`'s table whose account column holds the lease's account, read
 * through the lease's own reader — which sees its tenant's rows and no
 * other's, so the row found is this tenant's person, and the same account in
 * another tenant is another row (or none). `account` is the admitted
 * membership's, never anything a request says. A tenant with no row for the
 * account, a reader whose catalog lacks the account column, and a support
 * session (pass `account` undefined) all mean nobody: `owner_id = me` then matches nothing.
 * Text beside `me` is the session's email, as in any App.
 */
export async function lookupTenantPerson(
  app: AppDef,
  schema: DatabaseSchema,
  who: string | null,
  account: string | undefined,
  reader: Reader,
): Promise<QueryPerson> {
  const { table, column } = personTable(app, schema);
  /* The table is this reader's but its account column is not: nobody, rather
     than a `me` that compares a reference with an email. */
  const people = table ?? (app.auth?.me ? schema.tables.find((t) => t.id === app.auth!.me!.from && primaryKey(t).length === 1) : undefined);
  if (!people) return { email: who };
  const nobody: QueryPerson = { email: who, person: { table: people.id, key: null } };
  if (!table || !column || account === undefined) return nobody;
  const [pk] = primaryKey(table);
  /* A refusal is not caught: on a lease it is the lease's answer, never "nobody". */
  const found = await reader.query({
    table: table.id,
    columns: [pk],
    limit: 2,
    offset: 0,
    filter: { groups: [[{ column, op: '=', value: account }]] },
  });
  /* Two rows for one account in one tenant name nobody in particular. */
  const key = found.rows.length === 1 ? found.rows[0][pk] : null;
  return { email: who, person: { table: table.id, key: typeof key === 'number' || typeof key === 'string' ? key : null } };
}

/**
 * `me` for an account signed in with an email nobody has proven, where anyone
 * may sign up (auth.ts `emailUnproven`): someone is signed in, so `me` is not
 * an error, and it is nobody's row and no one's address, so it matches nothing.
 */
export function unprovenPerson(app: AppDef, schema: DatabaseSchema): QueryPerson {
  const people = app.auth?.me ? schema.tables.find((t) => t.id === app.auth!.me!.from) : undefined;
  return { email: null, unproven: true, ...(people ? { person: { table: people.id, key: null } } : {}) };
}

/** The most values one `me.<table>.<column>` holds: a person's teams or territories, not a table. */
const ME_SET_MOST = 1000;

/**
 * The memberships a request's text reads (`me.group_member.group_id`), laid on the person it means: the values of the column in the
 * rows that point at their row, read through the request's own reader and
 * catalog — so a row its grants, its row policy or another tenant hide is
 * none of them — and no row's at all where the person has none. A table or
 * column the reader cannot read is said as the parse's refusal, not read
 * around. Text that names none returns the person as it was.
 */
export async function readMeSets<P extends QueryPerson | null | undefined>(
  person: P,
  texts: readonly unknown[],
  schema: DatabaseSchema,
  reader: Reader,
): Promise<P> {
  const names = person ? meSetsIn(...texts, ...segmentsNamed(texts, schema)) : [];
  if (!person || !names.length) return person;
  const sets: Record<string, MeSet> = {};
  for (const name of names) {
    const shape = meSetShape(schema, person.person, name);
    const key = person.person?.key;
    if (!('table' in shape) || key === null || key === undefined || (person.email === null && !person.unproven)) {
      sets[name] = shape.set;
      continue;
    }
    /* A refusal is not caught: on a lease or under a row policy it is the reader's answer, never "no teams". */
    const found = await reader.query({
      table: shape.table.id,
      columns: [shape.column],
      limit: ME_SET_MOST + 1,
      offset: 0,
      filter: { groups: [[{ column: shape.link, op: '=', value: key }]] },
    });
    if (found.rows.length > ME_SET_MOST) {
      sets[name] = {
        error: `me.${name} holds more than ${ME_SET_MOST.toLocaleString('en-US')} rows of the signed-in person's; it reads a person's teams, not a table.`,
      };
      continue;
    }
    const values = new Set<string | number>();
    for (const row of found.rows) {
      const value = row[shape.column];
      if (typeof value === 'string' || typeof value === 'number') values.add(value);
    }
    sets[name] = { values: [...values], kind: 'kind' in shape.set ? shape.set.kind : 'other' };
  }
  return { ...person, sets: { ...person.sets, ...sets } };
}

/** The key of the signed-in person's row (`auth.me`), what `me` writes to a reference to people; null for nobody's. */
export async function personKey(
  app: AppDef,
  schema: DatabaseSchema,
  who: string | undefined,
  reader: Reader,
): Promise<string | number | null> {
  return (await lookupPerson(app, schema, who, reader)).person?.key ?? null;
}

/**
 * The conditions of every segment a text names, and of the segments those
 * name: a tab that says `my_groups` reads `me.group_member.group_id` where the
 * segment is written, and the parse spells it out only after the sets are read.
 */
/**
 * Whether any of these texts compares with `me`, directly or through a segment it names: a tab that names
 * `my_threads` (`author_id = me`) says no `me` of its own, and read without the person it matches nobody.
 */
export function textsMentionMe(texts: readonly unknown[], schema: DatabaseSchema): boolean {
  const said = texts.filter((text): text is string => typeof text === 'string');
  return said.some((text) => mentionsMe(text)) || segmentsNamed(said, schema).some((text) => mentionsMe(text));
}

function segmentsNamed(texts: readonly unknown[], schema: DatabaseSchema): string[] {
  const books = schema.tables.flatMap((table) => (table.segments ? Object.entries(table.segments) : []));
  if (!books.length) return [];
  const found: string[] = [];
  let pending = texts.filter((text): text is string => typeof text === 'string');
  for (let depth = 0; pending.length && depth < 8; depth++) {
    const next = books
      .filter(([name, query]) => !found.includes(query) && pending.some((text) => new RegExp(`(?<![\\w.])${name}(?![\\w.])`).test(text)))
      .map(([, query]) => query);
    found.push(...next);
    pending = next;
  }
  return found;
}
