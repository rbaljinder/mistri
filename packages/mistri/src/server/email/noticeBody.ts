/**
 * The fixed lines around a notice's title in its email, in the recipient's
 * language. The title is the App's words, already said in their locale when
 * the write queued it (app/noticeWords.ts); these are the framework's, so
 * they come from a table of its own, the chrome's languages (client
 * copy/es.ts) and English for any other.
 *
 * The recipient's locale is read at send as a request of theirs reads it: the
 * `ui.locale` column on their person row, found by the address they are told
 * at, then the App's own.
 */
import type { QueryRequest, QueryResult } from '@mistriwork/engine/adapters/adapter.js';
import type { AppDef } from '../../shared/appModel.js';
import { personTable } from '../../shared/appMe.js';
import { canonicalLocale, localeColumn } from '@mistriwork/engine/shared/appLocale.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';

interface NoticeLines {
  place: (place: string) => string;
  by: (by: string) => string;
  open: (link: string) => string;
  why: (app: string) => string;
}

const LINES: Readonly<Record<string, NoticeLines>> = {
  en: {
    place: (place) => `In ${place}.`,
    by: (by) => `By ${by}.`,
    open: (link) => `Open it: ${link}`,
    why: (app) => `You get this because email notifications are on for your ${app} account. Turn them off under Notifications in ${app}.`,
  },
  es: {
    place: (place) => `En ${place}.`,
    by: (by) => `Por ${by}.`,
    open: (link) => `Ábrelo: ${link}`,
    why: (app) =>
      `Recibes esto porque las notificaciones por correo están activadas en tu cuenta de ${app}. Desactívalas en Notificaciones, en ${app}.`,
  },
};

/** The lines in a locale's language, else English. */
export function noticeLines(locale: string | undefined): NoticeLines {
  const language = locale?.split('-')[0]?.toLowerCase();
  return (language && Object.hasOwn(LINES, language) ? LINES[language] : undefined) ?? LINES.en!;
}

/**
 * The recipient's locale: their person row's `ui.locale` column, where it is
 * the people table `auth.me` names, read under their own grants; else the
 * App's. A read that fails says the App's, rather than holding the mail.
 */
export async function recipientLocale(
  app: AppDef,
  schema: DatabaseSchema,
  query: (request: QueryRequest) => Promise<QueryResult>,
  email: string,
): Promise<string | undefined> {
  const named = localeColumn(app.ui);
  const person = named && personTable(app, schema);
  const table = named && tableNamed(schema, named.resource);
  if (
    named &&
    person?.table &&
    person.column &&
    table &&
    person.table.id === table.id &&
    table.columns.some((c) => c.name === named.column)
  ) {
    const own = await query({
      table: table.id,
      filter: { groups: [[{ column: person.column, op: '=', value: email }]] },
      columns: [named.column],
      limit: 1,
      offset: 0,
    }).catch(() => undefined);
    const said = canonicalLocale(own?.rows[0]?.[named.column]);
    if (said) return said;
  }
  return canonicalLocale(app.ui.locale);
}
