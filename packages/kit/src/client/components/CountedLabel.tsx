/**
 * An App action's label said for the records it takes, in the reader's
 * language: the server parsed it (server appMessages.ts countedLabels), and
 * this says it with `{count}`. The formatter (intl-messageformat) comes with
 * this part, loaded on demand the first time a selection needs it
 * (onDemand.tsx), so no first page carries it; until then the words the
 * server said for one record stand in.
 */
import { useMemo } from 'react';
import IntlMessageFormat from 'intl-messageformat';

type Formatter = InstanceType<typeof IntlMessageFormat>;
type MessageFormatElement = Exclude<ConstructorParameters<typeof IntlMessageFormat>[0], string>[number];

/** A counting label as the server sends it: the message parsed in the reader's locale. */
export type CountedMessage = readonly MessageFormatElement[];

/** Built once per message and locale: a selection re-renders on every tick of its box. */
const kept = new WeakMap<CountedMessage, Map<string, Formatter>>();

function formatter(message: CountedMessage, locale: string): Formatter {
  let byLocale = kept.get(message);
  if (!byLocale) kept.set(message, (byLocale = new Map()));
  let format = byLocale.get(locale);
  if (!format) byLocale.set(locale, (format = new IntlMessageFormat(message as MessageFormatElement[], locale)));
  return format;
}

export function CountedLabel({ message, count, locale }: { message: CountedMessage; count: number; locale: string }) {
  const said = useMemo(() => String(formatter(message, locale).format({ count })), [message, locale, count]);
  return <>{said}</>;
}
