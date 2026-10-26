/**
 * One of an App's messages said by a custom component (`useMessage`): the
 * server hands the catalog over already in the reader's words, each message
 * parsed (appPayload `messages`), and this says one with its arguments in
 * the reader's locale. A test's fixture hands it the catalog as text. The
 * formatter comes with the component SDK, which is loaded only where a
 * component is drawn, so no first page carries it.
 */
import IntlMessageFormat from 'intl-messageformat';
import { formatLocale } from '@mistriwork/kit/client/locale.js';

type Formatter = InstanceType<typeof IntlMessageFormat>;
type Parsed = Exclude<ConstructorParameters<typeof IntlMessageFormat>[0], string>;
/** What a message's `{name}`s are filled with. */
type MessageArgs = Readonly<Record<string, string | number | boolean | Date | null | undefined>>;

/** Built once per message and locale: a component re-renders often, and a formatter is costly to build. */
const parsed = new WeakMap<object, Map<string, Formatter>>();
const written = new Map<string, Formatter>();

function formatter(message: string | readonly unknown[], locale: string): Formatter {
  if (typeof message === 'string') {
    const id = `${locale}\n${message}`;
    let format = written.get(id);
    if (!format) written.set(id, (format = new IntlMessageFormat(message, locale)));
    return format;
  }
  let byLocale = parsed.get(message);
  if (!byLocale) parsed.set(message, (byLocale = new Map()));
  let format = byLocale.get(locale);
  if (!format) byLocale.set(locale, (format = new IntlMessageFormat(message as Parsed, locale)));
  return format;
}

/**
 * Say `key` from `catalog`. A key the catalog lacks is said as itself — a
 * section shows the slip rather than failing — and so is a message whose
 * arguments were not all given, since the formatter refuses a missing one.
 */
export function sayAppMessage(
  catalog: Readonly<Record<string, string | readonly unknown[]>> | undefined,
  key: string,
  args?: MessageArgs,
): string {
  const message = catalog && Object.hasOwn(catalog, key) ? catalog[key] : undefined;
  if (message === undefined) return key;
  try {
    return String(formatter(message, formatLocale() ?? 'en-US').format(args as Record<string, string | number | boolean | Date>));
  } catch {
    return key;
  }
}
