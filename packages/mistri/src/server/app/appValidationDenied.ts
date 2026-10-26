/**
 * The refusal a write meets when the App's validation rules turn it down. Its own module so a path that only
 * refuses (the MCP's write facade, a record write) does not load the App definition and every rule
 * appValidation.ts reads to decide.
 */
import { Refusal } from '@mistriwork/engine/adapters/adapter.js';
import type { FieldRefusal } from '@mistriwork/engine/server/recordWriteOperations.js';

/** A validation failure is intentionally safe to expose through App errors. */
export class AppValidationDenied extends Refusal implements FieldRefusal {
  readonly fields: readonly string[];
  /** A sentence per field, where the rule has one: the author's `message`, or a fixed one (a row-defined field's DEFINED_REASONS). */
  readonly reasons: Readonly<Record<string, string>>;

  constructor(fields: readonly string[] = [], reasons: Readonly<Record<string, string>> = {}) {
    super('The record does not satisfy the application rules.');
    this.name = 'AppValidationDenied';
    // Field names are the validation context that crosses the App boundary,
    // with the sentence the App's author wrote for the rule (or a fixed one).
    // Values, a rule's condition and database post-images never do.
    this.fields = Object.freeze([
      ...new Set(fields.filter((field) => typeof field === 'string' && field.length > 0 && field.length <= 256)),
    ]);
    this.reasons = Object.freeze(Object.fromEntries(Object.entries(reasons).filter(([field]) => this.fields.includes(field))));
  }

  /** The same refusal of a record's line, its fields at the line's place (recordWriteOperations.ts writeLines). */
  renamed(rename: (field: string) => string): AppValidationDenied {
    return new AppValidationDenied(
      this.fields.map(rename),
      Object.fromEntries(Object.entries(this.reasons).map(([name, reason]) => [rename(name), reason])),
    );
  }
}

/**
 * A line's `consumes` refusing the write: the balance it would take from has
 * too little left (appConsumes.ts). Said as the rule's `refuse` sentence,
 * filled from the record it would take from with only the fields the reader
 * may read; nothing of the write is kept.
 */
export class ConsumesRefused extends AppValidationDenied {
  readonly sentence: string;

  constructor(field: string, sentence: string) {
    super([field], { [field]: sentence });
    this.name = 'ConsumesRefused';
    this.message = sentence;
    this.sentence = sentence;
  }

  /* A balance a line would overdraw stays that refusal, so it is answered 422 as everywhere else (DM9). */
  override renamed(rename: (field: string) => string): ConsumesRefused {
    return new ConsumesRefused(rename(this.fields[0] ?? ''), this.sentence);
  }
}
