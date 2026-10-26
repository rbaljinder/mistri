/**
 * What the server checks about a public form before it serves one, beside
 * the command registry's own checks: startup and `mistri check` both run
 * it, so a form that would echo what an applicant typed, or a saved form
 * whose tables cannot hold a draft, is refused by name before anyone fills
 * it in.
 *
 * Two rules. Every public form is write-only to the person filling it in:
 * its command answers a receipt and a fixed sentence, nothing else, so no
 * output shape can carry back a value that was typed or stored. And a form
 * saved on every step names real tables that can hold an unfinished
 * application: a root with the platform's three columns, typed and nullable,
 * the columns later steps fill nullable too, every step writing only the root
 * and the tables that reference it. On a tenant App the intake adds its own
 * check at startup: a root in each place a step may land, a tenant's and the
 * platform's (tenant/tenantIntake.ts).
 */
import {
  isPublicCommandPage,
  isPublicForm,
  isRowPolicyApp,
  isTenantApp,
  logicalResource,
  type AppDef,
  type AppFormView,
} from '../../shared/app.js';
import { findTable, primaryKey, type DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { commandFieldsDeep } from '../../shared/command.js';
import { compileNotifyWhen, notifyWhenHolds } from '../../shared/appNotify.js';
import { formCommands, isSavedForm } from '../../shared/appSavedForms.js';
import { commandCatalog, type CommandCatalog } from '../commands/commandDb.js';
import { describeShape, type ShapeDescriptor } from '../commands/commandShapes.js';
import { getCommandEvents, type AnyBusinessCommand, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { draftChildren } from './savedForms.js';
import { hasKeyedInput } from './formKey.js';

const TEXT = /char|text|clob|string/i;
const TIME = /^(timestamp|timestamptz|datetime|date ?time|timestamp with(out)? time zone|text)/i;

/**
 * What a public form's command may answer: `reference` (text: the receipt,
 * always) and `message` (a literal: fixed words, if it likes), and nothing
 * else. The reference is what the visitor quotes and what the form's reply
 * carries, so a submit without one would fail every submission at runtime
 * (formHttp.ts); it is refused here instead. A step of a saved form answers
 * `message` at most — the receipt is the submit's. A value that could have
 * been typed or read never fits either.
 */
function publicOutputProblem(id: string, command: AnyBusinessCommand, role: 'submit' | 'step'): string | undefined {
  const shape: ShapeDescriptor = describeShape(command.output);
  const refused =
    role === 'submit'
      ? `Command "${id}" answers a public form, which answers { reference: text(), message: literal(…) } and nothing else: ` +
        'a public form is write-only, and its reply must never carry back what was typed or stored.'
      : `Command "${id}" saves a step of a public form, which answers nothing but an optional message: literal(…). The receipt is the submit's.`;
  if (shape.kind !== 'object') return refused;
  if (role === 'submit' && shape.fields.reference?.kind !== 'text') {
    return (
      `Command "${id}" answers a public form [public-form-reference], and its output has no reference: every submission would be refused after it ran. ` +
      "Answer shape({ reference: text({ pattern: publicReferencePattern('…') }), message: literal('…') }), returning publicReference('…'): the visitor quotes it."
    );
  }
  for (const [name, member] of Object.entries(shape.fields)) {
    const inner = member.kind === 'optional' ? member.item : member;
    if (name === 'message' && inner.kind === 'literal' && inner.values.every((value) => typeof value === 'string')) continue;
    if (role === 'submit' && name === 'reference' && member.kind === 'text') continue;
    return refused;
  }
  return undefined;
}

/**
 * A public form's reference input is a picker a visitor reads its choices
 * through: the same signed-out read a public page makes, so its rows are only
 * those `auth.public` opens (a row policy's public rows, where there is one)
 * and the picker asks its key and its label, nothing else. It is refused,
 * by name, where that read could not answer: a resource `auth.public` does not
 * open, or a key or label column its `fields` leave out. Its `query` is read
 * the same way, so a column the visitor cannot read refuses the choices there.
 */
function publicPickerProblem(
  app: AppDef,
  id: string,
  command: AnyBusinessCommand,
  schema: DatabaseSchema,
  on = 'a public form',
): string | undefined {
  for (const { field: declared, path } of commandFieldsDeep(command.fields)) {
    /* A choice from a table's rows is read the same way: the visitor's read offers them. */
    const field =
      declared.type === 'reference'
        ? declared
        : (declared.type === 'choice' || declared.type === 'choices') && declared.source
          ? { from: declared.source.from, by: declared.source.by, labelColumn: declared.source.labelColumn }
          : undefined;
    if (!field) continue;
    const resource = logicalResource(app, command.source, field.from);
    const opened = app.auth?.public;
    const at = `Command "${id}" input "${path}" [public-form-picker] ${declared.type === 'reference' ? 'is a picker' : 'offers the rows'} over "${field.from}" on ${on}`;
    if (!opened?.read.includes(resource))
      return `${at}, and "auth.public" does not open "${resource}": a visitor reads its choices signed out. Open it in "auth.public", or use a choice the handler resolves.`;
    const table = findTable(schema, resource);
    const keys = table ? primaryKey(table) : [];
    const ceilings = [opened.fields?.[resource]?.read, app.resources?.[resource]?.fields?.read].filter((read) => read !== undefined);
    for (const column of new Set([field.by, field.labelColumn])) {
      if (keys.includes(column)) continue;
      if (ceilings.some((read) => !read.includes(column)))
        return `${at}, and a visitor may not read its column "${column}". Name it in "auth.public.fields.${resource}", or pick by and label columns the public reads.`;
    }
  }
  return undefined;
}

/** Every problem of the App's public forms, and of its public pages' commands, against this registry and catalog, the first first. */
export function publicFormProblems(app: AppDef, registry: BusinessCommandRegistry, schema: DatabaseSchema): string | undefined {
  for (const [key, view] of Object.entries(app.views)) {
    if (!isPublicForm(view)) continue;
    const form = view as AppFormView;
    for (const reference of formCommands(form)) {
      const command = registry[reference.id];
      const problem = command && publicPickerProblem(app, reference.id, command, schema);
      if (problem) return `Form "${key}": ${problem}`;
    }
    const submit = registry[form.command.id];
    if (submit) {
      const problem = publicOutputProblem(form.command.id, submit, 'submit');
      if (problem) return `Form "${key}": ${problem}`;
    }
    if (isSavedForm(form)) {
      const problem = savedFormProblem(app, form, registry, schema);
      if (problem) return `Form "${key}": ${problem}`;
    }
  }
  /* A public page's public command offers a table's rows the same way: served with the page's command, read as the
     public reads them (appProjection.ts), so the same read must answer. */
  for (const [key, view] of Object.entries(app.views)) {
    if (!isPublicCommandPage(view)) continue;
    for (const id of view.page.commands) {
      const command = Object.hasOwn(registry, id) ? registry[id] : undefined;
      const problem = command?.public === true && publicPickerProblem(app, id, command, schema, 'a public page');
      if (problem) return `Page "${key}": ${problem}`;
    }
  }
  return undefined;
}

function footprintCatalog(app: AppDef, command: AnyBusinessCommand, schema: DatabaseSchema): CommandCatalog | undefined {
  return commandCatalog(schema, command.read, (local) => logicalResource(app, command.source, local));
}

/** The tables a saved form's root may be in: its first step's written tables that carry the resume columns. */
export function savedFormRoots(
  form: AppFormView & { save: NonNullable<AppFormView['save']> },
  start: AnyBusinessCommand,
  catalog: CommandCatalog,
): string[] {
  const { token, expires, progress } = form.save.resume;
  return start.write.filter((table) => {
    const columns = new Set(catalog[table]?.meta.columns.map((column) => column.name) ?? []);
    return columns.has(token) && columns.has(expires) && columns.has(progress);
  });
}

/**
 * The columns the server writes beside the resume's: the status check's
 * alert stamp and the link's owner, provenance and claim. Each is typed and
 * nullable — a submitted application holds none of them yet — and an alert
 * nobody's `notify` rule watches would tell nobody.
 */
function platformColumnProblem(
  app: AppDef,
  form: AppFormView,
  root: string,
  start: AnyBusinessCommand,
  column: (name: string) => { type: string; nullable?: boolean } | undefined,
): string | undefined {
  const wanted: Array<[string, string, RegExp, string]> = [];
  const alert = form.statusCheck?.alert;
  if (alert) wanted.push(['statusCheck.alert', alert, TIME, 'a timestamp']);
  if (form.link) {
    const { link } = form;
    wanted.push(['link.owner', link.owner, TEXT, 'text'], ['link.at', link.at, TIME, 'a timestamp'], ['link.via', link.via, TEXT, 'text']);
    if (link.sameDevice)
      wanted.push(
        ['link.sameDevice.token', link.sameDevice.token, TEXT, 'text'],
        ['link.sameDevice.expires', link.sameDevice.expires, TIME, 'a timestamp'],
      );
    if (link.email?.verified) wanted.push(['link.email.verified', link.email.verified, TEXT, 'text']);
  }
  for (const [role, name, pattern, what] of wanted) {
    const found = column(name);
    if (!found) return `${role} names "${root}.${name}", which is not a column.`;
    if (!pattern.test(found.type)) return `"${root}.${name}" (${role}) is ${found.type}; it must be ${what}.`;
    if (!found.nullable)
      return `"${root}.${name}" (${role}) must be nullable: a submitted application holds none until the server writes it.`;
  }
  if (alert) {
    const rules = app.resources?.[logicalResource(app, start.source, root)]?.notify ?? [];
    const watched = rules.some(
      (rule) => rule.on === 'update' || (typeof rule.on === 'object' && 'changes' in rule.on && rule.on.changes.includes(alert)),
    );
    if (!watched)
      return (
        `the status check stamps "${root}.${alert}" when a receipt locks, and no notify rule on "${root}" watches it, so nobody would be told: ` +
        `notify: [{ on: { changes: '${alert}' }, when: { ${form.save!.draft.column}: [the states after '${form.save!.draft.value}'] }, to: …, title: … }].`
      );
  }
  return undefined;
}

function savedFormProblem(
  app: AppDef,
  form: AppFormView & { save: NonNullable<AppFormView['save']> },
  registry: BusinessCommandRegistry,
  schema: DatabaseSchema,
): string | undefined {
  const { save } = form;
  /* A row-policy App's public intake places one insert and changes nothing
     after it (policy/policyPublicIntake.ts): a draft that later steps update
     needs that placement re-proved on every step, which it does not do yet.
     A tenant App's intake does (tenant/tenantIntake.ts): each step is
     resolved again, and its draft is found only in the place it resolves to. */
  if (isRowPolicyApp(app)) {
    return "saves each step, which an ordinary or a tenant App's public form does; a row-policy App's public intake inserts once and changes nothing after.";
  }
  /* The status check and the link read and write an application outside any
     step's command — a lockout stamp, an account's id — and a tenant App's
     intake runs nothing but its public commands, each in the place its
     address resolves to. Refused by name rather than served as a 503. */
  if (isTenantApp(app) && (form.statusCheck || form.link)) {
    return `declares ${form.statusCheck ? 'statusCheck' : 'link'}, which a tenant App's saved form does not serve yet: its intake runs only the form's own steps and submit, each in the place its address resolves to. Leave it out.`;
  }
  const steps = form.steps as Array<{ id: string; command: { id: string } }>;
  const commands = formCommands(form).map((reference) => [reference.id, registry[reference.id]] as const);
  const missing = commands.find(([, command]) => !command);
  if (missing) return `command "${missing[0]}" is not registered.`;
  const [startId, start] = commands[0] as [string, AnyBusinessCommand];
  const startCatalog = footprintCatalog(app, start, schema);
  if (!startCatalog) return `command "${startId}" names a table the catalog does not hold.`;
  const roots = savedFormRoots(form, start, startCatalog);
  if (!roots.length) {
    return (
      `its first step's command "${startId}" writes no table with the resume columns "${save.resume.token}", "${save.resume.expires}" ` +
      `and "${save.resume.progress}": the application's root row is the one it inserts, and it keeps them.`
    );
  }
  for (const root of roots) {
    const meta = startCatalog[root].meta;
    const column = (name: string) => meta.columns.find((candidate) => candidate.name === name);
    if (meta.columns.filter((candidate) => candidate.primaryKey).length !== 1)
      return `the root table "${root}" needs a single-column primary key.`;
    for (const [role, name, pattern] of [
      ['token', save.resume.token, TEXT],
      ['progress', save.resume.progress, TEXT],
      ['expires', save.resume.expires, TIME],
    ] as const) {
      const found = column(name)!;
      if (!pattern.test(found.type))
        return `"${root}.${name}" (resume.${role}) is ${found.type}; it must be ${role === 'expires' ? 'a timestamp' : 'text'}.`;
      if (!found.nullable) return `"${root}.${name}" (resume.${role}) must be nullable: the platform clears it on submit.`;
    }
    if (!column(save.draft.column)) return `the root table "${root}" has no column "${save.draft.column}" for the draft state.`;
    if (form.statusCheck) {
      const check = form.statusCheck;
      for (const name of [check.receipt, ...check.confirm.map((item) => item.column), ...check.show]) {
        if (!column(name)) return `the status check names "${root}.${name}", which is not a column.`;
      }
    }
    const problem = platformColumnProblem(app, form, root, start, column);
    if (problem) return problem;
  }
  const asked = new Map<string, string>();
  for (const [index, [id, command]] of commands.entries()) {
    const role = index < steps.length ? 'step' : 'submit';
    if (role === 'step') {
      const problem = publicOutputProblem(id, command!, 'step');
      if (problem) return problem;
    }
    // Only the move to submitted notifies anyone: a step is a draft being written.
    if (role === 'step' && (getCommandEvents(command!) !== undefined || command!.sources !== undefined)) {
      return `command "${id}" saves a step and declares events, effects or a lookup; only the submit, which finishes the application, may.`;
    }
    const catalog = footprintCatalog(app, command!, schema);
    if (!catalog) return `command "${id}" names a table the catalog does not hold.`;
    for (const root of roots) {
      if (!command!.write.includes(root))
        return `command "${id}" does not write the root table "${root}"; every step and the submit keep the application's place on it.`;
    }
    for (const table of command!.write) {
      /* A resource's `notify` fires on the write itself, and a draft's rows
         are written long before anyone should hear of them: on the root only
         a rule held to states past the draft (`when: 'status = submitted'`),
         and none on the rows beneath it. */
      const resource = app.resources?.[logicalResource(app, command!.source, table)];
      for (const rule of resource?.notify ?? []) {
        const meta = schema.tables.find((candidate) => candidate.name === table);
        const compiled = rule.when === undefined || !meta ? undefined : compileNotifyWhen(meta, schema, rule.when);
        const held = typeof compiled === 'object' && !notifyWhenHolds(compiled, { [save.draft.column]: save.draft.value });
        if (!roots.includes(table) || !held) {
          return (
            `"${table}" notifies on a write a draft makes; a saved form's rows notify only once it is submitted: ` +
            `on the root, a rule with when: '${save.draft.column} != ${save.draft.value}', or the states after it.`
          );
        }
      }
      if (roots.includes(table)) continue;
      if (![...roots].some((root) => draftChildren(catalog, root).has(table))) {
        return `command "${id}" writes "${table}", which does not reference the application's root: a step writes its own application's rows only.`;
      }
      if (save.abandoned === 'purge' && !start.write.includes(table)) {
        return (
          `abandoned: 'purge' removes an expired draft with every row that points at it, in the first step's transaction, ` +
          `so its command "${startId}" must list "${table}" in write.`
        );
      }
    }
    if (role === 'step' && index > 0) {
      for (const field of command!.fields) {
        asked.set(field.name, id);
        for (const root of roots) {
          const column = catalog[root]?.meta.columns.find((candidate) => candidate.name === field.name);
          if (column && !column.nullable && !column.default && !column.hasDefault) {
            return `"${root}.${field.name}" is filled by the step "${steps[index].id}", after the root row is created, so it must be nullable.`;
          }
        }
      }
    } else if (role === 'step') for (const field of command!.fields) asked.set(field.name, id);
  }
  if (form.statusCheck) {
    const check = form.statusCheck;
    for (const name of check.show) {
      if (asked.has(name)) return `the status check shows "${name}", which a step asks for. It answers a state, never an input.`;
    }
    for (const item of check.confirm) {
      if (!item.keyed) continue;
      const step = commands.find(([, command]) =>
        command!.fields.some((field) => field.name === item.column && field.type === 'text' && field.sensitive?.keep === 'hash'),
      );
      if (!step) return `the status check confirms "${item.column}" as keyed, and no step asks a keyed input of that name to fill it.`;
    }
    if (check.stepUp) {
      // The code goes to the address the application holds, so that column must hold one.
      for (const root of roots) {
        const email = startCatalog[root]?.meta.columns.find((candidate) => candidate.name === check.stepUp!.email);
        if (!email || !TEXT.test(email.type))
          return `the status check's stepUp sends its code to "${root}.${check.stepUp.email}", which is not a text column of the root.`;
        const missing = check.stepUp.show.find((name) => !startCatalog[root]?.meta.columns.some((candidate) => candidate.name === name));
        if (missing) return `the status check's stepUp shows "${missing}", which is not a column of "${root}".`;
      }
    }
  }
  if (form.link?.email) {
    for (const root of roots) {
      const email = startCatalog[root]?.meta.columns.find((candidate) => candidate.name === form.link!.email!.column);
      if (!email || !TEXT.test(email.type))
        return `link.email matches accounts by "${root}.${form.link.email.column}", which is not a text column of the root.`;
    }
  }
  return undefined;
}

/** Whether any public form of the App keeps an input as a keyed hash: then the server needs MISTRI_FORM_KEY. */
export function publicFormsNeedKey(app: AppDef, registry: BusinessCommandRegistry): boolean {
  return Object.values(app.views).some(
    (view) =>
      isPublicForm(view) &&
      formCommands(view as AppFormView).some((reference) => registry[reference.id] && hasKeyedInput(registry[reference.id].fields)),
  );
}
