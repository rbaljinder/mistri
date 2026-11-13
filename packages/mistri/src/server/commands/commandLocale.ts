/**
 * The locale a command is served in (`ctx.locale`): what its caller resolved
 * for the person who asked — their row, their pick, their browser on a public
 * form, their tenant's — clamped to the catalogs the App ships, else the
 * App's own. Never read from the input. A refusal naming a message
 * (`refuse(msg('booking.full'))`) is said in it.
 */
import type { AppMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { canonicalLocale, negotiateLocale } from '@mistriwork/engine/shared/appLocale.js';
import type { AppDef } from '../../shared/appModel.js';
import { appCatalogs, MessageSayer } from '../app/appMessages.js';
import { catalogLocales } from '../app/readerLocale.js';

/** What the executor needs of the App to resolve and say in a locale; the binding carries it, as it carries `ui.timezone`. */
export interface CommandWords {
  /** The tag a command is served in where nothing nearer is shipped: the App's `ui.locale`, else its source catalog's. */
  fallback(): string;
  /** The locales the App has a catalog for. */
  shipped(): readonly string[];
  /** A message of the App's catalogs in `locale`, without arguments; undefined where it has none. */
  say(locale: string, ref: AppMessageRef): string | undefined;
}

/* Read when asked, not when the binding is built: an App's catalogs are held by its load (apps.ts holdLocalizer). */
export function commandWords(app: AppDef): CommandWords {
  const sayers = new Map<string, MessageSayer>();
  return Object.freeze({
    fallback: () => canonicalLocale(app.ui?.locale) ?? appCatalogs(app)?.source ?? 'en-US',
    shipped: () => catalogLocales(app),
    say(locale: string, ref: AppMessageRef) {
      const catalogs = appCatalogs(app);
      if (!catalogs) return undefined;
      let sayer = sayers.get(locale);
      if (!sayer || sayer.catalogs !== catalogs) {
        if (sayers.size > 64) sayers.clear();
        sayers.set(locale, (sayer = new MessageSayer(catalogs, locale)));
      }
      return sayer.has(ref.message) ? sayer.format(ref.message) : undefined;
    },
  });
}

/** `asked` among the shipped catalogs (its region kept: `es-MX` against `es`), else the App's own; `en-US` with no App. */
export function commandLocale(words: CommandWords | undefined, asked: string | undefined): string {
  if (!words) return 'en-US';
  const shipped = words.shipped();
  return (asked && shipped.length ? negotiateLocale(asked, shipped) : undefined) ?? words.fallback();
}
