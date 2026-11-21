/**
 * An App's `choose` on the server: the rows a person picked (the site they work at) for one request.
 *
 * The tab sends its picks in one header (`x-mistri-chosen: site=12`); a name the header leaves out is the person's
 * stored pick (appPreferences.ts), so a page's first paint, a loader, a command and the API agree with a tab that
 * sends nothing. Nothing either says is believed: each id is read again from the choice's table through the request's
 * own reader, so the person's row policy and grants decide whether it is theirs to pick. One they cannot read —
 * forged, another tenant's, or a site taken away since — is dropped, and the request reads as if nothing were chosen.
 * A choice narrows a page; it never widens one, so it is never a grant and its store needs no trust of its own.
 */
import type { IncomingMessage } from 'node:http';
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { QueryPerson } from '@mistriwork/engine/shared/queryOperands.js';
import { primaryKey, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { AppDef } from '../../shared/appModel.js';

type Reader = { query: (request: QueryRequest) => Promise<QueryResult> };

/** The header a tab sends its picks in, as `URLSearchParams` text: `site=12&region=3`. */
export const CHOICE_HEADER = 'x-mistri-chosen';
/* A row key is a number or a short text; anything longer is no key a chooser sent. */
const KEY_MAX = 128;

/** The App-wide choices, by name, each the picked row's key as this request proved it, or null. */
export type Chosen = Readonly<Record<string, string | number | null>>;

/** What a person's stored picks hold, by name: the fallback for a name the header leaves out. */
export type StoredPicks = Readonly<Record<string, string>>;

/**
 * What the header asks, by declared name only: an undeclared name, an empty value or an overlong one asks nothing. The
 * header wins, name by name (a tab that cleared a pick wrote the clearing to the store too); `stored` fills the rest.
 */
function askedChoices(app: AppDef, header: string | string[] | undefined, stored?: StoredPicks): Record<string, string> {
  const asked: Record<string, string> = {};
  if (!app.choose) return asked;
  const text = Array.isArray(header) ? header[0] : header;
  if (typeof text === 'string' && text && text.length <= 1024) {
    for (const [name, value] of new URLSearchParams(text)) {
      if (Object.hasOwn(app.choose, name) && !Object.hasOwn(asked, name) && value && value.length <= KEY_MAX) asked[name] = value;
    }
  }
  for (const [name, value] of Object.entries(stored ?? {}))
    if (Object.hasOwn(app.choose, name) && !Object.hasOwn(asked, name) && value && value.length <= KEY_MAX) asked[name] = value;
  return asked;
}

/**
 * The request's choices, each read again under `reader`: the key as the row holds it (a number stays a number, an id
 * past 2^53 its digits) where the reader sees that row, else null. Undefined where the App declares no `choose`, so
 * `chosen.<name>` is refused there rather than read as nothing.
 */
export async function readChosen(
  app: AppDef,
  schema: DatabaseSchema,
  reader: Reader,
  header: string | string[] | undefined,
  stored?: StoredPicks,
): Promise<Chosen | undefined> {
  if (!app.choose) return undefined;
  const asked = askedChoices(app, header, stored);
  const chosen: Record<string, string | number | null> = {};
  await Promise.all(
    Object.entries(app.choose).map(async ([name, choice]) => {
      chosen[name] = null;
      const id = asked[name];
      const table = id === undefined ? undefined : tableNamed(schema, choice.from);
      const keys = table ? primaryKey(table) : [];
      if (!table || keys.length !== 1) return;
      try {
        const found = await reader.query({
          table: table.id,
          columns: [keys[0]],
          limit: 1,
          offset: 0,
          filter: { groups: [[{ column: keys[0], op: '=', value: id }]] },
        });
        const key = found.rows[0]?.[keys[0]];
        if (typeof key === 'number' || (typeof key === 'string' && key)) chosen[name] = key;
        else if (typeof key === 'bigint') chosen[name] = String(key);
      } catch {
        /* A key the column cannot hold, or a table this reader may not read: not chosen. */
      }
    }),
  );
  return Object.freeze(chosen);
}

/** The request's choices from its own headers, and the person's stored picks where it sends none. */
export const chosenFor = (
  app: AppDef,
  schema: DatabaseSchema,
  reader: Reader,
  req: Pick<IncomingMessage, 'headers'>,
  stored?: StoredPicks,
) => readChosen(app, schema, reader, req.headers[CHOICE_HEADER], stored);

/**
 * The person's stored picks as this reader may still make them, by name, as text: what the App's payload tells the
 * shell. One they can no longer read is left out of the answer and stays stored (a row policy can change back).
 */
export async function provenPicks(
  app: AppDef,
  schema: DatabaseSchema,
  reader: Reader,
  stored: StoredPicks,
): Promise<Record<string, string>> {
  const chosen = await readChosen(app, schema, reader, undefined, stored);
  const proven: Record<string, string> = {};
  for (const [name, key] of Object.entries(chosen ?? {})) if (key !== null) proven[name] = String(key);
  return proven;
}

/** The person with the request's choices on them, where the App declares any: what `chosen.<name>` reads. */
export function withChosen(person: QueryPerson, chosen: Chosen | undefined): QueryPerson {
  return chosen ? { ...person, chosen } : person;
}

/** `ctx.chosen` for a loader or a handler: each name's key, or undefined where nothing is chosen. */
export function chosenContext(chosen: Chosen | undefined): Readonly<Record<string, string | number | undefined>> {
  return Object.freeze(Object.fromEntries(Object.entries(chosen ?? {}).map(([name, key]) => [name, key ?? undefined])));
}

/* `chosen.<name>` as a query says it: not a column's own `x.chosen.y`, and not inside a quoted value. */
const CHOSEN_SAID = /(?<![\w.])chosen\.([A-Za-z_]\w*)/g;
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g;

/**
 * What `mistri check` says of an App's `choose`: each choice's `from` a table the catalog serves, with one key to pick
 * by and the label column it names; and every `chosen.<name>` the App's own texts say naming a declared choice. Texts
 * are found wherever the definition holds them (a view's query, a segment, a rollup, a policy), so a new place a query
 * is written is judged without being listed here. A handler's or a loader's code is its own: refused when it runs.
 */
export function chooseProblems(app: AppDef, schema: DatabaseSchema): string[] {
  const problems: string[] = [];
  const declared = Object.keys(app.choose ?? {});
  for (const [name, choice] of Object.entries(app.choose ?? {})) {
    const table = tableNamed(schema, choice.from);
    if (!table) {
      problems.push(`choose.${name}: "${choice.from}" is not a table the App serves.`);
      continue;
    }
    if (primaryKey(table).length !== 1) problems.push(`choose.${name}: "${choice.from}" has no single key column to pick a row by.`);
    if (choice.label !== undefined && !table.columns.some((column) => column.name === choice.label))
      problems.push(`choose.${name}: label "${choice.label}" is not a column of "${choice.from}".`);
  }
  const said = new Set<string>();
  const walk = (value: unknown, seen: Set<object>) => {
    if (typeof value === 'string') {
      if (!value.includes('chosen.')) return;
      for (const [, name] of value.replace(QUOTED, '""').matchAll(CHOSEN_SAID)) if (!declared.includes(name)) said.add(name);
    } else if (value && typeof value === 'object' && !seen.has(value)) {
      seen.add(value);
      for (const each of Array.isArray(value) ? value : Object.values(value)) walk(each, seen);
    }
  };
  const { choose: _choose, ...rest } = app;
  walk(rest, new Set());
  for (const name of said)
    problems.push(
      `chosen.${name} names no choice: ${declared.length ? `the App's choose declares ${declared.join(', ')}` : 'the App declares no choose'}.`,
    );
  return problems;
}
