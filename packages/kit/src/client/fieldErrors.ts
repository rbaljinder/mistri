/**
 * The per-field half of a refused write, as a form may show it.
 *
 * A write the server refuses on the application's rules answers
 * `{ errors: [{ message, field?, fields?: [{ field, message }] }], outcome:
 * 'rejected' }`. The names and messages are untrusted response text that ends
 * up as an element's association and an announced message, so they are held
 * to a shape here — once, for the New form and the record page alike — and
 * anything else is dropped rather than shown: a name with whitespace, a
 * control character or a dot (but the one a row-defined field has,
 * `specs.capacity`), a message that is empty or long, a field named twice.
 * What a form cannot place stays in the refusal's summary.
 */
export interface FieldError {
  field: string;
  message: string;
}

interface FieldErrorEnvelope {
  message: string;
  field?: string;
  fields?: readonly { field: string; message: string }[];
}

export function safeFieldErrors(errors: readonly FieldErrorEnvelope[]): FieldError[] {
  const seen = new Set<string>();
  return errors
    .flatMap((error) => [
      ...(typeof error?.field === 'string' ? [{ field: error.field, message: error.message }] : []),
      ...(Array.isArray(error?.fields) ? error.fields : []),
    ])
    .flatMap((error) => {
      if (
        typeof error?.field !== 'string' ||
        // eslint-disable-next-line no-control-regex -- Reject control characters in untrusted response field names.
        !/^[^\s.\x00-\x1f\x7f]{1,256}(?:\.[A-Za-z_][A-Za-z0-9_]{0,127})?$/u.test(error.field) ||
        typeof error.message !== 'string' ||
        !error.message.trim() ||
        error.message.length > 256 ||
        seen.has(error.field)
      )
        return [];
      seen.add(error.field);
      return [{ field: error.field, message: error.message }];
    });
}
