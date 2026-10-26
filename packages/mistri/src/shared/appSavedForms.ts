/**
 * A public form saved on every step, as the App declares it: each step runs a
 * command of its own against the App's real tables, the first creating the
 * application's root row in a draft state and every later one writing that
 * root's rows; the form's own `command` is the final submit. The server keeps
 * the application's place in an opaque cookie whose hash is on the root row
 * (`resume`), and answers nothing an applicant typed: a saved form is
 * write-only (server/forms/savedForms.ts).
 *
 *   commandForm('Apply for financing', [step('About you', 'startApplication'), step('Income', 'saveIncome')], {
 *     public: true, submit: submitApplication,
 *     resume: { token: 'resume_token_hash', expires: 'resume_expires_at', progress: 'resume_progress', after: '14 days' },
 *     draft: { status: 'in_progress' }, abandoned: 'purge',
 *     statusCheck: { receipt: 'reference', confirm: { applicant_last_name: 'Last name' }, show: ['status'] } })
 *
 * This module reads the declaration's shape; the catalog judges its names
 * (savedFormSchemaProblems), and the command registry its commands.
 */
import { parseFormCommandReference, type AppFormCommandReference } from './command.js';
import type { AppFormView } from './appModel.js';
import { parseStepWords, stepIdOf } from './formRules.js';
import { parseDuration } from '@mistriwork/engine/shared/duration.js';

/** The root row's columns the platform owns, and how long a draft may be resumed. */
interface AppFormResume {
  /** Text: the SHA-256 of the applicant's cookie, never the cookie. */
  token: string;
  /** A timestamp: after it the draft cannot be resumed, and `abandoned` says what becomes of it. */
  expires: string;
  /** Text: the ids of the steps saved so far — never what was typed in them. */
  progress: string;
  /** Days from the first step to the expiry: 1 to 90. */
  days: number;
}

export interface AppFormSave {
  resume: AppFormResume;
  /** The one column and value the root is created with and held to until submit. */
  draft: { column: string; value: string };
  /** An expired draft: removed with the rows that point at it, or kept for follow-up. */
  abandoned: 'purge' | 'keep';
}

/** One value a status check asks for, in the order asked, compared with a column of the root. */
interface AppStatusConfirm {
  column: string;
  label: string;
  /** The column holds a keyed hash (a `keyed` input's), so the value asked is hashed the same way before comparing. */
  keyed?: true;
}

/**
 * The one sanctioned read of an anonymous application: a receipt, which is
 * the strong factor, confirmed by values only the applicant knows. It
 * answers `show` only — a status, never what was typed — and anything more
 * needs a one-time code sent to the address on file (`stepUp`).
 */
export interface AppStatusCheck {
  /** The root column holding the receipt the submit returned. */
  receipt: string;
  confirm: AppStatusConfirm[];
  /** Root columns answered after the check: a state, never an input. */
  show: string[];
  /** Words for a shown column's values (`{ status: { new: 'Received' } }`); a value it does not name is answered as "Received". */
  says?: Record<string, Record<string, string>>;
  /** More after a one-time code sent to the root's email column: these columns too. */
  stepUp?: { email: string; show: string[] };
  /**
   * A timestamp column of the root the server stamps when a submitted
   * application's receipt locks after repeated wrong answers: the App's own
   * `notify` rule on a change to it tells staff (statusCheck.ts).
   */
  alert?: string;
}

/**
 * Linking a submitted application to an account, on proven control only
 * (formLink.ts): the same browser straight after submitting (`sameDevice`),
 * or a signed-in status check (`statusCheck`). Never on matching data.
 */
export interface AppFormLink {
  /** Text: the account's id, set once; null until linked. */
  owner: string;
  /** A timestamp and text: when it was linked and by which path, for staff to see. */
  at: string;
  via: string;
  /** The claim a submit leaves in this browser for thirty minutes: its hash and expiry on the root. */
  sameDevice?: { token: string; expires: string };
  /** A signed-in person who passes the status check may add the application to their account. */
  statusCheck?: true;
  /**
   * A signed-in person whose account's email is verified is offered the
   * applications that captured the same address (`column`), and confirms
   * each. It links without asking only where the applicant proved the
   * address with a code in the form: `verified` is the root column the server
   * stamps with the address proved.
   */
  email?: { column: string; verified?: string };
}

/** How long the claim a submit leaves in the browser may be spent. */
export const CLAIM_MINUTES = 30;

/** A step of a saved form: its caption, its command, and the command's inputs as the step's fields. */
interface AppFormStepCommand {
  id: string;
  label: string;
  fields: string[];
  command: AppFormCommandReference;
}

const COLUMN = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;
const MAX_STEPS = 12;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const keysOnly = (value: Record<string, unknown>, allowed: readonly string[], at: string) => {
  const stray = Object.keys(value).find((key) => !allowed.includes(key));
  if (stray !== undefined) throw new Error(`${at} has "${stray}"; it takes ${allowed.map((key) => `"${key}"`).join(', ')}.`);
};
const column = (value: unknown, at: string, what: string): string => {
  if (typeof value !== 'string' || !COLUMN.test(value)) throw new Error(`${at} needs ${what}: a column of the application's root table.`);
  return value;
};
const words = (value: unknown, at: string, max: number): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`${at} must be text of at most ${max} characters.`);
  return value.trim();
};

/** Whether a form is saved on every step. */
export const isSavedForm = (form: Pick<AppFormView, 'save'> | undefined): form is AppFormView & { save: AppFormSave } => !!form?.save;

/** Every command a form runs: each saved step's, then its own (the submit). */
export function formCommands(form: Pick<AppFormView, 'command' | 'steps'>): AppFormCommandReference[] {
  const steps = (form.steps ?? []).flatMap((step) => ('command' in step && step.command ? [step.command as AppFormCommandReference] : []));
  return [...steps, form.command];
}

/** The steps of a saved form: `step('About you', 'startApplication')`, each naming its command. */
export function parseSavedSteps(raw: unknown, at: string): AppFormStepCommand[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > MAX_STEPS)
    throw new Error(`${at} must be a list of 1 to ${MAX_STEPS} steps, each running its own command.`);
  const ids = new Set<string>(),
    commands = new Set<string>();
  return raw.map((entry, index) => {
    const here = `${at}, step ${index + 1}`;
    if (!isRecord(entry)) throw new Error(`${here} is not a step { id, label, command }.`);
    keysOnly(entry, ['id', 'label', 'command', 'title', 'lead', 'next'], here);
    if (entry.command === undefined)
      throw new Error(
        `${here} names no command. A saved form's step runs its own: step('${String(entry.label ?? 'About you')}', 'saveAddress').`,
      );
    const label = words(entry.label, `${here}, "label"`, 80);
    // One rule for a step's id, whatever the step does: the label's slug unless written (formRules.ts).
    const id = stepIdOf(entry, label, here);
    if (ids.has(id)) throw new Error(`${here} repeats the step id "${id}".`);
    ids.add(id);
    const command = parseFormCommandReference(entry.command, `${here}, "command"`, true);
    if (commands.has(command.id))
      throw new Error(`${here} runs "${command.id}", which another step runs too. Each step saves through its own command.`);
    commands.add(command.id);
    if (!command.input.length) throw new Error(`${here}: its command takes no input, so the step would ask for nothing.`);
    return {
      id,
      label,
      fields: command.input.map((field) => field.name),
      command,
      ...parseStepWords(entry, here, ['title', 'lead', 'next']),
    };
  });
}

/** `'14 days'` or `'2 weeks'`: a whole number of days, 1 to 90. */
function days(raw: unknown, at: string): number {
  const ms = parseDuration(raw);
  if (ms === undefined || ms % 86_400_000 !== 0 || ms < 86_400_000 || ms > 90 * 86_400_000) {
    throw new Error(`${at} must be a duration of whole days from 1 to 90, such as '14 days' or '2 weeks'.`);
  }
  return ms / 86_400_000;
}

/** A form saved on every step, and what it needs beside its steps: where the draft is kept, and what becomes of it. */
export function parseFormSave(e: Record<string, unknown>, at: string): AppFormSave {
  if (e.public !== true) throw new Error(`${at} saves each step, which a public form does: say public: true.`);
  if (!isRecord(e.resume))
    throw new Error(
      `${at} saves each step and needs "resume": { token, expires, progress, after }, the root row's columns the server keeps.`,
    );
  keysOnly(e.resume, ['token', 'expires', 'progress', 'after'], `${at}, "resume"`);
  const resume: AppFormResume = {
    token: column(e.resume.token, `${at}, "resume"`, 'a "token"'),
    expires: column(e.resume.expires, `${at}, "resume"`, 'an "expires"'),
    progress: column(e.resume.progress, `${at}, "resume"`, 'a "progress"'),
    days: days(e.resume.after ?? '14 days', `${at}, "resume.after"`),
  };
  if (new Set([resume.token, resume.expires, resume.progress]).size !== 3) throw new Error(`${at}, "resume" names one column twice.`);
  if (!isRecord(e.draft) || Object.keys(e.draft).length !== 1)
    throw new Error(
      `${at} saves each step and needs "draft": one column and the value an unfinished application holds, such as { status: 'in_progress' }.`,
    );
  const [[draftColumn, draftValue]] = Object.entries(e.draft);
  column(draftColumn, `${at}, "draft"`, 'a column');
  if ([resume.token, resume.expires, resume.progress].includes(draftColumn))
    throw new Error(`${at}, "draft" names "${draftColumn}", which "resume" keeps.`);
  const value = words(draftValue, `${at}, "draft.${draftColumn}"`, 60);
  if (e.abandoned !== undefined && e.abandoned !== 'purge' && e.abandoned !== 'keep')
    throw new Error(`${at} has an "abandoned" of ${JSON.stringify(e.abandoned)}. Use 'purge' or 'keep'.`);
  return { resume, draft: { column: draftColumn, value }, abandoned: (e.abandoned as 'purge' | 'keep' | undefined) ?? 'purge' };
}

/** A saved form's status check: the receipt, the values that confirm it, what it shows, and the step-up. */
export function parseStatusCheck(raw: unknown, at: string, save: AppFormSave): AppStatusCheck {
  if (!isRecord(raw)) throw new Error(`${at} is not { receipt, confirm, show }.`);
  keysOnly(raw, ['receipt', 'confirm', 'show', 'says', 'stepUp', 'alert'], at);
  const receipt = column(raw.receipt, at, 'a "receipt"');
  if (!isRecord(raw.confirm) || !Object.keys(raw.confirm).length || Object.keys(raw.confirm).length > 3) {
    throw new Error(
      `${at} needs "confirm": one to three root columns only the applicant knows, each with the label asked, such as { applicant_last_name: 'Last name' }. ` +
        'A receipt alone opens nothing.',
    );
  }
  const confirm = Object.entries(raw.confirm).map(([name, spec]): AppStatusConfirm => {
    column(name, `${at}, "confirm"`, 'a column');
    if (typeof spec === 'string') return { column: name, label: words(spec, `${at}, "confirm.${name}"`, 80) };
    if (!isRecord(spec))
      throw new Error(`${at}, "confirm.${name}" is a label, or { label, keyed: true } for a column holding a keyed input's hash.`);
    keysOnly(spec, ['label', 'keyed'], `${at}, "confirm.${name}"`);
    if (spec.keyed !== undefined && spec.keyed !== true) throw new Error(`${at}, "confirm.${name}" has a "keyed" that is not true.`);
    return {
      column: name,
      label: words(spec.label, `${at}, "confirm.${name}.label"`, 80),
      ...(spec.keyed === true ? { keyed: true as const } : {}),
    };
  });
  const list = (value: unknown, where: string): string[] => {
    if (!Array.isArray(value) || !value.length || value.length > 8)
      throw new Error(`${where} must be a list of one to eight root columns.`);
    const names = value.map((item) => column(item, where, 'a column'));
    if (new Set(names).size !== names.length) throw new Error(`${where} names one column twice.`);
    return names;
  };
  const show = list(raw.show ?? ['status'], `${at}, "show"`);
  const owned = new Set([save.resume.token, save.resume.expires, save.resume.progress]);
  const secret = new Set([...owned, receipt, ...confirm.map((item) => item.column)]);
  for (const name of show) {
    if (secret.has(name))
      throw new Error(
        `${at}, "show" names "${name}", which the check itself asks for or the server keeps. A status check answers a state, never a factor.`,
      );
  }
  let says: AppStatusCheck['says'];
  if (raw.says !== undefined) {
    if (!isRecord(raw.says)) throw new Error(`${at}, "says" is { column: { value: 'Words' } }.`);
    says = Object.fromEntries(
      Object.entries(raw.says).map(([name, map]) => {
        if (!show.includes(name)) throw new Error(`${at}, "says" has words for "${name}", which "show" does not name.`);
        if (!isRecord(map) || !Object.keys(map).length) throw new Error(`${at}, "says.${name}" is { value: 'Words' }.`);
        return [
          name,
          Object.fromEntries(Object.entries(map).map(([value, text]) => [value, words(text, `${at}, "says.${name}.${value}"`, 60)])),
        ];
      }),
    );
  }
  let stepUp: AppStatusCheck['stepUp'];
  if (raw.stepUp !== undefined) {
    if (!isRecord(raw.stepUp))
      throw new Error(`${at}, "stepUp" is { email, show }: the root's email column a one-time code goes to, and what it opens.`);
    keysOnly(raw.stepUp, ['email', 'show'], `${at}, "stepUp"`);
    const email = column(raw.stepUp.email, `${at}, "stepUp"`, 'an "email"');
    const more = list(raw.stepUp.show, `${at}, "stepUp.show"`);
    for (const name of more)
      if (owned.has(name) || confirm.some((item) => item.keyed && item.column === name)) {
        throw new Error(`${at}, "stepUp.show" names "${name}", which is never shown: the server's own column, or a keyed hash.`);
      }
    stepUp = { email, show: more };
  }
  const alert = raw.alert === undefined ? undefined : column(raw.alert, at, 'an "alert"');
  if (alert && (secret.has(alert) || show.includes(alert) || alert === save.draft.column))
    throw new Error(`${at}, "alert" names "${alert}", which the check asks for, shows or the server keeps otherwise.`);
  return { receipt, confirm, show, ...(says ? { says } : {}), ...(stepUp ? { stepUp } : {}), ...(alert ? { alert } : {}) };
}

/** `link`: the root's owner and provenance columns, and the paths a person may link by. */
export function parseFormLink(raw: unknown, at: string, save: AppFormSave, check: AppStatusCheck | undefined): AppFormLink {
  if (!isRecord(raw)) throw new Error(`${at} is not { owner, at, via, sameDevice?, statusCheck? }.`);
  // What a linked account sees is the status check's: its receipt and its state, never an input.
  if (!check)
    throw new Error(`${at} needs the form's "statusCheck": a linked application is tracked by its receipt and the state the check shows.`);
  keysOnly(raw, ['owner', 'at', 'via', 'sameDevice', 'statusCheck', 'email'], at);
  const link: AppFormLink = {
    owner: column(raw.owner, at, 'an "owner"'),
    at: column(raw.at, at, 'an "at"'),
    via: column(raw.via, at, 'a "via"'),
  };
  if (raw.sameDevice !== undefined) {
    if (!isRecord(raw.sameDevice))
      throw new Error(`${at}, "sameDevice" is { token, expires }: the root's columns for the claim's hash and its expiry.`);
    keysOnly(raw.sameDevice, ['token', 'expires'], `${at}, "sameDevice"`);
    link.sameDevice = {
      token: column(raw.sameDevice.token, `${at}, "sameDevice"`, 'a "token"'),
      expires: column(raw.sameDevice.expires, `${at}, "sameDevice"`, 'an "expires"'),
    };
  }
  if (raw.statusCheck !== undefined) {
    if (raw.statusCheck !== true) throw new Error(`${at}, "statusCheck" is true or left out.`);
    link.statusCheck = true;
  }
  if (raw.email !== undefined) {
    if (typeof raw.email === 'string') link.email = { column: column(raw.email, `${at}, "email"`, 'an email column') };
    else if (isRecord(raw.email)) {
      keysOnly(raw.email, ['column', 'verified'], `${at}, "email"`);
      link.email = {
        column: column(raw.email.column, `${at}, "email"`, 'a "column" holding the applicant\'s email'),
        ...(raw.email.verified !== undefined
          ? { verified: column(raw.email.verified, `${at}, "email"`, 'a "verified" column the server stamps') }
          : {}),
      };
    } else
      throw new Error(
        `${at}, "email" is the root's email column, or { column, verified }: verified is the column the server stamps when the applicant proves the address with a code.`,
      );
  }
  if (!link.sameDevice && !link.statusCheck && !link.email) {
    throw new Error(
      `${at} names no way to link: sameDevice: { token, expires } (straight after submitting, in the same browser), statusCheck: true (signed in, through the status check), ` +
        "email: 'applicant_email' (signed in with a verified email that matches), or several.",
    );
  }
  const named = linkColumns(link);
  if (new Set(named).size !== named.length) throw new Error(`${at} names one column twice.`);
  const taken = new Set([
    save.resume.token,
    save.resume.expires,
    save.resume.progress,
    save.draft.column,
    check.receipt,
    ...check.confirm.map((item) => item.column),
    ...check.show,
    ...(check.alert ? [check.alert] : []),
  ]);
  const clash = named.find((name) => taken.has(name));
  if (clash) throw new Error(`${at} names "${clash}", which the form keeps for something else. The link's columns are the server's own.`);
  return link;
}

/** The root columns a link keeps. */
export const linkColumns = (link: AppFormLink): string[] => [
  link.owner,
  link.at,
  link.via,
  ...(link.sameDevice ? [link.sameDevice.token, link.sameDevice.expires] : []),
  ...(link.email?.verified ? [link.email.verified] : []),
];

/** The root columns holding a token's hash — the resume's and the claim's: never kept in a record history. */
export const tokenColumns = (form: Pick<AppFormView, 'save' | 'link'>): string[] => [
  ...(form.save ? [form.save.resume.token] : []),
  ...(form.link?.sameDevice ? [form.link.sameDevice.token] : []),
];

/** Every root column the platform writes and no step may: the resume's, the link's, the status check's alert. */
export function platformColumns(form: Pick<AppFormView, 'save' | 'statusCheck' | 'link'>): string[] {
  const resume = form.save ? [form.save.resume.token, form.save.resume.expires, form.save.resume.progress] : [];
  return [...resume, ...(form.link ? linkColumns(form.link) : []), ...(form.statusCheck?.alert ? [form.statusCheck.alert] : [])];
}

/** A shown value in the words the status check says it in: never a raw internal state the author did not name. */
export function statusWords(check: Pick<AppStatusCheck, 'says'>, name: string, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const said = check.says?.[name];
  if (!said) return String(value);
  return said[String(value)] ?? 'Received';
}
