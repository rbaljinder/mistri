/**
 * A step's check: the server's word on the answers so far, asked as a multistep form goes on (a public form's
 * `/api/forms/<key>/check/<step>`, a signed-in form's `/api/commands/check`). It reads only the fields the steps so
 * far ask — each as the run will read it — judges their draft conditions (a hidden question answered, a shown one
 * left empty) and the command's rules that every named field has been answered for, and says each problem at its
 * field. Nothing runs, nothing is written, nothing is kept: a sensitive answer is read for its shape and dropped
 * with the rest of the request, and a rule never names one, so a check is no lookup.
 *
 * A record-reading `when` is the run's to judge (it reads the record in its transaction); a check leaves it be.
 * The run judges every answer again whatever a check said.
 */
import type { AppCommandField } from '../../shared/command.js';
import { commandInputProblems, type CommandInputReason } from '../../shared/commandInput.js';
import { brokenRules, draftHolds, readsRecord } from '../../shared/commandDraft.js';
import type { AnyBusinessCommand } from './businessCommands.js';

/** A reason in plain words, for a caller that has no form of its own to say it (an import, a check). */
const REASON_SENTENCES: Readonly<Record<CommandInputReason, string>> = Object.freeze({
  required: 'This is required.',
  type: 'This is not the kind of value it takes.',
  shape: 'This is not in the form it takes.',
  text: 'This has characters a form does not take.',
  too_short: 'This is too short.',
  too_long: 'This is too long.',
  format: 'This is not in the form it takes.',
  pattern: 'This is not in the form it takes.',
  integer: 'This must be a whole number.',
  below_min: 'This is below the least it takes.',
  above_max: 'This is above the most it takes.',
  not_below: 'This must be below its pair.',
  not_above: 'This must be above its pair.',
  choice: 'This is not one of the choices.',
  too_few: 'This has too few entries.',
  too_many: 'This has too many entries.',
  exclusive: 'This choice stands alone.',
});

/** At most this many fields are named by one check: a form's steps, never more than its command declares. */
const NAMES_MOST = 512;

/** The names a check's `fields` gives, of the command's own top-level inputs; undefined for a list that is not one. */
export function checkedNames(command: AnyBusinessCommand, raw: unknown): string[] | undefined {
  if (!Array.isArray(raw) || raw.length > NAMES_MOST) return undefined;
  const declared = new Set(command.fields.map((field) => field.name));
  if (!raw.every((name) => typeof name === 'string' && declared.has(name))) return undefined;
  return [...new Set(raw as string[])];
}

/**
 * Each problem of the answers so far, by path, in plain words: the fields `asked` names read as the run reads them,
 * their draft conditions, and the rules over them. Empty where the steps so far hold.
 */
export function checkCommandStep(
  command: AnyBusinessCommand,
  raw: unknown,
  asked: readonly string[],
  now = new Date(),
): Record<string, string> {
  const names = new Set(asked);
  const fields = command.fields.filter((field) => names.has(field.name));
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  // Only the fields asked so far: a later step's answer is not this check's, and is refused as one nobody asked.
  const given = Object.fromEntries(Object.entries(input).filter(([name]) => names.has(name)));
  const problems: Record<string, string> = {};
  const say = (path: string, words: string) => {
    if (!Object.hasOwn(problems, path)) problems[path] = words;
  };
  for (const name of Object.keys(input)) if (!names.has(name)) say(name, REASON_SENTENCES.shape);
  /* A choice from a table is the run's to judge against its rows; here its shape alone. */
  for (const problem of commandInputProblems(fields, given, { sourced: () => true })) say(problem.path, REASON_SENTENCES[problem.reason]);
  for (const field of fields) {
    const when = whenOf(field);
    if (when === undefined || readsRecord(when)) continue;
    const shown = draftHolds(when, given, command.fields, now);
    const answered = Object.hasOwn(given, field.name) && !empty(given[field.name]);
    if (shown && !answered && isRequired(field)) say(field.name, REASON_SENTENCES.required);
    if (!shown && Object.hasOwn(given, field.name)) say(field.name, REASON_SENTENCES.shape);
  }
  if (command.rules?.length) {
    // A rule is judged once every field it names has been asked: a later step's rule waits for its step.
    for (const broken of brokenRules(command.rules, given, command.fields, now))
      if (names.has(broken.field)) say(broken.field, broken.message);
  }
  return problems;
}

const whenOf = (field: AppCommandField): string | undefined => ('when' in field ? (field.when as string | undefined) : undefined);
const empty = (value: unknown) => value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length);
/* A box is required only where it must be ticked (unticked is its no); a yes or a no asked as two buttons is a
   question like any other, required unless optional. */
const isRequired = (field: AppCommandField) =>
  field.type === 'boolean' && field.as !== 'buttons'
    ? field.accept === true
    : field.type !== 'group' && field.type !== 'lines' && field.required === true;
