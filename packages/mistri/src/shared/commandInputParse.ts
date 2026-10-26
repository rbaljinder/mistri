/**
 * A command's input declaration, as the App's reference and the server's registration both read it: one parser, so
 * one normalized field list. A public form's repeats at most `publicRepeatRows` rows.
 *
 * Its own module, apart from command.ts, because a field's `when` is read with the condition compiler
 * (commandDraft.ts, formValues.ts): command.ts is in every page's module graph for its keys and limits, the browser
 * never parses a declaration, and the bundler keeps whatever such a module reaches in the first paint as soon as a
 * part loaded on demand (the draft's logic, CommandFields.tsx) asks for it.
 */
import { parseCommandFields, type AppCommandField } from './command.js';
import { draftNames } from './commandDraft.js';

export function parseCommandInput(raw: unknown, where: string, options: { publicForm?: boolean } = {}): AppCommandField[] {
  return parseCommandFields(raw, where, { ...options, names: draftNames });
}
