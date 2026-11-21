/**
 * An App's `choose` at the machine doors (the App API, App MCP): the picks the call names, never a stored one.
 *
 * A person's picks are theirs: the shell sends them in a header and the server falls back to what they stored
 * (app/appChoices.ts). A token is not a person, and reading a stored pick for it would make one call answer by what
 * someone last clicked in a tab. So a call says its picks itself, as `chosen.<name>=<key>` query parameters on a read,
 * a `chosen` object beside a command's input, an App MCP tool's `chosen` argument, or the same header the browser
 * sends; a name it leaves out is unset, and a text that uses one is refused with the words a job gets.
 *
 * What a call says is believed no more than a tab's header: each key is read again from the choice's table under the
 * token's own scoped reader (its grants, its row filter, its tenant), and one it cannot read is null and matches no
 * row. A key the table cannot hold at all (the wrong kind for its primary key) is the caller's mistake and a 422. A
 * pick narrows a read or tells a handler where it works; it never widens one and nothing here writes it.
 */
import { columnKind, primaryKey, tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import type { QueryPerson } from '@mistriwork/engine/shared/queryOperands.js';
import type { AppDef } from '../../shared/appModel.js';
import { CHOICE_HEADER, readChosen, type Chosen } from '../app/appChoices.js';
import { ApiReadFailure } from './apiReadFailure.js';

type Reader = Parameters<typeof readChosen>[2];

/** The query parameter a read names one pick by: `chosen.site=12`. */
const CHOSEN_PARAMETER = /^chosen\.(.*)$/s;
/* A row key is a number or a short text, as the header's reader holds it (app/appChoices.ts). */
const KEY_MAX = 128;

/** The picks a call named, by choice name, as the text it sent. */
export type ApiChosenAsk = Readonly<Record<string, string>>;

/** What a read or command is judged with: the picks it named, and the declared names it left out. */
export type ApiChosen = Readonly<{ chosen: Chosen; unset: readonly string[] }>;

const declaredNames = (app: AppDef): string[] => Object.keys(app.choose ?? {});

const invalid = (name: string, why: string): never => {
  throw new ApiReadFailure('chosen_invalid', `chosen.${name} ${why}`);
};

/** One key as the choice's table could hold it: its primary key's kind decides, as a typed filter's value is. */
function checkKey(app: AppDef, schema: DatabaseSchema, name: string, key: string): void {
  if (!key || key.length > KEY_MAX || /[\p{Cc}\p{Cs}]/u.test(key))
    return invalid(name, 'is not a usable key: it must be 1 to 128 characters.');
  const choice = app.choose![name];
  const table = tableNamed(schema, choice.from);
  const keys = table ? primaryKey(table) : [];
  const column = table && keys.length === 1 ? table.columns.find((candidate) => candidate.name === keys[0]) : undefined;
  if (column && columnKind(column.type) === 'number' && !/^-?\d+(?:\.\d+)?$/.test(key))
    invalid(name, `is not a key of ${choice.from}: its ${keys[0]} is a number.`);
}

/** Each `chosen.<name>=<key>` in a raw query, decoded as the list parameters are; the rest of the query is not read here. */
function chosenParametersOf(rawQuery: string): Record<string, string> {
  const found: Record<string, string> = {};
  for (const part of (rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery).split('&')) {
    const equals = part.indexOf('=');
    if (equals <= 0) continue;
    try {
      const name = decodeURIComponent(part.slice(0, equals).replace(/\+/g, ' '));
      const match = CHOSEN_PARAMETER.exec(name);
      if (match) found[match[1]] = decodeURIComponent(part.slice(equals + 1).replace(/\+/g, ' '));
    } catch {
      /* A malformed escape is the list parameters' refusal to make. */
    }
  }
  return found;
}

/** What a call named, judged against the App: a name the App does not declare, or a key its table cannot hold, is refused. */
export function checkChosenAsk(app: AppDef, schema: DatabaseSchema, asked: Readonly<Record<string, unknown>>): ApiChosenAsk {
  const checked: Record<string, string> = {};
  for (const [name, key] of Object.entries(asked)) {
    if (!app.choose || !Object.hasOwn(app.choose, name))
      return invalid(name, `names no choice: the App's choose declares ${declaredNames(app).join(', ') || 'none'}.`);
    if (typeof key !== 'string' && typeof key !== 'number') return invalid(name, 'must be a row key, a number or text.');
    checkKey(app, schema, name, String(key));
    checked[name] = String(key);
  }
  return Object.freeze(checked);
}

/** The picks a read's raw query names (`chosen.<name>=<key>`), checked. */
export const chosenAskOf = (app: AppDef, schema: DatabaseSchema, rawQuery: string): ApiChosenAsk =>
  checkChosenAsk(app, schema, chosenParametersOf(rawQuery));

/**
 * The browser's header spelling on a machine call: its picks join the query the owners read, where the same name in
 * the query wins. Undeclared names and unusable keys in a header are dropped, as a tab's header is read, not refused:
 * one client library sends the header to every door.
 */
export function withChosenHeader(app: AppDef, rawQuery: string, header: string | string[] | undefined): string {
  const text = Array.isArray(header) ? header[0] : header;
  if (!app.choose || typeof text !== 'string' || !text || text.length > 1024) return rawQuery;
  const named = chosenParametersOf(rawQuery);
  const added: string[] = [];
  for (const [name, key] of new URLSearchParams(text))
    if (
      Object.hasOwn(app.choose, name) &&
      !Object.hasOwn(named, name) &&
      key &&
      key.length <= KEY_MAX &&
      !added.some((a) => a.startsWith(`chosen.${name}=`))
    )
      added.push(`chosen.${name}=${encodeURIComponent(key)}`);
  return added.length ? [rawQuery, ...added].filter(Boolean).join('&') : rawQuery;
}

/** The header's picks as a body-style object, for a command call. Same reading as `withChosenHeader`. */
function chosenHeaderObject(app: AppDef, header: string | string[] | undefined): Record<string, string> {
  const found: Record<string, string> = {};
  const text = Array.isArray(header) ? header[0] : header;
  if (!app.choose || typeof text !== 'string' || !text || text.length > 1024) return found;
  for (const [name, key] of new URLSearchParams(text))
    if (Object.hasOwn(app.choose, name) && !Object.hasOwn(found, name) && key && key.length <= KEY_MAX) found[name] = key;
  return found;
}

/**
 * What a call named as a judgment's input, before any read: the keys as the caller wrote them. Undefined where the App
 * declares no `choose` or the call named nothing, which is "no person at a desk" and says so in the words.
 */
export function askedChosen(app: AppDef, ask: ApiChosenAsk): ApiChosen | undefined {
  if (!app.choose || !Object.keys(ask).length) return undefined;
  return Object.freeze({ chosen: Object.freeze({ ...ask }), unset: declaredNames(app).filter((name) => !Object.hasOwn(ask, name)) });
}

/** The same, each key read again under `reader`: the row's own key where the reader sees it, else null. */
export async function resolveApiChosen(
  app: AppDef,
  schema: DatabaseSchema,
  reader: Reader,
  ask: ApiChosenAsk,
): Promise<ApiChosen | undefined> {
  const named = askedChosen(app, ask);
  if (!named) return undefined;
  const read = await readChosen(app, schema, reader, new URLSearchParams(ask as Record<string, string>).toString());
  const chosen: Record<string, string | number | null> = {};
  for (const name of Object.keys(ask)) chosen[name] = read?.[name] ?? null;
  return Object.freeze({ chosen: Object.freeze(chosen), unset: named.unset });
}

/**
 * A command call's picks, taken out of the body it arrived in: the App declares `choose`, so a top-level `chosen`
 * object beside the input (or beside `targets` and `input` of a bulk call) is the call's picks, not input. The
 * header's picks fill the names the body leaves out. Undefined when the call named none.
 */
export function takeBodyChosen(app: AppDef, body: unknown, header: string | string[] | undefined): { body: unknown; said: unknown } {
  const fromHeader = chosenHeaderObject(app, header);
  if (!app.choose || !body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'chosen'))
    return { body, said: Object.keys(fromHeader).length ? fromHeader : undefined };
  const { chosen, ...rest } = body as Record<string, unknown>;
  if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) return { body: rest, said: chosen };
  return { body: rest, said: { ...fromHeader, ...(chosen as Record<string, unknown>) } };
}

/** The picks an owner finds on the envelope its mapper built (apiCommandRequest.ts), and the envelope without them. */
export function takeChosenAsk(value: unknown): { envelope: unknown; ask: ApiChosenAsk } {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.hasOwn(value, 'chosen')) return { envelope: value, ask: {} };
  const { chosen, ...envelope } = value as Record<string, unknown>;
  const ask: Record<string, string> = {};
  if (chosen && typeof chosen === 'object' && !Array.isArray(chosen))
    for (const [name, key] of Object.entries(chosen)) if (typeof key === 'string') ask[name] = key;
  return { envelope, ask: Object.freeze(ask) };
}

/** The person a query is compiled for: nobody, with these picks. */
export const chosenPerson = (given: ApiChosen | undefined): QueryPerson | undefined =>
  given ? { email: null, chosen: given.chosen, ...(given.unset.length ? { chosenUnset: given.unset } : {}) } : undefined;

/**
 * What a check before any request compiles a standing question with: every declared choice nothing in particular, so
 * `chosen.site` is judged (a name the App does not declare is refused) and the rest of the question is read as ever.
 */
export function catalogChosenPerson(app: AppDef): QueryPerson | undefined {
  return app.choose ? { email: null, chosen: Object.fromEntries(declaredNames(app).map((name) => [name, null])) } : undefined;
}

export { CHOICE_HEADER };

/** An App MCP command tool's optional `chosen` argument: an object keyed by choice name, each naming its resource. */
export function chosenSchema(app: AppDef): Record<string, unknown> | undefined {
  if (!app.choose) return undefined;
  return {
    type: 'object',
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(app.choose).map(([name, choice]) => [
        name,
        {
          type: 'string',
          minLength: 1,
          maxLength: 128,
          description: `The key of the ${choice.from} row this call works at, read again under this token's reach.`,
        },
      ]),
    ),
    description:
      'The App-wide choices this call makes for itself, by name: a handler reads them as ctx.chosen. ' +
      'A name left out is unset. They are never stored and never input.',
  };
}
