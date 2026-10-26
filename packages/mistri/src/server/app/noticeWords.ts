/**
 * A notify rule's title said from the App's messages (`title: msg('ticket.assigned')`),
 * per recipient, after the write: each one's own locale, nearest first — the
 * `ui.locale` column on their person row (found by the email they are told
 * at), their tenant's default (`branding.allow: 'locale'`), the App's own —
 * and the tenant's own words over the App's where it keeps any. The record's
 * values are read once (adapters/inbox/inbox.ts); only the saying is per person.
 */
import type { NoticeRule, NoticeSink } from '../../adapters/inbox/inbox.js';
import type { AppDef, AppFormView } from '../../shared/appModel.js';
import { recordNoun } from '@mistriwork/engine/shared/appNoun.js';
import { canonicalLocale, localeColumn } from '@mistriwork/engine/shared/appLocale.js';
import { personTable } from '../../shared/appMe.js';
import { tableNamed, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { appCatalogs, MessageSayer, type MessageOverrides } from './appMessages.js';
import { checkTenantMessages, messageColumns, MOST_MESSAGE_ROWS } from './recordMessages.js';

interface NoticeWordsOptions {
  /** The App's logical catalog, for the person table `auth.me` names. */
  readonly schema: DatabaseSchema;
  /** A logical table's physical id, as the writer is asked it. */
  readonly physical: (table: string) => string;
  /** A tenant's default locale, where its branding sets one. */
  readonly tenantLocale?: (tenant: string) => Promise<string | undefined>;
}

/** The `say` a compiled rule's message title becomes, or undefined where the App has no catalogs to say it from. */
export function noticeWords(
  app: AppDef,
  message: string,
  args: NonNullable<NoticeRule['say']>['args'],
  options: NoticeWordsOptions,
): NoticeRule['say'] | undefined {
  const catalogs = appCatalogs(app);
  if (!catalogs) return undefined;
  /* The person row a recipient's own tag is read from: the locale column's table, where it is the people table
     auth.me names, found by the email (or a tenant App's account) they are told at. */
  const column = localeColumn(app.ui);
  const person = personTable(app, options.schema);
  const own =
    column && person.table && person.column && person.table.id === tableNamed(options.schema, column.resource)?.id
      ? {
          table: options.physical(person.table.id),
          by: person.column,
          column: column.column,
        }
      : undefined;
  const spec = app.ui.messages?.source ? app.ui.messages : undefined;
  let wordsTable: string | undefined;
  try {
    wordsTable = spec && options.physical(spec.from);
  } catch {
    wordsTable = undefined;
  }
  const sayers = new Map<string, MessageSayer>();
  const sayerFor = (locale: string, overrides?: { stamp: string; words: MessageOverrides }) => {
    const key = `${locale}\n${overrides?.stamp ?? ''}`;
    let sayer = sayers.get(key);
    if (!sayer) {
      if (sayers.size > 64) sayers.clear();
      sayers.set(key, (sayer = new MessageSayer(catalogs, locale, overrides?.words)));
    }
    return sayer;
  };
  return Object.freeze({
    args,
    async words(
      values: Readonly<Record<string, unknown>>,
      recipient: string | undefined,
      tenant: string | undefined,
      sink: Pick<NoticeSink, 'rows'>,
    ) {
      let locale: string | undefined;
      if (own && recipient) {
        const rows = await sink.rows(own.table, { [own.by]: recipient }, [own.column], 1).catch(() => []);
        locale = canonicalLocale(rows[0]?.[own.column]);
      }
      if (!locale && tenant && options.tenantLocale) locale = canonicalLocale(await options.tenantLocale(tenant).catch(() => undefined));
      locale ??= canonicalLocale(app.ui.locale) ?? catalogs.source;
      /* The tenant's own words, read in the write's transaction among its own rows (recordMessages.ts). */
      const overrides =
        tenant && spec && wordsTable
          ? await sink
              .rows(wordsTable, { [spec.tenantField]: tenant }, messageColumns(spec), MOST_MESSAGE_ROWS)
              .then((rows) => checkTenantMessages(app.id, spec, tenant, rows))
              .catch(() => undefined)
          : undefined;
      try {
        return sayerFor(locale, overrides).format(message, values);
      } catch {
        /* A word that cannot be said in this locale is said in the App's own; one that cannot be said at all tells
           nobody, rather than failing the write it follows. */
        try {
          return sayerFor(catalogs.source).format(message, values);
        } catch {
          return '';
        }
      }
    },
  });
}

/**
 * What a rule that emails an address a record holds (`notify.via` email) adds
 * to its channel: the sentence that says why the recipient gets it, and the
 * columns of `resource` a saved form stamps with an address a visitor proved
 * with a code, which a visitor's write may mail and no other address they typed
 * (integrations/integrationChannels.ts). One reading for an App with tenants
 * and one without.
 */
export function contactEmailWording(
  app: AppDef,
  resource: string,
  columns: ReadonlySet<string>,
): Readonly<{ proof: readonly string[]; because: string }> {
  const proved = new Set(
    Object.values(app.views).flatMap((view) => {
      const verified = (view as AppFormView).link?.email?.verified;
      return verified ? [verified] : [];
    }),
  );
  const noun = recordNoun(app.resources?.[resource]?.noun, resource);
  return {
    proof: [...proved].filter((column) => columns.has(column)),
    because: `You get this because ${app.name} has your address on file for ${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}.`,
  };
}
