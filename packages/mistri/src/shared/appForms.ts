/**
 * Command forms: one form running one command that creates records — its
 * `label` the heading, its steps (when it has them) the stepper's pages,
 * its done screen what follows a submission.
 *
 * A form is signed in unless it says `public: true`, and nothing else makes
 * one public. A signed-in form is a room of the App: nav and home may name
 * it, and it runs its command through the signed-in grant. A public form is
 * served at `/{app}/form/{key}` to anyone — signed out or signed in — under
 * the public rules (a public command, its pickers over what `auth.public` reads), and always runs
 * as a public submission, whoever opens it. Both are read into the AppDef's
 * `views`, under their keys, beside the lists and dashboards.
 */
import { parseRoutePath } from './appAddress.js';
import { parseRealm, type AppFormView } from './appModel.js';
import { allowKeys, isRecord } from '@mistriwork/engine/shared/model.js';
import { commandInputAt, parseInputs } from '@mistriwork/engine/shared/appComponents.js';
import { parseFormCommandReference } from './command.js';
import { FORM_STYLES, parseAppForm } from './formRules.js';
import { parseIcon } from '@mistriwork/engine/shared/appIcons.js';
import { linkColumns, parseFormLink, parseFormSave, parseSavedSteps, parseStatusCheck, type AppFormSave } from './appSavedForms.js';

export const FORM_VIEW_KEYS = [
  'kind',
  'label',
  'path',
  'icon',
  'description',
  'command',
  'steps',
  'style',
  'note',
  'review',
  'submitLabel',
  'done',
  'public',
  'prefillable',
  'resume',
  'draft',
  'abandoned',
  'statusCheck',
  'link',
] as const;
/* What only a form saved on every step takes. */
const SAVED_KEYS = ['resume', 'draft', 'abandoned', 'statusCheck', 'link'] as const;

const isText = (value: unknown, max: number): value is string => typeof value === 'string' && Boolean(value.trim()) && value.length <= max;

/**
 * A form view. The steps go through the shared form parser; what is checked
 * here is that they carve up the command's input exactly: every input on
 * one step, no step naming a field the command does not take. Without
 * steps the form is one page asking every input in the command's order.
 */
export function parseFormView(e: Record<string, unknown>, at: string): AppFormView {
  const isPublic = e.public === true;
  allowKeys(e, isPublic ? [...FORM_VIEW_KEYS, 'inputs'] : [...FORM_VIEW_KEYS, 'realm', 'inputs', 'roles'], at, {
    ...(isPublic
      ? {
          realm: 'is not taken: a public form is open to everyone',
          roles: 'is not taken: a public form is open to everyone, signed out too, and a visitor holds no role',
        }
      : {}),
  });
  if (e.public !== undefined && typeof e.public !== 'boolean')
    throw new Error(`${at} has a "public" that is not true or false. A form is signed in unless it says public: true.`);
  if (!isText(e.label, 120)) throw new Error(`${at} needs a "label" of at most 120 characters: the form's heading.`);
  // An icon is a menu's mark, and a public form is in no menu.
  if (e.icon !== undefined && isPublic) throw new Error(`${at} is a public form, which is in no menu, so it takes no "icon".`);
  // A public form's address is the server's (`/{app}/form/{key}`); only a signed-in form is a room of the App.
  if (e.path !== undefined && isPublic) throw new Error(`${at} is a public form, served at /{app}/form/{key}, so it takes no "path".`);
  const path = parseRoutePath(e.path, at);
  const icon = e.icon === undefined ? undefined : parseIcon(e.icon, at);
  if (e.description !== undefined && !isText(e.description, 2000)) {
    throw new Error(`${at} has a "description" that is not text of at most 2000 characters.`);
  }
  if (e.submitLabel !== undefined && !isText(e.submitLabel, 60)) {
    throw new Error(`${at} has a "submitLabel" that is not text of at most 60 characters.`);
  }
  /* The intake style: how the steps are drawn, the line over its progress bar, and whether it ends in a review. */
  if (e.style !== undefined && !(FORM_STYLES as readonly unknown[]).includes(e.style))
    throw new Error(`${at} has a "style" that is not 'stepper' or 'intake'.`);
  const style = e.style === 'intake' ? ('intake' as const) : e.style === 'stepper' ? ('stepper' as const) : undefined;
  if (style !== undefined && e.steps === undefined) throw new Error(`${at} has a "style", which draws steps, and the form has none.`);
  for (const key of ['note', 'review'] as const)
    if (e[key] !== undefined && style !== 'intake') throw new Error(`${at} has "${key}", which the intake style takes: style: 'intake'.`);
  if (e.review !== undefined && typeof e.review !== 'boolean') throw new Error(`${at} has a "review" that is not true or false.`);
  let note: AppFormView['note'];
  if (e.note !== undefined) {
    if (!isRecord(e.note)) throw new Error(`${at} has a "note" that is not { icon, text }.`);
    allowKeys(e.note, ['icon', 'text'], `${at}, "note"`);
    if (!isText(e.note.text, 120)) throw new Error(`${at}, "note" needs "text" of at most 120 characters.`);
    note = {
      ...(e.note.icon === undefined ? {} : { icon: parseIcon(e.note.icon, `${at}, "note"`) }),
      text: e.note.text.trim(),
    };
  }
  let done: AppFormView['done'];
  if (e.done !== undefined) {
    if (!e.done || typeof e.done !== 'object' || Array.isArray(e.done)) throw new Error(`${at} has a "done" that is not an object.`);
    const d = e.done as Record<string, unknown>;
    allowKeys(d, ['title', 'description'], `${at}, "done"`, { message: 'is now "description": the sentence under the title' });
    for (const k of ['title', 'description'] as const) {
      if (d[k] !== undefined && !isText(d[k], k === 'title' ? 120 : 2000)) throw new Error(`${at}, "done" has a "${k}" that is not text.`);
    }
    done = {
      ...(d.title === undefined ? {} : { title: (d.title as string).trim() }),
      ...(d.description === undefined ? {} : { description: (d.description as string).trim() }),
    };
  }
  /* A form is saved on every step when its steps say so: a step that runs a
     command of its own (`step('About you', 'startApplication')`) saves what it
     asked, and one that lists fields keeps them in the page until submit.
     One form is one or the other. */
  const saving = Array.isArray(e.steps) ? e.steps.filter((step) => isRecord(step) && step.command !== undefined).length : 0;
  if (saving && saving !== (e.steps as unknown[]).length) {
    throw new Error(
      `${at} has steps that run commands and steps that list fields. A form saved on every step runs a command on each: step('About you', 'startApplication').`,
    );
  }
  const saved = saving > 0;
  if (!saved) {
    const stray = SAVED_KEYS.find((key) => e[key] !== undefined);
    if (stray)
      throw new Error(
        `${at} has "${stray}", which a form saved on every step takes: steps that each run a command, step('About you', 'startApplication').`,
      );
  }
  const save: AppFormSave | undefined = saved ? parseFormSave(e, at) : undefined;
  const command = parseFormCommandReference(e.command, `${at}, "command"`, isPublic);
  // A saved form's own command is the final submit, over what the steps saved: it may ask nothing more.
  if (!command.input.length && !saved) throw new Error(`${at}: the command takes no input; a form asks for something.`);
  let steps: AppFormView['steps'];
  if (saved) {
    if (e.steps === undefined) throw new Error(`${at} saves each step and names none: steps: [step('About you', 'startApplication'), …].`);
    steps = parseSavedSteps(e.steps, `${at}, "steps"`);
    if (steps.some((step) => step.command!.id === command.id))
      throw new Error(`${at} submits through "${command.id}", which a step runs too. The submit is its own command.`);
    /* The page holds one application in memory, keyed by input name, and
       draws the review from it: one name, one question, across the steps and
       the submit. */
    const seen = new Map<string, string>();
    for (const [where, inputs] of [
      ...steps.map((step) => [`step "${step.id}"`, step.command!.input] as const),
      ['the submit', command.input] as const,
    ]) {
      for (const field of inputs) {
        const before = seen.get(field.name);
        if (before)
          throw new Error(`${at}: ${where} asks "${field.name}", which ${before} asks too. Each input of a saved form has its own name.`);
        seen.set(field.name, where);
      }
    }
    /* Nothing an applicant typed is ever answered back, so nothing starts
       filled either: a saved form starts blank and keeps what was typed in
       the page's memory alone. */
    if (e.prefillable !== undefined) throw new Error(`${at} saves each step, and takes no "prefillable": it starts blank.`);
  } else if (e.steps !== undefined) {
    const parsed = parseAppForm({ steps: e.steps }, `${at}, "steps"`).steps!;
    const inputs = new Set(command.input.map((field) => field.name));
    for (const step of parsed) {
      for (const field of step.fields) {
        if (!inputs.has(field)) throw new Error(`${at}: step "${step.label}" names "${field}", which the command does not take.`);
      }
    }
    const owned = new Set(parsed.flatMap((step) => step.fields));
    for (const field of command.input) {
      if (!owned.has(field.name))
        throw new Error(`${at}: the command input "${field.name}" belongs to no step. Every input is asked on exactly one step.`);
    }
    steps = parsed.map((step) => ({ ...step, fields: [...step.fields] }));
  }
  /* The inputs a link may start filled: shown, editable and checked like
     anything typed. */
  let prefillable: string[] | undefined;
  if (e.prefillable !== undefined) {
    if (!Array.isArray(e.prefillable) || !e.prefillable.length)
      throw new Error(`${at} has a "prefillable" that is not a list of the command's input names.`);
    prefillable = e.prefillable.map((name) => {
      const field = typeof name === 'string' ? command.input.find((input) => input.name === name) : undefined;
      if (!field) throw new Error(`${at}, "prefillable": ${JSON.stringify(name)} is not one of the command's inputs.`);
      if (field.type === 'group' || field.type === 'lines' || field.type === 'boolean')
        throw new Error(
          `${at}, "prefillable": "${field.name}" is ${field.type === 'lines' ? 'lines' : `a ${field.type}`}; an address fills a text, number, date or choice.`,
        );
      return field.name;
    });
    if (new Set(prefillable).size !== prefillable.length) throw new Error(`${at} has a "prefillable" that names one input twice.`);
  }
  const statusCheck = save && e.statusCheck !== undefined ? parseStatusCheck(e.statusCheck, `${at}, "statusCheck"`, save) : undefined;
  if (statusCheck) {
    // A status check confirms with what the applicant typed; the steps must ask it.
    const asked = new Set(steps!.flatMap((step) => step.command!.input.map((field) => field.name)));
    const keyed = new Set(
      steps!.flatMap((step) =>
        step.command!.input.flatMap((field) => (field.type === 'text' && field.sensitive?.keep === 'hash' ? [field.name] : [])),
      ),
    );
    for (const item of statusCheck.confirm) {
      if (item.keyed && !keyed.size)
        throw new Error(`${at}, "statusCheck.confirm.${item.column}" is keyed, and no step asks a keyed input to fill it.`);
    }
    if (asked.has(statusCheck.receipt))
      throw new Error(
        `${at}, "statusCheck.receipt" names "${statusCheck.receipt}", which a step asks for. The receipt is the server's, returned by the submit.`,
      );
    if (statusCheck.alert && asked.has(statusCheck.alert))
      throw new Error(`${at}, "statusCheck.alert" names "${statusCheck.alert}", which a step asks for. The server stamps it.`);
  }
  const link = save && e.link !== undefined ? parseFormLink(e.link, `${at}, "link"`, save, statusCheck) : undefined;
  if (link) {
    // The link's columns are the server's: a step that asked for one could write it.
    const asked = new Set([
      ...steps!.flatMap((step) => step.command!.input.map((field) => field.name)),
      ...command.input.map((field) => field.name),
    ]);
    const taken = linkColumns(link).find((name) => asked.has(name));
    if (taken) throw new Error(`${at}, "link" names "${taken}", which the form asks for. The link's columns are the server's own.`);
    // The address an account's email is matched with is the applicant's own answer.
    if (link.email && !asked.has(link.email.column))
      throw new Error(`${at}, "link.email" names "${link.email.column}", which no step asks for: it is the address the applicant gives.`);
  }
  /* A component standing in one of the command's own inputs (appComponents.ts). */
  const inputs = parseInputs(e.inputs, at, { paths: true });
  const stray = inputs && Object.keys(inputs).find((name) => !commandInputAt(command.input, name));
  if (stray) throw new Error(`${at} names an input component for "${stray}", which is not one of the command's inputs.`);
  return {
    label: e.label.trim(),
    command,
    ...(inputs ? { inputs } : {}),
    ...(path === undefined ? {} : { path }),
    ...(prefillable ? { prefillable } : {}),
    ...(icon === undefined ? {} : { icon }),
    ...(e.realm === undefined ? {} : { realm: parseRealm(e.realm, at) }),
    ...(steps === undefined ? {} : { steps }),
    ...(style === undefined ? {} : { style }),
    ...(note ? { note } : {}),
    ...(e.review === false ? { review: false as const } : {}),
    ...(e.description === undefined ? {} : { description: (e.description as string).trim() }),
    ...(e.submitLabel === undefined ? {} : { submitLabel: (e.submitLabel as string).trim() }),
    ...(done === undefined ? {} : { done }),
    ...(isPublic ? { public: true as const } : {}),
    ...(save ? { save } : {}),
    ...(statusCheck ? { statusCheck } : {}),
    ...(link ? { link } : {}),
  };
}

/**
 * What a form's dress adds to what it is served as: the steps with their rows and words, the style, the note and
 * whether it reviews. One place, so a public form's payload and a signed-in one's say the same.
 */
export function servedFormDress(form: Pick<AppFormView, 'steps' | 'style' | 'note' | 'review'>): Record<string, unknown> {
  return {
    ...(form.steps === undefined
      ? {}
      : {
          steps: form.steps.map((step) => ({
            id: step.id,
            label: step.label,
            fields: [...step.fields],
            ...(step.rows ? { rows: step.rows.map((row) => [...row]) } : {}),
            ...(step.title === undefined ? {} : { title: step.title }),
            ...(step.lead === undefined ? {} : { lead: step.lead }),
            ...(step.next === undefined ? {} : { next: step.next }),
            ...(step.skip === undefined ? {} : { skip: step.skip }),
          })),
        }),
    ...(form.style === undefined ? {} : { style: form.style }),
    ...(form.note ? { note: form.note } : {}),
    ...(form.review === false ? { review: false } : {}),
  };
}
