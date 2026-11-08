/**
 * A signed-in form saved on every step, over HTTP: one route, `/api/commands/draft`, for the person who owns the
 * draft (savedForms.ts). It is the signed-in command route with the form's place added, and nothing else:
 *
 *   { form, op: 'step',    step, draft?, request }   save one step              → the command's result, and the draft
 *   { form, op: 'submit',  draft?, version, request } finish the application     → the command's result (the receipt)
 *   { form, op: 'resume' }                           the person's open draft    → { draft } · { draft: null }
 *   { form, op: 'review',  draft? }                  the draft's version        → { version, saved, values }
 *   { form, op: 'discard', draft? }                  start over                 → { discarded }
 *
 * `request` is the ordinary command envelope, idempotency key and all: a step or a submit that is sent twice answers
 * the first outcome (the executor's receipt, found before anything runs) and writes once. Which phase a request is —
 * the first step, a later one, the submit — is decided here from the form and the step, never from a field the page
 * fills, and who owns the draft is the session's `me`, resolved in the step's own transaction: the page names nobody.
 * Every operation runs under the actor's own grant of the form's commands and, in a row-policy App, the actor's rows,
 * resolved again for this request, so a grant lost between steps refuses the next one and leaves the draft as it is.
 *
 * A draft id the page sends is a hint: another person's draft and a guess answer as no draft at all (404). A person
 * with two open drafts (two tabs raced the first step) is answered with the hinted one, else the newest.
 *
 * Resume and review answer `values`: what the draft holds under the names the steps ask, so the page can show the
 * review of everything that will be submitted. It is only ever the owner's (the same owner predicate found the draft),
 * and never a column no step shows: the owner, the token, the expiry, the progress and the platform's own.
 */
import type { WriteTransaction } from '@mistriwork/engine/adapters/adapter.js';
import { CommandTransactionFailure } from '../../adapters/commands/commandJournal.js';
import { ScopeRefusal } from '@mistriwork/engine/adapters/scoped/scopedTransaction.js';
import type { Filter } from '@mistriwork/engine/shared/filter.js';
import { isFormView, type AppDef, type AppFormView } from '../../shared/app.js';
import { formCommands, isSavedForm, platformColumns, type AppFormSave } from '../../shared/appSavedForms.js';
import { AppAccessDenied } from '../app/appAccess.js';
import type { BusinessCommandBinding } from '../commands/businessCommandAccess.js';
import type { CommandFileRule } from '../commands/businessCommandAuthorization.js';
import { BusinessCommandExecutionError } from '../commands/commandErrors.js';
import { executeBusinessCommand, type CommandDoor } from '../commands/businessCommandExecution.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from '../commands/businessCommands.js';
import { checkCommandStep } from '../commands/commandCheck.js';
import { CommandInputError } from '../commands/commandPayload.js';
import { whenPerson, type CommandPeople } from '../commands/commandWhen.js';
import type { CommandFlags } from '../commands/commandFlags.js';
import { keyFilter, type CommandCatalog } from '../commands/commandDb.js';
import { draftChildren, draftVersion, dropObjects, findOwnedDraft, type SavedDraftRun } from './savedForms.js';
import { savedFormRoots } from './savedFormChecks.js';

type Op = 'step' | 'submit' | 'resume' | 'review' | 'discard';
const OPS: readonly Op[] = ['step', 'submit', 'resume', 'review', 'discard'];

/** What the page said: which form, what to do, and the hints it may give. */
interface Selector {
  readonly form: string;
  readonly op: Op;
  readonly step?: string;
  readonly hint?: string | number;
  readonly version?: string;
  readonly request?: unknown;
}

function parseSelector(body: unknown): Selector {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandInputError();
  const raw = body as Record<string, unknown>;
  const stray = Object.keys(raw).find((key) => !['form', 'op', 'step', 'draft', 'version', 'request'].includes(key));
  if (stray !== undefined) throw new CommandInputError(stray);
  if (typeof raw.form !== 'string') throw new CommandInputError('form');
  if (typeof raw.op !== 'string' || !OPS.includes(raw.op as Op)) throw new CommandInputError('op');
  if (raw.step !== undefined && typeof raw.step !== 'string') throw new CommandInputError('step');
  if (raw.version !== undefined && (typeof raw.version !== 'string' || !/^[0-9a-f]{64}$/.test(raw.version)))
    throw new CommandInputError('version');
  if (raw.draft !== undefined && typeof raw.draft !== 'string' && typeof raw.draft !== 'number') throw new CommandInputError('draft');
  return {
    form: raw.form,
    op: raw.op as Op,
    ...(raw.step === undefined ? {} : { step: raw.step }),
    ...(raw.draft === undefined ? {} : { hint: raw.draft }),
    ...(raw.version === undefined ? {} : { version: raw.version }),
    ...(raw.request === undefined ? {} : { request: raw.request }),
  };
}

/** The signed-in saved form a key names, or none: a wrong key and a form that is not one read the same. */
function draftFormOf(app: AppDef, key: string): (AppFormView & { save: AppFormSave & { owner: string } }) | undefined {
  if (!Object.hasOwn(app.views, key)) return undefined;
  const view = app.views[key];
  if (!isFormView(view) || view.public || !isSavedForm(view) || view.save.owner === undefined) return undefined;
  return view as AppFormView & { save: AppFormSave & { owner: string } };
}

const notFound = (): never => {
  throw new BusinessCommandExecutionError('not_found');
};

interface Authorized {
  readonly catalog?: CommandCatalog;
  readonly actor: BusinessCommandActor;
  readonly people?: CommandPeople;
  readonly readsInCommand?: true;
  /** The file resources the form's first command writes, by local name. */
  readonly files?: ReadonlyMap<string, CommandFileRule>;
  transaction<T>(run: (tx: WriteTransaction) => Promise<T>): Promise<T>;
  commandTransaction?<T>(run: (tx: WriteTransaction, journal: never) => Promise<T>): Promise<T>;
}

/** The actor's own transaction for the form's first command: the plain one, or a row policy's command transaction. */
function inTransaction<T>(authorized: Authorized, work: (tx: WriteTransaction) => Promise<T>): Promise<T> {
  if (authorized.readsInCommand && authorized.commandTransaction) {
    // A row policy opens only its command's transaction; what is found leaves it beside the transaction, not through it.
    let found: { value: T } | undefined;
    return authorized
      .commandTransaction(async (tx) => {
        found = { value: await work(tx) };
        return null as never;
      })
      .then(() => found!.value);
  }
  return authorized.transaction(work);
}

/** What the person's open draft says of itself, and the answers the steps ask for that it holds. */
interface DraftSummary {
  id: string | number;
  saved: string[];
  expiresAt: string;
  /** The first saved step that today's rules refuse, or null: the page reopens there. */
  reopen: string | null;
  /**
   * The saved answers, as the input that would have stored them, by the step's input name: a plain field is the root
   * column of that name; a lines field is the rows of its resource that hang off the root, each its shown columns.
   * An answer the App keeps under another name, or in a group, is not here: the page asks it again.
   */
  values: Record<string, unknown>;
}

/** A stored value as the input that would have stored it. */
function asInput(value: unknown, type: string): unknown {
  if (value === null || value === undefined) return undefined;
  if (type === 'boolean' && (value === 0 || value === 1)) return value === 1;
  if (value instanceof Date) return type === 'date' ? value.toISOString().slice(0, 10) : value.toISOString();
  if (typeof value === 'bigint') return String(value);
  return value;
}

/**
 * Resume re-runs each saved step's validation against today's rules, on the answers the root row holds under the
 * step's own input names, and reopens at the first step that no longer passes. An answer the App keeps under another
 * name, or in a row beneath the root, is the submit's to judge again, as every run judges what it is given.
 */
function firstFailingStep(
  form: AppFormView & { save: AppFormSave },
  commands: BusinessCommandRegistry,
  catalog: CommandCatalog,
  rootTable: string,
  row: Record<string, unknown>,
  saved: readonly string[],
  now: Date,
): string | null {
  const steps = form.steps as unknown as Array<{ id: string; command: { id: string } }>;
  const columns = new Map(catalog[rootTable].meta.columns.map((column) => [column.name, column]));
  for (const step of steps) {
    if (!saved.includes(step.id)) continue;
    const command = commands[step.command.id];
    if (!command) continue;
    const input: Record<string, unknown> = {};
    const asked: string[] = [];
    for (const field of command.fields) {
      if (field.type === 'group' || field.type === 'lines' || !columns.has(field.name) || !Object.hasOwn(row, field.name)) continue;
      asked.push(field.name);
      const value = asInput(row[field.name], field.type);
      if (value !== undefined) input[field.name] = value;
    }
    if (asked.length && Object.keys(checkCommandStep(command, input, asked, now)).length) return step.id;
  }
  return null;
}

/**
 * What the draft holds for the fields its steps ask, read in the caller's transaction: the root row's columns (the row
 * given is the whole row) and the rows of a lines field's resource that reference the root. Nothing the platform keeps
 * is named, whatever a step calls its field.
 */
async function savedValues(
  tx: WriteTransaction,
  form: AppFormView & { save: AppFormSave },
  commands: BusinessCommandRegistry,
  catalog: CommandCatalog,
  found: { table: string; row: Record<string, unknown> },
): Promise<Record<string, unknown>> {
  const kept = new Set([
    form.save.owner,
    form.save.resume.token,
    form.save.resume.expires,
    form.save.resume.progress,
    form.save.draft.column,
    ...platformColumns(form),
  ]);
  const columns = new Set(catalog[found.table].meta.columns.map((column) => column.name));
  const children = draftChildren(catalog, found.table);
  const rootKey = found.row[catalog[found.table].key[0]] as string | number;
  const values: Record<string, unknown> = {};
  for (const step of form.steps as unknown as Array<{ command: { id: string } }>) {
    for (const field of commands[step.command.id]?.fields ?? []) {
      if (Object.hasOwn(values, field.name)) continue;
      if (field.type === 'lines') {
        const link = children.get(field.from);
        if (!link) continue;
        const shown = field.show.filter(
          (column) => !kept.has(column) && catalog[field.from].meta.columns.some((item) => item.name === column),
        );
        const rows = await tx.query({
          table: field.from,
          filter: { groups: [[{ column: link, op: '=', value: rootKey }]] } satisfies Filter,
          orderBy: catalog[field.from].key.map((column) => ({ column, direction: 'asc' as const })),
          limit: field.max ?? 100,
          offset: 0,
          columns: shown,
        });
        if (rows.rows.length) {
          values[field.name] = rows.rows.map((row) =>
            Object.fromEntries(
              shown.flatMap((column) =>
                row[column] === null || row[column] === undefined ? [] : [[column, asInput(row[column], 'text')]],
              ),
            ),
          );
        }
        continue;
      }
      if (field.type === 'group' || field.type === 'files' || field.type === 'signature' || field.type === 'defined') continue;
      if (kept.has(field.name) || !columns.has(field.name) || !Object.hasOwn(found.row, field.name)) continue;
      const value = asInput(found.row[field.name], field.type);
      if (value !== undefined) values[field.name] = value;
    }
  }
  return values;
}

interface DraftRouteOptions {
  readonly app: AppDef;
  readonly commands: BusinessCommandRegistry;
  readonly binding: BusinessCommandBinding;
  readonly actor: BusinessCommandActor;
  readonly body: unknown;
  readonly execution: { signal?: AbortSignal | undefined; requestId?: string | undefined };
  /** The flags for this command's run, captured under the actor's grant of it. */
  readonly flagsFor: (envelope: unknown) => Promise<CommandFlags>;
  readonly door?: CommandDoor;
  /** False where a request holds one transaction (a tenant's, tenantRequestRuntime.ts): a step then answers without its
   * draft, which the host reads with a resume of its own. */
  readonly stepSummary?: false;
}

/** One request to a signed-in saved form: the same on the ordinary host and under a row policy; only the binding differs. */
export async function runDraftRoute(options: DraftRouteOptions): Promise<unknown> {
  const { app, commands, binding, actor } = options;
  const selector = parseSelector(options.body);
  const form = draftFormOf(app, selector.form);
  if (!form) return notFound();
  const references = formCommands(form);
  const steps = form.steps as unknown as Array<{ id: string; command: { id: string } }>;
  const order = steps.map((step) => step.id);
  const startId = references[0].id;
  const start = commands[startId];
  // Authorized as any command of the form is: a role that lost the grant is refused here, before anything is read.
  const authorized = binding.authorize(startId, actor) as unknown as Authorized;
  if (!start || !authorized.catalog) throw new AppAccessDenied();
  const catalog = authorized.catalog;
  const roots = savedFormRoots(form, start, catalog);
  const owner = form.save.owner;
  const now = new Date();

  /** The person, as `me`: resolved in the transaction asked, from the command's reading of the people table. */
  const me = async (tx: WriteTransaction): Promise<string | number | undefined> => {
    const key = (await whenPerson(tx, authorized.actor, authorized.people, ['owner = me']))?.person?.key;
    return key === null || key === undefined ? undefined : key;
  };
  const summary = async (
    tx: WriteTransaction,
    found: { table: string; row: Record<string, unknown>; saved: string[] },
  ): Promise<DraftSummary> => ({
    id: found.row[catalog[found.table].key[0]] as string | number,
    saved: found.saved,
    expiresAt: new Date(String(found.row[form.save.resume.expires])).toISOString(),
    reopen: firstFailingStep(form, commands, catalog, found.table, found.row, found.saved, now),
    values: await savedValues(tx, form, commands, catalog, found),
  });
  /** The person's open draft, read with the columns a resume re-validates. */
  const open = async (tx: WriteTransaction) => {
    const person = await me(tx);
    if (person === undefined) return undefined;
    const found = await findOwnedDraft(tx, catalog, roots, form.save, owner, person, order, now, selector.hint);
    if (!found) return undefined;
    const full = await tx.query({
      table: found.table,
      filter: keyFilter({ [catalog[found.table].key[0]]: found.row[catalog[found.table].key[0]] as string | number }),
      limit: 1,
      offset: 0,
      columns: catalog[found.table].meta.columns.map((column) => column.name),
    });
    return { ...found, row: full.rows[0] ?? found.row };
  };
  const readOpen = async () =>
    inTransaction(authorized, async (tx) => {
      const found = await open(tx);
      return found ? await summary(tx, found) : null;
    });

  if (selector.op === 'resume') return { draft: await readOpen() };

  if (selector.op === 'review') {
    return inTransaction(authorized, async (tx) => {
      const found = await open(tx);
      if (!found) return notFound();
      return {
        version: await draftVersion(tx, catalog, found.table, rootKeyOf(catalog, found), form.save),
        saved: found.saved,
        values: await savedValues(tx, form, commands, catalog, found),
      };
    });
  }

  const startOver = () =>
    inTransaction(authorized, async (tx) => {
      const found = await open(tx);
      // Nothing to start over from is already started over.
      if (!found) return { discarded: false };
      const key = found.row[catalog[found.table].key[0]] as string | number;
      for (const [table, link] of draftChildren(catalog, found.table)) {
        const rows = await tx.query({
          table,
          limit: 1001,
          offset: 0,
          columns: [...catalog[table].key],
          filter: { groups: [[{ column: link, op: '=', value: key }]] } satisfies Filter,
        });
        if (rows.rows.length > 1000) throw new BusinessCommandExecutionError('temporarily_unavailable');
        const doomed = rows.rows.map((child) => ({
          table,
          key: Object.fromEntries(catalog[table].key.map((column) => [column, child[column] as string | number])),
        }));
        // Start over takes the files away too: bucket objects first, and the draft stays whole if the bucket does not answer.
        if (!(await dropObjects(tx, authorized.files, doomed))) throw new BusinessCommandExecutionError('temporarily_unavailable');
        for (const entry of doomed) await tx.remove({ ...entry, unreferenced: true });
      }
      await tx.remove({ table: found.table, key: rootKeyOf(catalog, found), unreferenced: true });
      return { discarded: true };
    });

  if (selector.op === 'discard') {
    return startOver().catch((error: unknown) => {
      /* The scoped delete never cascades and refuses a row something still references, whoever can see that row. A
         transaction that failed answers with the first failure it met, whatever its callback threw, so it is said
         here, outside it, as what it is, where it fell through to temporarily_unavailable and a retry that could never succeed. */
      const cause = error instanceof CommandTransactionFailure ? error.cause : error;
      if (cause instanceof ScopeRefusal)
        throw new BusinessCommandExecutionError(
          'ineligible_state',
          'not_applied',
          undefined,
          undefined,
          'Other records still refer to this draft, so it cannot be started over. Ask whoever manages it to remove them first.',
        );
      throw error;
    });
  }

  // A step or the submit: the page's envelope runs as the form's command for that step, in the draft.
  const step = selector.op === 'step' ? steps.findIndex((item) => item.id === selector.step) : -1;
  if (selector.op === 'step' && step < 0) return notFound();
  const commandId = selector.op === 'submit' ? form.command.id : steps[step].command.id;
  const envelope = selector.request;
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new CommandInputError('request');
  if ((envelope as Record<string, unknown>).command !== commandId) throw new CommandInputError('command');
  const run: SavedDraftRun = Object.freeze({
    phase: selector.op === 'submit' ? 'submit' : step === 0 ? 'start' : 'step',
    step: selector.op === 'submit' ? 'submit' : steps[step].id,
    token: '',
    save: form.save,
    order: Object.freeze(order),
    roots: Object.freeze([...roots]),
    owned: Object.freeze(platformColumns(form)),
    owner: Object.freeze({ column: owner }),
    ...(selector.hint === undefined ? {} : { hint: selector.hint }),
    ...(selector.version === undefined ? {} : { version: selector.version }),
  });
  const result = await executeBusinessCommand(binding, actor, envelope, {
    ...(options.execution.signal ? { signal: options.execution.signal } : {}),
    ...(options.execution.requestId ? { requestId: options.execution.requestId } : {}),
    flags: await options.flagsFor(envelope),
    ...(options.door ? { door: options.door } : {}),
    draft: run,
  });
  if (selector.op === 'submit' || options.stepSummary === false) return result;
  // The draft the step saved into, for the page to hold on to.
  return { ...result, draft: await readOpen() };
}

function rootKeyOf(catalog: CommandCatalog, found: { table: string; row: Record<string, unknown> }): Record<string, string | number> {
  return Object.fromEntries(catalog[found.table].key.map((column) => [column, found.row[column] as string | number]));
}
