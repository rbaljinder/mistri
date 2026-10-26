/**
 * A public form's submission over HTTP: the one write a signed-out person
 * may make, and what a signed-in person makes too on a public form — it is
 * always a public submission. The route has already found the form and rate
 * limited the address; this builds the command envelope the applicant never
 * sees — the command the form names, its pinned version, no key, revision
 * zero, the submission key as the idempotency key — and runs it under a
 * public principal through the same executor, journal and audit every
 * signed-in command uses.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppDef, AppFormView } from '../../shared/app.js';
import { servedFormDress } from '../../shared/appForms.js';
import type { Registry } from '@mistriwork/engine/server/connections.js';
import { loadAppRuntimeResources } from '../app/appRuntimeResources.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { bindHttpBusinessCommands } from './businessCommandLoader.js';
import type { CommandJournalAppScope } from '../../adapters/commands/commandJournalTypes.js';
import { CommandBodyTooLarge, commandBody } from './businessCommandHttp.js';
import { CommandInputError } from './commandPayload.js';
import type { BusinessCommandActor, BusinessCommandRegistry } from './businessCommands.js';
import { BusinessCommandExecutionError, executeBusinessCommand, type BusinessCommandResult } from './businessCommandExecution.js';
import { forbiddenBy } from './commandErrors.js';
import type { CaptureCommandFlags } from './commandFlags.js';
import { commandFlagsOnce } from './commandFlagCapture.js';

import { componentHrefs, type CompiledComponents } from '../app/appComponents.js';
import { publicFormInputIds } from '../../shared/appComponentPlaces.js';
const SUBMISSION_KEY = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * What the page draws: the form under its key, its inputs and its steps,
 * less the command's id and version, which an applicant never sees.
 */
export function presentForm(key: string, form: AppFormView) {
  /* A form saved on every step asks each step's command's inputs on its step,
     and the submit's own (a confirmation, say) on the review before it. */
  const saved = form.save
    ? {
        save: {
          submit: form.command.input.map((field) => field.name),
          ...(form.statusCheck
            ? {
                statusCheck: {
                  confirm: form.statusCheck.confirm.map((item) => ({ name: item.column, label: item.label })),
                  ...(form.statusCheck.stepUp ? { stepUp: true } : {}),
                },
              }
            : {}),
          // Which ways an application may be added to an account: the page offers only those, never a column —
          // but for the input whose address the applicant may prove, which the page already asks by that name.
          ...(form.link
            ? {
                link: {
                  ...(form.link.sameDevice ? { sameDevice: true } : {}),
                  ...(form.link.statusCheck ? { statusCheck: true } : {}),
                  ...(form.link.email ? { email: form.link.email.verified ? { prove: form.link.email.column } : {} } : {}),
                },
              }
            : {}),
        },
      }
    : {};
  return {
    id: key,
    label: form.label,
    ...(form.description === undefined ? {} : { description: form.description }),
    input: form.save ? [...(form.steps ?? []).flatMap((step) => step.command?.input ?? []), ...form.command.input] : form.command.input,
    ...saved,
    // Its steps as the intake style draws them, its style, its note and whether it reviews (appForms.ts).
    ...servedFormDress(form),
    // The command's rules over the draft, which the page checks step by step and the run again.
    ...(form.command.rules?.length ? { rules: form.command.rules } : {}),
    ...(form.submitLabel === undefined ? {} : { submitLabel: form.submitLabel }),
    ...(form.prefillable?.length ? { prefillable: form.prefillable } : {}),
    // The App's own input components standing in its inputs, by id alone: where each is served is the route's to add.
    ...(form.inputs ? { inputs: Object.fromEntries(Object.entries(form.inputs).map(([name, decl]) => [name, { id: decl.id }])) } : {}),
    ...(form.done === undefined ? {} : { done: form.done }),
  };
}

/** Where the input components a public form draws are served (`/{app}/_components/…`, componentRoutes.ts), for its
    page to load the first time it draws one; undefined where it draws none the App compiled. */
export function publicFormComponents(appId: string, compiled: CompiledComponents | undefined, form: AppFormView) {
  const wanted = publicFormInputIds(form);
  const served = wanted.size ? componentHrefs(appId, compiled) : undefined;
  const entries = Object.entries(served ?? {}).filter(([id, entry]) => wanted.has(id) && entry.kind === 'input');
  return entries.length
    ? Object.fromEntries(entries.map(([id, entry]) => [id, { href: entry.href, ...(entry.css ? { css: entry.css } : {}) }]))
    : undefined;
}

/** The members a door's submission may carry beside its input and key: the stock form's decoy, which a person never
    sees and so never fills. A ticket and a challenge's token travel as headers, read before the body is. */
type SubmissionExtra = 'trap';

/** The submission body: exactly the input and the client's submission key, and the extra members this door reads. */
export function parseSubmission(
  body: unknown,
  extra: readonly SubmissionExtra[] = [],
): { input: unknown; submission: string; extra: Partial<Record<SubmissionExtra, unknown>> } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CommandInputError();
  const keys = Object.keys(body);
  // Only the member this body was missing, which is a name of ours; an extra
  // one the sender invented is refused without being repeated.
  const missing = ['input', 'submission'].find((name) => !keys.includes(name));
  if (missing || keys.some((key) => key !== 'input' && key !== 'submission' && !(extra as readonly string[]).includes(key))) {
    throw new CommandInputError(missing);
  }
  const { input, submission } = body as { input: unknown; submission: unknown };
  if (typeof submission !== 'string' || !SUBMISSION_KEY.test(submission)) throw new CommandInputError('submission');
  const members = body as Record<string, unknown>;
  return {
    input,
    submission,
    extra: Object.fromEntries(extra.filter((name) => Object.hasOwn(members, name)).map((name) => [name, members[name]])),
  };
}

/** The public principal a public door runs under: no session, no roles, one door — a public form or a public page. */
export function publicPrincipal(appId: string, form: string): BusinessCommandActor {
  return Object.freeze({ id: `public:${form}`, appId, roles: Object.freeze([]), kind: 'public' as const, form });
}

/** What a public door answers a submission with: the reference the applicant quotes, and the receipt. */
type PublicSubmissionReply = { reference: string; receipt: { id: string; status: 'applied' } };

/**
 * What a door asks of a submission before it runs, with its extra members: undefined to go on, `'decoy'` to answer it
 * as accepted and write nothing (a filled honeypot), or a thrown refusal.
 */
type SubmissionAdmission = (extra: Partial<Record<SubmissionExtra, unknown>>) => Promise<'decoy' | undefined> | 'decoy' | undefined;

/** The operation owns every lease until the transaction completes, even after socket loss. */
export async function dispatchPublicFormHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  registry: Registry;
  app: AppDef;
  commands: BusinessCommandRegistry;
  connection: string;
  key: string;
  /** The command the door runs, at the version it pins. */
  command: { id: string; version: number };
  captureFlags?: CaptureCommandFlags;
  /** The App-scope event source startup issued, when a command declares events. */
  events?: CommandJournalAppScope;
  /** The extra members this door reads, and what it asks of them first. */
  extra?: readonly SubmissionExtra[];
  admit?: SubmissionAdmission;
  /** `'thrown'`: a body past the envelope is thrown as itself (CommandBodyTooLarge), for a door that answers it 413. */
  tooLarge?: 'thrown';
}): Promise<PublicSubmissionReply> {
  const { req, res, registry, app, commands, connection, key, command, events } = options;
  const captureFlags = options.captureFlags;
  const releases: Array<() => void> = [];
  try {
    return await dispatchPublicFormSubmissionHttp({
      req,
      res,
      ...(options.extra ? { extra: options.extra } : {}),
      ...(options.admit ? { admit: options.admit } : {}),
      ...(options.tooLarge ? { tooLarge: options.tooLarge } : {}),
      submit: async ({ input, submission }, execution) => {
        const resources = await loadAppRuntimeResources(registry, app, connection, (owner) => releases.push(registry.lease(owner)));
        const { binding } = bindHttpBusinessCommands(
          app,
          commands,
          resources,
          (owner) => registry.configOf(owner)?.writable === true,
          events,
        );
        if (execution.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
        const actor = publicPrincipal(app.id, key);
        const authorized = binding.authorize(command.id, actor);
        const flags = await commandFlagsOnce(() => captureFlags?.(authorized.actor))();
        return executeBusinessCommand(
          binding,
          actor,
          {
            command: command.id,
            commandVersion: command.version,
            key: {},
            expectedVersion: 0,
            idempotencyKey: submission,
            input,
          },
          { ...execution, flags },
        );
      },
    });
  } finally {
    for (const release of releases.reverse()) release();
  }
}

/* A decoy's answer: shaped as an accepted submission's, its reference and receipt random, so a script that filled the
   honeypot learns nothing — and nothing was written, journalled or counted as a receipt. */
export function decoyReply(): PublicSubmissionReply {
  return { reference: randomBytes(6).toString('hex').toUpperCase(), receipt: { id: randomUUID(), status: 'applied' } };
}

/** Shared transport, with the writer supplied by its deployment. The policy
 * path never loads resources or falls back to an ordinary command binding. */
export async function dispatchPublicFormSubmissionHttp(options: {
  req: IncomingMessage;
  res: ServerResponse;
  submit: (
    submission: { input: unknown; submission: string },
    execution: { signal: AbortSignal; requestId?: string },
  ) => Promise<BusinessCommandResult>;
  extra?: readonly SubmissionExtra[];
  admit?: SubmissionAdmission;
  tooLarge?: 'thrown';
}): Promise<PublicSubmissionReply> {
  const { req, res, submit } = options;
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once('aborted', abort);
  res.once('close', abort);
  try {
    if (req.aborted || res.destroyed) abort();
    const { input, submission, extra } = parseSubmission(await commandBody(req), options.extra);
    if (controller.signal.aborted) throw new BusinessCommandExecutionError('cancelled');
    if ((await options.admit?.(extra)) === 'decoy') return decoyReply();
    const execution = {
      signal: controller.signal,
      ...(typeof res.getHeader('x-request-id') === 'string' ? { requestId: String(res.getHeader('x-request-id')) } : {}),
    };
    const result = await submit({ input, submission }, execution);
    const reference = (result.result as { reference?: unknown } | null)?.reference;
    // The receipt is durable either way; a handler that returned no
    // reference has left the applicant nothing to quote, which is its bug.
    if (typeof reference !== 'string' || !reference.trim() || reference.length > 64)
      throw new BusinessCommandExecutionError('invalid_result', 'unknown');
    return { reference, receipt: { id: result.receiptId, status: result.status } };
  } catch (error) {
    if (error instanceof CommandBodyTooLarge && options.tooLarge === 'thrown') throw error;
    if (error instanceof CommandInputError) throw new BusinessCommandExecutionError('invalid_input', 'not_applied', error.field);
    if (error instanceof AppAccessDenied) throw forbiddenBy(error);
    throw error;
  } finally {
    req.off('aborted', abort);
    res.off('close', abort);
  }
}
