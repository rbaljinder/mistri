/**
 * The names a form's reference pickers last read for the keys they hold, for the words a stepped form says about its
 * steps so far (FormSurface.tsx `summarize`) and for the picker's own box when its step is drawn again. A name is put
 * here only by the picker, from the reader's own read of the field's resource (CommandReference.tsx), keyed by the
 * reader, the source, the field's resource, columns and filter, and the key itself: a changed key is another entry,
 * so an old name never stands for a new choice. It is words to show, never what is sent: the form sends the key, and
 * the server judges it. The review reads every name again (CommandReference.tsx `ReferenceName`).
 *
 * Its own module, with no imports, so a form's first page can ask it without fetching the picker.
 */

interface NamedField {
  from: string;
  by: string;
  labelColumn: string;
  query?: string;
}

/** Where a picker reads: a signed-in reader's connection, or a public form's App, read as its visitor. */
type Source = string | { visitor: { app: string; via?: string } };

const KEPT = 500;
const names = new Map<string, string>();

const keyOf = (field: NamedField, source: Source, epoch: number, value: string | number) =>
  JSON.stringify([
    epoch,
    typeof source === 'string' ? source : [source.visitor.app, source.visitor.via ?? ''],
    field.from,
    field.by,
    field.labelColumn,
    field.query ?? '',
    typeof value,
    String(value),
  ]);

/** The name a picker read for this key, as the reader it read for. */
export function rememberReferenceName(field: NamedField, source: Source, epoch: number, value: string | number, name: string): void {
  const key = keyOf(field, source, epoch, value);
  names.delete(key);
  names.set(key, name);
  // A long-open page picks many times: the oldest names go first.
  if (names.size > KEPT) names.delete(names.keys().next().value!);
}

/** The name a picker last read for this key, or undefined when none has. */
export function knownReferenceName(field: NamedField, source: Source, epoch: number, value: string | number): string | undefined {
  return names.get(keyOf(field, source, epoch, value));
}
