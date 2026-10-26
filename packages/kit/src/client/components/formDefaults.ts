/**
 * A New form's starting words, made values as it opens: `today` and `now` from
 * the App's clock and the zone its timestamps are written in (UTC when it names none), `me` from the server — the signed-in person's row
 * where a reference points at the table people are rows of, their email in a
 * text column. The server resolves `me` in a query it parses for this request,
 * so the browser never decides who someone is; it only asks.
 *
 * A word that cannot be made a value (nobody signed in, no row carries the
 * email) starts the field empty, and the form's own rules then ask for it.
 */
import { useQuery } from '@tanstack/react-query';
import { api, state } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { equalityFilter } from '../resourceRequests.js';
import { formatClockZone } from '../locale.js';
import { formDefaultWord } from '@mistriwork/engine/shared/formValues.js';
import { primaryKey, type ColumnMeta, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { clockDefault, type FormCuration } from './newRecordModel.js';

interface MeAsk {
  column: string;
  target?: TableMeta;
}

/** Who `me` is, for each column that starts with it: a key, an email, or null for nobody. */
async function askMe(asks: readonly MeAsk[], connection: string | null): Promise<Record<string, string | number | null>> {
  const answers: Record<string, string | number | null> = {};
  let email: Promise<string | null> | undefined;
  for (const ask of asks) {
    if (ask.target) {
      const [pk] = primaryKey(ask.target);
      try {
        const data = await api('/api/run', {
          q: `${ask.target.id} ${pk} = me show ${pk}`,
          limit: 1,
          offset: 0,
          count: 'none',
          ...ownedBy(connection),
        });
        const key = (data.rows as Array<Record<string, unknown>> | undefined)?.[0]?.[pk];
        answers[ask.column] = typeof key === 'string' || typeof key === 'number' ? key : null;
      } catch {
        answers[ask.column] = null;
      }
    } else {
      email ??= api(connection ? `/api/whoami?app=${encodeURIComponent(connection)}` : '/api/whoami')
        .then((me: { who?: unknown }) => (typeof me.who === 'string' ? me.who : null))
        .catch(() => null);
      answers[ask.column] = await email;
    }
  }
  return answers;
}

/** The words a form's defaults say, by column: `today`, `now`, `me`. None in the Workbench, which reads the schema. */
export function formWords(
  table: TableMeta,
  form: FormCuration | undefined,
  app: boolean,
): Array<{ column: ColumnMeta; word: 'today' | 'now' | 'me' }> {
  if (!app) return [];
  return Object.entries(form?.defaults ?? {}).flatMap(([name, value]) => {
    const column = table.columns.find((c: ColumnMeta) => c.name === name);
    const word = column && formDefaultWord(column, value);
    return word && column ? [{ column, word }] : [];
  });
}

/** The form with `today` and `now` made values, and `me` made the answers given (a column it has none for starts empty). */
export function resolvedForm(
  form: FormCuration | undefined,
  words: ReturnType<typeof formWords>,
  me: Record<string, string | number | null> = {},
): FormCuration | undefined {
  if (!words.length) return form;
  const now = new Date();
  const resolved: Record<string, unknown> = { ...(form?.defaults ?? {}) };
  for (const { column, word } of words) {
    if (word !== 'me') resolved[column.name] = clockDefault(word, column, now, formatClockZone());
    else if (me[column.name] === null || me[column.name] === undefined) delete resolved[column.name];
    else resolved[column.name] = me[column.name];
  }
  return { ...form, defaults: resolved };
}

/** Who `me` is for a form's columns that start with it, or undefined while the server is asked. */
export function useMeDefaults(
  table: TableMeta,
  words: ReturnType<typeof formWords>,
  target: (tableId: string) => TableMeta | undefined,
): Record<string, string | number | null> | undefined {
  const asks: MeAsk[] = words
    .filter((w) => w.word === 'me')
    .map(({ column }) => ({ column: column.name, ...(column.references ? { target: target(column.references.table) } : {}) }));
  const connection = state.activeConnection as string | null;
  const me = useQuery({
    queryKey: ['form-me', connection, table.id, asks.map((ask) => [ask.column, ask.target?.id])],
    queryFn: () => askMe(asks, connection),
    retry: false,
    staleTime: 60_000,
  });
  return me.isPending ? undefined : (me.data ?? {});
}

/**
 * A value the form takes from a referenced record (`defaults: { labor_charge: { from: 'service_id.price' } }`),
 * read as the reference is chosen: the referenced row's column, as the form's text, or '' when the row has none.
 * The server fills the same value where a create leaves it out, so a form that never asks still gets it.
 */
export async function derivedValue(
  path: string,
  reference: ColumnMeta,
  chosen: string,
  target: (tableId: string) => TableMeta | undefined,
): Promise<string> {
  const to = reference.references && target(reference.references.table);
  const column = path.split('.')[1];
  if (!to || !column || chosen === '') return '';
  const key = reference.references?.column ?? primaryKey(to)[0];
  try {
    /* A computed column of the record is worked out by the statement a view runs; a table read has only what is
       stored (DM5). The server works the same figure out where a create leaves the value out. */
    const data =
      to.computed && Object.hasOwn(to.computed, column)
        ? await api('/api/view/run', {
            view: {
              id: `derived:${to.id}`,
              name: to.name,
              base: to.id,
              columns: [{ path: column }],
              filter: { groups: [[{ path: key, op: '=', value: chosen }]] },
              limit: 1,
            },
          })
        : await api('/api/query', {
            table: to.id,
            columns: [column],
            filter: equalityFilter({ [key]: chosen }),
            limit: 1,
            offset: 0,
          });
    const value = (data.rows as Array<Record<string, unknown>> | undefined)?.[0]?.[column];
    return value === null || value === undefined ? '' : String(value);
  } catch {
    return '';
  }
}
